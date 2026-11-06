import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { actionLead, receiptModel, reviewChecks, routeLine, transfersModel } from "./page-models.js";
import { buildQuote } from "./quote.js";
import { arrivalDue, measuredSeconds, routeTime, routeTimeText } from "./route-times.js";
import { transferView } from "./transfer-view.js";

const DUSKEVM = {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
};
function profile(name, extra = {}) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: name, ...extra };
  try {
    return loadConfig();
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}
const testnet = profile("testnet", DUSKEVM);
const mainnet = profile("mainnet");
const routes = (cfg) => buildRoutes(cfg);
const byId = (cfg, id) => routes(cfg).find((route) => route.id === id);
const text = (cfg, id, timing) => routeTimeText(routeTime(byId(cfg, id), cfg, timing));
// What DuskEVM testnet's chains said on 27 Oct 2026.
const CHAIN = Object.freeze({
  deposit: { lagSeconds: 35 },
  withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 },
});

test("each network has its own times, and another network's never stands in", () => {
  // Mainnet: Ethereum's migrations as measured, BSC's and the payout to BSC as the docs say.
  assert.equal(text(mainnet, "ethereum-to-dusk"), "~70 min");
  assert.equal(text(mainnet, "bsc-to-dusk"), "~1 hour");
  assert.equal(text(mainnet, "dusk-to-bsc"), "~10 hours");
  // Testnet: its deposits as configured; its payouts by testnet workers have no time.
  assert.equal(text(testnet, "dusk-to-dusk-evm"), "~1 min");
  assert.equal(text(testnet, "ethereum-to-dusk"), "");
  assert.equal(text(testnet, "dusk-to-ethereum"), "");
  // Mainnet has no DuskEVM yet. Without a time of its own, DuskEVM's is only what its chains say.
  assert.equal(byId(mainnet, "dusk-to-dusk-evm"), undefined);
  const cleared = profile("testnet", { ...DUSKEVM, VITE_DUSKEVM_DEPOSIT_SECONDS: "none" });
  assert.equal(text(cleared, "dusk-to-dusk-evm"), "");
  assert.equal(text(cleared, "dusk-evm-to-dusk"), "");
  assert.equal(text(cleared, "dusk-to-dusk-evm", { chain: CHAIN }), "~1 min");
  // A deployment sets or clears its own.
  const set = profile("mainnet", { VITE_BSC_MIGRATION_SECONDS: "none", VITE_SERVICE_BRIDGE_DELAY_SECONDS: "3600" });
  assert.equal(text(set, "bsc-to-dusk"), "");
  assert.equal(text(set, "dusk-to-bsc"), "~1 hour");
  assert.equal(text(set, "ethereum-to-dusk"), "~70 min");
});

test("what the chain says replaces the configured time, and a withdrawal has none without it", () => {
  const deposit = byId(testnet, "dusk-to-dusk-evm");
  // DuskEVM trailing Dusk by five minutes: a deposit takes that, not the configured minute.
  assert.deepEqual(routeTime(deposit, testnet, { chain: { deposit: { lagSeconds: 290 } } }), { seconds: 300, source: "chain" });
  assert.equal(text(testnet, "dusk-to-dusk-evm", { chain: { deposit: { lagSeconds: 290 } } }), "~5 min");
  const withdrawal = byId(testnet, "dusk-evm-to-dusk");
  assert.equal(routeTime(withdrawal, testnet), null);
  assert.deepEqual(routeTime(withdrawal, testnet, { chain: CHAIN }), { maturity: 604_800, prove: 1_700, report: 3_400, seconds: 608_200, source: "chain", wait: 604_800 });
  // A dispute game finality delay longer than the proof's maturity is the wait.
  assert.equal(routeTime(withdrawal, testnet, { chain: { withdrawal: { ...CHAIN.withdrawal, finalitySeconds: 1_209_600 } } }).wait, 1_209_600);
});

