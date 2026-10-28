import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { buildQuote, parseAmount, routeDuskFees } from "./quote.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = {
  VITE_BRIDGE_PROFILE: "testnet",
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3".repeat(64),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "1".repeat(64),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "2".repeat(64),
};
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const routes = Object.fromEntries(buildRoutes(cfg).map((route) => [route.mode, route]));
const DUSK = 1_000_000_000n;
const rows = (quote) => Object.fromEntries(quote.rows.map((row) => [row.key, [row.value, row.detail].filter(Boolean).join(" | ")]));

test("amounts take at most 9 decimals and nothing else", () => {
  assert.deepEqual(parseAmount("25"), { error: "", lux: 25n * DUSK });
  assert.deepEqual(parseAmount("1,000.5"), { error: "", lux: 1_000_500_000_000n });
  assert.deepEqual(parseAmount("1,234,567"), { error: "", lux: 1_234_567n * DUSK });
  // A decimal comma reads as one; a comma that could be either is asked about.
  assert.deepEqual(parseAmount("0,5"), { error: "", lux: DUSK / 2n });
  assert.deepEqual(parseAmount("12,75"), { error: "", lux: 12_750_000_000n });
  assert.equal(parseAmount("1,234").error, "Is that 1234 or 1.234? Write it without the comma.");
  for (const odd of ["1,2,3", "1,23.4", ",5", "1,234,5"]) assert.equal(parseAmount(odd).error, "Use a point for decimals, like 0.5.", odd);
  assert.deepEqual(parseAmount("0.000000001"), { error: "", lux: 1n });
  assert.equal(parseAmount("0.0000000001").error, "Use at most 9 decimals.");
  assert.equal(parseAmount("1e3").error, "Enter an amount like 25 or 0.5.");
  assert.equal(parseAmount("0").error, "Enter an amount above 0.");
  assert.deepEqual(parseAmount("  "), { error: "", lux: null });
});

test("a deposit quote shows the fee as a maximum and its usual cost, in DUSK", () => {
  const quote = buildQuote(routes["duskevm-deposit"], "25", { balance: 1_483_920_000_000n, cfg, gasPrice: 1n });
  assert.deepEqual(rows(quote), {
    // DuskEVM testnet's configured time, until the chain's own is read.
    arrives: "~1 min",
    fee: "up to 0.005 DUSK | usually about 0.002 DUSK",
    receive: "25 DUSK on DuskEVM",
    send: "25 DUSK",
  });
  assert.equal(quote.leaves, "up to 25.005 DUSK");
  assert.equal(quote.error, "");
  // Max leaves room for the fee at its limit.
  assert.equal(quote.maxLux, 1_483_920_000_000n - 5_000_000n);
  // The fee follows the node's price.
  assert.match(rows(buildQuote(routes["duskevm-deposit"], "25", { cfg, gasPrice: 3n })).fee, /^up to 0\.015 DUSK/u);
});

test("the bridge fee comes off what arrives, and a send at or under it is refused", () => {
  const quote = buildQuote(routes["service-transfer"], "50", { balance: 100n * DUSK, cfg, gasPrice: 1n });
  assert.equal(rows(quote).bridge, "1 DUSK, from the amount");
  // More than the balance: the card's button says so.
  const short = buildQuote(routes["service-transfer"], "5000", { balance: 10_000_000_000n, cfg, gasPrice: 1n });
  assert.equal(short.insufficient, true);
  assert.equal(buildQuote(routes["service-transfer"], "5", { balance: 10_000_000_000n, cfg, gasPrice: 1n }).insufficient, undefined);
  // Paid out as the chain's own DUSK token.
  assert.equal(rows(quote).receive, "49 ERC20 DUSK on Ethereum (Sepolia)");
  assert.equal(rows(quote).fee, "up to 0.0025 DUSK | usually about 0.0019 DUSK");
  // No time is known for this testnet payout, so none is quoted.
  assert.equal(rows(quote).arrives, undefined);
  assert.match(buildQuote(routes["service-transfer"], "1", { cfg }).error, /^Send more than the 1 DUSK bridge fee/u);
  assert.match(
    buildQuote(routes["service-transfer"], "100", { balance: 100n * DUSK, cfg, gasPrice: 1n }).error,
    /^That's more than you have after the network fee\. You can send up to 99\.9975 DUSK\./u,
  );
});

