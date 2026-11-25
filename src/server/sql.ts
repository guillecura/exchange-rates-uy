/**
 * What a database has to give the server: run a statement, read rows, and run
 * several at once. That is all, so any database a backend has will do:
 *
 *   SQLite      `sqliteSql(db)` over node:sqlite, better-sqlite3 or bun:sqlite
 *               (`exchange-rates-uy/sqlite`), a file on a server or a laptop.
 *   D1          `d1Sql(env.DB)`, Cloudflare's (`exchange-rates-uy/d1`).
 *   Postgres    `pgSql(client)` over node-postgres, Neon, Vercel Postgres, Supabase,
 *               RDS, PGlite (`exchange-rates-uy/postgres`), or `postgresJsSql(sql)`
 *               over postgres.js, which is what Supabase's Edge Functions use.
 *
 * Queries are written once, with `?` for each value and `{name}` for each table:
 * the store turns `?` into `$1, $2…` on Postgres, and the server turns `{name}`
 * into the table's name with its prefix (`rates_` unless told otherwise), so the
 * tables sit beside an app's own without a clash.
 */
export interface Sql {
  readonly dialect: "sqlite" | "postgres";
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Several statements, all or none. */
  batch(statements: readonly (readonly [string, readonly unknown[]])[]): Promise<void>;
}

/** The same database with `{name}` written as the prefixed table's name in every statement. */
export function withTables(sql: Sql, prefix: string): Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(prefix)) throw new Error(`a table prefix is letters, digits and underscores: ${prefix}`);
  const name = (s: string) => s.replace(/\{([a-z_]+)\}/g, (_, t: string) => `${prefix}${t}`);
  return {
    dialect: sql.dialect,
    all: (s, p) => sql.all(name(s), p),
    run: (s, p) => sql.run(name(s), p),
    batch: (list) => sql.batch(list.map(([s, p]) => [name(s), p] as const)),
  };
}

/**
 * The schema, as a list that only grows: each entry runs once, in order, and the
 * count of those that ran is kept in `{meta}`. A change to a table is a new entry,
 * never an edit to one that shipped. Written in the SQL both dialects read
 * (`double precision`, integers for flags, days as `YYYY-MM-DD` text).
 *
 * What is kept is what the sources said and nothing derived from it: the bank's
 * reading of each currency per day (`{official}`) and the market's table per day
 * (`{market}`). A pair is arithmetic on those, done when it is asked for, so a pair
 * added today has its whole history at once and turning one around is swapping its
 * two sides.
 */
export const MIGRATIONS: readonly string[] = [
  `create table if not exists {currency} (
    iso text primary key,
    symbol text not null default '',
    active integer not null default 1,
    sort integer not null default 0
  )`,
  `create table if not exists {pair} (
    pair text primary key,
    base text not null,
    quote text not null,
    active integer not null default 1,
    sort integer not null default 0,
    favourite integer not null default 0
  )`,
  `create table if not exists {official} (
    day text not null,
    iso text not null,
    buy double precision not null,
    sell double precision not null,
    usd double precision,
    fetched_at bigint not null,
    primary key (day, iso)
  )`,
  `create table if not exists {market} (
    day text not null,
    iso text not null,
    per_usd double precision not null,
    fetched_at bigint not null,
    primary key (day, iso)
  )`,
  `create table if not exists {slot} (
    day text not null,
    slot text not null,
    primary key (day, slot)
  )`,
  `create table if not exists {log} (
    at bigint not null,
    job text not null,
    ok integer not null,
    detail text
  )`,
  `create index if not exists {log}_at on {log} (at)`,
  // Whose table a market day is: 'live' (ExchangeRate-API, read on its day) or 'past' (a day gone by, filled in).
  `alter table {market} add column source text not null default 'live'`,
  // Until 1.6.1 a currency's arbitrage was kept as the bank sent it, which is units per dollar for all but these:
  // kept from now on as dollars per unit, as `usd` always said.
  `update {official} set usd = 1.0 / usd
    where usd is not null and usd > 0 and iso not in ('USD', 'EUR', 'GBP', 'AUD', 'NZD', 'XDR', 'UP', 'UI')`,
];

/** Brings a database up to the last entry of `MIGRATIONS`. Safe to call on every start. */
export async function migrate(sql: Sql): Promise<void> {
  await sql.run(`create table if not exists {meta} (key text primary key, value text not null)`);
  const [row] = await sql.all<{ value: string }>(`select value from {meta} where key = 'schema'`);
  const done = row ? Number(row.value) : 0;
  for (let i = done; i < MIGRATIONS.length; i += 1) {
    await sql.batch([
      [MIGRATIONS[i]!, []],
      [`insert into {meta} (key, value) values ('schema', ?) on conflict (key) do update set value = excluded.value`, [String(i + 1)]],
    ]);
  }
}
