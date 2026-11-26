import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { groupTransfers } from "./discovery.js";
import { duskRecipientHash } from "./hyperlane.js";
import { balanceLine, receiptModel, reviewChecks, routeDetailRows, routeLines, transfersModel } from "./page-models.js";
import { amountsIn, assertShownInFull, decode, exactly, fieldOf, fieldsOf, paidOf, partsOf, stepPartsOf, textOf } from "./pages.fixtures.js";

const DUSK_TX = (hash) => `https://explorer.testnet.dusk.network/transactions/transaction?id=${hash}`;
// That the first transfer to an account waits for its claim: never released by itself.
const CLAIMED = /\bclaim/iu;
const AUTOMATIC = /\bautomatic/iu;
import { buildQuote } from "./quote.js";
import { cardPage, cardRegions, receiptPage, transferRow } from "./views.js";
import { assetChoices } from "./bridge-card.js";

/** The card's route line as it reads: its lines, one after the other. */
const routeLine = (route, cfg, options) => routeLines(route, cfg, options).join(" ");

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
// A receipt with its Details opened, as a press on Details shows them.
const opened = (page) => page.replace(/<details(?![^>]*\bopen\b)/gu, "<details open");
// What each of a receipt's fields says, as amounts.
const amountsOf = (page, labels) => labels.map((label) => amountsIn(fieldOf(page, label).text));
const pickerOptions = (page) =>
  [...page.matchAll(/<button\b[^>]*\bdata-action="pick-(?:asset|net)" data-(?:asset|route)="([^"]*)" aria-selected="(true|false)"[^>]*>([\s\S]*?)<\/button>/gu)].map(
    ([, value, selected, body]) => ({
      value: decode(value),
      selected: selected === "true",
      text: [...partsOf(body, "nm"), ...partsOf(body, "sb")].map(textOf).join(" "),
    }),
  );

test("a transfer to Sepolia shows its message on its way, its fees in DUSK, and Sepolia's transaction once it arrives", () => {
  const model = receipt(OUT);
  assert.deepEqual(amountsIn(model.view.title), ["95.085867 EURd"]);
  // Its own transaction is one step, done once it's in a block.
  assert.deepEqual(steps(model), [["sent", "done"], ["arrived", "now"]]);
  assert.match(model.caption, exactly("~20 s"));
  // Field by field, under Details: the bridge fee and the network fee in DUSK, who sent it and the message, nothing else.
  // What's sent and arrives is the title's, whom it pays the line under it, the transaction its step's.
  const page = opened(receiptPage(model));
  assert.deepEqual(fieldsOf(page).map((field) => field.label), ["Bridge fee", "Network fee", "From", "Message ID"]);
  assert.deepEqual(amountsOf(page, ["Bridge fee", "Network fee"]), [["16.876 DUSK"], ["0.002216155 DUSK"]]);
  // The message in full; whom it pays in full, under the title; each copied as it is, and on its explorer.
  assertShownInFull(fieldOf(page, "Message ID"), OUT.messageId);
  assertShownInFull(paidOf(page), EVM, `https://sepolia.etherscan.io/address/${EVM}`);
  // The transaction on its step, 6…6, copied in full, on its explorer.
  const [sent] = stepPartsOf(page);
  assert.deepEqual([sent.copies, sent.links], [[OUT.hash], [DUSK_TX(OUT.hash)]]);
  assert.match(sent.text, exactly("861237…9b383f"));
  assert.equal(model.arrives, true);

  const done = receipt({ ...OUT, destinationAt: OUT.sourceAt + 19_000, destinationHash: "0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8", status: "completed" });
  assert.equal(done.view.status, "completed");
  assert.deepEqual(amountsIn(done.view.title), ["95.085867 EURd"]);
  assert.deepEqual(done.view.steps.at(-1).href, "https://sepolia.etherscan.io/tx/0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8");
  // What arrived is the title's, so no row says it again.
  assert.deepEqual(fieldsOf(opened(receiptPage(done))).map((field) => field.label), ["Bridge fee", "Network fee", "From", "Message ID"]);
});

