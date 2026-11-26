import assert from "node:assert/strict";
import test from "node:test";

import { assetChoices, cardRoute, choosePair, defaultPair, entryRoutes, flipRoute, followsWallets, handedOverRecipient, primaryButton, routeBetween, tokenOf } from "./bridge-card.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { bridgeTasks, networkName } from "./names.js";
import { parseLocation } from "./permalink.js";
import { entryLine } from "./views.js";

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
// Testnet without Hyperlane's routes: Sepolia's own are all it has.
const withoutHyperlane = profile("testnet", { ...DUSKEVM, VITE_HYPERLANE_TOKENS: "none" });
const mainnet = profile("mainnet");
const pairs = (routes) => routes.map((route) => `${route.from.id}>${route.to.id}`);
// What pressing the card's button does, and whether it can be pressed.
const press = (state) => (({ action, enabled }) => [action, enabled])(primaryButton(state));

test("the card pairs only the bridge's routes, in both directions where both exist", () => {
  const routes = buildRoutes(running);
  assert.deepEqual([...new Set(pairs(routes))].sort(), ["dusk-evm>dusk", "dusk>dusk-evm", "dusk>ethereum", "ethereum>dusk"]);
  const main = buildRoutes(mainnet);
  assert.deepEqual(pairs(main).sort(), ["bsc>dusk", "dusk>bsc", "ethereum>dusk"]);

  // The flip swaps where a way back exists, and only then.
  const flip = (cfgRoutes, from, to) => flipRoute(cfgRoutes, routeBetween(cfgRoutes, from, to));
  assert.equal(flip(routes, "dusk", "dusk-evm").id, routeBetween(routes, "dusk-evm", "dusk").id);
  assert.equal(flip(routes, "ethereum", "dusk").id, routeBetween(routes, "dusk", "ethereum").id);
  assert.equal(flip(main, "ethereum", "dusk"), null);
  assert.equal(flip(main, "bsc", "dusk").id, routeBetween(main, "dusk", "bsc").id);
});

