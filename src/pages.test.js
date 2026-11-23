import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encodeDepositArgs } from "@dusk-network/networks/duskevm";
import { withdrawalGasLimit } from "@dusk-network/networks/gas";
import { releaseFor } from "@duskdomains/sdk/releases";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { NETWORK_BUSY, actionLead, actionPrivacy, availableLine, balanceLine, busyNotes, feeNotes, openApproval, pricedReview, receiptModel, recipientLine, replacedLine, reviewChecks, revokeReview, routeDetailRows, routeLines, stepOfReview, transfersModel } from "./page-models.js";
import { DURATION, ESTIMATE, amountsIn, assertShownInFull, byLabel, copiesOf, decode, exactly, fieldOf, fieldsOf, linksOf, paidOf, partsOf, stepPartsOf, textOf } from "./pages.fixtures.js";
import { buildQuote, withdrawalStepMax } from "./quote.js";
import { PUBLIC_LINE } from "./transfer-view.js";
import { cardPage, cardRegions, contractsSheet, footer, header, receiptPage, reviewSheet, walletLines, walletsSheet, wholeNumbers } from "./views.js";
import { formatDateTime } from "./format.js";
import { approveLines, duskCallLines, duskTransferLines, migrateLines, walletFee, withdrawalAmount } from "./wallet-lines.js";
import { driverJson, loadDataDriver } from "./data-driver.js";
import { NO_PAYOUT, createTracking } from "./tracking.js";
import { contractCreditLog, messagePassedLog, u256, withdrawalInput } from "./withdrawals.fixtures.js";

/** The card's route line as it reads: its lines, one after the other. */
const routeLine = (route, cfg, options) => routeLines(route, cfg, options).join(" ");

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
  return {
    amount: "25",
    amountError: "",
    button: { action: "review", enabled: true, label: "Review bridge" },
    canFlip: true,
    canMax: true,
    error: "",
    from: { balance: "174.0037 DUSK", balanceLabel: "Public balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    hint: "",
    menu: null,
    needsCount: 1,
    notice: null,
    privacy: "Public and linked: your Dusk account wallet-both.dusk (21n5nc…fMMLNz), 0xd63bB1…fE8df4 and the amount.",
    quote: buildQuote(T["duskevm-deposit"], "25", { balance: 174_003_700_000n, cfg: testnet, gasPrice: 1n }),
    receive: "25",
    receiveUnit: "DUSK",
    routeLines: routeLines(T["duskevm-deposit"], testnet),
    routeRows: routeDetailRows(T["duskevm-deposit"], buildQuote(T["duskevm-deposit"], "25", { balance: 174_003_700_000n, cfg: testnet, gasPrice: 1n })),
    routeOpen: false,
    steps: "One, in Dusk Wallet",
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient on DuskEVM", line: 'to your MetaMask <b class="mono">0xd63b…8df4</b>', looking: "", net: { id: "dusk-evm", name: "DuskEVM" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    unit: "DUSK",
    ...patch,
  };
}
const EVM = "0xd63bB1959D64E236f63DDC62c37248708ffE8df4";
const explorer = { explorer: (network, address) => explorerAddressUrl(testnet, network, address) };
// The lookalike that must never appear where addresses are checked.
const TIMES = "×";
// The words an allowance with no limit, and one with nothing left of it, are said in.
const UNLIMITED = /\b(?:unlimited|no limit|any amount)\b/iu;
const NOTHING_LEFT = /\b(?:nothing|none)\b/iu;
// Where these say something is so: only a short phrase, as copy changes around it.
const MOVES_NO_DUSK = /\b(?:no DUSK moves|moves no DUSK)\b/iu;
const PAYS_OUT = /\bpays? out\b/iu;
// The explorers' pages, as the page links them.
const DUSK_ACCOUNT = (account) => `https://explorer.testnet.dusk.network/accounts/?key=${account}`;
const DUSK_TX = (hash) => `https://explorer.testnet.dusk.network/transactions/transaction?id=${hash}`;
const DUSKEVM_ADDRESS = (address) => `https://explorer.testnet.evm.dusk.network/address/${address}`;
const SEPOLIA_ADDRESS = (address) => `https://sepolia.etherscan.io/address/${address}`;

// A page with its Details opened, as a press on Details shows them.
const opened = (page) => page.replace(/<details(?![^>]*\bopen\b)/gu, "<details open");

/** An allowance with no limit, said as that: no amount, no 0, never that nothing's left of it. */
function assertUnlimited(text) {
  assert.deepEqual(amountsIn(text), [], text);
  assert.doesNotMatch(text, /(?<![\w.,−-])0(?![\w.,])/u, text);
  assert.doesNotMatch(text, NOTHING_LEFT, text);
  assert.match(text, UNLIMITED, text);
}

test("the card's route row gives each route its time and the coin and cost of its fee", () => {
  const line = (mode, cfg = testnet, timing) => routeLine(routesOf(cfg)[mode], cfg, { timing });
  assert.match(line("duskevm-deposit"), exactly("~1 min"));
  assert.deepEqual(amountsIn(line("duskevm-deposit")), ["≤0.005 DUSK"]);
  // The withdrawal's time is the chain's: none until it's read. Its two steps on Dusk, the proof and the claim, as one figure.
  assert.deepEqual(amountsIn(line("duskevm-withdrawal")), ["≤0.102 DUSK"]);
  assert.doesNotMatch(line("duskevm-withdrawal"), DURATION);
  const read = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
  assert.match(line("duskevm-withdrawal", testnet, read), exactly("~7 days"));
  // No time is known for the testnet payouts: the cost alone.
  assert.deepEqual(amountsIn(line("service-transfer")), ["1 DUSK"]);
  assert.doesNotMatch(line("service-transfer"), DURATION);
  assert.match(line("migration"), exactly("ETH"));
  // Mainnet's own times, and the coin each EVM chain's fee is paid in.
  assert.match(line("service-transfer", mainnet), exactly("~10 hours"));
  assert.deepEqual(amountsIn(line("service-transfer", mainnet)), ["1 DUSK"]);
  const from = (id) => buildRoutes(mainnet).find((route) => route.from.id === id);
  assert.match(routeLine(from("ethereum"), mainnet), exactly("~70 min"));
  assert.match(routeLine(from("ethereum"), mainnet), exactly("ETH"));
  assert.match(routeLine(from("bsc"), mainnet), exactly("~1 hour"));
  assert.match(routeLine(from("bsc"), mainnet), exactly("BNB"));
});

test("how the route is doing is said under it, and stops nobody from sending", () => {
  const status = { inline: true, text: "Payouts are running late. Last payout 3 hours ago.", warn: true };
  const { cta, route } = cardRegions(cardVmFor({ status }));
  assert.ok(textOf(route).includes(status.text), route);
  assert.equal(cta, cardRegions(cardVmFor())["cta"]);
  assert.ok(cta.includes('data-action="review"') && !cta.includes("disabled"), cta);
});

test("the review checks the facts first, shows the spender in full, names its step on the button, and lists what else the wallet shows under Details, addresses in full", async () => {
  const route = T.migration;
  const lux = 1_000_000_000_000n;
  const reads = { migration: { allowanceWei: 0n, balanceWei: 2_500n * 10n ** 18n, gasCoinWei: 21_300_000_000_000_000n, gasPriceWei: 2_000_000_000n } };
  const quote = buildQuote(route, "1000", { allowanceWei: 0n, balance: reads.migration.balanceWei, cfg: testnet, evmGas: { approve: 46_000n, migrate: 70_000n, priceWei: 2_000_000_000n } });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote, reads });
  assert.deepEqual(checks.map((check) => check.ok), [true, true]);
  // What the wallet holds; then what both steps need, and the ETH it has.
  assert.deepEqual(amountsIn(checks[0].html), ["2,500 ERC20 DUSK"]);
  assert.deepEqual(amountsIn(checks[1].html), ["0.00023 ETH", "0.0213 ETH"]);
  // Not enough ETH is caught before the wallet opens.
  const poor = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { migration: { ...reads.migration, gasCoinWei: 1n } } });
  assert.equal(poor[1].ok, false);

  const { migrationContract, tokenContract } = testnet.evmNetworks.ethereum;
  const approve = approveLines({ amountLux: lux, cfg: testnet, fee: 92_000_000_000_000n, network: "ethereum" });
  const migrate = migrateLines({ amountLux: lux, cfg: testnet, duskAccount: ACCOUNT, fee: null, network: "ethereum" });
  // The approval, field by field: the network, the token, the spender, a cap of exactly the amount, and its fee.
  const approval = byLabel(approve);
  assert.equal(approval.Network.value, "Sepolia, chain 11155111");
  assert.deepEqual([approval.Token.value, approval.Token.address], ["ERC20 DUSK", tokenContract]);
  assert.equal(approval.Spender.address, migrationContract);
  assert.equal(approval["Spending cap"].value, "1,000 ERC20 DUSK");
  assert.deepEqual(amountsIn(approval["Network fee"].value), ["0.000092 ETH"]);
  // The migration, by the arguments the contract names: the amount in wei, the Dusk account it pays, and what leaves the wallet.
  const migration = byLabel(migrate);
  assert.equal(migration["Interacting with"].address, migrationContract);
  assert.equal(migration.amount.value, "1000000000000000000000");
  assert.deepEqual(amountsIn(migration.amount.note), ["1,000 DUSK"]);
  assert.equal(migration.targetAddress.address, ACCOUNT);
  assert.equal(migration["Estimated change"].value, "−1,000 ERC20 DUSK");
  // A fee not estimated yet isn't made up.
  assert.deepEqual(amountsIn(migration["Network fee"].value), []);

  const spender = { address: migrationContract, name: "Dusk migration contract", network: "ethereum" };
  const vm = (current) => ({
    canConfirm: true,
    cfgLinks: explorer,
    checks,
    confirmLabel: current === 0 ? "Approve 1,000 ERC20 DUSK" : "Migrate 1,000 ERC20 DUSK",
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    privacy: PUBLIC_LINE,
    receive: { account: ACCOUNT, amount: "1,000", chain: "dusk", full: true, unit: "DUSK", where: "Dusk" },
    send: { account: "0xd63bB1…fE8df4", amount: "1,000", chain: "ethereum", unit: "ERC20 DUSK", where: "Sepolia" },
    stepOf: stepOfReview({ current, steps: [{}, {}] }),
    steps: [
      { current: current === 0, lines: approve, ready: true, spender, title: "Approve exactly 1,000 ERC20 DUSK", walletName: "MetaMask" },
      { current: current === 1, lines: migrate, ready: true, title: "Migrate", walletName: "MetaMask" },
    ],
    sub: "",
  });
  const approving = reviewSheet(vm(0));
  // In view, as the security check of an approval: the spender in full, its Copy button copying exactly it, on its explorer.
  assertShownInFull(fieldOf(approving, "Spender"), migrationContract, SEPOLIA_ADDRESS(migrationContract));
  // The button names the step it takes, with which of the two it is; no row lists the steps.
  assert.equal(textOf(partsOf(approving, "pri")[0]), "Approve 1,000 ERC20 DUSK 1 of 2");
  assert.deepEqual(fieldsOf(opened(approving)).filter((field) => ["Network", "Steps"].includes(field.label)), []);
  // Under Details, what else the wallet will show, the token in full: not the network From says, the spender above,
  // the cap the button approves, or the fee.
  const [details] = partsOf(approving, "wl-more");
  assert.deepEqual(fieldsOf(details).map((field) => field.label), ["Token"]);
  assertShownInFull(fieldOf(details, "Token"), tokenContract, SEPOLIA_ADDRESS(tokenContract));
  // The migration's, once it's the step at hand: whom it pays is in view, in full, so Details has the contract and the call.
  const migrating = reviewSheet(vm(1));
  assert.equal(textOf(partsOf(migrating, "pri")[0]), "Migrate 1,000 ERC20 DUSK 2 of 2");
  assert.ok(textOf(migrating).split(" ").includes(ACCOUNT));
  const [then] = partsOf(migrating, "wl-more");
  assert.deepEqual(fieldsOf(then).map((field) => [field.label, field.text]), [
    ["Interacting with", `Dusk migration contract ${migrationContract}`],
    ["Method", "migrate"],
    ["amount", "1000000000000000000000 = 1,000 DUSK, in 18 decimals: 18 more digits than you typed."],
  ]);
  assertShownInFull(fieldOf(then, "Interacting with"), migrationContract, SEPOLIA_ADDRESS(migrationContract));
  assert.ok(!approving.includes(TIMES) && !migrating.includes(TIMES));
});