test("a transfer to Dusk the route holds needs its account's claim, there and in the list", () => {
  const model = receipt(HELD);
  assert.deepEqual(amountsIn(model.view.title), ["32.156353 USDd"]);
  assert.deepEqual(steps(model), [["sent", "done"], ["arrived", "done"], ["claim", "turn"]]);
  const { blocked, command, failure, kind, quiet } = model.view.action;
  assert.deepEqual({ blocked, command, failure, kind, quiet }, { blocked: "", command: "escrow-claim", failure: "", kind: "claim", quiet: false });
  assert.deepEqual(amountsIn(model.actionFee), ["≤0.003 DUSK"]);
  // Nothing comes by itself: it isn't offered to be told when it arrives.
  assert.equal(model.arrives, false);
  // Field by field, under Details: the bridge fee and the network fee in ETH. What's sent and held for the claim is the title's.
  const page = opened(receiptPage({ ...model, canAct: true }));
  assert.deepEqual(fieldsOf(page).map((field) => field.label), ["Bridge fee", "Network fee", "From", "Message ID"]);
  assert.deepEqual(amountsOf(page, ["Bridge fee", "Network fee"]), [["0.000000132000000001 ETH"], ["0.000000235736 ETH"]]);
  assert.match(page, /data-action="escrow-claim" data-id="sepolia-to-dusk-usdd:0x1944/u);

  // In My transfers it needs you, with Claim on its row.
  const list = transfersModel([HELD], { account: ACCOUNT, accounts: [ACCOUNT], cfg, locale: GB, now: NOW, routeOf, timeZone: AMS });
  assert.equal(list.needs, 1);
  const [row] = list.groups.needs;
  // USDd to the cent, rounded down, as a list writes it.
  assert.equal(row.amountText, "32.15 USDd");
  assert.match(transferRow(row), /data-action="escrow-claim"/u);

  // Held for another account: anyone can claim it for it, so it's offered quietly, apart.
  assert.deepEqual(Object.entries(groupTransfers([HELD], routeOf, OTHER)).filter(([, list]) => list.length).map(([key]) => key), ["other"]);
  const forOther = receipt(HELD, { own: { account: OTHER, name: "" } });
  assert.equal(forOther.view.action.quiet, true);
  assert.deepEqual(amountsIn(forOther.actionFee), ["≤0.08 DUSK"]);
});

test("a transfer to Dusk waits for a claim as soon as it's known to be the account's first, and once claimed, it arrived", () => {
  const way = { ...HELD, delivered: false, escrow: undefined, firstToAccount: true, heldLux: undefined };
  assert.deepEqual(steps(receipt(way)), [["sent", "done"], ["arrived", "now"], ["claim", "todo"]]);
  // Its message, in full, under Details.
  assertShownInFull(fieldOf(opened(receiptPage(receipt(way))), "Message ID"), HELD.messageId);
  const claimAt = Date.parse("2026-11-18T09:25:00Z");
  const claimed = receipt({ ...HELD, claimAt, claimFeeLux: "1908588", claimHash: "cd".repeat(32), destinationAt: claimAt, escrow: "claimed", status: "completed" });
  assert.equal(claimed.view.status, "completed");
  assert.deepEqual(amountsIn(claimed.view.title), ["32.156353 USDd"]);
  assert.deepEqual(steps(claimed), [["sent", "done"], ["arrived", "done"], ["claim", "done"]]);
  // The claim's own fee under Details; its transaction on its step, copied in full, on its explorer.
  const page = opened(receiptPage(claimed));
  assert.deepEqual(amountsOf(page, ["Claim fee"]), [["0.001908588 DUSK"]]);
  const claim = stepPartsOf(page).at(-1);
  assert.deepEqual([claim.copies, claim.links], [["cd".repeat(32)], [DUSK_TX("cd".repeat(32))]]);
  assert.match(claim.text, exactly("cdcdcd…cdcdcd"));
  // Paid straight away, no claim at all.
  const direct = receipt({ ...HELD, destinationAt: HELD.deliveredAt, escrow: null, status: "completed" });
  assert.deepEqual(steps(direct), [["sent", "done"], ["arrived", "done"]]);
  // Looked up by its hash alone, its account is said by its hash, in full.
  assertShownInFull(fieldOf(opened(receiptPage(receipt({ ...HELD, destination: undefined }))), "To (account hash)"), "0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b");
});

test("a Hyperlane route's row and checks say its time, its fees' coin, and the first transfer's claim", () => {
  // Its fees as one figure: the bridge's and the most the network's can be, in DUSK.
  const dusk = routeLine(byId["dusk-to-sepolia"], cfg, { quote: { bridgeFeeLux: 16_876_000_000n, gasMaxLux: 5_000_000n } });
  assert.match(dusk, exactly("~20 s"));
  assert.deepEqual(amountsIn(dusk), ["≤16.881 DUSK"]);
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
  // The token held and the gas coin for the fees, each passing; the account it pays is the review's flow, in full.
  assert.deepEqual(checks.map((check) => [check.ok, Boolean(check.note)]), [[true, false], [true, false], [true, true]]);
  assert.deepEqual(amountsIn(checks[0].html), ["71.508029 USDd"]);
  // The first USDd to the account waits on Dusk for its claim, never released by itself: said for this token, with the claim's fee, always.
  assert.match(textOf(checks[2].html), exactly("USDd"));
  assert.match(textOf(checks[2].html), CLAIMED);
  assert.doesNotMatch(textOf(checks[2].html), AUTOMATIC);
  assert.deepEqual(amountsIn(checks[2].html), ["≤0.003 DUSK"]);
  // An account the route pays already: no claim to mention.
  const paid = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { hyperlane: { registered: true } } });
  assert.equal(paid.some((check) => CLAIMED.test(textOf(check.html))), false);

  const out = byId["dusk-to-sepolia-eurd"];
  const ctx = { allowance: 20_000_000n, fee: 16_876_000_000n, tokenBalance: 49_805_396_789n };
  const outQuote = buildQuote(out, "10", { balance: 20_000_000_000n, cfg, gasPrice: 1n, hyperlane: ctx });
  const outChecks = reviewChecks(out, { cfg, destination: EVM, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote: outQuote, reads: { duskBalance: 20_000_000_000n, hyperlane: ctx } });
  // The token held, the DUSK for the fees against what they take, and the approval that covers it, said always.
  assert.deepEqual(
    outChecks.map((check) => [check.ok, Boolean(check.note), amountsIn(check.html)]),
    [
      [true, false, ["49,805.396789 EURd"]],
      [true, false, ["≤16.881 DUSK", "20 DUSK"]],
      [true, true, ["20 EURd"]],
    ],
  );
});

