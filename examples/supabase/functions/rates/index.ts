// A Supabase Edge Function: `supabase functions deploy rates --no-verify-jwt`.
// The tables go in your project's database with their prefix (rates_…), beside your own.
// The clock: pg_cron calls /rates/api/tick every 15 minutes (see ../README.md).
import postgres from "npm:postgres@3.4.5";
import { createExchangeRates } from "npm:exchange-rates-uy/server";
import { postgresJsSql } from "npm:exchange-rates-uy/postgres";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

const rates = createExchangeRates({
  sql: postgresJsSql(sql),
  apiBase: "/rates/api",
  publicPage: false,
  adminToken: Deno.env.get("RATES_ADMIN_TOKEN"),
  cronSecret: Deno.env.get("RATES_CRON_SECRET"),
});

Deno.serve((req) => rates.fetch(req));
