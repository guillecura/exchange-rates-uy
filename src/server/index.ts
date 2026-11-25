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
  /**
   * Told of every API request once it is answered: which endpoint, how it went, how long it took and who asked
   * (`Origin`, `Referer`, `User-Agent`, as sent). For usage counts, logs, metrics. Never waited on by the answer.
   */
  observe?: (event: ApiEvent) => void | Promise<void>;
}

/** One API request, as `observe` is told of it. */
export interface ApiEvent {
  at: number;
  /** The endpoint, without values: `pairs`, `pairs/history`, `convert`, `official`, `market`, `currencies`, `status`, `admin`, `tick`. */
  route: string;
  method: string;
  status: number;
  ms: number;
  origin: string | null;
  referer: string | null;
  userAgent: string | null;
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

  /** The endpoint a path is, without its values (`/api/pairs/USD-UYU/history` is `pairs/history`). */
  const route = (path: string) => {
    const rest = path.slice(base.length).replace(/^\/+|\/+$/g, "");
    return /^pairs\/[^/]+\/history$/.test(rest) ? "pairs/history" : rest.split("/")[0] || "index";
  };

  /**
   * `wait`, where the platform has one (a Worker's `ctx.waitUntil`), keeps `observe` running after the answer is sent.
   */
  async function fetch(req: Request, wait?: (p: Promise<unknown>) => void): Promise<Response> {
    const started = Date.now();
    await prepare();
    const url = new URL(req.url);
    const api = await handleApi(req, sql, { base, schedule, authorize, mayTick, tick: () => runTick(), maxAge: o.maxAge ?? 300 });
    if (api) {
      if (o.observe && req.method !== "OPTIONS") {
        const told = Promise.resolve()
          .then(() => o.observe!({
            at: started, route: route(url.pathname), method: req.method, status: api.status, ms: Date.now() - started,
            origin: req.headers.get("origin"), referer: req.headers.get("referer"), userAgent: req.headers.get("user-agent"),
          }))
          .catch((e) => console.error("exchange-rates-uy observe", e));
        wait?.(told);
      }
      return api;
    }
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
