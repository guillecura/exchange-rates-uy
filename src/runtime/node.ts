/**
 * cambista on any server, with Node 22.13 or newer and a SQLite file:
 *
 *   import { serve } from "cambista/node";
 *   serve({ port: 8787, database: "./cambista.db", adminToken: process.env.ADMIN_TOKEN });
 *
 * or with nothing to write: `npx cambista serve` (see `cli.ts`).
 *
 * A timer calls `tick` every five minutes; the schedule decides what is read.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sqliteSql } from "../stores/sqlite.ts";
import { createCambista, type CambistaOptions } from "../server/index.ts";

export interface ServeOptions extends Omit<CambistaOptions, "sql"> {
  port?: number;
  host?: string;
  /** The SQLite file. */
  database?: string;
  /** How often the clock looks at the schedule, in minutes. */
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

export function serve(o: ServeOptions = {}) {
  const sql = sqliteSql(o.database ?? "cambista.db");
  const app = createCambista({ ...o, sql });
  const port = o.port ?? 8787;
  const host = o.host ?? "0.0.0.0";
  const server = createServer((req, res) => {
    toRequest(req, `http://${req.headers.host ?? "localhost"}`)
      .then((r) => app.fetch(r))
      .then((a) => send(res, a))
      .catch((e) => { console.error("cambista", e); res.statusCode = 500; res.end("error"); });
  });
  const clock = () => app.tick().then((slots) => slots.length && console.log("cambista read", slots.join(", "))).catch((e) => console.error("cambista tick", e));
  const timer = setInterval(clock, (o.every ?? 5) * 60_000);
  server.listen(port, host, () => {
    console.log(`cambista on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    void clock();
  });
  return {
    app,
    server,
    close() {
      clearInterval(timer);
      server.close();
      sql.close();
    },
  };
}
