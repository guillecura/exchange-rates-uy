/**
 * exchange-rates-uy: exchange rates, the official one and the market's, and the
 * arithmetic that turns what each publishes into any pair.
 *
 * This entry point is the library, with no server in it and nothing to keep: the
 * two sources, the pair arithmetic and the time helpers. Formatting a currency is
 * `exchange-rates-uy/money`. A server that keeps the readings, answers an API and
 * has a panel to add currencies and pairs is `exchange-rates-uy/server`, on any
 * database (`/sqlite`, `/d1`, `/postgres`) and any platform (`/worker`, `/node`,
 * `/lambda`, or its `fetch` anywhere else).
 *
 * ## Two sources because they answer two questions
 *
 * The **BCU** (Banco Central del Uruguay) is the official one (`bcu.ts`): buying
 * and selling, once a working day. **ExchangeRate-API** is the market
 * (`market.ts`): one number, every currency, every day. Neither replaces the other
 * and that is why they are two readings and not an average: an average of an
 * official rate and a market one is a figure that is true nowhere.
 */

export * from "./rates/types.ts";
export * from "./rates/time.ts";
export * from "./rates/convert.ts";
export {
  BCU_CURRENCIES,
  BCU_PAGE,
  BCU_QUOTE,
  PATIENCE,
  bcuBetween,
  bcuCode,
  bcuOn,
  bcuPairs,
  fetchBcu,
  latestBcu,
  type BcuReading,
} from "./rates/bcu.ts";
export {
  MARKET_CREDIT, PAST_MARKET_CREDIT, PAST_MARKET_FROM, archiveUrls, fetchMarket, forgetArchive, marketCredit, marketPairs, marketTable, pastMarketTable,
  type MarketMonth, type MarketSource, type MarketTable,
} from "./rates/market.ts";
