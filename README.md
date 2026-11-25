# exchange-rates-uy

**Uruguay's exchange rates, on your own backend.** The **official** rate (Banco Central del Uruguay: buying and selling, every working day) and the **market** rate (ExchangeRate-API: every currency, every day), any pair between the currencies you choose, read on the schedule you choose, served by an API, a public page with a converter, and a panel to add currencies and pairs.

**Demo: [rates.whitebear.io](https://rates.whitebear.io)**, Whitebear's rates tool, running on this package.

```sh
npx exchange-rates-uy serve
# → http://localhost:8787 with the page, http://localhost:8787/api/pairs with the rates
```

No API keys and no accounts: both sources are free and open. It brings no database and no host of its own: it runs on the ones you already have.

| Database | Adapter |
| --- | --- |
| SQLite (a file: `node:sqlite`, `better-sqlite3`, `bun:sqlite`) | `exchange-rates-uy/sqlite` |
| Postgres (Supabase, Neon, Vercel Postgres, RDS, Aurora, local, PGlite) | `exchange-rates-uy/postgres` |
| Cloudflare D1 | `exchange-rates-uy/d1` |

| Platform | How |
| --- | --- |
| Any server (Node 22.13+), Docker | `exchange-rates-uy/node`, `npx exchange-rates-uy serve`, the `Dockerfile` |
| Cloudflare Workers | `exchange-rates-uy/worker` |
| AWS Lambda | `exchange-rates-uy/lambda` |
| Vercel, Netlify, Deno, Bun, Supabase Edge Functions | `createExchangeRates(…).fetch` is a plain `Request → Response` |

## Contents

- [Why two sources](#why-two-sources)
- [What it does](#what-it-does)
- [Quick start](#quick-start): [Node](#on-any-server-with-node) · [Docker](#in-docker) · [Cloudflare](#on-cloudflare-workers) · [Supabase](#on-supabase) · [Vercel](#on-vercel) · [AWS Lambda](#on-aws-lambda) · [anything else](#anywhere-else)
- [Pairs and currencies](#pairs-and-currencies)
- [The schedule](#the-schedule)
- [The API](#the-api)
- [The panel](#the-panel)
- [Options](#options)
- [The library](#the-library)
- [How it keeps the rates](#how-it-keeps-the-rates)
- [Credits](#credits)

## Why two sources

They answer two questions. The **official** rate is what an invoice, a tax return or any figure that has to agree with somebody outside is read against: the BCU publishes it once a working day, buying and selling, and nothing on a bank holiday. The **market** rate is what the rest of the world uses while the official one holds all day: one number for every currency, every day.

Neither replaces the other, and they are never averaged: an average of an official rate and a market one is a figure that is true nowhere.

## What it does

- **Reads both sources on a schedule**: the BCU at 10, 14 and 18 in Montevideo on working days and the market at 10 and 18 by default, or whatever you set. Each slot is claimed in the database before it is read, so restarts, several instances or a late trigger never read twice, and a slot missed while the server was down is read on its next tick.
- **Keeps what the sources said, as they said it**: the bank's reading of each currency per day (with the dollar arbitrage it publishes) and the market's whole table per day (about 160 currencies).
- **Answers any pair**. Official: what the bank published directly where it did, else a division through the peso with both spreads compounded, which is what going through it costs. Market: one column over another. A pair is computed when asked, so one added today has its whole history at once.
- **Serves an API** anybody may read from any origin, **a public page** with the pairs and a converter, and **a panel** to add currencies and pairs, retire, star and order them, read now, and load the bank's history back to 2018 or earlier.
- **Writes rates the way people read them**: four digits that mean something (`40.08`, `0.0256`, `1592`), and money with its code, because `$` alone says nothing.

## Quick start

### On any server, with Node

```sh
ADMIN_TOKEN=a-long-secret npx exchange-rates-uy serve --port 8787 --database ./rates.db
```

The page is `/`, the API `/api`, the panel `/admin` (with `ADMIN_TOKEN`). The environment sets the rest: `RATES_CURRENCIES=USD,UYU,EUR`, `RATES_PAIRS=USD/UYU,EUR/UYU`, `RATES_OFFICIAL_HOURS=10,14,18`, `RATES_MARKET_HOURS=10,18`, `RATES_TIMEZONE`, `RATES_TITLE`, `RATES_LANG=es|en`, `CRON_SECRET`.

In code, on SQLite or on Postgres ([`examples/node`](examples/node)):

```ts
import { serve } from "exchange-rates-uy/node";
await serve({ port: 8787, database: "./rates.db", adminToken: process.env.ADMIN_TOKEN });

// or on Postgres
import pg from "pg";
import { pgSql } from "exchange-rates-uy/postgres";
await serve({ sql: pgSql(new pg.Pool({ connectionString: process.env.DATABASE_URL })) });
```

### In Docker

```sh
docker build -t exchange-rates-uy .
docker run -p 8787:8787 -v rates:/data -e ADMIN_TOKEN=a-long-secret exchange-rates-uy
```

### On Cloudflare Workers

```sh
npm install exchange-rates-uy
npx wrangler d1 create exchange-rates
```

```ts
// src/index.ts
import { exchangeRatesWorker } from "exchange-rates-uy/worker";
export default exchangeRatesWorker();
```

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "exchange-rates"
database_id = "…"          # from `wrangler d1 create`

[triggers]
crons = ["*/15 * * * *"]   # only wakes it: the schedule decides what is read
```

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

The free plan is plenty. This is how [rates.whitebear.io](https://rates.whitebear.io) runs. See [`examples/cloudflare`](examples/cloudflare).

### On Supabase

An Edge Function on your project's own Postgres, the tables beside yours (`rates_official`, `rates_pair`…), so your SQL can join them. pg_cron calls its `/api/tick`. See [`examples/supabase`](examples/supabase).

```ts
import postgres from "npm:postgres";
import { createExchangeRates } from "npm:exchange-rates-uy/server";
import { postgresJsSql } from "npm:exchange-rates-uy/postgres";

const rates = createExchangeRates({
  sql: postgresJsSql(postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false })),
  apiBase: "/rates/api",
  cronSecret: Deno.env.get("RATES_CRON_SECRET"),
});
Deno.serve((req) => rates.fetch(req));
```

### On Vercel

A Function on Postgres (Neon from the Marketplace), with Vercel Cron calling `/api/tick`: Vercel sends `Authorization: Bearer $CRON_SECRET`, which is what `cronSecret` checks. See [`examples/vercel`](examples/vercel).

### On AWS Lambda

A Function URL or an HTTP API for the requests, and an EventBridge rule every 15 minutes invoking the same function for the clock. See [`examples/aws-lambda`](examples/aws-lambda).

```ts
import pg from "pg";
import { lambdaHandler } from "exchange-rates-uy/lambda";
import { pgSql } from "exchange-rates-uy/postgres";
export const handler = lambdaHandler({ sql: pgSql(new pg.Pool({ connectionString: process.env.DATABASE_URL })) });
```

### Anywhere else

`createExchangeRates({ sql })` from `exchange-rates-uy/server` gives `fetch(request)` and `tick(now)`. Hand `fetch` to whatever serves requests (Bun's `Bun.serve`, Deno's `Deno.serve`, Hono, a Next.js route handler) and call `tick` from whatever keeps time (a timer, a cron, or a request to `/api/tick` with the cron secret). A database is three functions ([`src/server/sql.ts`](src/server/sql.ts)), so another one is a few lines.

## Pairs and currencies

A **currency** is its ISO code and nothing else: its name in each language, its mark and its decimals come from the platform (`Intl`). If the BCU quotes it (34 currencies, from the dollar to the Peruvian sol), it joins the official reading the moment it is kept; the market has all of them anyway.

A **pair** is two kept currencies, `BASE/QUOTE`: one `BASE` buys this many `QUOTE`. `USD/UYU` is pesos per dollar, `EUR/USD` dollars per euro, `USD/ARS` Argentine pesos per dollar through the Uruguayan peso.

Three ways to choose them:

- **The seed**, the first ones of a new database: `seed: { currencies: ["USD", "UYU", "EUR"], pairs: ["USD/UYU", "EUR/UYU"] }`, or `RATES_CURRENCIES` and `RATES_PAIRS`.
- **The panel**: add, retire, star, order, reverse.
- **The admin API**, which is what the panel calls.

## The schedule

```ts
schedule: {
  timeZone: "America/Montevideo",                                        // the hours below are this zone's
  official: { hours: [10, 14, 18], weekdays: [1, 2, 3, 4, 5] },          // the BCU publishes on working days
  market:   { hours: [10, 18],     weekdays: [0, 1, 2, 3, 4, 5, 6] },    // its table is rebuilt once a day
}
```

Any hours and any days. Whatever runs it only has to call `tick` often enough (every 15 minutes is plenty): the Worker's Cron Trigger, the Node server's own timer, a scheduled Lambda, pg_cron, Vercel Cron.

## The API

`GET`, open to any origin unless [`access`](#who-may-read-the-api) says otherwise, cached five minutes. `date=YYYY-MM-DD` reads another day: the last reading on or before it. Days are Montevideo's. 

| Endpoint | What |
| --- | --- |
| `/api/pairs` | The kept pairs, each with its official rate (`buy`, `sell`, `day`) and its market rate (`rate`, `day`). |
| `/api/pairs/USD-UYU/history?from=&to=&source=official\|market` | One pair, day by day (up to ten years per call). |
| `/api/convert?amount=100&from=USD&to=UYU&source=official\|market&side=buy\|sell\|mid` | An amount in another currency. |
| `/api/official` | The bank's reading: each currency in pesos (`perLocal`) and what it published against the dollar (`published`). |
| `/api/market` | The market's table: how many of each currency buy one dollar (`perUsd`), and its credit. |
| `/api/currencies?lang=es` | The kept currencies: name, mark, decimals, whether the BCU quotes them. |
| `/api/status` | The newest day of each source and the last readings. |

```json
GET /api/pairs
{
  "date": "2026-11-25",
  "pairs": [
    { "pair": "USD/UYU", "base": "USD", "quote": "UYU", "favourite": true,
      "official": { "day": "2026-11-24", "buy": 40.697, "sell": 40.697 },
      "market": { "day": "2026-11-24", "rate": 40.532 } }
  ]
}
```

Two more, behind a secret:

- `POST /api/tick` (or `GET`), with `Authorization: Bearer <cronSecret or adminToken>`: reads whatever is due.
- `GET`/`POST /api/admin`, with `Authorization: Bearer <adminToken>` (or your `authorize`): the panel's. The actions are `currency`, `pair`, `reverse`, `order`, `read` and `backfill` ([`src/server/api.ts`](src/server/api.ts)).

## The panel

At `/admin`, on with an `adminToken` (or an `authorize` function). Add a currency by searching its code, name or country; add a pair from two kept ones; retire, star, reverse and order pairs; set a currency's own mark (`US$` beside the peso's `$`); read now; load the BCU's history from any day. It asks for the token once per tab, or opens straight away when `authorize` lets the request in (your own session cookie, an access proxy), which is how Whitebear's sits behind its own panel's sign-in.

## Options

```ts
createExchangeRates({                 // exchangeRatesWorker({…}), serve({…}) and lambdaHandler({…}) take the same
  sql,                                // the database (not for the Worker: it is env.DB)
  tablePrefix: "rates_",              // the tables' prefix
  apiBase: "/api",                    // where the API answers
  adminToken: "…",                    // the panel and the admin API (the Worker reads env.ADMIN_TOKEN)
  authorize: (req) => …,              // instead of the token: any check on the request
  cronSecret: "…",                    // the bearer a scheduler sends to /api/tick
  schedule: { … },                    // see above
  seed: { currencies: [...], pairs: [...] },
  page: { title, tagline, footer, lang: "es" },
  publicPage: true,                   // false: the API only
  maxAge: 300,                        // the public API's cache, in seconds
  observe: (e) => …,                  // each API request: route, status, ms, origin, referer, user agent
  access: { origins: [...], keys: [...] }, // who may read the API (open to everybody without it)
});
```

### Who may read the API

Open to everybody by default. With `access`, only:

- the web **origins** listed (`"https://app.example.com"`), whose pages call it from a browser (CORS answers them and nobody else);
- the server's **own page**, always;
- a server-side caller with one of the **keys**, as `Authorization: Bearer <key>` or `X-Api-Key: <key>` (a server has no origin to check).

What a browser says about where a call comes from stops other web pages from using your API; a script can write those headers itself, so the keys are what really close it. Behind `access` the answers are `private` for caches, so no shared cache hands one caller's answer to another.

`observe` is how you count usage, log or send metrics: it is told of each API request once it is answered (`{ at, route, method, status, ms, origin, referer, userAgent }`, the route without values: `pairs/history`, not `pairs/USD-UYU/history`) and the answer never waits for it. On a Worker it keeps running after the answer through `ctx.waitUntil`. rates.whitebear.io counts its API's use per day, endpoint and client this way.

## The library

Without a server: the same sources and arithmetic, to use inside an app of your own.

```ts
import { latestBcu, bcuCode, marketTable, officialCross, marketCross } from "exchange-rates-uy";
import { money, rate, currencyName } from "exchange-rates-uy/money";

const bank = await latestBcu([{ iso: "USD", bcu: bcuCode("USD") }]);
officialCross(bank!.perLocal, bank!.published, "USD", "UYU");  // { buy, sell }

const market = await marketTable();
marketCross(market!.perUsd, "EUR", "JPY");                        // yen per euro

rate(40.0784, "es");             // "40,08"
money(1234.5, "UYU", "es-UY");   // "UYU 1.234,50"
currencyName("UYU", "es");       // "peso uruguayo"
```

## How it keeps the rates

Seven tables, prefixed (`rates_` by default), created and migrated by the server on its first request:

| Table | What |
| --- | --- |
| `currency`, `pair` | What you chose: the kept currencies (and their own marks), the pairs (order, starred, active). |
| `official` | The bank's reading: one row per day and currency, buying and selling in pesos, and its published dollar arbitrage. |
| `market` | The market's table: one row per day and currency, units per dollar. |
| `slot` | Which slot of each day was read, so none is read twice. |
| `log` | Each reading and how it went (90 days). |
| `meta` | How far the schema has migrated. |

Retiring a currency or a pair only hides it: the readings stay, and bringing it back brings its history back.

## Develop

```sh
npm install
npm test          # every server test on SQLite and on Postgres (PGlite)
npm run typecheck
npm run build
```

## Credits

- Official rates: [Banco Central del Uruguay](https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx).
- Market rates: [Rates By Exchange Rate API](https://www.exchangerate-api.com). Their free tier asks for this credit beside their figures, and the public page shows it: keep it if you build your own.

Made by [Guille Cura](https://github.com/guillecura). It keeps the rates for [Whitebear](https://whitebear.io)'s products ([rates.whitebear.io](https://rates.whitebear.io)) and for [Umino](https://github.com/Umino-Trade).

## License

MIT
