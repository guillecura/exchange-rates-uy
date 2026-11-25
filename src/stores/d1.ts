import type { Sql } from "../server/sql.ts";

/** The parts of Cloudflare's D1 binding the store uses, so this needs no types package. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes?: number } }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

/** A store on a D1 database (the binding from `wrangler.toml`). */
export function d1Sql(db: D1Like): Sql {
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return (await db.prepare(sql).bind(...params).all<T>()).results;
    },
    async run(sql, params = []) {
      const { meta } = await db.prepare(sql).bind(...params).run();
      return { changes: meta.changes ?? 0 };
    },
    async batch(statements) {
      if (statements.length) await db.batch(statements.map(([sql, params]) => db.prepare(sql).bind(...params)));
    },
  };
}
