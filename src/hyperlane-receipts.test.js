import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { duskRecipientHash } from "./hyperlane.js";
import { receiptModel, routeSteps } from "./page-models.js";
import { transferSubline, transferView } from "./transfer-view.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));

const NOW = Date.parse("2026-11-18T09:30:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
const receipt = (entry) => receiptModel(entry, { cfg, gasPrice: 1n, locale: "en-GB", now: NOW, own: { account: ACCOUNT, name: "" }, route: byId[entry.routeId], timeZone: "Europe/Amsterdam", url: "https://bridge.test/#/transfer/x" });
const details = (model) => Object.fromEntries(model.details.map((row) => [row.label, row]));

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
  const rows = details(model);
  assert.deepEqual([rows["Network fee"].value, rows["Network fee"].detail], ["0.004056872 DUSK", "approval and transfer"]);
  assert.match(rows["Dusk approval"].html, new RegExp(`transactions/transaction\\?id=${approval}`, "u"));
  // Without one, the transfer's own gas alone.
  const plain = details(receipt({ amountLux: "1", feeLux: "2216155", hash: "ab".repeat(32), id: "y", routeId: "dusk-to-sepolia-eurd", status: "pending" }));
  assert.deepEqual([plain["Network fee"].value, plain["Network fee"].detail ?? "", "Dusk approval" in plain], ["0.002216155 DUSK", "", false]);
});

test("a transfer to Dusk links the Dusk transaction that delivered it, on its step and in its details", () => {
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
  assert.match(details(model)["Dusk transaction"].html, new RegExp(`id=${delivery}`, "u"));
  // Before it's found, said as it stands.
  assert.match(details(receipt({ ...entry, deliveryHash: undefined, status: "pending" }))["Dusk transaction"].html, /Delivered/u);
  assert.match(details(receipt({ ...entry, delivered: false, deliveryHash: undefined, status: "pending" }))["Dusk transaction"].html, /Shows when it arrives/u);
});

test("a transfer to Sepolia that arrived before its transaction was found says it was delivered, not that it shows when it arrives", () => {
  const rows = details(receipt({ amountLux: "1000000", destination: EVM, hash: "1decfef01c5b9991253a54e7442c87a8999dd45976cf498f232fd455a9be6b37", id: "o", messageId: "0x" + "ab".repeat(32), routeId: "dusk-to-sepolia-eurd", sourceAt: NOW - 60_000, status: "completed" }));
  assert.match(rows["Sepolia transaction"].html, /Delivered/u);
  assert.doesNotMatch(rows["Sepolia transaction"].html, /Shows when it arrives/u);
});

test("a transfer held for its claim says it waits to be claimed, with Claim, not that it's pending or how long it takes", () => {
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
  assert.deepEqual([model.view.statusWord, model.caption, model.view.action?.label], ["To claim", "Held on Dusk until it's claimed.", "Claim on Dusk"]);
  const sent = receipt({ ...held, pendingAction: "claim", pendingHash: "cd".repeat(32) });
  assert.deepEqual([sent.view.statusWord, sent.caption], ["To claim", "Claim sent, waiting for Dusk."]);
  // On its way, it's pending, and takes the route's time.
  const way = receipt({ ...held, delivered: false, escrow: undefined, heldLux: undefined });
  assert.deepEqual([way.view.statusWord, way.caption], ["Pending", "Takes ~1 min"]);
});

test("a claim that failed on Dusk says so and what it cost, on the receipt and in the list, not that it wasn't sent", () => {
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
  assert.deepEqual([model.view.action.failure, model.view.action.label], ["The claim failed on Dusk (Panic) and cost 0.003 DUSK.", "Claim on Dusk"]);
  const rows = details(model);
  assert.equal(rows["Failed claim fee on Dusk"].value, "0.003 DUSK");
  assert.match(rows["Failed claim on Dusk"].html, new RegExp(`id=${failedHash}`, "u"));
  const view = transferView(held, { cfg, locale: "en-GB", now: NOW, route: byId["sepolia-to-dusk"], timeZone: "Europe/Amsterdam" });
  assert.equal(transferSubline(view, held, byId["sepolia-to-dusk"], cfg, { locale: "en-GB", now: NOW, timeZone: "Europe/Amsterdam" }), "The claim failed on Dusk");
  // One the wallet didn't send stays that.
  const unsent = receipt({ ...held, actionError: "Dusk Wallet didn't answer.", claimFailedFeeLux: undefined, claimFailedHash: undefined });
  assert.equal(unsent.view.action.failure, "The claim wasn't sent. Try again.");
});

test("a route's steps aren't said before its approval is read", () => {
  assert.equal(routeSteps(byId["dusk-to-sepolia-eurd"], { steps: null }), "In Dusk Wallet");
  assert.equal(routeSteps(byId["dusk-to-sepolia-eurd"], { steps: 2 }), "Approve, then send, in Dusk Wallet");
  assert.equal(routeSteps(byId["dusk-to-sepolia-eurd"], { steps: 1 }), "One, in Dusk Wallet");
});

test("a transfer back to Dusk whose gas isn't known yet says its check covers only the delivery fee, never that the gas is free", async () => {
  const { reviewChecks } = await import("./page-models.js");
  const { buildQuote } = await import("./quote.js");
  const route = byId["sepolia-to-dusk-eurd"];
  const evm = { balance: 5_000_000n, deliveryFeeWei: 132_000_000_001n, gasCoinWei: 132_000_000_001n, gasPriceWei: null };
  const quote = buildQuote(route, "1", { balance: evm.balance, cfg, evm: { deliveryFeeWei: evm.deliveryFeeWei, gas: 250_000n, gasCoinWei: evm.gasCoinWei, priceWei: null } });
  const checks = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { gasPrice: 1n, hyperlane: { evm, registered: true } } });
  const fees = checks.find((check) => /ETH/u.test(check.html) && /fee/u.test(check.html));
  assert.match(fees.html, /for the delivery fee/u);
  assert.match(fees.html, /the gas isn't known yet/u);
});
