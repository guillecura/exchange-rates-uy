/**
 * A cambista server: the readings kept in a database, the API, the public page
 * and the panel, as one `fetch` handler and one `tick`. Nothing here knows where
 * it runs: `cambista/worker` puts it on Cloudflare (D1 and a Cron Trigger),
 * `cambista/node` on any server (a SQLite file and a timer), and anything else
 * that speaks `Request`/`Response` can hold it the same way.
 *
 *   const cambista = createCambista({ sql, adminToken: "…" });
 *   await cambista.fetch(request);   // the API and the pages
 *   await cambista.tick(new Date()); // every few minutes: reads what is due
 */
import { handleApi } from "./api.ts";
import { DEFAULT_SCHEDULE, backfill, readMarket, readOfficial, tick, localTime, type Schedule } from "./read.ts";
import { migrate, type Sql } from "./sql.ts";
import { seed } from "./store.ts";
import { adminPage, pickLang, publicPage, type PageOptions } from "./ui.ts";

export type { Sql } from "./sql.ts";
export type { Schedule } from "./read.ts";
export type { PageOptions } from "./ui.ts";
export { DEFAULT_SCHEDULE } from "./read.ts";

export interface CambistaOptions {
  sql: Sql;
  /**
   * The admin API's bearer token. Without it (and without `authorize`) the panel
   * and the admin API are off, which is the safe default for a public server.
   */
  adminToken?: string;
  /** Instead of a token: any check on the request (a session cookie, an IP, an access header). */
  authorize?: (req: Request) => boolean | Promise<boolean>;
  /** When each source is read. Montevideo's working days for the BCU by default. */
  schedule?: Schedule;
  /** What a new, empty database starts with. */
  seed?: { currencies: readonly string[]; pairs: readonly string[] };
  /** The pages' title, tagline and footer. */
  page?: Partial<PageOptions>;
  /** Turn the public page off (the API stays). */
  publicPage?: boolean;
  /** How long a public API answer may be cached, in seconds. */
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

export function createCambista(o: CambistaOptions) {
  const schedule = o.schedule ?? DEFAULT_SCHEDULE;
  const page: PageOptions = { title: "cambista", tagline: "Exchange rates: the official one and the market's.", ...o.page };
  let ready: Promise<void> | null = null;
  const prepare = () => (ready ??= migrate(o.sql).then(() => seed(o.sql, o.seed ?? DEFAULT_SEED)).catch((e) => {
    ready = null;
    throw e;
  }));
  const authorize = o.authorize ?? ((req: Request) => {
    const token = o.adminToken;
    const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return !!token && !!given && same(given, token);
  });
  const adminOn = Boolean(o.adminToken || o.authorize);

  async function fetch(req: Request): Promise<Response> {
    await prepare();
    const url = new URL(req.url);
    const api = await handleApi(req, o.sql, { schedule, authorize, maxAge: o.maxAge ?? 300 });
    if (api) return api;
    const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/" && o.publicPage !== false) return html(publicPage(pickLang(req, page.lang), page));
    if (url.pathname === "/admin" && adminOn) return html(adminPage(pickLang(req, page.lang), page));
    return new Response("Not found", { status: 404 });
  }

  return {
    fetch,
    /** Reads whatever is due at `now`; returns the slots it read. */
    async tick(now = new Date()) {
      await prepare();
      return tick(o.sql, now, schedule);
    },
    /** Both sources, now, whatever the clock says. */
    async read() {
      await prepare();
      const today = localTime(new Date(), schedule.timeZone).day;
      return { official: await readOfficial(o.sql, today), market: await readMarket(o.sql) };
    },
    /** The bank's history between two days (see `backfill`). */
    async backfill(from: string, to: string, budget = Infinity) {
      await prepare();
      return backfill(o.sql, from, to, budget);
    },
  };
}

export type Cambista = ReturnType<typeof createCambista>;
