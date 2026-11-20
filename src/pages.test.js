import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encodeDepositArgs } from "@dusk-network/networks/duskevm";
import { withdrawalGasLimit } from "@dusk-network/networks/gas";
import { releaseFor } from "@duskdomains/sdk/releases";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { actionLead, actionPrivacy, addDuskOffer, availableLine, balanceLine, feeNotes, feesTotal, openApproval, pricedReview, receiptModel, recipientLine, replacedLine, reviewChecks, revokeReview, routeDetailRows, routeLines, transfersModel } from "./page-models.js";
import { buildQuote, withdrawalStepMax } from "./quote.js";
import { activityPanel, cardPage, cardRegions, contractsSheet, footer, header, networkSheet, receiptPage, reviewSheet, walletsSheet } from "./views.js";
import { formatDateTime } from "./format.js";
import { chainMark, pairMark } from "./icons.js";
import { driverJson, loadDataDriver } from "./data-driver.js";
import { createTracking } from "./tracking.js";
import { short } from "./transfer-view.js";
import { contractCreditLog, messagePassedLog, u256, withdrawalInput } from "./withdrawals.fixtures.js";

const DUSKEVM = {
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "3b7d562aa0e6b94ce29c5ce2a6f0587ad771afdace86abb0baf66f93e49548cd",
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d",
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9",
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
const routesOf = (cfg) => Object.fromEntries(buildRoutes(cfg).map((route) => [route.mode, route]));
const T = routesOf(testnet);
const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
// Whom testnet's 1,008 DUSK withdrawal (the fixture) pays.
const PAID = "213qXNRaEAXrgJTFxXsPMeFasiEtPVJwZ3x2wKgZog2kXtXE7ovGRFfn1spfKBU4AUitAS91nM5T7HSvwRiyYCHLRaTTnJQbZn1TKnDySEiKZxX8vyodtWorbMuybDV5JJ9Y";
// A Portal call as the bridge sends it: its arguments, encoded by the Portal's own data driver.
const portalDriver = await loadDataDriver(readFileSync(new URL("../public/drivers/optimism_portal_dd_opt.wasm", import.meta.url)));
const portalCall = (fnName, args) => portalDriver.encodeInputFn(fnName, driverJson(args));
const OUTPUT_ROOT_PROOF = { latest_blockhash: Array(32).fill(1), message_passer_storage_root: Array(32).fill(2), state_root: Array(32).fill(3), version: Array(32).fill(0) };

/** The card as the controller builds it: Dusk to DuskEVM, 25, both wallets connected. */
function cardVmFor(patch = {}) {
  const quote = buildQuote(T["duskevm-deposit"], "25", { balance: 174_003_700_000n, cfg: testnet, gasPrice: 1n });
  return {
    amount: "25",
    amountError: "",
    button: { action: "review", enabled: true, label: "Review 25 DUSK" },
    canFlip: true,
    canMax: true,
    error: "",
    from: { balance: "174.0037 DUSK", balanceLabel: "Public balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    hint: "",
    menu: null,
    needsCount: 1,
    notice: null,
    quote,
    receive: "25",
    receiveUnit: "DUSK",
    routeLines: routeLines(T["duskevm-deposit"], testnet, { quote }),
    routeOpen: false,
    routeRows: routeDetailRows(T["duskevm-deposit"], quote),
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient", line: '<b class="mono">0xd63bB1…fE8df4</b>', looking: "", net: { id: "dusk-evm", name: "DuskEVM" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    unit: "DUSK",
    ...patch,
  };
}
const EVM = "0xd63bB1959D64E236f63DDC62c37248708ffE8df4";
const explorer = { explorer: (network, address) => explorerAddressUrl(testnet, network, address) };
// The lookalike that must never appear where addresses are checked.
const TIMES = "×";

test("the card's route line gives each route its time and fees, a withdrawal its steps' times and fees in two", () => {
  const line = (mode, cfg = testnet, timing, quote) => routeLines(routesOf(cfg)[mode], cfg, { quote, timing });
  assert.deepEqual(line("duskevm-deposit"), ["~1 min · fee up to 0.005 DUSK"]);
  // The withdrawal's time is the chain's: none until it's read. Its fees on Dusk are both steps'.
  assert.deepEqual(line("duskevm-withdrawal"), ["Send, then prove and claim on Dusk", "Then up to 0.102 DUSK on Dusk"]);
  const read = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
  assert.deepEqual(line("duskevm-withdrawal", testnet, read, { evmFeeWei: 1_384_528_439_000_000n }), [
    "~7 days: send, prove after ~30 min, claim 7 days later",
    "Network fee ~0.0014 DUSK, then up to 0.102 DUSK on Dusk",
  ]);
  // No time is known for the testnet payouts: the cost alone, taken from the amount.
  assert.deepEqual(line("service-transfer"), ["Bridge fee 1 DUSK, from the amount"]);
  assert.deepEqual(line("migration"), ["Network fee in ETH"]);
  // Mainnet's own times.
  assert.deepEqual(line("service-transfer", mainnet), ["~10 hours · bridge fee 1 DUSK, from the amount"]);
  const from = (id) => buildRoutes(mainnet).find((route) => route.from.id === id);
  assert.deepEqual(routeLines(from("ethereum"), mainnet, { quote: { evmFeeWei: 48_000_000_000_000n } }), ["~70 min · network fee ~0.000048 ETH"]);
  assert.deepEqual(routeLines(from("bsc"), mainnet), ["~1 hour · network fee in BNB"]);
  // What it sums is behind it; a line that says it all has nothing behind it.
  const deposit = buildQuote(T["duskevm-deposit"], "25", { cfg: testnet, gasPrice: 1n });
  assert.deepEqual(routeDetailRows(T["duskevm-deposit"], deposit), []);
  const payout = buildQuote(T["service-transfer"], "25", { cfg: testnet, gasPrice: 1n });
  assert.deepEqual(routeDetailRows(T["service-transfer"], payout).map((row) => [row.label, row.value]), [["Network fee", "up to 0.0025 DUSK"]]);
});
test("how the route is doing is said under it where it warns, and stops nobody from sending", () => {
  const status = { text: "Payouts late: last 3 hours ago", warn: true };
  const vm = cardVmFor({ status });
  const { cta, route } = cardRegions(vm);
  assert.ok(route.includes('<span class="route-sum"><span>~1 min · fee up to 0.005 DUSK</span><span class="route-status warn">Payouts late: last 3 hours ago</span></span>'), route);
  assert.equal(cta, cardRegions(cardVmFor())["cta"]);
  assert.ok(cta.includes('data-action="review"') && !cta.includes("disabled"), cta);
  assert.ok(cardPage(vm).includes("route-status warn"));
  // Until it's read, or where there's nothing to say, nothing.
  assert.doesNotMatch(cardRegions(cardVmFor()).route, /route-status/u);
  // A line with nothing behind it doesn't open; one with its split does.
  assert.match(cardPage(cardVmFor()), /<div class="route" data-region="route"><div class="route-head">/u);
  const split = cardVmFor({ routeRows: [{ key: "fee", label: "Network fee", value: "up to 0.0025 DUSK" }] });
  assert.match(cardPage(split), /<details class="route" data-region="route"><summary>/u);
  // A paused route has no line: its button says so.
  assert.doesNotMatch(cardPage(cardVmFor({ routeLines: [], routeRows: [] })), /data-region="route"/u);
});

test("a name typed without .dusk is offered as the .dusk name, under the recipient", () => {
  const vm = cardVmFor({ to: { ...cardVmFor().to, editing: true, error: "Not a Dusk account or .dusk name", input: "alice", suggest: "alice.dusk" } });
  assert.equal(cardRegions(vm)["recipient-note"], '<button type="button" class="linkish" data-action="recipient-suggest">Did you mean alice.dusk?</button>');
});

test("the review says a check only where it fails, and leaves the contracts, the spender and raw units to the wallet", async () => {
  const route = T.migration;
  const reads = { migration: { allowanceWei: 0n, balanceWei: 2_500n * 10n ** 18n, gasCoinWei: 21_300_000_000_000_000n, gasPriceWei: 2_000_000_000n } };
  const quote = buildQuote(route, "1000", { allowanceWei: 0n, balance: reads.migration.balanceWei, cfg: testnet, evmGas: { approve: 46_000n, migrate: 70_000n, priceWei: 2_000_000_000n } });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote, reads });
  assert.deepEqual(checks.map((check) => check.ok), [true, true]);
  assert.equal(checks[0].html, 'Not enough ERC20 DUSK: you have <b class="num">2,500 ERC20 DUSK</b>');
  assert.equal(checks[1].html, 'Not enough ETH for the network fee (~0.00023 ETH): you have <b class="num">0.0213 ETH</b>');
  // Not enough ETH is caught before the wallet opens.
  const poor = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { migration: { ...reads.migration, gasCoinWei: 1n } } });
  assert.equal(poor[1].ok, false);

  const vm = {
    canConfirm: true,
    checks,
    confirmLabel: "Approve 1,000 ERC20 DUSK",
    feeRows: [...quote.rows.filter((row) => !["send", "receive"].includes(row.key)), { key: "steps", label: "Steps", value: "Approve exactly 1,000 ERC20 DUSK, then migrate" }],
    notes: [],
    privacy: "Public: both accounts and the amount",
    receive: { account: ACCOUNT, amount: "1,000", chain: "dusk", full: true, unit: "DUSK", where: "Dusk" },
    send: { account: "0xd63bB1…fE8df4", amount: "1,000", chain: "ethereum", unit: "ERC20 DUSK", where: "Sepolia" },
    steps: [
      { current: true, ready: true, title: "Approve exactly 1,000 ERC20 DUSK", walletName: "MetaMask" },
      { current: false, ready: true, title: "Migrate", walletName: "MetaMask" },
    ],
    sub: "",
  };
  const sheet = reviewSheet(vm);
  // Whom it pays in full, where it's checked; the sender short.
  assert.ok(sheet.includes(`Dusk · <code class="mono wrap">${ACCOUNT}</code>`));
  assert.ok(sheet.includes('Sepolia · <code class="mono">0xd63bB1…fE8df4</code>'));
  // No contract, spender or raw amount, and no walk-through of the wallet's window: it shows those itself.
  for (const left of [testnet.evmNetworks.ethereum.migrationContract, testnet.evmNetworks.ethereum.tokenContract, "1000000000000000000000", "will show", "Check each line", "Step 2 opens"])
    assert.ok(!sheet.includes(left), left);
  // A check that passes isn't said.
  assert.doesNotMatch(sheet, /Not enough/u);
  assert.match(sheet, /<dt class="k">Steps<\/dt><dd class="v"><span class="stack"><span class="num">Approve exactly 1,000 ERC20 DUSK, then migrate<\/span><\/span><\/dd>/u);
  assert.match(sheet, />Cancel<\/button><button type="button" class="btn pri" data-action="confirm" >Approve 1,000 ERC20 DUSK</u);
  assert.ok(!sheet.includes(TIMES));
  // One that fails is said, as what keeps Confirm off.
  assert.match(reviewSheet({ ...vm, canConfirm: false, checks: poor }), /<li class="bad">.*?<span>Not enough ETH for the network fee \(~0\.00023 ETH\): you have <b class="num">0\.000000000000000001 ETH<\/b><\/span><\/li>/u);
});

