import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { actionLead, receiptModel, reviewChecks, routeLine, transfersModel } from "./page-models.js";
import { buildQuote } from "./quote.js";
import { aboutTime, measuredSeconds, routeTime, routeTimeText } from "./route-times.js";
import { transferView } from "./transfer-view.js";

const DUSKEVM = {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
};
// DuskEVM on mainnet needs every endpoint set; none is a default there.
const MAINNET_DUSKEVM = {
  ...DUSKEVM,
  VITE_DUSKEVM_CHAIN_ID: "744",
  VITE_DUSKEVM_EXPLORER_URL: "https://explorer.example.org",
  VITE_DUSKEVM_L1_BRIDGE_RPC_URL: "https://rpc.example.org/l1",
  VITE_DUSKEVM_RPC_URL: "https://rpc.example.org",
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
const mainnet = profile("mainnet", MAINNET_DUSKEVM);
const routes = (cfg) => buildRoutes(cfg);
const byId = (cfg, id) => routes(cfg).find((route) => route.id === id);
const text = (cfg, id, timing) => routeTimeText(routeTime(byId(cfg, id), cfg, timing));
// What DuskEVM testnet's chains said on 27 Oct 2026.
const CHAIN = Object.freeze({
  deposit: { lagSeconds: 35 },
  withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 },
});

test("a time reads as an estimate, rounded up on a scale that reads at a glance", () => {
  assert.deepEqual([45, 172, 600, 660, 3_400, 3_600, 4_000, 5_400, 5_460, 36_000, 608_200].map(aboutTime), [
    "~1 min", "~3 min", "~10 min", "~15 min", "~1 hour", "~1 hour", "~70 min", "~90 min", "~2 hours", "~10 hours", "~7 days",
  ]);
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
  // DuskEVM on mainnet has no configured times: only what its chains say.
  assert.equal(text(mainnet, "dusk-to-dusk-evm"), "");
  assert.equal(text(mainnet, "dusk-evm-to-dusk"), "");
  assert.equal(text(mainnet, "dusk-to-dusk-evm", { chain: CHAIN }), "~1 min");
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
  assert.deepEqual(routeTime(withdrawal, testnet, { chain: CHAIN }), { report: 3_400, seconds: 608_200, source: "chain", wait: 604_800 });
  // A dispute game finality delay longer than the proof's maturity is the wait.
  assert.equal(routeTime(withdrawal, testnet, { chain: { withdrawal: { ...CHAIN.withdrawal, finalitySeconds: 1_209_600 } } }).wait, 1_209_600);
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
  const withdrawal = byId(mainnet, "dusk-evm-to-dusk");
  assert.equal(routeTime(withdrawal, mainnet, { now, transfers: [paid(1, 3, { routeId: withdrawal.id }), paid(2, 2, { routeId: withdrawal.id })] }), null);
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
      activity: transfersModel([entry], { accounts: ["me"], cfg, now, routeOf, timeZone: "UTC", timing }).groups.progress[0]?.subline ?? "",
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
  // A withdrawal: the whole on the card, the quote and the receipt; its proof's wait in the review.
  const withdrawal = pages(testnet, byId(testnet, "dusk-evm-to-dusk"), { chain: CHAIN });
  assert.deepEqual([withdrawal.card.split(" · ")[0], withdrawal.quote, withdrawal.receipt], ["~7 days", "~7 days", "Takes ~7 days"]);
  const view = transferView({ hash: "0x01", stage: "ready_to_prove", status: "pending" }, { cfg: testnet, route: byId(testnet, "dusk-evm-to-dusk"), timing: { chain: CHAIN } });
  assert.equal(view.steps[2].detail, "~7 days after the proof");
  assert.equal(actionLead("prove", {}, { maxLux: 1n, wait: view.time.wait }).line, "No DUSK moves now. Claim ~7 days after the proof.");
  // Unknown on this network: no time anywhere, and no Arrives line in the review.
  const unknown = pages(testnet, byId(testnet, "dusk-to-ethereum"), {});
  assert.deepEqual(unknown, { activity: "Sent Tue 27 Oct, 08:59 UTC", card: "1 DUSK bridge fee", quote: "", receipt: "" });
  const checks = reviewChecks(byId(testnet, "dusk-to-ethereum"), { cfg: testnet, destination: "0x1", duskAccount: "a", evm: {}, quote: buildQuote(byId(testnet, "dusk-to-ethereum"), "10", { cfg: testnet }), reads: {} });
  assert.ok(checks.every((check) => !/arrive|usually|within/iu.test(check.html)));
});