test("a migration prices both wallet steps in ETH until the allowance covers it", () => {
  const ctx = {
    balance: 2_500n * 10n ** 18n,
    cfg,
    evmGas: { approve: 46_000n, migrate: 60_000n, priceWei: 2_000_000_000n },
  };
  const both = buildQuote(routes.migration, "1000", ctx);
  assert.equal(rows(both).send, "1,000 ERC20 DUSK");
  assert.equal(rows(both).fee, "about 0.00021 ETH | two wallet steps");
  assert.equal(rows(both).receive, "1,000 DUSK on Dusk");
  assert.equal(both.steps, 2);
  const approved = buildQuote(routes.migration, "1000", { ...ctx, allowanceWei: 1_000n * 10n ** 18n });
  assert.equal(approved.steps, 1);
  assert.equal(rows(approved).fee, "about 0.00012 ETH | one wallet step");
  assert.match(buildQuote(routes.migration, "3000", ctx).error, /^That's more than the 2,500 ERC20 DUSK in this wallet\./u);
  // ERC20 DUSK finer than a Lux can't be migrated, so Max stops at whole Lux.
  assert.equal(buildQuote(routes.migration, "", { ...ctx, balance: 10n ** 18n + 1n }).maxLux, DUSK);
});

test("a withdrawal quotes its DuskEVM step and the two Dusk steps after it", () => {
  const quote = buildQuote(routes["duskevm-withdrawal"], "200", {
    balance: 312n * 10n ** 18n,
    cfg,
    // DuskEVM testnet: 138,439 gas at 10.001 gwei for a withdrawal (Oct).
    evmGas: { priceWei: 10_001_000_000n, withdraw: 138_439n },
    gasPrice: 1n,
  });
  assert.deepEqual(rows(quote), {
    fee: "about 0.0014 DUSK",
    "fee-dusk": "up to 0.051 DUSK a step | to prove, then to claim",
    receive: "200 DUSK on Dusk",
    send: "200 DUSK on DuskEVM",
  });
  // A proof and a claim share one limit, 50M plus the withdrawal's own gas
  // and at least a 1M bound, so each step reads the same "up to" everywhere.
  const known = routeDuskFees(routes["duskevm-withdrawal"], { gasPrice: 1n, withdrawalGas: 519_542n });
  assert.equal(known.claim.maxLux, 51_000_000n);
  assert.equal(known.prove.maxLux, 51_000_000n);
  assert.equal(routeDuskFees(routes["duskevm-withdrawal"], { gasPrice: 1n }).claim.maxLux, 51_000_000n);
  assert.equal(routeDuskFees(routes["duskevm-withdrawal"], { gasPrice: 2n, withdrawalGas: 9_000_000n }).prove.maxLux, 118_000_000n);

  // Without DuskEVM's gas price there's no Max, and the whole balance is too much.
  const unpriced = { balance: 312n * 10n ** 18n, cfg, evmGas: { priceWei: null, withdraw: 138_439n }, gasPrice: 1n };
  assert.equal(buildQuote(routes["duskevm-withdrawal"], "200", unpriced).maxLux, null);
  assert.equal(buildQuote(routes["duskevm-withdrawal"], "200", unpriced).error, "");
  assert.equal(buildQuote(routes["duskevm-withdrawal"], "312", unpriced).error, "That's more than you have on DuskEVM, with its network fee.");
  assert.ok(quote.maxLux > 311n * 10n ** 9n);
  // Nothing arrives without the two Dusk steps: it says when they can be
  // taken, from what the chain said, and nothing until it has.
  const read = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
  const timed = rows(buildQuote(routes["duskevm-withdrawal"], "200", { cfg, gasPrice: 1n, timing: read }));
  assert.equal(timed.when, "Claim 7 days after you prove. | You can prove about 30 minutes after sending.");
  assert.equal(timed.arrives, undefined);
});
