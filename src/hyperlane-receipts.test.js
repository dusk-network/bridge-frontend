import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { duskRecipientHash } from "./hyperlane.js";
import { receiptModel } from "./page-models.js";
import { transferSubline, transferView } from "./transfer-view.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));

const NOW = Date.parse("2026-11-18T09:30:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
const receipt = (entry) => receiptModel(entry, { cfg, gasPrice: 1n, locale: "en-GB", now: NOW, own: { account: ACCOUNT, name: "" }, route: byId[entry.routeId], timeZone: "Europe/Amsterdam", url: "https://bridge.test/#/transfer/x" });
// The amounts a receipt says, and the transactions it links, whatever words it says them with.
const AMOUNT = /\d[\d,]*(?:\.\d+)? (?:DUSK|EURd|USDd|ETH)\b/gu;
const amounts = (model) => model.details.filter((row) => !row.html).flatMap((row) => String(row.value).match(AMOUNT) ?? []);
const links = (model) => model.details.map((row) => row.html ?? "").join("");
const DURATION = /\b\d+ (?:s|min|minutes?|hours?|days?)\b/u;

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
  // The transfer's gas and the approval's, as one network fee.
  assert.ok(amounts(model).includes("0.004056872 DUSK"));
  assert.match(links(model), new RegExp(`transactions/transaction\\?id=${approval}`, "u"));
  // Without one, the transfer's own gas alone, and only its own transaction.
  const plain = receipt({ amountLux: "1", feeLux: "2216155", hash: "ab".repeat(32), id: "y", routeId: "dusk-to-sepolia-eurd", status: "pending" });
  assert.ok(amounts(plain).includes("0.002216155 DUSK"));
  const duskTransactions = (model) => links(model).match(/transactions\/transaction\?id=/gu)?.length ?? 0;
  assert.deepEqual([duskTransactions(model), duskTransactions(plain)], [2, 1]);
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
  assert.match(links(model), new RegExp(`id=${delivery}`, "u"));
});

test("a transfer held for its claim offers Claim, and isn't said to take the route's time", () => {
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
  // Its claim sent: Claim isn't offered again while that's on its way.
  const sent = receipt({ ...held, pendingAction: "claim", pendingHash: "cd".repeat(32) });
  assert.equal(sent.view.action, null);
  assert.doesNotMatch(sent.caption, DURATION);
  // On its way, it takes the route's time, and nothing is to claim.
  const way = receipt({ ...held, delivered: false, escrow: undefined, heldLux: undefined });
  assert.equal(way.view.action, null);
  assert.equal(way.arrives, true);
  assert.match(way.caption, /~1 min/u);
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
  // Dusk's own reason, and what the failed claim cost; Claim is offered again.
  assert.match(model.view.action.failure, /Panic/u);
  assert.deepEqual(model.view.action.failure.match(AMOUNT), ["0.003 DUSK"]);
  assert.equal(model.view.action.kind, "claim");
  assert.ok(amounts(model).includes("0.003 DUSK"));
  assert.match(links(model), new RegExp(`id=${failedHash}`, "u"));
  // The list says it apart from a transfer that's only held.
  const subline = (entry) => transferSubline(transferView(entry, { cfg, locale: "en-GB", now: NOW, route: byId["sepolia-to-dusk"], timeZone: "Europe/Amsterdam" }), entry, byId["sepolia-to-dusk"], cfg, { locale: "en-GB", now: NOW, timeZone: "Europe/Amsterdam" });
  assert.notEqual(subline(held), subline({ ...held, actionError: undefined, claimFailedFeeLux: undefined, claimFailedHash: undefined }));
  // One the wallet didn't send stays that: no cost is said.
  const unsent = receipt({ ...held, actionError: "Dusk Wallet didn't answer.", claimFailedFeeLux: undefined, claimFailedHash: undefined });
  assert.ok(unsent.view.action.failure);
  assert.equal(unsent.view.action.failure.match(AMOUNT), null);
});

test("a transfer back to Dusk whose gas isn't known yet says its check covers only the delivery fee, never that the gas is free", async () => {
  const { reviewChecks } = await import("./page-models.js");
  const { buildQuote } = await import("./quote.js");
  const route = byId["sepolia-to-dusk-eurd"];
  const evm = { balance: 5_000_000n, deliveryFeeWei: 132_000_000_001n, gasCoinWei: 132_000_000_001n, gasPriceWei: null };
  // The check of the ETH for the fees, with the gas price unread and read.
  const fees = (priceWei) => {
    const quote = buildQuote(route, "1", { balance: evm.balance, cfg, evm: { deliveryFeeWei: evm.deliveryFeeWei, gas: 250_000n, gasCoinWei: evm.gasCoinWei, priceWei } });
    const checks = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { gasPrice: 1n, hyperlane: { evm: { ...evm, gasPriceWei: priceWei }, registered: true } } });
    return checks.find((check) => /\bETH\b/u.test(check.html)).html;
  };
  // The same amounts either way here: what tells them apart is that the gas isn't counted yet, and it's said.
  assert.notEqual(fees(null), fees(2n));
});