test("the card offers assets to send and shows what the routes hold for the account", () => {
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
    assets: assetChoices(buildRoutes(cfg), route, "from"),
    menu: null,
    needsCount: 0,
    notice: null,
    privacy: "Public and linked: your Dusk account xGX8tZ…zQjkw9, 0x8A51d0…a1B75d and the amount.",
    quote,
    receive: "10",
    receiveUnit: "EURd",
    routeLines: routeLines(route, cfg, { quote }),
    routeRows: routeDetailRows(route, quote),
    routeOpen: false,
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient on Sepolia", line: "to your MetaMask", looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    unit: "EURd",
  };
  assert.match(textOf(/<button\b[^>]*\bclass="tokbtn"[^>]*>[\s\S]*?<\/button>/u.exec(cardPage(vm))[0]), exactly("EURd on Dusk"));
  assert.deepEqual(pickerOptions(cardPage({ ...vm, menu: { side: "from" } })).map(({ value, selected }) => [value, selected]), [
    ["DUSK", false],
    ["EURd", true],
    ["USDd", false],
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

test("the DUSK network step tells Sepolia's ERC20 DUSK and Hyperlane DUSK routes apart", () => {
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
    menu: { side: "to", asset: "DUSK" },
    networks: assetChoices(all, route, "to").find(({ symbol }) => symbol === "DUSK").networks.map((choice) => ({
      ...choice,
      name: choice.network === "ethereum" ? "Sepolia" : "DuskEVM",
    })),
    needsCount: 0,
    notice: null,
    privacy: "",
    quote: buildQuote(route, "", { balance: null, cfg: running, gasPrice: 1n, hyperlane: {} }),
    receive: "",
    receiveUnit: "DUSK",
    routeLines: [],
    routeOpen: false,
    routeRows: [],
    steps: [],
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient on Sepolia", line: "", looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    unit: "DUSK",
  });
  assert.deepEqual(pickerOptions(page), [
    { value: "dusk-to-ethereum", selected: false, text: "Sepolia ERC20 DUSK" },
    { value: "dusk-to-sepolia", selected: true, text: "Sepolia DUSK" },
    { value: "dusk-to-dusk-evm", selected: false, text: "DuskEVM" },
  ]);
});
