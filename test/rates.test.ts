import { test } from "node:test";
import assert from "node:assert/strict";
import { bcuBetween, bcuCode, marketCross, officialCross } from "../src/index.ts";
import { currencyPlaces, isKnownCurrency, rate, ratePlaces } from "../src/money.ts";
import { bcuAnswer, dato, fakeFetch } from "./fixtures.ts";

test("officialCross: what the bank published wins, else through the peso with the spreads compounded", () => {
  const perLocal = { UYU: { buy: 1, sell: 1 }, USD: { buy: 39.5, sell: 41.9 }, EUR: { buy: 44, sell: 47 } };
  assert.deepEqual(officialCross(perLocal, { "EUR/USD": { buy: 1.16, sell: 1.16 } }, "EUR", "USD"), { buy: 1.16, sell: 1.16 });
  assert.deepEqual(officialCross(perLocal, {}, "USD", "UYU"), { buy: 39.5, sell: 41.9 });
  const eurUsd = officialCross(perLocal, {}, "EUR", "USD")!;
  assert.equal(eurUsd.buy, 44 / 41.9);
  assert.equal(eurUsd.sell, 47 / 39.5);
  assert.equal(officialCross(perLocal, {}, "USD", "JPY"), null);
  // Either way round: what the bank published for EUR/USD answers USD/EUR too, its selling price the buying one.
  assert.deepEqual(officialCross(perLocal, { "EUR/USD": { buy: 1.15, sell: 1.16 } }, "USD", "EUR"), { buy: 1 / 1.16, sell: 1 / 1.15 });
});

test("marketCross: the quote's column over the base's", () => {
  const perUsd = { USD: 1, UYU: 40, EUR: 0.8 };
  assert.equal(marketCross(perUsd, "USD", "UYU"), 40);
  assert.equal(marketCross(perUsd, "UYU", "USD"), 1 / 40);
  assert.equal(marketCross(perUsd, "EUR", "UYU"), 50);
  assert.equal(marketCross(perUsd, "EUR", "XXX"), null);
});

test("the BCU: one request for a range, each block under its own day, the arbitrage kept apart", async () => {
  let asked = "";
  const restore = fakeFetch((body) => {
    asked = body;
    return bcuAnswer([
      dato(2225, "2026-11-21", 39.4, 41.8), dato(2225, "2026-11-24", 39.5, 41.9), dato(1111, "2026-11-24", 44, 47, 1.16),
      dato(500, "2026-11-24", 0.0248, 0.0262, 1579.2758), dato(1000, "2026-11-24", 6.6, 7.0, 5.9398),
    ]);
  }, () => ({}));
  try {
    const days = await bcuBetween("2026-11-20", "2026-11-24", [
      { iso: "USD", bcu: bcuCode("USD") }, { iso: "EUR", bcu: bcuCode("EUR") }, { iso: "ARS", bcu: bcuCode("ARS") }, { iso: "BRL", bcu: bcuCode("BRL") },
    ]);
    assert.match(asked, /<cot:item>2225<\/cot:item><cot:item>1111<\/cot:item>/);
    // The arbitrage of the peso argentino and the real comes as units per dollar: kept as dollars per unit.
    assert.equal(days[1]!.published["ARS/USD"]!.sell, 1 / 1579.2758);
    assert.equal(days[1]!.published["BRL/USD"]!.sell, 1 / 5.9398);
    assert.equal(officialCross(days[1]!.perLocal, days[1]!.published, "USD", "ARS")!.sell, 1579.2758);
    assert.ok(Math.abs(officialCross(days[1]!.perLocal, days[1]!.published, "BRL", "USD")!.sell - 0.16836) < 1e-4);
    assert.deepEqual(days.map((d) => d.day), ["2026-11-21", "2026-11-24"]);
    assert.deepEqual(days[1]!.perLocal.EUR, { buy: 44, sell: 47 });
    assert.deepEqual(days[1]!.published["EUR/USD"], { buy: 1.16, sell: 1.16 });
    assert.equal(bcuCode("JPY"), 3600);
    assert.equal(bcuCode("BDT"), 0);
  } finally {
    restore();
  }
});

test("money: currencies from the platform, rates with four digits that mean something", () => {
  assert.equal(isKnownCurrency("UYU"), true);
  assert.equal(isKnownCurrency("ZZZ"), false);
  assert.equal(currencyPlaces("JPY"), 0);
  assert.equal(ratePlaces(1506.9), 0);
  assert.equal(ratePlaces(40.0784), 2);
  assert.equal(ratePlaces(0.024951), 4);
  assert.equal(rate(40.0784, "en"), "40.08");
});
