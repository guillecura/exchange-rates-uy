#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 *   exchange-rates-uy serve [--port 8787] [--database rates.db]   the server
 *   exchange-rates-uy read [--database rates.db]                  both sources, now
 *   exchange-rates-uy backfill --from 2018-01-01 [--to …]         the BCU's history
 *
 * The environment configures the rest: ADMIN_TOKEN (the panel), CRON_SECRET,
 * RATES_CURRENCIES and RATES_PAIRS (a new database's first ones), RATES_TIMEZONE,
 * RATES_OFFICIAL_HOURS, RATES_MARKET_HOURS, RATES_TITLE, RATES_LANG.
 */
import { parseArgs } from "node:util";
import { serve } from "./runtime/node.ts";
import { createExchangeRates, DEFAULT_SCHEDULE, type ExchangeRatesOptions } from "./server/index.ts";
import { openSqlite } from "./stores/sqlite.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" }, host: { type: "string" }, database: { type: "string" },
    from: { type: "string" }, to: { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
const command = positionals[0] ?? "serve";
const env = process.env;
const database = values.database ?? env.RATES_DATABASE ?? "rates.db";
const list = (v: string | undefined) => v?.split(",").map((x) => x.trim()).filter(Boolean);
const hours = (v: string | undefined) => list(v)?.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h < 24);

/** The options the environment sets, for every command. */
const options: Omit<ExchangeRatesOptions, "sql"> = {
  adminToken: env.ADMIN_TOKEN,
  cronSecret: env.CRON_SECRET,
  ...(list(env.RATES_CURRENCIES) || list(env.RATES_PAIRS)
    ? { seed: { currencies: list(env.RATES_CURRENCIES) ?? [], pairs: list(env.RATES_PAIRS) ?? [] } }
    : {}),
  schedule: {
    timeZone: env.RATES_TIMEZONE ?? DEFAULT_SCHEDULE.timeZone,
    official: { ...DEFAULT_SCHEDULE.official, ...(hours(env.RATES_OFFICIAL_HOURS) ? { hours: hours(env.RATES_OFFICIAL_HOURS)! } : {}) },
    market: { ...DEFAULT_SCHEDULE.market, ...(hours(env.RATES_MARKET_HOURS) ? { hours: hours(env.RATES_MARKET_HOURS)! } : {}) },
  },
  page: { ...(env.RATES_TITLE ? { title: env.RATES_TITLE } : {}), ...(env.RATES_LANG === "es" || env.RATES_LANG === "en" ? { lang: env.RATES_LANG } : {}) },
};

if (values.help || !["serve", "read", "backfill"].includes(command)) {
  console.log(`exchange-rates-uy serve [--port 8787] [--host 0.0.0.0] [--database rates.db]
exchange-rates-uy read [--database rates.db]
exchange-rates-uy backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--database rates.db]

Environment: ADMIN_TOKEN, CRON_SECRET, RATES_CURRENCIES=USD,UYU,EUR RATES_PAIRS=USD/UYU,EUR/UYU
RATES_TIMEZONE=America/Montevideo RATES_OFFICIAL_HOURS=10,14,18 RATES_MARKET_HOURS=10,18 RATES_TITLE RATES_LANG=es|en`);
  process.exit(values.help ? 0 : 1);
}

if (command === "serve") {
  await serve({ ...options, port: Number(values.port ?? env.PORT ?? 8787), host: values.host, database });
} else {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (command === "backfill" && (!day.test(values.from ?? "") || (values.to && !day.test(values.to)))) {
    console.error("backfill needs --from YYYY-MM-DD (and --to YYYY-MM-DD, today by default)");
    process.exit(1);
  }
  const sql = await openSqlite(database);
  const app = createExchangeRates({ ...options, sql });
  const out = command === "read"
    ? await app.read()
    : await app.backfill(values.from!, values.to ?? new Date().toISOString().slice(0, 10));
  console.log(JSON.stringify(out, null, 2));
  sql.close();
}