test("an approval not used up shows above the way back's form, with Finish and Revoke", () => {
  const route = T.migration;
  const HALF = 5n * 10n ** 17n;
  const held = 5n * 10n ** 18n;
  const open = openApproval(route, { allowanceWei: HALF, balanceWei: held, evm: EVM });
  const box = cardRegions(cardVmFor({ approval: open })).approval;
  assert.match(box, /<b>Open approval:<\/b> <span class="num">0\.5 ERC20 DUSK<\/span>/u);
  assert.match(box, /data-action="approval-finish">Finish<\/button><button type="button" class="btn sec sm" data-action="approval-revoke">Revoke<\/button>/u);
  // Above From, where the way back starts.
  const page = cardPage(cardVmFor({ approval: open }));
  assert.ok(page.indexOf("Open approval:") < page.indexOf('data-side="from"'));
  // Covering the amount, it leaves one wallet step: the review says the steps, the card the fee.
  const steps = (amount) => buildQuote(route, amount, { allowanceWei: HALF, balance: held, cfg: testnet }).steps;
  assert.deepEqual([steps("0.5"), steps("0.6"), steps("")], [1, 2, 2]);
  assert.deepEqual(routeLines(route, testnet), ["Network fee in ETH"]);
  // Finish goes for what it still lets go, of what the wallet holds.
  assert.equal(open.finishLux, 500_000_000n);
  assert.equal(openApproval(route, { allowanceWei: 10n * held, balanceWei: held, evm: EVM }).finishLux, 5_000_000_000n);
  // With nothing to finish it with, or on a route that isn't running: Revoke alone.
  for (const quiet of [{ balanceWei: 0n }, { paused: true }]) {
    const only = cardRegions(cardVmFor({ approval: openApproval(route, { allowanceWei: HALF, balanceWei: held, evm: EVM, ...quiet }) })).approval;
    assert.ok(!only.includes("approval-finish") && only.includes("approval-revoke"), only);
  }
  // One with no limit, and one of less than a Lux, as that.
  const say = (allowanceWei) => cardRegions(cardVmFor({ approval: openApproval(route, { allowanceWei, balanceWei: held, evm: EVM }) })).approval;
  assert.match(say(2n ** 256n - 1n), /<span class="num">any amount of ERC20 DUSK<\/span>/u);
  assert.match(say(999n), /<span class="num">less than 0\.000000001 ERC20 DUSK<\/span>/u);
  assert.doesNotMatch(say(999n), /approval-finish/u);
  // Nothing approved, nothing read yet, no EVM wallet, or another route: none.
  for (const none of [{ allowanceWei: 0n }, { allowanceWei: null }, { allowanceWei: HALF, evm: "" }]) assert.equal(openApproval(route, { balanceWei: held, evm: EVM, ...none }), null);
  assert.equal(openApproval(T["service-transfer"], { allowanceWei: HALF, balanceWei: held, evm: EVM }), null);
  assert.equal(cardRegions(cardVmFor()).approval, "");
  // Once it's revoked, that, in its place.
  assert.equal(cardRegions(cardVmFor({ approvalNote: "The approval is revoked." })).approval, '<p class="message" id="approval-note" role="status" tabindex="-1">The approval is revoked.</p>');
});

test("a review that skips Approve says which approval covers the amount, and what stays approved", () => {
  const route = T.migration;
  const HALF = 5n * 10n ** 17n;
  const held = 5n * 10n ** 18n;
  const checks = (amount, allowanceWei) =>
    reviewChecks(route, {
      cfg: testnet,
      destination: ACCOUNT,
      duskAccount: ACCOUNT,
      evm: { account: EVM },
      quote: buildQuote(route, amount, { allowanceWei, balance: held, cfg: testnet }),
      reads: { migration: { allowanceWei, balanceWei: held, gasCoinWei: 10n ** 16n } },
    });
  const covered = (amount, allowanceWei) => checks(amount, allowanceWei).find((check) => check.html.startsWith("An earlier approval"))?.html;
  assert.equal(covered("0.2", HALF), 'An earlier approval of <b class="num">0.5 ERC20 DUSK</b> covers this. <b class="num">0.3 ERC20 DUSK</b> stays approved.');
  assert.equal(covered("0.5", HALF), 'An earlier approval of <b class="num">0.5 ERC20 DUSK</b> covers this. Nothing stays approved.');
  assert.equal(covered("1", 2n ** 256n - 1n), "An earlier approval with no limit covers this. It stays approved.");
  assert.match(covered("0.5", HALF + 5n), /<b class="num">Less than 0\.000000001 ERC20 DUSK<\/b> stays approved\.$/u);
  // A fact, read on the chain, always said: the review still confirms.
  assert.ok(checks("0.2", HALF).every((check) => check.ok));
  assert.equal(checks("0.2", HALF).find((check) => check.html.startsWith("An earlier approval")).note, true);
  // One that doesn't cover it isn't said to: the approval step replaces it, and says so.
  assert.equal(covered("1", HALF), undefined);
  assert.equal(covered("0.2", 0n), undefined);
  assert.equal(replacedLine(HALF, "ERC20 DUSK"), "Replaces the open approval of 0.5 ERC20 DUSK");
  assert.equal(replacedLine(0n, "ERC20 DUSK"), "");
});

test("a revoke is reviewed as what's approved now and its fee; its wallet shows the approval of 0", () => {
  const route = T.migration;
  const reads = { migration: { allowanceWei: 3n * 10n ** 16n, balanceWei: 10n ** 17n, gasCoinWei: 9n * 10n ** 15n, gasPriceWei: 10n ** 9n } };
  const revoke = (patch = {}, feeWei = 26_000n * 10n ** 9n) => revokeReview(route, { cfg: testnet, evm: { account: EVM }, feeWei, reads: { migration: { ...reads.migration, ...patch } }, walletName: "MetaMask" });
  const review = revoke();
  assert.deepEqual(review.lead, { amount: "0.03", chain: "ethereum", label: "Approved now", line: "Sepolia · 0xd63bB1…fE8df4", unit: "ERC20 DUSK" });
  const [step] = review.steps;
  assert.deepEqual(step, { confirmLabel: "Revoke approval", ready: true, title: "Revoke the approval", walletName: "MetaMask" });
  assert.deepEqual(review.feeRows.map((row) => [row.label, row.value]), [["Network fee", "~0.000026 ETH"]]);
  assert.equal(review.checks[0].html, 'Not enough ETH for the network fee: you have <b class="num">0.009 ETH</b>');
  assert.equal(review.checks[0].ok, true);
  // Without ETH for its fee, it can't be confirmed.
  assert.equal(revoke({ gasCoinWei: 1n }).checks[0].ok, false);
  // Its sheet: what's approved now, what's public, its fee; the token and spender are the wallet's to show.
  const sheet = reviewSheet({ ...review, canConfirm: true, confirmLabel: step.confirmLabel, steps: review.steps.map((item) => ({ ...item, current: true })) });
  assert.match(sheet, /<div class="k">Approved now<\/div><div class="v num">0\.03<span class="u">ERC20 DUSK<\/span><\/div>/u);
  assert.match(sheet, /<b>Public:<\/b> your account and the revoke/u);
  assert.ok(!sheet.includes(testnet.evmNetworks.ethereum.migrationContract));
  assert.match(sheet, /data-action="confirm" >Revoke approval</u);
  // One with no limit, as that; its fee in what pays it, before it's estimated.
  const unlimited = revoke({ allowanceWei: 2n ** 256n - 1n }, null);
  assert.deepEqual([unlimited.lead.amount, unlimited.lead.unit], ["No limit", ""]);
  assert.equal(unlimited.feeRows[0].value, "paid in ETH");
  assert.doesNotMatch(reviewSheet({ ...unlimited, canConfirm: true, confirmLabel: "x", steps: unlimited.steps.map((item) => ({ ...item, current: true })) }), /No limit<span class="u">/u);
});

/** What a page shows, as words: its tags gone, each run of space one. */
const visible = (html) => html.replace(/<span class="evm-tag">EVM<\/span>/gu, "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const SHOT = "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e";

test("a review is the summary: what moves, whom it pays in full, the fees and the time; the wallet's window shows its contract, method and call data", () => {
  const route = T["duskevm-deposit"];
  const quote = buildQuote(route, "0.1", { balance: 10n ** 12n, cfg: testnet, gasPrice: 1n });
  const sheet = reviewSheet({
    canConfirm: true,
    checks: reviewChecks(route, { cfg: testnet, destination: SHOT, duskAccount: ACCOUNT, evm: {}, quote, reads: { duskBalance: 10n ** 12n } }),
    confirmLabel: "Send 0.1 DUSK",
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    notes: [],
    privacy: "Public: both accounts and the amount",
    receive: { account: SHOT, amount: "0.1", chain: "dusk-evm", full: true, unit: "DUSK", where: "DuskEVM" },
    send: { account: "21n5nc…fMMLNz", amount: "0.1", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, ready: true, title: "Send from Dusk", walletName: "Dusk Wallet" }],
    sub: "",
  });
  assert.equal(
    visible(sheet),
    `Review You send 0.1 DUSK Dusk · 21n5nc…fMMLNz You receive 0.1 DUSK DuskEVM · ${SHOT} Public: both accounts and the amount Network fee up to 0.005 DUSK Arrives ~1 min Cancel Send 0.1 DUSK`,
  );
  // Until its request is built, it says so, and Confirm waits.
  const preparing = reviewSheet({ canConfirm: false, checks: [], confirmLabel: "Send 0.1 DUSK", feeRows: [], privacy: "x", receive: { amount: "0.1", chain: "dusk-evm", unit: "DUSK", where: "DuskEVM" }, send: { amount: "0.1", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, ready: false, wait: "Preparing…" }], sub: "" });
  assert.match(preparing, /<span>Preparing…<\/span>/u);
  assert.match(preparing, /data-action="confirm" disabled>/u);
});

test("a proof's review leads with the withdrawal and whom it pays, in full; who can claim is said once", () => {
  const lead = actionLead("prove", { destination: PAID }, { account: ACCOUNT, amountLux: 1_008_000_000_000n, claim: { at: Date.UTC(2026, 10, 26, 22, 25), exact: true }, maxLux: 51_000_000n, when: () => "26 Nov, 23:25 CET" });
  assert.deepEqual(lead, {
    amount: "1,008",
    chain: "dusk",
    label: "Withdrawal",
    line: "",
    notYours: "Not your connected account",
    payee: PAID,
    rows: [
      { key: "fee", label: "Network fee", value: "up to 0.051 DUSK" },
      { key: "when", label: "When", value: "Claim from 26 Nov, 23:25 CET" },
    ],
  });
  const sheet = reviewSheet({ canConfirm: true, checks: [], confirmLabel: "Prove", feeRows: lead.rows, lead, notes: ["Only the account that proves can claim"], privacy: actionPrivacy("prove"), steps: [{ current: true, ready: true }], sub: "Step 2 of 3: prove" });
  assert.equal(
    visible(sheet),
    `Review Step 2 of 3: prove Withdrawal 1,008 DUSK To ${PAID} on Dusk Public: your account, as the prover Not your connected account Only the account that proves can claim Network fee up to 0.051 DUSK When Claim from 26 Nov, 23:25 CET Cancel Prove`,
  );
});

