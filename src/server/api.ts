import { BCU_PAGE, BCU_QUOTE, bcuCode } from "../rates/bcu.ts";
import { marketCross, officialCross } from "../rates/convert.ts";
import { MARKET_CREDIT } from "../rates/market.ts";
import { currencyName, currencyPlaces, currencySymbol, everyCurrency, isKnownCurrency } from "../rates/money.ts";
import { backfill, localTime, readMarket, readOfficial, type Schedule } from "./read.ts";
import type { Sql } from "./sql.ts";
import {
  currencies, freshest, history, marketOn, officialOn, orderPairs, pairs, reversePair, runs, saveCurrency, savePair,
  type Pair,
} from "./store.ts";

/**
 * The HTTP API: `Request` in, `Response` out, the same on Workers, Node and Deno.
 *
 * Public (`GET /api/...`, or wherever `base` puts it): anybody may read it, from
 * any origin. Rates are public data, and the point of keeping them in one place is
 * that every app reads them from there.
 *
 * Clock (`/api/tick`): for a platform whose scheduler calls a URL (Vercel Cron,
 * Supabase's pg_cron with pg_net, a GitHub Action, crontab and curl), behind the
 * cron secret or the admin token.
 *
 * Admin (`/api/admin`): what the panel does, behind `authorize`. Adding a currency
 * is its ISO code and nothing else (its name, mark and places are the platform's,
 * `exchange-rates-uy/money`); adding a pair is two kept currencies.
 */

export interface ApiOptions {
  /** Where the API answers: `/api` unless told otherwise. */
  base: string;
  schedule: Schedule;
  /** Whether a request may wake the clock at `{base}/tick` (a platform's cron calling in). */
  mayTick: (req: Request) => boolean | Promise<boolean>;
  /** Reads whatever is due now. */
  tick: () => Promise<string[]>;
  /** Whether a request may use the admin API. */
  authorize: (req: Request) => boolean | Promise<boolean>;
  /** How long a public answer may be cached, in seconds. */
  maxAge: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export const json = (data: unknown, status = 200, cache = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? `public, max-age=${cache}` : "no-store",
      ...CORS,
    },
  });

const fail = (error: string, status = 400) => json({ error }, status);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string | null): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(v));
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pairName = (v: string) => v.toUpperCase().replace(/[-_]/, "/");

/** A currency as the API writes it: what it is called in `lang`, its mark, its places, whether the bank quotes it. */
export function describe(c: { iso: string; symbol?: string; active?: boolean }, lang: string) {
  return {
    iso: c.iso,
    name: currencyName(c.iso, lang),
    symbol: currencySymbol(c.iso, c.symbol ?? ""),
    places: currencyPlaces(c.iso),
    official: c.iso === BCU_QUOTE || bcuCode(c.iso) > 0,
    ...(c.active === undefined ? {} : { active: c.active }),
  };
}

/** Each pair with its rate on `day` from both sources. */
export async function pairRates(sql: Sql, list: readonly Pair[], day: string) {
  const [official, market] = await Promise.all([officialOn(sql, day), marketOn(sql, day)]);
  return list.map((p) => {
    const o = official ? officialCross(official.perLocal, official.published, p.base, p.quote) : null;
    const m = market ? marketCross(market.perUsd, p.base, p.quote) : null;
    return {
      pair: p.pair, base: p.base, quote: p.quote, favourite: p.favourite,
      official: o && official ? { day: official.day, buy: o.buy, sell: o.sell } : null,
      market: m !== null && market ? { day: market.day, rate: m } : null,
    };
  });
}

