import { bcuBetween, bcuCode } from "../rates/bcu.ts";
import { marketTable } from "../rates/market.ts";
import type { CurrencySpec } from "../rates/types.ts";
import type { Sql } from "./sql.ts";
import { claim, currencies, keepMarket, keepOfficial, log } from "./store.ts";

/**
 * The readings, and the clock that decides when they happen.
 *
 * The clock is a function of the time and nothing else (`tick`), called every few
 * minutes by whatever runs the server: a Cron Trigger on Cloudflare, a timer on
 * Node. It never sleeps and never keeps state in memory: each slot of a day is
 * claimed in the database before it is read (`claim`), so a restart, two
 * instances or a late trigger never read the same slot twice, and a slot missed
 * while the server was down is read on the next tick of that day.
 */

/** When each source is read, in the hours of one time zone. */
export interface Schedule {
  /** The time zone the hours are in. The BCU's day is Montevideo's. */
  timeZone: string;
  /** The bank's slots: it publishes once a working day, so only weekdays by default. */
  official: { hours: readonly number[]; weekdays: readonly number[] };
  /** The market's: its table is rebuilt once a day, so twice is plenty. */
  market: { hours: readonly number[]; weekdays: readonly number[] };
}

export const DEFAULT_SCHEDULE: Schedule = {
  timeZone: "America/Montevideo",
  official: { hours: [10, 14, 18], weekdays: [1, 2, 3, 4, 5] },
  market: { hours: [10, 18], weekdays: [0, 1, 2, 3, 4, 5, 6] },
};

/** The day, hour and weekday (0 is Sunday) it is in a time zone. */
export function localTime(now: Date, timeZone: string): { day: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The kept currencies the bank quotes, with its number for each. */
async function quoted(sql: Sql): Promise<CurrencySpec[]> {
  return (await currencies(sql)).map((c) => ({ iso: c.iso, bcu: bcuCode(c.iso) })).filter((c) => c.bcu > 0);
}

/**
 * The bank's last ten days, for every kept currency it quotes. Ten and not one
 * because a reading that failed on Thursday is filled in on Friday: the days the
 * bank published that are not kept yet are kept now, and the ones that are, again.
 */
export async function readOfficial(sql: Sql, today: string): Promise<{ days: number; rows: number } | { error: string }> {
  try {
    const wanted = await quoted(sql);
    if (!wanted.length) return { days: 0, rows: 0 };
    const readings = await bcuBetween(shift(today, -10), today, wanted);
    if (!readings.length) throw new Error("the BCU answered nothing for the last ten days");
    const rows = await keepOfficial(sql, readings);
    const out = { days: readings.length, rows };
    await log(sql, "official", true, out);
    return out;
  } catch (e) {
    const out = { error: e instanceof Error ? e.message : String(e) };
    await log(sql, "official", false, out);
    return out;
  }
}

/** The market's whole table: every currency it has, not only the kept ones, so any of them converts. */
export async function readMarket(sql: Sql): Promise<{ day: string; rows: number } | { error: string }> {
  try {
    const table = await marketTable();
    if (!table) throw new Error("ExchangeRate-API answered no table");
    const out = { day: table.day, rows: await keepMarket(sql, table) };
    await log(sql, "market", true, out);
    return out;
  } catch (e) {
    const out = { error: e instanceof Error ? e.message : String(e) };
    await log(sql, "market", false, out);
    return out;
  }
}

/** Reads whatever is due now: each source's latest slot of the day that has come and is not taken. */
export async function tick(sql: Sql, now: Date, schedule: Schedule = DEFAULT_SCHEDULE): Promise<string[]> {
  const { day, hour, weekday } = localTime(now, schedule.timeZone);
  const done: string[] = [];
  for (const kind of ["official", "market"] as const) {
    const s = schedule[kind];
    if (!s.weekdays.includes(weekday)) continue;
    const due = [...s.hours].filter((h) => h <= hour).sort((a, b) => b - a)[0];
    if (due === undefined || !(await claim(sql, day, `${kind}:${due}`))) continue;
    await (kind === "official" ? readOfficial(sql, day) : readMarket(sql));
    done.push(`${kind}:${due}`);
  }
  return done;
}

/**
 * The bank's history between two days, for the kept currencies it quotes.
 *
 * The bank refuses a range it thinks too wide, and how wide shrinks with how many
 * currencies are asked at once, so it goes one currency and one year at a time.
 * `budget` caps the requests of one call (a Cloudflare Worker may make fifty): the
 * answer says where it stopped, and calling again from there carries on.
 */
export async function backfill(
  sql: Sql,
  from: string,
  to: string,
  budget = 40,
): Promise<{ rows: number; next: string | null }> {
  const wanted = await quoted(sql);
  let rows = 0;
  let a = from;
  while (a <= to) {
    const b = shift(a, 364) < to ? shift(a, 364) : to;
    if (budget < wanted.length) return { rows, next: a };
    for (const c of wanted) {
      rows += await keepOfficial(sql, await bcuBetween(a, b, [c]));
      budget -= 1;
    }
    a = shift(b, 1);
  }
  await log(sql, "backfill", true, { from, to, rows });
  return { rows, next: null };
}