test("a review's step count follows its steps, and says none while the wallet's asked or the chain's switched", () => {
  const two = { current: 0, steps: [{}, {}] };
  assert.deepEqual([stepOfReview(two), stepOfReview({ ...two, current: 1 })], [{ at: 1, of: 2 }, { at: 2, of: 2 }]);
  // One step: nothing to count. A withdrawal's own three, as its review says them.
  assert.equal(stepOfReview({ current: 0, steps: [{}] }), null);
  assert.deepEqual(stepOfReview({ current: 0, stepOf: { at: 2, of: 3 }, steps: [{}] }), { at: 2, of: 3 });
  // Asked of the wallet, or of the chain first: no step of the transfer.
  assert.equal(stepOfReview({ ...two, busy: true }), null);
  assert.equal(stepOfReview(two, { switching: true }), null);
});

test("an approval not used up is offered to finish or revoke, for what it still lets go", () => {
  const route = T.migration;
  const HALF = 5n * 10n ** 17n;
  const held = 5n * 10n ** 18n;
  const open = openApproval(route, { allowanceWei: HALF, balanceWei: held, evm: EVM });
  const box = cardRegions(cardVmFor({ approval: open })).approval;
  // What the migration contract may still take, from which address, and both ways out.
  assert.deepEqual(amountsIn(box), ["0.5 ERC20 DUSK"]);
  assert.match(textOf(box), exactly("0xd63bB1…fE8df4"));
  assert.ok(box.includes('data-action="approval-finish"') && box.includes('data-action="approval-revoke"'), box);
  // Covering the amount, it leaves one wallet step.
  const steps = (amount) => buildQuote(route, amount, { allowanceWei: HALF, balance: held, cfg: testnet }).steps;
  assert.equal(steps("0.5"), 1);
  for (const more of ["0.6", ""]) assert.notEqual(steps(more), 1, more);
  // Finish goes for what it still lets go, of what the wallet holds.
  assert.equal(open.finishLux, 500_000_000n);
  assert.equal(openApproval(route, { allowanceWei: 10n * held, balanceWei: held, evm: EVM }).finishLux, 5_000_000_000n);
  // With nothing to finish it with, or on a route that isn't running: Revoke alone.
  for (const quiet of [{ balanceWei: 0n }, { paused: true }]) {
    const only = cardRegions(cardVmFor({ approval: openApproval(route, { allowanceWei: HALF, balanceWei: held, evm: EVM, ...quiet }) })).approval;
    assert.ok(!only.includes("approval-finish") && only.includes("approval-revoke"), only);
  }
  // One with no limit is said as that, never as an amount, 0 or nothing; one of less than a Lux, as less than one, and can't be finished.
  const say = (allowanceWei) => openApproval(route, { allowanceWei, balanceWei: held, evm: EVM });
  assertUnlimited(say(2n ** 256n - 1n).text);
  assertUnlimited(textOf(cardRegions(cardVmFor({ approval: say(2n ** 256n - 1n) })).approval));
  assert.deepEqual(amountsIn(say(999n).text), ["<0.000000001 ERC20 DUSK"]);
  assert.deepEqual(amountsIn(cardRegions(cardVmFor({ approval: say(999n) })).approval), ["<0.000000001 ERC20 DUSK"]);
  assert.doesNotMatch(cardRegions(cardVmFor({ approval: say(999n) })).approval, /approval-finish/u);
  // Nothing approved, nothing read yet, no EVM wallet, or another route: none.
  for (const none of [{ allowanceWei: 0n }, { allowanceWei: null }, { allowanceWei: HALF, evm: "" }]) assert.equal(openApproval(route, { balanceWei: held, evm: EVM, ...none }), null);
  assert.equal(openApproval(T["service-transfer"], { allowanceWei: HALF, balanceWei: held, evm: EVM }), null);
  assert.equal(cardRegions(cardVmFor()).approval, "");
});

test("a review that skips Approve says which approval covers the amount, and what stays approved: some, none, all of one with no limit, or less than a Lux", () => {
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
  // The check an approval adds: the one the same review without it doesn't have.
  const covered = (amount, allowanceWei) => {
    const without = new Set(checks(amount, 0n).map((check) => check.html));
    const added = checks(amount, allowanceWei).find((check) => !without.has(check.html));
    return added && textOf(added.html);
  };
  // The approval that covers it, then what of it stays approved.
  assert.deepEqual(amountsIn(covered("0.2", HALF)), ["0.5 ERC20 DUSK", "0.3 ERC20 DUSK"]);
  const spent = covered("0.5", HALF);
  assert.deepEqual(amountsIn(spent), ["0.5 ERC20 DUSK"]);
  assert.match(spent, NOTHING_LEFT);
  assert.doesNotMatch(spent, UNLIMITED);
  const unlimited = covered("1", 2n ** 256n - 1n);
  assertUnlimited(unlimited);
  assert.match(unlimited, /\bstays approved\b/iu);
  assert.doesNotMatch(unlimited, /\b(?:expires?|ends|revoked)\b/iu);
  assert.deepEqual(amountsIn(covered("0.5", HALF + 5n)), ["0.5 ERC20 DUSK", "<0.000000001 ERC20 DUSK"]);
  // A fact, read on the chain: the review still confirms.
  assert.ok(checks("0.2", HALF).every((check) => check.ok));
  // One that doesn't cover it isn't said to: the approval step replaces it, and says so.
  assert.equal(covered("1", HALF), undefined);
  assert.equal(covered("0.2", 0n), undefined);
  assert.deepEqual(amountsIn(replacedLine(HALF, "ERC20 DUSK")), ["0.5 ERC20 DUSK"]);
  assert.equal(replacedLine(0n, "ERC20 DUSK"), "");
});

test("a revoke is reviewed as its wallet shows it: an approval of 0, and nothing moves", () => {
  const route = T.migration;
  const { migrationContract, tokenContract } = testnet.evmNetworks.ethereum;
  const reads = { migration: { allowanceWei: 3n * 10n ** 16n, balanceWei: 10n ** 17n, gasCoinWei: 9n * 10n ** 15n, gasPriceWei: 10n ** 9n } };
  const revoke = (patch = {}, feeWei = 26_000n * 10n ** 9n) => revokeReview(route, { cfg: testnet, evm: { account: EVM }, feeWei, reads: { migration: { ...reads.migration, ...patch } }, walletName: "MetaMask" });
  const review = revoke();
  // What's approved now, of which token, from which address, on which chain: nothing moves.
  assert.deepEqual([review.lead.amount, review.lead.unit, review.lead.chain], ["0.03", "ERC20 DUSK", "ethereum"]);
  assert.match(review.lead.line, exactly("0xd63bB1…fE8df4"));
  assert.deepEqual(amountsIn(review.lead.line), []);
  // Its one wallet step, field by field: the network, the token, the spender, a cap of 0, and its fee.
  const [step] = review.steps;
  const lines = byLabel(step.lines);
  assert.equal(lines.Network.value, "Sepolia, chain 11155111");
  assert.deepEqual([lines.Token.value, lines.Token.address], ["ERC20 DUSK", tokenContract]);
  assert.equal(lines.Spender.address, migrationContract);
  assert.equal(lines["Spending cap"].value, "0 ERC20 DUSK");
  assert.deepEqual(amountsIn(lines["Network fee"].value), ["0.000026 ETH"]);
  assert.deepEqual(review.feeRows.map((row) => [row.key, amountsIn(row.value)]), [["fee", ["0.000026 ETH"]]]);
  // The ETH it has, against the fee above.
  assert.deepEqual(amountsIn(review.checks[0].html), ["0.009 ETH"]);
  // Without ETH for its fee, it can't be confirmed.
  assert.equal(revoke({ gasCoinWei: 1n }).checks[0].ok, false);
  // Its sheet: what's approved now under its own label; under Details, opened, the token and the spender in full, each copied as it is.
  const sheetOf = (shown) => reviewSheet({ ...shown, canConfirm: true, cfgLinks: explorer, confirmLabel: "x", steps: shown.steps.map((item) => ({ ...item, current: true })) });
  const sheet = sheetOf(review);
  assert.deepEqual(amountsIn(fieldOf(sheet, review.lead.label).text), ["0.03 ERC20 DUSK"]);
  // Not the network the lead says, or the fee in view.
  const [details] = partsOf(sheet, "wl-more");
  assert.deepEqual(fieldsOf(details).map((field) => field.label), ["Token", "Spender", "Spending cap"]);
  assertShownInFull(fieldOf(details, "Token"), tokenContract, SEPOLIA_ADDRESS(tokenContract));
  assertShownInFull(fieldOf(details, "Spender"), migrationContract, SEPOLIA_ADDRESS(migrationContract));
  assert.deepEqual(amountsIn(fieldOf(details, "Spending cap").text), ["0 ERC20 DUSK"]);
  // One with no limit is said as that, never as 0 or nothing, on the review and its sheet; its fee, before it's estimated, is the wallet's, in ETH.
  const unlimited = revoke({ allowanceWei: 2n ** 256n - 1n }, null);
  assertUnlimited(unlimited.lead.amount);
  assert.equal(unlimited.lead.unit, "");
  assertUnlimited(fieldOf(sheetOf(unlimited), unlimited.lead.label).text);
  assert.deepEqual(amountsIn(byLabel(unlimited.steps[0].lines)["Network fee"].value), []);
  assert.match(byLabel(unlimited.steps[0].lines)["Network fee"].value, exactly("ETH"));
});

// Dusk Wallet's approval windows (ux/extension-approvals): the lines it prints, without their headings.
const rowsOf = (lines) => lines.filter((line) => !line.kind);
// What the bridge sent Dusk Wallet for 0.1 DUSK on testnet: the window prints
// its call data as "40 bytes · sha256=2f64b19f5ac0…731c7c2a".
const SHOT = "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e";
const shotDeposit = {
  contractId: DUSKEVM.VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID,
  depositLux: 100_000_000n,
  display: { label: "Bridge 0.1 DUSK to DuskEVM", recipient: SHOT },
  fnArgs: encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: SHOT }),
  fnName: "depositETHToWithValue",
  gas: { limit: "5000000", price: "1" },
};
// The site's own words, folded, and marked as not checked by the wallet.
function assertSiteLine(lines, display) {
  const site = rowsOf(lines).filter((line) => line.value === JSON.stringify(display));
  assert.equal(site.length, 1);
  assert.equal(site[0].fold, true);
  assert.match(site[0].label, /\b(?:not checked|unverified)\b/iu);
}

