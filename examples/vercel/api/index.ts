// A Vercel Function with Postgres (Neon from the Marketplace sets DATABASE_URL). vercel.json routes everything here
// and its cron calls /api/tick; Vercel sends `Authorization: Bearer $CRON_SECRET`, which is the cron secret here.
import { Pool } from "@neondatabase/serverless";
import { createExchangeRates } from "exchange-rates-uy/server";
import { pgSql } from "exchange-rates-uy/postgres";

const rates = createExchangeRates({
  sql: pgSql(new Pool({ connectionString: process.env.DATABASE_URL })),
  adminToken: process.env.ADMIN_TOKEN,
  cronSecret: process.env.CRON_SECRET,
});

export default { fetch: (req: Request) => rates.fetch(req) };