test("the picker lists DUSK once and offers the networks for each side", () => {
  const routes = buildRoutes(mainnet);
  const current = routeBetween(routes, "dusk", "bsc");
  const assets = assetChoices(routes, current, "from");
  assert.deepEqual(assets.map(({ symbol, selected }) => [symbol, selected]), [["DUSK", true]]);
  assert.deepEqual(
    assets[0].networks.map(({ id, network, note, selected }) => [id, network, note, selected]),
    [
      ["ethereum-to-dusk", "ethereum", "ERC20 DUSK", false],
      ["bsc-to-dusk", "bsc", "BEP20 DUSK", false],
      ["dusk-to-bsc", "dusk", "", true],
    ],
  );
  assert.deepEqual(assetChoices(routes, current, "to")[0].networks, [
    { disabled: false, id: "dusk-to-bsc", network: "bsc", note: "BEP20 DUSK", selected: true },
  ]);
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

test("the button opens the review only once nothing is missing, and does what's needed first", () => {
  const routes = buildRoutes(running);
  const deposit = routeBetween(routes, "dusk", "dusk-evm");
  const migration = routeBetween(routes, "ethereum", "dusk");
  const ready = { amountLux: 25_000_000_000n, destination: "0x1", duskInstalled: true, route: deposit, signerConnected: true };
  const pressed = (patch) => press({ ...ready, ...patch });
  // The wallet that signs: connected, got, or nothing from a phone.
  assert.deepEqual(pressed({ signerConnected: false }), ["connect-dusk", true]);
  assert.deepEqual(pressed({ duskInstalled: false, signerConnected: false }), ["get-dusk", true]);
  assert.deepEqual(pressed({ duskInstalled: false, phoneOnly: true, signerConnected: false }), [null, false]);
  assert.deepEqual(pressed({ route: migration, signerConnected: false }), ["connect-evm", true]);
  // An amount that's missing, unreadable, more than there is or under the bridge fee, a recipient being looked up, wrong or missing: nothing to press.
  const missing = [
    { amountLux: null },
    { amountError: "Use a point for decimals, like 0.5.", amountLux: null },
    { amountError: "That's more than you have", insufficient: true },
    { insufficient: true, route: migration, unit: "ERC20 DUSK" },
    { amountError: "Send more than the 1 DUSK bridge fee." },
    { destination: "", looking: "alice.dusk" },
    { destination: "", destinationError: "That isn't an EVM address" },
    { destination: "" },
  ];
  missing.forEach((patch, index) => assert.deepEqual(pressed(patch), [null, false], `case ${index}`));
  // Short of a token, the button names it.
  assert.match(primaryButton({ ...ready, insufficient: true, route: migration, unit: "ERC20 DUSK" }).label, /ERC20 DUSK/u);
  // A route's approval not read yet: nothing to review until it is, or a way to read it again.
  assert.deepEqual(pressed({ waiting: "reading" }), [null, false]);
  assert.deepEqual(pressed({ waiting: "failed" }), ["read-again", true]);
  // A withdrawal's fee not worked out for its call yet: nothing to review until it is, or a way to work it out again.
  assert.deepEqual(pressed({ waiting: "fee" }), [null, false]);
  assert.deepEqual(pressed({ waiting: "fee-failed" }), ["read-again", true]);
  // It's worked out for a recipient: one missing, wrong or being looked up comes first.
  for (const patch of [{ destination: "" }, { destination: "", destinationError: "That isn't a Dusk account" }, { destination: "", looking: "alice.dusk" }, { connectsRecipient: true, destination: "" }])
    assert.deepEqual(primaryButton({ ...ready, ...patch, waiting: "fee" }), primaryButton({ ...ready, ...patch }));
  // No wallet to pay and none typed: the way to one, where a narrow page has no header button.
  assert.deepEqual(pressed({ connectsRecipient: true, destination: "" }), ["connect-evm", true]);
  assert.deepEqual(pressed({}), ["review", true]);
});

test("a wallet on another chain than its route's is offered the switch, before anything else it can do", () => {
  const route = routeBetween(buildRoutes(running), "ethereum", "dusk");
  const ready = { amountLux: 1_000_000_000n, destination: "x", route, signerConnected: true, switchTo: "Sepolia" };
  assert.deepEqual(press(ready), ["switch-chain", true]);
  assert.match(primaryButton(ready).label, /Sepolia/u);
  assert.deepEqual(press({ ...ready, amountLux: null }), ["switch-chain", true]);
  // Asked: pressing again would only ask again.
  assert.deepEqual(press({ ...ready, switching: true }), [null, false]);
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
  const routes = buildRoutes(withoutHyperlane);
  assert.deepEqual(routes.filter((route) => route.paused).map((route) => route.id), ["ethereum-to-dusk", "dusk-to-ethereum"]);
  const current = routeBetween(routes, "dusk", "dusk-evm");
  const sepoliaChoice = (route, side) => assetChoices(routes, route, side)[0].networks.find((choice) => choice.network === "ethereum");
  assert.deepEqual(sepoliaChoice(current, "from"), { disabled: true, id: "ethereum-to-dusk", network: "ethereum", note: "ERC20 DUSK", selected: false });
  assert.deepEqual(sepoliaChoice(current, "to"), { disabled: true, id: "dusk-to-ethereum", network: "ethereum", note: "ERC20 DUSK", selected: false });
  // Never opened by itself, and not offered under the card.
  assert.equal(pairs([defaultPair(routes, { evm: true })])[0], "dusk>dusk-evm");
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "dusk", "dusk-evm")), []);
  // A link to one opens it, and it sends nothing.
  const sepolia = cardRoute(parseLocation("#/move/migrate"), bridgeTasks(withoutHyperlane, routes), routes);
  assert.equal(sepolia.id, "ethereum-to-dusk");
  assert.deepEqual(press({ amountLux: 1n, destination: "x", duskInstalled: true, route: sepolia, signerConnected: true }), [null, false]);
  // On its own page the network stays chosen, not disabled.
  assert.deepEqual(sepoliaChoice(sepolia, "from"), { disabled: false, id: "ethereum-to-dusk", network: "ethereum", note: "ERC20 DUSK", selected: true });
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
  assert.deepEqual(buildRoutes(testnet).filter((route) => route.paused).map((route) => route.id), ["ethereum-to-dusk", "dusk-to-ethereum"]);
  assert.ok(buildRoutes(mainnet).every((route) => !route.paused));
});

