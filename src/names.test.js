import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { bridgeTasks, networkName, networkNames, routeTitle } from "./names.js";

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
  assert.deepEqual(
    bridgeTasks(cfg, routes).map((task) => [task.id, task.title]),
    [
      ["migrate", "Move old DUSK to Dusk"],
      ["to-duskevm", "Move DUSK to DuskEVM"],
      ["from-duskevm", "Move DUSK from DuskEVM to Dusk"],
      ["to-ethereum", "Send DUSK to Ethereum (Sepolia)"],
    ],
  );
  const mainnet = profile("mainnet");
  const tasks = bridgeTasks(mainnet, buildRoutes(mainnet));
  assert.deepEqual(tasks.map((task) => task.title), ["Move old DUSK to Dusk", "Send DUSK to BNB Smart Chain"]);
  assert.equal(tasks[0].what, "You hold DUSK as a token on Ethereum or BNB Smart Chain");
  assert.equal(networkName(mainnet, "dusk-evm"), "DuskEVM");
});

test("no label says Testnet, L1 or Sepolia on its own", () => {
  for (const cfg of [profile("testnet", DUSKEVM), profile("mainnet")])
    for (const route of buildRoutes(cfg))
      for (const label of [route.from.label, route.to.label]) {
        assert.doesNotMatch(label, /Testnet|L1|^Sepolia/u);
      }
});