test("a withdrawal keeps its waits before there are two games to time outputs by", () => {
  // Just after launch, or a switch of game type: no output cadence yet.
  const withdrawal = byId(testnet, "dusk-evm-to-dusk");
  const early = { chain: { withdrawal: { ...CHAIN.withdrawal, outputSeconds: null } } };
  assert.deepEqual(routeTime(withdrawal, testnet, early), { maturity: 604_800, seconds: 604_800, source: "chain", wait: 604_800 });
  assert.equal(text(testnet, "dusk-evm-to-dusk", early), "~7 days");
  // The quote still says the days to wait, and leaves out only when proving can start.
  const when = buildQuote(withdrawal, "10", { balance: null, cfg: testnet, gasPrice: 1n, timing: early }).rows.find((row) => row.key === "when");
  assert.deepEqual([when.value, when.detail], ["Claim 7 days after you prove.", ""]);
});

test("this browser's own recent transfers measure a route the chain says nothing about", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const route = byId(mainnet, "dusk-to-bsc");
  const paid = (hours, daysAgo, extra = {}) => ({ destinationAt: now - daysAgo * 86_400_000 + hours * 3_600_000, routeId: route.id, sourceAt: now - daysAgo * 86_400_000, status: "completed", ...extra });
  // Two payouts after 1 and 2 hours: the middle of them, not the docs' 10 hours.
  assert.equal(measuredSeconds(route, [paid(1, 3), paid(2, 2)], now), 7_200);
  assert.equal(text(mainnet, "dusk-to-bsc", { now, transfers: [paid(1, 3), paid(2, 2)] }), "~2 hours");
  // One isn't enough, older than 30 days doesn't count, nor do other routes or pending ones.
  for (const transfers of [[paid(1, 3)], [paid(1, 31), paid(2, 40)], [paid(1, 3), paid(2, 2, { routeId: "bsc-to-dusk" })], [paid(1, 3), paid(2, 2, { status: "pending" })]])
    assert.equal(text(mainnet, "dusk-to-bsc", { now, transfers }), "~10 hours");
  // A withdrawal's time is always the chain's.
  const withdrawal = byId(testnet, "dusk-evm-to-dusk");
  assert.equal(routeTime(withdrawal, testnet, { now, transfers: [paid(1, 3, { routeId: withdrawal.id }), paid(2, 2, { routeId: withdrawal.id })] }), null);
});

test("a transfer is due from a minute before its usual time until five minutes after", () => {
  const sent = Date.UTC(2026, 10, 5, 19, 58);
  const entry = { routeId: "dusk-to-bsc", sourceAt: sent, status: "pending" };
  const due = (route, cfg, seconds, extra = {}) => arrivalDue(route, routeTime(route, cfg), { ...entry, ...extra }, sent + seconds * 1_000);
  // Mainnet's BSC payout takes about 10 hours: due around then, not the hour after it was sent.
  const payout = byId(mainnet, "dusk-to-bsc");
  assert.deepEqual([3_600, 35_940, 36_000, 36_300, 36_301].map((seconds) => due(payout, mainnet, seconds)), [false, true, true, true, false]);
  // A minute's route is due from when it's sent; until it's confirmed, from when it was sent here.
  const minute = { ...mainnet, service: { ...mainnet.service, delaySeconds: 60 } };
  assert.deepEqual([0, 360, 361].map((seconds) => due(payout, minute, seconds)), [true, true, false]);
  assert.equal(due(payout, minute, 30, { createdAt: new Date(sent).toISOString(), sourceAt: undefined }), true);
  // Without a usual time, or for a withdrawal, which arrives as it's claimed, never.
  assert.equal(due(byId(testnet, "dusk-to-ethereum"), testnet, 60), false);
  const withdrawal = byId(testnet, "dusk-evm-to-dusk");
  assert.equal(arrivalDue(withdrawal, { seconds: 60 }, entry, sent + 60_000), false);
});

