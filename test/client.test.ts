import { test } from "node:test";
import assert from "node:assert/strict";
import { createRatesClient, perLocal, RatesError } from "../src/client.ts";
import { createExchangeRates } from "../src/server.ts";
import { openSqlite } from "../src/sqlite.ts";
import { bcuAnswer, dato, fakeFetch, marketAnswer, pastAnswer } from "./fixtures.ts";

test("the client reads a server as an app does: with its key, typed, the server's errors as RatesError", async () => {
  const sql = await openSqlite(":memory:");
  const server = createExchangeRates({ sql, access: { keys: ["app-key"] } });
  const restore = fakeFetch(() => bcuAnswer([dato(2225, "2026-11-24", 39.5, 41.9)]), () => marketAnswer({ UYU: 40.5, EUR: 0.86 }));
  try {
    await server.read();
    const through = ((req: RequestInfo | URL, init?: RequestInit) => server.fetch(new Request(req, init))) as typeof fetch;
    const rates = createRatesClient({ baseUrl: "http://rates.x/api/", key: "app-key", fetch: through });
    assert.deepEqual((await rates.official("2026-11-25")).perLocal.USD, { buy: 39.5, sell: 41.9 });
    const market = await rates.market("2026-11-25");
    assert.equal(market.perUsd.EUR, 0.86);
    assert.equal(perLocal(market).USD, 40.5);
    assert.deepEqual((await rates.history("USD/UYU", { from: "2026-11-01", to: "2026-11-30" })).map((d) => d.day), ["2026-11-24"]);
    assert.equal((await rates.convert({ amount: 2, from: "USD", to: "UYU", source: "official", date: "2026-11-25" })).result, 83.8);
    assert.ok((await rates.pairs()).some((p) => p.pair === "USD/UYU"));

    const keyless = createRatesClient({ baseUrl: "http://rates.x/api", fetch: through });
    await assert.rejects(keyless.official(), (e) => e instanceof RatesError && e.status === 403);
    assert.throws(() => rates.official("25/11/2026"), RangeError);
  } finally {
    restore();
    sql.close();
  }
});

test("without a server the client reads the sources itself, with the server's arithmetic", async () => {
  const restore = fakeFetch(
    () => bcuAnswer([dato(2225, "2026-11-24", 39.5, 41.9), dato(1111, "2026-11-24", 44, 47, 1.16)]),
    () => marketAnswer({ UYU: 40.5, EUR: 0.86, JPY: 155 }),
    (day) => (day >= "2026-11-20" ? pastAnswer(day, { UYU: 40, EUR: 0.9 }) : null),
  );
  try {
    const rates = createRatesClient({ pairs: ["USD/UYU", "EUR/USD"] });
    const bank = await rates.official("2026-11-25");
    assert.equal(bank.day, "2026-11-24");
    assert.deepEqual(bank.perLocal.USD, { buy: 39.5, sell: 41.9 });
    const pairs = await rates.pairs();
    assert.deepEqual(pairs.map((p) => p.pair), ["USD/UYU", "EUR/USD"]);
    assert.deepEqual(pairs[1]!.official && { buy: pairs[1]!.official.buy }, { buy: 1.16 }, "the bank's published EUR/USD wins");
    assert.equal(pairs[0]!.market?.rate, 40.5);
    assert.equal((await rates.convert({ amount: 1, from: "EUR", to: "JPY" })).rate, 155 / 0.86);
    assert.equal((await rates.convert({ amount: 100, from: "USD", to: "UYU", source: "official", date: "2026-11-25" })).result, 4190);
    assert.deepEqual((await rates.history("USD/UYU", { from: "2026-11-20", to: "2026-11-25" })).map((d) => d.day), ["2026-11-24"]);
    const market = await rates.history("USD/UYU", { source: "market", from: "2026-11-19", to: "2026-11-23" });
    assert.deepEqual(market.map((d) => [d.day, d.buy, d.source]), [
      ["2026-11-20", 40, "past"], ["2026-11-21", 40, "past"], ["2026-11-22", 40, "past"], ["2026-11-23", 40.5, "live"],
    ]);
    const past = await rates.market("2026-11-21");
    assert.equal(past.source, "past");
    assert.equal(past.credit.label, "exchange-rates-uy");
    await assert.rejects(rates.market("2020-01-01"), (e) => e instanceof RatesError && e.status === 404);
    assert.deepEqual((await rates.currencies("es")).map((c) => c.iso), ["USD", "UYU", "EUR"]);
  } finally {
    restore();
  }
});
