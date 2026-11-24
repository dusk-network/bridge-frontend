import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { amountForInput, formatDuskPlain, formatLux } from "./format.js";
import { duskEvmGasLimit } from "./evm-reads.js";
import { buildQuote, duskEvmFeeMax, parseAmount, routeDuskFees } from "./quote.js";

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
  assert.deepEqual(parseAmount(",5"), { error: "", lux: DUSK / 2n });
  assert.deepEqual(parseAmount("0,123"), { error: "", lux: 123_000_000n });
  assert.deepEqual(parseAmount("1.000,5"), { error: "", lux: 1_000_500_000_000n });
  for (const odd of ["1,2,3", "1,23.4", "1,234,5"]) assert.equal(parseAmount(odd).error, "Use a point for decimals, like 0.5.", odd);
  assert.deepEqual(parseAmount("0.000000001"), { error: "", lux: 1n });
  assert.equal(parseAmount("0.0000000001").error, "Max 9 decimals");
  assert.equal(parseAmount("1e3").error, "Enter an amount like 25 or 0.5.");
  assert.equal(parseAmount("0").error, "Enter an amount above 0.");
  assert.deepEqual(parseAmount("  "), { error: "", lux: null });
});

test("a deposit quote shows the fee as a maximum, in DUSK", () => {
  const quote = buildQuote(routes["duskevm-deposit"], "25", { balance: 1_483_920_000_000n, cfg, gasPrice: 1n });
  assert.deepEqual(rows(quote), {
    // DuskEVM testnet's configured time, until the chain's own is read.
    arrives: "~1 min",
    fee: "up to 0.005 DUSK",
    receive: "25 DUSK on DuskEVM",
    send: "25 DUSK",
  });
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
  assert.equal(rows(quote).receive, "49 ERC20 DUSK on Sepolia");
  assert.equal(rows(quote).fee, "up to 0.0025 DUSK");
  // What leaves the account, as Dusk Wallet asks for it: the amount and the network fee, the bridge's taken from the amount.
  assert.equal(rows(quote).total, "up to 50.0025 DUSK");
  assert.deepEqual([quote.fees.label, quote.fees.value, quote.fees.detail], ["Fees", "up to 1.0025 DUSK", "1 DUSK of it from the amount"]);
  // No time is known for this testnet payout, so none is quoted.
  assert.equal(rows(quote).arrives, undefined);
  assert.equal(buildQuote(routes["service-transfer"], "1", { cfg }).error, "Send more than the 1 DUSK bridge fee");
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
  assert.equal(rows(both).fee, "~0.00021 ETH");
  assert.equal(rows(both).receive, "1,000 DUSK on Dusk");
  assert.equal(both.steps, 2);
  const approved = buildQuote(routes.migration, "1000", { ...ctx, allowanceWei: 1_000n * 10n ** 18n });
  assert.equal(approved.steps, 1);
  assert.equal(rows(approved).fee, "~0.00012 ETH");
  assert.match(buildQuote(routes.migration, "3000", ctx).error, /^That's more than the 2,500 ERC20 DUSK in this wallet\./u);
  // ERC20 DUSK finer than a Lux can't be migrated, so Max stops at whole Lux.
  assert.equal(buildQuote(routes.migration, "", { ...ctx, balance: 10n ** 18n + 1n }).maxLux, DUSK);
});

// DuskEVM testnet as a withdrawal of 138,439 gas finds it (Nov): a 10 gwei base fee and a 0.001 gwei
// tip; the limit the wallet is asked for, a fifth over; and its GasPriceOracle's getL1FeeUpperBound
// for 516 bytes and getOperatorFee at that limit.
const DUSK_EVM_GAS = {
  baseFeeWei: 10_000_000_000n,
  // Estimated for the very call quoted.
  exact: true,
  l1FeeMaxWei: 379n,
  limit: 166_127n,
  operatorFeeWei: 24_071_158_578_548_300n,
  priceWei: 10_001_000_000n,
  tipWei: 1_000_000n,
  withdraw: 138_439n,
};

test("a withdrawal's DuskEVM fee is the most the chain can charge it, at the gas limit and price caps the wallet is asked for", () => {
  // The limit at twice the base fee and the tip, the operator fee, and the L1 data fee twice and a Lux.
  const most = 166_127n * 20_001_000_000n + 24_071_158_578_548_300n + 2n * 379n + 10n ** 9n;
  assert.equal(most, 27_393_865_705_549_058n);
  assert.equal(duskEvmFeeMax(DUSK_EVM_GAS), most);
  assert.equal(duskEvmGasLimit(138_439n), 166_127n);
  const quote = buildQuote(routes["duskevm-withdrawal"], "200", { balance: 312n * 10n ** 18n, cfg, evmGas: DUSK_EVM_GAS, gasPrice: 1n });
  // What the wallet is asked for: that limit, and the price caps the fee is the most of.
  assert.deepEqual([quote.evmFeeWei, quote.evmGasLimit, quote.evmMaxFeePerGas, quote.evmMaxPriorityFeePerGas, quote.waiting ?? ""], [most, 166_127n, 20_001_000_000n, 1_000_000n, ""]);
  // Max keeps that aside, no more and no less.
  assert.equal(quote.maxLux, (312n * 10n ** 18n - most) / 10n ** 9n);
  // At least what testnet's two withdrawals of that gas were charged, and not much more.
  for (const charged of [21_777_138_444_933_323n, 21_780_567_040_362_924n]) {
    assert.ok(most >= charged);
    assert.ok(most * 10n < charged * 13n);
  }
  // Without any one part, there's no figure, and no Max.
  for (const part of Object.keys(DUSK_EVM_GAS).filter((key) => !["exact", "priceWei", "withdraw"].includes(key)))
    assert.equal(buildQuote(routes["duskevm-withdrawal"], "200", { balance: 312n * 10n ** 18n, cfg, evmGas: { ...DUSK_EVM_GAS, [part]: null }, gasPrice: 1n }).maxLux, null, part);
});

test("Max on DuskEVM leaves what the chain checks the balance for, even when the L1 data fee moves before it's mined", () => {
  // A balance of exactly 1 DUSK and the fee: Max sends 1 DUSK and keeps the fee.
  const fee = duskEvmFeeMax(DUSK_EVM_GAS);
  const balance = 10n ** 18n + fee;
  const quote = buildQuote(routes["duskevm-withdrawal"], "", { balance, cfg, evmGas: DUSK_EVM_GAS, gasPrice: 1n });
  assert.equal(quote.maxLux, 10n ** 9n);
  // What OP Stack checks before it's taken: the limit at the price cap, the operator fee at the limit,
  // and the L1 data fee then, here four times the 223 wei a withdrawal paid. Left over: just under a Lux.
  const left = balance - quote.maxLux * 10n ** 9n;
  const checked = (l1) => 166_127n * 20_001_000_000n + 24_071_158_578_548_300n + l1;
  assert.ok(left >= checked(892n));
  assert.equal(left - checked(892n), 999_999_866n);
  // Without the Lux, that check came 134 wei short.
  assert.equal(left - 10n ** 9n - checked(892n), -134n);
});

test("a withdrawal isn't reviewed until its fee is worked out for the call that goes out, and says when it couldn't be", () => {
  const quote = (evmGas, amount = "200") => buildQuote(routes["duskevm-withdrawal"], amount, { balance: 312n * 10n ** 18n, cfg, evmGas, gasPrice: 1n });
  // Read for another amount or account, or with the gas a withdrawal usually needs: shown, with Max, but nothing the wallet is asked for.
  const other = quote({ ...DUSK_EVM_GAS, exact: false });
  assert.deepEqual([other.evmFeeWei, other.evmGasLimit, other.evmMaxFeePerGas, other.waiting], [duskEvmFeeMax(DUSK_EVM_GAS), null, null, "fee"]);
  assert.ok(other.maxLux > 0n);
  // Its estimate failed, or a part of its fee didn't come back with it: said, to try again.
  assert.equal(quote({ ...DUSK_EVM_GAS, exact: false, failed: true }).waiting, "fee-failed");
  for (const part of ["baseFeeWei", "l1FeeMaxWei", "operatorFeeWei", "tipWei"]) assert.equal(quote({ ...DUSK_EVM_GAS, [part]: null }).waiting, "fee-failed", part);
  // No amount yet: nothing waits.
  assert.equal(quote({ ...DUSK_EVM_GAS, exact: false }, "").waiting ?? "", "");
});

test("a withdrawal quotes its DuskEVM step and the two Dusk steps after it", () => {
  const quote = buildQuote(routes["duskevm-withdrawal"], "200", {
    balance: 312n * 10n ** 18n,
    cfg,
    evmGas: DUSK_EVM_GAS,
    gasPrice: 1n,
  });
  assert.deepEqual(rows(quote), {
    fee: "up to 0.0274 DUSK",
    "fee-dusk": "up to 0.051 DUSK each",
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
  // taken, from what the chain said, and nothing until it has. Sent now and
  // proved about an output later (1,700 s), it can be claimed 7 days after.
  const read = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } }, now: Date.UTC(2026, 9, 29, 11) };
  const timed = rows(buildQuote(routes["duskevm-withdrawal"], "200", { cfg, gasPrice: 1n, locale: "en-GB", timeZone: "Europe/Amsterdam", timing: read }));
  assert.equal(timed.when, "Claim from about 5 Nov, 12:28 CET | Claim 7 days after you prove. You can prove about 30 minutes after sending.");
  assert.equal(timed.arrives, undefined);
  // A game's finality longer than the proof's maturity: the date waits for it, as the Portal does.
  const slow = { ...read, chain: { withdrawal: { ...read.chain.withdrawal, finalitySeconds: 1_209_600 } } };
  const later = rows(buildQuote(routes["duskevm-withdrawal"], "200", { cfg, gasPrice: 1n, locale: "en-GB", timeZone: "Europe/Amsterdam", timing: slow }));
  assert.equal(later.when, "Claim from about 12 Nov, 12:28 CET | Claim 7 days after you prove. You can prove about 30 minutes after sending.");
  // Before outputs can be timed, no date: the wait alone.
  const untimed = { ...read, chain: { withdrawal: { ...read.chain.withdrawal, outputSeconds: null } } };
  assert.equal(rows(buildQuote(routes["duskevm-withdrawal"], "200", { cfg, gasPrice: 1n, timing: untimed })).when, "Claim 7 days after you prove.");
});

