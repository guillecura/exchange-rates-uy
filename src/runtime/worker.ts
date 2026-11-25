/**
 * cambista on Cloudflare Workers, with D1:
 *
 *   // src/index.ts
 *   import { cambistaWorker } from "cambista/worker";
 *   export default cambistaWorker();
 *
 *   # wrangler.toml
 *   [[d1_databases]]   binding = "DB", database_name = "cambista", database_id = "…"
 *   [triggers]         crons = ["*\/15 * * * *"]
 *   # secret ADMIN_TOKEN: npx wrangler secret put ADMIN_TOKEN
 *
 * The Cron Trigger only wakes it: what is read and when is the schedule's
 * (`tick`), so the trigger can be every 15 minutes whatever the slots are.
 */
import { d1Sql, type D1Like } from "../stores/d1.ts";
import { createCambista, type CambistaOptions } from "../server/index.ts";

export interface CambistaEnv {
  DB: D1Like;
  ADMIN_TOKEN?: string;
}

type Options = Omit<CambistaOptions, "sql" | "adminToken">;

export function cambistaWorker<E extends CambistaEnv>(options: Options | ((env: E) => Options) = {}) {
  let made: { env: E; app: ReturnType<typeof createCambista> } | null = null;
  const app = (env: E) => {
    if (made?.env !== env) {
      const o = typeof options === "function" ? options(env) : options;
      made = { env, app: createCambista({ ...o, sql: d1Sql(env.DB), adminToken: env.ADMIN_TOKEN }) };
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
