import assert from "node:assert/strict";
import test from "node:test";

import { contractGroups } from "./contracts.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { bridgeTasks, linkedRoute, networkName, networkNames, routeTitle, routeUnits, tokenName } from "./names.js";

const DUSKEVM = {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3".repeat(64),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "1".repeat(64),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "2".repeat(64),
};

function profile(name, extra = {}) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: name, ...extra };
  try {
    return loadConfig();
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}

test("each chain has one name per network", () => {
  assert.deepEqual(
    { ...networkNames(profile("mainnet")) },
    { badge: "Mainnet", bsc: "BNB Smart Chain", dusk: "Dusk", "dusk-evm": "DuskEVM", ethereum: "Ethereum" },
  );
  assert.deepEqual(
    { ...networkNames(profile("testnet")) },
    {
      badge: "Testnet",
      bsc: "BNB Smart Chain (testnet)",
      dusk: "Dusk",
      "dusk-evm": "DuskEVM",
      ethereum: "Ethereum (Sepolia)",
    },
  );
});

test("routes and tasks use the same names everywhere", () => {
  const cfg = profile("testnet", DUSKEVM);
  const routes = buildRoutes(cfg);
  const labels = new Set(routes.flatMap((route) => [route.from.label, route.to.label]));
  assert.deepEqual([...labels].sort(), ["Dusk", "DuskEVM", "Ethereum (Sepolia)"]);
  assert.deepEqual(
    routes.map((route) => routeTitle(cfg, route)),
    ["Ethereum (Sepolia) to Dusk", "Dusk to Ethereum (Sepolia)", "Dusk to DuskEVM", "DuskEVM to Dusk"],
  );
  assert.equal(networkName(profile("mainnet"), "dusk-evm"), "DuskEVM");
});

test("the bridge has three routes: BSC both ways, Ethereum one way, and DuskEVM", () => {
  const mainnet = profile("mainnet");
  const routes = buildRoutes(mainnet);
  const tasks = bridgeTasks(mainnet, routes);
  assert.deepEqual(
    tasks.map((task) => [task.id, task.title, task.routes.map((route) => route.id)]),
    [
      ["bsc", "BNB Smart Chain ↔ Dusk", ["bsc-to-dusk", "dusk-to-bsc"]],
      ["ethereum", "Ethereum → Dusk", ["ethereum-to-dusk"]],
    ],
  );
  // DuskEVM, where the network's file has it: testnet.
  const withDuskEvm = profile("testnet", DUSKEVM);
  assert.deepEqual(
    bridgeTasks(withDuskEvm, buildRoutes(withDuskEvm)).map((task) => task.title),
    ["Ethereum (Sepolia) ↔ Dusk", "Dusk ↔ DuskEVM"],
  );
  // A link names a route by its ID, as one of the three routes, or as earlier links did.
  const opens = (name) => linkedRoute(name, tasks, routes)?.id ?? null;
  assert.deepEqual(
    ["bsc", "ethereum", "bsc-to-dusk", "dusk-to-bsc", "migrate", "to-bsc", "to-duskevm", "elsewhere"].map(opens),
    ["bsc-to-dusk", "ethereum-to-dusk", "bsc-to-dusk", "dusk-to-bsc", "ethereum-to-dusk", "dusk-to-bsc", null, null],
  );
});

test("DUSK on an EVM chain is named by its token standard, never old", () => {
  assert.equal(tokenName("bsc"), "BEP20 DUSK");
  assert.equal(tokenName("ethereum"), "ERC20 DUSK");
  // What each side of a route holds: the chain's token, or DUSK on Dusk and DuskEVM.
  const units = (cfg) => buildRoutes(cfg).map((route) => [route.id, routeUnits(route).send, routeUnits(route).receive]);
  assert.deepEqual(units(profile("mainnet")), [
    ["ethereum-to-dusk", "ERC20 DUSK", "DUSK"],
    ["bsc-to-dusk", "BEP20 DUSK", "DUSK"],
    ["dusk-to-bsc", "DUSK", "BEP20 DUSK"],
  ]);
  assert.deepEqual(units(profile("testnet", DUSKEVM)).slice(2), [
    ["dusk-to-dusk-evm", "DUSK", "DUSK"],
    ["dusk-evm-to-dusk", "DUSK", "DUSK"],
  ]);
  for (const cfg of [profile("mainnet"), profile("testnet", DUSKEVM)]) {
    const sheet = JSON.stringify(contractGroups(cfg));
    assert.doesNotMatch(sheet, /\bold\b/iu);
    assert.doesNotMatch(JSON.stringify(bridgeTasks(cfg, buildRoutes(cfg))), /\bold\b/iu);
  }
  const labels = contractGroups(profile("mainnet")).flatMap((group) => group.rows.map((row) => row.label));
  assert.ok(labels.includes("BEP20 DUSK") && labels.includes("ERC20 DUSK"), labels.join(" | "));
});

test("no label says Testnet, L1 or Sepolia on its own", () => {
  for (const cfg of [profile("testnet", DUSKEVM), profile("mainnet")])
    for (const route of buildRoutes(cfg))
      for (const label of [route.from.label, route.to.label]) {
        assert.doesNotMatch(label, /Testnet|L1|^Sepolia/u);
      }
});