test("amounts are read as the browser's language writes them: never as another amount", () => {
  const inDutch = () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "nl-NL" } });
    return () => Object.defineProperty(globalThis, "navigator", before);
  };
  const restore = inDutch();
  try {
    assert.equal(parseAmount("1,5").lux, 1_500_000_000n);
    assert.equal(parseAmount("1,001").lux, 1_001_000_000n);
    assert.equal(parseAmount("1.001,5").lux, 1_001_500_000_000n);
    assert.equal(parseAmount("1.000.000").lux, 1_000_000_000_000_000n);
    assert.equal(parseAmount("1.5").lux, 1_500_000_000n);
    assert.equal(parseAmount("0.125").lux, 125_000_000n);
    // A point before three digits could mean a thousand or one: it's asked.
    assert.equal(parseAmount("1.001").lux, null);
    assert.match(parseAmount("1.001").error, /1001 or 1,001/u);
    // What the page writes is read back as the same amount, or refused.
    assert.equal(parseAmount(formatLux(1_500_000_000n)).lux, 1_500_000_000n);
    assert.equal(parseAmount(formatLux(1_001_000_000_000n)).lux, null);
    assert.equal(parseAmount(amountForInput(1_234_000_000n)).lux, 1_234_000_000n);
    assert.equal(formatLux(1_484_923_500_000n), "1.484,9235");
    // What a contract call takes stays plain.
    assert.equal(formatDuskPlain(1_484_923_500_000n), "1484.9235");
  } finally {
    restore();
  }
  // In English, as before.
  assert.equal(parseAmount("1.001").lux, 1_001_000_000n);
  assert.equal(parseAmount("1,001").lux, null);
  assert.equal(formatLux(1_484_923_500_000n), "1,484.9235");
});