test("a deposit lists Dusk Wallet's bridge window: the recipient in full, the amount, the fee and the total, the contract and its call", async () => {
  const lines = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT, note: "The DuskEVM bridge contract on Dusk." });
  // A call the window reads as the bridge's: what it sends, and to whom.
  assert.deepEqual([lines[0].amount, lines[0].toFull, Boolean(lines[0].tag)], ["0.1 DUSK", SHOT, true]);
  // Field by field: the recipient, the amount, who pays, the fee at its most and the total, the contract, the deposit, and the call.
  const rows = byLabel(lines);
  assert.deepEqual([rows["DuskEVM recipient"].address, rows["DuskEVM recipient"].network], [SHOT, "dusk-evm"]);
  assert.equal(rows.Amount.value, "0.1 DUSK");
  assert.deepEqual([rows.From.value, rows.From.full, rows.From.suffix], ["21n5nc…fMMLNz", ACCOUNT, "Public"]);
  assert.deepEqual(amountsIn(rows["Network fee"].value), ["≤0.005 DUSK"]);
  assert.deepEqual(amountsIn(rows.Total.value), ["≤0.105 DUSK"]);
  assert.deepEqual([rows.Contract.name, rows.Contract.value, rows.Contract.full], ["DuskEVM bridge", "2257e5…a1b31d", DUSKEVM.VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID]);
  assert.equal(rows.Deposit.value, "0.1 DUSK");
  assert.deepEqual([rows.Method.value, rows.Method.fold], ["depositETHToWithValue", true]);
  assert.deepEqual([rows["Call data"].value, rows["Call data"].fold], ["40 bytes · sha256=2f64b19f5ac0…731c7c2a", true]);
  assertSiteLine(lines, shotDeposit.display);
  // As the review shows it: the recipient in full and copied as it is; the fee and the total each in its own field.
  const view = walletLines(lines, explorer);
  assertShownInFull(fieldOf(view, "DuskEVM recipient"), SHOT, DUSKEVM_ADDRESS(SHOT));
  assert.match(fieldOf(view, "From").text, exactly("21n5nc…fMMLNz"));
  assert.deepEqual(amountsIn(fieldOf(view, "Network fee").text), ["≤0.005 DUSK"]);
  assert.deepEqual(amountsIn(fieldOf(view, "Total").text), ["≤0.105 DUSK"]);
  // With the .dusk name Dusk Wallet sent, From reads as the window does.
  const named = byLabel(await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT, fromName: "alice.dusk" }));
  assert.deepEqual([named.From.value, named.From.full, named.From.suffix], ["alice.dusk", ACCOUNT, "Public"]);

  // Where Dusk Wallet doesn't read the call (Mainnet, another contract,
  // arguments that aren't a deposit), it's a plain contract call: no recipient
  // read from it, nothing said to be the bridge's, its call data to check by its hash.
  for (const other of [{ chainId: "dusk:1" }, { chainId: "dusk:2", contractId: "ab".repeat(32) }, { chainId: "dusk:2", fnArgs: Uint8Array.from([1, 2, 3]) }]) {
    const plain = await duskCallLines({ ...shotDeposit, ...other, from: ACCOUNT });
    assert.deepEqual([plain[0].amount, plain[0].toFull, plain[0].tag], ["0.1 DUSK", undefined, undefined]);
    const call = byLabel(plain)["Call data"];
    assert.match(call.value, /^\d+ bytes · sha256=[0-9a-f]{12}…[0-9a-f]{8}$/u);
    assert.match(call.note, /\bcheck the sha256\b/iu);
    assert.equal(byLabel(plain).Deposit.value, "0.1 DUSK");
    assertSiteLine(plain, shotDeposit.display);
  }
  // A contract the network doesn't name: its ID alone, 6…6.
  const unnamed = byLabel(await duskCallLines({ ...shotDeposit, chainId: "dusk:2", contractId: "AB".repeat(32), from: ACCOUNT, note: "A contract." }));
  assert.deepEqual([unnamed.Contract.name, unnamed.Contract.value], [undefined, "ababab…ababab"]);
});

test("a deposit's review lists under Details only what Dusk Wallet shows that the review doesn't: its contract and its call", async () => {
  const lines = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT });
  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send 0.1 DUSK", feeRows: [{ key: "fee", label: "Network fee", value: "up to 0.005 DUSK" }], privacy: PUBLIC_LINE,
    receive: { account: SHOT, amount: "0.1", chain: "dusk-evm", full: true, unit: "DUSK", where: "DuskEVM" }, send: { account: "21n5nc…fMMLNz", amount: "0.1", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, lines, ready: true, walletName: "Dusk Wallet" }], sub: "",
  });
  // Not the recipient, the amount, the account it's from, the fee, the total or the site's own words: the review says those.
  const [details] = partsOf(sheet, "wl-more");
  assert.deepEqual(fieldsOf(details).map((field) => [field.label, field.text]), [
    ["Contract", "DuskEVM bridge · 2257e5…a1b31d"],
    ["Method", "depositETHToWithValue"],
    ["Call data", "40 bytes · sha256=2f64b19f5ac0…731c7c2a Older Dusk Wallets show it as bytes: check the sha256."],
  ]);
  // Whom it pays is in view, in full, on its own line.
  assert.ok(textOf(sheet).split(" ").includes(SHOT));
});

test("a proof or claim lists what the withdrawal pays, to whom, and who sent it; proving moves no DUSK, its fee is all it costs", async () => {
  // Testnet's 1,008 DUSK withdrawal to an account, proved, as the Portal's driver encodes the call.
  const portal = {
    chainId: "dusk:2",
    contractId: DUSKEVM.VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID,
    display: { label: "Prove a DuskEVM withdrawal" },
    fnArgs: portalCall("proveWithdrawalTransaction", [withdrawalInput(messagePassedLog), u256(29), OUTPUT_ROOT_PROOF, [[0x20, 0x01]]]),
    fnName: "proveWithdrawalTransaction",
    from: ACCOUNT,
    gas: { limit: "50519542", price: "1" },
  };
  const prove = await duskCallLines(portal);
  // As the window leads since wallet#149: what it costs, marked as a cost, then the withdrawal it's for and whom that pays.
  assert.deepEqual([prove[0].amount, Boolean(prove[0].lead), prove[0].to, prove[0].toFull, Boolean(prove[0].tag)], ["0.0506 DUSK", true, "213qXN…V5JJ9Y", PAID, true]);
  assert.deepEqual(amountsIn(prove[0].prefix), ["1,008 DUSK"]);
  // What it says of itself: what it costs at most, and that proving moves no DUSK and pays nothing out.
  assert.deepEqual(amountsIn(`${prove[0].lead} ${prove[0].amount}`), ["≤0.0506 DUSK"]);
  assert.match(prove[0].sub, MOVES_NO_DUSK);
  assert.doesNotMatch([prove[0].title, prove[0].lead, prove[0].sub].join(" "), PAYS_OUT);
  const proof = byLabel(prove);
  assert.equal(proof["Pays to"].address, PAID);
  assert.equal(proof.Amount.value, "1,008 DUSK");
  // The sender as the window checksums it.
  assert.equal(proof["Sent from DuskEVM"].address, "0x75685f9D88749B583732B40d56fe007cD404b72D");
  // A maximum rounds up past 4 decimals, so it never reads lower than it can be. Proving moves no DUSK: nothing deposited, its total is its fee.
  assert.deepEqual(amountsIn(proof["Network fee"].value), ["≤0.0506 DUSK"]);
  assert.deepEqual(amountsIn(proof.Total.value), ["≤0.0506 DUSK"]);
  assert.equal(proof.Deposit, undefined);
  assert.deepEqual([proof.Contract.name, proof.Contract.value], ["DuskEVM bridge portal", "14eeb3…3fb1b9"]);
  assert.equal(proof.Method.value, "proveWithdrawalTransaction");
  assert.match(proof["Call data"].value, /^\d+ bytes · sha256=[0-9a-f]{12}…[0-9a-f]{8}$/u);
  // As the review shows it: the payee and the sender in full and copied as they are, the amount and the total each in its own field.
  const view = walletLines(prove, explorer);
  // Its head as shown: the cost at most, then the withdrawal it's for; and that proving moves no DUSK and pays nothing out.
  assert.deepEqual(amountsIn(partsOf(view, "wlhd")[0]), ["≤0.0506 DUSK", "1,008 DUSK"]);
  assert.match(textOf(view), MOVES_NO_DUSK);
  assert.doesNotMatch(textOf(view), PAYS_OUT);
  assertShownInFull(fieldOf(view, "Pays to"), PAID, DUSK_ACCOUNT(PAID));
  assertShownInFull(fieldOf(view, "Sent from DuskEVM"), "0x75685f9D88749B583732B40d56fe007cD404b72D", DUSKEVM_ADDRESS("0x75685f9D88749B583732B40d56fe007cD404b72D"));
  assert.deepEqual(amountsIn(fieldOf(view, "Amount").text), ["1,008 DUSK"]);
  assert.deepEqual(amountsIn(fieldOf(view, "Total").text), ["≤0.0506 DUSK"]);

  // Testnet's 10 DUSK withdrawal that credits a contract, claimed: it pays that contract, and costs its fee too.
  const claim = await duskCallLines({ ...portal, fnArgs: portalCall("finalizeWithdrawalTransaction", withdrawalInput(contractCreditLog)), fnName: "finalizeWithdrawalTransaction" });
  assert.deepEqual(amountsIn(claim[0].prefix), ["10 DUSK"]);
  assert.deepEqual([claim[0].to, claim[0].toFull], ["ed7176…44a0af", "ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af"]);
  const payout = byLabel(claim);
  assert.equal(payout["Pays to contract"].value, "ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af");
  assert.equal(payout.Amount.value, "10 DUSK");
  assert.equal(payout.Method.value, "finalizeWithdrawalTransaction");
  assert.deepEqual(amountsIn(payout.Total.value), amountsIn(payout["Network fee"].value));
  assert.equal(payout.Deposit, undefined);
  assert.notEqual(prove[0].title, claim[0].title);
  assert.doesNotMatch(claim[0].sub, MOVES_NO_DUSK);
  // An amount finer than a Lux keeps all 18 decimals.
  assert.equal(withdrawalAmount(10n ** 18n + 1n), "1.000000000000000001 DUSK");

  // A call the window can't read is a plain contract call: it sends nothing, and its bytes are to check.
  const plain = await duskCallLines({ ...portal, fnArgs: Uint8Array.from([1, 2, 3]) });
  assert.deepEqual([plain[0].amount, plain[0].toFull, plain[0].tag], ["", undefined, undefined]);
  assert.equal(byLabel(plain)["Call data"].value, "3 bytes · sha256=039058c6f2c0…011cfb81");
});

