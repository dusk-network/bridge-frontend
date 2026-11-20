import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { duskRecipientHash } from "./hyperlane.js";
import { receiptModel } from "./page-models.js";
import { DURATION, NOT_SENT, amountsIn, assertShownInFull, exactly, fieldOf, fieldsOf, linksOf, partsOf, stepsOf, textOf } from "./pages.fixtures.js";
import { transferSubline, transferView } from "./transfer-view.js";
import { receiptPage } from "./views.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));

const NOW = Date.parse("2026-11-18T09:30:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
const receipt = (entry) => receiptModel(entry, { cfg, gasPrice: 1n, locale: "en-GB", now: NOW, own: { account: ACCOUNT, name: "" }, route: byId[entry.routeId], timeZone: "Europe/Amsterdam", url: "https://bridge.test/#/transfer/x" });
const field = (model, label) => fieldOf(receiptPage({ ...model, canAct: true }), label);
const steps = (model) => model.view.steps.map(({ key, state }) => [key, state]);
const DUSK_TX = (hash) => `https://explorer.testnet.dusk.network/transactions/transaction?id=${hash}`;
// The words a receipt's states are said in, by a short phrase each.
const ARRIVED = /\barrived\b/iu;
const ARRIVING = /\barriving\b/iu;
const DELIVERED = /\bdelivered\b/iu;
const CLAIM_SENT = /\bclaim sent\b/iu;
const NEVER_SENT = /\b(?:never|not|wasn't)\b[^.]*\bsent\b/iu;
const FAILED = /\bfailed\b/iu;
const NOT = /\bnot\b/iu;
// The last step of a receipt as it shows: its state, and its text.
const lastStep = (model) => stepsOf(receiptPage({ ...model, canAct: true })).at(-1);
// The status a receipt's pill shows: completed, or still on its way.
const pillOf = (model) => textOf(partsOf(receiptPage({ ...model, canAct: true }), "spill")[0]);
function assertPill(model, completed) {
  const pill = pillOf(model);
  assert.match(pill, completed ? /\bcompleted\b/iu : /\b(?:pending|in progress)\b/iu, pill);
  assert.doesNotMatch(pill, completed ? /\b(?:pending|in progress)\b/iu : /\bcompleted\b/iu, pill);
}

test("a transfer to Sepolia that approved first counts the approval in its network fee, and lists it", () => {
  const approval = "ab".repeat(32);
  const model = receipt({
    amountLux: "25000000",
    approvalFeeLux: "1840717",
    approvalHash: approval,
    bridgeFeeLux: "16876000000",
    destination: EVM,
    feeLux: "2216155",
    hash: "86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f",
    id: "x",
    routeId: "dusk-to-sepolia-eurd",
    sender: ACCOUNT,
    sourceAt: NOW - 60_000,
    status: "pending",
  });
  // The transfer's gas and the approval's, as one network fee; the approval in full, copied as it is, on its explorer.
  assert.deepEqual(amountsIn(field(model, "Network fee").text), ["0.004056872 DUSK"]);
  assertShownInFull(field(model, "Dusk approval"), approval, DUSK_TX(approval));
  // Without one, the transfer's own gas alone, and no approval listed.
  const plain = receipt({ amountLux: "1", feeLux: "2216155", hash: "ab".repeat(32), id: "y", routeId: "dusk-to-sepolia-eurd", status: "pending" });
  assert.deepEqual(amountsIn(field(plain, "Network fee").text), ["0.002216155 DUSK"]);
  assert.equal(fieldsOf(receiptPage(plain)).filter((each) => each.label === "Dusk approval").length, 0);
});

test("a transfer to Dusk links the Dusk transaction that delivered it, and before that's found, says whether it was delivered", () => {
  const delivery = "bbf13d74c6451e0d5042b550ad543f359db88b8ec40916f0fb5f298bfe457a25";
  const entry = {
    amountLux: "540488790",
    delivered: true,
    deliveredAt: NOW - 120_000,
    deliveryHash: delivery,
    destination: ACCOUNT,
    destinationAt: NOW - 120_000,
    hash: "0x662c6163ce754cf4dea9c50db789967a43d20fd42d4fc378447a1eed26aaab06",
    id: "z",
    recipientHash: duskRecipientHash(ACCOUNT),
    routeId: "sepolia-to-dusk",
    sender: EVM,
    sourceAt: NOW - 180_000,
    status: "completed",
  };
  const model = receipt(entry);
  const arrived = model.view.steps.find((step) => step.key === "arrived");
  assert.equal(arrived.href, `https://explorer.testnet.dusk.network/transactions/transaction?id=${delivery}`);
  assertShownInFull(field(model, "Dusk transaction"), delivery, DUSK_TX(delivery));
  assertPill(model, true);
  // Delivered, its transaction not found yet; or still on its way: neither links one, and each shows as what it is.
  for (const [still, completed] of [[{ deliveryHash: undefined, status: "pending" }, false], [{ delivered: false, deliveryHash: undefined, status: "pending" }, false]]) assertPill(receipt({ ...entry, ...still }), completed);
  const unfound = receipt({ ...entry, deliveryHash: undefined, status: "pending" });
  const onItsWay = receipt({ ...entry, delivered: false, deliveryHash: undefined, status: "pending" });
  assert.deepEqual([steps(unfound).at(-1), steps(onItsWay).at(-1)], [["arrived", "done"], ["arrived", "now"]]);
  for (const model of [unfound, onItsWay]) assert.deepEqual([field(model, "Dusk transaction").copies, linksOf(field(model, "Dusk transaction").html)], [[], []]);
  const [doneState, doneText] = lastStep(unfound);
  assert.deepEqual([doneState, ARRIVED.test(doneText), ARRIVING.test(doneText), NOT.test(doneText)], ["done", true, false, false]);
  assert.match(field(unfound, "Dusk transaction").text, DELIVERED);
  assert.doesNotMatch(field(unfound, "Dusk transaction").text, NOT);
  const [wayState, wayText] = lastStep(onItsWay);
  assert.deepEqual([wayState, ARRIVING.test(wayText), ARRIVED.test(wayText)], ["now", true, false]);
  assert.doesNotMatch(field(onItsWay, "Dusk transaction").text, DELIVERED);
});

test("a transfer to Sepolia that arrived before its transaction was found reads as arrived, not as on its way", () => {
  const entry = { amountLux: "1000000", destination: EVM, hash: "1decfef01c5b9991253a54e7442c87a8999dd45976cf498f232fd455a9be6b37", id: "o", messageId: "0x" + "ab".repeat(32), routeId: "dusk-to-sepolia-eurd", sourceAt: NOW - 60_000 };
  const arrived = receipt({ ...entry, status: "completed" });
  const onItsWay = receipt({ ...entry, status: "pending" });
  assert.deepEqual([arrived.view.status, steps(arrived).at(-1)], ["completed", ["arrived", "done"]]);
  assert.deepEqual([onItsWay.view.status, steps(onItsWay).at(-1)], ["pending", ["arrived", "now"]]);
  // No transaction to link yet; each shows as what it is.
  for (const model of [arrived, onItsWay]) assert.deepEqual([field(model, "Sepolia transaction").copies, linksOf(field(model, "Sepolia transaction").html)], [[], []]);
  const [doneState, doneText] = lastStep(arrived);
  assert.deepEqual([doneState, ARRIVED.test(doneText), ARRIVING.test(doneText), NOT.test(doneText)], ["done", true, false, false]);
  assert.match(field(arrived, "Sepolia transaction").text, DELIVERED);
  assert.doesNotMatch(field(arrived, "Sepolia transaction").text, NOT);
  assertPill(arrived, true);
  assertPill(onItsWay, false);
  const [wayState, wayText] = lastStep(onItsWay);
  assert.deepEqual([wayState, ARRIVING.test(wayText), ARRIVED.test(wayText)], ["now", true, false]);
  assert.doesNotMatch(field(onItsWay, "Sepolia transaction").text, DELIVERED);
});

test("a transfer held for its claim offers Claim; once the claim is sent, it shows that claim and offers no other", () => {
  const held = {
    amountLux: "1000000000",
    delivered: true,
    deliveredAt: NOW - 60_000,
    destination: ACCOUNT,
    escrow: "held",
    hash: "0xc00e8f6b42e13c3c81d90c15a3fdc7f490ebd9295a08de854dde6ea144405c07",
    heldLux: "1000000000",
    id: "h",
    recipientHash: duskRecipientHash(ACCOUNT),
    routeId: "sepolia-to-dusk",
    sender: EVM,
    sourceAt: NOW - 120_000,
    status: "pending",
  };
  const model = receipt(held);
  assert.equal(model.view.action.kind, "claim");
  assert.equal(model.arrives, false);
  assert.doesNotMatch(model.caption, DURATION);
  // Held: the claim is the account's turn, and it's said as held, on its pill too: neither completed nor pending.
  assert.equal(lastStep(model)[0], "turn");
  assert.match(model.caption, /\bheld\b/iu);
  assert.match(pillOf(model), /\b(?:held|claim)\b/iu);
  assert.doesNotMatch(pillOf(model), /\b(?:completed|pending)\b/iu);
  // Its claim sent: that claim's transaction in full, said as sent (never as not sent), and Claim not offered again.
  const sent = receipt({ ...held, pendingAction: "claim", pendingHash: "cd".repeat(32) });
  assert.equal(sent.view.action, null);
  assertShownInFull(field(sent, "Claim on Dusk"), "cd".repeat(32), DUSK_TX("cd".repeat(32)));
  const [sentState, sentText] = lastStep(sent);
  assert.equal(sentState, "now");
  for (const said of [sentText, sent.caption]) {
    assert.match(said, CLAIM_SENT);
    assert.doesNotMatch(said, NEVER_SENT);
  }
  assert.doesNotMatch(sent.caption, DURATION);
  // On its way, it takes the route's time, and nothing is to claim.
  const way = receipt({ ...held, delivered: false, escrow: undefined, heldLux: undefined });
  assert.equal(way.view.action, null);
  assert.equal(way.arrives, true);
  assert.match(way.caption, exactly("~1 min"));
});

test("a claim that failed on Dusk says so and what it cost, on the receipt and in the list; one the wallet didn't send says it wasn't sent", () => {
  const failedHash = "cd".repeat(32);
  const held = {
    actionError: "The claim failed on Dusk: Panic",
    amountLux: "1000000000",
    claimFailedFeeLux: "3000000",
    claimFailedHash: failedHash,
    delivered: true,
    destination: ACCOUNT,
    escrow: "held",
    hash: "0xc00e8f6b42e13c3c81d90c15a3fdc7f490ebd9295a08de854dde6ea144405c07",
    heldLux: "1000000000",
    id: "f",
    recipientHash: duskRecipientHash(ACCOUNT),
    routeId: "sepolia-to-dusk",
    sender: EVM,
    sourceAt: NOW - 120_000,
    status: "pending",
  };
  const model = receipt(held);
  // Dusk's own reason, and what the failed claim cost; Claim is offered again.
  assert.match(model.view.action.failure, exactly("Panic"));
  assert.deepEqual(amountsIn(model.view.action.failure), ["0.003 DUSK"]);
  assert.equal(model.view.action.kind, "claim");
  assert.deepEqual(amountsIn(field(model, "Failed claim fee on Dusk").text), ["0.003 DUSK"]);
  assertShownInFull(field(model, "Failed claim on Dusk"), failedHash, DUSK_TX(failedHash));
  // The list says it failed; a transfer only held, that it didn't.
  const subline = (entry) => transferSubline(transferView(entry, { cfg, locale: "en-GB", now: NOW, route: byId["sepolia-to-dusk"], timeZone: "Europe/Amsterdam" }), entry, byId["sepolia-to-dusk"], cfg, { locale: "en-GB", now: NOW, timeZone: "Europe/Amsterdam" });
  assert.match(subline(held), FAILED);
  assert.doesNotMatch(subline({ ...held, actionError: undefined, claimFailedFeeLux: undefined, claimFailedHash: undefined }), FAILED);
  // One the wallet didn't send: never said as sent, failed on Dusk or paid for, and no failed claim is listed.
  const unsent = receipt({ ...held, actionError: "Dusk Wallet didn't answer.", claimFailedFeeLux: undefined, claimFailedHash: undefined });
  const { failure } = unsent.view.action;
  assert.match(failure, NOT_SENT);
  assert.deepEqual(amountsIn(failure), []);
  assert.doesNotMatch(failure, exactly("Panic"));
  assert.equal(unsent.view.action.kind, "claim");
  assert.equal(fieldsOf(receiptPage(unsent)).filter((each) => /failed/iu.test(each.label)).length, 0);
  assert.doesNotMatch(subline({ ...held, actionError: "Dusk Wallet didn't answer.", claimFailedFeeLux: undefined, claimFailedHash: undefined }), FAILED);
});

test("a transfer back to Dusk whose gas isn't known yet counts only the delivery fee, and never says the gas is free", async () => {
  const { reviewChecks } = await import("./page-models.js");
  const { buildQuote } = await import("./quote.js");
  const route = byId["sepolia-to-dusk-eurd"];
  const evm = { balance: 5_000_000n, deliveryFeeWei: 132_000_000_001n, gasCoinWei: 132_000_000_001n };
  // The quote and the check of the ETH for the fees, with the gas price unread and read.
  const read = (priceWei) => {
    const quote = buildQuote(route, "1", { balance: evm.balance, cfg, evm: { ...evm, gas: 250_000n, priceWei } });
    const checks = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { gasPrice: 1n, hyperlane: { evm: { ...evm, gasPriceWei: priceWei }, registered: true } } });
    return { fees: textOf(checks.find((check) => exactly("ETH").test(textOf(check.html))).html), quote };
  };
  const unknown = read(null);
  const known = read(2n);
  // Unread, no gas fee is counted, not even 0; read, it is.
  assert.equal(unknown.quote.evmFeeWei, null);
  assert.equal(known.quote.evmFeeWei, 500_000n);
  // What the account holds, and the delivery fee alone, under its bound.
  assert.deepEqual(amountsIn(unknown.fees), ["0.00000013 ETH", "<0.000001 ETH"]);
  // It says it covers the delivery fee, never the whole charge; never a gas of 0, or free; and it's said apart from the whole charge's check.
  assert.match(unknown.fees, /\bdelivery fee\b/iu);
  assert.doesNotMatch(unknown.fees, /\bwhole charge\b|\ball (?:the )?fees\b/iu);
  assert.doesNotMatch(unknown.fees, /\bfree\b|(?<![\w.,−-])0 ETH\b/iu);
  assert.notEqual(unknown.fees, known.fees);
});
