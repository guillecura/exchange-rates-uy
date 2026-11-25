/**
 * The client: what an app uses to read exchange rates, the same calls in two ways.
 *
 *   With a server (`baseUrl`): it asks an exchange-rates-uy server, which keeps the history and the pairs (yours, or
 *   rates.whitebear.io with its key).
 *   Without one: it reads the sources itself, the BCU and the market, with the same arithmetic the server uses
 *   (`direct.ts`). The market's past days need a server (the source only gives today's), and in a browser the BCU
 *   refuses other pages (no CORS), so there the direct way works on a server (Node, Deno, Workers) only.
 *
 *   import { createRatesClient } from "exchange-rates-uy/client";
 *   const rates = createRatesClient({ baseUrl: "https://rates.whitebear.io/api", key: Deno.env.get("RATES_API_KEY") });
 *   const alone = createRatesClient({ pairs: ["USD/UYU", "EUR/UYU"] });   // no server
 *   const bank = await rates.official();                 // the BCU's pesos per unit, buying and selling
 *   const usd = await rates.history("USD/UYU", { from: "2026-01-01" });
 *
 * Deno can take it straight from the repository: `https://raw.githubusercontent.com/guillecura/exchange-rates-uy/<tag>/src/client.ts`.
 */
import { createDirectClient, type DirectOptions } from "./direct.ts";

export interface Spread {
  buy: number;
  sell: number;
}

/** The bank's reading on or before a day: each currency in pesos, and what it published against the dollar. */
export interface Official {
  date: string;
  day: string;
  perLocal: Record<string, Spread>;
  published: Record<string, Spread>;
  quote: string;
  source: string;
}

/** The market's table on or before a day: how many of each currency buy one dollar, and its credit. */
export interface Market {
  date: string;
  day: string;
  perUsd: Record<string, number>;
  base: "USD";
  credit: { label: string; href: string };
}

export interface PairRate {
  pair: string;
  base: string;
  quote: string;
  favourite: boolean;
  official: { day: string; buy: number; sell: number } | null;
  market: { day: string; rate: number } | null;
}

export interface Currency {
  iso: string;
  name: string;
  symbol: string;
  places: number;
  official: boolean;
}

export interface Conversion {
  amount: number;
  from: string;
  to: string;
  date: string;
  day: string;
  source: "official" | "market";
  side?: "buy" | "sell" | "mid";
  rate: number;
  result: number;
}

export interface ServerOptions {
  /** The API's address, `…/api` included: `https://rates.whitebear.io/api`. */
  baseUrl: string;
  /** The server-side caller's key, when the server asks for one. Never put it in a browser. */
  key?: string;
  /** Another `fetch` (a test's, a platform's). */
  fetch?: typeof fetch;
  /** How long a call may take, in milliseconds (15 000). */
  timeout?: number;
}

/** What a call that failed says: the status, and the server's own words. */
export class RatesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RatesError";
  }
}

export type RatesClientOptions = ServerOptions | DirectOptions;

/** The same calls whichever way it reads. */
export interface RatesClient {
  /** The bank's reading on `date` (the last on or before it; today by default). */
  official(date?: string): Promise<Official>;
  /** The market's table on `date` (without a server, only today's). */
  market(date?: string): Promise<Market>;
  /** The pairs, each with both rates, on `date`. */
  pairs(date?: string): Promise<PairRate[]>;
  /** The currencies, named in `lang`. */
  currencies(lang?: string): Promise<Currency[]>;
  /** One pair, day by day, from one source (the bank's by default). At most ten years per call. */
  history(pair: string, opts?: { from?: string; to?: string; source?: "official" | "market" }): Promise<HistoryDay[]>;
  /** An amount in another currency. */
  convert(opts: { amount: number; from: string; to: string; date?: string; source?: "official" | "market"; side?: "buy" | "sell" | "mid" }): Promise<Conversion>;
  /** The newest day of each source. */
  status(): Promise<{ freshest: { official: string | null; market: string | null } }>;
}

export interface HistoryDay {
  day: string;
  buy: number;
  sell: number;
}

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A client: on a server when given its `baseUrl`, else reading the sources itself. */
export function createRatesClient(o: RatesClientOptions = {}): RatesClient {
  return "baseUrl" in o && o.baseUrl ? serverClient(o) : createDirectClient(o as DirectOptions);
}

function serverClient(o: ServerOptions): RatesClient {
  const base = o.baseUrl.replace(/\/+$/, "");
  const call = async <T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    const q = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    const res = await (o.fetch ?? fetch)(`${base}${path}${q ? `?${q}` : ""}`, {
      headers: { Accept: "application/json", ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}) },
      signal: AbortSignal.timeout(o.timeout ?? 15_000),
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) throw new RatesError(res.status, body?.error ?? `HTTP ${res.status}`);
    return body;
  };
  const day = (d: string | undefined) => {
    if (d !== undefined && !DAY.test(d)) throw new RangeError(`a day is YYYY-MM-DD: ${d}`);
    return d;
  };
  const pairPath = (pair: string) => pair.toUpperCase().replace("/", "-");

  return {
    official: (date) => call<Official>("/official", { date: day(date) }),
    market: (date) => call<Market>("/market", { date: day(date) }),
    pairs: (date) => call<{ date: string; pairs: PairRate[] }>("/pairs", { date: day(date) }).then((r) => r.pairs),
    currencies: (lang) => call<{ currencies: Currency[] }>("/currencies", { lang }).then((r) => r.currencies),
    history: (pair, opts = {}) =>
      call<{ days: HistoryDay[] }>(`/pairs/${pairPath(pair)}/history`, { from: day(opts.from), to: day(opts.to), source: opts.source })
        .then((r) => r.days),
    convert: (opts) =>
      call<Conversion>("/convert", { amount: opts.amount, from: opts.from, to: opts.to, date: day(opts.date), source: opts.source, side: opts.side }),
    status: () => call<{ freshest: { official: string | null; market: string | null } }>("/status"),
  };
}

/** Pesos (or any `local`) per unit of each currency, from the market's table: the local column over the currency's. */
export function perLocal(market: Pick<Market, "perUsd">, local = "UYU"): Record<string, number> {
  const l = market.perUsd[local];
  if (!(l && l > 0)) return {};
  return Object.fromEntries(Object.entries(market.perUsd).filter(([, v]) => v > 0).map(([iso, v]) => [iso, l / v]));
}
