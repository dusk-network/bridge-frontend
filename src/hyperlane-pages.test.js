import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { groupTransfers } from "./discovery.js";
import { duskRecipientHash } from "./hyperlane.js";
import { balanceLine, receiptModel, reviewChecks, routeLine, routeSteps, transfersModel } from "./page-models.js";
import { amountsIn, assertShownInFull, decode, exactly, fieldOf, textOf } from "./pages.fixtures.js";

const DUSK_TX = (hash) => `https://explorer.testnet.dusk.network/transactions/transaction?id=${hash}`;
// That the first transfer to an account waits for its claim: never released by itself.
const CLAIMED = /\bclaim/iu;
const AUTOMATIC = /\bautomatic/iu;
import { buildQuote } from "./quote.js";
import { cardPage, cardRegions, receiptPage, transferRow } from "./views.js";
import { tokenChoices } from "./bridge-card.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));
const routeOf = (id) => byId[id];

const GB = "en-GB";
const AMS = "Europe/Amsterdam";
const NOW = Date.parse("2026-11-18T09:20:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";

// Live transaction 86123720…, 95.085867 EURd to Sepolia, on its way.
const OUT = {
  amountLux: "95085867",
  bridgeFeeLux: "16876000000",
  destination: EVM,
  feeLux: "2216155",
  hash: "86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f",
  id: "dusk-to-sepolia-eurd:86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f",
  messageId: "0xed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b",
  routeId: "dusk-to-sepolia-eurd",
  sender: ACCOUNT,
  sourceAt: Date.parse("2026-11-18T09:13:41Z"),
  status: "pending",
};
// A USDd transfer to Dusk, delivered, and held for the account's claim.
const HELD = {
  amountLux: "32156353",
  bridgeFeeWei: "132000000001",
  delivered: true,
  deliveredAt: Date.parse("2026-11-18T09:21:30Z"),
  destination: ACCOUNT,
  escrow: "held",
  feeWei: "235736000000",
  hash: "0x194470f65cdcb660042f9c87df42c83c5b8b88200e20f4faa6be6273e3c07c75",
  heldLux: "32156353",
  id: "sepolia-to-dusk-usdd:0x194470f65cdcb660042f9c87df42c83c5b8b88200e20f4faa6be6273e3c07c75",
  messageId: "0x8bfceee4fc2bb2d10246a3b7c7ac8f75538cded9501f44382df39123c0f86db6",
  parties: [EVM.toLowerCase(), ACCOUNT],
  recipientHash: duskRecipientHash(ACCOUNT),
  routeId: "sepolia-to-dusk-usdd",
  sender: EVM,
  sourceAt: Date.parse("2026-11-18T09:20:38Z"),
  status: "pending",
};

const receipt = (entry, extra = {}) =>
  receiptModel(entry, { cfg, gasPrice: 1n, locale: GB, now: NOW, own: { account: ACCOUNT, name: "" }, route: routeOf(entry.routeId), timeZone: AMS, url: "https://bridge.test/#/transfer/x", ...extra });
const steps = (model) => model.view.steps.map(({ key, state }) => [key, state]);
// What each of a receipt's fields says, as amounts.
const amountsOf = (page, labels) => labels.map((label) => amountsIn(fieldOf(page, label).text));
// The tokens a card's menu offers: the route a press picks, beside the token it shows and what's said under it.
const tokenOptions = (page) =>
  [...page.matchAll(/<button\b[^>]*\bdata-action="pick-token" data-route="([^"]*)" aria-selected="(true|false)"[^>]*>[\s\S]*?<span class="nm">([^<]*)<\/span><span class="sb">([^<]*)<\/span>/gu)].map(
    ([, route, selected, symbol, sub]) => ({ route: decode(route), selected: selected === "true", sub: decode(sub), symbol: decode(symbol) }),
  );