test("a receipt is a record without balances: whom it paid in full, both transactions and its own link", () => {
  const entry = {
    amountLux: "25000000000",
    destination: EVM.toLowerCase(),
    destinationAt: Date.UTC(2026, 9, 26, 9, 31, 19),
    destinationHash: `0x${"a1".repeat(32)}`,
    feeLux: "1986599",
    hash: "38".repeat(32),
    id: `dusk-to-dusk-evm:${"38".repeat(32)}`,
    routeId: "dusk-to-dusk-evm",
    sender: ACCOUNT,
    sourceAt: Date.UTC(2026, 9, 26, 9, 31, 12),
    status: "completed",
  };
  const url = `https://bridge.example.org/#/transfer/${"38".repeat(32)}`;
  const model = receiptModel(entry, { cfg: testnet, locale: "en-GB", now: Date.UTC(2026, 10, 2), route: T["duskevm-deposit"], timeZone: "Europe/Amsterdam", url });
  assert.equal(model.view.title, "25 DUSK · Dusk → DuskEVM");
  // Completed: its pill says it, its steps when.
  assert.equal(model.caption, "");
  assert.deepEqual(model.details.map((row) => row.label), ["You sent", "Network fee", "You received", "From", "To", "Dusk transaction", "DuskEVM transaction", "Sent"]);
  // A record: the fee as paid, to the last decimal, and in the main view, as a total.
  assert.equal(model.details[1].value, "0.001986599 DUSK");
  assert.deepEqual(model.fees, { exact: "0.001986599 DUSK", text: "0.002 DUSK" });
  const html = receiptPage(model);
  // Whom it paid, in full, under its title; the sender short.
  assert.ok(html.includes(`<p class="l"><code class="mono">21n5nc…fMMLNz</code> → <code class="mono wrap">${EVM}</code></p>`), html);
  // Each transaction short, in full on hover and copy, with its explorer link.
  assert.ok(html.includes(`<code class="mono" title="${"38".repeat(32)}">383838…383838</code>`));
  assert.ok(html.includes(`data-copy="0x${"a1".repeat(32)}"`));
  // Its link to copy, and its details folded.
  assert.ok(html.includes(`data-copy="${url}"`) && !html.includes(`<code class="mono">${url}</code>`));
  assert.match(html, /<section class="rc-side" aria-label="Details"><details><summary class="gh">Details<\/summary>/u);
  assert.match(html, /<p class="small t2">Fees <span class="num" title="0\.001986599 DUSK">0\.002 DUSK<\/span><\/p>/u);
  assert.doesNotMatch(html, /balance|now holds|Anyone with the link/iu);
  assert.ok(!html.includes(TIMES));

  // While pending: how long it takes on this network, and a note only once it's late.
  const waiting = { ...entry, destinationHash: undefined, status: "pending" };
  const pending = receiptModel(waiting, { cfg: testnet, now: entry.sourceAt + 60_000, route: T["duskevm-deposit"], url });
  assert.equal(pending.caption, "~1 min");
  assert.deepEqual(pending.notes, []);
  const late = receiptModel(waiting, { cfg: testnet, now: entry.sourceAt + 3_600_000, route: T["duskevm-deposit"], url });
  assert.deepEqual(late.notes.map((note) => note.html), ["<b>Taking longer than usual.</b>"]);
  // A contact only where the deployment names one.
  const supported = profile("testnet", { ...DUSKEVM, VITE_SUPPORT_LABEL: "Dusk support", VITE_SUPPORT_URL: "https://support.example.org" });
  const withSupport = receiptModel(waiting, { cfg: supported, now: entry.sourceAt + 3_600_000, route: routesOf(supported)["duskevm-deposit"], url });
  assert.match(withSupport.notes.at(-1).html, /Contact <a href="https:\/\/support\.example\.org" target="_blank" rel="noreferrer">Dusk support<\/a> with the receipt link\./u);
});

test("the form's balance line writes what's held as wallets do, with every digit on hover", () => {
  const way = (id) => buildRoutes(mainnet).find((route) => route.id === id);
  // Wei on an EVM chain: what Max fills in is the same amount, in full.
  assert.deepEqual(balanceLine(way("bsc-to-dusk"), 90_082_082_000_000_000n), { exact: "0.090082082 BEP20 DUSK", text: "0.09 BEP20 DUSK" });
  assert.deepEqual(balanceLine(way("dusk-to-bsc"), 174_003_712_345n), { exact: "174.003712345 DUSK", text: "174.0037 DUSK" });
  // Rounded down, never to more than there is, and never to 0 where there's something.
  assert.equal(balanceLine(way("dusk-to-bsc"), 999_999_999n).text, "0.9999 DUSK");
  assert.equal(balanceLine(way("dusk-to-bsc"), 1n).text, "0.000000001 DUSK");
  assert.equal(balanceLine(way("bsc-to-dusk"), 10_000_000_000_000n).text, "0.00001 BEP20 DUSK");
  assert.deepEqual(balanceLine(way("dusk-to-bsc"), null), { exact: "", text: "" });
  const held = cardRegions(cardVmFor({ from: { balance: "0.09 BEP20 DUSK", balanceExact: "0.090082082 BEP20 DUSK", balanceLabel: "Balance", net: { id: "bsc", name: "BNB Smart Chain" } } }))["from-foot"];
  assert.ok(held.includes('<span class="num" title="0.090082082 BEP20 DUSK">0.09 BEP20 DUSK</span>'), held);
  // Nothing left out, nothing on hover.
  assert.ok(cardRegions(cardVmFor({ from: { balance: "25 DUSK", balanceExact: "25 DUSK", balanceLabel: "Balance", net: { id: "dusk", name: "Dusk" } } }))["from-foot"].includes('<span class="num">25 DUSK</span>'));
});

test("the review checks a balance to the Lux, as what it sends: 0.09 can't pay for 0.090082082", () => {
  const route = T.migration;
  const reads = { migration: { balanceWei: 90_082_082_000_000_000n, gasCoinWei: 10_000_000_000_000n } };
  const quote = buildQuote(route, "0.090082082", { balance: reads.migration.balanceWei, cfg: testnet });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads });
  assert.match(checks[0].html, /<b class="num">0\.090082082 ERC20 DUSK<\/b>/u);
  // Gas in the short form, where 4 decimals alone would say it has none.
  assert.match(checks[1].html, /<b class="num">0\.00001 ETH<\/b>/u);
  const deposit = T["duskevm-deposit"];
  const fromDusk = reviewChecks(deposit, { cfg: testnet, destination: EVM, evm: {}, quote: buildQuote(deposit, "1", { balance: 2_123_456_789n, cfg: testnet }), reads: { duskBalance: 2_123_456_789n } });
  assert.match(fromDusk[0].html, /<b class="num">2\.123456789 DUSK<\/b>/u);
  const withdrawal = T["duskevm-withdrawal"];
  const fromEvm = reviewChecks(withdrawal, { cfg: testnet, destination: ACCOUNT, evm: {}, quote: buildQuote(withdrawal, "1", { balance: 2_123_456_789_999_999_999n, cfg: testnet }), reads: { l2: { balanceWei: 2_123_456_789_999_999_999n } } });
  assert.match(fromEvm[0].html, /<b class="num">2\.123456789 DUSK<\/b>/u);
});

test("a receipt says the transfer's amounts as every Dusk app does, to the Lux", () => {
  const url = "https://bridge.example.org/#/transfer/m";
  const rows = (entry, route) => receiptModel({ hash: `0x${"0d".repeat(32)}`, id: "m", routeId: route.id, ...entry }, { cfg: testnet, route, url }).details.filter((row) => !row.html && row.label !== "Sent").map((row) => [row.label, row.value]);
  const service = T["service-transfer"];
  // Before it arrives: what will, worked out from what was sent.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", status: "pending" }, service), [
    ["You sent", "2.053082083 DUSK"],
    ["Bridge fee", "1 DUSK"],
    ["Network fee", "0.001859281 DUSK"],
    ["You receive", "1.053082083 ERC20 DUSK"],
  ]);
  // Once it has: what did.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", receivedLux: "1053082083", status: "completed" }, service).at(-1), ["You received", "1.053082083 ERC20 DUSK"]);
  // An older entry, kept before what arrived was: worked out, and said as arrived.
  assert.deepEqual(rows({ amountLux: "2053082083", status: "completed" }, service).at(-1), ["You received", "1.053082083 ERC20 DUSK"]);
  // A proof's and a claim's fees are one network fee.
  assert.deepEqual(rows({ amountLux: "1008000000000", claimFeeLux: "2000001", proveFeeLux: "1000000", status: "completed", stage: "finalized" }, T["duskevm-withdrawal"]), [
    ["You sent", "1,008 DUSK"],
    ["Network fee", "0.003000001 DUSK"],
    ["You received", "1,008 DUSK"],
  ]);
  // Failed on Dusk: nothing moved, and its fee stands alone.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", note: "The Dusk transaction failed.", status: "failed" }, T["duskevm-deposit"]), [["Network fee", "0.001859281 DUSK"]]);
  // Went through and pays nothing out: the DUSK moved, and nothing came of it.
  // A failure past its own chain still moved what was sent; one on its own chain moved nothing.
  const sentOf = (entry) => rows({ amountLux: "2053082083", feeLux: "1859281", status: "failed", ...entry }, service).some(([label]) => label === "You sent");
  assert.equal(sentOf({ note: "The memo isn't an EVM address, so the bridge won't pay it out." }), true);
  assert.equal(sentOf({ sourceFailed: true }), false);
  assert.equal(sentOf({ note: "The transfer failed on Dusk." }), false);
  assert.deepEqual(rows({ amountLux: "500000000", feeLux: "1859281", receivedLux: "0", status: "failed" }, service).filter(([label]) => label !== "Bridge fee"), [
    ["You sent", "0.5 DUSK"],
    ["Network fee", "0.001859281 DUSK"],
    ["You received", "0 ERC20 DUSK"],
  ]);
});

/**
 * Sepolia's migration route as `migrationFacts` asks its RPC over fetch: an
 * owner's approvals and migrations, each in a block of its own, with the
 * token's Transfer and Approval logs as an ERC-20 writes them. `pruned`: the
 * RPC refuses logs that old, as Ethereum's publicnode does a day on.
 */
function migrationChain({ pruned = false } = {}) {
  const { contract } = testnet.network.routes.migrations.find((route) => route.id === T.migration.id);
  const token = testnet.network.routes.chains.ethereum.token;
  const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  const [APPROVAL, TRANSFER] = ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"];
  const receipts = new Map();
  const nonces = new Map();
  const logs = [];
  const urls = [];
  /** The owner sends a transaction: an approval of `wei`, or a migration of it, at 1.000000016 gwei. */
  const send = (kind, { block, gas, hash, left = 0n, wei, failed = false }) => {
    const own = kind === "approve" ? [[APPROVAL, wei]] : failed ? [] : [[TRANSFER, wei], [APPROVAL, left]];
    const placed = own.map(([event, value], index) => ({ address: token, blockNumber: `0x${block.toString(16)}`, data: word(value), logIndex: `0x${index.toString(16)}`, topics: [event, topic(EVM), topic(contract)], transactionHash: hash }));
    logs.push(...placed);
    receipts.set(hash, { blockNumber: `0x${block.toString(16)}`, effectiveGasPrice: "0x3b9aca10", from: EVM.toLowerCase(), gasUsed: `0x${gas.toString(16)}`, logs: placed, status: failed ? "0x0" : "0x1", to: (kind === "approve" ? token : contract).toLowerCase() });
    nonces.set(hash, nonces.size);
    return hash;
  };
  const fetch = async (url, { body }) => {
    const { id, method, params } = JSON.parse(body);
    urls.push(url);
    const answer = (result) => new Response(JSON.stringify({ id, jsonrpc: "2.0", result }));
    if (method === "eth_getTransactionReceipt") return answer(receipts.get(params[0]) ?? null);
    if (method === "eth_getTransactionByHash") return answer(nonces.has(params[0]) ? { from: EVM.toLowerCase(), hash: params[0], nonce: `0x${nonces.get(params[0]).toString(16)}` } : null);
    if (method === "eth_blockNumber") return answer("0x2710");
    if (method === "eth_getBlockByNumber") return answer({ number: params[0], timestamp: `0x${(1_793_000_000 + Number(params[0])).toString(16)}` });
    if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
    if (pruned) return new Response(JSON.stringify({ error: { code: -32000, message: "history has been pruned for this block" }, id, jsonrpc: "2.0" }));
    const [{ address, fromBlock, toBlock, topics }] = params;
    return answer(logs.filter((log) => log.address.toLowerCase() === address.toLowerCase() && BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock) && topics[0].includes(log.topics[0]) && log.topics[1] === topics[1] && log.topics[2] === topics[2]));
  };
  // What's final of it, kept as the page keeps it.
  return { cache: new Map(), fetch, send, urls };
}

