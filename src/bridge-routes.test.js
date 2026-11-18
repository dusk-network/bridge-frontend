import assert from "node:assert/strict";
import test from "node:test";

import { networks, routes as networkRoutes } from "@dusk-network/networks";

import { buildRoutes, deployedNetwork } from "./bridge-routes.js";
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

test("every route of DUSK moves whole Lux, the precision Dusk holds, and Hyperlane's tokens their own decimals", () => {
  const modes = new Set(["migration", "service-transfer", "duskevm-deposit", "duskevm-withdrawal", "hyperlane"]);
  for (const route of routes) {
    assert.ok(modes.has(route.mode));
    assert.equal(route.amountDecimals, route.token.decimals);
    if (route.token.symbol === "DUSK") assert.equal(route.amountDecimals, 9);
  }
  assert.deepEqual(
    routes.filter((route) => route.mode === "hyperlane").map((route) => [route.id, route.token.symbol, route.amountDecimals, route.signer]),
    [
      ["dusk-to-sepolia", "DUSK", 9, "dusk"],
      ["sepolia-to-dusk", "DUSK", 9, "evm"],
      ["dusk-to-sepolia-eurd", "EURd", 6, "dusk"],
      ["sepolia-to-dusk-eurd", "EURd", 6, "evm"],
      ["dusk-to-sepolia-usdd", "USDd", 6, "dusk"],
      ["sepolia-to-dusk-usdd", "USDd", 6, "evm"],
    ],
  );
});

test("routes can be selected by their stable identifier", () => {
  assert.equal(routes.find(({ id }) => id === "dusk-to-ethereum")?.to.id, "ethereum");
  assert.equal(routes.find(({ id }) => id === "unsupported"), undefined);
});

test("the network's routes run as this deployment says, for what's read about them", () => {
  const all = networkRoutes(deployedNetwork({ network: networks.testnet, pausedRoutes: [] }));
  assert.ok(all.length > 0 && all.every((route) => route.running));
  const [first] = all;
  const stopped = networkRoutes(deployedNetwork({ network: networks.testnet, pausedRoutes: [first.id] }));
  assert.equal(stopped.find((route) => route.id === first.id).running, false);
  assert.ok(stopped.filter((route) => route.id !== first.id).every((route) => route.running));
});

