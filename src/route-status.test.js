import assert from "node:assert/strict";
import test from "node:test";

import { networks } from "@dusk-network/networks";

import { amountsIn, exactly } from "./pages.fixtures.js";
import { createRouteStatus, statusLine } from "./route-status.js";

const NOW = Date.UTC(2026, 10, 5, 12);
const MINUTE = 60_000;
const line = (status, options) => statusLine({ canPay: null, lastPayout: null, limit: "mints", readSince: null, ...status }, { now: NOW, ...options });
const paid = (ago) => ({ amount: 5n, at: NOW - ago, block: 1, hash: "0xaa" });

test("a route's status says whether it's paying out and when it last did, and warns only where payouts run late", () => {
  const paying = line({ lastPayout: paid(12 * MINUTE), paying: "yes" });
  assert.equal(paying.warn, false);
  assert.match(paying.text, exactly("12 minutes"));
  // Under a minute ago, or at a time not read: no number of minutes.
  for (const lastPayout of [paid(20_000), { ...paid(0), at: null }]) assert.doesNotMatch(line({ lastPayout, paying: "yes" }).text, /\d/u);
  // Late: warned, with when it last paid where that's known.
  const late = line({ lastPayout: paid(185 * MINUTE), paying: "late" });
  assert.equal(late.warn, true);
  assert.match(late.text, exactly("3 hours 5 minutes"));
  assert.equal(line({ paying: "late" }).warn, true);
  // Quiet is nobody having used it, not trouble.
  const quiet = line({ lastPayout: paid(12 * 86_400_000), paying: "quiet" });
  assert.equal(quiet.warn, false);
  assert.match(quiet.text, exactly("12 days"));
  assert.match(line({ paying: "quiet", readSince: Date.UTC(2026, 9, 6, 12) }).text, exactly("6 Oct"));
  // Paid when it's claimed: said, and no warning.
  for (const state of ["quiet", "on-claim"]) {
    const said = line({ paying: state });
    assert.equal(said.warn, false, state);
    assert.ok(said.text, state);
  }
});

test("a status it can't read says it doesn't know, never that anything is wrong", () => {
  const unknown = line({ paying: "unknown" });
  assert.equal(unknown.warn, false);
  assert.ok(unknown.text);
  assert.doesNotMatch(unknown.text, /fail|error|problem|wrong|down|sorry/iu);
});

test("a route that isn't running, or that nothing was read of yet, says nothing here", () => {
  assert.equal(line({ paying: "stopped" }), null);
  assert.equal(statusLine(null), null);
});

test("it says how much it can pay where a balance limits that, and warns only where what's sent is more", () => {
  const route = { canPay: 1_234_567_890_123n, lastPayout: paid(5 * MINUTE), limit: "balance", paying: "yes" };
  assert.equal(line(route).warn, false);
  assert.deepEqual(amountsIn(line(route).text), ["1,234.5678 DUSK"]);
  assert.equal(line(route, { amountLux: 1_234_567_890_123n }).warn, false);
  const more = line(route, { amountLux: 1_234_567_890_124n });
  assert.equal(more.warn, true);
  assert.deepEqual(amountsIn(more.text), ["1,234.5678 DUSK"]);
  // What's paid is minted as it's paid: no balance says how much it can pay.
  assert.deepEqual(amountsIn(line({ ...route, canPay: null, limit: "mints" }).text), []);
  for (const paying of ["on-claim", "unknown", "yes"]) assert.deepEqual(amountsIn(line({ canPay: 5_000_000_000n, limit: "balance", paying }).text), ["5 DUSK"], paying);
});

test("a route is read once as its card opens, and again once what was read is old", async () => {
  let now = NOW;
  const reads = [];
  let changes = 0;
  const answer = { canPay: null, lastPayout: null, limit: "mints", paying: "yes" };
  const status = createRouteStatus({
    now: () => now,
    onChange: () => {
      changes += 1;
    },
    read: async (route) => {
      reads.push(route.id);
      return answer;
    },
  });
  const route = { id: "dusk-to-bsc" };
  assert.equal(status.get(route), null);
  status.open(route);
  status.open(route);
  status.open({ id: "bsc-to-dusk", paused: true });
  await new Promise(setImmediate);
  assert.deepEqual(reads, ["dusk-to-bsc"]);
  assert.equal(status.get(route), answer);
  assert.equal(changes, 1);
  now += 9 * MINUTE;
  status.open(route);
  assert.deepEqual(reads, ["dusk-to-bsc"]);
  now += 2 * MINUTE;
  status.open(route);
  assert.deepEqual(reads, ["dusk-to-bsc", "dusk-to-bsc"]);
});

test("a read that fails outright reads as not knowing, and leaves the page as it was", async () => {
  const status = createRouteStatus({ read: async () => Promise.reject(new TypeError("That route isn't one of the network's")) });
  const route = { id: "gone" };
  status.open(route);
  await new Promise(setImmediate);
  assert.deepEqual(statusLine(status.get(route)), line({ paying: "unknown" }));
});

test("what a route's read found is kept, so the page asks the chains again only once it's old", async () => {
  const stored = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => stored.get(key) ?? null, removeItem: (key) => stored.delete(key), setItem: (key, value) => stored.set(key, value) } });
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "mainnet" };
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    // JSON-RPC to the chain; anything else is the Dusk node's archive.
    const method = String(body).startsWith("{") ? JSON.parse(body).method : undefined;
    asked.push(method ?? String(url));
    if (method === "eth_blockNumber") return Response.json({ id: 1, result: "0x100" });
    if (method === "eth_getLogs") return Response.json({ id: 1, result: [] });
    if (method === "eth_getBalance") return Response.json({ id: 1, result: "0x1" });
    if (method === "eth_getBlockByNumber") return Response.json({ id: 1, result: { timestamp: "0x1" } });
    return Response.json({ data: { pair: { json: { last_finalized_block: [100, ""] } }, w0: { json: [] }, w1: { json: [] }, w2: { json: [] } } });
  };
  const { createServices } = await import("./services.js");
  const { loadConfig } = await import("./config.js");
  const { buildRoutes } = await import("./bridge-routes.js");
  const cfg = loadConfig();
  delete globalThis.__DUSK_BRIDGE_CONFIG__;
  const services = createServices(cfg);
  const route = buildRoutes(cfg).find((each) => each.id === "dusk-to-bsc");
  assert.equal(cfg.network.routes.services[0].payoutAddress, networks.mainnet.routes.services[0].payoutAddress);

  const first = await services.status(route);
  assert.ok(asked.includes("eth_getLogs"), asked.join());
  assert.equal(first.error, "");
  assert.equal(first.paying, "quiet");
  // Kept past a reload: another page's read asks nothing.
  const again = await createServices(cfg).status(route);
  assert.equal(again.requests, 0);
  assert.equal(again.paying, "quiet");
  globalThis.fetch = realFetch;
  delete globalThis.localStorage;
});
