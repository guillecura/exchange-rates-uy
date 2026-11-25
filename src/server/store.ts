import { BCU_QUOTE } from "../rates/bcu.ts";
import { marketCross, officialCross, type Spread } from "../rates/convert.ts";
import type { MarketSource, MarketTable } from "../rates/market.ts";
import type { BcuReading } from "../rates/bcu.ts";
import type { Sql } from "./sql.ts";

/**
 * Everything the server reads and writes, as plain functions over a `Sql`.
 *
 * Two kinds of thing are kept. What is **chosen**: the currencies and the pairs,
 * which a person adds and orders in the panel. And what the sources **said**: the
 * bank's reading of each kept currency, per day, and the market's whole table, per
 * day. A pair's rate is never stored; it is `officialCross` or `marketCross` on
 * the day's reading when somebody asks.
 */

export interface Currency {
  iso: string;
  /** The mark written for it where the standard's is ambiguous (`US$`), or empty. */
  symbol: string;
  active: boolean;
  sort: number;
}

export interface Pair {
  pair: string;
  base: string;
  quote: string;
  active: boolean;
  sort: number;
  favourite: boolean;
}

/** The bank's reading of one day: each currency in pesos and what it published against the dollar. */
export interface OfficialDay {
  day: string;
  perLocal: Record<string, Spread>;
  published: Record<string, Spread>;
}

export interface MarketDay {
  day: string;
  perUsd: Record<string, number>;
  /** Whose table: ExchangeRate-API's on its day, or a past day from the package's archive (`pastMarketTable`). */
  source: MarketSource;
}

export interface Run {
  at: number;
  job: string;
  ok: boolean;
  detail: unknown;
}

const bool = (v: unknown) => v === 1 || v === true;

// MARK: What is chosen

export async function currencies(sql: Sql, all = false): Promise<Currency[]> {
  const rows = await sql.all<{ iso: string; symbol: string; active: number; sort: number }>(
    `select iso, symbol, active, sort from {currency} ${all ? "" : "where active = 1"} order by sort, iso`,
  );
  return rows.map((r) => ({ ...r, sort: Number(r.sort), active: bool(r.active) }));
}

export async function pairs(sql: Sql, all = false): Promise<Pair[]> {
  const rows = await sql.all<{ pair: string; base: string; quote: string; active: number; sort: number; favourite: number }>(
    `select pair, base, quote, active, sort, favourite from {pair} ${all ? "" : "where active = 1"} order by sort, pair`,
  );
  return rows.map((r) => ({ ...r, sort: Number(r.sort), active: bool(r.active), favourite: bool(r.favourite) }));
}

export async function saveCurrency(sql: Sql, c: { iso: string; symbol?: string; active?: boolean }): Promise<void> {
  const [last] = await sql.all<{ sort: number | null }>(`select max(sort) as sort from {currency}`);
  await sql.run(
    `insert into {currency} (iso, symbol, active, sort) values (?, ?, ?, ?)
     on conflict (iso) do update set
       symbol = coalesce(?, {currency}.symbol),
       active = coalesce(?, {currency}.active)`,
    [c.iso, c.symbol ?? "", c.active === false ? 0 : 1, Number(last?.sort ?? -1) + 1, c.symbol ?? null, c.active === undefined ? null : Number(c.active)],
  );
}

export async function savePair(
  sql: Sql,
  p: { base: string; quote: string; active?: boolean; favourite?: boolean },
): Promise<string> {
  const name = `${p.base}/${p.quote}`;
  const [last] = await sql.all<{ sort: number | null }>(`select max(sort) as sort from {pair}`);
  await sql.run(
    `insert into {pair} (pair, base, quote, active, sort, favourite) values (?, ?, ?, ?, ?, ?)
     on conflict (pair) do update set
       active = coalesce(?, {pair}.active),
       favourite = coalesce(?, {pair}.favourite)`,
    [
      name, p.base, p.quote, p.active === false ? 0 : 1, Number(last?.sort ?? -1) + 1, p.favourite ? 1 : 0,
      p.active === undefined ? null : Number(p.active), p.favourite === undefined ? null : Number(p.favourite),
    ],
  );
  return name;
}

/**
 * A pair the other way round. Nothing about its history changes, because there is
 * no stored history of a pair: the same readings divided the other way.
 */