test("a transfer to Sepolia shows its message on its way, its fees in DUSK, and Sepolia's transaction once it arrives", () => {
  const model = receipt(OUT);
  assert.deepEqual(amountsIn(model.view.title), ["95.085867 EURd"]);
  assert.deepEqual(steps(model), [["sent", "done"], ["confirmed", "done"], ["arrived", "now"]]);
  assert.match(model.view.steps.at(-1).detail, exactly("0xed2c…213b"));
  assert.match(model.caption, exactly("~20 s"));
  // Field by field: what was sent, the bridge fee and the network fee in DUSK, and what arrives.
  const page = receiptPage(model);
  assert.deepEqual(amountsOf(page, ["You sent", "Bridge fee", "Network fee", "You receive"]), [["95.085867 EURd"], ["16.876 DUSK"], ["0.002216155 DUSK"], ["95.085867 EURd"]]);
  // The message, the recipient and the transaction in full, each copied as it is, and on its explorer.
  assertShownInFull(fieldOf(page, "Message ID"), OUT.messageId);
  assertShownInFull(fieldOf(page, "To, on Sepolia"), EVM, `https://sepolia.etherscan.io/address/${EVM}`);
  assertShownInFull(fieldOf(page, "Dusk transaction"), OUT.hash, DUSK_TX(OUT.hash));
  assert.equal(model.arrives, true);

  const done = receipt({ ...OUT, destinationAt: OUT.sourceAt + 19_000, destinationHash: "0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8", status: "completed" });
  assert.equal(done.view.status, "completed");
  assert.deepEqual(amountsIn(done.view.title), ["95.085867 EURd"]);
  assert.deepEqual(done.view.steps.at(-1).href, "https://sepolia.etherscan.io/tx/0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8");
  assert.deepEqual(amountsOf(receiptPage(done), ["You received"]), [["95.085867 EURd"]]);
});

