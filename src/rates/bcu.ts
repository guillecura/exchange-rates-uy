import { officialCross, type Spread } from "./convert.ts";
import { montevideoNow, stamp } from "./time.ts";
import type { CurrencySpec, PairSpec, Rate } from "./types.ts";

/**
 * The official rates, from the BCU.
 *
 * It is what an invoice, a tax return and any figure that has to agree with
 * somebody outside gets read against. It publishes a pair, buying and selling
 * (`TCC` and `TCV`), and on a bank holiday it publishes nothing.
 *
 * ## How it is asked
 *
 * The BCU has a SOAP service, which is what there is: no REST, no key, and the
 * envelope is written out by hand because pulling in a SOAP client for one
 * operation with four fields is a dependency that has to be kept alive for a
 * request that fits on a screen. The answer gets read with a regular expression
 * for the same reason: it is a handful of known tags out of a document whose shape
 * is published in the WSDL, not a general XML problem.
 *
 * Every currency comes out of a single call: what the bank publishes is each one
 * against the peso, and against the dollar the arbitrage it publishes beside them
 * (`ArbAct`), which is that division already done at the source.
 *
 * `FechaDesde` and `FechaHasta` are a real range and not a formality, so a stretch
 * of days is one call too: see `bcuBetween`, which is the one request this module
 * makes. A reading of one day is that range with both ends on it.
 *
 * ## Nothing here throws
 *
 * A source that is down is a source that is down: whoever calls gets nothing back
 * and decides what that means (the server keeps what it had and
 * says so in its log).
 */

/**
 * The peso, which is the one currency the official source never quotes.
 *
 * Everything the BCU publishes is "how many pesos buy one of these", so the peso
 * is the quote side of every official pair and is never asked for.
 */
export const BCU_QUOTE = "UYU";

/**
 * The numbers the BCU calls each currency by, from the bank's own list
 * (`awsbcumonedas`, group 0), which is where it is published.
 *
 * Thirty four of the forty rows it returns are currencies; the rest are variants
 * of one already here (the cable and the fund's average beside the note's dollar,
 * the Argentine peso and the real in banknote form) and one that is not a currency
 * at all (the market's average rate). A variant is not a second currency, so none
 * of them is mapped.
 *
 * 2225 is `DLS. USA BILLETE`, the cash rate, which is the one published on the
 * board and the one anybody means by "the dollar"; 2224 is the interbank one and it
 * is a different figure for a different question.
 *
 * The server looks a kept currency's number up here (`bcuCode`), so a currency the
 * bank quotes joins the official reading the moment it is kept, with no code to
 * change.
 */
/** The currencies whose arbitrage the bank publishes as dollars per unit; every other's comes as units per dollar. */
export const ARB_DOLLARS_PER_UNIT: ReadonlySet<string> = new Set(["EUR", "GBP", "AUD", "NZD", "XDR", "UP", "UI"]);

export const BCU_CURRENCIES: Readonly<Record<string, { code: number; name: string }>> = {
  XDR: { code: 2, name: "DER.ESP. DE GIRO" },
  AUD: { code: 105, name: "DOL. AUSTRALIANO" },
  ARS: { code: 500, name: "PESO ARGENTINO" },
  BRL: { code: 1000, name: "REAL" },
  EUR: { code: 1111, name: "EURO" },
  CLP: { code: 1300, name: "PESO CHILENO" },
  NZD: { code: 1490, name: "DOL. NEOZELANDES" },
  ZAR: { code: 1620, name: "RAND SUDAFRICANO" },
  DKK: { code: 1800, name: "CORONA DANESA" },
  USD: { code: 2225, name: "DLS. USA BILLETE" },
  CAD: { code: 2309, name: "DOLAR CANADIENSE" },
  GBP: { code: 2700, name: "LIBRA ESTERLINA" },
  JPY: { code: 3600, name: "YEN" },
  PEN: { code: 4000, name: "NVO.SOL PERUANO" },
  CNY: { code: 4150, name: "YUAN RENMIMBI" },
  CNH: { code: 4155, name: "YUAN OFF SHORE" },
  MXN: { code: 4200, name: "PESO MEXICANO" },
  HUF: { code: 4300, name: "FORINT HUNGARO" },
  TRY: { code: 4400, name: "LIRA TURCA" },
  NOK: { code: 4600, name: "CORONA NORUEGA" },
  PYG: { code: 4800, name: "GUARANI" },
  ISK: { code: 4900, name: "CORONA ISLANDESA" },
  HKD: { code: 5100, name: "DOLAR HONG KONG" },
  KRW: { code: 5300, name: "WON" },
  RUB: { code: 5400, name: "RUBLO" },
  COP: { code: 5500, name: "PESO COLOMBIANO" },
  MYR: { code: 5600, name: "RINGGIT MALAYO" },
  INR: { code: 5700, name: "RUPIA INDIA" },
  SEK: { code: 5800, name: "CORONA SUECA" },
  CHF: { code: 5900, name: "FRANCO SUIZO" },
  VES: { code: 6200, name: "BOLIVAR" },
  UP: { code: 9700, name: "UNIDAD PREVISIONAL" },
  UI: { code: 9800, name: "UNIDAD INDEXADA" },
  UR: { code: 9900, name: "UNIDAD REAJUSTAB" },
};

