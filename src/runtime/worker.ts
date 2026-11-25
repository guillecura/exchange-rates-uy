/**
 * On Cloudflare Workers, with D1:
 *
 *   // src/index.ts
 *   import { exchangeRatesWorker } from "exchange-rates-uy/worker";
 *   export default exchangeRatesWorker();
 *
 *   # wrangler.toml
 *   [[d1_databases]]   binding = "DB", database_name = "rates", database_id = "…"
 *   [triggers]         crons = ["*\/15 * * * *"]
 *   # npx wrangler secret put ADMIN_TOKEN   (the panel)
 *
 * The Cron Trigger only wakes it: what is read and when is the schedule's, so the
 * trigger can be every 15 minutes whatever the hours are.
 */
import { d1Sql, type D1Like } from "../stores/d1.ts";
import { createExchangeRates, type ExchangeRatesOptions } from "../server/index.ts";

export interface ExchangeRatesEnv {
  DB: D1Like;
  ADMIN_TOKEN?: string;
}

type Options = Omit<ExchangeRatesOptions, "sql" | "adminToken">;

export function exchangeRatesWorker<E extends ExchangeRatesEnv>(options: Options | ((env: E) => Options) = {}) {
  let made: { env: E; app: ReturnType<typeof createExchangeRates> } | null = null;
  const app = (env: E) => {
    if (made?.env !== env) {
      const o = typeof options === "function" ? options(env) : options;
      made = { env, app: createExchangeRates({ ...o, sql: d1Sql(env.DB), adminToken: env.ADMIN_TOKEN }) };
    }
    return made.app;
  };
  return {
    fetch(req: Request, env: E): Promise<Response> {
      return app(env).fetch(req);
    },
    scheduled(event: { scheduledTime: number }, env: E, ctx: { waitUntil(p: Promise<unknown>): void }): void {
      ctx.waitUntil(app(env).tick(new Date(event.scheduledTime)));
    },
  };
}
