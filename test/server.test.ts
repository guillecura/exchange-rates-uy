import { test } from "node:test";
import assert from "node:assert/strict";
import { createCambista } from "../src/server.ts";
import { sqliteSql } from "../src/node.ts";
import { bcuAnswer, dato, fakeFetch, marketAnswer } from "./fixtures.ts";

const TOKEN = "test-token";

function setup() {
  const sql = sqliteSql(":memory:");
  const app = createCambista({ sql, adminToken: TOKEN, maxAge: 0 });
  const get = async (path: string) => {
    const res = await app.fetch(new Request(`http://x${path}`));
    return { status: res.status, body: await res.json() as any };
  };
  const admin = async (body?: unknown, token = TOKEN) => {
    const res = await app.fetch(new Request("http://x/v1/admin", {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }));
    return { status: res.status, body: await res.json() as any };
  };
  return { sql, app, get, admin };
}

function sources() {
  return fakeFetch(
    () => bcuAnswer([
      dato(2225, "2026-11-21", 39.4, 41.8), dato(1111, "2026-11-21", 43.9, 46.9, 1.159),
      dato(2225, "2026-11-24", 39.5, 41.9), dato(1111, "2026-11-24", 44, 47, 1.16),
      dato(500, "2026-11-24", 0.025, 0.026), dato(1000, "2026-11-24", 6.8, 6.9),
    ]),
    () => marketAnswer({ UYU: 40.5, EUR: 0.86, ARS: 1590, BRL: 5.9, JPY: 155 }),
  );
}

test("a new database starts with the seed, and the reading fills both sources", async () => {
  const { app, get, sql } = setup();
  const restore = sources();
  try {
    const read = await app.read();
    assert.ok(!("error" in read.official), JSON.stringify(read.official));
    assert.ok(!("error" in read.market));
    const pairs = (await get("/v1/pairs?date=2026-11-25")).body.pairs;
    assert.deepEqual(pairs.map((p: any) => p.pair), ["USD/UYU", "EUR/UYU", "EUR/USD", "USD/ARS", "USD/BRL"]);
    const usd = pairs[0];
    assert.deepEqual(usd.official, { day: "2026-11-24", buy: 39.5, sell: 41.9 });
    assert.deepEqual(usd.market, { day: "2026-11-23", rate: 40.5 });
    assert.deepEqual(pairs[2].official, { day: "2026-11-24", buy: 1.16, sell: 1.16 }, "the bank's published EUR/USD wins");
    assert.equal((await get("/v1/market?date=2026-11-25")).body.perUsd.JPY, 155, "the whole market table is kept");
    assert.equal((await get("/v1/official?date=2026-11-22")).body.day, "2026-11-21", "a day with no reading reads the one before");
    sql.close();
  } finally {
    restore();
  }
});

test("convert, and a pair's history from either source", async () => {
  const { app, get } = setup();
  const restore = sources();
  try {
    await app.read();
    const c = (await get("/v1/convert?amount=100&from=USD&to=UYU&source=official&date=2026-11-25")).body;
    assert.equal(c.result, 4190);
    assert.equal((await get("/v1/convert?amount=100&from=USD&to=UYU&source=official&side=buy&date=2026-11-25")).body.result, 3950);
    assert.equal((await get("/v1/convert?amount=1&from=EUR&to=JPY&date=2026-11-25")).body.rate, 155 / 0.86);
    const h = (await get("/v1/pairs/USD-UYU/history?from=2026-11-01&to=2026-11-30")).body;
    assert.deepEqual(h.days.map((d: any) => d.day), ["2026-11-21", "2026-11-24"]);
    assert.equal((await get("/v1/convert?from=USD&to=ZZZ")).status, 400);
  } finally {
    restore();
  }
});

test("the clock reads each due slot once, and only on the days it is set for", async () => {
  const { app, sql } = setup();
  let bcuCalls = 0;
  const restore = fakeFetch(() => { bcuCalls += 1; return bcuAnswer([dato(2225, "2026-11-24", 39.5, 41.9)]); }, () => marketAnswer({ UYU: 40.5 }));
  try {
    // Tuesday 25 Nov 2026, 11:00 in Montevideo (14:00 UTC): the 10 o'clock slots are due.
    assert.deepEqual(await app.tick(new Date("2026-11-25T14:00:00Z")), ["official:10", "market:10"]);
    assert.deepEqual(await app.tick(new Date("2026-11-25T14:30:00Z")), [], "taken already");
    assert.deepEqual(await app.tick(new Date("2026-11-25T17:05:00Z")), ["official:14"]);
    // Saturday: no official slot, the market's still.
    assert.deepEqual(await app.tick(new Date("2026-11-28T22:00:00Z")), ["market:18"]);
    assert.equal(bcuCalls, 2);
    sql.close();
  } finally {
    restore();
  }
});

test("the admin API: behind the token, and the panel's rules", async () => {
  const { admin, get } = setup();
  assert.equal((await admin(undefined, "wrong")).status, 401);
  assert.equal((await get("/v1/admin")).status, 401);

  assert.equal((await admin({ kind: "currency", fresh: true, iso: "ZZZ" })).body.error, "bad_iso");
  assert.equal((await admin({ kind: "currency", fresh: true, iso: "USD" })).status, 409);
  assert.equal((await admin({ kind: "currency", fresh: true, iso: "jpy" })).status, 200);
  assert.equal((await admin({ kind: "currency", iso: "USD", symbol: "US$" })).status, 200);

  assert.equal((await admin({ kind: "pair", fresh: true, base: "USD", quote: "USD" })).body.error, "same_currency");
  assert.equal((await admin({ kind: "pair", fresh: true, base: "USD", quote: "CLP" })).body.error, "unknown_currency");
  assert.equal((await admin({ kind: "pair", fresh: true, base: "UYU", quote: "USD" })).status, 409, "USD/UYU exists the other way");
  assert.equal((await admin({ kind: "pair", fresh: true, base: "USD", quote: "JPY" })).body.pair, "USD/JPY");

  assert.equal((await admin({ kind: "reverse", pair: "USD-JPY" })).body.pair, "JPY/USD");
  assert.equal((await admin({ kind: "pair", pair: "EUR/USD", active: false })).status, 200);
  assert.equal((await admin({ kind: "order", pairs: ["JPY/USD", "USD/UYU"] })).status, 200);

  const all = (await admin()).body;
  assert.equal(all.currencies.find((c: any) => c.iso === "USD").symbol, "US$");
  assert.deepEqual(all.pairs.slice(0, 2).map((p: any) => p.pair), ["JPY/USD", "USD/UYU"]);
  assert.equal(all.pairs.find((p: any) => p.pair === "EUR/USD").active, false);
  assert.ok(!all.catalog.some((c: any) => c.iso === "JPY"), "the catalogue leaves the kept ones out");
  assert.ok(!(await get("/v1/pairs")).body.pairs.some((p: any) => p.pair === "EUR/USD"), "a retired pair is not public");
});

test("the pages: public always, the panel only with a token", async () => {
  const { app } = setup();
  const home = await app.fetch(new Request("http://x/", { headers: { "accept-language": "es-UY" } }));
  assert.match(await home.text(), /Conversor/);
  assert.equal((await app.fetch(new Request("http://x/admin"))).status, 200);
  const open = createCambista({ sql: (await import("../src/node.ts")).sqliteSql(":memory:") });
  assert.equal((await open.fetch(new Request("http://x/admin"))).status, 404, "no token, no panel");
});