/** The number the bank calls a currency by, or zero where it does not quote it. */
export function bcuCode(iso: string): number {
  return BCU_CURRENCIES[iso]?.code ?? 0;
}

const BCU_URL = "https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones";

/** Where a person reads the same rates on the bank's own site. */
export const BCU_PAGE =
  "https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx";

/** How long a source gets before the reading is given up on. */
export const PATIENCE = 15_000;

function tag(xml: string, name: string): string | null {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]?.trim() ?? null;
}

/** Each currency's block of the answer, split before anything is read out of it. */
function entries(xml: string): string[] {
  return xml.split("<datoscotizaciones.dato").slice(1);
}

/** What the bank said on one day: each currency in pesos, and what it published directly. */
export interface BcuReading {
  /** The day the bank stamped it, which on a Monday is not the day it was asked. */
  day: string;
  /** Each currency's buying and selling price in pesos, the peso itself at one. */
  perLocal: Readonly<Record<string, Spread>>;
  /** The pairs the bank published already divided, keyed `ISO/USD`. */
  published: Readonly<Record<string, Spread>>;
  fetchedAt: number;
}

/**
 * The official rates for a stretch of days, one reading per day the bank
 * published, earliest first.
 *
 * An empty list is a normal answer and not a failure: on a Saturday, on a bank
 * holiday and before the day's publication the service replies correctly with
 * nothing, and over a range the days it did not publish are simply absent. Nothing
 * here fills a gap in, because a day the bank was shut has no official rate and
 * inventing one is the thing the whole module exists not to do.
 *
 * ## The window has a cap, and the cap moves
 *
 * The bank refuses a range it considers too wide (`Rango de fechas excede lo
 * permitido`, which arrives as a status that is not 1 and lands here as an empty
 * list), and how wide that is shrinks as more currencies are asked for: a full year
 * of a single currency goes through. So a longer history is walked a year at a time
 * and one currency at a time, by whoever wants it.
 *
 * The day is read off each block and never off the request, which is the one thing
 * a range changes: over a stretch the blocks of different days arrive mixed in a
 * single list, and a Monday's reading stamped with the day it was asked for is a
 * figure filed under a date it was never true on.
 */