test("a transfer to the bridge's account lists Dusk Wallet's bridge window: what's sent, the bridge fee, what arrives, and to whom", () => {
  const gas = { limit: "2500000", price: "1" };
  const transfer = (cfg, patch = {}) =>
    duskTransferLines({ amountLux: 2_000_000_000n, chainId: cfg.dusk.chainId, from: ACCOUNT, fromName: "alice.dusk", gas, memo: EVM, to: cfg.service.account, ...patch });
  // Mainnet's to BNB Smart Chain (wallet#150): 2 DUSK sent, 1 DUSK bridge fee, 1 DUSK arrives.
  const bsc = transfer(mainnet);
  assert.deepEqual([bsc[0].amount, bsc[0].toFull, Boolean(bsc[0].tag)], ["2 DUSK", EVM, true]);
  assert.deepEqual(amountsIn(bsc[0].sub), ["2 DUSK", "1 DUSK", "1 DUSK"]);
  // Field by field: the fee and the total, who pays, the bridge's account on Dusk, and the recipient there.
  const rows = byLabel(bsc);
  assert.deepEqual(amountsIn(rows["Network fee"].value), ["≤0.0025 DUSK"]);
  assert.deepEqual(amountsIn(rows.Total.value), ["≤2.0025 DUSK"]);
  assert.deepEqual([rows.From.value, rows.From.full, rows.From.suffix], ["alice.dusk", ACCOUNT, "Public"]);
  assert.deepEqual([rows.To.address, rows.To.network], [mainnet.service.account, "dusk"]);
  assert.deepEqual([rows["Recipient on BNB Smart Chain"].address, rows["Recipient on BNB Smart Chain"].network], [EVM, "bsc"]);
  // As the review shows it: the bridge's account and the recipient in full, each copied as it is.
  const view = walletLines(bsc, { explorer: (network, address) => explorerAddressUrl(mainnet, network, address) });
  assertShownInFull(fieldOf(view, "To"), mainnet.service.account, `https://explorer.dusk.network/accounts/?key=${mainnet.service.account}`);
  assertShownInFull(fieldOf(view, "Recipient on BNB Smart Chain"), EVM, `https://bscscan.com/address/${EVM}`);
  assert.deepEqual(amountsIn(fieldOf(view, "Total").text), ["≤2.0025 DUSK"]);
  // Testnet's to Sepolia, which the bridge doesn't pay out on now: nothing arrives.
  const sepolia = transfer(testnet);
  assert.deepEqual(amountsIn(sepolia[0].sub), ["2 DUSK", "1 DUSK"]);
  assert.equal(byLabel(sepolia).To.address, testnet.service.account);
  assert.equal(byLabel(sepolia)["Recipient on Sepolia"].address, EVM);
  // Nothing arrives when the fee takes it all, or without an address there in the memo: then no recipient is read from it, and the memo shows as it is.
  assert.deepEqual(amountsIn(transfer(mainnet, { amountLux: 1_000_000_000n })[0].sub), ["1 DUSK", "1 DUSK"]);
  for (const memo of ["not an address", EVM.replace("B", "b")]) {
    const unread = transfer(mainnet, { memo });
    assert.deepEqual(amountsIn(unread[0].sub), ["2 DUSK", "1 DUSK"]);
    assert.equal("to" in unread[0], false);
    const recipient = byLabel(unread)["Recipient on BNB Smart Chain"];
    assert.deepEqual([recipient.value, recipient.mono, recipient.address], [memo, true, undefined]);
  }
  // An account the wallet doesn't know as the bridge's: a plain payment, its memo shown as it is.
  const pay = transfer(mainnet, { to: ACCOUNT });
  assert.deepEqual([pay[0].amount, pay[0].toFull, pay[0].tag], ["2 DUSK", ACCOUNT, undefined]);
  assert.deepEqual([byLabel(pay).To.address, byLabel(pay).Memo.value], [ACCOUNT, EVM]);
});

test("fees and totals read as Dusk Wallet writes them", () => {
  // A maximum: exact to 4 decimals, rounded up past them, trailing zeros trimmed.
  assert.deepEqual([0n, 49_999n, 50_000n, 2_500_000n, 5_000_000n, 105_000_000n, 1_000_010_000n, 12_345_678_912_345n].map(walletFee), [
    "0 DUSK", "0.00005 DUSK", "0.00005 DUSK", "0.0025 DUSK", "0.005 DUSK", "0.105 DUSK", "1.0001 DUSK", "12,345.679 DUSK",
  ]);
});

test("a receipt is a record without balances, with both hashes and its own link", () => {
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
  const model = receiptModel(entry, { cfg: testnet, locale: "en-GB", route: T["duskevm-deposit"], timeZone: "Europe/Amsterdam", url });
  assert.deepEqual(amountsIn(model.view.title), ["25 DUSK"]);
  const html = receiptPage(model);
  // Whom it paid, in full, in view, with its checksum's capitals: the payout's check, copied as it is, on its explorer.
  assertShownInFull(paidOf(html), EVM, DUSKEVM_ADDRESS(EVM));
  // Both transactions, each on its step: 6…6, copied in full, on its explorer.
  assert.deepEqual(
    stepPartsOf(html).map(({ copies, links }) => [copies, links]),
    [
      [["38".repeat(32)], [DUSK_TX("38".repeat(32))]],
      [[`0x${"a1".repeat(32)}`], [`https://explorer.testnet.evm.dusk.network/tx/0x${"a1".repeat(32)}`]],
    ],
  );
  assert.deepEqual(stepPartsOf(html).map(({ text }) => [text.includes("383838…383838"), text.includes("0xa1a1a1…a1a1a1")]), [[true, false], [false, true]]);
  // Under Details, only what the rest doesn't say: the fee as paid to the last decimal, and who sent it, in full.
  // What was sent and arrived is the title's; whom it paid, when and how, the line and the steps'.
  const details = opened(html);
  assert.deepEqual(fieldsOf(details).map((field) => field.label), ["Network fee", "From"]);
  assert.deepEqual(amountsIn(fieldOf(details, "Network fee").text), ["0.001986599 DUSK"]);
  assertShownInFull(fieldOf(details, "From"), ACCOUNT, DUSK_ACCOUNT(ACCOUNT));
  const link = /<div class="lk">([\s\S]*?)<\/div>/u.exec(html)[1];
  assert.deepEqual(copiesOf(link), [url]);
  // Anyone with the link sees it: no balance is on it.
  assert.doesNotMatch(html, /balance|now holds/iu);
  assert.ok(!html.includes(TIMES));

  // While pending: how long it takes on this network, and a note only once it's late.
  const waiting = { ...entry, destinationHash: undefined, status: "pending" };
  const pending = receiptModel(waiting, { cfg: testnet, now: entry.sourceAt + 60_000, route: T["duskevm-deposit"], url });
  assert.match(pending.caption, exactly("~1 min"));
  assert.deepEqual(pending.notes, []);
  const late = receiptModel(waiting, { cfg: testnet, now: entry.sourceAt + 3_600_000, route: T["duskevm-deposit"], url });
  assert.equal(late.notes.length, 1);
  // A contact only where the deployment names one.
  assert.doesNotMatch(late.notes[0].html, /href=/u);
  const supported = profile("testnet", { ...DUSKEVM, VITE_SUPPORT_LABEL: "Dusk support", VITE_SUPPORT_URL: "https://support.example.org" });
  const withSupport = receiptModel(waiting, { cfg: supported, now: entry.sourceAt + 3_600_000, route: routesOf(supported)["duskevm-deposit"], url });
  assert.match(withSupport.notes.at(-1).html, /href="https:\/\/support\.example\.org"/u);
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
});

test("the review checks a balance to the Lux, as what it sends: 0.09 can't pay for 0.090082082", () => {
  const route = T.migration;
  const reads = { migration: { balanceWei: 90_082_082_000_000_000n, gasCoinWei: 10_000_000_000_000n } };
  const quote = buildQuote(route, "0.090082082", { balance: reads.migration.balanceWei, cfg: testnet });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads });
  assert.deepEqual(amountsIn(checks[0].html), ["0.090082082 ERC20 DUSK"]);
  // Gas in the short form, where 4 decimals alone would say it has none.
  assert.deepEqual(amountsIn(checks[1].html), ["0.00001 ETH"]);
  const deposit = T["duskevm-deposit"];
  const fromDusk = reviewChecks(deposit, { cfg: testnet, destination: EVM, evm: {}, quote: buildQuote(deposit, "1", { balance: 2_123_456_789n, cfg: testnet }), reads: { duskBalance: 2_123_456_789n } });
  assert.deepEqual(amountsIn(fromDusk[0].html), ["2.123456789 DUSK"]);
  const withdrawal = T["duskevm-withdrawal"];
  const fromEvm = reviewChecks(withdrawal, { cfg: testnet, destination: ACCOUNT, evm: {}, quote: buildQuote(withdrawal, "1", { balance: 2_123_456_789_999_999_999n, cfg: testnet }), reads: { l2: { balanceWei: 2_123_456_789_999_999_999n } } });
  assert.deepEqual(amountsIn(fromEvm[0].html), ["2.123456789 DUSK"]);
});

test("a transfer that failed on its own chain reads as failed on its receipt, on every route: nothing sent or received, and no step done", () => {
  const url = "https://bridge.example.org/#/transfer/f";
  const sourceAt = Date.UTC(2026, 10, 20, 9);
  const moved = (details) => details.filter((row) => !row.html && /^You (sent|receive)/u.test(row.label)).map((row) => `${row.label} ${row.value}`);
  for (const cfg of [testnet, mainnet])
    for (const route of buildRoutes(cfg)) {
      const hash = route.from.kind === "evm" ? `0x${"9e".repeat(32)}` : "9e".repeat(32);
      // In a block, or not.
      for (const at of [{ sourceAt }, {}]) {
        const { details, view } = receiptModel({ amountLux: "1008000000000", hash, id: "f", routeId: route.id, sourceFailed: true, status: "failed", ...at }, { cfg, route, url });
        assert.deepEqual(moved(details), [], route.id);
        assert.equal(view.steps[0].state, "failed", route.id);
        assert.deepEqual([...view.steps, ...(view.tracker ?? [])].filter(({ state }) => state === "done"), [], route.id);
      }
    }
  // A withdrawal that reverted on DuskEVM, as tracking ends it, and as kept before that was noted: its note says so.
  const withdrawal = T["duskevm-withdrawal"];
  const note = "The withdrawal failed on DuskEVM. Your DUSK is still there.";
  const reverted = { amountLux: "1008000000000", hash: `0x${"9e".repeat(32)}`, id: "w", note, routeId: withdrawal.id, sourceAt, stage: "failed", status: "failed" };
  for (const entry of [{ ...reverted, sourceFailed: true }, reverted]) {
    const { caption, details, view } = receiptModel(entry, { cfg: testnet, route: withdrawal, url });
    assert.deepEqual(moved(details), []);
    assert.deepEqual(view.steps.map(({ state }) => state), ["failed", "todo", "todo"]);
    assert.equal(caption, note);
  }
  // One that went through and wasn't paid out left the account: that's said, nothing received, and its own step is done.
  const service = T["service-transfer"];
  const unpaid = receiptModel({ amountLux: "2053082083", feeLux: "1859281", hash: "9e".repeat(32), id: "s", note: "The memo isn't an EVM address, so the bridge won't pay it out.", routeId: service.id, sourceAt, status: "failed" }, { cfg: testnet, route: service, url });
  assert.deepEqual(moved(unpaid.details), ["You sent 2.053082083 DUSK", "You received 0 ERC20 DUSK"]);
  assert.equal(unpaid.view.steps[0].state, "done");
});