export async function handleApi(req: Request, sql: Sql, opts: ApiOptions): Promise<Response | null> {
  const url = new URL(req.url);
  const full = url.pathname.replace(/\/+$/, "");
  if (full !== opts.base && !full.startsWith(`${opts.base}/`)) return null;
  const path = full.slice(opts.base.length);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const q = (k: string) => url.searchParams.get(k);
  const lang = q("lang") ?? "en";
  const today = localTime(new Date(), opts.schedule.timeZone).day;
  const day = q("date") ?? today;
  if (!isDay(day)) return fail("date is YYYY-MM-DD");

  if (path === "/admin") return admin(req, sql, opts, lang, today);
  if (path === "/tick") {
    if (!(await opts.mayTick(req))) return fail("unauthorized", 401);
    return json({ ok: true, read: await opts.tick() });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return fail("method not allowed", 405);
  const cache = opts.maxAge;

  switch (path) {
    case "":
      return json({
        endpoints: ["currencies", "pairs", "pairs/USD-UYU/history", "official", "market", "convert", "status"].map((e) => `${opts.base}/${e}`),
        credits: { official: BCU_PAGE, market: MARKET_CREDIT },
      }, 200, cache);

    case "/currencies":
      return json({ currencies: (await currencies(sql)).map((c) => describe(c, lang)) }, 200, cache);

    case "/pairs":
      return json({ date: day, pairs: await pairRates(sql, await pairs(sql), day) }, 200, cache);

    case "/official": {
      const o = await officialOn(sql, day);
      return o ? json({ date: day, ...o, quote: BCU_QUOTE, source: BCU_PAGE }, 200, cache) : fail("no official reading up to that day", 404);
    }

    case "/market": {
      const m = await marketOn(sql, day);
      return m ? json({ date: day, ...m, base: "USD", credit: MARKET_CREDIT }, 200, cache) : fail("no market table up to that day", 404);
    }

    case "/convert": {
      const amount = Number(q("amount") ?? "1");
      const from = (q("from") ?? "").toUpperCase();
      const to = (q("to") ?? "").toUpperCase();
      const source = q("source") === "official" ? "official" : "market";
      const side = q("side") === "buy" ? "buy" : q("side") === "mid" ? "mid" : "sell";
      if (!Number.isFinite(amount)) return fail("amount is a number");
      if (!isKnownCurrency(from) || !isKnownCurrency(to)) return fail("from and to are ISO currency codes");
      if (source === "official") {
        const o = await officialOn(sql, day);
        const s = o ? officialCross(o.perLocal, o.published, from, to) : null;
        if (!s || !o) return fail(`no official rate for ${from}/${to}`, 404);
        const rate = side === "mid" ? (s.buy + s.sell) / 2 : s[side];
        return json({ amount, from, to, date: day, day: o.day, source, side, rate, result: amount * rate }, 200, cache);
      }
      const m = await marketOn(sql, day);
      const rate = m ? marketCross(m.perUsd, from, to) : null;
      if (rate === null || !m) return fail(`no market rate for ${from}/${to}`, 404);
      return json({ amount, from, to, date: day, day: m.day, source, rate, result: amount * rate }, 200, cache);
    }

    case "/status":
      return json({ freshest: await freshest(sql), runs: await runs(sql, 20) });
  }

  const h = /^\/pairs\/([A-Za-z]{3})[-_/]([A-Za-z]{3})\/history$/.exec(path);
  if (h) {
    const base = h[1]!.toUpperCase();
    const quote = h[2]!.toUpperCase();
    const source = q("source") === "market" ? "market" : "official";
    const to = q("to") ?? today;
    const from = q("from") ?? shift(to, -30);
    if (!isDay(from) || !isDay(to) || from > to) return fail("from and to are YYYY-MM-DD, from first");
    if (Date.parse(to) - Date.parse(from) > 3700 * 86_400_000) return fail("ten years at most at once");
    return json({ pair: `${base}/${quote}`, source, from, to, days: await history(sql, source, base, quote, from, to) }, 200, cache);
  }
  return fail("not found", 404);
}

// MARK: Admin

type Action =
  | { kind: "currency"; iso: string; symbol?: string; active?: boolean; fresh?: boolean }
  | { kind: "pair"; base?: string; quote?: string; pair?: string; active?: boolean; favourite?: boolean; fresh?: boolean }
  | { kind: "reverse"; pair: string }
  | { kind: "order"; pairs: string[] }
  | { kind: "read" }
  | { kind: "backfill"; from: string; to?: string };

async function admin(req: Request, sql: Sql, opts: ApiOptions, lang: string, today: string): Promise<Response> {
  if (!(await opts.authorize(req))) return fail("unauthorized", 401);

  if (req.method === "GET") {
    const kept = await currencies(sql, true);
    const keptIso = new Set(kept.map((c) => c.iso));
    const all = await pairs(sql, true);
    const rated = await pairRates(sql, all, today);
    return json({
      currencies: kept.map((c) => ({ ...describe(c, lang), active: c.active, ownSymbol: c.symbol })),
      pairs: rated.map((r, i) => ({ ...r, active: all[i]!.active })),
      catalog: everyCurrency(lang).filter((c) => !keptIso.has(c.iso)),
      status: { freshest: await freshest(sql), runs: await runs(sql, 12) },
    });
  }
  if (req.method !== "POST") return fail("method not allowed", 405);

  const body = (await req.json().catch(() => null)) as Action | null;
  if (!body || typeof body !== "object") return fail("the body is a JSON action");

  switch (body.kind) {
    case "currency": {
      const iso = String(body.iso ?? "").toUpperCase();
      if (!isKnownCurrency(iso)) return fail("bad_iso");
      const kept = (await currencies(sql, true)).some((c) => c.iso === iso);
      if (body.fresh && kept) return fail("currency_exists", 409);
      if (!body.fresh && !kept) return fail("unknown_currency", 404);
      const symbol = body.symbol === undefined ? undefined : String(body.symbol).trim().slice(0, 4);
      await saveCurrency(sql, { iso, symbol, active: body.fresh ? true : body.active });
      return json({ ok: true, iso });
    }

    case "pair": {
      const all = await pairs(sql, true);
      if (!body.fresh) {
        const name = pairName(String(body.pair ?? ""));
        const p = all.find((x) => x.pair === name);
        if (!p) return fail("unknown_pair", 404);
        await savePair(sql, { base: p.base, quote: p.quote, active: body.active, favourite: body.favourite });
        return json({ ok: true, pair: name });
      }
      const base = String(body.base ?? "").toUpperCase();
      const quote = String(body.quote ?? "").toUpperCase();
      if (!base || !quote) return fail("both_sides");
      if (base === quote) return fail("same_currency");
      const kept = new Set((await currencies(sql, true)).map((c) => c.iso));
      if (!kept.has(base) || !kept.has(quote)) return fail("unknown_currency");
      if (all.some((p) => (p.base === base && p.quote === quote) || (p.base === quote && p.quote === base))) return fail("pair_exists", 409);
      return json({ ok: true, pair: await savePair(sql, { base, quote, favourite: body.favourite }) });
    }

    case "reverse": {
      const name = pairName(String(body.pair ?? ""));
      const [base, quote] = name.split("/");
      if ((await pairs(sql, true)).some((p) => p.base === quote && p.quote === base)) return fail("pair_exists", 409);
      const turned = await reversePair(sql, name);
      return turned ? json({ ok: true, pair: turned }) : fail("unknown_pair", 404);
    }

    case "order": {
      if (!Array.isArray(body.pairs)) return fail("pairs is a list of pair names");
      await orderPairs(sql, body.pairs.map((p) => pairName(String(p))));
      return json({ ok: true });
    }

    case "read": {
      const [official, market] = await Promise.all([readOfficial(sql, today), readMarket(sql)]);
      return json({ ok: !("error" in official) && !("error" in market), official, market });
    }

    case "backfill": {
      const to = body.to ?? today;
      if (!isDay(body.from) || !isDay(to) || body.from > to) return fail("from and to are YYYY-MM-DD, from first");
      return json({ ok: true, ...(await backfill(sql, body.from, to)) });
    }

    default:
      return fail("unknown action");
  }
}