test("a migration's network fee counts the approval it spent, whichever app signed it and whenever, as its chain says", async () => {
  // Nandini's way back of 0.003: an approval signed in another app, then the migration: 46,194 and 47,005 gas at 1.000000016 gwei.
  const chain = migrationChain();
  const approval = chain.send("approve", { block: 100, gas: 46_194, hash: `0x${"a7".repeat(32)}`, wei: 3n * 10n ** 15n });
  const hash = chain.send("migrate", { block: 140, gas: 47_005, hash: `0x${"0d".repeat(32)}`, wei: 3n * 10n ** 15n });
  const entry = { amountLux: "3000000", destination: ACCOUNT, hash, id: "m", receivedLux: "3000000", routeId: T.migration.id, sender: EVM, status: "completed" };
  const read = (sent, on = chain) => createTracking({ cache: on.cache, config: testnet, fetch: on.fetch }).migrationEvm(sent, T.migration);
  const receipt = async (sent, on = chain) => receiptModel(sent, { cfg: testnet, evm: await read(sent, on), route: T.migration, url: "https://bridge.example.org/#/transfer/m" });
  const fee = (model) => {
    const row = model.details.find((each) => each.label === "Network fee");
    return row && [row.value, row.exact, row.detail];
  };
  const model = await receipt(entry);
  // Both, to the wei, as left the wallet: 0.000093199001491184 ETH.
  assert.deepEqual(fee(model), ["0.000093 ETH", "0.000093199001491184 ETH", "approval and migration"]);
  assert.ok(receiptPage(model).includes('<span class="stack"><span class="num" title="0.000093199001491184 ETH">0.000093 ETH</span><span class="small">approval and migration</span></span>'));
  // And the approval found on the chain, with the migration's own transaction after it.
  const labels = model.details.map((row) => row.label);
  assert.equal(labels.indexOf("Sepolia approval") + 1, labels.indexOf("Sepolia transaction"));
  assert.ok(model.details.find((row) => row.label === "Sepolia approval").html.includes(`data-copy="${approval}"`));
  // Read from the deployment's own RPC; and once it's final, kept: opened again, the chain isn't asked.
  assert.deepEqual([...new Set(chain.urls)], [testnet.evmNetworks.ethereum.rpcUrl]);
  const asked = chain.urls.length;
  assert.deepEqual(fee(await receipt(entry)), fee(model));
  assert.equal(chain.urls.length, asked);
  // Before it's read, no fee: not the migration's half of it.
  assert.equal(fee(receiptModel(entry, { cfg: testnet, route: T.migration, url: "x" })), undefined);

  // Two migrations from one approval of 0.01: the first counts it, the next its own gas.
  const shared = migrationChain();
  shared.send("approve", { block: 100, gas: 46_194, hash: `0x${"b1".repeat(32)}`, wei: 10n ** 16n });
  const first = shared.send("migrate", { block: 140, gas: 47_005, hash: `0x${"b2".repeat(32)}`, left: 7n * 10n ** 15n, wei: 3n * 10n ** 15n });
  const next = shared.send("migrate", { block: 180, gas: 47_005, hash: `0x${"b3".repeat(32)}`, wei: 7n * 10n ** 15n });
  assert.equal(fee(await receipt({ ...entry, hash: first }, shared))[2], "approval and migration");
  assert.deepEqual(fee(await receipt({ ...entry, amountLux: "7000000", hash: next, receivedLux: "7000000" }, shared)), ["0.000047 ETH", "0.00004700500075208 ETH", "migration"]);

  // Where the RPC no longer gives logs that old, the migration's own gas, and that the approval can't be read.
  const pruned = migrationChain({ pruned: true });
  pruned.send("approve", { block: 100, gas: 46_194, hash: approval, wei: 3n * 10n ** 15n });
  pruned.send("migrate", { block: 140, gas: 47_005, hash, wei: 3n * 10n ** 15n });
  assert.deepEqual(fee(await receipt(entry, pruned)), ["0.000047 ETH", "0.00004700500075208 ETH", "migration; its approval can't be read"]);
  // The approval this browser sent right before it still counts there: the chain's nonces say nothing came between.
  assert.equal(fee(await receipt({ ...entry, approvalHash: approval }, pruned))[2], "approval and migration");

  // Failed on its chain: its own gas; its approval wasn't spent, and counts with the migration that spends it.
  const failing = migrationChain();
  failing.send("approve", { block: 100, gas: 46_194, hash: approval, wei: 3n * 10n ** 15n });
  failing.send("migrate", { block: 140, failed: true, gas: 30_002, hash, wei: 3n * 10n ** 15n });
  const failed = await receipt({ ...entry, approvalHash: approval, receivedLux: undefined, sourceFailed: true, status: "failed" }, failing);
  assert.deepEqual(failed.details.filter((row) => !row.html).map((row) => [row.label, row.value, row.detail]), [["Network fee", "0.00003 ETH", "migration"]]);

  // Cancelled in the wallet after its approval: no migration was mined, and the approval's gas, as this browser read it, is the fee.
  const cancel = { ...entry, approvalFeeWei: "29106000465696", approvalHash: approval, receivedLux: undefined, replaced: "cancelled", sourceFailed: true, status: "failed" };
  const cancelled = await receipt(cancel);
  assert.deepEqual(cancelled.details.filter((row) => !row.html).map((row) => [row.label, row.value, row.exact, row.detail]), [["Network fee", "0.000029 ETH", "0.000029106000465696 ETH", "approval"]]);
  // Until a migration spends that approval: then it counts the fee, once, and this receipt doesn't; nor while that's read. The approval stays listed.
  for (const approvalSpentBy of [`0x${"f1".repeat(32)}`, null]) {
    const spent = receiptModel(cancel, { approvalSpentBy, cfg: testnet, route: T.migration, url: "x" });
    assert.equal(fee(spent), undefined);
    assert.ok(spent.details.find((row) => row.label === "Sepolia approval").html.includes(`data-copy="${approval}"`));
  }
});

test("a transfer to the EVM chain that arrived at the connected wallet offers to add DUSK to it, as the way back's form does while it holds none", () => {
  const service = T["service-transfer"];
  const entry = { amountLux: "2053082083", destination: EVM, feeLux: "1859281", hash: "ab".repeat(32), id: "s", receivedLux: "1053082083", routeId: service.id, status: "completed" };
  const wallet = { account: EVM.toLowerCase(), addsDusk: true, walletName: "MetaMask" };
  const receipt = (patch = {}, on = wallet) => receiptPage(receiptModel({ ...entry, ...patch }, { cfg: testnet, route: service, url: "x", wallet: on }));
  // Under its progress, once it arrived.
  assert.match(receipt(), /<\/ol><\/div><div class="action-box"><button type="button" class="btn sec sm" data-action="add-dusk" data-net="ethereum">Add DUSK to MetaMask<\/button><\/div><\/section>/u);
  assert.match(receipt({}, { ...wallet, walletName: "" }), />Add DUSK to your EVM wallet</u);
  // Not before it arrived, nor at another address than the wallet's, nor for a wallet that can't take it or added it here.
  assert.doesNotMatch(receipt({ receivedLux: undefined, status: "pending" }), /add-dusk/u);
  assert.doesNotMatch(receipt({ destination: "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d" }), /add-dusk/u);
  assert.doesNotMatch(receipt({}, { ...wallet, addsDusk: false }), /add-dusk/u);
  assert.doesNotMatch(receipt({}, null), /add-dusk/u);
  // The way back's form, beside the balance, while the wallet holds none.
  const offer = (balanceWei, wayBack = true) => addDuskOffer(T.migration, { balanceWei, evm: wallet, takes: true, wayBack });
  const none = { canMax: false, from: { balance: "0 ERC20 DUSK", balanceLabel: "Balance", net: { id: "ethereum", name: "Sepolia" } } };
  assert.match(cardRegions(cardVmFor({ ...none, addDusk: offer(0n) }))["from-foot"], /<span class="num">0 ERC20 DUSK<\/span><button type="button" class="mini" data-action="add-dusk" data-net="ethereum">Add DUSK to MetaMask<\/button><\/span>$/u);
  // Not while it holds some, before that's read, on a route only into Dusk, or for a wallet that can't take it.
  for (const nothing of [offer(1n), offer(null), offer(0n, false), addDuskOffer(T.migration, { balanceWei: 0n, evm: wallet, wayBack: true })]) assert.equal(nothing, null);
  assert.doesNotMatch(cardRegions(cardVmFor(none))["from-foot"], /add-dusk/u);
});

test("once DUSK was added from the page, where the offer was says so on screen: Nandini's button just vanished", () => {
  const service = T["service-transfer"];
  const entry = { amountLux: "2053082083", destination: EVM, feeLux: "1859281", hash: "ab".repeat(32), id: "s", receivedLux: "1053082083", routeId: service.id, status: "completed" };
  // Added: the wallet takes it no more, and this visit added it.
  const wallet = { account: EVM.toLowerCase(), addedDusk: true, addsDusk: false, walletName: "Test MetaMask" };
  const receipt = (patch = {}, on = wallet) => receiptPage(receiptModel({ ...entry, ...patch }, { cfg: testnet, route: service, url: "x", wallet: on }));
  assert.match(receipt(), /<\/ol><\/div><div class="action-box"><span class="small" id="dusk-added" tabindex="-1">DUSK added to Test MetaMask\.<\/span><\/div><\/section>/u);
  assert.doesNotMatch(receipt(), /add-dusk/u);
  // Only where it was offered: not before it arrived, nor at another address, nor once another visit added it.
  assert.doesNotMatch(receipt({ receivedLux: undefined, status: "pending" }), /dusk-added/u);
  assert.doesNotMatch(receipt({ destination: "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d" }), /dusk-added/u);
  assert.doesNotMatch(receipt({}, { ...wallet, addedDusk: false }), /dusk-added|add-dusk/u);
  // The way back's form, beside the balance.
  const none = { canMax: false, from: { balance: "0 ERC20 DUSK", balanceLabel: "Balance", net: { id: "ethereum", name: "Sepolia" } } };
  const added = addDuskOffer(T.migration, { added: true, balanceWei: 0n, evm: wallet, wayBack: true });
  assert.match(cardRegions(cardVmFor({ ...none, addDusk: added }))["from-foot"], /<span class="num">0 ERC20 DUSK<\/span><span class="small" id="dusk-added" tabindex="-1">DUSK added to Test MetaMask\.<\/span><\/span>$/u);
});