test("a transfer that went through and was then not paid out reads as sent and not paid out, on every route that can end so", () => {
  const url = "https://bridge.example.org/#/transfer/p";
  const sourceAt = Date.UTC(2026, 10, 20, 9);
  // Each route whose own transaction can go through and pay nothing out, with what its tracking writes then.
  const cases = [
    [mainnet, routesOf(mainnet)["service-transfer"], [NO_PAYOUT["no-address"], NO_PAYOUT["under-fee"], NO_PAYOUT.elsewhere]],
    [testnet, T["service-transfer"], [NO_PAYOUT["no-address"], NO_PAYOUT["under-fee"], NO_PAYOUT.elsewhere]],
    // Failed on DuskEVM, in the evm-sdk's words, or tracking's where it gives none.
    [testnet, T["duskevm-deposit"], ["The deposit failed on DuskEVM.", "The DuskEVM deposit transaction reverted", "The DuskEVM cross-domain relay failed", "The Dusk L1 bridge transaction failed"]],
  ];
  for (const [cfg, route, notes] of cases)
    for (const note of notes)
      // As tracking writes it now; without the block's time, which the node may not give; and as kept before nothing received was noted.
      for (const kept of [{ receivedLux: "0", sourceAt }, { receivedLux: "0" }, { sourceAt }, {}]) {
        const where = `${route.id}: ${note} ${JSON.stringify(kept)}`;
        const entry = { amountLux: "2053082083", feeLux: "1859281", hash: "9e".repeat(32), id: "p", note, routeId: route.id, status: "failed", ...kept };
        const { caption, details, view } = receiptModel(entry, { cfg, route, url });
        // Sent, and nothing after it done, under way or anyone's turn.
        assert.equal(view.steps[0].state, "done", where);
        assert.deepEqual(view.steps.slice(1).filter(({ state }) => ["done", "now", "turn"].includes(state)), [], where);
        const said = details.filter((row) => !row.html).map((row) => [row.label, row.value]);
        assert.deepEqual(said.filter(([label]) => label === "You sent"), [["You sent", "2.053082083 DUSK"]], where);
        // Nothing received.
        assert.deepEqual(said.filter(([label, value]) => /^You receive/u.test(label) && !/^0 /u.test(value)), [], where);
        assert.equal(caption, note, where);
      }
});

test("a payout that failed says what happened: nothing received, and no bridge fee beyond what the bridge took", () => {
  const url = "https://bridge.example.org/#/transfer/f";
  const receipt = (cfg, route, entry) => receiptModel({ feeLux: "1859281", hash: "9e".repeat(32), id: "f", routeId: route.id, status: "failed", ...entry }, { cfg, route, url });
  const rows = (...args) => receipt(...args).details.filter((row) => !row.html).map((row) => [row.label, row.value]);
  for (const [cfg, route, token] of [[testnet, T["service-transfer"], "ERC20 DUSK"], [mainnet, routesOf(mainnet)["service-transfer"], "BEP20 DUSK"]]) {
    // An invalid memo, kept before nothing received was noted: nothing received all the same.
    assert.deepEqual(rows(cfg, route, { amountLux: "2053082083", note: NO_PAYOUT["no-address"] }), [
      ["You sent", "2.053082083 DUSK"],
      ["Bridge fee", "1 DUSK"],
      ["Network fee", "0.001859281 DUSK"],
      ["You received", `0 ${token}`],
    ]);
    // Less than the bridge fee: the bridge kept the 0.5 DUSK it was sent, no more, then and now.
    for (const kept of [{ receivedLux: "0" }, {}]) {
      const under = receipt(cfg, route, { amountLux: "500000000", note: NO_PAYOUT["under-fee"], ...kept });
      assert.deepEqual(under.details.filter((row) => !row.html).map((row) => [row.label, row.value]), [
        ["You sent", "0.5 DUSK"],
        ["Bridge fee", "0.5 DUSK"],
        ["Network fee", "0.001859281 DUSK"],
        ["You received", `0 ${token}`],
      ]);
      assert.equal(under.fees.exact, "0.501859281 DUSK");
    }
    // Never sent to the bridge's account: the bridge took nothing.
    assert.deepEqual(rows(cfg, route, { amountLux: "2053082083", note: NO_PAYOUT.elsewhere, receivedLux: "0" }), [
      ["You sent", "2.053082083 DUSK"],
      ["Network fee", "0.001859281 DUSK"],
      ["You received", `0 ${token}`],
    ]);
  }
  // A deposit that failed on DuskEVM: nothing arrived there.
  assert.deepEqual(rows(testnet, T["duskevm-deposit"], { amountLux: "25000000000", note: "The DuskEVM deposit transaction reverted" }), [
    ["You sent", "25 DUSK"],
    ["Network fee", "0.001859281 DUSK"],
    ["You received", "0 DUSK"],
  ]);
});

test("a receipt says the transfer's amounts as every Dusk app does, to the Lux", () => {
  const url = "https://bridge.example.org/#/transfer/m";
  const rows = (entry, route) => receiptModel({ hash: `0x${"0d".repeat(32)}`, id: "m", routeId: route.id, ...entry }, { cfg: testnet, route, url }).details.filter((row) => !row.html).map((row) => [row.label, row.value]);
  const service = T["service-transfer"];
  // Before it arrives: what will, worked out from what was sent. What was sent is the title's.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", status: "pending" }, service), [
    ["Bridge fee", "1 DUSK"],
    ["Network fee", "0.001859281 DUSK"],
    ["You receive", "1.053082083 ERC20 DUSK"],
  ]);
  // Once it has: what did; the title says what arrived, so what was sent is said here.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", receivedLux: "1053082083", status: "completed" }, service), [
    ["You sent", "2.053082083 DUSK"],
    ["Bridge fee", "1 DUSK"],
    ["Network fee", "0.001859281 DUSK"],
    ["You received", "1.053082083 ERC20 DUSK"],
  ]);
  // An older entry, kept before what arrived was: worked out, and said as arrived.
  assert.deepEqual(rows({ amountLux: "2053082083", status: "completed" }, service).at(-1), ["You received", "1.053082083 ERC20 DUSK"]);
  // A proof's and a claim's fees are one network fee; what was sent and received is the title's, 1,008 DUSK.
  assert.deepEqual(rows({ amountLux: "1008000000000", claimFeeLux: "2000001", proveFeeLux: "1000000", status: "completed", stage: "finalized" }, T["duskevm-withdrawal"]), [
    ["Network fee", "0.003000001 DUSK"],
  ]);
  // Failed on Dusk: nothing moved, and its fee stands alone.
  assert.deepEqual(rows({ amountLux: "2053082083", feeLux: "1859281", note: "The Dusk transaction failed.", status: "failed" }, T["duskevm-deposit"]), [["Network fee", "0.001859281 DUSK"]]);
  // Went through and pays nothing out: the DUSK moved, and nothing came of it.
  // A failure past its own chain still moved what was sent; one on its own chain moved nothing.
  const sentOf = (entry) => rows({ amountLux: "2053082083", feeLux: "1859281", status: "failed", ...entry }, service).some(([label]) => label === "You sent");
  assert.equal(sentOf({ note: "The memo isn't an EVM address, so the bridge won't pay it out." }), true);
  assert.equal(sentOf({ sourceFailed: true }), false);
  assert.equal(sentOf({ note: "The transfer failed on Dusk." }), false);
  // Less than the bridge fee: the bridge kept the 0.5 DUSK it was sent, no more.
  assert.deepEqual(rows({ amountLux: "500000000", feeLux: "1859281", receivedLux: "0", status: "failed" }, service), [
    ["You sent", "0.5 DUSK"],
    ["Bridge fee", "0.5 DUSK"],
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
  // The network fee: as wallets write it, and to the wei.
  const fee = (model) => {
    const row = model.details.find((each) => each.label === "Network fee");
    return row && [row.value, row.exact];
  };
  const BOTH = "0.000093199001491184 ETH";
  const MIGRATION = ["0.000047 ETH", "0.00004700500075208 ETH"];
  const model = await receipt(entry);
  // Both, to the wei, as left the wallet.
  assert.deepEqual(fee(model), ["0.000093 ETH", BOTH]);
  // And the approval found on the chain, in full in its own field, copied as it is.
  assertShownInFull(fieldOf(opened(receiptPage(model)), "Sepolia approval"), approval, `https://sepolia.etherscan.io/tx/${approval}`);
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
  assert.equal(fee(await receipt({ ...entry, hash: first }, shared))[1], BOTH);
  assert.deepEqual(fee(await receipt({ ...entry, amountLux: "7000000", hash: next, receivedLux: "7000000" }, shared)), MIGRATION);

  // Where the RPC no longer gives logs that old, the migration's own gas alone.
  const pruned = migrationChain({ pruned: true });
  pruned.send("approve", { block: 100, gas: 46_194, hash: approval, wei: 3n * 10n ** 15n });
  pruned.send("migrate", { block: 140, gas: 47_005, hash, wei: 3n * 10n ** 15n });
  assert.deepEqual(fee(await receipt(entry, pruned)), MIGRATION);
  // The approval this browser sent right before it still counts there: the chain's nonces say nothing came between.
  assert.equal(fee(await receipt({ ...entry, approvalHash: approval }, pruned))[1], BOTH);

  // Failed on its chain: its own gas; its approval wasn't spent, and counts with the migration that spends it.
  const failing = migrationChain();
  failing.send("approve", { block: 100, gas: 46_194, hash: approval, wei: 3n * 10n ** 15n });
  failing.send("migrate", { block: 140, failed: true, gas: 30_002, hash, wei: 3n * 10n ** 15n });
  const failed = await receipt({ ...entry, approvalHash: approval, receivedLux: undefined, sourceFailed: true, status: "failed" }, failing);
  assert.deepEqual(failed.details.filter((row) => !row.html).map((row) => [row.label, row.value]), [["Network fee", "0.00003 ETH"]]);

  // Cancelled in the wallet after its approval: no migration was mined, and the approval's gas, as this browser read it, is the fee.
  const cancel = { ...entry, approvalFeeWei: "29106000465696", approvalHash: approval, receivedLux: undefined, replaced: "cancelled", sourceFailed: true, status: "failed" };
  const cancelled = await receipt(cancel);
  assert.deepEqual(cancelled.details.filter((row) => !row.html).map((row) => [row.label, row.value, row.exact]), [["Network fee", "0.000029 ETH", "0.000029106000465696 ETH"]]);
  // Until a migration spends that approval: then it counts the fee, once, and this receipt doesn't; nor while that's read. The approval stays listed.
  for (const approvalSpentBy of [`0x${"f1".repeat(32)}`, null]) {
    const spent = receiptModel(cancel, { approvalSpentBy, cfg: testnet, route: T.migration, url: "x" });
    assert.equal(fee(spent), undefined);
    assertShownInFull(fieldOf(opened(receiptPage(spent)), "Sepolia approval"), approval, `https://sepolia.etherscan.io/tx/${approval}`);
  }
});

