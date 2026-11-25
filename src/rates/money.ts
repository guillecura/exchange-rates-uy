/**
 * What a currency is called, what it is marked with, and how a price is written.
 *
 * Nothing here is stored. A currency is its ISO code and the platform holds the
 * rest: `Intl` knows the yen takes no decimals, that the taka is ৳ and that CNY is
 * "yuan renminbi" in Spanish and "Chinese Yuan" in English. A copy of any of those
 * in a column is a fact that can go stale, and three fields somebody has to type
 * to add a currency.
 *
 * It is not `server-only`: a price is drawn on a screen, so this has to reach the
 * browser. Nothing in it opens a database: the only things the server keeps about
 * a currency are that it is kept and, where somebody wrote one, its own mark.
 *
 * ## Why prices are not written with the symbol alone
 *
 * Because a symbol does not say which currency it is. Asked for the narrow one,
 * `Intl` gives the currency's own mark and the same one in every locale, which is
 * what makes it right for a badge next to a code, and wrong on its own:
 *
 *     USD $   UYU $   ARS $   CLP $
 *     CNY ¥   JPY ¥
 *
 * A ledger kept in dollars and pesos that draws "$ 1.234,50" has said nothing. So
 * money is written with the code (`USD 1,234.50`) wherever more than one currency
 * can appear, which in this office is everywhere, and the symbol is for the places
 * that have already said which currency they are talking about.
 */

/**
 * The mark: the office's own where it wrote one down, the standard's otherwise.
 *
 * The standard's is the same in every locale, which is what makes it a good default
 * and not a good answer on its own: it does not identify the currency. Four of them
 * narrow to "$" and two to "¥". Where that matters the office writes the one it
 * wants (a kept currency's `symbol`), and in Uruguay that is a peso "$" against a
 * dollar "US$".
 *
 * Falls back to the code where a currency has no symbol at all, which is the truth
 * about it and not a gap.
 */
export function currencySymbol(iso: string, override = ""): string {
  if (override) return override;

  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: iso,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(1)
        .find((part) => part.type === "currency")?.value ?? iso
    );
  } catch {
    return iso;
  }
}

/** What it is called, in the language the screen is being read in. */
export function currencyName(iso: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** How many places it is written with: none for the yen, three for the dinar. */
export function currencyPlaces(iso: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: iso }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

let KNOWN: Set<string> | null = null;
const known = () => (KNOWN ??= new Set(Intl.supportedValuesOf("currency")));

/**
 * Whether a string is a currency the standard knows.
 *
 * Three letters is what the shape is, and the platform's list of currencies is what
 * says the rest: the check nobody has to maintain a list for.
 */
export function isKnownCurrency(iso: string): boolean {
  if (!/^[A-Z]{3}$/.test(iso)) return false;

  /* Formatting is not the check it looks like: `Intl` formats any three letters it
     is given ("ZZZ 1.00"), well formed being all it asks. Its list of currencies is
     the real one, where the platform has it. */
  if (typeof Intl.supportedValuesOf === "function") return known().has(iso);

  try {
    new Intl.NumberFormat("en", { style: "currency", currency: iso }).format(1);

    return true;
  } catch {
    return false;
  }
}

/**
 * A price, written so it says which currency it is.
 *
 * The code and not the symbol, for the reason above. `Intl` puts it where the
 * locale puts it and groups and rounds the way the locale does, which is the whole
 * point of not doing this by hand.
 */
export function money(amount: number, iso: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: iso,
      currencyDisplay: "code",
    }).format(amount);
  } catch {
    return `${iso} ${amount.toFixed(2)}`;
  }
}

/**
 * Where it is the money, in the language the screen is being read in.
 *
 * Not stored and not a table: a currency's ISO code is its country's two letters
 * plus a letter for the currency itself, so `USD` is the US dollar and `BDT` the
 * Bangladeshi taka. The region's own name comes from the platform.
 *
 * Except for the codes that start with X, which is the standard's way of saying
 * "this is not a country's money": gold is `XAU`, the IMF's drawing rights `XDR`.
 * Those two letters are not a region and asking for one gets nonsense back: CLDR
 * answers `XA` with "Pseudo-Accents", which is a locale it keeps for testing. So
 * they get nothing, which is the truth.
 */
export function currencyCountry(iso: string, locale: string): string {
  if (iso.startsWith("X")) return "";

  try {
    const region = new Intl.DisplayNames([locale], { type: "region" }).of(iso.slice(0, 2));

    /* It hands the code back when it does not know it, and a two letter code is not
       a country's name. */
    return region && region !== iso.slice(0, 2) ? region : "";
  } catch {
    return "";
  }
}

/**
 * Every currency the standard has, for picking one off a list.
 *
 * The point of the list is that nobody has to know the code. Somebody adding the
 * Argentine peso knows the word "Argentina" and not that it is `ARS`, so each one
 * carries what it is called and where it is from, and the search box reads all
 * three.
 *
 * The name and the country travel apart as well, for a screen that draws them in
 * columns. A client screen gets this list from its server and does not build it
 * again: the names are the platform's tables, and Node's and the browser's are
 * different versions (one says "Hong Kong SAR China" where the other says "Hong
 * Kong", one knows currencies the other does not), so a list built on both sides
 * never hydrates.
 */