test("under the card, DUSK on Ethereum or BNB Smart Chain is one link from moving to Dusk", () => {
  const routes = buildRoutes(mainnet);
  const out = routeBetween(routes, "dusk", "bsc");
  assert.deepEqual(entryRoutes(routes, out).map((route) => route.id), ["ethereum-to-dusk", "bsc-to-dusk"]);
  // Not while the card is on one of them.
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "bsc", "dusk")), []);
  const line = entryLine(entryRoutes(routes, out).map((route) => ({ href: `#/move/${route.id}`, name: networkName(mainnet, route.from.id) })));
  assert.deepEqual([...line.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]), ["#/move/ethereum-to-dusk", "#/move/bsc-to-dusk"]);
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

test("Hyperlane's routes run Sepolia ↔ Dusk on testnet, one per token, beside Sepolia's paused ones", () => {
  const routes = buildRoutes(testnet);
  const current = routeBetween(routes, "dusk", "dusk-evm");
  // Sepolia is offered again, both ways: its routes run through Hyperlane.
  const sepolia = (side) => assetChoices(routes, current, side)[0].networks.filter((choice) => choice.network === "ethereum" && !choice.disabled);
  assert.deepEqual(sepolia("from").map(({ id }) => id), ["sepolia-to-dusk"]);
  assert.deepEqual(sepolia("to").map(({ id }) => id), ["dusk-to-sepolia"]);
  // A pair's route is the running one, of the token asked for where it moves it.
  assert.equal(routeBetween(routes, "dusk", "ethereum").id, "dusk-to-sepolia");
  assert.equal(routeBetween(routes, "dusk", "ethereum", "hyperlane-eurd").id, "dusk-to-sepolia-eurd");
  assert.equal(routeBetween(routes, "dusk", "dusk-evm", "hyperlane-eurd").id, "dusk-to-dusk-evm");
  // The flip keeps the token; a From keeps it where it can.
  assert.equal(flipRoute(routes, routeBetween(routes, "dusk", "ethereum", "hyperlane-usdd")).id, "sepolia-to-dusk-usdd");
  assert.equal(choosePair(routes, { from: "ethereum", to: "dusk-evm", token: "hyperlane-eurd" }).id, "sepolia-to-dusk-eurd");
  assert.equal(choosePair(routes, { from: "dusk", to: "ethereum", token: "hyperlane-eurd" }).id, "dusk-to-sepolia-eurd");
  // With only an EVM wallet, the card opens on the way into Dusk that runs.
  assert.equal(defaultPair(routes, { evm: true }).id, "sepolia-to-dusk");
  // A link to the chain, or to a token's route, opens a running one.
  const tasks = bridgeTasks(testnet, routes);
  assert.equal(cardRoute(parseLocation("#/move/ethereum"), tasks, routes).id, "sepolia-to-dusk");
  assert.equal(cardRoute(parseLocation("#/move/dusk-to-sepolia-usdd"), tasks, routes).id, "dusk-to-sepolia-usdd");
  // Still not offered under the card: that's for DUSK migrating in.
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "dusk", "ethereum")), []);
});

