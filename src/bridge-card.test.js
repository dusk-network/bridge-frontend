import assert from "node:assert/strict";
import test from "node:test";

import { cardNetworks, cardRoute, choosePair, defaultPair, entryRoutes, flipRoute, followsWallets, fromChoices, handedOverRecipient, primaryButton, routeBetween, toChoices, tokenChoices, tokenOf } from "./bridge-card.js";
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
// Testnet without Hyperlane's routes: Sepolia's own are all it has.
const withoutHyperlane = profile("testnet", { ...DUSKEVM, VITE_HYPERLANE_TOKENS: "none" });
const mainnet = profile("mainnet");
const pairs = (routes) => routes.map((route) => `${route.from.id}>${route.to.id}`);

test("the card pairs only the bridge's routes, in both directions where both exist", () => {
  const routes = buildRoutes(running);
  assert.deepEqual([...new Set(pairs(routes))].sort(), ["dusk-evm>dusk", "dusk>dusk-evm", "dusk>ethereum", "ethereum>dusk"]);
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

test("a network without a route from the chosen one is offered disabled, saying why, and the one it comes from without words", () => {
  const routes = buildRoutes(testnet);
  const name = (id) => networkName(testnet, id);
  assert.deepEqual(
    toChoices(routes, "dusk-evm", "dusk", name).map(({ disabled = "", id, selected = false }) => [id, disabled, selected]),
    [
      ["ethereum", "No route", false],
      ["dusk", "", true],
      ["dusk-evm", true, false],
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

test("the button says what's missing, then Review and what's sent", () => {
  const routes = buildRoutes(running);
  const deposit = routeBetween(routes, "dusk", "dusk-evm");
  const migration = routeBetween(routes, "ethereum", "dusk");
  const ready = { amountLux: 25_000_000_000n, destination: "0x1", duskInstalled: true, route: deposit, signerConnected: true };
  const label = (patch) => primaryButton({ ...ready, ...patch }).label;
  assert.equal(label({ signerConnected: false }), "Connect Dusk Wallet");
  // Connected before and locked since, as the header says it.
  assert.equal(label({ duskLocked: true, signerConnected: false }), "Unlock Dusk Wallet");
  assert.equal(label({ duskInstalled: false, signerConnected: false }), "Get Dusk Wallet");
  assert.equal(label({ duskInstalled: false, phoneOnly: true, signerConnected: false }), "Send from a computer");
  assert.equal(label({ route: migration, signerConnected: false }), "Connect EVM wallet");
  assert.equal(label({ amountLux: null }), "Enter an amount");
  assert.equal(label({ amountError: "Use a point for decimals, like 0.5.", amountLux: null }), "Enter a valid amount");
  assert.equal(label({ amountError: "That's more than you have", insufficient: true }), "Not enough DUSK");
  assert.equal(label({ insufficient: true, route: migration, unit: "ERC20 DUSK" }), "Not enough ERC20 DUSK");
  assert.equal(label({ amountError: "Send more than the 1 DUSK fee" }), "Check the amount");
  assert.equal(label({ destination: "", looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.equal(label({ destination: "", destinationError: "Not an EVM address (0x + 40 hex)" }), "Fix recipient");
  assert.equal(label({ destination: "" }), "Add a recipient");
  // A route's approval not read yet: nothing to review until it is, or a way to read it again.
  assert.deepEqual(primaryButton({ ...ready, waiting: "reading" }), { action: null, enabled: false, label: "Checking the approval…" });
  assert.deepEqual(primaryButton({ ...ready, waiting: "failed" }), { action: "read-again", enabled: true, label: "Couldn't read the approval. Try again" });
  // No wallet to pay and none typed: the way to one, where a narrow page has no header button.
  assert.deepEqual(primaryButton({ ...ready, connectsRecipient: true, destination: "" }), {
    action: "connect-evm",
    enabled: true,
    label: "Connect EVM wallet",
  });
  assert.deepEqual(primaryButton({ ...ready, amountText: "25 DUSK" }), { action: "review", enabled: true, label: "Review 25 DUSK" });
  assert.deepEqual(primaryButton(ready), { action: "review", enabled: true, label: "Review" });
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
  const routes = buildRoutes(withoutHyperlane);
  assert.deepEqual(routes.filter((route) => route.paused).map((route) => route.id), ["ethereum-to-dusk", "dusk-to-ethereum"]);
  const name = (id) => networkName(testnet, id);
  const why = notRunning(testnet);
  assert.equal(why, "Paused on testnet");
  // In the card's lists, disabled, saying why.
  assert.deepEqual(fromChoices(routes, "dusk", name, why).find((choice) => choice.id === "ethereum"), { disabled: why, id: "ethereum" });
  assert.deepEqual(toChoices(routes, "dusk", "dusk-evm", name, why).find((choice) => choice.id === "ethereum"), { disabled: why, id: "ethereum" });
  // Never opened by itself, and not offered under the card.
  assert.equal(pairs([defaultPair(routes, { evm: true })])[0], "dusk>dusk-evm");
  assert.deepEqual(entryRoutes(routes, routeBetween(routes, "dusk", "dusk-evm")), []);
  // A link to one opens it, and it sends nothing.
  const sepolia = cardRoute(parseLocation("#/move/migrate"), bridgeTasks(withoutHyperlane, routes), routes);
  assert.equal(sepolia.id, "ethereum-to-dusk");
  assert.deepEqual(primaryButton({ amountLux: 1n, destination: "x", duskInstalled: true, paused: why, route: sepolia, signerConnected: true }), { action: null, enabled: false, label: "Paused on testnet" });
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
  assert.equal(
    line,
    '<p class="entry">Migrate from <a href="#/move/ethereum-to-dusk" aria-label="Migrate DUSK from Ethereum to Dusk">Ethereum</a> <span aria-hidden="true">·</span> <a href="#/move/bsc-to-dusk" aria-label="Migrate DUSK from BNB Smart Chain to Dusk">BNB Smart Chain</a></p>',
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

test("Hyperlane's routes run Sepolia ↔ Dusk on testnet, one per token, beside Sepolia's paused ones", () => {
  const routes = buildRoutes(testnet);
  const name = (id) => networkName(testnet, id);
  const why = notRunning(testnet);
  // Sepolia is offered again, both ways: its routes run through Hyperlane.
  assert.deepEqual(fromChoices(routes, "dusk", name, why).find((choice) => choice.id === "ethereum"), { id: "ethereum", selected: false });
  const toSepolia = toChoices(routes, "dusk", "dusk-evm", name, why).find((choice) => choice.id === "ethereum");
  assert.deepEqual([toSepolia.disabled, toSepolia.route.id], [undefined, "dusk-to-sepolia"]);
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

test("the card offers the tokens its pair moves, each by its route, and none for a pair of one", () => {
  const routes = buildRoutes(testnet);
  const choices = (route) => tokenChoices(routes, route).map(({ id, name, selected, symbol }) => [symbol, id, name, selected]);
  // Each by its own name.
  assert.deepEqual(choices(routeBetween(routes, "dusk", "ethereum", "hyperlane-eurd")), [
    ["DUSK", "dusk-to-sepolia", "Dusk", false],
    ["EURd", "dusk-to-sepolia-eurd", "Dusk Euro (testnet)", true],
    ["USDd", "dusk-to-sepolia-usdd", "Dusk Dollar (testnet)", false],
  ]);
  assert.deepEqual(choices(routeBetween(routes, "ethereum", "dusk")).map(([symbol, id]) => [symbol, id]), [
    ["DUSK", "sepolia-to-dusk"],
    ["EURd", "sepolia-to-dusk-eurd"],
    ["USDd", "sepolia-to-dusk-usdd"],
  ]);
  assert.deepEqual(tokenChoices(routes, routeBetween(routes, "dusk", "dusk-evm")), []);
  // A paused route a link opened is the card's; the running tokens are offered beside it, Hyperlane's DUSK too.
  const legacy = routes.find((route) => route.id === "dusk-to-ethereum");
  assert.deepEqual(choices(legacy).map(([symbol, id, , selected]) => [symbol, id, selected]), [
    ["DUSK", "dusk-to-ethereum", true],
    ["DUSK", "dusk-to-sepolia", false],
    ["EURd", "dusk-to-sepolia-eurd", false],
    ["USDd", "dusk-to-sepolia-usdd", false],
  ]);
  // A token paused by the deployment isn't offered.
  const paused = buildRoutes(profile("testnet", { ...DUSKEVM, VITE_PAUSED_ROUTES: "dusk-to-sepolia-usdd,ethereum-to-dusk,dusk-to-ethereum" }));
  assert.deepEqual(tokenChoices(paused, routeBetween(paused, "dusk", "ethereum")).map((choice) => choice.symbol), ["DUSK", "EURd"]);
});

test("a pair's running route is preferred to a paused one of the token asked for", () => {
  // Hyperlane's EURd alone, beside Sepolia's paused DUSK routes: from a card on DUSK, the pair still runs.
  const eurdOnly = buildRoutes(profile("testnet", { ...DUSKEVM, VITE_HYPERLANE_TOKENS: "eurd" }));
  const deposit = routeBetween(eurdOnly, "dusk", "dusk-evm");
  assert.equal(routeBetween(eurdOnly, "dusk", "ethereum", tokenOf(deposit)).id, "dusk-to-sepolia-eurd");
  const name = (id) => networkName(testnet, id);
  const sepolia = toChoices(eurdOnly, "dusk", "dusk-evm", name, notRunning(testnet), tokenOf(deposit)).find((choice) => choice.id === "ethereum");
  assert.deepEqual([sepolia.disabled, sepolia.route.id], [undefined, "dusk-to-sepolia-eurd"]);
  // With nothing running there, the paused route of the token, as before.
  const legacy = buildRoutes(withoutHyperlane);
  assert.equal(routeBetween(legacy, "dusk", "ethereum", tokenOf(routeBetween(legacy, "dusk", "dusk-evm"))).id, "dusk-to-ethereum");
});

test("Sepolia's own DUSK routes and Hyperlane's are told apart: in the token list, and by the flip", () => {
  const all = buildRoutes(running);
  const hyperlaneDusk = all.find((route) => route.id === "dusk-to-sepolia");
  // Both send DUSK from Dusk: each says what arrives.
  assert.deepEqual(
    tokenChoices(all, hyperlaneDusk).map(({ id, note, selected, symbol }) => [symbol, id, note ?? "", selected]),
    [
      ["DUSK", "dusk-to-ethereum", "Arrives as ERC20 DUSK", false],
      ["DUSK", "dusk-to-sepolia", "Arrives as DUSK", true],
      ["EURd", "dusk-to-sepolia-eurd", "", false],
      ["USDd", "dusk-to-sepolia-usdd", "", false],
    ],
  );
  // Back from Sepolia, a Hyperlane DUSK transfer goes back through Hyperlane, not the migration.
  assert.equal(flipRoute(all, hyperlaneDusk).id, "sepolia-to-dusk");
  assert.equal(flipRoute(all, all.find((route) => route.id === "dusk-to-ethereum")).id, "ethereum-to-dusk");
  // From Sepolia they send different tokens: ERC20 DUSK to migrate, Hyperlane's DUSK to bring back.
  assert.deepEqual(
    tokenChoices(all, all.find((route) => route.id === "sepolia-to-dusk")).map(({ id, symbol }) => [symbol, id]),
    [
      ["ERC20 DUSK", "ethereum-to-dusk"],
      ["DUSK", "sepolia-to-dusk"],
      ["EURd", "sepolia-to-dusk-eurd"],
      ["USDd", "sepolia-to-dusk-usdd"],
    ],
  );
});