export async function bcuBetween(
  from: string,
  to: string,
  currencies: readonly CurrencySpec[],
): Promise<BcuReading[]> {
  const quoted = currencies.filter((one) => one.bcu > 0);
  if (quoted.length === 0) return [];

  const wanted = quoted.map((one) => `<cot:item>${one.bcu}</cot:item>`).join("");

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza">` +
    `<soapenv:Body><cot:wsbcucotizaciones.Execute><cot:Entrada>` +
    `<cot:Moneda>${wanted}</cot:Moneda>` +
    `<cot:FechaDesde>${from}</cot:FechaDesde><cot:FechaHasta>${to}</cot:FechaHasta>` +
    `<cot:Grupo>0</cot:Grupo>` +
    `</cot:Entrada></cot:wsbcucotizaciones.Execute></soapenv:Body></soapenv:Envelope>`;

  const answer = await fetch(BCU_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: '""' },
    body: envelope,
    signal: AbortSignal.timeout(PATIENCE),
  });

  if (!answer.ok) return [];

  const xml = await answer.text();
  /* The status comes back inside the envelope and not as an HTTP code: a bad
     request is a 200 with a `status` that is not 1. */
  if (tag(xml, "status") !== "1") return [];

  const fetchedAt = Date.now();
  const byDay = new Map<
    string,
    { perLocal: Record<string, Spread>; published: Record<string, Spread> }
  >();

  for (const block of entries(xml)) {
    const which = Number(tag(block, "Moneda"));
    const on = tag(block, "Fecha");
    const buy = Number(tag(block, "TCC"));
    const sell = Number(tag(block, "TCV"));

    if (!on || !Number.isFinite(buy) || buy <= 0) continue;

    const currency = quoted.find((one) => one.bcu === which);
    if (!currency) continue;

    /*
     * What the bank said about each currency that day, in pesos.
     *
     * Everything it publishes is "how many pesos buy one of these", which is the
     * whole shape of this source: the peso is the quote side of every reading and is
     * never asked for, so it goes in at one.
     */
    let reading = byDay.get(on);

    if (!reading) {
      reading = { perLocal: { [BCU_QUOTE]: { buy: 1, sell: 1 } }, published: {} };
      byDay.set(on, reading);
    }

    reading.perLocal[currency.iso] = { buy, sell };

    /*
     * The arbitrage, which is this source's one extra.
     *
     * On a currency's own block the bank also publishes what it is worth in dollars
     * (`ArbAct`), already divided at the source. Kept apart because it is the bank's
     * own figure for that pair and not this module's arithmetic on two of its
     * others: where the two disagree by a hundredth, the published one is the one an
     * invoice will be read against.
     *
     * It comes the way each currency is quoted against the dollar in the market:
     * dollars per unit for the euro, the pound, the Australian and New Zealand
     * dollars, the SDR and the indexed units (`ARB_DOLLARS_PER_UNIT`), units per
     * dollar for every other (1579 pesos argentinos, 5.94 reales). Kept always as
     * dollars per unit, under `ISO/USD`.
     */
    const arb = Number(tag(block, "ArbAct"));

    if (Number.isFinite(arb) && arb > 0) {
      const usd = ARB_DOLLARS_PER_UNIT.has(currency.iso) ? arb : 1 / arb;
      reading.published[`${currency.iso}/USD`] = { buy: usd, sell: usd };
    }
  }

  return [...byDay.entries()]
    .sort(([one], [other]) => one.localeCompare(other))
    .map(([day, reading]) => ({ day, ...reading, fetchedAt }));
}

/**
 * The official rates for a given day, or nothing.
 *
 * A day is the range with both ends on it, which is why this is three lines: the
 * request, the status and the parse live in `bcuBetween` and there is one of each.
 * Nothing is a normal answer and not a failure, and whoever calls this walks back a
 * day at a time (see `latestBcu`).
 */
export async function bcuOn(
  day: string,
  currencies: readonly CurrencySpec[],
): Promise<BcuReading | null> {
  const [reading] = await bcuBetween(day, day, currencies);
  return reading ?? null;
}

/**
 * The last official reading standing, looking back from today.
 *
 * It walks back day by day and stops at the first one that answers, up to a week:
 * a Monday morning has to show Friday's, and the longest stretch the BCU goes
 * without publishing is a long weekend plus a holiday. Past that, something is
 * wrong at the other end and showing a rate from another week would be worse than
 * showing none.
 */
export async function latestBcu(currencies: readonly CurrencySpec[]): Promise<BcuReading | null> {
  const today = montevideoNow();

  for (let back = 0; back < 7; back += 1) {
    const day = stamp(new Date(today.getTime() - back * 86_400_000));
    const reading = await bcuOn(day, currencies).catch(() => null);
    if (reading) return reading;
  }

  return null;
}

/**
 * A reading turned into the pairs asked for: each one through `officialCross`,
 * which is what the bank published directly where it did and a division through
 * the peso where it did not. That is how a dollar against the Argentine peso gets
 * a reading the bank never published: it published both against ours.
 */
export function bcuPairs(reading: BcuReading, pairs: readonly PairSpec[]): Rate[] {
  return pairs.flatMap(({ pair, base, quote }) => {
    const rate = officialCross(reading.perLocal, reading.published, base, quote);
    return rate
      ? [{ source: "bcu" as const, pair, day: reading.day, ...rate, fetchedAt: reading.fetchedAt }]
      : [];
  });
}

/** The last official rates standing, for the pairs asked for. */
export async function fetchBcu(
  currencies: readonly CurrencySpec[],
  pairs: readonly PairSpec[],
): Promise<Rate[]> {
  const reading = await latestBcu(currencies);
  return reading ? bcuPairs(reading, pairs) : [];
}