test("a receipt on its way offers to tell you when it arrives, and says what happens where that's refused", () => {
  const url = "https://bridge.example.org/#/transfer/n";
  const sent = { amountLux: "25000000000", destination: EVM, hash: "0e".repeat(32), id: "n", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const page = (entry, route, notice) => receiptPage({ ...receiptModel(entry, { cfg: testnet, route, url }), notice });
  const deposit = T["duskevm-deposit"];
  assert.match(page(sent, deposit, "offer"), /<button type="button" class="linkish" data-action="notify-on">Notify me<\/button>/u);
  assert.match(page(sent, deposit, "on"), /You&#039;ll get a notification when it arrives\. <button type="button" class="linkish" data-action="notify-off">Turn off<\/button>/u);
  assert.match(page(sent, deposit, "refused"), /Notifications aren&#039;t allowed for this site, so this tab&#039;s title will say when it arrives\./u);
  assert.match(page(sent, deposit, "unavailable"), /This tab&#039;s title will say when it arrives\./u);
  assert.doesNotMatch(page(sent, deposit, "refused"), /data-action="notify/u);
  // Nothing to be told once it ended, and a withdrawal comes when you claim it.
  assert.doesNotMatch(page({ ...sent, status: "completed" }, deposit, "offer"), /id="notify"/u);
  assert.doesNotMatch(page({ ...sent, status: "failed" }, deposit, "offer"), /id="notify"/u);
  assert.doesNotMatch(page({ ...sent, routeId: "dusk-evm-to-dusk", stage: "submitted" }, T["duskevm-withdrawal"], "offer"), /id="notify"/u);
});

test("a claim's fee maximum on the receipt uses the withdrawal's own gas once it's known", () => {
  const ready = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", stage: "ready_to_finalize", status: "pending" };
  const url = "https://bridge.example.org/#/transfer/w";
  // Unknown yet: the bound (1M on top of 50M).
  assert.equal(receiptModel(ready, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee, "Network fee up to 0.051 DUSK");
  // It waits for you, not for time: no route time beside its pill.
  const timed = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
  assert.equal(receiptModel(ready, { cfg: testnet, route: T["duskevm-withdrawal"], timing: timed, url }).caption, "");
  assert.equal(receiptModel({ ...ready, stage: "waiting_for_output" }, { cfg: testnet, route: T["duskevm-withdrawal"], timing: timed, url }).caption, "~7 days");
  // Known: 50M plus what the withdrawal asks for.
  assert.equal(
    receiptModel({ ...ready, withdrawalGas: "9000000" }, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee,
    "Network fee up to 0.059 DUSK",
  );
});

test("a row in Activity writes its amount as wallets do, with every digit on hover", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  const shown = (amountLux, patch = {}) =>
    transfersModel([{ amountLux, hash: "0a".repeat(32), id: "a", parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", status: "pending", ...patch }], { accounts: [ACCOUNT], cfg: testnet, routeOf }).groups.progress[0];
  assert.deepEqual((({ amountExact, amountText }) => ({ amountExact, amountText }))(shown("53082083")), { amountExact: "0.053082083 DUSK", amountText: "0.053 DUSK" });
  // Rounded down, and an amount that isn't 0 never reads 0.
  assert.equal(shown("999999999").amountText, "0.9999 DUSK");
  assert.equal(shown("1").amountText, "0.000000001 DUSK");
  const row = activityPanel({ empty: "", groups: { done: [], failed: [], needs: [], progress: [{ ...shown("53082083"), href: "#/t" }] }, lede: "", more: false, syncText: "", watch: null });
  // On the row's link, which takes the pointer anywhere on the row.
  assert.match(row, /<a class="tr-link" [^>]* title="0\.053082083 DUSK"><\/a>/u);
  assert.ok(row.includes('<span class="am num">0.053 DUSK</span>'), row);
  // The receipt is its detail: in full.
  const model = receiptModel({ amountLux: "53082083", hash: "0a".repeat(32), id: "a", routeId: "dusk-to-dusk-evm", status: "pending" }, { cfg: testnet, route: T["duskevm-deposit"], url: "https://bridge.example.org/#/transfer/a" });
  assert.equal(model.view.title, "0.053082083 DUSK · Dusk → DuskEVM");
  assert.equal(model.details[0].value, "0.053082083 DUSK");
});

test("Activity groups the connected accounts' transfers and offers the next action", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  const entries = [
    { amountLux: "120000000000", hash: `0x${"01".repeat(32)}`, id: "a", parties: [EVM.toLowerCase(), ACCOUNT], readyAt: Date.UTC(2026, 9, 24) / 1_000, routeId: "dusk-evm-to-dusk", stage: "ready_to_finalize", status: "pending" },
    { amountLux: "25000000000", destinationAt: Date.UTC(2026, 9, 26, 9, 31), hash: "02".repeat(32), id: "b", parties: [ACCOUNT, EVM.toLowerCase()], routeId: "dusk-to-dusk-evm", status: "completed" },
    { amountLux: "5000000000", hash: "03".repeat(32), id: "c", parties: ["someone-else"], routeId: "dusk-to-dusk-evm", status: "completed" },
    { amountLux: "5000000000", followed: true, hash: "04".repeat(32), id: "d", parties: [], routeId: "dusk-to-ethereum", status: "pending" },
  ];
  const model = transfersModel(entries, { accounts: [ACCOUNT, EVM], cfg: testnet, locale: "en-GB", now: Date.UTC(2026, 9, 26, 10), routeOf, timeZone: "Europe/Amsterdam" });
  assert.equal(model.needs, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(model.groups).map(([key, rows]) => [key, rows.map((row) => row.id)])), { done: ["b"], failed: [], needs: ["a"], other: [], progress: ["d"] });
  const claim = model.groups.needs[0];
  assert.equal(claim.subline, "Ready to claim since 24 Oct, 02:00 CEST");
  assert.equal(claim.action.kind, "finalize");
  assert.equal(claim.href, `#/transfer/0x${"01".repeat(32)}`);
  const html = activityPanel({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  assert.match(html, /data-action="withdrawal-finalize" data-id="a">Claim<span class="sr-only"> 120 DUSK from DuskEVM → Dusk<\/span>/u);
  assert.match(html, /<h2 class="sec-t">Needs you<\/h2>/u);
});

test("each transfer in Activity says whom it pays and its transaction, short as a list writes them, so equal ones are told apart", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  // Discovered from the archive: the DuskEVM recipient in lower case, the hash without 0x.
  const deposit = { amountLux: "500000000", destination: SHOT.toLowerCase(), destinationAt: Date.UTC(2026, 9, 27, 5, 52), hash: `ac6b2f${"9".repeat(52)}16bc24`, id: "d", parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", status: "completed" };
  const withdrawal = { amountLux: "1008000000000", destination: ACCOUNT, hash: `0x04a8a8${"7".repeat(52)}1b3213`, id: "w", parties: [ACCOUNT], routeId: "dusk-evm-to-dusk", stage: "ready_to_prove", status: "pending" };
  const model = transfersModel([deposit, withdrawal], { account: ACCOUNT, accounts: [ACCOUNT], cfg: testnet, locale: "en-GB", name: "alice.dusk", now: Date.UTC(2026, 9, 28), routeOf, timeZone: "Europe/Amsterdam" });
  const [done] = model.groups.done;
  // The address with its checksum's capitals, as the wallet writes it; a dense list's 4 + 4.
  assert.deepEqual([done.to, done.hash], [{ address: "0x96BA…893e" }, "ac6b…bc24"]);
  // Your own account by its .dusk name.
  // An EVM transaction as an EVM address is cut: 0x and 4 + 4.
  assert.deepEqual([model.groups.needs[0].to, model.groups.needs[0].hash], [{ name: "alice.dusk" }, "0x04a8…3213"]);
  const html = activityPanel({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  // Its group says it's completed: the row, when.
  assert.match(html, /<div class="t2">Yesterday, 06:52 CET<\/div><div class="t3">To <code class="mono">0x96BA…893e<\/code> · <code class="mono">ac6b…bc24<\/code><\/div>/u);
  assert.match(html, /<div class="t3">To alice\.dusk · <code class="mono">0x04a8…3213<\/code><\/div>/u);
});

test("a withdrawal that pays someone else waits in its own group, with a quiet Prove and no count on Activity", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  // The stand-in EVM address's 1,008 DUSK withdrawal, which pays 213qXN…V5JJ9Y.
  const stranger = `213qXN${"x".repeat(40)}V5JJ9Y`;
  const entry = { amountLux: "1008000000000", destination: stranger, hash: `0x04a8a8${"7".repeat(52)}1b3213`, id: "w", parties: [EVM.toLowerCase(), stranger], provenByOther: true, routeId: "dusk-evm-to-dusk", sourceAt: Date.UTC(2026, 9, 7, 7, 7), stage: "ready_to_prove", status: "pending" };
  const model = transfersModel([entry], { account: ACCOUNT, accounts: [ACCOUNT, EVM], cfg: testnet, name: "alice.dusk", owner: ACCOUNT, routeOf });
  assert.equal(model.needs, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(model.groups).map(([key, rows]) => [key, rows.map((row) => row.id)])), { done: [], failed: [], needs: [], other: ["w"], progress: [] });
  const html = activityPanel({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  assert.match(html, /<h2 class="sec-t">Sent to someone else<\/h2>/u);
  assert.doesNotMatch(html, /Needs you/u);
  assert.match(html, /<button type="button" class="btn sec xs" data-action="withdrawal-prove" data-id="w">Prove<span class="sr-only">/u);
  // Activity's tab carries no count for it.
  assert.doesNotMatch(cardPage({ activity: html, needsCount: model.needs, tab: "activity" }), /class="cnt"/u);
  // Followed without Dusk Wallet, the followed account is the one it's for.
  assert.deepEqual(transfersModel([entry], { accounts: [ACCOUNT, EVM], cfg: testnet, owner: ACCOUNT, routeOf }).groups.other.map((row) => row.id), ["w"]);
});


test("the top bar names each wallet's account, in the form its wallet writes it, short enough for a phone", () => {
  const top = header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { account: SHOT.toLowerCase(), state: "connected", walletName: "MetaMask" }, isTestnet: true });
  // The EVM address with its checksum's capitals; on a phone, its tail goes: "0x96BA8D…".
  assert.match(top, /<span class="av">.*<\/span><code class="mono">0x96BA8D…<span class="tail">dc893e<\/span><\/code><\/button>/u);
  assert.match(top, /<code class="mono">21n5nc…<span class="tail">fMMLNz<\/span><\/code><\/button>/u);
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
  // A phone shows the labels, without their tails, not the marks alone.
  assert.match(phone, /\.hdr-r \.wpill \.tail \{ display: none; \}/u);
  assert.doesNotMatch(phone, /\.hdr-r \.wpill > :not\(\.av\) \{ display: none; \}/u);
});

test("About this page lists every address short, in full on copy, per route, and names no one as running it", () => {
  const groups = contractGroups(testnet);
  assert.deepEqual(groups.map((group) => group.title), ["Networks", "Sepolia ↔ Dusk", "Dusk ↔ DuskEVM", "Dusk ↔ Sepolia (Hyperlane)", ""]);
  // The Sepolia routes are listed, as paused.
  assert.deepEqual(groups.map((group) => Boolean(group.paused)), [false, true, false, false, false]);
  assert.deepEqual(groups[0].rows.map((row) => [row.label, row.value]), [
    ["Dusk", "dusk:2"],
    ["DuskEVM", "chain 745"],
    ["Sepolia", "chain 11155111"],
  ]);
  // What the sheet used to name an operator with is passed and ignored.
  const html = contractsSheet({ badge: "Testnet", groups, links: testnet.links, operator: "Dusk" });
  for (const value of [
    testnet.evmNetworks.ethereum.migrationContract,
    testnet.evmNetworks.ethereum.tokenContract,
    testnet.service.account,
    // Dusk contracts as every Dusk app writes them: all 64 hex characters without 0x, copied the same.
    testnet.duskEvm.l1StandardBridgeContractId,
    testnet.duskEvm.optimismPortalContractId,
    testnet.duskEvm.disputeGameFactoryContractId,
    testnet.duskEvm.anchorStateRegistryContractId,
    // DuskEVM's predeploys, from its network's file.
    "0x4200000000000000000000000000000000000010",
    "0x4200000000000000000000000000000000000016",
    testnet.multicall.contractId,
    // Hyperlane's, from its deployment's record: each token's route, the tokens issued on Dusk, and both Mailboxes.
    ...testnet.hyperlane.tokens.flatMap((token) => [token.dusk.route, token.evm.token, ...(token.dusk.token ? [token.dusk.token] : [])]),
    testnet.hyperlane.dusk.mailbox,
    testnet.hyperlane.dusk.igp,
    testnet.hyperlane.evm.mailbox,
  ]) {
    // Short, all of it on hover and on copy.
    assert.ok(html.includes(`<code class="mono" title="${value}">${short(value)}</code>`), value);
    assert.ok(html.includes(`data-copy="${value}"`), value);
  }
  assert.deepEqual(groups[3].rows.map((row) => row.label), [
    "DUSK route",
    "DUSK on Sepolia",
    "EURd route",
    "EURd on Dusk",
    "EURd on Sepolia",
    "USDd route",
    "USDd on Dusk",
    "USDd on Sepolia",
    "Mailbox on Dusk",
    "Gas paymaster",
    "Mailbox on Sepolia",
  ]);
  assert.equal(groups[3].rows[1].href, `https://sepolia.etherscan.io/address/${testnet.hyperlane.tokens[0].evm.token}`);
  assert.ok(html.includes(`https://explorer.testnet.dusk.network/accounts/?key=${testnet.service.account}`));
  // The Terms of use and Privacy policy, and nothing more: no operator, and no contract said to hold or keep DUSK.
  assert.match(
    html,
    /<p class="about-links"><a href="https:\/\/dusk\.network\/terms-of-use" target="_blank" rel="noreferrer" aria-label="Terms of use">Terms<\/a><span class="sep" aria-hidden="true">·<\/span><a href="https:\/\/dusk\.network\/privacy-policy" target="_blank" rel="noreferrer" aria-label="Privacy policy">Privacy<\/a><\/p>/u,
  );
  assert.doesNotMatch(html, /Operated by|Keeps the|no function to send|holds the DUSK|Check these against/u);
  // The networks are the network sheet's.
  assert.doesNotMatch(html, /chain 11155111|dusk:2/u);
  assert.equal(groups[1].rows.find((row) => row.label === "Migration contract").note, "");
  assert.equal(groups[2].rows.find((row) => row.label === "Bridge contract").note, "Takes deposits.");
  assert.match(html, /<h3 class="gt">Sepolia ↔ Dusk · paused/u);
  // What each does, behind Details, once for all that do the same.
  assert.match(html, /<details class="wl-more"><summary>Details<\/summary>/u);
  assert.match(html, /<p class="small t2">DUSK route, EURd route, USDd route: Takes what&#039;s sent to Sepolia, and pays out what comes back\.<\/p>/u);
  assert.match(html, /<p class="small t2">DUSK on Sepolia, EURd on Sepolia, USDd on Sepolia: Mints what comes from Dusk, and burns what goes back\.<\/p>/u);
  assert.ok(!html.includes(TIMES));

  // Mainnet: BSC both ways, its account paying out migrations too; Ethereum one way, with its payer.
  const main = contractGroups(mainnet);
  assert.deepEqual(main.map((group) => group.title), ["Networks", "BNB Smart Chain ↔ Dusk", "Ethereum → Dusk", ""]);
  assert.deepEqual(main[1].rows.map((row) => row.label), ["BEP20 DUSK", "Migration contract", "Bridge account", "Pays out from"]);
  // The address the network's file says pays the route out, linked on BscScan.
  assert.deepEqual([main[1].rows[3].value, main[1].rows[3].href], [mainnet.service.payoutAddress, `https://bscscan.com/address/${mainnet.service.payoutAddress}`]);
  assert.match(main[1].rows[2].note, /It also pays out what comes from BNB Smart Chain\.$/u);
  assert.deepEqual(main[2].rows.map((row) => [row.label, row.value]), [
    ["ERC20 DUSK", mainnet.evmNetworks.ethereum.tokenContract],
    ["Migration contract", mainnet.evmNetworks.ethereum.migrationContract],
    ["Payout account", mainnet.evmNetworks.ethereum.payoutAccount],
  ]);

  // No route names who runs it, whatever a deployment sets.
  const operated = profile("mainnet", { VITE_SERVICE_OPERATOR: "Example B.V." });
  assert.ok(contractGroups(operated).every((group) => !("operator" in group)));
  assert.doesNotMatch(contractsSheet({ badge: "Mainnet", groups: contractGroups(operated) }), /Operated by|Example B\.V\./u);
  assert.deepEqual(contractGroups(mainnet)[0].rows[1], { label: "DuskEVM", muted: true, value: "not live yet" });
  // The network sheet: its chains; the badge says it's real DUSK.
  const sheet = networkSheet({ badge: "Mainnet", isTestnet: false, networks: contractGroups(mainnet)[0].rows, otherName: "Testnet", otherSite: "" });
  assert.doesNotMatch(sheet, /Real DUSK|own bridge/u);
  assert.match(networkSheet({ badge: "Mainnet", isTestnet: false, networks: [], otherName: "Testnet", otherSite: "https://bridge.testnet.dusk.network/" }), />Testnet bridge <svg/u);
});

test("a Dusk contract in the Contracts sheet is never linked as an account", () => {
  // Without 0x, an ID with no 0 in it is all Base58 characters, as an account is.
  const ids = ["1b", "2c", "3d", "4e", "5f"].map((pair) => pair.repeat(32));
  const cfg = profile("testnet", {
    VITE_DUSK_MULTICALL_CONTRACT_ID: ids[4],
    VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID: ids[0],
    VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: ids[1],
    VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: ids[2],
    VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: ids[3],
  });
  const groups = contractGroups(cfg);
  const rows = groups.flatMap((group) => group.rows).filter((row) => ids.includes(row.value));
  assert.equal(rows.length, 5);
  for (const row of rows) assert.equal(row.href, null, row.label);
  const html = contractsSheet({ badge: "Testnet", groups });
  for (const id of ids) assert.ok(!html.includes(`key=${id}`), id);
  // The bridge's account keeps its page.
  assert.ok(html.includes(`/accounts/?key=${cfg.service.account}`));
});

test("the card reads as a bridge: From, a flip, To, the route, then one button", () => {
  const vm = cardVmFor();
  const page = cardPage(vm);
  const order = ['aria-current="page">Bridge', 'data-side="from"', 'id="amount"', 'data-action="flip"', 'data-side="to"', 'data-region="receive"', 'class="route"', 'data-action="review"'];
  const at = order.map((part) => page.indexOf(part));
  assert.ok(at.every((index, i) => index > (at[i - 1] ?? -1)), JSON.stringify(at));
  assert.ok(page.includes('value="25"') && page.includes('aria-label="Amount, in DUSK"'));
  assert.match(page, /<span class="token">.*DUSK<\/span>/u);
  assert.match(page, /<span>Public balance<\/span><span class="bal"><span class="num">174\.0037 DUSK<\/span><button type="button" class="mini" data-action="max">Max<\/button><\/span>/u);
  assert.match(page, /<p class="recip"><b class="mono">0xd63bB1…fE8df4<\/b> · <button type="button" class="linkish" data-action="recipient-edit">Change<\/button><\/p>/u);
  // No recipient yet: one is added.
  assert.match(cardPage(cardVmFor({ to: { ...cardVmFor().to, empty: true, line: "No recipient" } })), /<p class="recip">No recipient · <button type="button" class="linkish" data-action="recipient-edit">Add<\/button><\/p>/u);
  // The route's line: its time and fee. The steps and what's public are the review's.
  assert.match(page, /<div class="route-head">.*<span>~1 min · fee up to 0\.005 DUSK<\/span>/u);
  assert.doesNotMatch(page, /pubnote|Public on|Steps|One, in Dusk Wallet/u);
  // The time is the route row's, not a second line in it.
  assert.doesNotMatch(cardRegions(vm).route, />Arrives</u);
  assert.match(page, /Activity<span class="cnt" aria-label="1 need you">1<\/span>/u);
  // No way back: the flip can't be pressed. Dusk Wallet missing: the button is its link.
  assert.match(cardPage(cardVmFor({ canFlip: false })), /data-action="flip" aria-label="Swap From and To" disabled/u);
  assert.match(cardPage(cardVmFor({ button: { action: "get-dusk", enabled: true, href: "https://wallet.example", label: "Get Dusk Wallet" } })), /<a class="btn pri full" href="https:\/\/wallet\.example" target="_blank"/u);
  assert.match(cardPage(cardVmFor({ button: { action: null, enabled: false, label: "Enter an amount" } })), /<button type="button" class="btn pri full" data-action="none" disabled>Enter an amount<\/button>/u);
});
test("everything in the card that follows balances is a region the page refreshes while you type", () => {
  const vm = cardVmFor();
  const regions = cardRegions(vm);
  const page = cardPage(vm);
  for (const name of Object.keys(regions)) assert.ok(page.includes(`data-region="${name}"`), name);
  assert.ok(page.includes(`data-region="from-foot">${regions["from-foot"]}</div>`));
  assert.ok(page.includes(`data-region="cta">${regions.cta}</div>`));
});

test("a network the chosen one has no route to is listed, disabled, saying why", () => {
  const page = cardPage(
    cardVmFor({
      from: { balance: "", balanceLabel: "Balance", net: { id: "dusk-evm", name: "DuskEVM" } },
      menu: "to",
      to: { ...cardVmFor().to, net: { id: "dusk", name: "Dusk" } },
      toChoices: [
        { disabled: "No route", id: "ethereum", name: "Sepolia" },
        { id: "dusk", name: "Dusk", note: "~7 days", selected: true },
        { disabled: true, id: "dusk-evm", name: "DuskEVM" },
      ],
    }),
  );
  assert.match(page, /<div class="netmenu" role="listbox" aria-label="To"><p class="netmenu-t">To<\/p>/u);
  assert.match(page, /data-net="ethereum" aria-selected="false" aria-disabled="true">.*<span class="nm">Sepolia<\/span><span class="sb">No route<\/span>/u);
  // A route's time: its fees are on the card once it's picked.
  assert.match(page, /data-net="dusk" aria-selected="true">.*?<span class="sb">~7 days<\/span>/u);
  // The one it comes from: disabled, without words.
  assert.match(page, /data-net="dusk-evm" aria-selected="false" aria-disabled="true">.*?<span class="nm">DuskEVM<\/span><\/span><\/button>/u);
  assert.match(page, /data-side="to" aria-haspopup="listbox" aria-expanded="true"/u);
});
test("a proof's review says what moves, whom it pays in full, what it costs and when it can be claimed; a claim, what it pays", () => {
  const amountLux = 1_008n * 10n ** 9n;
  const other = { destination: testnet.service.account };
  // Paying another account than Dusk Wallet's says so, by the wallet's .dusk name.
  const prove = actionLead("prove", other, { account: ACCOUNT, amountLux, maturity: 604_800, maxLux: 51_000_000n, name: "alice.dusk" });
  assert.deepEqual(prove, {
    amount: "1,008",
    chain: "dusk",
    label: "Withdrawal",
    line: "",
    notYours: "Not alice.dusk",
    payee: testnet.service.account,
    rows: [
      { key: "fee", label: "Network fee", value: "up to 0.051 DUSK" },
      { key: "when", label: "When", value: "Claim 7 days after you prove." },
    ],
  });
  // Once the request is ready, the date a proof made now can be claimed from: exact against a resolved game.
  const when = (ms) => formatDateTime(ms, { locale: "en-GB", now: Date.UTC(2026, 9, 28), timeZone: "Europe/Amsterdam" });
  const at = Date.UTC(2026, 10, 9, 2, 20);
  assert.equal(actionLead("prove", other, { claim: { at, exact: true }, maturity: 604_800, maxLux: 1n, when }).rows[1].value, "Claim from 9 Nov, 03:20 CET");
  assert.equal(actionLead("prove", other, { claim: { at, exact: false }, maturity: 604_800, maxLux: 1n, when }).rows[1].value, "Claim from about 9 Nov, 03:20 CET");
  const claim = actionLead("finalize", { destination: ACCOUNT }, { account: ACCOUNT, amountLux, maxLux: 51_000_000n });
  assert.deepEqual(claim, { amount: "1,008", chain: "dusk", label: "You claim", line: "", notYours: "", payee: ACCOUNT, rows: [{ key: "fee", label: "Network fee", value: "up to 0.051 DUSK" }] });
  assert.equal(actionLead("finalize", other, { account: ACCOUNT, amountLux, maxLux: 1n }).notYours, "Not your connected account");

  const sheet = reviewSheet({ canConfirm: true, checks: [], confirmLabel: "Prove", feeRows: prove.rows, lead: prove, privacy: "x", steps: [], sub: "" });
  assert.match(sheet, /<div class="k">Withdrawal<\/div><div class="v num">1,008<span class="u">DUSK<\/span>/u);
  assert.ok(sheet.includes(`To <code class="mono wrap">${testnet.service.account}</code> on Dusk`));
  // A warning before what it costs, not a line among them.
  assert.match(sheet, /<div class="group pad warn-box" role="note"><div class="note">.*?<span>Not alice\.dusk<\/span>/u);
  assert.ok(sheet.indexOf("warn-box") < sheet.indexOf('class="group kvs"'));
  assert.doesNotMatch(sheet, /You send|You receive|No DUSK moves/u);
});

test("a review says what becomes public right under what moves, before what could cost money and the fees", () => {
  const privacy = "Public: both accounts and the amount";
  const at = (sheet, part) => sheet.indexOf(part);
  // A transfer: under You send and You receive, above a warning, a check that fails and the fees.
  const send = reviewSheet({
    canConfirm: false, checks: [{ html: "Not enough DUSK for this and the network fee: you have <b>1 DUSK</b>", ok: false }], confirmLabel: "Send 2 DUSK", feeRows: [{ key: "fee", label: "Network fee", value: "up to 0.0025 DUSK" }],
    notYours: "Not your connected account", privacy, receive: { amount: "1", chain: "ethereum", unit: "ERC20 DUSK", where: "Sepolia" },
    send: { amount: "2", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, ready: true, title: "Send from Dusk", walletName: "Dusk Wallet" }], sub: "",
  });
  const order = ["You receive", "<b>Public:</b>", "warn-box", 'class="ck"', 'class="group kvs"'].map((part) => at(send, part));
  assert.ok(order.every((index, i) => index > (order[i - 1] ?? -1)), JSON.stringify(order));
  assert.equal(send.match(/Public:/gu).length, 1);
  // A proof: under what moves.
  const prove = reviewSheet({
    canConfirm: true, checks: [], confirmLabel: "Prove", feeRows: [],
    lead: { amount: "1,008", label: "Withdrawal", notYours: "", payee: "x" }, privacy, steps: [], sub: "",
  });
  assert.ok(at(prove, "Withdrawal") < at(prove, "Public:") && at(prove, "Public:") < at(prove, 'class="group kvs"'));
  assert.doesNotMatch(prove, /warn-box/u);
});

test("the form shows one number format: the balance and what's available, to 4 decimals", () => {
  // 1,483.112423314 DUSK less the 0.005 maximum fee.
  assert.deepEqual(availableLine(T["duskevm-deposit"], 1_483_107_423_314n), { available: "1,483.1074 DUSK", availableLabel: "Available after fees", canMax: true });
  assert.deepEqual(availableLine(T.migration, 2_500_000_000_000n), { available: "2,500 ERC20 DUSK", availableLabel: "Available", canMax: true });
  assert.equal(availableLine(T["duskevm-deposit"], null).available, "");
});

test("a Dusk review's fees and balance check follow the price its request was built with", () => {
  const reads = { duskBalance: 106_000_000n, gasPrice: 1n };
  const context = { amount: "0.1", cfg: testnet, destination: EVM, duskAccount: ACCOUNT, evm: { account: EVM }, reads };
  // 0.1 DUSK and a fee of up to 0.005 fit in 0.106; at a doubled price, they don't.
  const asRead = pricedReview(T["duskevm-deposit"], { ...context, gasPrice: 1n });
  assert.equal(asRead.checks[0].ok, true);
  const risen = pricedReview(T["duskevm-deposit"], { ...context, gasPrice: 2n });
  assert.equal(risen.checks[0].ok, false);
  assert.equal(risen.feeRows.find((row) => row.key === "fee").value, "up to 0.01 DUSK");
});

test("the footer links the terms of use and privacy policy, and names no one as running the bridge", () => {
  // What the footer used to name operators with is passed and ignored.
  const dusk = footer({
    links: { privacy: mainnet.links.privacy, terms: mainnet.links.terms },
    officialSite: "",
    operator: "Dusk",
    operators: [{ name: "Example B.V.", route: "Dusk to BNB Smart Chain" }],
  });
  assert.match(dusk, /<a href="https:\/\/dusk\.network\/terms-of-use" target="_blank" rel="noreferrer" aria-label="Terms of use">Terms<\/a><a href="https:\/\/dusk\.network\/privacy-policy" target="_blank" rel="noreferrer" aria-label="Privacy policy">Privacy<\/a><\/nav><\/footer>/u);
  assert.match(dusk, /aria-label="About this page">About<\/button>/u);
  assert.doesNotMatch(dusk, /Operated by|run-by|Example B\.V\.|How the bridge works|support/iu);
});

test("the bridge screen and Activity each have a page heading", () => {
  assert.match(cardPage(cardVmFor()), /<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Bridge DUSK<\/h1>/u);
  assert.match(cardPage({ activity: "", needsCount: 0, tab: "activity" }), /<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Activity<\/h1>/u);
  // The entry line under the card, after it.
  const page = cardPage(cardVmFor({ entry: [{ href: "#/move/ethereum-to-dusk", name: "Ethereum" }] }));
  assert.ok(page.indexOf('<p class="entry">') > page.indexOf('data-region="cta"'));
});

test("a proof's review says the account that proves becomes public too", () => {
  assert.equal(actionPrivacy("prove"), "Public: your account, as the prover");
  assert.equal(actionPrivacy("finalize"), "Public: your account and the claim");
});

test("a withdrawal claimed outside this browser reads as claimed", () => {
  const entry = { amountLux: "1000000000", destination: ACCOUNT, hash: `0x${"34".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", sender: EVM, stage: "finalized", status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T["duskevm-withdrawal"], url: "https://bridge.example/#/transfer/x" });
  assert.match(model.details.find((row) => row.label === "Claim").html, />Claimed</u);
});

test("your Dusk account shows by the .dusk name Dusk Wallet sent", () => {
  const top = header({ badge: "Testnet", dusk: { account: ACCOUNT, name: "alice.dusk", state: "connected" }, evm: { state: "connect" }, isTestnet: true, nav: "move" });
  assert.match(top, /<span class="av">.*<\/span><span class="nm" title="alice\.dusk">alice\.dusk<\/span><\/button>/u);
  // A long name is cut short in the bar (style.css): it's there in full on hover and for a screen reader.
  const long = `${"a".repeat(63)}.${"b".repeat(63)}.dusk`;
  const named = header({ badge: "Testnet", dusk: { account: ACCOUNT, name: long, state: "connected" }, evm: { state: "connect" }, isTestnet: true });
  assert.ok(named.includes(`<span class="nm" title="${long}">${long}</span>`));
  assert.ok(named.includes(`aria-label="Dusk Wallet, account ${long}, ${ACCOUNT}"`));
  assert.doesNotMatch(header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { state: "connect" }, isTestnet: true }), /class="nm"/u);
  // A receipt says who sent it by its short code, and whom it paid in full.
  const entry = { amountLux: "100000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const url = "https://bridge.example/#/transfer/x";
  for (const own of [{ account: ACCOUNT, name: "alice.dusk" }, { account: "someone else", name: "bob.dusk" }])
    assert.equal(receiptModel(entry, { cfg: testnet, own, route: T["duskevm-deposit"], url }).fromTo, `<code class="mono">21n5nc…fMMLNz</code> → <code class="mono wrap">${EVM}</code>`);
  // Where only one is known, that one.
  assert.equal(receiptModel({ ...entry, sender: undefined }, { cfg: testnet, route: T["duskevm-deposit"], url }).fromTo, `To <code class="mono wrap">${EVM}</code>`);
});

test("a typed .dusk name shows the account it points to, and wrong capitals offer the fix", () => {
  const to = { ...cardVmFor().to, editing: true, input: "alice.dusk", label: "Recipient", net: { id: "dusk", name: "Dusk" }, placeholder: "Account or .dusk name", resolved: { address: ACCOUNT, name: "alice.dusk" } };
  const vm = cardVmFor({ to });
  const page = cardPage(vm);
  // The field wraps, so the whole address shows on a phone.
  assert.match(page, /<textarea id="recipient" name="recipient" class="mono-input wrap-input" rows="2"[^>]*>alice\.dusk<\/textarea>/u);
  // Short, all of it on hover; the review shows it in full.
  assert.ok(page.includes(`alice.dusk = <code class="mono" title="${ACCOUNT}">21n5nc…fMMLNz</code>`));
  const note = (patch) => cardRegions({ ...vm, to: { ...to, resolved: null, ...patch } })["recipient-note"];
  assert.equal(note({ looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.match(note({ error: "x", fix: EVM }), /<button type="button" class="linkish" data-action="recipient-fix">Fix capitals<\/button>/u);
  assert.equal(note({}), "");
});
test("About this page names, in one line, the servers the page reads from", async () => {
  const line = serversLine(testnet);
  assert.equal(line, "Reads from testnet.nodes.dusk.network, rpc.testnet.evm.dusk.network, ethereum-sepolia-rpc.publicnode.com, testnet.dusk.domains");
  // In the About sheet the footer opens, with the contracts.
  assert.match(footer({ links: {}, officialSite: "" }), /<button type="button" class="linkish" data-action="open-about" aria-haspopup="dialog" aria-label="About this page">About<\/button>/u);
  const sheet = contractsSheet({ badge: "Testnet", groups: contractGroups(testnet), servers: line });
  assert.match(sheet, /<h2 id="sheet-title">About · Testnet<\/h2>/u);
  assert.match(sheet, /<section class="cgroup"><p class="card about-servers">Reads from testnet\.nodes\.dusk\.network/u);
  assert.ok(sheet.indexOf("Reads from") < sheet.indexOf("Bridge contract"));
  // The names' host is the one each network's pinned release fetches its lens driver from, last.
  for (const cfg of [testnet, mainnet]) assert.ok(serversLine(cfg).endsWith(`, ${new URL(releaseFor(cfg.dusk.chainId).artifactBaseUrl).host}`));
});

test("Activity can follow a Dusk account without a wallet, and stop", () => {
  const page = (watch) => activityPanel({ empty: "e", groups: {}, lede: "l", syncText: "", watch });
  const form = page({ busy: false, error: "", following: "", input: "" });
  assert.match(form, /<form class="group pad watch" data-form="watch">\s*<label for="watch" class="l1">Follow a Dusk account<\/label>/u);
  assert.match(form, /placeholder="Account or \.dusk name"/u);
  assert.match(form, />Show transfers<\/button>/u);
  assert.match(page({ busy: false, error: "bob.dusk isn't an active .dusk name.", following: "", input: "bob.dusk" }), /role="alert">bob\.dusk isn&#039;t an active \.dusk name\.<\/p>/u);
  const following = page({ following: "alice.dusk" });
  // Whom it follows is the list's lede; the line offers to stop.
  assert.match(following, /<button type="button" class="linkish" data-action="unwatch" aria-label="Stop following alice\.dusk">Stop following<\/button>/u);
  assert.doesNotMatch(following, /data-form="watch"/u);
  // With Dusk Wallet connected, there's nothing to follow.
  assert.doesNotMatch(page(null), /Follow a Dusk account|Stop following/u);
});

test("a route is two marks with an arrow, and DuskEVM is told apart from Dusk", () => {
  assert.match(pairMark("dusk", "dusk-evm"), /^<span class="pair" aria-hidden="true"><span class="cm" aria-hidden="true">.*<\/span><svg class="ic pa"[^>]*><path d="M5 12h14"\/>.*<span class="cm evm" aria-hidden="true">.*<span class="evm-tag">EVM<\/span><\/span><\/span>$/u);
  assert.doesNotMatch(chainMark("dusk"), /evm-tag/u);
  for (const chain of ["ethereum", "bsc"]) assert.match(chainMark(chain), /<svg class="mk-svg" viewBox="0 0 24 24"[^>]*><path /u, chain);
});

test("the card, its quote, the review, the receipt and the transfer quote one fee a step", () => {
  const gasPrice = 2n;
  const route = T["duskevm-withdrawal"];
  const withdrawalGas = 519_542n;
  // Before the withdrawal exists: the card's route line, both steps' together, and its quote, each step's.
  assert.equal(routeLines(route, testnet, { gasPrice })[1], "Then up to 0.204 DUSK on Dusk");
  const form = buildQuote(route, "1", { balance: null, cfg: testnet, gasPrice });
  assert.equal(form.rows.find((row) => row.key === "fee-dusk").value, "up to 0.102 DUSK each");
  // Once it exists, with its own gas: the card, the receipt, and the review's request.
  const entry = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: route.id, sourceAt: Date.UTC(2026, 9, 1), stage: "ready_to_prove", status: "pending", withdrawalGas: withdrawalGas.toString() };
  assert.equal(receiptModel(entry, { cfg: testnet, gasPrice, route, url: "https://bridge.example/#/transfer/w" }).actionFee, "Network fee up to 0.102 DUSK");
  const request = withdrawalGasLimit(withdrawalGas) * gasPrice;
  assert.equal(request, withdrawalStepMax({ gasPrice, withdrawalGas }));
  for (const kind of ["prove", "finalize"]) assert.equal(actionLead(kind, entry, { maxLux: request }).rows[0].value, "up to 0.102 DUSK", kind);
});

test("the pages say what's public and what to do, without explaining what they already show", () => {
  const route = T["duskevm-deposit"];
  const entry = { amountLux: "25000000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: route.id, sender: ACCOUNT, sourceAt: Date.UTC(2026, 9, 26, 9, 31), status: "pending" };
  const receipt = receiptPage({ ...receiptModel(entry, { cfg: testnet, now: entry.sourceAt + 60_000, route, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  const review = reviewSheet({ canConfirm: true, checks: [], confirmLabel: "Send 25 DUSK", feeRows: [], privacy: "Public: both accounts and the amount", receive: { amount: "25", chain: "dusk-evm", unit: "DUSK", where: "DuskEVM" }, send: { amount: "25", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, ready: true, title: "Send from Dusk", walletName: "Dusk Wallet" }], sub: "" });
  const card = cardPage(cardVmFor({ routeOpen: true }));
  const about = contractsSheet({ badge: "Testnet", groups: contractGroups(testnet), servers: serversLine(testnet) });
  for (const page of [receipt, review, card, about]) {
    // Reassurance and lines that repeat the page are gone.
    assert.doesNotMatch(page, /doesn't let anyone move|public balances only|You can close this page|public on both networks anyway|Keep the receipt link|holds the DUSK while|safety window|First time\?|What it reads from/u);
  }
  // What's public stays, once, in one line; nothing walks through the wallet's window or narrates the obvious.
  assert.equal(review.match(/Public:/gu)?.length, 1);
  for (const page of [receipt, review, card]) assert.doesNotMatch(page, /Check each line|will show|Step 2 opens|Anyone with the link|usually about|on top of the amount/u);
  // The deposit's steps say nothing the hero, the caption or the details don't.
  assert.deepEqual(receiptModel(entry, { cfg: testnet, now: entry.sourceAt + 60_000, route, url: "x" }).view.steps.map((step) => step.detail), ["", ""]);
});

test("a Dusk recipient handed over in the link reads as Paying, with a way to change it", () => {
  const line = (route, options) => recipientLine(route, { destination: ACCOUNT, ...options });
  assert.equal(line(T.migration, { handedOver: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>');
  // Even when it's the connected account; another one is said.
  assert.equal(line(T["duskevm-withdrawal"], { connected: true, duskName: "alice.dusk", handedOver: true, own: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>');
  assert.equal(line(T.migration, { connected: true, handedOver: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>, not your connected account');
  // Otherwise the account itself, by its .dusk name where it has one: the wallet's name adds nothing.
  assert.equal(line(T.migration, {}), '<b class="mono">21n5nc…fMMLNz</b>');
  assert.equal(line(T.migration, { duskName: "alice.dusk", own: true }), "<b>alice.dusk</b>");
  assert.equal(line(T.migration, { resolved: { address: ACCOUNT, name: "bob.dusk" } }), '<b>bob.dusk</b> (21n5nc…fMMLNz)');
  assert.doesNotMatch(recipientLine(T.service ?? { to: { kind: "evm" } }, { destination: "0x5a3D8e1B7c2f4A6b9E0d1C3f5a7B9c2D4e6F8a01", own: true }), /your/u);
  assert.equal(recipientLine(T.migration, {}), "No recipient");
  assert.equal(recipientLine(T["duskevm-deposit"], { destination: EVM, own: true }), '<b class="mono">0xd63bB1…fE8df4</b>');
  // The card: the line, then Change.
  const page = cardPage(cardVmFor({ to: { ...cardVmFor().to, label: "Recipient", line: line(T.migration, { handedOver: true }), net: { id: "dusk", name: "Dusk" } } }));
  assert.match(page, /<p class="recip">Paying <b class="mono">21n5nc…fMMLNz<\/b> · <button type="button" class="linkish" data-action="recipient-edit">Change<\/button><\/p>/u);
});

test("with more than one Dusk wallet to choose from, each is offered by name, and so is one left alone", () => {
  const two = walletsSheet({ wallets: [{ id: "a", name: "Dusk Wallet", rdns: "network.dusk.wallet" }, { id: "b<", name: "Piewallet", rdns: "com.piewallet" }] });
  assert.match(two, /<h2 id="sheet-title">Choose a wallet<\/h2><\/div>/u);
  assert.deepEqual([...two.matchAll(/data-action="choose-dusk" data-wallet="([^"]+)">.*?<span class="nm">([^<]+)<\/span><span class="sb">([^<]+)<\/span>/gu)].map((match) => match.slice(1)), [
    ["a", "Dusk Wallet", "network.dusk.wallet"],
    ["b&lt;", "Piewallet", "com.piewallet"],
  ]);
  // The wallet chosen here before is gone: the one left is offered, not taken for you.
  const one = walletsSheet({ wallets: [{ id: "a", name: "Dusk Wallet", rdns: "network.dusk.wallet" }] });
  assert.doesNotMatch(one, /class="sub"/u);
  assert.equal([...one.matchAll(/data-action="choose-dusk"/gu)].length, 1);
});

test("the card and the review say once, calmly, when the bridge fee is more than the amount, and block nothing", () => {
  const route = buildRoutes(testnet).find((each) => each.id === "dusk-to-sepolia");
  const quote = buildQuote(route, "1", { balance: 2_000n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } });
  assert.deepEqual(feeNotes(quote), ["Bridge fee is more than the amount"]);
  assert.deepEqual(feeNotes(buildQuote(route, "20", { balance: 2_000n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } })), []);
  // Under the card's route line, beside the fees it's about; the button still reviews.
  const vm = cardVmFor({ feeNotes: feeNotes(quote), quote, routeLines: routeLines(route, testnet, { quote }), routeRows: routeDetailRows(route, quote) });
  const { cta, route: row } = cardRegions(vm);
  assert.match(row, /<span>~20 s · fees up to 16\.881 DUSK<\/span><span class="route-status warn">Bridge fee is more than the amount<\/span>/u);
  assert.ok(cta.includes('data-action="review"') && !cta.includes("disabled"), cta);
  assert.doesNotMatch(cardRegions(cardVmFor()).route, /more than the amount/u);
  // On the review, once, as a line of its own; Confirm stays on.
  const sheet = reviewSheet({
    canConfirm: true, checks: [], confirmLabel: "Send 1 DUSK", feeRows: quote.rows.filter((each) => !["send", "receive"].includes(each.key)), notes: feeNotes(quote), privacy: "Public: both accounts and the amount",
    receive: { account: EVM, amount: "1", chain: "ethereum", full: true, unit: "DUSK", where: "Sepolia" }, send: { account: "21n5nc…fMMLNz", amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, ready: true }], sub: "",
  });
  assert.equal(sheet.match(/Bridge fee is more than the amount/gu)?.length, 1);
  assert.match(sheet, /<p class="note">.*?<span>Bridge fee is more than the amount<\/span><\/p>/u);
  assert.match(sheet, /data-action="confirm" >Send 1 DUSK</u);
});

test("a call Dusk Wallet can't read is under Details, folded, named for what the wallet asks", () => {
  const call = [
    { label: "Method", mono: true, value: "transfer_remote" },
    { full: "979fb72774e1d45a07abd0d57479578513917ab855bb4027acdfd48ac8ee5a0b", label: "Contract", mono: true, value: "979fb7…ee5a0b" },
    { label: "Recipient", mono: true, value: EVM, wrap: true },
    { detail: "the amount and the bridge fee", label: "Deposit", value: "17.876 DUSK" },
  ];
  const vm = (step) => ({ canConfirm: true, checks: [], confirmLabel: "Send 1 DUSK", feeRows: [], privacy: "x", receive: { amount: "1", chain: "ethereum", unit: "DUSK", where: "Sepolia" }, send: { amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, ready: true, ...step }], sub: "" });
  const sheet = reviewSheet(vm({ call }));
  // Folded, and found by what the wallet's window says to check.
  assert.match(sheet, /<details class="wl-more"><summary>Call details, to check against Dusk Wallet<\/summary><dl class="group kvs">/u);
  assert.match(sheet, /<dt class="k">Method<\/dt><dd class="v"><code class="mono">transfer_remote<\/code><\/dd>/u);
  assert.ok(sheet.includes('<code class="mono" title="979fb72774e1d45a07abd0d57479578513917ab855bb4027acdfd48ac8ee5a0b">979fb7…ee5a0b</code>'));
  assert.ok(sheet.includes(`<code class="mono wrap">${EVM}</code>`));
  assert.match(sheet, /<dt class="k">Deposit<\/dt><dd class="v"><span class="stack"><span class="num">17\.876 DUSK<\/span><span class="small">the amount and the bridge fee<\/span><\/span><\/dd>/u);
  // A call the wallet reads itself, or one not built yet: no fold.
  assert.doesNotMatch(reviewSheet(vm({})), /Call details/u);
  assert.doesNotMatch(reviewSheet(vm({ call: null, ready: false })), /Call details/u);
});