test("nothing a transaction takes is read back from a formatted amount: those follow the browser's language", () => {
  const formatted = /format(?:Lux|Dusk|UnitsGrouped)\([^)]*\)\s*\.replace\(\/,/u;
  for (const name of readdirSync(new URL(".", import.meta.url))) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    assert.doesNotMatch(readFileSync(new URL(name, import.meta.url), "utf8"), formatted, name);
  }
});

// Hyperlane's routes on testnet, by ID.
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));
const BRIDGE_FEE = 16_876_000_000n;

test("an amount of a token takes its own decimals, within what one transfer carries", () => {
  assert.deepEqual(parseAmount("95.085867", 6), { error: "", lux: 95_085_867n });
  assert.equal(parseAmount("1.1234567", 6).error, "Max 6 decimals");
  assert.deepEqual(parseAmount("0,5", 6), { error: "", lux: 500_000n });
  const eurd = byId["dusk-to-sepolia-eurd"];
  assert.equal(buildQuote(eurd, "18446744073709.551616", { cfg }).error, "That's more than one transfer can carry.");
  assert.equal(buildQuote(eurd, "18446744073709.551615", { cfg }).error, "");
});

test("DUSK to Sepolia pays the route's own quote and the network fee on top, in DUSK", () => {
  const route = byId["dusk-to-sepolia"];
  const quote = buildQuote(route, "1", { balance: 20n * DUSK, cfg, gasPrice: 1n, hyperlane: { fee: BRIDGE_FEE } });
  // The wallet asks for the DUSK and its bridge fee in one deposit: the review's total says the most that leaves.
  assert.deepEqual(rows(quote), {
    arrives: "~20 s",
    bridge: "16.876 DUSK | on top of the amount",
    fee: "up to 0.005 DUSK",
    receive: "1 DUSK on Sepolia",
    send: "1 DUSK",
    total: "up to 17.881 DUSK",
  });
  // Max leaves the bridge fee and the network fee at its limit.
  assert.equal(quote.maxLux, 20n * DUSK - BRIDGE_FEE - 5_000_000n);
  const over = buildQuote(route, "4", { balance: 20n * DUSK, cfg, gasPrice: 1n, hyperlane: { fee: BRIDGE_FEE } });
  assert.deepEqual([over.insufficient, over.error], [true, "That's more than you have after the fees. You can send up to 3.119 DUSK."]);
  // Before the route's quote is read, no fee is guessed: a dash, and no Max.
  const unread = buildQuote(route, "1", { balance: 20n * DUSK, cfg, gasPrice: 1n });
  assert.deepEqual([rows(unread).bridge, unread.maxLux, rows(unread).total], ["— | on top of the amount", null, undefined]);
});

