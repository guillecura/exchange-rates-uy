/**
 * Where a rate came from.
 *
 * The market one is stored under the provider's own name and not under a word like
 * "market": what is on file has to say which figure it is, because the day the
 * provider changes the old rows are still that provider's.
 */
export type RateSource = "bcu" | "erapi";

/** The two kinds of figure, as the API names them: the bank's and the market's. */
export type RateKind = "official" | "market";

/** One reading of one pair: one `base` buys `buy` (or `sell`) of the `quote`. */
export interface Rate {
  source: RateSource;
  /** The pair's name, `BASE/QUOTE`. */
  pair: string;
  /** The day the rate belongs to, which on a Monday is not always today. */
  day: string;
  buy: number;
  sell: number;
  /** When it was actually fetched, in milliseconds. */
  fetchedAt: number;
}

/** What gets read against what: `pair` is the name, `base`/`quote` its two sides. */
export interface PairSpec {
  pair: string;
  base: string;
  quote: string;
}

/** A currency as the sources need it: its ISO code, and the BCU's number for it. */
export interface CurrencySpec {
  iso: string;
  /** The number the central bank calls it by, or zero where it does not quote it. */
  bcu: number;
}
