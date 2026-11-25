import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Sql } from "../server/sql.ts";

/**
 * A store on a SQLite file, through Node's own `node:sqlite` (Node 22.13 and up):
 * nothing to install and nothing to compile. `":memory:"` keeps it in memory,
 * which is what the tests use.
 */
export function sqliteSql(path: string): Sql & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
  const values = (params: readonly unknown[]) => params.map((v) => (typeof v === "boolean" ? Number(v) : v)) as SQLInputValue[];
  return {
    async all<T>(sql: string, params: readonly unknown[] = []) {
      return db.prepare(sql).all(...values(params)) as T[];
    },
    async run(sql, params = []) {
      const { changes } = db.prepare(sql).run(...values(params));
      return { changes: Number(changes) };
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
    close() {
      db.close();
    },
  };
}
