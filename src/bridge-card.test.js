import assert from "node:assert/strict";
import test from "node:test";

import { cardNetworks, choosePair, defaultPair, flipRoute, fromChoices, primaryButton, routeBetween, toChoices } from "./bridge-card.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { networkName } from "./names.js";

function profile(name, extra = {}) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: name, ...extra };
  try {
    return loadConfig();
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}
const testnet = profile("testnet", {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3b".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "22".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "14".repeat(32),
});
const mainnet = profile("mainnet");
const pairs = (routes) => routes.map((route) => `${route.from.id}>${route.to.id}`);

test("the card pairs only the bridge's routes, in both directions where both exist", () => {
  const routes = buildRoutes(testnet);
  assert.deepEqual(pairs(routes).sort(), ["dusk-evm>dusk", "dusk>dusk-evm", "dusk>ethereum", "ethereum>dusk"]);
  assert.deepEqual(cardNetworks(routes), ["ethereum", "dusk", "dusk-evm"]);
  const main = buildRoutes(mainnet);
  assert.deepEqual(pairs(main).sort(), ["bsc>dusk", "dusk>bsc", "ethereum>dusk"]);
  assert.deepEqual(cardNetworks(main), ["ethereum", "bsc", "dusk"]);

  // The flip swaps where a way back exists, and only then.
  const flip = (cfgRoutes, from, to) => flipRoute(cfgRoutes, routeBetween(cfgRoutes, from, to));
  assert.equal(flip(routes, "dusk", "dusk-evm").id, routeBetween(routes, "dusk-evm", "dusk").id);
  assert.equal(flip(routes, "ethereum", "dusk").id, routeBetween(routes, "dusk", "ethereum").id);
  assert.equal(flip(main, "ethereum", "dusk"), null);
  assert.equal(flip(main, "bsc", "dusk").id, routeBetween(main, "dusk", "bsc").id);
});

test("a network without a route from the chosen one is offered disabled, saying why", () => {
  const routes = buildRoutes(testnet);
  const name = (id) => networkName(testnet, id);
  assert.deepEqual(
    toChoices(routes, "dusk-evm", "dusk", name).map(({ disabled = "", id, selected = false }) => [id, disabled, selected]),
    [
      ["ethereum", "No route from DuskEVM", false],
      ["dusk", "", true],
      ["dusk-evm", "It's where it comes from", false],
    ],
  );
  assert.ok(fromChoices(routes, "dusk", name).every((choice) => !choice.disabled));
  // Choosing a From whose current To has no route picks its only (first) route.
  assert.equal(choosePair(routes, { from: "ethereum", to: "dusk-evm" }).id, routeBetween(routes, "ethereum", "dusk").id);
  assert.equal(choosePair(routes, { from: "dusk", to: "ethereum" }).id, routeBetween(routes, "dusk", "ethereum").id);
});

test("the card opens on Dusk to DuskEVM with Dusk Wallet, and on Ethereum to Dusk with only an EVM wallet", () => {
  const routes = buildRoutes(testnet);
  const opens = (wallets) => pairs([defaultPair(routes, wallets)])[0];
  assert.equal(opens({ dusk: true, evm: true }), "dusk>dusk-evm");
  assert.equal(opens({ dusk: true }), "dusk>dusk-evm");
  assert.equal(opens({ evm: true }), "ethereum>dusk");
  assert.equal(opens({}), "dusk>dusk-evm");
  // Without DuskEVM, Dusk's own route out.
  assert.equal(pairs([defaultPair(buildRoutes(mainnet), { dusk: true })])[0], "dusk>bsc");
});

test("the button says what's missing, then Review bridge", () => {
  const routes = buildRoutes(testnet);
  const deposit = routeBetween(routes, "dusk", "dusk-evm");
  const migration = routeBetween(routes, "ethereum", "dusk");
  const ready = { amountLux: 25_000_000_000n, destination: "0x1", duskInstalled: true, route: deposit, signerConnected: true };
  const label = (patch) => primaryButton({ ...ready, ...patch }).label;
  assert.equal(label({ signerConnected: false }), "Connect Dusk Wallet");
  assert.equal(label({ duskInstalled: false, signerConnected: false }), "Get Dusk Wallet");
  assert.equal(label({ duskInstalled: false, phoneOnly: true, signerConnected: false }), "Send from a computer");
  assert.equal(label({ route: migration, signerConnected: false }), "Connect EVM wallet");
  assert.equal(label({ amountLux: null }), "Enter an amount");
  assert.equal(label({ amountError: "Use a point for decimals, like 0.5.", amountLux: null }), "Enter a valid amount");
  assert.equal(label({ amountError: "That's more than you have", insufficient: true }), "Not enough DUSK");
  assert.equal(label({ insufficient: true, route: migration, unit: "old DUSK" }), "Not enough old DUSK");
  assert.equal(label({ amountError: "Send more than the 1 DUSK bridge fee." }), "Check the amount");
  assert.equal(label({ destination: "", looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.equal(label({ destination: "", destinationError: "That isn't an EVM address" }), "Fix the recipient");
  assert.equal(label({ destination: "" }), "Add a recipient");
  assert.deepEqual(primaryButton(ready), { action: "review", enabled: true, label: "Review bridge" });
  assert.equal(primaryButton({ ...ready, amountLux: null }).enabled, false);
});