test("every page says the same time for the same route", () => {
  const now = Date.UTC(2026, 9, 27, 9);
  const url = "https://bridge.example.org/#/transfer/x";
  const pages = (cfg, route, timing) => {
    const quote = buildQuote(route, "10", { balance: null, cfg, gasPrice: 1n, timing });
    const entry = { amountLux: "10000000000", hash: "ab".repeat(32), id: "x", parties: ["me"], routeId: route.id, sourceAt: now - 60_000, stage: "waiting_for_output", status: "pending" };
    const routeOf = (id) => routes(cfg).find((item) => item.id === id);
    return {
      // The card's route row, which its network lists show too.
      card: routeLine(route, cfg, { timing }),
      // The quote's row, in the card's details and the review's fee rows.
      quote: quote.rows.find((row) => row.key === "arrives")?.value ?? "",
      receipt: receiptModel(entry, { cfg, now, route, timing, url }).caption,
      activity: transfersModel([entry], { accounts: ["me"], cfg, locale: "en-GB", now, routeOf, timeZone: "UTC", timing }).groups.progress[0]?.subline ?? "",
    };
  };
  const cases = [
    [mainnet, "dusk-to-bsc", {}, "~10 hours"],
    [mainnet, "ethereum-to-dusk", {}, "~70 min"],
    [testnet, "dusk-to-dusk-evm", { chain: CHAIN }, "~1 min"],
    [testnet, "dusk-to-dusk-evm", { chain: { deposit: { lagSeconds: 290 } } }, "~5 min"],
  ];
  for (const [cfg, id, timing, expected] of cases) {
    const shown = pages(cfg, byId(cfg, id), timing);
    assert.match(shown.card, new RegExp(`^${expected} · `, "u"), id);
    assert.equal(shown.quote, expected, id);
    assert.equal(shown.receipt, `Takes ${expected}`, id);
    assert.match(shown.activity, new RegExp(` · takes ${expected}$`, "u"), id);
  }
  // A withdrawal: the whole on the card and the receipt; the Portal's 7 days
  // from the proof to the claim in the quote, the claim step and the review.
  const withdrawal = pages(testnet, byId(testnet, "dusk-evm-to-dusk"), { chain: CHAIN });
  assert.deepEqual([withdrawal.card.split(" · ")[0], withdrawal.receipt], ["~7 days", "Takes ~7 days"]);
  const route = byId(testnet, "dusk-evm-to-dusk");
  // Sent now, it says when that is: proved about an output later, 7 days after.
  const when = buildQuote(route, "10", { balance: null, cfg: testnet, gasPrice: 1n, locale: "en-GB", timeZone: "UTC", timing: { chain: CHAIN, now } }).rows.find((row) => row.key === "when");
  assert.deepEqual([when.value, when.detail], ["Claim from about 3 Nov, 09:28 UTC", "Claim 7 days after you prove. You can prove about 30 minutes after sending."]);
  const view = transferView({ hash: "0x01", stage: "ready_to_prove", status: "pending" }, { cfg: testnet, route, timing: { chain: CHAIN } });
  assert.equal(view.steps[2].detail, "7 days after you prove");
  assert.equal(actionLead("prove", {}, { maturity: view.time.maturity, maxLux: 1n }).line, "No DUSK moves now. Claim 7 days after you prove.");
  // Unknown on this network: no time anywhere, and no Arrives line in the review.
  const unknown = pages(testnet, byId(testnet, "dusk-to-ethereum"), {});
  assert.deepEqual(unknown, { activity: "Sent Today, 08:59 UTC", card: "1 DUSK bridge fee", quote: "", receipt: "" });
  const checks = reviewChecks(byId(testnet, "dusk-to-ethereum"), { cfg: testnet, destination: "0x1", duskAccount: "a", evm: {}, quote: buildQuote(byId(testnet, "dusk-to-ethereum"), "10", { cfg: testnet }), reads: {} });
  assert.ok(checks.every((check) => !/arrive|usually|within/iu.test(check.html)));
});