test("a transfer to Dusk the route holds needs its account's claim, there and in the list", () => {
  const model = receipt(HELD);
  assert.deepEqual(amountsIn(model.view.title), ["32.156353 USDd"]);
  assert.deepEqual(steps(model), [["confirmed", "done"], ["arrived", "done"], ["claim", "turn"]]);
  const { blocked, command, failure, kind, quiet } = model.view.action;
  assert.deepEqual({ blocked, command, failure, kind, quiet }, { blocked: "", command: "escrow-claim", failure: "", kind: "claim", quiet: false });
  assert.deepEqual(amountsIn(model.actionFee), ["≤0.003 DUSK"]);
  // Nothing comes by itself: it isn't offered to be told when it arrives.
  assert.equal(model.arrives, false);
  // Field by field: what was sent, the bridge fee and the fee on Sepolia in ETH, and what's held for the claim.
  const page = receiptPage({ ...model, canAct: true });
  assert.deepEqual(amountsOf(page, ["You sent", "Bridge fee", "Fee on Sepolia", "You receive"]), [["32.156353 USDd"], ["0.000000132000000001 ETH"], ["0.000000235736 ETH"], ["32.156353 USDd"]]);
  assert.match(page, /data-action="escrow-claim" data-id="sepolia-to-dusk-usdd:0x1944/u);

  // In My transfers it needs you, with Claim on its row.
  const list = transfersModel([HELD], { account: ACCOUNT, accounts: [ACCOUNT], cfg, locale: GB, now: NOW, routeOf, timeZone: AMS });
  assert.equal(list.needs, 1);
  const [row] = list.groups.needs;
  assert.equal(row.amountText, "32.1563 USDd");
  assert.match(transferRow(row), /data-action="escrow-claim"/u);

  // Held for another account: anyone can claim it for it, so it's offered quietly, apart.
  assert.deepEqual(Object.entries(groupTransfers([HELD], routeOf, OTHER)).filter(([, list]) => list.length).map(([key]) => key), ["other"]);
  const forOther = receipt(HELD, { own: { account: OTHER, name: "" } });
  assert.equal(forOther.view.action.quiet, true);
  assert.deepEqual(amountsIn(forOther.actionFee), ["≤0.08 DUSK"]);
});

test("a transfer to Dusk waits for a claim as soon as it's known to be the account's first, and once claimed, it arrived", () => {
  const way = { ...HELD, delivered: false, escrow: undefined, firstToAccount: true, heldLux: undefined };
  assert.deepEqual(steps(receipt(way)), [["confirmed", "done"], ["arrived", "now"], ["claim", "todo"]]);
  assert.match(receipt(way).view.steps[1].detail, exactly("0x8bfc…6db6"));
  const claimAt = Date.parse("2026-11-18T09:25:00Z");
  const claimed = receipt({ ...HELD, claimAt, claimFeeLux: "1908588", claimHash: "cd".repeat(32), destinationAt: claimAt, escrow: "claimed", status: "completed" });
  assert.equal(claimed.view.status, "completed");
  assert.deepEqual(amountsIn(claimed.view.title), ["32.156353 USDd"]);
  assert.deepEqual(steps(claimed), [["confirmed", "done"], ["arrived", "done"], ["claim", "done"]]);
  // The claim's own fee, and its transaction in full, copied as it is.
  const page = receiptPage(claimed);
  assert.deepEqual(amountsOf(page, ["Claim fee on Dusk"]), [["0.001908588 DUSK"]]);
  assertShownInFull(fieldOf(page, "Claim on Dusk"), "cd".repeat(32), DUSK_TX("cd".repeat(32)));
  // Paid straight away, no claim at all.
  const direct = receipt({ ...HELD, destinationAt: HELD.deliveredAt, escrow: null, status: "completed" });
  assert.deepEqual(steps(direct), [["confirmed", "done"], ["arrived", "done"]]);
  // Looked up by its hash alone, its account is said by its hash, in full.
  assertShownInFull(fieldOf(receiptPage(receipt({ ...HELD, destination: undefined })), "To, on Dusk, by its hash"), "0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b");
});

test("a Hyperlane route's row and checks say its time, its fees' coin, and the first transfer's claim", () => {
  const dusk = routeLine(byId["dusk-to-sepolia"], cfg, { fee: 16_876_000_000n });
  assert.match(dusk, exactly("~20 s"));
  assert.deepEqual(amountsIn(dusk), ["16.876 DUSK"]);
  // Before its fee is read, the coin it's paid in.
  assert.match(routeLine(byId["dusk-to-sepolia-eurd"], cfg), exactly("DUSK"));
  assert.match(routeLine(byId["sepolia-to-dusk-usdd"], cfg), exactly("~1 min"));
  assert.match(routeLine(byId["sepolia-to-dusk-usdd"], cfg), exactly("ETH"));
  assert.deepEqual(balanceLine(byId["sepolia-to-dusk"], 2_599_214_807n), { exact: "2.599214807 DUSK", text: "2.5992 DUSK" });

  const route = byId["sepolia-to-dusk-usdd"];
  const evm = { deliveryFeeWei: 132_000_000_001n, gas: 276_237n, gasCoinWei: 29_971_344_846_295_543n, priceWei: 17n };
  const quote = buildQuote(route, "10", { balance: 71_508_029n, cfg, evm });
  const reads = { gasPrice: 1n, hyperlane: { evm: { balance: 71_508_029n, gasCoinWei: evm.gasCoinWei }, registered: false } };
  const checks = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads });
  assert.deepEqual(checks.map((check) => check.ok), [true, true, true, true]);
  assert.deepEqual(amountsIn(checks[0].html), ["71.508029 USDd"]);
  assert.match(textOf(checks[0].html), exactly("0x8A51…B75d"));
  assert.match(textOf(checks[2].html), exactly("xGX8tZ…zQjkw9"));
  // The first USDd to the account waits on Dusk for its claim, never released by itself: said for this token, with the claim's fee.
  assert.match(textOf(checks[3].html), exactly("USDd"));
  assert.match(textOf(checks[3].html), CLAIMED);
  assert.doesNotMatch(textOf(checks[3].html), AUTOMATIC);
  assert.deepEqual(amountsIn(checks[3].html), ["≤0.003 DUSK"]);
  // An account the route pays already: no claim to mention.
  assert.equal(reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { hyperlane: { registered: true } } }).length, 1);

  const out = byId["dusk-to-sepolia-eurd"];
  const ctx = { allowance: 20_000_000n, fee: 16_876_000_000n, tokenBalance: 49_805_396_789n };
  const outQuote = buildQuote(out, "10", { balance: 20_000_000_000n, cfg, gasPrice: 1n, hyperlane: ctx });
  const outChecks = reviewChecks(out, { cfg, destination: EVM, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote: outQuote, reads: { duskBalance: 20_000_000_000n, hyperlane: ctx } });
  // The token held, the DUSK for the fees against what they take, the approval that covers it, and the recipient.
  assert.deepEqual(
    outChecks.map((check) => [check.ok, amountsIn(check.html)]),
    [
      [true, ["49,805.396789 EURd"]],
      [true, ["20 DUSK", "≤16.881 DUSK"]],
      [true, ["20 EURd"]],
      [true, []],
    ],
  );
  assert.match(textOf(outChecks[3].html), exactly("0x8A51…B75d"));
});