test("the destination picker offers the assets available from the existing source", () => {
  const routes = buildRoutes(testnet);
  const current = routeBetween(routes, "dusk", "ethereum", "hyperlane-eurd");
  const choices = (all, route) => assetChoices(all, route, "to").map(({ name, selected, symbol }) => [symbol, name, selected]);
  assert.deepEqual(choices(routes, current), [
    ["DUSK", "Dusk", false],
    ["EURd", "Dusk Euro (testnet)", true],
    ["USDd", "Dusk Dollar (testnet)", false],
  ]);
  assert.deepEqual(choices(routes, routeBetween(routes, "dusk-evm", "dusk")), [["DUSK", "Dusk", true]]);
  // A token paused by the deployment isn't offered.
  const paused = buildRoutes(profile("testnet", { ...DUSKEVM, VITE_PAUSED_ROUTES: "dusk-to-sepolia-usdd,ethereum-to-dusk,dusk-to-ethereum" }));
  assert.deepEqual(choices(paused, current).map(([symbol]) => symbol), ["DUSK", "EURd"]);
  assert.deepEqual(choices(paused, paused.find(({ id }) => id === "dusk-to-sepolia-usdd")).map(([symbol, , selected]) => [symbol, selected]), [
    ["DUSK", false], ["EURd", false], ["USDd", true],
  ]);
});

test("a pair's running route is preferred to a paused one of the token asked for", () => {
  // Hyperlane's EURd alone, beside Sepolia's paused DUSK routes: from a card on DUSK, the pair still runs.
  const eurdOnly = buildRoutes(profile("testnet", { ...DUSKEVM, VITE_HYPERLANE_TOKENS: "eurd" }));
  const deposit = routeBetween(eurdOnly, "dusk", "dusk-evm");
  assert.equal(routeBetween(eurdOnly, "dusk", "ethereum", tokenOf(deposit)).id, "dusk-to-sepolia-eurd");
  // In the picker, choosing an asset limits the network options to that asset.
  const assets = assetChoices(eurdOnly, deposit, "to");
  assert.deepEqual(assets.map(({ symbol, networks }) => [symbol, networks.find(({ network }) => network === "ethereum").disabled]), [["DUSK", true], ["EURd", false]]);
  // With nothing running there, the paused route of the token, as before.
  const legacy = buildRoutes(withoutHyperlane);
  assert.equal(routeBetween(legacy, "dusk", "ethereum", tokenOf(routeBetween(legacy, "dusk", "dusk-evm"))).id, "dusk-to-ethereum");
});

test("the picker distinguishes Sepolia's original and Hyperlane DUSK routes on the same network", () => {
  const all = buildRoutes(running);
  const hyperlaneDusk = all.find((route) => route.id === "dusk-to-sepolia");
  const networks = (route, side, network) => assetChoices(all, route, side)[0].networks
    .filter((choice) => choice.network === network)
    .map(({ id, note, selected }) => [id, note, selected]);
  // Both send DUSK from Dusk: each says what arrives.
  assert.deepEqual(networks(hyperlaneDusk, "from", "dusk"), [
    ["dusk-to-ethereum", "Arrives as ERC20 DUSK", false], ["dusk-to-sepolia", "Arrives as DUSK", true],
  ]);
  assert.deepEqual(networks(hyperlaneDusk, "to", "ethereum"), [
    ["dusk-to-ethereum", "ERC20 DUSK", false], ["dusk-to-sepolia", "DUSK", true],
  ]);
  // Back from Sepolia, a Hyperlane DUSK transfer goes back through Hyperlane, not the migration.
  assert.equal(flipRoute(all, hyperlaneDusk).id, "sepolia-to-dusk");
  assert.equal(flipRoute(all, all.find((route) => route.id === "dusk-to-ethereum")).id, "ethereum-to-dusk");
  // From Sepolia they send different tokens: ERC20 DUSK to migrate, Hyperlane's DUSK to bring back.
  const fromSepolia = all.find((route) => route.id === "sepolia-to-dusk");
  assert.deepEqual(networks(fromSepolia, "from", "ethereum"), [
    ["ethereum-to-dusk", "ERC20 DUSK", false], ["sepolia-to-dusk", "DUSK", true],
  ]);
  assert.deepEqual(networks(fromSepolia, "to", "dusk"), [
    ["ethereum-to-dusk", "Sends ERC20 DUSK", false], ["sepolia-to-dusk", "Sends DUSK", true],
  ]);
});