export async function reversePair(sql: Sql, name: string): Promise<string | null> {
  const [p] = await sql.all<{ base: string; quote: string }>(`select base, quote from {pair} where pair = ?`, [name]);
  if (!p) return null;
  const turned = `${p.quote}/${p.base}`;
  await sql.run(`update {pair} set pair = ?, base = ?, quote = ? where pair = ?`, [turned, p.quote, p.base, name]);
  return turned;
}

/** The pairs in the order given; any left out keep their place after them. */
export async function orderPairs(sql: Sql, names: readonly string[]): Promise<void> {
  const all = await pairs(sql, true);
  const rest = all.map((p) => p.pair).filter((p) => !names.includes(p));
  await sql.batch([...names, ...rest].map((pair, i) => [`update {pair} set sort = ? where pair = ?`, [i, pair]] as const));
}

/** The first currencies and pairs of a new database, and nothing once it has any. */
export async function seed(sql: Sql, seed: { currencies: readonly string[]; pairs: readonly string[] }): Promise<void> {
  const [any] = await sql.all<{ n: number }>(`select count(*) as n from {currency}`);
  if (any && Number(any.n) > 0) return;
  for (const iso of seed.currencies) await saveCurrency(sql, { iso });
  for (const name of seed.pairs) {
    const [base, quote] = name.split("/");
    if (base && quote) await savePair(sql, { base, quote, favourite: true });
  }
}

// MARK: What the sources said

export async function keepOfficial(sql: Sql, readings: readonly BcuReading[]): Promise<number> {
  const rows: [string, unknown[]][] = [];
  for (const r of readings) {
    for (const [iso, s] of Object.entries(r.perLocal)) {
      if (iso === BCU_QUOTE) continue;
      const usd = r.published[`${iso}/USD`]?.sell ?? null;
      rows.push([
        `insert into {official} (day, iso, buy, sell, usd, fetched_at) values (?, ?, ?, ?, ?, ?)
         on conflict (day, iso) do update set buy = excluded.buy, sell = excluded.sell, usd = excluded.usd, fetched_at = excluded.fetched_at`,
        [r.day, iso, s.buy, s.sell, usd, r.fetchedAt],
      ]);
    }
  }
  for (let i = 0; i < rows.length; i += 100) await sql.batch(rows.slice(i, i + 100));
  return rows.length;
}

export async function keepMarket(sql: Sql, table: MarketTable): Promise<number> {
  const source = table.source ?? "live";
  // A live table is the market's word on its day and replaces whatever was there; a past one only fills a gap.
  const write = source === "live"
    ? `insert into {market} (day, iso, per_usd, fetched_at, source) values (?, ?, ?, ?, ?)
       on conflict (day, iso) do update set per_usd = excluded.per_usd, fetched_at = excluded.fetched_at, source = excluded.source`
    : `insert into {market} (day, iso, per_usd, fetched_at, source) values (?, ?, ?, ?, ?) on conflict (day, iso) do nothing`;
  const rows = Object.entries(table.perUsd)
    .filter(([iso, v]) => /^[A-Z]{3}$/.test(iso) && Number(v) > 0)
    .map(([iso, v]) => [write, [table.day, iso, Number(v), table.fetchedAt, source]] as const);
  for (let i = 0; i < rows.length; i += 100) await sql.batch(rows.slice(i, i + 100));
  return rows.length;
}

/** The bank's last reading on or before `day`, or nothing. */
export async function officialOn(sql: Sql, day: string): Promise<OfficialDay | null> {
  const rows = await sql.all<{ day: string; iso: string; buy: number; sell: number; usd: number | null }>(
    `select day, iso, buy, sell, usd from {official} where day = (select max(day) from {official} where day <= ?)`,
    [day],
  );
  if (!rows.length) return null;
  const out: OfficialDay = { day: rows[0]!.day, perLocal: { [BCU_QUOTE]: { buy: 1, sell: 1 } }, published: {} };
  for (const r of rows) {
    out.perLocal[r.iso] = { buy: r.buy, sell: r.sell };
    if (r.usd) out.published[`${r.iso}/USD`] = { buy: r.usd, sell: r.usd };
  }
  return out;
}

/** The market's last table on or before `day`, or nothing. */
export async function marketOn(sql: Sql, day: string): Promise<MarketDay | null> {
  const rows = await sql.all<{ day: string; iso: string; per_usd: number; source: string }>(
    `select day, iso, per_usd, source from {market} where day = (select max(day) from {market} where day <= ?)`,
    [day],
  );
  if (!rows.length) return null;
  return {
    day: rows[0]!.day,
    perUsd: Object.fromEntries([["USD", 1], ...rows.map((r) => [r.iso, r.per_usd] as const)]),
    source: rows.some((r) => r.source === "live") ? "live" : "past",
  };
}

