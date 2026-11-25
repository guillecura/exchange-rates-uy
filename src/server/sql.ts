/**
 * The one thing a store has to give the server: run a statement, read rows, and
 * run several at once. SQLite's dialect, which is what both Cloudflare's D1
 * (`cambista/worker`) and Node's built-in `node:sqlite` (`cambista/node`) speak,
 * so every query is written once.
 */
export interface Sql {
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Several statements, all or none. */
  batch(statements: readonly (readonly [string, readonly unknown[]])[]): Promise<void>;
}

/**
 * The schema, as a list that only grows: each entry runs once, in order, and the
 * count of those that ran is kept in `cambista_meta`. A change to a table is a new
 * entry, never an edit to one that shipped.
 *
 * What is kept is what the sources said and nothing derived from it: the bank's
 * reading of each currency per day (`official`) and the market's table per day
 * (`market`). A pair is arithmetic on those, done when it is asked for, so a pair
 * added today has its whole history at once and turning one around is swapping
 * its two sides.
 */
export const MIGRATIONS: readonly string[] = [
  `create table if not exists currency (
    iso text primary key,
    symbol text not null default '',
    active integer not null default 1,
    sort integer not null default 0
  )`,
  `create table if not exists pair (
    pair text primary key,
    base text not null,
    quote text not null,
    active integer not null default 1,
    sort integer not null default 0,
    favourite integer not null default 0
  )`,
  `create table if not exists official (
    day text not null,
    iso text not null,
    buy real not null,
    sell real not null,
    usd real,
    fetched_at integer not null,
    primary key (day, iso)
  )`,
  `create table if not exists market (
    day text not null,
    iso text not null,
    per_usd real not null,
    fetched_at integer not null,
    primary key (day, iso)
  )`,
  `create table if not exists slot (
    day text not null,
    slot text not null,
    primary key (day, slot)
  )`,
  `create table if not exists run (
    id integer primary key autoincrement,
    at integer not null,
    job text not null,
    ok integer not null,
    detail text
  )`,
  `create index if not exists run_at on run (at)`,
];

/** Brings a database up to the last entry of `MIGRATIONS`. Safe to call on every start. */
export async function migrate(sql: Sql): Promise<void> {
  await sql.run(`create table if not exists cambista_meta (key text primary key, value text not null)`);
  const [row] = await sql.all<{ value: string }>(`select value from cambista_meta where key = 'schema'`);
  const done = row ? Number(row.value) : 0;
  for (let i = done; i < MIGRATIONS.length; i += 1) {
    await sql.batch([
      [MIGRATIONS[i]!, []],
      [`insert into cambista_meta (key, value) values ('schema', ?) on conflict (key) do update set value = excluded.value`, [String(i + 1)]],
    ]);
  }
}
