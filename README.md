# cambista

Exchange rates you host yourself. The **official** rate (Banco Central del Uruguay: buying and selling, every working day) and the **market** rate (ExchangeRate-API: every currency, every day), any pair between the currencies you keep, a public API, a public page with a converter, and a panel to add currencies and pairs.

It runs on **Cloudflare Workers** (with D1) or on **any server with Node 22** (with a SQLite file, or in Docker). No API keys, no accounts: both sources are free and open.

```sh
npx cambista serve
# → http://localhost:8787, reading the BCU and the market on schedule
```

## Why two sources

They answer two questions. The **official** rate is what an invoice, a tax return or any figure that has to agree with somebody outside is read against. The **market** rate is what the rest of the world is using while the official one holds all day. Neither replaces the other, and they are never averaged: an average of an official rate and a market one is a figure that is true nowhere.

## What you get

- **The readings, on a schedule.** The BCU at 10, 14 and 18 in Montevideo on working days; the market twice a day. Each slot is claimed in the database before it is read, so restarts, several instances or a late trigger never read twice, and a slot missed while the server was down is read on its next tick.
- **What the sources said, kept as they said it.** The bank's reading of each kept currency per day (with its published arbitrage against the dollar) and the market's whole table per day (about 160 currencies). A pair is arithmetic on those when somebody asks, so a pair added today has its whole history at once.
- **Any pair.** The official rate is what the bank published directly where it did, else a division through the peso with both spreads compounded (what it actually costs to go through it). The market rate is one column over another.
- **An API** anybody may read, from any origin.
- **A public page**: the pairs with both rates, a converter between any two currencies, the credits the sources ask for.
- **A panel** (`/admin`, behind a token): add a currency by its ISO code (its name, mark and decimals come from the platform), add pairs, retire, star and order them, read now, load the bank's history back to whenever you want.

## Run it

### On Cloudflare Workers

```sh
npm create cloudflare@latest my-rates -- --type hello-world --lang ts
cd my-rates && npm install cambista
npx wrangler d1 create cambista
```

```ts
// src/index.ts
import { cambistaWorker } from "cambista/worker";
export default cambistaWorker();
```

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "cambista"
database_id = "…"          # from `wrangler d1 create`

[triggers]
crons = ["*/15 * * * *"]   # only wakes it: the schedule decides what is read
```

```sh
npx wrangler secret put ADMIN_TOKEN   # turns the panel on
npx wrangler deploy
```

The free plan is plenty: a handful of requests per reading and a few hundred rows a day. See [`examples/cloudflare`](examples/cloudflare).

### On any server, with Node

```sh
ADMIN_TOKEN=… npx cambista serve --port 8787 --database ./cambista.db
```

or in code ([`examples/node`](examples/node)):

```ts
import { serve } from "cambista/node";
serve({ port: 8787, database: "./cambista.db", adminToken: process.env.ADMIN_TOKEN });
```

### In Docker

```sh
docker build -t cambista .
docker run -p 8787:8787 -v cambista:/data -e ADMIN_TOKEN=… cambista
```

### The bank's history

The BCU publishes its history for free. From the panel (**Load the BCU's history from**), or:

```sh
npx cambista backfill --from 2018-01-01 --database ./cambista.db
```

## The API

All `GET`, open to any origin, cached five minutes. `date=YYYY-MM-DD` reads another day (the last reading on or before it); days are Montevideo's.

| Endpoint | What |
| --- | --- |
| `/v1/pairs` | The kept pairs, each with its official rate (`buy`, `sell`, `day`) and its market rate (`rate`, `day`). |
| `/v1/pairs/USD-UYU/history?from=&to=&source=official\|market` | One pair, day by day. |
| `/v1/convert?amount=100&from=USD&to=UYU&source=official\|market&side=buy\|sell\|mid` | An amount in another currency. |
| `/v1/official` | The bank's reading: each currency in pesos (`perLocal`) and what it published against the dollar (`published`). |
| `/v1/market` | The market's table: how many of each currency buy one dollar (`perUsd`). |
| `/v1/currencies?lang=es` | The kept currencies: name, mark, decimals, whether the bank quotes them. |
| `/v1/status` | The newest day of each source and the last readings. |

The admin API is `GET`/`POST /v1/admin` with `Authorization: Bearer <ADMIN_TOKEN>`; the panel is its only client and the actions are in [`src/server/api.ts`](src/server/api.ts).

## Options

```ts
cambistaWorker({                      // or serve({ … }) on Node, or createCambista({ sql, … })
  page: { title: "Cotizaciones", tagline: "…", footer: "<p>…</p>", lang: "es" }, // lang: else the browser's
  seed: { currencies: ["USD", "UYU", "EUR"], pairs: ["USD/UYU", "EUR/UYU"] }, // a new database's first ones
  schedule: {
    timeZone: "America/Montevideo",
    official: { hours: [10, 14, 18], weekdays: [1, 2, 3, 4, 5] },
    market: { hours: [10, 18], weekdays: [0, 1, 2, 3, 4, 5, 6] },
  },
  authorize: (req) => …,              // instead of a token: any check on the request
  publicPage: true,                   // false: the API only
  maxAge: 300,                        // the public API's cache, in seconds
});
```

Anything that speaks `Request` and `Response` can hold the server: `createCambista({ sql })` from `cambista/server` gives `fetch(request)` and `tick(now)`; `sql` is three functions over a SQLite-dialect database ([`src/server/sql.ts`](src/server/sql.ts)).

## The library

Without a server, the same sources and arithmetic:

```ts
import { latestBcu, marketTable, officialCross, marketCross, bcuCode } from "cambista";
import { money, rate, currencyName } from "cambista/money";

const bank = await latestBcu([{ iso: "USD", bcu: bcuCode("USD") }]);
officialCross(bank!.perLocal, bank!.published, "USD", "UYU"); // { buy, sell }

const market = await marketTable();
marketCross(market!.perUsd, "EUR", "JPY");

rate(40.0784, "es");          // "40,08": four digits that mean something
money(1234.5, "UYU", "es-UY"); // "UYU 1.234,50": the code, because "$" says nothing
```

## Credits

- Official rates: [Banco Central del Uruguay](https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx).
- Market rates: [Rates By Exchange Rate API](https://www.exchangerate-api.com). Their free tier asks for this credit next to their figures, and the public page shows it: keep it if you build your own.

Born inside [Umino](https://github.com/Umino-Trade) and [Whitebear](https://whitebear.io), where it keeps the rates for every product.

## License

MIT
