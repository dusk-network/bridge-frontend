import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = {
  VITE_BRIDGE_PROFILE: "testnet",
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
};
const routes = buildRoutes(loadConfig());
delete globalThis.__DUSK_BRIDGE_CONFIG__;

test("the supported routes are unique and cross a Dusk/EVM boundary", () => {
  assert.equal(new Set(routes.map(({ id }) => id)).size, routes.length);
  for (const route of routes) {
    assert.notEqual(route.from.id, route.to.id);
    assert.notEqual(route.from.kind, route.to.kind);
  }
});

test("each route delegates signing to its source wallet", () => {
  for (const route of routes) assert.equal(route.signer, route.from.kind);
});

test("every route moves whole Lux, the precision Dusk holds", () => {
  const modes = new Set(["migration", "service-transfer", "duskevm-deposit", "duskevm-withdrawal"]);
  for (const route of routes) {
    assert.ok(modes.has(route.mode));
    assert.equal(route.amountDecimals, 9);
  }
});

test("routes can be selected by their stable identifier", () => {
  assert.equal(routes.find(({ id }) => id === "dusk-to-ethereum")?.to.id, "ethereum");
  assert.equal(routes.find(({ id }) => id === "unsupported"), undefined);
});