/** The newest live market day kept, or nothing. */
export async function newestLiveMarket(sql: Sql): Promise<string | null> {
  const [row] = await sql.all<{ day: string | null }>(`select max(day) as day from {market} where source = 'live'`);
  return row?.day ?? null;
}

/** A value kept in `{meta}`, or nothing. */
export async function metaGet(sql: Sql, key: string): Promise<string | null> {
  const [row] = await sql.all<{ value: string }>(`select value from {meta} where key = ?`, [key]);
  return row?.value ?? null;
}

export async function metaSet(sql: Sql, key: string, value: string): Promise<void> {
  await sql.run(`insert into {meta} (key, value) values (?, ?) on conflict (key) do update set value = excluded.value`, [key, value]);
}

/** One pair's rate per day between two days, from one source. */
export async function history(
  sql: Sql,
  kind: "official" | "market",
  base: string,
  quote: string,
  from: string,
  to: string,
): Promise<{ day: string; buy: number; sell: number; source?: MarketSource }[]> {
  if (kind === "market") {
    const rows = await sql.all<{ day: string; iso: string; per_usd: number; source: string }>(
      `select day, iso, per_usd, source from {market} where iso in (?, ?) and day between ? and ? order by day`,
      [base, quote, from, to],
    );
    const byDay = new Map<string, { perUsd: Record<string, number>; live: boolean }>();
    for (const r of rows) {
      const d = byDay.get(r.day) ?? { perUsd: { USD: 1 }, live: false };
      d.perUsd[r.iso] = r.per_usd;
      d.live ||= r.source === "live";
      byDay.set(r.day, d);
    }
    return [...byDay].flatMap(([day, d]) => {
      const rate = marketCross(d.perUsd, base, quote);
      return rate === null ? [] : [{ day, buy: rate, sell: rate, source: d.live ? "live" as const : "past" as const }];
    });
  }
  const rows = await sql.all<{ day: string; iso: string; buy: number; sell: number; usd: number | null }>(
    `select day, iso, buy, sell, usd from {official} where iso in (?, ?) and day between ? and ? order by day`,
    [base, quote, from, to],
  );
  const byDay = new Map<string, OfficialDay>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { day: r.day, perLocal: { [BCU_QUOTE]: { buy: 1, sell: 1 } }, published: {} };
    d.perLocal[r.iso] = { buy: r.buy, sell: r.sell };
    if (r.usd) d.published[`${r.iso}/USD`] = { buy: r.usd, sell: r.usd };
    byDay.set(r.day, d);
  }
  return [...byDay.values()].flatMap((d) => {
    const s = officialCross(d.perLocal, d.published, base, quote);
    return s ? [{ day: d.day, ...s }] : [];
  });
}

// MARK: The clock and the log

/** Takes a slot of a day for a job; false when it was already taken (another run, a restart). */
export async function claim(sql: Sql, day: string, slot: string): Promise<boolean> {
  const { changes } = await sql.run(`insert into {slot} (day, slot) values (?, ?) on conflict do nothing`, [day, slot]);
  return changes > 0;
}

export async function log(sql: Sql, job: string, ok: boolean, detail: unknown): Promise<void> {
  const now = Date.now();
  await sql.batch([
    [`insert into {log} (at, job, ok, detail) values (?, ?, ?, ?)`, [now, job, ok ? 1 : 0, JSON.stringify(detail ?? null)]],
    [`delete from {log} where at < ?`, [now - 90 * 86_400_000]],
    [`delete from {slot} where day < ?`, [new Date(now - 14 * 86_400_000).toISOString().slice(0, 10)]],
  ]);
}

export async function runs(sql: Sql, limit = 20): Promise<Run[]> {
  const rows = await sql.all<{ at: number; job: string; ok: number; detail: string | null }>(
    `select at, job, ok, detail from {log} order by at desc limit ?`,
    [limit],
  );
  return rows.map((r) => ({ at: Number(r.at), job: r.job, ok: bool(r.ok), detail: r.detail ? JSON.parse(r.detail) : null }));
}

/** The newest day each source has, for the status line. */
export async function freshest(sql: Sql): Promise<{ official: string | null; market: string | null }> {
  const [o] = await sql.all<{ day: string | null }>(`select max(day) as day from {official}`);
  const [m] = await sql.all<{ day: string | null }>(`select max(day) as day from {market}`);
  return { official: o?.day ?? null, market: m?.day ?? null };
}
