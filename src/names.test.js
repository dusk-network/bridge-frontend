import assert from "node:assert/strict";
import test from "node:test";

import { contractGroups } from "./contracts.js";
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
  // The old token has one name, as a token, wherever it's named.
  assert.equal(tasks[0].what, "You hold old DUSK (ERC20 on Ethereum) or old DUSK (BEP20 on BSC)");
  assert.equal(tasks[1].what, "Paid out as old DUSK (BEP20 on BSC)");
  assert.equal(bridgeTasks(cfg, routes)[3].what, "Paid out as old DUSK (ERC20 on Sepolia)");
  const sheet = contractGroups(cfg).flatMap((group) => group.rows.map((row) => row.label));
  assert.ok(sheet.filter((label) => label === "Old DUSK (ERC20 on Sepolia)").length === 2, sheet.join(" | "));
  assert.ok(!sheet.some((label) => /DUSK token/u.test(label)));
  assert.equal(networkName(mainnet, "dusk-evm"), "DuskEVM");
});

test("no label says Testnet, L1 or Sepolia on its own", () => {
  for (const cfg of [profile("testnet", DUSKEVM), profile("mainnet")])
    for (const route of buildRoutes(cfg))
      for (const label of [route.from.label, route.to.label]) {
        assert.doesNotMatch(label, /Testnet|L1|^Sepolia/u);
      }
});
