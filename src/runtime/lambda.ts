/**
 * On AWS Lambda, behind a Function URL or an API Gateway HTTP API, with a
 * Postgres (RDS, Aurora, Neon…), and an EventBridge schedule to wake the clock:
 *
 *   import pg from "pg";
 *   import { lambdaHandler } from "exchange-rates-uy/lambda";
 *   import { pgSql } from "exchange-rates-uy/postgres";
 *
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *   export const handler = lambdaHandler({ sql: pgSql(pool), adminToken: process.env.ADMIN_TOKEN });
 *
 * An event with `source: "aws.events"` (a scheduled rule, every 15 minutes) is a
 * tick; anything else is an HTTP request.
 */
import { createExchangeRates, type ExchangeRatesOptions } from "../server/index.ts";

/** The parts of a Function URL / HTTP API (payload 2.0) event the handler reads. */
export interface HttpEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string }; domainName?: string };
}

export interface ScheduledEvent {
  source: "aws.events";
  time?: string;
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export function lambdaHandler(options: ExchangeRatesOptions) {
  const app = createExchangeRates(options);
  return async (event: HttpEvent | ScheduledEvent): Promise<HttpResult | { read: string[] }> => {
    if ("source" in event && event.source === "aws.events") return { read: await app.tick(event.time ? new Date(event.time) : new Date()) };
    const e = event as HttpEvent;
    const method = e.requestContext?.http?.method ?? "GET";
    const url = `https://${e.requestContext?.domainName ?? "localhost"}${e.rawPath ?? "/"}${e.rawQueryString ? `?${e.rawQueryString}` : ""}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(e.headers ?? {})) if (v !== undefined) headers.set(k, v);
    const body = e.body ? (e.isBase64Encoded ? Buffer.from(e.body, "base64") : e.body) : undefined;
    const answer = await app.fetch(new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body }));
    const out: Record<string, string> = {};
    answer.headers.forEach((v, k) => { out[k] = v; });
    return { statusCode: answer.status, headers: out, body: await answer.text(), isBase64Encoded: false };
  };
}