test("a claim's fee maximum on the receipt uses the withdrawal's own gas once it's known", () => {
  const ready = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", stage: "ready_to_finalize", status: "pending" };
  const url = "https://bridge.example.org/#/transfer/w";
  // Unknown yet: the bound (1M on top of 50M).
  assert.deepEqual(amountsIn(receiptModel(ready, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee), ["≤0.051 DUSK"]);
  // Known: 50M plus what the withdrawal asks for.
  assert.deepEqual(amountsIn(receiptModel({ ...ready, withdrawalGas: "9000000" }, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee), ["≤0.059 DUSK"]);
});

test("a row in My transfers writes its amount as wallets do, with every digit on hover", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  const shown = (amountLux, patch = {}) =>
    transfersModel([{ amountLux, hash: "0a".repeat(32), id: "a", parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", status: "pending", ...patch }], { accounts: [ACCOUNT], cfg: testnet, routeOf }).groups.progress[0];
  assert.deepEqual((({ amountExact, amountText }) => ({ amountExact, amountText }))(shown("53082083")), { amountExact: "0.053082083 DUSK", amountText: "0.053 DUSK" });
  // Rounded down, and an amount that isn't 0 never reads 0.
  assert.equal(shown("999999999").amountText, "0.9999 DUSK");
  assert.equal(shown("1").amountText, "0.000000001 DUSK");
  // The receipt is its detail: its title says it in full, and no row says it again.
  const model = receiptModel({ amountLux: "53082083", hash: "0a".repeat(32), id: "a", routeId: "dusk-to-dusk-evm", status: "pending" }, { cfg: testnet, route: T["duskevm-deposit"], url: "https://bridge.example.org/#/transfer/a" });
  assert.deepEqual(amountsIn(model.view.title), ["0.053082083 DUSK"]);
  assert.deepEqual(fieldsOf(opened(receiptPage(model))).filter((field) => amountsIn(field.text).includes("0.053082083 DUSK")), []);
});

test("My transfers groups the connected accounts' transfers and offers the next action", () => {
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
  assert.equal(claim.action.kind, "finalize");
  assert.equal(claim.href, `#/transfer/0x${"01".repeat(32)}`);
});

test("each transfer in My transfers says whom it pays and its transaction, so equal ones are told apart", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  // Discovered from the archive: the DuskEVM recipient in lower case, the hash without 0x.
  const deposit = { amountLux: "500000000", destination: SHOT.toLowerCase(), destinationAt: Date.UTC(2026, 9, 27, 5, 52), hash: `ac6b2f${"9".repeat(52)}16bc24`, id: "d", parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", status: "completed" };
  const withdrawal = { amountLux: "1008000000000", destination: ACCOUNT, hash: `0x04a8a8${"7".repeat(52)}1b3213`, id: "w", parties: [ACCOUNT], routeId: "dusk-evm-to-dusk", stage: "ready_to_prove", status: "pending" };
  const model = transfersModel([deposit, withdrawal], { account: ACCOUNT, accounts: [ACCOUNT], cfg: testnet, locale: "en-GB", name: "alice.dusk", now: Date.UTC(2026, 9, 28), routeOf, timeZone: "Europe/Amsterdam" });
  const [done] = model.groups.done;
  // The address with its checksum's capitals, as the wallet writes it: 6 + 6 after the 0x.
  assert.deepEqual([done.to, done.hash], [{ address: "0x96BA8D…dc893e" }, "ac6b2f…16bc24"]);
  // Your own account by its .dusk name.
  // An EVM transaction as an EVM address is cut: 0x and 6 + 6.
  assert.deepEqual([model.groups.needs[0].to, model.groups.needs[0].hash], [{ name: "alice.dusk" }, "0x04a8a8…1b3213"]);
});

test("a withdrawal that pays someone else waits in its own group, and counts for no one's turn", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  // The stand-in EVM address's 1,008 DUSK withdrawal, which pays 213qXN…V5JJ9Y.
  const stranger = `213qXN${"x".repeat(40)}V5JJ9Y`;
  const entry = { amountLux: "1008000000000", destination: stranger, hash: `0x04a8a8${"7".repeat(52)}1b3213`, id: "w", parties: [EVM.toLowerCase(), stranger], provenByOther: true, routeId: "dusk-evm-to-dusk", sourceAt: Date.UTC(2026, 9, 7, 7, 7), stage: "ready_to_prove", status: "pending" };
  const model = transfersModel([entry], { account: ACCOUNT, accounts: [ACCOUNT, EVM], cfg: testnet, name: "alice.dusk", owner: ACCOUNT, routeOf });
  assert.equal(model.needs, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(model.groups).map(([key, rows]) => [key, rows.map((row) => row.id)])), { done: [], failed: [], needs: [], other: ["w"], progress: [] });
  assert.equal(model.groups.other[0].action.quiet, true);
  // Followed without Dusk Wallet, the followed account is the one it's for.
  assert.deepEqual(transfersModel([entry], { accounts: [ACCOUNT, EVM], cfg: testnet, owner: ACCOUNT, routeOf }).groups.other.map((row) => row.id), ["w"]);
});

test("the Contracts sheet lists every address in full, under its own label, and names no one as running it", () => {
  const groups = contractGroups(testnet);
  // The Sepolia routes are listed, as paused; Hyperlane's run.
  assert.equal(groups[1].paused, true);
  assert.equal(groups[3].paused, false);
  // Each network by its ID.
  assert.deepEqual(groups[0].rows.map((row) => row.value.match(/[\w:]+$/u)[0]), ["dusk:2", "745", "11155111"]);
  const rows = groups.flatMap((group) => group.rows);
  for (const value of [
    testnet.evmNetworks.ethereum.migrationContract,
    testnet.evmNetworks.ethereum.tokenContract,
    testnet.service.account,
    // Dusk contracts as every Dusk app writes them: all 64 hex characters without 0x.
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
  ])
    assert.ok(rows.some((row) => row.value === value), value);
  // On the sheet, each in full under its own label, its Copy button copying exactly it.
  const html = contractsSheet({ badge: "Testnet", groups, links: testnet.links, operator: "Dusk" });
  const fields = fieldsOf(html);
  for (const row of rows.filter((each) => each.network)) {
    const shown = fields.filter((field) => field.label === row.label && field.copies.includes(row.value));
    assert.equal(shown.length, 1, row.label);
    assertShownInFull(shown[0], row.value, row.href ?? undefined);
    if (!row.href) assert.deepEqual(linksOf(shown[0].html), [], row.label);
  }
  assert.equal(groups[3].rows.find((row) => row.value === testnet.hyperlane.tokens[0].evm.token).href, `https://sepolia.etherscan.io/address/${testnet.hyperlane.tokens[0].evm.token}`);
  assert.ok(html.includes(`https://explorer.testnet.dusk.network/accounts/?key=${testnet.service.account}`));
  assert.ok(!html.includes(TIMES));

  // Mainnet: BSC both ways, its account paying out migrations too; Ethereum one way, with its payer.
  const main = contractGroups(mainnet);
  // The address the network's file says pays the route out, linked on BscScan.
  assert.ok(main[1].rows.some((row) => row.value === mainnet.service.payoutAddress && row.href === `https://bscscan.com/address/${mainnet.service.payoutAddress}`));
  assert.deepEqual(main[2].rows.map((row) => row.value), [mainnet.evmNetworks.ethereum.tokenContract, mainnet.evmNetworks.ethereum.migrationContract, mainnet.evmNetworks.ethereum.payoutAccount]);

  // No route names who runs it, whatever a deployment sets.
  const operated = profile("mainnet", { VITE_SERVICE_OPERATOR: "Example B.V." });
  assert.ok(contractGroups(operated).every((group) => !("operator" in group)));
  assert.doesNotMatch(contractsSheet({ badge: "Mainnet", groups: contractGroups(operated) }), /Example B\.V\./u);
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

test("everything in the card that follows balances is a region the page refreshes while you type", () => {
  const vm = cardVmFor();
  const regions = cardRegions(vm);
  const page = cardPage(vm);
  for (const name of Object.keys(regions)) assert.ok(page.includes(`data-region="${name}"`), name);
  assert.ok(page.includes(`data-region="from-foot">${regions["from-foot"]}</div>`));
  assert.ok(page.includes(`data-region="cta">${regions.cta}</div>`));
});

test("a proof's review says what it costs and moves no DUSK, and whom the withdrawal pays; a claim, where the DUSK goes", () => {
  const amountLux = 1_008n * 10n ** 9n;
  const other = { destination: testnet.service.account };
  // The withdrawal, whom it pays in full, and that proving moves none of it; the proof's fee, up to 0.051 DUSK, and the claim 7 days after, each in its row. Paying another account than Dusk Wallet's says so.
  const prove = actionLead("prove", other, { account: ACCOUNT, amountLux, maturity: 604_800, maxLux: 51_000_000n, name: "alice.dusk" });
  assert.equal(prove.amount, "1,008");
  assert.equal(prove.payee, other.destination);
  assert.deepEqual(amountsIn(prove.line), []);
  assert.match(prove.line, MOVES_NO_DUSK);
  assert.doesNotMatch(`${prove.label} ${prove.line}`, PAYS_OUT);
  assert.deepEqual(prove.rows.map((row) => [row.label, amountsIn(row.value)]), [["Network fee", ["≤0.051 DUSK"]], ["When", []]]);
  assert.match(prove.rows[1].value, exactly("7 days"));
  assert.match(prove.notYours, /\bnot\b/iu);
  // Once the request is ready, the date a proof made now can be claimed from, exactly; an estimated one is said apart from a sure one.
  const when = (ms) => formatDateTime(ms, { locale: "en-GB", now: Date.UTC(2026, 9, 28), timeZone: "Europe/Amsterdam" });
  const at = Date.UTC(2026, 10, 9, 2, 20);
  const claimFrom = (exact) => actionLead("prove", other, { claim: { at, exact }, maturity: 604_800, maxLux: 1n, when }).rows.find((row) => row.key === "when").value;
  for (const exact of [true, false]) assert.match(claimFrom(exact), exactly("9 Nov, 03:20 CET"));
  assert.doesNotMatch(claimFrom(true), ESTIMATE);
  assert.match(claimFrom(false), ESTIMATE);
  const claim = actionLead("finalize", { destination: ACCOUNT }, { account: ACCOUNT, amountLux, maxLux: 51_000_000n });
  assert.deepEqual([claim.amount, claim.chain, claim.notYours, claim.payee], ["1,008", "dusk", "", ACCOUNT]);
  assert.doesNotMatch(claim.line, MOVES_NO_DUSK);
  assert.deepEqual(claim.rows.map((row) => [row.label, amountsIn(row.value)]), [["Network fee", ["≤0.051 DUSK"]]]);
  assert.match(actionLead("finalize", other, { account: ACCOUNT, amountLux, maxLux: 1n }).notYours, /\bnot\b/iu);
  // The proof's review: the withdrawal under its own label, whom it pays in full, its fee in its own field, that it moves no DUSK; and that another account gets the DUSK.
  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Prove", feeRows: prove.rows, lead: prove,
    privacy: "x", steps: [], sub: "",
  });
  assert.deepEqual(amountsIn(`${fieldOf(sheet, prove.label).text}`), ["1,008 DUSK"]);
  // Whom it pays, in full, on the line under it, with that it moves no DUSK.
  const payee = textOf(partsOf(sheet, "w")[0]);
  assert.ok(payee.split(" ").includes(other.destination), payee);
  assert.match(payee, MOVES_NO_DUSK);
  assert.deepEqual(amountsIn(fieldOf(sheet, "Network fee").text), ["≤0.051 DUSK"]);
  assert.match(textOf(sheet), MOVES_NO_DUSK);
  assert.doesNotMatch(textOf(sheet), PAYS_OUT);
  assert.ok(textOf(sheet).includes(prove.notYours), sheet);
});

test("the form says what's available after the fee, to 4 decimals", () => {
  // 1,483.112423314 DUSK less the 0.005 maximum fee.
  const available = (route, held) => (({ available: amount, canMax }) => [amount, canMax])(availableLine(route, held));
  assert.deepEqual(available(T["duskevm-deposit"], 1_483_107_423_314n), ["1,483.1074 DUSK", true]);
  assert.deepEqual(available(T.migration, 2_500_000_000_000n), ["2,500 ERC20 DUSK", true]);
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
  assert.deepEqual(amountsIn(risen.feeRows.find((row) => row.key === "fee").value), ["≤0.01 DUSK"]);
});

test("the footer links the terms of use and privacy policy, and names no one as running the bridge", () => {
  // What the footer used to name operators with is passed and ignored.
  const dusk = footer({
    links: { privacy: mainnet.links.privacy, terms: mainnet.links.terms },
    officialSite: "",
    operator: "Dusk",
    operators: [{ name: "Example B.V.", route: "Dusk to BNB Smart Chain" }],
  });
  for (const link of [mainnet.links.terms, mainnet.links.privacy]) assert.ok(dusk.includes(`href="${link}"`), link);
  assert.doesNotMatch(dusk, /Example B\.V\./u);
});

test("a proof's or claim's review says the account that sends it becomes public with it", () => {
  for (const kind of ["prove", "finalize"]) assert.match(actionPrivacy(kind), /\bpublic\b.*\byour account\b/iu);
  assert.notEqual(actionPrivacy("prove"), actionPrivacy("finalize"));
});

test("a withdrawal claimed outside this browser reads as claimed", () => {
  const entry = { amountLux: "1000000000", destination: ACCOUNT, hash: `0x${"34".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", sender: EVM, stage: "finalized", status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T["duskevm-withdrawal"], url: "https://bridge.example/#/transfer/x" });
  assert.equal(model.view.status, "completed");
  assert.equal(model.view.action, null);
  assert.equal(model.view.steps.find((step) => step.key === "claim").state, "done");
});

test("a receipt names the account that sent it by its short code, and whom it paid in full", () => {
  const entry = { amountLux: "100000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const url = "https://bridge.example/#/transfer/x";
  for (const own of [{ account: ACCOUNT, name: "alice.dusk" }, { account: "someone else", name: "bob.dusk" }]) {
    const fromTo = textOf(receiptModel(entry, { cfg: testnet, own, route: T["duskevm-deposit"], url }).fromTo);
    assert.match(fromTo, exactly("21n5nc…fMMLNz"));
    assert.ok(fromTo.split(" ").includes(EVM), fromTo);
    assert.doesNotMatch(fromTo, /bob\.dusk/u);
  }
});

test("a typed .dusk name shows the account it points to, in full, under the recipient", () => {
  const to = { ...cardVmFor().to, editing: true, input: "alice.dusk", label: "Recipient on Dusk", net: { id: "dusk", name: "Dusk" }, placeholder: "A Dusk account or .dusk name", resolved: { address: ACCOUNT, name: "alice.dusk" } };
  const note = (resolved) => textOf(cardRegions(cardVmFor({ to: { ...to, resolved } }))["recipient-note"]);
  assert.ok(note(to.resolved).split(" ").includes(ACCOUNT), note(to.resolved));
  assert.ok(!note(null).includes(ACCOUNT));
});

test("About this page names the servers the page reads from", () => {
  const line = serversLine(testnet);
  for (const host of ["testnet.nodes.dusk.network", "rpc.testnet.evm.dusk.network", "ethereum-sepolia-rpc.publicnode.com", "testnet.dusk.domains"]) assert.match(line, exactly(host), host);
  // The names' host is the one each network's pinned release fetches its lens driver from.
  for (const cfg of [testnet, mainnet]) assert.match(serversLine(cfg), exactly(new URL(releaseFor(cfg.dusk.chainId).artifactBaseUrl).host));
});

test("the card, its quote, the review, the receipt and the transfer quote one fee a step", () => {
  const gasPrice = 2n;
  const route = T["duskevm-withdrawal"];
  const withdrawalGas = 519_542n;
  // Before the withdrawal exists: the card's route row, both Dusk steps as one figure, and its quote, a step each.
  assert.deepEqual(amountsIn(routeLine(route, testnet, { gasPrice })), ["≤0.204 DUSK"]);
  const form = buildQuote(route, "1", { balance: null, cfg: testnet, gasPrice });
  assert.deepEqual(amountsIn(form.rows.find((row) => row.key === "fee-dusk").value), ["≤0.102 DUSK"]);
  // Once it exists, with its own gas: the card, the receipt, and the review's request.
  const entry = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: route.id, sourceAt: Date.UTC(2026, 9, 1), stage: "ready_to_prove", status: "pending", withdrawalGas: withdrawalGas.toString() };
  assert.deepEqual(amountsIn(receiptModel(entry, { cfg: testnet, gasPrice, route, url: "https://bridge.example/#/transfer/w" }).actionFee), ["≤0.102 DUSK"]);
  const request = withdrawalGasLimit(withdrawalGas) * gasPrice;
  assert.equal(request, withdrawalStepMax({ gasPrice, withdrawalGas }));
  for (const kind of ["prove", "finalize"]) assert.deepEqual(amountsIn(actionLead(kind, entry, { maxLux: request }).rows.find((row) => row.key === "fee").value), ["≤0.102 DUSK"]);
});

test("a Dusk recipient handed over in the link is shown by its account, and said apart where it isn't the connected one", () => {
  const SHORT = exactly("21n5nc…fMMLNz");
  const line = (route, options) => recipientLine(route, { destination: ACCOUNT, ...options });
  for (const [route, options] of [
    [T.migration, { handedOver: true }],
    // Even when it's the connected account.
    [T["duskevm-withdrawal"], { connected: true, duskName: "alice.dusk", handedOver: true, own: true }],
    [T.migration, { connected: true, handedOver: true }],
    [T.migration, {}],
  ])
    assert.match(textOf(line(route, options)), SHORT);
  // Another account than the connected one is said to be.
  assert.notEqual(line(T.migration, { connected: true, handedOver: true }), line(T.migration, { handedOver: true }));
  // Your own account by its .dusk name; a typed name with the account it points to.
  assert.match(textOf(line(T.migration, { duskName: "alice.dusk", own: true })), exactly("alice.dusk"));
  const bob = textOf(line(T.migration, { resolved: { address: ACCOUNT, name: "bob.dusk" } }));
  assert.match(bob, exactly("bob.dusk"));
  assert.match(bob, SHORT);
  assert.match(textOf(recipientLine(T["duskevm-deposit"], { destination: EVM, own: true, walletName: "MetaMask" })), exactly("0xd63bB1…fE8df4"));
});

test("with more than one Dusk wallet to choose from, each button shows its own wallet's name and ID, and chooses that wallet", () => {
  const sheet = walletsSheet({ wallets: [{ id: "a", name: "Dusk Wallet", rdns: "network.dusk.wallet" }, { id: "b<", name: "Piewallet", rdns: "com.piewallet" }] });
  // What a press chooses, read as the page's handler reads it, beside what that button shows.
  const buttons = [...sheet.matchAll(/<button\b[^>]*\bdata-action="choose-dusk"[^>]*\bdata-wallet="([^"]*)"[^>]*>([\s\S]*?)<\/button>/gu)];
  assert.deepEqual(buttons.map(([, id, shown]) => [decode(id), textOf(shown)]), [
    ["a", "Dusk Wallet network.dusk.wallet"],
    ["b<", "Piewallet com.piewallet"],
  ]);
  // A wallet's own words can't break out of the attribute.
  assert.ok(sheet.includes('data-wallet="b&lt;"'));
});

// That a fee or the network says something before sending: by a short phrase each.
const FEE_OVER = /\bmore than the amount\b/iu;
const BUSY = /\bnetwork busy\b/iu;
/** The warnings a fragment shows, each its own line, in amber. */
const warningsOf = (fragment) => partsOf(fragment, "warn").map(textOf);
/** Whether a review's Confirm can be pressed. */
const confirmable = (sheet) => /data-action="confirm" (?!disabled)/u.test(sheet);

test("a bridge fee more than the amount is a warning on the card and the review, and blocks nothing", () => {
  const route = buildRoutes(testnet).find((each) => each.id === "dusk-to-sepolia");
  const quoteFor = (amount) => buildQuote(route, amount, { balance: 2_000n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } });
  // 16.876 DUSK on 1 DUSK: said; on 20 DUSK: not.
  const over = quoteFor("1");
  assert.equal(over.feeOverAmount, true);
  assert.equal(quoteFor("20").feeOverAmount, false);
  // On the card, under the route line: one warning; its button still reviews.
  const card = cardRegions(cardVmFor({ warnings: feeNotes(over) }));
  assert.deepEqual(warningsOf(card.route).map((text) => FEE_OVER.test(text)), [true]);
  assert.ok(card.cta.includes('data-action="review"') && !card.cta.includes("disabled"), card.cta);
  assert.deepEqual(warningsOf(cardRegions(cardVmFor({ warnings: feeNotes(quoteFor("20")) })).route), []);
  // On the review: one warning, and Confirm stays on.
  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send 1 DUSK", feeRows: over.rows.filter((row) => !["send", "receive"].includes(row.key)), fees: over.fees, privacy: "x", warnings: feeNotes(over),
    receive: { account: EVM, amount: "1", chain: "ethereum", full: true, unit: "DUSK", where: "Sepolia" }, send: { amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, ready: true }], sub: "",
  });
  assert.deepEqual(warningsOf(sheet).map((text) => FEE_OVER.test(text)), [true]);
  assert.ok(confirmable(sheet), sheet);
});

test("a busy network is a warning on the card and the review, for what's signed on Dusk, and blocks nothing", () => {
  assert.deepEqual(busyNotes(true), [NETWORK_BUSY]);
  assert.deepEqual(busyNotes(false), []);
  assert.match(NETWORK_BUSY, BUSY);
  // On the card, under the route line, beside a fee more than the amount; its button still reviews.
  const card = cardRegions(cardVmFor({ warnings: [...busyNotes(true), "Bridge fee is more than the amount"] }));
  assert.deepEqual(warningsOf(card.route).map((text) => [BUSY.test(text), FEE_OVER.test(text)]), [[true, false], [false, true]]);
  assert.ok(card.cta.includes('data-action="review"') && !card.cta.includes("disabled"), card.cta);
  assert.deepEqual(warningsOf(cardRegions(cardVmFor({ warnings: busyNotes(false) })).route), []);
  // On the review: one warning, and Confirm stays on.
  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send 1 DUSK", feeRows: [], privacy: "x", warnings: busyNotes(true),
    receive: { account: EVM, amount: "1", chain: "dusk-evm", full: true, unit: "DUSK", where: "DuskEVM" }, send: { amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, ready: true }], sub: "",
  });
  assert.deepEqual(warningsOf(sheet).map((text) => BUSY.test(text)), [true]);
  assert.ok(confirmable(sheet), sheet);
});

test("a review shows the fees as one figure, whom it pays in full, and folds their split under Details", () => {
  const route = buildRoutes(testnet).find((each) => each.id === "dusk-to-sepolia-eurd");
  const quote = buildQuote(route, "1", { balance: 2_000n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { allowance: 0n, fee: 16_876_000_000n, tokenBalance: 10n ** 9n } });
  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Approve 1 EURd", feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)), fees: quote.fees, privacy: "x",
    receive: { account: EVM, amount: "1", chain: "ethereum", full: true, unit: "EURd", where: "Sepolia" }, send: { amount: "1", chain: "dusk", unit: "EURd", where: "Dusk" },
    steps: [{ current: true, ready: true }], sub: "",
  });
  // In view: the fees as one figure, the bridge's and the network's both steps' most, and whom it pays in full.
  const fees = fieldOf(sheet, "Fees");
  assert.ok(fees.shown);
  assert.deepEqual(amountsIn(fees.text), ["≤16.884 DUSK"]);
  assert.ok(textOf(sheet).split(" ").includes(EVM), sheet);
  // Under Details: the split, each fee in its own field, one figure each: the network's at its most.
  for (const label of ["Bridge fee", "Network fee"]) assert.equal(fieldOf(sheet, label).shown, false, label);
  const [split] = partsOf(sheet, "wl-more");
  assert.deepEqual(fieldsOf(split).map((field) => [field.label, field.text]), [["Bridge fee", "16.876 DUSK"], ["Network fee", "up to 0.008 DUSK"]]);
  // The amount is in EURd and the fees in DUSK: no total adds them.
  assert.deepEqual(fieldsOf(sheet).filter((field) => field.label === "Total"), []);
});

test("a review in DUSK shows the total Dusk Wallet asks for where it isn't the amount and the fees, beside the fees as one figure", () => {
  const sheetFor = (route, quote, receive) =>
    reviewSheet({
      canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send", feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)), fees: quote.fees, privacy: PUBLIC_LINE,
      receive: { account: receive, amount: "1", chain: route.to.id, full: true, unit: "DUSK", where: route.to.id }, send: { account: "21n5nc…fMMLNz", amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" },
      steps: [{ current: true, ready: true }], sub: "",
    });
  const byRoute = (id) => buildRoutes(testnet).find((each) => each.id === id);
  // 1 DUSK to Sepolia: the bridge fee on top, 16.876 DUSK, and the network fee at its most: 17.881 DUSK leaves, in view.
  const dusk = byRoute("dusk-to-sepolia");
  const native = sheetFor(dusk, buildQuote(dusk, "1", { balance: 20n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } }), EVM);
  assert.deepEqual(["Fees", "Total"].map((label) => [fieldOf(native, label).shown, fieldOf(native, label).text]), [[true, "up to 16.881 DUSK"], [true, "up to 17.881 DUSK"]]);
  // 50 DUSK to the bridge's account: its fee comes from the amount, so what leaves is the amount and the network fee.
  const service = T["service-transfer"];
  const payout = sheetFor(service, buildQuote(service, "50", { balance: 100n * 10n ** 9n, cfg: testnet, gasPrice: 1n }), EVM);
  assert.deepEqual(["Fees", "Total"].map((label) => [fieldOf(payout, label).shown, fieldOf(payout, label).text]), [[true, "up to 1.0025 DUSK 1 DUSK of it from the amount"], [true, "up to 50.0025 DUSK"]]);
  // To DuskEVM, what leaves is the amount and the fee in view: no total says it again.
  const deposit = T["duskevm-deposit"];
  const plain = sheetFor(deposit, buildQuote(deposit, "1", { balance: 20n * 10n ** 9n, cfg: testnet, gasPrice: 1n }), EVM);
  assert.equal(fieldOf(plain, "Network fee").text, "up to 0.005 DUSK");
  assert.deepEqual(fieldsOf(plain).filter((field) => field.label === "Total"), []);
});

test("a call Dusk Wallet can't read has its own fold, by what the wallet asks, with its method and arguments each in its own field", () => {
  const call = [
    { label: "Method", mono: true, value: "transfer_remote" },
    { full: "979fb72774e1d45a07abd0d57479578513917ab855bb4027acdfd48ac8ee5a0b", label: "Contract", mono: true, value: "979fb7…ee5a0b" },
    { label: "Recipient", mono: true, value: EVM, wrap: true },
    { label: "Amount", value: "1 DUSK (1000000000 Lux)" },
  ];
  const vm = (step, receive = {}) => ({ canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send 1 DUSK", feeRows: [], privacy: "x", receive: { amount: "1", chain: "ethereum", unit: "DUSK", where: "Sepolia", ...receive }, send: { amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, ready: true, ...step }], sub: "" });
  const sheet = reviewSheet(vm({ call }));
  // Folded, by what the wallet's window says to check.
  assert.deepEqual([...sheet.matchAll(/<summary>([^<]*)<\/summary>/gu)].map(([, text]) => text), ["Call details, to check against Dusk Wallet"]);
  assert.equal(fieldOf(sheet, "Method").shown, false);
  // Opened: each value in its own field, the recipient in full.
  const shown = opened(sheet);
  assert.equal(fieldOf(shown, "Method").text, "transfer_remote");
  assert.ok(fieldOf(shown, "Recipient").text.split(" ").includes(EVM));
  assert.deepEqual(amountsIn(fieldOf(shown, "Amount").text), ["1 DUSK"]);
  // Where the review shows whom it pays, in full, the call doesn't say it again, in any case.
  const [paid] = partsOf(reviewSheet(vm({ call: call.map((row) => (row.label === "Recipient" ? { ...row, value: EVM.toLowerCase() } : row)) }, { account: EVM, full: true })), "wl-more");
  assert.deepEqual(fieldsOf(paid).map((field) => field.label), ["Method", "Contract", "Amount"]);
  // A call the wallet reads itself, or one not built yet: no such fold.
  for (const step of [{}, { call: null, ready: false }]) assert.doesNotMatch(reviewSheet(vm(step)), /Call details/u);
});

test("on a wide screen a review sets its reference beside it, open, and says nothing there twice; narrower, it folds", () => {
  const route = buildRoutes(testnet).find((each) => each.id === "dusk-to-sepolia");
  const quote = buildQuote(route, "1", { balance: 20n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } });
  const call = [
    { label: "Method", mono: true, value: "transfer_remote" },
    { full: "979fb72774e1d45a07abd0d57479578513917ab855bb4027acdfd48ac8ee5a0b", label: "Contract", mono: true, value: "979fb7…ee5a0b" },
    { label: "Destination", value: "Sepolia, Hyperlane domain 11155111" },
    { label: "Recipient", mono: true, value: EVM.toLowerCase(), wrap: true },
    { label: "Amount", value: "1 DUSK (1000000000 Lux)" },
    { detail: "the amount and the bridge fee", label: "Deposit", value: "17.876 DUSK" },
  ];
  const sheet = (wide) =>
    reviewSheet({
      canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send 1 DUSK", feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)), fees: quote.fees, privacy: PUBLIC_LINE,
      receive: { account: EVM, amount: "1", chain: "ethereum", full: true, unit: "DUSK", where: "Sepolia" }, send: { account: "21n5nc…fMMLNz", amount: "1", chain: "dusk", unit: "DUSK", where: "Dusk" },
      steps: [{ call, current: true, ready: true, walletName: "Dusk Wallet" }], sub: "", warnings: feeNotes(quote), wide,
    });
  const wide = sheet(true);
  // Nothing folded: the decision on the left, whole by itself; the reference beside it, the fees' split and the call.
  assert.doesNotMatch(wide, /<details/u);
  const [main] = partsOf(wide, "rv-main");
  const [side] = partsOf(wide, "rv-side");
  assert.deepEqual(fieldsOf(main).map((field) => [field.label, field.text]), [
    ["You send", "1 DUSK"],
    ["You receive", "1 DUSK"],
    ["Fees", "up to 16.881 DUSK"],
    ["Total", "up to 17.881 DUSK"],
    ["Arrives", "~20 s"],
  ]);
  assert.ok(textOf(main).split(" ").includes(EVM));
  assert.deepEqual(warningsOf(main).map((text) => FEE_OVER.test(text)), [true]);
  assert.deepEqual(fieldsOf(side).map((field) => [field.label, field.text]), [
    ["Bridge fee", "16.876 DUSK on top of the amount"],
    ["Network fee", "up to 0.005 DUSK"],
    ["Method", "transfer_remote"],
    ["Contract", "979fb7…ee5a0b"],
    ["Destination", "Sepolia, Hyperlane domain 11155111"],
    ["Amount", "1 DUSK (1000000000 Lux)"],
    ["Deposit", "17.876 DUSK the amount and the bridge fee"],
  ]);
  assert.match(textOf(side), /Call details, to check against Dusk Wallet/u);
  // Nothing beside it is said on the left: not whom it pays, in any case, not a fee or a total.
  for (const field of fieldsOf(side)) assert.ok(!textOf(main).toLowerCase().includes(field.text.toLowerCase()), field.label);
  // Narrower, the same reference folds: the split under Details, the call in its own fold, none of it shown.
  const narrow = sheet(false);
  assert.deepEqual([...narrow.matchAll(/<summary>([^<]*)<\/summary>/gu)].map(([, text]) => text), ["Details", "Call details, to check against Dusk Wallet"]);
  assert.deepEqual(partsOf(narrow, "wl-more").flatMap((part) => fieldsOf(part).map((field) => field.label)), fieldsOf(side).map((field) => field.label));
  assert.ok(fieldsOf(narrow).filter((field) => ["Bridge fee", "Method"].includes(field.label)).every((field) => !field.shown));
});

test("on a wide screen a receipt's details sit beside it, open; narrower, they fold under the rest", () => {
  const entry = { amountLux: "25000000000", destination: EVM.toLowerCase(), feeLux: "1986599", hash: "38".repeat(32), id: "w", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, sourceAt: Date.UTC(2026, 9, 26, 9, 31, 12), status: "pending" };
  const model = receiptModel(entry, { cfg: testnet, locale: "en-GB", route: T["duskevm-deposit"], timeZone: "Europe/Amsterdam", url: "https://bridge.example.org/#/transfer/w" });
  const wide = receiptPage({ ...model, wide: true });
  assert.doesNotMatch(wide, /<details/u);
  const [side] = partsOf(wide, "rc-side");
  assert.equal(textOf(side).split(" ")[0], "Details");
  assert.deepEqual(fieldsOf(wide).filter((field) => field.shown).map((field) => field.label), ["Network fee", "From"]);
  const narrow = receiptPage({ ...model, wide: false });
  assert.deepEqual([...narrow.matchAll(/<summary class="gh">([^<]*)<\/summary>/gu)].map(([, text]) => text), ["Details"]);
  assert.deepEqual(fieldsOf(narrow).filter((field) => field.shown), []);
});

test("the header writes a connected account 6…6, as the card writes the same account", () => {
  const page = header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { account: EVM.toLowerCase(), chainName: "Sepolia", state: "connected", walletName: "MetaMask" }, isTestnet: true });
  const accounts = partsOf(page, "mono").map((part) => decode(part.replace(/<[^>]*>/gu, "")));
  assert.deepEqual(accounts, ["21n5nc…fMMLNz", "0xd63bB1…fE8df4"]);
});

test("the card's route line opens on the fees' split, each fee one figure, and the total where DUSK pays both; no row of steps", () => {
  const byRoute = (id) => buildRoutes(testnet).find((each) => each.id === id);
  const fold = (route, quote) => fieldsOf(cardRegions(cardVmFor({ routeRows: routeDetailRows(route, quote) })).route).map((field) => [field.label, field.text]);
  const eurd = byRoute("dusk-to-sepolia-eurd");
  assert.deepEqual(fold(eurd, buildQuote(eurd, "1", { balance: 20n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { allowance: 0n, fee: 16_876_000_000n, tokenBalance: 10n ** 9n } })), [
    ["Bridge fee", "16.876 DUSK"],
    ["Network fee", "up to 0.008 DUSK"],
  ]);
  const dusk = byRoute("dusk-to-sepolia");
  assert.deepEqual(fold(dusk, buildQuote(dusk, "1", { balance: 20n * 10n ** 9n, cfg: testnet, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } })), [
    ["Bridge fee", "16.876 DUSK on top of the amount"],
    ["Network fee", "up to 0.005 DUSK"],
    ["Total", "up to 17.881 DUSK"],
  ]);
});

test("a label reads exactly as given once its numbers are kept whole, in any language's separators, a typed name escaped", () => {
  const labels = [
    "Review 99,999,999.123456789 BEP20 DUSK",
    "Review 12.345,6789 DUSK",
    "Review 25\u202f000,1234 DUSK",
    "Review 12\u2019345.6789 DUSK",
    "Claim 95.085867 EURd for it",
    "Looking up <img src=x onerror=alert(1)>.dusk…",
    "Send  25 DUSK",
  ];
  for (const label of labels) {
    const html = wholeNumbers(label, ".cta");
    assert.equal(decode(html.replace(/<[^>]*>/gu, "")), label);
    assert.doesNotMatch(html, /<img/u);
  }
});
