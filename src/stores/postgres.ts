import type { Sql } from "../server/sql.ts";

/**
 * A Postgres client as node-postgres has it (`Pool` or `Client`), which is also
 * Neon's serverless driver, `@vercel/postgres`, and PGlite: `query(text, values)`
 * answering the rows and how many it touched.
 */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>;
}

/** postgres.js (`import postgres from "postgres"`), which Supabase's Edge Functions use. */
export interface PostgresJsLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown[] & { count?: number }>;
  begin<T>(fn: (tx: PostgresJsLike) => Promise<T>): Promise<T>;
}

/** `?, ?, ?` as Postgres writes them, `$1, $2, $3`. Queries here have no `?` inside a string. */
export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

/** Postgres answers a count or a bigint as text; the server reads numbers. */
function rows<T>(list: unknown[]): T[] {
  return list.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) =>
    [k, typeof v === "string" && (k === "n" || k === "at" || k === "fetched_at" || k === "sort") && /^-?\d+$/.test(v) ? Number(v) : v]))) as T[];
}

/** A store on Postgres through a node-postgres–style client. */
export function pgSql(client: PgLike): Sql {
  return {
    dialect: "postgres",
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return rows<T>((await client.query(numbered(sql), [...params])).rows);
    },
    async run(sql, params = []) {
      const r = await client.query(numbered(sql), [...params]);
      return { changes: Number(r.rowCount ?? r.affectedRows ?? 0) };
    },
    async batch(statements) {
      if (!statements.length) return;
      await client.query("begin");
      try {
        for (const [sql, params] of statements) await client.query(numbered(sql), [...params]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    },
  };
}

/** A store on Postgres through postgres.js. */
export function postgresJsSql(sql: PostgresJsLike): Sql {
  return {
    dialect: "postgres",
    async all<T>(text: string, params: readonly unknown[] = []) {
      return rows<T>(await sql.unsafe(numbered(text), [...params]));
    },
    async run(text, params = []) {
      const r = await sql.unsafe(numbered(text), [...params]);
      return { changes: Number(r.count ?? 0) };
    },
    async batch(statements) {
      await sql.begin(async (tx) => {
        for (const [text, params] of statements) await tx.unsafe(numbered(text), [...params]);
      });
    },
  };
}
