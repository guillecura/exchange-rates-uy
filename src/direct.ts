/**
 * The client without a server: the same calls as `client.ts`, answered by reading the sources directly (the BCU and
 * ExchangeRate-API), with the same arithmetic the server uses (`officialCross`, `marketCross`). For an app that has no
 * exchange-rates-uy server of its own.
 *
 * The market's past days come from fawazahmed0's exchange-api (`pastMarketTable`, back to 2 March 2024), a day per
 * request, so its market history takes a year at most per call. What it cannot do: the BCU from a browser (it allows
 * no other page to call it). The pairs and currencies are the ones it is given, not a panel's.
 */
import { BCU_CURRENCIES, BCU_PAGE, BCU_QUOTE, bcuBetween, bcuCode, bcuOn, type BcuReading } from "./rates/bcu.ts";
import { marketCross, officialCross } from "./rates/convert.ts";
import { PAST_MARKET_FROM, marketCredit, marketTable, pastMarketTable, type MarketTable } from "./rates/market.ts";
import { currencyName, currencyPlaces, currencySymbol } from "./rates/money.ts";
import { montevideoNow, stamp } from "./rates/time.ts";
import type { CurrencySpec } from "./rates/types.ts";
import { RatesError, type Conversion, type Currency, type HistoryDay, type Market, type Official, type PairRate, type RatesClient } from "./client.ts";

export interface DirectOptions {
  /** The pairs `pairs()` answers: `USD/UYU`, `EUR/UYU`, `ARS/UYU`, `BRL/UYU` unless told otherwise. */
  pairs?: readonly string[];
  /** More currencies to read from the BCU beside the pairs' (any it quotes; `BCU_CURRENCIES`). */
  currencies?: readonly string[];
}

const DEFAULT_PAIRS = ["USD/UYU", "EUR/UYU", "ARS/UYU", "BRL/UYU"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shift = (day: string, days: number) => stamp(new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000));
const today = () => stamp(montevideoNow());
const checked = (d: string | undefined) => {
  if (d !== undefined && !DAY.test(d)) throw new RangeError(`a day is YYYY-MM-DD: ${d}`);
  return d;
};
const sides = (pair: string) => {
  const [base, quote] = pair.toUpperCase().split(/[/-]/);
  if (!base || !quote) throw new RangeError(`a pair is BASE/QUOTE: ${pair}`);
  return [base, quote] as const;
};

