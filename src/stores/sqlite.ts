import type { Sql } from "../server/sql.ts";

/**
 * The shape the three synchronous SQLite drivers share: Node's own `node:sqlite`
 * (`DatabaseSync`), `better-sqlite3` and Bun's `bun:sqlite`. Whichever the backend
 * has, it is passed in as it is.
 */
export interface SqliteLike {
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes: number | bigint };
  };
  exec(sql: string): unknown;
}

/** A store on a SQLite database the caller opened. */
export function sqliteSql(db: SqliteLike): Sql {
  const values = (params: readonly unknown[]) => params.map((v) => (typeof v === "boolean" ? Number(v) : v)) as never[];
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return db.prepare(sql).all(...values(params)) as T[];
    },
    async run(sql, params = []) {
      return { changes: Number(db.prepare(sql).run(...values(params)).changes) };
    },
    async batch(statements) {
      db.exec("begin");
      try {
        for (const [sql, params] of statements) db.prepare(sql).run(...values(params));
        db.exec("commit");
      } catch (e) {
        db.exec("rollback");
        throw e;
      }
    },
  };
}

/**
 * A SQLite file opened with Node's own driver (Node 22.13 and up): nothing to
 * install. `":memory:"` keeps it in memory, which is what the tests use.
 */
export async function openSqlite(path: string): Promise<Sql & { close(): void }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
  return { ...sqliteSql(db as unknown as SqliteLike), close: () => db.close() };
}
