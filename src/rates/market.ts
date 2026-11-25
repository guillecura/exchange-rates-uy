import { PATIENCE } from "./bcu.ts";
import { marketCross } from "./convert.ts";
import { montevideoNow, stamp } from "./time.ts";
import type { PairSpec, Rate } from "./types.ts";

/**
 * The market rates, from ExchangeRate-API.
 *
 * It is what gets read when the question is whether to change money today, and it
 * is the reference the rest of the world is using while the official one holds all
 * day. One number, no spread.
 *
 * It is that one and not XE, which is where this started. XE publishes no free API
 * and the only way in was reading the sentence its converter prints, which is a
 * page and not a contract. This publishes an open endpoint with terms and asks for
 * a credit in return, which every screen that shows its figures gives it
 * (`MARKET_CREDIT`): it is not decoration, it is the licence.
 *
 * The endpoint answers with every currency against the dollar in a single request,
 * and there is no walk back like the BCU's: it always has a figure, it is never
 * shut on a holiday, and what it says about how fresh it is comes in the answer.
 */

const ERAPI_URL = "https://open.er-api.com/v6/latest/USD";

/** The credit the free tier asks for, beside any figure it gave. */
export const MARKET_CREDIT = {
  label: "Rates By Exchange Rate API",
  href: "https://www.exchangerate-api.com",
} as const;

interface ErApi {
  result?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

/** The market's table: how many of each currency buy one dollar, and whose day it is. */
export interface MarketTable {
  /**
   * The day stored is **theirs** and not ours: `time_last_update_unix` is when the
   * table was last built, and around here that lands the evening before. Writing
   * today's date on it would say the rate is from a day it is not.
   */
  day: string;
  perUsd: Readonly<Record<string, number>>;
  fetchedAt: number;
  /** Whose table it is: `live` is ExchangeRate-API's, read on its day; `past` is `pastMarketTable`'s, a day gone by. */
  source?: MarketSource;
}

export type MarketSource = "live" | "past";

export async function marketTable(): Promise<MarketTable | null> {
  const answer = await fetch(ERAPI_URL, { signal: AbortSignal.timeout(PATIENCE) });
  if (!answer.ok) return null;

  const body = (await answer.json()) as ErApi;
  if (body.result !== "success" || !body.rates) return null;

  const built = Number(body.time_last_update_unix) * 1000;
  const day = stamp(
    Number.isFinite(built) && built > 0
      ? new Date(
          new Date(built).toLocaleString("en-US", { timeZone: "America/Montevideo" }) + " UTC",
        )
      : montevideoNow(),
  );

  return { day, perUsd: { ...body.rates, USD: 1 }, fetchedAt: Date.now(), source: "live" };
}

/**
 * The market's past days, from the archive this package keeps.
 *
 * ExchangeRate-API's free table is only today's, so a day gone by comes from
 * `data/market/YYYY-MM.json`: every currency against the dollar, once a day since
 * 2 March 2024, public-domain reference rates (within about one percent of
 * ExchangeRate-API's) kept in the repository and published with the package every
 * month (`scripts/archive.ts`). It is read from the package as npm serves it
 * (jsDelivr), or from the repository when that has none yet: a month a request,
 * kept in memory.
 */
export const PAST_MARKET_FROM = "2024-03-02";

/** The credit a past day goes with: this package's archive. */
export const PAST_MARKET_CREDIT = {
  label: "exchange-rates-uy",
  href: "https://github.com/guillecura/exchange-rates-uy",
} as const;

/** The credit a table's figures go with. */
export const marketCredit = (source: MarketSource | undefined) => (source === "past" ? PAST_MARKET_CREDIT : MARKET_CREDIT);

/** One month of the archive: each day's table, how many of each currency buy one dollar. */
export interface MarketMonth {
  base: "USD";
  month: string;
  days: Record<string, Record<string, number>>;
}

/** Where a month of the archive is read from, in order. */
export const archiveUrls = (month: string) => [
  `https://cdn.jsdelivr.net/npm/exchange-rates-uy@1/data/market/${month}.json`,
  `https://raw.githubusercontent.com/guillecura/exchange-rates-uy/main/data/market/${month}.json`,
];

const months = new Map<string, { at: number; file: Promise<MarketMonth | null> }>();
/** A month read again after this long when a day asked for is not in it yet (the newest month grows). */
const STALE = 6 * 3_600_000;

async function readMonth(month: string, fetcher: typeof fetch): Promise<MarketMonth | null> {
  for (const url of archiveUrls(month)) {
    const answer = await fetcher(url, { signal: AbortSignal.timeout(PATIENCE) }).catch(() => null);
    if (!answer?.ok) continue;
    const body = (await answer.json().catch(() => null)) as MarketMonth | null;
    if (body?.month === month && body.days && typeof body.days === "object") return body;
  }
  return null;
}

/**
 * The market's table of a past `day` (`YYYY-MM-DD`, from `PAST_MARKET_FROM`): that day's, or the last one before it
 * within a week (the archive lacks a few days), saying which (`day`); null when there is none.
 */
export async function pastMarketTable(day: string, fetcher: typeof fetch = fetch): Promise<MarketTable | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < PAST_MARKET_FROM) return null;
  for (let back = 0; back < 7; back += 1) {
    const d = new Date(Date.parse(`${day}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    if (d < PAST_MARKET_FROM) break;
    const t = await archivedDay(d, fetcher);
    if (t) return t;
  }
  return null;
}

async function archivedDay(day: string, fetcher: typeof fetch): Promise<MarketTable | null> {
  const month = day.slice(0, 7);
  let kept = months.get(month);
  if (kept) {
    const file = await kept.file;
    if (!file || (!file.days[day] && Date.now() - kept.at > STALE)) kept = undefined;
  }
  if (!kept) {
    kept = { at: Date.now(), file: readMonth(month, fetcher) };
    months.set(month, kept);
  }
  const file = await kept.file;
  if (!file) months.delete(month);
  const perUsd = file?.days[day];
  if (!perUsd?.UYU) return null;
  return { day, perUsd: { ...perUsd, USD: 1 }, fetchedAt: Date.now(), source: "past" };
}

/** Forgets the months read (a test's). */
export const forgetArchive = () => months.clear();

/**
 * The table turned into the pairs asked for, among the currencies allowed.
 *
 * Theirs is one column: how many of each currency buy a dollar. So a pair is one
 * of three sums against it: the dollar as the base is the column straight, the
 * dollar as the quote is the column upside down, and a pair with no dollar in it
 * at all is one divided by the other.
 *
 * By ISO code, which is how their table is keyed: CNY and not a house's own RMB.
 */
export function marketPairs(
  table: MarketTable,
  pairs: readonly PairSpec[],
  /** The ISO codes that may be read; a pair touching any other is left out. */
  allowed: ReadonlySet<string>,
): Rate[] {
  return pairs.flatMap(({ pair, base, quote }) => {
    if (!allowed.has(base) || !allowed.has(quote)) return [];

    /* One number and it goes in both: no spread is published, and writing the same
       figure twice is what is true. */
    const rate = marketCross(table.perUsd, base, quote);
    return rate === null
      ? []
      : [
          {
            source: "erapi" as const,
            pair,
            day: table.day,
            buy: rate,
            sell: rate,
            fetchedAt: table.fetchedAt,
          },
        ];
  });
}

/** The market rates for the pairs asked for, in a single request. */
export async function fetchMarket(
  pairs: readonly PairSpec[],
  allowed: ReadonlySet<string>,
): Promise<Rate[]> {
  const table = await marketTable();
  return table ? marketPairs(table, pairs, allowed) : [];
}