export function createDirectClient(o: DirectOptions = {}): RatesClient {
  const pairs = (o.pairs ?? DEFAULT_PAIRS).map((p) => sides(p));
  const isos = [...new Set([...pairs.flat(), ...(o.currencies ?? [])].map((c) => c.toUpperCase()))];
  const quoted: CurrencySpec[] = isos.map((iso) => ({ iso, bcu: bcuCode(iso) })).filter((c) => c.bcu > 0);
  const specs = (list: readonly string[]) => list.map((iso) => ({ iso, bcu: bcuCode(iso) })).filter((c) => c.bcu > 0);

  /** The bank's last reading on or before `day`, walking back a week at most (weekends, bank holidays). */
  async function reading(day: string, wanted: CurrencySpec[] = quoted): Promise<BcuReading> {
    for (let back = 0; back < 7; back += 1) {
      const r = await bcuOn(shift(day, -back), wanted).catch(() => null);
      if (r) return r;
    }
    throw new RatesError(502, "the BCU published nothing in the week before that day");
  }

  /** Today's table from ExchangeRate-API; a day before it, that day's from the past dataset. */
  async function table(date: string | undefined): Promise<MarketTable> {
    const t = await marketTable().catch(() => null);
    if (!date || (t && date >= t.day)) {
      if (!t) throw new RatesError(502, "ExchangeRate-API answered no table");
      return t;
    }
    if (date < PAST_MARKET_FROM) throw new RatesError(404, `the market's past begins on ${PAST_MARKET_FROM}`);
    const past = await pastMarketTable(date).catch(() => null);
    if (!past) throw new RatesError(502, `no market table for ${date}`);
    return past;
  }

  const official = async (date?: string): Promise<Official> => {
    const asked = checked(date) ?? today();
    const r = await reading(asked);
    return { date: asked, day: r.day, perLocal: { ...r.perLocal }, published: { ...r.published }, quote: BCU_QUOTE, source: BCU_PAGE };
  };

  const market = async (date?: string): Promise<Market> => {
    const asked = checked(date) ?? today();
    const t = await table(asked === today() ? undefined : asked);
    const source = t.source ?? "live";
    return { date: asked, day: t.day, perUsd: { ...t.perUsd }, base: "USD", source, credit: { ...marketCredit(source) } };
  };

  return {
    official,
    market,

    async pairs(date) {
      const [o, m] = await Promise.all([official(date).catch(() => null), market(date).catch(() => null)]);
      return pairs.map(([base, quote]): PairRate => {
        const s = o ? officialCross(o.perLocal, o.published, base, quote) : null;
        const rate = m ? marketCross(m.perUsd, base, quote) : null;
        return {
          pair: `${base}/${quote}`, base, quote, favourite: true,
          official: s && o ? { day: o.day, buy: s.buy, sell: s.sell } : null,
          market: rate !== null && m ? { day: m.day, rate } : null,
        };
      });
    },

    async currencies(lang = "en") {
      return isos.map((iso): Currency => ({
        iso, name: currencyName(iso, lang), symbol: currencySymbol(iso), places: currencyPlaces(iso),
        official: iso === BCU_QUOTE || iso in BCU_CURRENCIES,
      }));
    },

    async history(pair, opts = {}) {
      const [base, quote] = sides(pair);
      const to = checked(opts.to) ?? today();
      const from = checked(opts.from) ?? shift(to, -30);
      if (from > to) throw new RangeError("from comes before to");
      if ((opts.source ?? "official") === "market") {
        // A table per day, eight at a time; a year at most, since each day is a request.
        if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new RatesError(400, "without a server, a year of the market at most at once");
        const days: string[] = [];
        for (let d = from < PAST_MARKET_FROM ? PAST_MARKET_FROM : from; d <= to; d = shift(d, 1)) days.push(d);
        const out: HistoryDay[] = [];
        for (let i = 0; i < days.length; i += 8) {
          const tables = await Promise.all(days.slice(i, i + 8).map((d) => table(d === today() ? undefined : d).catch(() => null)));
          for (const t of tables) {
            const rate = t ? marketCross(t.perUsd, base, quote) : null;
            if (t && rate !== null && !out.some((x) => x.day === t.day)) out.push({ day: t.day, buy: rate, sell: rate, source: t.source ?? "live" });
          }
        }
        return out.sort((x, y) => x.day.localeCompare(y.day));
      }
      const wanted = specs([base, quote]);
      const byDay = new Map<string, BcuReading>();
      // One currency and one year at a time: the bank refuses wider ranges.
      for (let a = from; a <= to; a = shift(a, 365)) {
        const b = shift(a, 364) < to ? shift(a, 364) : to;
        for (const c of wanted) {
          for (const r of await bcuBetween(a, b, [c])) {
            const had = byDay.get(r.day);
            byDay.set(r.day, had
              ? { ...had, perLocal: { ...had.perLocal, ...r.perLocal }, published: { ...had.published, ...r.published } }
              : r);
          }
        }
      }
      return [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day)).flatMap((r): HistoryDay[] => {
        const s = officialCross(r.perLocal, r.published, base, quote);
        return s ? [{ day: r.day, buy: s.buy, sell: s.sell }] : [];
      });
    },

    async convert({ amount, from, to, date, source = "market", side = "sell" }) {
      const f = from.toUpperCase();
      const t = to.toUpperCase();
      if (source === "official") {
        const o = await official(date);
        const s = officialCross(o.perLocal, o.published, f, t);
        if (!s) throw new RatesError(404, `no official rate for ${f}/${t}`);
        const rate = side === "mid" ? (s.buy + s.sell) / 2 : s[side];
        return { amount, from: f, to: t, date: o.date, day: o.day, source, side, rate, result: amount * rate } satisfies Conversion;
      }
      const m = await market(date);
      const rate = marketCross(m.perUsd, f, t);
      if (rate === null) throw new RatesError(404, `no market rate for ${f}/${t}`);
      return { amount, from: f, to: t, date: m.date, day: m.day, source, rate, result: amount * rate } satisfies Conversion;
    },

    async status() {
      const [o, m] = await Promise.all([official().catch(() => null), market().catch(() => null)]);
      return { freshest: { official: o?.day ?? null, market: m?.day ?? null } };
    },
  };
}
