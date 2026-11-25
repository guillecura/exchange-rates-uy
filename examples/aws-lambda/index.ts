// AWS Lambda behind a Function URL (or an HTTP API), with Postgres (RDS, Aurora, Neon), and an EventBridge rule every
// 15 minutes invoking the same function: that event is the clock.
import pg from "pg";
import { lambdaHandler } from "exchange-rates-uy/lambda";
import { pgSql } from "exchange-rates-uy/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const handler = lambdaHandler({ sql: pgSql(pool), adminToken: process.env.ADMIN_TOKEN });
