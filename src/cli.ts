#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 *   cambista serve [--port 8787] [--database ./cambista.db]   the server (ADMIN_TOKEN from the environment)
 *   cambista read [--database ./cambista.db]                  both sources, now
 *   cambista backfill --from 2018-01-01 [--to …] [--database …] the BCU's history
 */
import { parseArgs } from "node:util";
import { serve } from "./runtime/node.ts";
import { createCambista } from "./server/index.ts";
import { sqliteSql } from "./stores/sqlite.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" }, host: { type: "string" }, database: { type: "string" },
    from: { type: "string" }, to: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const command = positionals[0] ?? "serve";
const database = values.database ?? process.env.CAMBISTA_DATABASE ?? "cambista.db";

if (values.help || !["serve", "read", "backfill"].includes(command)) {
  console.log(`cambista serve [--port 8787] [--host 0.0.0.0] [--database cambista.db]
cambista read [--database cambista.db]
cambista backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--database cambista.db]

ADMIN_TOKEN in the environment turns the panel (/admin) and the admin API on.`);
  process.exit(values.help ? 0 : 1);
}

if (command === "serve") {
  serve({ port: Number(values.port ?? process.env.PORT ?? 8787), host: values.host, database, adminToken: process.env.ADMIN_TOKEN });
} else {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (command === "backfill" && (!day.test(values.from ?? "") || (values.to && !day.test(values.to)))) {
    console.error("backfill needs --from YYYY-MM-DD (and --to YYYY-MM-DD, today by default)");
    process.exit(1);
  }
  const sql = sqliteSql(database);
  const app = createCambista({ sql });
  const out = command === "read"
    ? await app.read()
    : await app.backfill(values.from ?? "", values.to ?? new Date().toISOString().slice(0, 10));
  console.log(JSON.stringify(out, null, 2));
  sql.close();
}
