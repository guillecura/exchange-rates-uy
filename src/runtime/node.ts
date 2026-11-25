/**
 * On any server with Node 22.13 or newer, and a SQLite file:
 *
 *   import { serve } from "exchange-rates-uy/node";
 *   serve({ port: 8787, database: "./rates.db", adminToken: process.env.ADMIN_TOKEN });
 *
 * or with nothing to write: `npx exchange-rates-uy serve` (see `cli.ts`). With
 * Postgres instead of a file, pass `sql` (`exchange-rates-uy/postgres`).
 *
 * A timer calls `tick` every five minutes; the schedule decides what is read.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openSqlite } from "../stores/sqlite.ts";
import { createExchangeRates, type ExchangeRatesOptions } from "../server/index.ts";
import type { Sql } from "../server/sql.ts";

export interface ServeOptions extends Omit<ExchangeRatesOptions, "sql"> {
  port?: number;
  host?: string;
  /** A database of the caller's (Postgres, a SQLite it opened); else `database` is opened. */
  sql?: Sql;
  /** The SQLite file, when there is no `sql`: `rates.db` by default. */
  database?: string;
  /** How often the clock looks at the schedule, in minutes (5). */
  every?: number;
}

/** A Node request as a web `Request`. */
async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", base), { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks) });
}

async function send(res: ServerResponse, answer: Response): Promise<void> {
  res.statusCode = answer.status;
  answer.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await answer.arrayBuffer()));
}

export async function serve(o: ServeOptions = {}) {
  const opened = o.sql ? null : await openSqlite(o.database ?? "rates.db");
  const app = createExchangeRates({ ...o, sql: o.sql ?? opened! });
  const port = o.port ?? 8787;
  const host = o.host ?? "0.0.0.0";
  const server = createServer((req, res) => {
    toRequest(req, `http://${req.headers.host ?? "localhost"}`)
      .then((r) => app.fetch(r))
      .then((a) => send(res, a))
      .catch((e) => { console.error("exchange-rates-uy", e); res.statusCode = 500; res.end("error"); });
  });
  const clock = () => app.tick().then((slots) => slots.length && console.log("exchange-rates-uy read", slots.join(", "))).catch((e) => console.error("exchange-rates-uy tick", e));
  const timer = setInterval(clock, (o.every ?? 5) * 60_000);
  await new Promise<void>((done) => server.listen(port, host, done));
  console.log(`exchange-rates-uy on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  void clock();
  return {
    app,
    server,
    close() {
      clearInterval(timer);
      server.close();
      opened?.close();
    },
  };
}