test("the card offers the pair's tokens, each by the route it picks, and what the routes hold for the account, each to claim for its own account", () => {
  const route = byId["dusk-to-sepolia-eurd"];
  const quote = buildQuote(route, "10", { balance: 20_000_000_000n, cfg, gasPrice: 1n, hyperlane: { allowance: 0n, fee: 16_876_000_000n, tokenBalance: 49_805_396_789n } });
  const vm = {
    amount: "10",
    amountError: "",
    button: { action: "review", enabled: true, label: "Review bridge" },
    canFlip: true,
    canMax: true,
    error: "",
    escrow: { held: [{ amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }, { amount: "2 DUSK", route: "sepolia-to-dusk", sent: "Claim sent, waiting for Dusk." }] },
    from: { balance: "49,805.3967 EURd", balanceLabel: "Balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    menu: null,
    needsCount: 0,
    notice: null,
    privacy: "Public on Dusk and Sepolia, and linked: your Dusk account xGX8tZ…zQjkw9, 0x8A51…B75d and the amount.",
    quote,
    receive: "10",
    receiveUnit: "EURd",
    routeLine: routeLine(route, cfg, { fee: 16_876_000_000n, steps: quote.steps }),
    routeOpen: false,
    steps: routeSteps(route, quote),
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient on Sepolia", line: "to your MetaMask", looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    tokens: tokenChoices(buildRoutes(cfg), route),
    unit: "EURd",
  };
  // The token sent, and the menu's tokens: each shown beside the route a press picks, the chosen one selected.
  assert.match(textOf(/<button\b[^>]*\bclass="token tokbtn"[^>]*>[\s\S]*?<\/button>/u.exec(cardPage(vm))[0]), exactly("EURd"));
  assert.deepEqual(tokenOptions(cardPage({ ...vm, menu: "token" })).map(({ route: id, selected, symbol }) => [id, symbol, selected]), [
    ["dusk-to-sepolia", "DUSK", false],
    ["dusk-to-sepolia-eurd", "EURd", true],
    ["dusk-to-sepolia-usdd", "USDd", false],
  ]);
  // What waits for the account, with Claim, or the claim sent in its place.
  const { escrow } = cardRegions(vm);
  for (const amount of ["10 USDd", "2 DUSK"]) assert.ok(amountsIn(escrow).includes(amount), amount);
  assert.match(escrow, /data-action="escrow-claim" data-route="sepolia-to-dusk-usdd"/u);
  assert.doesNotMatch(escrow, /data-route="sepolia-to-dusk"/u);
  assert.equal(cardRegions({ ...vm, escrow: null }).escrow, "");
  // Another account's, typed or handed over: claimed for that account.
  const other = cardRegions({ ...vm, escrow: { held: [{ account: ACCOUNT, amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }], link: "", owner: "xGX8tZ…zQjkw9" } }).escrow;
  assert.match(textOf(other), exactly("xGX8tZ…zQjkw9"));
  assert.match(other, new RegExp(`data-action="escrow-claim" data-route="sepolia-to-dusk-usdd" data-account="${ACCOUNT}"`, "u"));
  // Without DUSK for its own claim's fee: the link another account claims it with, in place of Claim.
  const link = "https://bridge.test/#/move/sepolia-to-dusk-usdd?to=" + ACCOUNT;
  const stuck = cardRegions({ ...vm, escrow: { held: [{ account: "", amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }], link, owner: "" } }).escrow;
  assert.ok(stuck.includes(`data-copy="${link}"`) && !stuck.includes("escrow-claim"), stuck);
});

test("where Sepolia's own DUSK route runs beside Hyperlane's, the token list says what each DUSK arrives as, by the route it picks", () => {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet", VITE_PAUSED_ROUTES: "none" };
  const running = loadConfig();
  delete globalThis.__DUSK_BRIDGE_CONFIG__;
  const all = buildRoutes(running);
  const route = all.find((each) => each.id === "dusk-to-sepolia");
  const page = cardPage({
    amount: "",
    amountError: "",
    button: { action: "review", enabled: false, label: "Enter an amount" },
    canFlip: true,
    canMax: false,
    error: "",
    escrow: null,
    from: { balance: "", balanceLabel: "Public balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    menu: "token",
    needsCount: 0,
    notice: null,
    privacy: "",
    quote: buildQuote(route, "", { balance: null, cfg: running, gasPrice: 1n, hyperlane: {} }),
    receive: "",
    receiveUnit: "DUSK",
    routeLine: "",
    routeOpen: false,
    steps: [],
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient on Sepolia", line: "", looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    tokens: tokenChoices(all, route),
    unit: "DUSK",
  });
  // Each option: the route a press picks, the token it shows, and the token that arrives where two send DUSK.
  const arrives = (sub) => sub.match(/\bas\s+(.+)$/u)?.[1] ?? "";
  assert.deepEqual(tokenOptions(page).map(({ route: id, sub, symbol }) => [id, symbol, arrives(sub)]), [
    ["dusk-to-ethereum", "DUSK", "ERC20 DUSK"],
    ["dusk-to-sepolia", "DUSK", "DUSK"],
    ["dusk-to-sepolia-eurd", "EURd", ""],
    ["dusk-to-sepolia-usdd", "USDd", ""],
  ]);
});
