import assert from "node:assert/strict";
import test from "node:test";

import { cardNetworks, cardRoute, choosePair, defaultPair, entryRoutes, flipRoute, followsWallets, fromChoices, handedOverRecipient, primaryButton, routeBetween, toChoices } from "./bridge-card.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { bridgeTasks, networkName, notRunning } from "./names.js";
import { parseLocation } from "./permalink.js";
import { entryLine, unavailablePage } from "./views.js";

function profile(name, extra = {}) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: name, ...extra };
  try {
    return loadConfig();
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}
const DUSKEVM = {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3b".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "22".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "14".repeat(32),
};
const testnet = profile("testnet", DUSKEVM);
// The same, with the Sepolia routes running again.
const running = profile("testnet", { ...DUSKEVM, VITE_PAUSED_ROUTES: "none" });
const mainnet = profile("mainnet");
const pairs = (routes) => routes.map((route) => `${route.from.id}>${route.to.id}`);

test("the card pairs only the bridge's routes, in both directions where both exist", () => {
  const routes = buildRoutes(running);
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
  assert.ok(fromChoices(buildRoutes(running), "dusk", name).every((choice) => !choice.disabled));
  // Choosing a From whose current To has no route picks its only (first) route.
  const all = buildRoutes(running);
  assert.equal(choosePair(all, { from: "ethereum", to: "dusk-evm" }).id, routeBetween(all, "ethereum", "dusk").id);
  assert.equal(choosePair(all, { from: "dusk", to: "ethereum" }).id, routeBetween(all, "dusk", "ethereum").id);
});

test("the card opens on Dusk to DuskEVM with Dusk Wallet, and on Ethereum to Dusk with only an EVM wallet", () => {
  const routes = buildRoutes(running);
  const opens = (wallets) => pairs([defaultPair(routes, wallets)])[0];
  assert.equal(opens({ dusk: true, evm: true }), "dusk>dusk-evm");
  assert.equal(opens({ dusk: true }), "dusk>dusk-evm");
  assert.equal(opens({ evm: true }), "ethereum>dusk");
  assert.equal(opens({}), "dusk>dusk-evm");
  // Without DuskEVM, Dusk's own route out.
  assert.equal(pairs([defaultPair(buildRoutes(mainnet), { dusk: true })])[0], "dusk>bsc");
});

