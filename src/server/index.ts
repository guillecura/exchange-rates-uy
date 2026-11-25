/**
 * The server: the readings kept in a database, the API, the public page and the
 * panel, as one `fetch(request)` and one `tick(now)`. Nothing here knows where it
 * runs, so it runs wherever a backend is:
 *
 *   const rates = createExchangeRates({ sql, adminToken: "…" });
 *   await rates.fetch(request);   // the API, the page, the panel
 *   await rates.tick(new Date()); // every few minutes, or from a cron: reads what is due
 *
 * Ready-made: `exchange-rates-uy/worker` (Cloudflare), `exchange-rates-uy/node`
 * (any server), `exchange-rates-uy/lambda` (AWS). Anything else that speaks
 * `Request`/`Response` (Vercel, Netlify, Deno, Bun, Supabase's Edge Functions)
 * holds `fetch` as it is; the README has each one.
 */
import { handleApi } from "./api.ts";
import { DEFAULT_SCHEDULE, backfill, readMarket, readOfficial, tick, localTime, type Schedule } from "./read.ts";
import { migrate, withTables, type Sql } from "./sql.ts";
import { seed } from "./store.ts";
import { adminPage, pickLang, publicPage, type PageOptions } from "./ui.ts";

export type { Sql } from "./sql.ts";
export type { Schedule } from "./read.ts";
export type { PageOptions } from "./ui.ts";
export { DEFAULT_SCHEDULE } from "./read.ts";
export { MIGRATIONS, migrate, withTables } from "./sql.ts";

export interface ExchangeRatesOptions {
  /** The database (`exchange-rates-uy/sqlite`, `/d1`, `/postgres`). */
  sql: Sql;
  /** The tables' prefix, so they sit beside an app's own: `rates_` by default (`rates_official`, `rates_pair`…). */
  tablePrefix?: string;
  /** Where the API answers: `/api` by default. */
  apiBase?: string;
  /**
   * The admin API's bearer token. Without it (and without `authorize`) the panel
   * and the admin API are off, which is the safe default for a public server.
   */
  adminToken?: string;
  /** Instead of a token: any check on the request (a session cookie, an access proxy's header). */
  authorize?: (req: Request) => boolean | Promise<boolean>;
  /**
   * The bearer a scheduler sends to `{apiBase}/tick` (Vercel Cron sends its
   * `CRON_SECRET` this way). The admin token works there too.
   */
  cronSecret?: string;
  /** When each source is read: which hours, which weekdays, in which time zone. */
  schedule?: Schedule;
  /** What a new, empty database starts with; the panel and the admin API change it after. */
  seed?: { currencies: readonly string[]; pairs: readonly string[] };
  /** The pages' title, tagline, footer and language. */
  page?: Partial<PageOptions>;
  /** The public page at `/` (default on); off leaves the API only. */
  publicPage?: boolean;
  /** How long a public API answer may be cached, in seconds (300). */
  maxAge?: number;
}

export const DEFAULT_SEED = {
  currencies: ["USD", "UYU", "EUR", "ARS", "BRL"],
  pairs: ["USD/UYU", "EUR/UYU", "EUR/USD", "USD/ARS", "USD/BRL"],
} as const;

/** Compares two strings in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

export function createExchangeRates(o: ExchangeRatesOptions) {
  const sql = withTables(o.sql, o.tablePrefix ?? "rates_");
  const schedule = o.schedule ?? DEFAULT_SCHEDULE;
  const base = (o.apiBase ?? "/api").replace(/\/+$/, "");
  const page: PageOptions = { title: "Exchange rates", tagline: "The official rate and the market's.", ...o.page };
  let ready: Promise<void> | null = null;
  const prepare = () => (ready ??= migrate(sql).then(() => seed(sql, o.seed ?? DEFAULT_SEED)).catch((e) => {
    ready = null;
    throw e;
  }));
  const isAdmin = (req: Request) => !!o.adminToken && !!bearer(req) && same(bearer(req), o.adminToken);
  const authorize = o.authorize ?? isAdmin;
  const mayTick = async (req: Request) => (!!o.cronSecret && !!bearer(req) && same(bearer(req), o.cronSecret)) || isAdmin(req) || (!!o.authorize && (await o.authorize(req)));
  const adminOn = Boolean(o.adminToken || o.authorize);
  const runTick = (now = new Date()) => prepare().then(() => tick(sql, now, schedule));

  async function fetch(req: Request): Promise<Response> {
    await prepare();
    const url = new URL(req.url);
    const api = await handleApi(req, sql, { base, schedule, authorize, mayTick, tick: () => runTick(), maxAge: o.maxAge ?? 300 });
    if (api) return api;
    const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/" && o.publicPage !== false) return html(publicPage(pickLang(req, page.lang), page, base));
    if (url.pathname === "/admin" && adminOn) return html(adminPage(pickLang(req, page.lang), page, base));
    return new Response("Not found", { status: 404 });
  }

  return {
    fetch,
    /** Reads whatever is due at `now`; answers the slots it read. */
    tick: runTick,
    /** Both sources, now, whatever the clock says. */
    async read() {
      await prepare();
      const today = localTime(new Date(), schedule.timeZone).day;
      return { official: await readOfficial(sql, today), market: await readMarket(sql) };
    },
    /** The bank's history between two days (see `backfill`). */
    async backfill(from: string, to: string, budget = Infinity) {
      await prepare();
      return backfill(sql, from, to, budget);
    },
  };
}

export type ExchangeRates = ReturnType<typeof createExchangeRates>;
