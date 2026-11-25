// The same server on Postgres (any: local, RDS, Neon, Supabase's connection string).
import pg from "pg";
import { serve } from "exchange-rates-uy/node";
import { pgSql } from "exchange-rates-uy/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await serve({ sql: pgSql(pool), adminToken: process.env.ADMIN_TOKEN });