test("EURd to Sepolia approves the route first where it can't take the amount, and pays its fees in DUSK", () => {
  const route = byId["dusk-to-sepolia-eurd"];
  const ctx = { balance: 20n * DUSK, cfg, gasPrice: 1n, hyperlane: { allowance: 0n, fee: BRIDGE_FEE, tokenBalance: 49_805_396_789n } };
  const quote = buildQuote(route, "10", ctx);
  assert.deepEqual(rows(quote), {
    arrives: "~20 s",
    bridge: "16.876 DUSK",
    fee: "up to 0.008 DUSK",
    receive: "10 EURd on Sepolia",
    send: "10 EURd",
  });
  assert.deepEqual([quote.steps, quote.maxLux, quote.bridgeFeeLux, quote.gasMaxLux], [2, 49_805_396_789n, BRIDGE_FEE, 8_000_000n]);
  // An approval that covers it: one step.
  assert.equal(buildQuote(route, "10", { ...ctx, hyperlane: { ...ctx.hyperlane, allowance: 10_000_000n } }).steps, 1);
  // More than it holds, or too little DUSK for the fees.
  const more = buildQuote(route, "50000", ctx);
  assert.deepEqual([more.insufficient, more.short, more.error], [true, undefined, "That's more than the 49,805.396789 EURd you have."]);
  const poor = buildQuote(route, "10", { ...ctx, balance: 10n * DUSK });
  assert.deepEqual([poor.insufficient, poor.short, poor.error], [true, "DUSK", "The fees take up to 16.884 DUSK, more than the 10 DUSK you have."]);
});