export function everyCurrency(
  locale: string,
): { iso: string; name: string; country: string; label: string }[] {
  return Intl.supportedValuesOf("currency").map((iso) => {
    const name = currencyName(iso, locale);
    const country = currencyCountry(iso, locale);

    return {
      iso,
      name,
      country,
      label: [iso, name, country].filter(Boolean).join(" · "),
    };
  });
}

/**
 * How many places a rate is written with.
 *
 * Not a fixed count. A rate is not an amount of money, it is a ratio, and the ratios
 * this office reads run from 0.00066 to 1506: two places is right for one end and
 * says nothing at all at the other.
 *
 * What holds across all of them is **four digits that mean something**. Where the
 * whole part already has four, there are no decimals to write; where it has one,
 * three follow it:
 *
 *   1506.9002 → 1507      four before the point, so none after
 *   40.0784   → 40.08     two before, two after
 *   6.7387    → 6.739     one before, three after
 *   1.1666    → 1.167     the same
 *   0.024951  → 0.0250    under one the zeros are not digits: past them, then three
 *   0.000664  → 0.000664  the same three, three zeros later
 *
 * The last two are the one case that is not simply four: below one the leading zeros
 * are notation and not information, so the count starts after them. A peso against
 * the dollar written to two places is `0.02`, which is not a rate, it is a shrug.
 */
export function ratePlaces(value: number): number {
  const size = Math.abs(value);

  if (!Number.isFinite(size) || size === 0) return 2;

  if (size >= 1) {
    /* How many digits the whole part is already spending. */
    const whole = Math.floor(Math.log10(size)) + 1;

    const places = Math.max(SIGNIFICANT - whole, 0);

    /*
     * And two of them at least, until the whole part is four digits long.
     *
     * Four significant on its own would write a taka at 122.5, and a rate of a
     * hundred and something is the same kind of figure as one of forty: it is read
     * to the cent, and one place there is a rounding somebody has to think about.
     * The floor lifts only where it changes something (from ten to a thousand)
     * because past a thousand the cents are noise and below ten there is room for
     * three without the floor being reached at all.
     */
    return whole >= SIGNIFICANT ? places : Math.max(places, 2);
  }

  /* Past the zeros and then three that mean something. `log10` of 0.0249 is -1.6,
     whose floor is -2, so there is one zero to clear. Capped at eight, past which a
     rate is not being read, it is being stared at. */
  return Math.min(-Math.floor(Math.log10(size)) + SIGNIFICANT - 2, 8);
}

/** How much of a rate anybody actually reads. See `ratePlaces`. */
const SIGNIFICANT = 4;

/**
 * The tag a plain number gets formatted under.
 *
 * Spanish does not separate four digits: a rate of a thousand five hundred is
 * `1507`, and the point comes in from five digits up (`10.500`). That is the RAE's
 * rule and the SI's, and English is the other way: `1,507` from a thousand. Both
 * are right in their own language.
 *
 * `Intl` knows it, and knows it under the bare language: asked for `es` it writes
 * `1507` and asked for `es-AR` or `es-UY` it writes `1.507`. That is a hole in those
 * two locales' data and not a different rule in those two countries, so what gets
 * handed over is the language.
 *
 * Only for a plain number. A date or an amount of money has real regional shape,
 * which is why this is here and not applied to everything that formats.
 */
function forNumbers(locale: string): string {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return locale;
  }
}

/**
 * A rate, written for the language the screen is being read in.
 *
 * The places come from the figure itself (`ratePlaces`) and the grouping and the
 * decimal mark come from the locale, which is the whole reason this goes through
 * `Intl` and not through `toFixed`. An Uruguayan reader writes a thousand and a half
 * as `1.506,90` and an English one as `1,506.90`, and a screen that picks one of
 * those and hands it to everybody is wrong for half the office.
 */
export function rate(value: number, locale: string): string {
  const places = ratePlaces(value);

  try {
    return new Intl.NumberFormat(forNumbers(locale), {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(value);
  } catch {
    return value.toFixed(places);
  }
}

/**
 * A figure with the currency's own mark on it, and the sign in front of everything.
 *
 * `Intl` writes a negative amount as `-US$ 12.00`, which puts the minus in front of
 * the mark and reads for a beat as a negative dollar rather than as an amount that
 * is negative. What is negative is the quantity, so the sign goes where the quantity
 * starts: `US$ -12.00`.
 *
 * And the mark and not the code, for a box whose column already says which currency
 * it is in: `USD 1,368,796.65` down three rows is the word said three times, and
 * what the reader is comparing is the figures. The code is right where more than one
 * currency can turn up in the same column, which is why `money` still writes it.
 */
export function marked(amount: number, iso: string, symbol: string, locale: string): string {
  const size = Math.abs(amount);
  const places = currencyPlaces(iso);

  let body: string;

  try {
    body = new Intl.NumberFormat(forNumbers(locale), {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(size);
  } catch {
    body = size.toFixed(places);
  }

  return `${currencySymbol(iso, symbol)} ${amount < 0 ? "-" : ""}${body}`;
}