test("the button says what's missing, then Review bridge", () => {
  const routes = buildRoutes(running);
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
  assert.equal(label({ insufficient: true, route: migration, unit: "ERC20 DUSK" }), "Not enough ERC20 DUSK");
  assert.equal(label({ amountError: "Send more than the 1 DUSK bridge fee." }), "Check the amount");
  assert.equal(label({ destination: "", looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.equal(label({ destination: "", destinationError: "That isn't an EVM address" }), "Fix the recipient");
  assert.equal(label({ destination: "" }), "Add a recipient");
  // No wallet to pay and none typed: the way to one, where a narrow page has no header button.
  assert.deepEqual(primaryButton({ ...ready, connectsRecipient: true, destination: "" }), {
    action: "connect-evm",
    enabled: true,
    label: "Connect EVM wallet",
  });
  assert.deepEqual(primaryButton(ready), { action: "review", enabled: true, label: "Review bridge" });
  assert.equal(primaryButton({ ...ready, amountLux: null }).enabled, false);
});

test("a wallet on another chain than its route's is offered the switch, before anything else it can do", () => {
  const route = routeBetween(buildRoutes(running), "ethereum", "dusk");
  const ready = { amountLux: 1_000_000_000n, destination: "x", route, signerConnected: true, switchTo: "Sepolia" };
  assert.deepEqual(primaryButton(ready), { action: "switch-chain", enabled: true, label: "Switch to Sepolia" });
  assert.deepEqual(primaryButton({ ...ready, amountLux: null }), { action: "switch-chain", enabled: true, label: "Switch to Sepolia" });
  // Asked: pressing again would only ask again.
  assert.deepEqual(primaryButton({ ...ready, switching: true }), { action: null, enabled: false, label: "Switching to Sepolia…" });
  // Without the wallet, or on a route that isn't running, there's nothing to switch.
  assert.equal(primaryButton({ ...ready, signerConnected: false }).action, "connect-evm");
  assert.equal(primaryButton({ ...ready, route: { ...route, paused: true } }).action, null);
});

test("a link to a task this network doesn't have opens no route, never another transfer", () => {
  const routes = buildRoutes(mainnet);
  const tasks = bridgeTasks(mainnet, routes);
  // DuskEVM isn't on mainnet: its link doesn't open the Dusk to BSC transfer the card opens on.
  assert.equal(cardRoute({ page: "move", task: "to-duskevm" }, tasks, routes, { dusk: true }), null);
  assert.equal(cardRoute({ page: "move", task: "nothing-here" }, tasks, routes, {}), null);
  assert.equal(cardRoute({ page: "move", task: "migrate" }, tasks, routes, { dusk: true }).id, "ethereum-to-dusk");
  assert.equal(cardRoute({ page: "home" }, tasks, routes, { dusk: true }).id, "dusk-to-bsc");
  assert.match(unavailablePage({ title: "DuskEVM isn't on Mainnet yet" }), /<h1>DuskEVM isn&#039;t on Mainnet yet<\/h1><p class="links-row"><a class="lnk" href="#\/">Back to the bridge<\/a>/u);
});

test("the card stops following the wallets once a recipient is typed, as once an amount or a pair is", () => {
  const fresh = { amount: "", pairChosen: false, recipientInput: "" };
  assert.equal(followsWallets(fresh), true);
  assert.equal(followsWallets({ ...fresh, recipientInput: "0x75685f9d88749b583732b40d56fe007cd404b72d" }), false);
  assert.equal(followsWallets({ ...fresh, amount: "1" }), false);
  assert.equal(followsWallets({ ...fresh, pairChosen: true }), false);
  assert.equal(followsWallets(null), false);
});

test("the testnet Sepolia routes are listed but not running, behind one switch", () => {
  const routes = buildRoutes(testnet);
  assert.deepEqual(routes.filter((route) => route.paused).map((route) => route.id), ["ethereum-to-dusk", "dusk-to-ethereum"]);
  const name = (id) => networkName(testnet, id);
  const why = notRunning(testnet);
  assert.equal(why, "Not running on testnet right now");
  // In the card's lists, disabled, saying why.
  assert.deepEqual(fromChoices(routes, "dusk", name, why).find((choice) => choice.id === "ethereum"), { disabled: why, id: "ethereum" });
  assert.deepEqual(toChoices(routes, "dusk", "dusk-evm", name, why).find((choice) => choice.id === "ethereum"), { disabled: why, id: "ethereum" });
  // Never opened by itself, and not offered under the card.
  assert.equal(pairs([defaultPair(routes, { evm: true })])[0], "dusk>dusk-evm");
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "dusk", "dusk-evm")), []);
  // A link to one opens it, and it sends nothing.
  const sepolia = cardRoute(parseLocation("#/move/migrate"), bridgeTasks(testnet, routes), routes);
  assert.equal(sepolia.id, "ethereum-to-dusk");
  assert.deepEqual(primaryButton({ amountLux: 1n, destination: "x", duskInstalled: true, route: sepolia, signerConnected: true }), { action: null, enabled: false, label: "Not running right now" });
  // On its own page the network stays chosen, not disabled.
  assert.deepEqual(fromChoices(routes, "ethereum", name, why).find((choice) => choice.id === "ethereum"), { id: "ethereum", selected: true });
  // The flip, the pair a From picks, and a link to a route with a running
  // direction never land on a paused one.
  assert.equal(flipRoute(routes, routeBetween(routes, "dusk", "dusk-evm")).id, "dusk-evm-to-dusk");
  const bscPaused = buildRoutes(profile("mainnet", { VITE_PAUSED_ROUTES: "bsc-to-dusk" }));
  assert.equal(flipRoute(bscPaused, routeBetween(bscPaused, "dusk", "bsc")), null);
  assert.equal(choosePair(bscPaused, { from: "bsc", to: "dusk" }).id, "bsc-to-dusk");
  assert.equal(cardRoute(parseLocation("#/move/bsc"), bridgeTasks(mainnet, bscPaused), bscPaused).id, "dusk-to-bsc");
  const ethPaused = buildRoutes(profile("mainnet", { VITE_PAUSED_ROUTES: "ethereum-to-dusk" }));
  assert.equal(choosePair(ethPaused, { from: "ethereum", to: "dusk" }).id, "ethereum-to-dusk");
  // One switch runs them again; mainnet's all run.
  assert.ok(buildRoutes(running).every((route) => !route.paused));
  assert.ok(buildRoutes(mainnet).every((route) => !route.paused));
});

test("under the card, DUSK on Ethereum or BNB Smart Chain is one link from moving to Dusk", () => {
  const routes = buildRoutes(mainnet);
  const out = routeBetween(routes, "dusk", "bsc");
  assert.deepEqual(entryRoutes(routes, out).map((route) => route.id), ["ethereum-to-dusk", "bsc-to-dusk"]);
  // Not while the card is on one of them.
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "bsc", "dusk")), []);
  const line = entryLine(entryRoutes(routes, out).map((route) => ({ href: `#/move/${route.id}`, name: networkName(mainnet, route.from.id) })));
  assert.equal(
    line,
    '<p class="entry">Have DUSK on <a href="#/move/ethereum-to-dusk" aria-label="Move DUSK from Ethereum to Dusk">Ethereum</a> or <a href="#/move/bsc-to-dusk" aria-label="Move DUSK from BNB Smart Chain to Dusk">BNB Smart Chain</a>? Move it to Dusk.</p>',
  );
  assert.doesNotMatch(line, /\bold\b/iu);
  // Each link sets From: it opens that route.
  assert.equal(cardRoute(parseLocation("#/move/bsc-to-dusk"), bridgeTasks(mainnet, routes), routes).id, "bsc-to-dusk");
  assert.equal(entryLine([]), "");
});

test("a recipient handed over in the link is taken only by a route that pays a Dusk account", () => {
  const routes = buildRoutes(testnet);
  const page = parseLocation("#/move/from-duskevm?to=21n5nc");
  const takes = (from, to) => handedOverRecipient(page, routeBetween(routes, from, to));
  assert.equal(takes("dusk-evm", "dusk"), "21n5nc");
  assert.equal(takes("ethereum", "dusk"), "21n5nc");
  // An EVM address is paid on the other routes: a Dusk account there is no recipient.
  assert.equal(takes("dusk", "dusk-evm"), "");
  assert.equal(takes("dusk", "ethereum"), "");
  assert.equal(handedOverRecipient(parseLocation("#/move/from-duskevm"), routeBetween(routes, "dusk-evm", "dusk")), "");
  assert.equal(handedOverRecipient({ page: "home", to: "21n5nc" }, routeBetween(routes, "dusk-evm", "dusk")), "");
});