test("from Sepolia, one call pays the token's delivery fee as its value, in ETH", () => {
  const route = byId["sepolia-to-dusk-usdd"];
  const evm = { deliveryFeeWei: 132_000_000_001n, gas: 276_237n, gasCoinWei: 29_971_344_846_295_543n, priceWei: 2_000_000_000n };
  const quote = buildQuote(route, "32.156353", { balance: 71_508_029n, cfg, evm });
  assert.deepEqual(rows(quote), {
    arrives: "~1 min",
    bridge: "<0.000001 ETH",
    fee: "~0.00055 ETH",
    receive: "32.156353 USDd on Dusk",
    send: "32.156353 USDd",
  });
  assert.deepEqual([quote.maxLux, quote.bridgeFeeWei, quote.evmFeeWei], [71_508_029n, 132_000_000_001n, 552_474_000_000_000n]);
  assert.equal(buildQuote(route, "72", { balance: 71_508_029n, cfg, evm }).error, "That's more than the 71.508029 USDd in this wallet.");
  const poor = buildQuote(route, "1", { balance: 71_508_029n, cfg, evm: { ...evm, gasCoinWei: 1_000n } });
  assert.deepEqual([poor.short, poor.error], ["ETH", "The fees take ~0.00055 ETH, more than the 0.000000000000001 ETH in this wallet."]);
  // Unread, the fees are said in what pays them.
  assert.equal(rows(buildQuote(route, "1", { cfg })).fee, "paid in ETH");
});

test("a Hyperlane route's time is said to the 10 seconds under a minute, and what this browser's transfers took once there are two", () => {
  const out = byId["dusk-to-sepolia-eurd"];
  const now = Date.parse("2026-11-18T12:00:00Z");
  const took = (seconds, minutesAgo) => ({ destinationAt: now - minutesAgo * 60_000 + seconds * 1_000, routeId: out.id, sourceAt: now - minutesAgo * 60_000, status: "completed" });
  assert.equal(rows(buildQuote(out, "1", { cfg, timing: { now, transfers: [took(31, 9), took(44, 5)] } })).arrives, "~50 s");
  assert.equal(rows(buildQuote(byId["sepolia-to-dusk"], "1", { cfg, timing: { now, transfers: [] } })).arrives, "~1 min");
});

test("an approval not read yet, or not readable, decides no steps: the review waits for it, never two steps by default", () => {
  const route = byId["dusk-to-sepolia-eurd"];
  const ctx = { balance: 20n * DUSK, cfg, gasPrice: 1n, hyperlane: { allowance: null, fee: BRIDGE_FEE, tokenBalance: 49_805_396_789n } };
  const reading = buildQuote(route, "10", ctx);
  assert.deepEqual([reading.steps, reading.waiting, reading.error], [null, "reading", ""]);
  assert.doesNotMatch(rows(reading).fee, /two wallet steps/u);
  const failed = buildQuote(route, "10", { ...ctx, hyperlane: { ...ctx.hyperlane, allowanceFailed: true } });
  assert.deepEqual([failed.steps, failed.waiting], [null, "failed"]);
  // Read: one step or two, nothing to wait for.
  assert.deepEqual([buildQuote(route, "10", { ...ctx, hyperlane: { ...ctx.hyperlane, allowance: 10_000_000n } })].map((quote) => [quote.steps, quote.waiting]), [[1, undefined]]);
  // DUSK's route takes no approval.
  assert.equal(buildQuote(byId["dusk-to-sepolia"], "1", { ...ctx, hyperlane: { fee: BRIDGE_FEE } }).waiting, undefined);
});

