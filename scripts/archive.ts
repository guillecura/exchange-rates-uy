/**
 * The market's archive: `data/market/YYYY-MM.json`, every day since 2 March 2024, every ISO currency against the
 * dollar. It ships in the npm package and is what every client and server reads for a day gone by, so at run time
 * nothing asks anyone else for the past.
 *
 *   node scripts/archive.ts              # adds every day missing up to yesterday (Montevideo)
 *   node scripts/archive.ts 2026-11-30   # … up to that day
 *
 * The figures are public-domain daily reference rates (CC0), taken once here and kept. ExchangeRate-API's table,
 * which a server reads every day, is not put here: its terms let a server keep it for its own use, not publish it.
 * Run once a month by `.github/workflows/archive.yml`, which publishes the package when a month grew.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PAST_MARKET_FROM, type MarketMonth } from "../src/rates/market.ts";

const DIR = new URL("../data/market/", import.meta.url);
const ISO = new Set(Intl.supportedValuesOf("currency"));
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const yesterday = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Montevideo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return shift(`${p.year}-${p.month}-${p.day}`, -1);
};

const upstream = (day: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`,
  `https://${day}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];

/** One day's table, ISO codes only, eight significant digits; null when no copy has it. */
async function day(d: string): Promise<Record<string, number> | null> {
  for (const url of upstream(d)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r?.ok) continue;
    const body = (await r.json().catch(() => null)) as { date?: string; usd?: Record<string, number> } | null;
    if (!body?.usd || body.date !== d) continue;
    const out: Record<string, number> = { USD: 1 };
    for (const [code, v] of Object.entries(body.usd)) {
      const iso = code.toUpperCase();
      if (ISO.has(iso) && Number.isFinite(v) && v > 0) out[iso] = Number(v.toPrecision(8));
    }
    if (out.UYU) return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  }
  return null;
}

const to = process.argv[2] ?? yesterday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error(`a day is YYYY-MM-DD: ${to}`);
await mkdir(DIR, { recursive: true });

const added: string[] = [];
const missing: string[] = [];
for (let month = PAST_MARKET_FROM.slice(0, 7); month <= to.slice(0, 7); month = shift(`${month}-28`, 7).slice(0, 7)) {
  const file = new URL(`${month}.json`, DIR);
  const kept: MarketMonth = await readFile(file, "utf8").then((t) => JSON.parse(t) as MarketMonth).catch(() => ({ base: "USD", month, days: {} }));
  const wanted: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month) && d <= to; d = shift(d, 1)) if (d >= PAST_MARKET_FROM && !kept.days[d]) wanted.push(d);
  if (!wanted.length) continue;
  for (let i = 0; i < wanted.length; i += 8) {
    const batch = wanted.slice(i, i + 8);
    const tables = await Promise.all(batch.map(day));
    batch.forEach((d, j) => {
      const t = tables[j];
      if (t) { kept.days[d] = t; added.push(d); } else missing.push(d);
    });
  }
  const days = Object.fromEntries(Object.entries(kept.days).sort(([a], [b]) => a.localeCompare(b)));
  if (Object.keys(days).length) await writeFile(file, `${JSON.stringify({ base: "USD", month, days })}\n`);
}

console.log(JSON.stringify({ to, added: added.length, first: added[0] ?? null, last: added.at(-1) ?? null, missing }));
