/**
 * Any pair, out of what each source publishes.
 *
 * The one place the arithmetic is written: the panel turns a reading into the
 * pairs it keeps with it (`bcuPairs`, `marketPairs`), and the public converter
 * turns the same readings into whatever pair somebody picks.
 */

/** Buying and selling, the official source's shape. */
export interface Spread {
  buy: number;
  sell: number;
}

/**
 * The official rate for one `base` in `quote`, out of the bank's reading.
 *
 * What the bank published already divided wins (`published`, keyed `BASE/QUOTE`), either way round.
 * Otherwise it is one division through the peso, which the bank quotes everything
 * against: the base's pesos over the quote's. Buying and selling stay on their own
 * sides of the division, so the spread of a derived pair is the two spreads
 * compounded, which is what it costs to go through the peso. Nothing when either
 * side is a currency the bank does not quote.
 */
export function officialCross(
  perLocal: Readonly<Record<string, Spread>>,
  published: Readonly<Record<string, Spread>>,
  base: string,
  quote: string,
): Spread | null {
  const direct = published[`${base}/${quote}`];
  if (direct) return direct;
  // The same pair the other way round: the bank's selling price becomes the buying one.
  const reverse = published[`${quote}/${base}`];
  if (reverse && reverse.buy > 0 && reverse.sell > 0) return { buy: 1 / reverse.sell, sell: 1 / reverse.buy };

  const from = perLocal[base];
  const to = perLocal[quote];
  if (!from || !to) return null;

  const buy = from.buy / to.sell;
  const sell = from.sell / to.buy;

  return Number.isFinite(buy) && buy > 0 ? { buy, sell } : null;
}

/**
 * The market rate for one `base` in `quote`, out of its table of how many of each
 * currency buy a dollar: the quote's column over the base's. Nothing when either
 * is missing from the table.
 */
export function marketCross(
  perUsd: Readonly<Record<string, number>>,
  base: string,
  quote: string,
): number | null {
  const from = Number(perUsd[base]);
  const to = Number(perUsd[quote]);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
  return to / from;
}
