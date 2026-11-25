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
 * The market's past days, from fawazahmed0's exchange-api.
 *
 * ExchangeRate-API's free table is only today's, so a day gone by comes from here:
 * an open dataset (CC0) that has published every currency against the dollar once a
 * day since 2 March 2024, from several open sources, and is served from two CDNs.
 * Its figures sit within about one percent of ExchangeRate-API's, so a past day is
 * the market's that day and not the bank's, and its credit says whose it is
 * (`PAST_MARKET_CREDIT`). Only the currencies with an ISO 4217 code are kept: the
 * dataset also carries crypto tokens, which no table here has.
 */
export const PAST_MARKET_FROM = "2024-03-02";

export const PAST_MARKET_CREDIT = {
  label: "Rates by fawazahmed0/exchange-api",
  href: "https://github.com/fawazahmed0/exchange-api",
} as const;

/** The credit a table's figures go with. */
export const marketCredit = (source: MarketSource | undefined) => (source === "past" ? PAST_MARKET_CREDIT : MARKET_CREDIT);

const pastUrls = (day: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`,
  `https://${day}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];

/** The market's table of a past `day` (`YYYY-MM-DD`, from `PAST_MARKET_FROM`), or null when neither CDN has it. */
export async function pastMarketTable(day: string, fetcher: typeof fetch = fetch): Promise<MarketTable | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < PAST_MARKET_FROM) return null;
  for (const url of pastUrls(day)) {
    const answer = await fetcher(url, { signal: AbortSignal.timeout(PATIENCE) }).catch(() => null);
    if (!answer?.ok) continue;
    const body = (await answer.json().catch(() => null)) as { date?: string; usd?: Record<string, number> } | null;
    if (!body?.usd || body.date !== day) continue;
    const perUsd: Record<string, number> = { USD: 1 };
    for (const [code, v] of Object.entries(body.usd)) {
      const iso = code.toUpperCase();
      if (/^[A-Z]{3}$/.test(iso) && ISO_CODES.has(iso) && Number.isFinite(v) && v > 0) perUsd[iso] = v;
    }
    if (!perUsd.UYU) continue;
    return { day, perUsd, fetchedAt: Date.now(), source: "past" };
  }
  return null;
}

const ISO_CODES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
);

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