test("a bridge fee larger than the amount sent is noted, and blocks nothing", () => {
  const route = byId["dusk-to-sepolia"];
  const quote = (amount, hyperlane = { fee: BRIDGE_FEE }) => buildQuote(route, amount, { balance: 2_000n * DUSK, cfg, gasPrice: 1n, hyperlane });
  // 16.876 DUSK to send 1 DUSK: said, and it can still be reviewed.
  assert.deepEqual([quote("1").feeOverAmount, quote("1").error, quote("1").insufficient], [true, "", undefined]);
  assert.equal(quote("16.876").feeOverAmount, false);
  assert.equal(quote("20").feeOverAmount, false);
  // Nothing typed, or the fee not read yet: nothing to compare.
  assert.equal(quote("").feeOverAmount, false);
  assert.equal(quote("1", {}).feeOverAmount, false);
  // A fee in another coin than the amount isn't compared: EURd's is in DUSK, Sepolia's in ETH.
  const eurd = buildQuote(byId["dusk-to-sepolia-eurd"], "1", { balance: 2_000n * DUSK, cfg, gasPrice: 1n, hyperlane: { allowance: 0n, fee: BRIDGE_FEE, tokenBalance: 10n ** 9n } });
  assert.equal(eurd.feeOverAmount, false);
  const back = buildQuote(byId["sepolia-to-dusk"], "0.0000001", { balance: DUSK, cfg, evm: { deliveryFeeWei: 132_000_000_001n, gas: 1n, gasCoinWei: 10n ** 18n, priceWei: 1n } });
  assert.equal(back.feeOverAmount, false);
});

test("each quote gives its fees as one figure, for the review to show, with their split behind it", () => {
  const fees = (route, amount, extra = {}) => buildQuote(routes[route] ?? byId[route], amount, { balance: 2_000n * DUSK, cfg, gasPrice: 1n, ...extra }).fees;
  // One network fee: as it is.
  assert.deepEqual(fees("duskevm-deposit", "25"), { key: "fees", label: "Network fee", value: "up to 0.005 DUSK" });
  // The bridge's fee and the network's, summed; the bridge's taken from the amount, as said.
  assert.deepEqual(fees("service-transfer", "50"), { detail: "1 DUSK of it from the amount", key: "fees", label: "Fees", value: "up to 1.0025 DUSK" });
  // DUSK to Sepolia: both in DUSK.
  assert.deepEqual(fees("dusk-to-sepolia", "1", { hyperlane: { fee: BRIDGE_FEE } }), { key: "fees", label: "Fees", value: "up to 16.881 DUSK" });
  assert.equal(fees("dusk-to-sepolia", "1", { hyperlane: {} }).value, "—");
  // From Sepolia: both in ETH, the network's once its gas is read.
  const evm = { deliveryFeeWei: 500_000_000_000_000n, gas: 1n, gasCoinWei: 10n ** 18n, priceWei: 50_000_000_000_000n };
  assert.equal(fees("sepolia-to-dusk", "1", { balance: DUSK, evm }).value, "~0.00055 ETH");
  assert.equal(fees("sepolia-to-dusk", "1", { balance: DUSK, evm: { ...evm, gas: null } }).value, "~0.0005 ETH and the network fee");
  // A withdrawal: DuskEVM's now, then the most the proof and the claim cost on Dusk.
  assert.equal(fees("duskevm-withdrawal", "200", { balance: 312n * 10n ** 18n, evmGas: DUSK_EVM_GAS }).value, "up to 0.0274 DUSK, then up to 0.102 DUSK on Dusk");
});
