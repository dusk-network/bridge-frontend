import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { encodeDepositArgs } from "@dusk-network/networks/duskevm";
import { withdrawalGasLimit } from "@dusk-network/networks/gas";
import { releaseFor } from "@duskdomains/sdk/releases";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { actionLead, actionPrivacy, availableLine, balanceLine, openApproval, pricedReview, receiptModel, recipientLine, replacedLine, reviewChecks, revokeReview, routeLine, transfersModel } from "./page-models.js";
import { buildQuote, withdrawalStepMax } from "./quote.js";
import { activityPanel, cardPage, cardRegions, contractsSheet, footer, header, networkSheet, receiptPage, reviewSheet, walletLines, walletsSheet } from "./views.js";
import { formatDateTime } from "./format.js";
import { chainMark, pairMark } from "./icons.js";
import { approveLines, duskCallLines, duskTransferLines, migrateLines, walletFee, withdrawalAmount } from "./wallet-lines.js";
import { driverJson, loadDataDriver } from "./data-driver.js";
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
    privacy: "Public on Dusk and DuskEVM, and linked: your Dusk account wallet-both.dusk (21n5nc…fMMLNz), 0xd63b…8df4 and the amount.",
    quote: buildQuote(T["duskevm-deposit"], "25", { balance: 174_003_700_000n, cfg: testnet, gasPrice: 1n }),
    receive: "25",
    receiveUnit: "DUSK",
    routeLine: routeLine(T["duskevm-deposit"], testnet),
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

test("the card's route row gives each route its time and cost in one line", () => {
  const line = (mode, cfg = testnet, timing) => routeLine(routesOf(cfg)[mode], cfg, { timing });
  assert.equal(line("duskevm-deposit"), "~1 min · fee up to 0.005 DUSK");
  // The withdrawal's time is the chain's: none until it's read.
  assert.equal(line("duskevm-withdrawal"), "Three steps · up to 0.051 DUSK a step on Dusk");
  const read = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
  assert.equal(line("duskevm-withdrawal", testnet, read), "~7 days · three steps · up to 0.051 DUSK a step on Dusk");
  // No time is known for the testnet payouts: the cost alone.
  assert.equal(line("service-transfer"), "1 DUSK bridge fee");
  assert.equal(line("migration"), "Two wallet steps · fee in ETH");
  // Mainnet's own times.
  assert.equal(line("service-transfer", mainnet), "~10 hours · 1 DUSK bridge fee");
  const from = (id) => buildRoutes(mainnet).find((route) => route.from.id === id);
  assert.equal(routeLine(from("ethereum"), mainnet), "~70 min · two wallet steps · fee in ETH");
  assert.equal(routeLine(from("bsc"), mainnet), "~1 hour · two wallet steps · fee in BNB");
});
test("how the route is doing is said under it, and stops nobody from sending", () => {
  const status = { text: "Payouts are running late. Last payout 3 hours ago.", warn: true };
  const vm = cardVmFor({ status });
  const { cta, route } = cardRegions(vm);
  assert.ok(route.includes('<span class="route-sum"><span>~1 min · fee up to 0.005 DUSK</span><span class="route-status warn">Payouts are running late. Last payout 3 hours ago.</span></span>'), route);
  assert.equal(cta, cardRegions(cardVmFor())["cta"]);
  assert.ok(cta.includes('data-action="review"') && !cta.includes("disabled"), cta);
  // In the card's open row too, and quiet where nothing could make anyone wait.
  assert.ok(cardPage(vm).includes("route-status warn"));
  assert.ok(cardRegions(cardVmFor({ status: { text: "Paying out.", warn: false } })).route.includes('<span class="route-status">Paying out.</span>'));
  // Until it's read, or where there's nothing to say, nothing.
  assert.doesNotMatch(cardRegions(cardVmFor()).route, /route-status/u);
});

test("a name typed without .dusk is offered as the .dusk name, under the recipient", () => {
  const vm = cardVmFor({ to: { ...cardVmFor().to, editing: true, error: "That isn't a Dusk account or a .dusk name.", input: "alice", suggest: "alice.dusk" } });
  assert.equal(cardRegions(vm)["recipient-note"], '<button type="button" class="linkish" data-action="recipient-suggest">Did you mean alice.dusk?</button>');
});

test("the review checks the facts first, then lists the wallet's lines with full addresses", async () => {
  const route = T.migration;
  const lux = 1_000_000_000_000n;
  const reads = { migration: { allowanceWei: 0n, balanceWei: 2_500n * 10n ** 18n, gasCoinWei: 21_300_000_000_000_000n, gasPriceWei: 2_000_000_000n } };
  const quote = buildQuote(route, "1000", { allowanceWei: 0n, balance: reads.migration.balanceWei, cfg: testnet, evmGas: { approve: 46_000n, migrate: 70_000n, priceWei: 2_000_000_000n } });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote, reads });
  assert.deepEqual(checks.map((check) => check.ok), [true, true, true]);
  assert.match(checks[0].html, /2,500 ERC20 DUSK<\/b> at <code class="mono">0xd63b…8df4<\/code> on Sepolia/u);
  assert.match(checks[1].html, /0\.0213 ETH<\/b> for the network fee, about 0\.00023 ETH needed for both steps/u);
  // Not enough ETH is caught before the wallet opens.
  const poor = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { migration: { ...reads.migration, gasCoinWei: 1n } } });
  assert.equal(poor[1].ok, false);

  const approve = approveLines({ amountLux: lux, cfg: testnet, fee: 92_000_000_000_000n, network: "ethereum" });
  const migrate = migrateLines({ amountLux: lux, cfg: testnet, duskAccount: ACCOUNT, fee: null, network: "ethereum" });
  assert.deepEqual(approve.map((line) => line.label), ["Network", "Token", "Spender", "Spending cap", "Network fee"]);
  assert.equal(approve[0].value, "Sepolia, chain 11155111");
  assert.equal(approve[3].value, "1,000 ERC20 DUSK");
  const amountLine = migrate.find((line) => line.label === "amount");
  assert.equal(amountLine.value, "1000000000000000000000");
  assert.match(amountLine.note, /^= 1,000 DUSK\./u);
  assert.equal(migrate.find((line) => line.label === "Estimated change").value, "−1,000 ERC20 DUSK");
  // The deployed migration contract names its account argument targetAddress, on BSC and Ethereum alike.
  const target = migrate.find((line) => line.label === "targetAddress");
  assert.deepEqual([target.address, target.note], [ACCOUNT, "Your Dusk account that receives the DUSK."]);

  const vm = {
    canConfirm: true,
    cfgLinks: explorer,
    checks,
    confirmLabel: "Approve 1,000 ERC20 DUSK in MetaMask",
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    privacy: "x",
    receive: { amount: "1,000", chain: "dusk", unit: "DUSK", where: "Dusk" },
    send: { amount: "1,000", chain: "ethereum", unit: "ERC20 DUSK", where: "Sepolia" },
    steps: [
      { current: true, lines: approve, title: "Approve exactly 1,000 ERC20 DUSK", walletName: "MetaMask", what: "", when: "Now" },
      { current: false, lines: migrate, title: "Migrate", walletName: "MetaMask", what: "", when: "After step 1" },
    ],
    sub: "",
    walletCheckName: "MetaMask",
  };
  const sheet = reviewSheet(vm);
  // Every address in full, with a copy button and an explorer link: never 4 + 4 alone.
  for (const address of [testnet.evmNetworks.ethereum.migrationContract, testnet.evmNetworks.ethereum.tokenContract, ACCOUNT]) {
    assert.ok(sheet.includes(`<code class="mono">${address}</code>`), address);
    assert.ok(sheet.includes(`data-copy="${address}"`), address);
  }
  assert.ok(sheet.includes(`https://sepolia.etherscan.io/address/${testnet.evmNetworks.ethereum.migrationContract}`));
  assert.match(sheet, />Cancel<\/button><button type="button" class="btn pri" data-action="confirm" >Approve 1,000 ERC20 DUSK in MetaMask</u);
  assert.ok(!sheet.includes(TIMES));
  // Each step's tag follows the review: once the approval is confirmed, it's done and the migration is now.
  const tags = (html) => [...html.matchAll(/<h3 id="req-\d+">[\s\S]*?<span class="tag">([^<]*)<\/span><\/h3>/gu)].map((match) => match[1]);
  assert.deepEqual(tags(sheet), ["Now", "After step 1"]);
  assert.deepEqual(tags(reviewSheet({ ...vm, steps: vm.steps.map((step, index) => ({ ...step, current: index === 1 })) })), ["Done", "Now"]);
});

test("an approval not used up shows above the way back's form, with Finish and Revoke", () => {
  const route = T.migration;
  const HALF = 5n * 10n ** 17n;
  const held = 5n * 10n ** 18n;
  const open = openApproval(route, { allowanceWei: HALF, balanceWei: held, evm: EVM });
  const box = cardRegions(cardVmFor({ approval: open })).approval;
  assert.match(box, /<b>Open approval\.<\/b> The Dusk migration contract may still take <b class="num">0\.5 ERC20 DUSK<\/b> from <code class="mono">0xd63b…8df4<\/code>\./u);
  assert.match(box, /data-action="approval-finish">Finish<\/button><button type="button" class="btn sec sm" data-action="approval-revoke">Revoke<\/button>/u);
  // Above From, where the way back starts.
  const page = cardPage(cardVmFor({ approval: open }));
  assert.ok(page.indexOf("Open approval.") < page.indexOf('data-side="from"'));
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
  assert.match(say(2n ** 256n - 1n), /may still take <b class="num">any amount of ERC20 DUSK<\/b>/u);
  assert.match(say(999n), /may still take <b class="num">less than 0\.000000001 ERC20 DUSK<\/b>/u);
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
  assert.equal(covered("0.2", HALF), 'An earlier approval of <b class="num">0.5 ERC20 DUSK</b> covers this, so you aren\'t asked to approve. <b class="num">0.3 ERC20 DUSK</b> stays approved after it.');
  assert.equal(covered("0.5", HALF), 'An earlier approval of <b class="num">0.5 ERC20 DUSK</b> covers this, so you aren\'t asked to approve. None of it stays approved after it.');
  assert.equal(covered("1", 2n ** 256n - 1n), "An earlier approval with no limit covers this, so you aren't asked to approve. It stays approved after it.");
  assert.match(covered("0.5", HALF + 5n), /<b class="num">Less than 0\.000000001 ERC20 DUSK<\/b> stays approved after it\.$/u);
  // A fact, read on the chain: the review still confirms.
  assert.ok(checks("0.2", HALF).every((check) => check.ok));
  // One that doesn't cover it isn't said to: the approval step replaces it, and says so.
  assert.equal(covered("1", HALF), undefined);
  assert.equal(covered("0.2", 0n), undefined);
  assert.equal(replacedLine(HALF, "ERC20 DUSK"), "It replaces the earlier approval of 0.5 ERC20 DUSK.");
  assert.equal(replacedLine(0n, "ERC20 DUSK"), "");
});

test("a revoke is reviewed as its wallet shows it: an approval of 0, and nothing moves", () => {
  const route = T.migration;
  const reads = { migration: { allowanceWei: 3n * 10n ** 16n, balanceWei: 10n ** 17n, gasCoinWei: 9n * 10n ** 15n, gasPriceWei: 10n ** 9n } };
  const revoke = (patch = {}, feeWei = 26_000n * 10n ** 9n) => revokeReview(route, { cfg: testnet, evm: { account: EVM }, feeWei, reads: { migration: { ...reads.migration, ...patch } }, walletName: "MetaMask" });
  const review = revoke();
  assert.deepEqual(review.lead, { amount: "0.03", chain: "ethereum", label: "Approved now", line: "Sepolia · 0xd63b…8df4 · No DUSK moves", unit: "ERC20 DUSK" });
  const [step] = review.steps;
  assert.deepEqual(
    step.lines.map((line) => [line.label, line.value, line.address ?? ""]),
    [
      ["Network", "Sepolia, chain 11155111", ""],
      ["Token", "ERC20 DUSK", testnet.evmNetworks.ethereum.tokenContract],
      ["Spender", "Dusk migration contract", testnet.evmNetworks.ethereum.migrationContract],
      ["Spending cap", "0 ERC20 DUSK", ""],
      ["Network fee", "about 0.000026 ETH", ""],
    ],
  );
  assert.deepEqual([step.title, step.confirmLabel], ["Revoke the approval", "Revoke in MetaMask"]);
  assert.deepEqual(review.feeRows.map((row) => [row.label, row.value, row.detail]), [["Network fee", "about 0.000026 ETH", "one wallet step"]]);
  assert.match(review.checks[0].html, /0\.009 ETH<\/b> for the network fee, about 0\.000026 ETH needed for the step/u);
  // Without ETH for its fee, it can't be confirmed.
  assert.equal(revoke({ gasCoinWei: 1n }).checks[0].ok, false);
  // Its sheet: what's approved now, what's public, the step and its lines, as every review shows them.
  const sheet = reviewSheet({ ...review, canConfirm: true, cfgLinks: explorer, confirmLabel: step.confirmLabel, steps: review.steps.map((item) => ({ ...item, current: true })), walletCheckName: "MetaMask" });
  assert.match(sheet, /<div class="k">Approved now<\/div><div class="v num">0\.03<span class="u">ERC20 DUSK<\/span><\/div>/u);
  assert.match(sheet, /<b>Public on Sepolia:<\/b> 0xd63b…8df4 and that it revokes its approval\./u);
  assert.ok(sheet.includes(`<code class="mono">${testnet.evmNetworks.ethereum.migrationContract}</code>`));
  assert.match(sheet, /data-action="confirm" >Revoke in MetaMask</u);
  // One with no limit, as that; its fee, as the wallet shows it, before it's estimated.
  const unlimited = revoke({ allowanceWei: 2n ** 256n - 1n }, null);
  assert.deepEqual([unlimited.lead.amount, unlimited.lead.unit], ["No limit", ""]);
  assert.equal(unlimited.steps[0].lines.at(-1).value, "shown by your wallet, paid in ETH");
  assert.doesNotMatch(reviewSheet({ ...unlimited, canConfirm: true, cfgLinks: explorer, confirmLabel: "x", steps: unlimited.steps.map((item) => ({ ...item, current: true })), walletCheckName: "MetaMask" }), /No limit<span class="u">/u);
});

// Dusk Wallet's approval windows (ux/extension-approvals): each line's label
// and value as the window prints it, group by group.
const rowsOf = (lines) => lines.filter((line) => !line.kind);
const labelsOf = (lines) => rowsOf(lines).map((line) => line.label);
const valueOf = (lines, label) => rowsOf(lines).find((line) => line.label === label);
const groupsOf = (lines) => rowsOf(lines).filter((line) => line.gap).map((line) => line.label);
// What the window folds under Details.
const foldOf = (lines) => rowsOf(lines).filter((line) => line.fold).map((line) => line.label);
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

test("a deposit lists Dusk Wallet's bridge window: what it does, the fee and the contract, its hash under Details", async () => {
  const lines = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT, note: "The DuskEVM bridge contract on Dusk." });
  assert.deepEqual(lines[0], {
    amount: "0.1 DUSK",
    kind: "head",
    tag: "Known DuskEVM bridge call",
    title: "Bridge to DuskEVM",
    to: "0x96BA…893e",
    toFull: SHOT,
    where: "on DuskEVM",
  });
  assert.deepEqual(labelsOf(lines), [
    "DuskEVM recipient", "Amount", "From",
    "Network fee", "Total",
    "Contract", "Deposit",
    "Method", "Call data", "From the site, not checked by the wallet",
  ]);
  assert.deepEqual(groupsOf(lines), ["Network fee", "Contract"]);
  assert.deepEqual(foldOf(lines), ["Method", "Call data", "From the site, not checked by the wallet"]);
  assert.equal(valueOf(lines, "DuskEVM recipient").address, SHOT);
  assert.equal(valueOf(lines, "Amount").value, "0.1 DUSK");
  assert.deepEqual([valueOf(lines, "From").value, valueOf(lines, "From").suffix], ["21n5nc…fMMLNz", "Public"]);
  assert.equal(valueOf(lines, "Network fee").value, "up to 0.005 DUSK");
  assert.equal(valueOf(lines, "Total").value, "up to 0.105 DUSK");
  // The contract by its network's name, then its ID without 0x, 6…6, as the window writes it.
  const contract = valueOf(lines, "Contract");
  assert.deepEqual([contract.name, contract.value, contract.full, contract.note], ["DuskEVM bridge", "2257e5…a1b31d", DUSKEVM.VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID, undefined]);
  assert.equal(valueOf(lines, "Call data").value, "40 bytes · sha256=2f64b19f5ac0…731c7c2a");
  assert.equal(valueOf(lines, "Call data").note, "Older Dusk Wallet versions show the call as bytes; check the sha256.");
  assert.equal(valueOf(lines, "Deposit").value, "0.1 DUSK");

  const view = walletLines(lines, explorer);
  assert.match(view, /<div class="wlhd"><div class="wlt">Bridge to DuskEVM<\/div><div class="wlto"><span class="num">0\.1 DUSK<\/span> to <code class="mono" title="0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e">0x96BA…893e<\/code> on DuskEVM<\/div><span class="tag">/u);
  assert.ok(view.includes(`<code class="mono">${SHOT}</code>`));
  assert.match(view, /<div class="wl gap"><dt>Network fee<\/dt>/u);
  assert.match(view, /<span class="mono wrap" title="21n5nc[^"]+">21n5nc…fMMLNz<\/span><span class="t2"> · Public<\/span>/u);
  // Its "·" stays with the ID it belongs to.
  assert.match(view, /<dt>Contract<\/dt><dd><span class="wl-contract"><span class="wl-name">DuskEVM bridge<\/span> <span class="wl-id">· <span class="mono wrap" title="2257e5f8[0-9a-f]{56}">2257e5…a1b31d<\/span><\/span><\/span><\/dd>/u);
  // The method, the hash and the site's words sit under Details, as in the window.
  assert.match(view, /<\/dl><details class="wl-more"><summary>Details<\/summary><dl class="wls"><div class="wl"><dt>Method<\/dt>/u);
  assert.ok(view.indexOf("sha256=") > view.indexOf("<summary>Details</summary>"));
  // With the .dusk name Dusk Wallet sent, From reads as the window does.
  const named = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT, fromName: "alice.dusk" });
  assert.deepEqual([valueOf(named, "From").value, valueOf(named, "From").suffix, valueOf(named, "From").note], ["alice.dusk", "Public", undefined]);

  // Where Dusk Wallet doesn't read the call (Mainnet, another contract,
  // arguments that aren't a deposit), the list is its plain contract call window.
  for (const other of [{ chainId: "dusk:1" }, { chainId: "dusk:2", contractId: "ab".repeat(32) }, { chainId: "dusk:2", fnArgs: Uint8Array.from([1, 2, 3]) }]) {
    const plain = await duskCallLines({ ...shotDeposit, ...other, from: ACCOUNT });
    assert.deepEqual(plain[0], { amount: "0.1 DUSK", kind: "head", title: "Contract call" });
    assert.deepEqual(labelsOf(plain), ["From", "Contract", "Deposit", "Method", "Call data", "Network fee", "Total", "From the site, not checked by the wallet"]);
    assert.equal(valueOf(plain, "Call data").note, "Dusk Wallet shows this call as bytes; check the sha256.");
  }
  // A contract the network doesn't name: its ID alone, 6…6.
  const unnamed = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", contractId: "AB".repeat(32), from: ACCOUNT, note: "A contract." });
  assert.deepEqual([valueOf(unnamed, "Contract").name, valueOf(unnamed, "Contract").value, valueOf(unnamed, "Contract").note], [undefined, "ababab…ababab", "A contract."]);
});

test("a proof or claim lists what the withdrawal pays, to whom, and who sent it", async () => {
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
  // As the window leads since wallet#149: what it costs, then the withdrawal it's for.
  assert.deepEqual(prove[0], {
    amount: "0.0506 DUSK",
    kind: "head",
    lead: "Costs up to",
    prefix: "for a 1,008 DUSK withdrawal that pays",
    sub: "Proving moves no DUSK. You claim it once the waiting period ends.",
    tag: "Known DuskEVM bridge call",
    title: "Prove a DuskEVM withdrawal",
    to: "213qXN…V5JJ9Y",
    toFull: PAID,
    where: "on Dusk",
  });
  assert.match(
    walletLines(prove, explorer),
    /<div class="wlt">Prove a DuskEVM withdrawal<\/div><div class="wlto">Costs up to <span class="num">0\.0506 DUSK<\/span><\/div><div class="wlto">for a 1,008 DUSK withdrawal that pays <code class="mono" title="213qXN[^"]+">213qXN…V5JJ9Y<\/code> on Dusk<\/div><div class="wlto">Proving moves no DUSK\. You claim it once the waiting period ends\.<\/div>/u,
  );
  assert.deepEqual(labelsOf(prove), [
    "Pays to", "Amount", "Sent from DuskEVM",
    "Network fee", "Total",
    "Contract", "Method", "Call data",
    "From the site, not checked by the wallet",
  ]);
  assert.equal(valueOf(prove, "Pays to").address, PAID);
  assert.equal(valueOf(prove, "Amount").value, "1,008 DUSK");
  // The sender as the window checksums it.
  assert.equal(valueOf(prove, "Sent from DuskEVM").address, "0x75685f9D88749B583732B40d56fe007cD404b72D");
  // A maximum rounds up past 4 decimals, so it never reads lower than it can be.
  assert.equal(valueOf(prove, "Network fee").value, "up to 0.0506 DUSK");
  assert.equal(valueOf(prove, "Total").value, "up to 0.0506 DUSK");
  assert.deepEqual([valueOf(prove, "Contract").name, valueOf(prove, "Contract").value], ["DuskEVM bridge portal", "14eeb3…3fb1b9"]);
  assert.match(valueOf(prove, "Call data").value, /^\d+ bytes · sha256=[0-9a-f]{12}…[0-9a-f]{8}$/u);

  // Testnet's 10 DUSK withdrawal that credits a contract, claimed.
  const claim = await duskCallLines({ ...portal, fnArgs: portalCall("finalizeWithdrawalTransaction", withdrawalInput(contractCreditLog)), fnName: "finalizeWithdrawalTransaction" });
  assert.deepEqual(
    [claim[0].title, claim[0].prefix, claim[0].to, claim[0].where, claim[0].sub],
    ["Claim a DuskEVM withdrawal", "for a 10 DUSK withdrawal that pays", "ed7176…44a0af", "on Dusk, a contract", "Claiming pays this DUSK to the account above. You pay only the network fee."],
  );
  assert.deepEqual([rowsOf(claim)[0].label, rowsOf(claim)[0].value], ["Pays to contract", "ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af"]);
  // An amount finer than a Lux keeps all 18 decimals.
  assert.equal(withdrawalAmount(10n ** 18n + 1n), "1.000000000000000001 DUSK");

  // A call the window can't read is a plain contract call.
  const plain = await duskCallLines({ ...portal, fnArgs: Uint8Array.from([1, 2, 3]) });
  assert.deepEqual(plain[0], { amount: "", kind: "head", title: "Contract call" });
  assert.deepEqual(labelsOf(plain), ["From", "Contract", "Method", "Call data", "Network fee", "Total", "From the site, not checked by the wallet"]);
  assert.equal(valueOf(plain, "Call data").value, "3 bytes · sha256=039058c6f2c0…011cfb81");
});

test("a transfer to the bridge's account lists Dusk Wallet's bridge window: where it goes, what arrives, then from, to and the recipient", () => {
  const gas = { limit: "2500000", price: "1" };
  const transfer = (cfg, patch = {}) =>
    duskTransferLines({ amountLux: 2_000_000_000n, chainId: cfg.dusk.chainId, from: ACCOUNT, fromName: "alice.dusk", gas, memo: EVM, to: cfg.service.account, ...patch });
  // Mainnet's to BNB Smart Chain, as the window words it (wallet#150).
  const bsc = transfer(mainnet);
  assert.deepEqual(bsc[0], {
    amount: "2 DUSK",
    kind: "head",
    sub: "2 DUSK sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain",
    tag: "Known bridge account",
    title: "Bridge to BNB Smart Chain",
    to: "0xd63b…8df4",
    toFull: EVM,
    where: "on BNB Smart Chain",
  });
  // What everyone sees, as the window says it under the amount, before the fee.
  assert.deepEqual(bsc[1], { kind: "visible", text: "Visible to everyone: amount, the recipient on BNB Smart Chain, and your name alice.dusk." });
  assert.equal(transfer(mainnet, { fromName: "" })[1].text, "Visible to everyone: amount, the recipient on BNB Smart Chain, and your account.");
  assert.deepEqual(labelsOf(bsc), ["Network fee", "Total", "From", "To", "Recipient on BNB Smart Chain"]);
  assert.deepEqual(groupsOf(bsc), ["Network fee", "From"]);
  assert.equal(valueOf(bsc, "Network fee").value, "up to 0.0025 DUSK");
  assert.equal(valueOf(bsc, "Total").value, "up to 2.0025 DUSK");
  assert.deepEqual([valueOf(bsc, "From").value, valueOf(bsc, "From").suffix], ["alice.dusk", "Public"]);
  assert.deepEqual({ ...valueOf(bsc, "To") }, { address: mainnet.service.account, label: "To", network: "dusk", value: "The bridge's account for BNB Smart Chain" });
  assert.deepEqual({ ...valueOf(bsc, "Recipient on BNB Smart Chain") }, { address: EVM, label: "Recipient on BNB Smart Chain", network: "bsc" });
  assert.match(
    walletLines(bsc, { explorer: (network, address) => explorerAddressUrl(mainnet, network, address) }),
    /<div class="wlt">Bridge to BNB Smart Chain<\/div><div class="wlto"><span class="num">2 DUSK<\/span> to <code class="mono" title="0xd63b[^"]+">0xd63b…8df4<\/code> on BNB Smart Chain<\/div><div class="wlto">2 DUSK sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain<\/div><span class="tag">.*Known bridge account<\/span><\/div><p class="note wl-visible">[\s\S]*?<span>Visible to everyone: amount, the recipient on BNB Smart Chain, and your name alice\.dusk\.<\/span><\/p><dl class="wls">/u,
  );
  // Testnet's to Sepolia, which the bridge doesn't pay out on now: the window says nothing arrives.
  const sepolia = transfer(testnet);
  assert.deepEqual([sepolia[0].title, sepolia[0].where, sepolia[0].sub], ["Bridge to Sepolia", "on Sepolia", "2 DUSK sent · 1 DUSK bridge fee · Nothing arrives on Sepolia"]);
  assert.equal(labelsOf(sepolia).at(-1), "Recipient on Sepolia");
  assert.equal(valueOf(sepolia, "To").value, "The bridge's account for Sepolia");
  // Nothing arrives when the fee takes it all, or without an address there in the memo.
  assert.equal(transfer(mainnet, { amountLux: 1_000_000_000n })[0].sub, "1 DUSK sent · 1 DUSK bridge fee · Nothing arrives on BNB Smart Chain");
  for (const memo of ["not an address", EVM.replace("B", "b")]) {
    const unread = transfer(mainnet, { memo });
    assert.equal(unread[0].sub, "2 DUSK sent · 1 DUSK bridge fee · Nothing arrives without a BNB Smart Chain address in the memo");
    assert.equal("to" in unread[0], false);
    assert.deepEqual([valueOf(unread, "Recipient on BNB Smart Chain").value, valueOf(unread, "Recipient on BNB Smart Chain").mono], [memo, true]);
  }
  // An account the wallet doesn't know as the bridge's: its Pay window, the memo last.
  const pay = transfer(mainnet, { to: ACCOUNT });
  assert.deepEqual(pay[0], { amount: "2 DUSK", kind: "head", title: "Pay", to: "21n5nc…fMMLNz", toFull: ACCOUNT });
  assert.equal(pay[1].text, "Visible to everyone: amount, memo, and your name alice.dusk.");
  assert.deepEqual(labelsOf(pay), ["Network fee", "Total", "From", "To", "Memo"]);
  assert.equal(valueOf(pay, "Memo").value, EVM);
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
  assert.equal(model.view.title, "25 DUSK arrived on DuskEVM");
  assert.equal(model.caption, "Arrived Mon 26 Oct 2026, 10:31 CET.");
  assert.deepEqual(model.details.map((row) => row.label), ["You sent", "Network fee", "You received", "From, on Dusk", "To, on DuskEVM", "Dusk transaction", "DuskEVM transaction", "Sent"]);
  // A record: the fee as paid, to the last decimal.
  assert.equal(model.details[1].value, "0.001986599 DUSK");
  const html = receiptPage(model);
  assert.ok(html.includes(`<code class="mono">${"38".repeat(32)}</code>`));
  assert.ok(html.includes(`<code class="mono">0x${"a1".repeat(32)}</code>`));
  assert.ok(html.includes(`<code class="mono">${url}</code>`));
  assert.ok(html.includes(`<code class="mono">${ACCOUNT}</code>`));
  assert.doesNotMatch(html, /balance|now holds/iu);
  assert.ok(!html.includes(TIMES));

  // While pending: how long it takes on this network, and a note only once it's late.
  const waiting = { ...entry, destinationHash: undefined, status: "pending" };
  const pending = receiptModel(waiting, { cfg: testnet, now: entry.sourceAt + 60_000, route: T["duskevm-deposit"], url });
  assert.equal(pending.caption, "Takes ~1 min");
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

test("gas a migration paid is rounded as wallets write it, with the rest on hover", () => {
  const entry = { amountLux: "1000000000", destination: ACCOUNT, feeWei: "47005000752080", hash: `0x${"0d".repeat(32)}`, id: "m", receivedLux: "1000000000", routeId: "ethereum-to-dusk", sender: EVM, status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T.migration, url: "https://bridge.example.org/#/transfer/m" });
  assert.deepEqual(model.details.slice(0, 3).map((row) => [row.label, row.value]), [
    ["You sent", "1 ERC20 DUSK"],
    ["You received", "1 DUSK"],
    ["Network fee", "0.000047 ETH"],
  ]);
  assert.equal(model.details[2].exact, "0.00004700500075208 ETH");
  assert.ok(receiptPage(model).includes('<span class="num" title="0.00004700500075208 ETH">0.000047 ETH</span>'));
  // It says which transactions it counts: the migration alone here.
  assert.equal(model.details[2].detail, "migration");
  assert.ok(!model.details.some((row) => row.label === "Sepolia approval"));
});

test("a migration's network fee counts its approval too, where this browser sent one with it", () => {
  // Nandini's way back: approve 29,106 gas, migrate 42,217, at 1.000000016 gwei.
  const APPROVAL = `0x${"a7".repeat(32)}`;
  const entry = { amountLux: "156301633", approvalFeeWei: "29106000465696", approvalHash: APPROVAL, destination: ACCOUNT, feeWei: "42217000675472", hash: `0x${"0d".repeat(32)}`, id: "m", receivedLux: "156301633", routeId: "ethereum-to-dusk", sender: EVM, status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T.migration, url: "https://bridge.example.org/#/transfer/m" });
  const fee = model.details.find((row) => row.label === "Network fee");
  // Both, as left the wallet: 0.000071323001141168 ETH.
  assert.deepEqual([fee.value, fee.exact, fee.detail], ["0.000071 ETH", "0.000071323001141168 ETH", "approval and migration"]);
  assert.ok(receiptPage(model).includes('<span class="stack"><span class="num" title="0.000071323001141168 ETH">0.000071 ETH</span><span class="small">approval and migration</span></span>'));
  // And the approval, with the migration's own transaction after it.
  const labels = model.details.map((row) => row.label);
  assert.equal(labels.indexOf("Sepolia approval") + 1, labels.indexOf("Sepolia transaction"));
  assert.ok(model.details.find((row) => row.label === "Sepolia approval").html.includes(`<code class="mono">${APPROVAL}</code>`));
  // Before its fee is read, the migration's alone, said as that.
  assert.deepEqual(["value", "detail"].map((key) => receiptModel({ ...entry, approvalFeeWei: undefined }, { cfg: testnet, route: T.migration, url: "x" }).details.find((row) => row.label === "Network fee")[key]), ["0.000042 ETH", "migration"]);
  // Failed on its chain, the gas of both was still spent.
  const failed = receiptModel({ ...entry, receivedLux: undefined, sourceFailed: true, status: "failed" }, { cfg: testnet, route: T.migration, url: "x" });
  assert.deepEqual(failed.details.filter((row) => !row.html).map((row) => [row.label, row.value]), [["Network fee", "0.000071 ETH"]]);
});

test("a receipt on its way offers to tell you when it arrives, and says what happens where that's refused", () => {
  const url = "https://bridge.example.org/#/transfer/n";
  const sent = { amountLux: "25000000000", destination: EVM, hash: "0e".repeat(32), id: "n", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const page = (entry, route, notice) => receiptPage({ ...receiptModel(entry, { cfg: testnet, route, url }), notice });
  const deposit = T["duskevm-deposit"];
  assert.match(page(sent, deposit, "offer"), /<button type="button" class="linkish" data-action="notify-on">Tell me when it arrives<\/button>/u);
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
  assert.equal(receiptModel(ready, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee, "Network fee up to 0.051 DUSK, from your public balance");
  // Known: 50M plus what the withdrawal asks for.
  assert.equal(
    receiptModel({ ...ready, withdrawalGas: "9000000" }, { cfg: testnet, route: T["duskevm-withdrawal"], url }).actionFee,
    "Network fee up to 0.059 DUSK, from your public balance",
  );
});

test("a row in My transfers writes its amount as wallets do, with every digit on hover", () => {
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
  assert.equal(model.view.title, "Sending 0.053082083 DUSK to DuskEVM");
  assert.equal(model.details[0].value, "0.053082083 DUSK");
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
  assert.equal(claim.subline, "Ready to claim since 24 Oct, 02:00 CEST");
  assert.equal(claim.action.kind, "finalize");
  assert.equal(claim.href, `#/transfer/0x${"01".repeat(32)}`);
  const html = activityPanel({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  assert.match(html, /data-action="withdrawal-finalize" data-id="a">Claim<span class="sr-only"> 120 DUSK from DuskEVM to Dusk<\/span>/u);
  assert.match(html, /<h2 class="sec-t">Needs you<\/h2>/u);
});

test("each transfer in My transfers says whom it pays and its transaction, so equal ones are told apart", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  // Discovered from the archive: the DuskEVM recipient in lower case, the hash without 0x.
  const deposit = { amountLux: "500000000", destination: SHOT.toLowerCase(), destinationAt: Date.UTC(2026, 9, 27, 5, 52), hash: `ac6b2f${"9".repeat(52)}16bc24`, id: "d", parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", status: "completed" };
  const withdrawal = { amountLux: "1008000000000", destination: ACCOUNT, hash: `0x04a8a8${"7".repeat(52)}1b3213`, id: "w", parties: [ACCOUNT], routeId: "dusk-evm-to-dusk", stage: "ready_to_prove", status: "pending" };
  const model = transfersModel([deposit, withdrawal], { account: ACCOUNT, accounts: [ACCOUNT], cfg: testnet, locale: "en-GB", name: "alice.dusk", now: Date.UTC(2026, 9, 28), routeOf, timeZone: "Europe/Amsterdam" });
  const [done] = model.groups.done;
  // The address with its checksum's capitals, as the wallet writes it.
  assert.deepEqual([done.to, done.hash], [{ address: "0x96BA…893e" }, "ac6b2f…16bc24"]);
  // Your own account by its .dusk name.
  // An EVM transaction as an EVM address is cut: 0x and 4 + 4.
  assert.deepEqual([model.groups.needs[0].to, model.groups.needs[0].hash], [{ name: "alice.dusk" }, "0x04a8…3213"]);
  const html = activityPanel({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  assert.match(html, /<div class="t2">Arrived Yesterday, 06:52 CET<\/div><div class="t3">To <code class="mono">0x96BA…893e<\/code> · <code class="mono">ac6b2f…16bc24<\/code><\/div>/u);
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
  // The EVM address with its checksum's capitals; on a phone, its tail goes: "0x96BA…".
  assert.match(top, /<span class="av">.*<\/span><code class="mono">0x96BA…<span class="tail">893e<\/span><\/code><\/button>/u);
  assert.match(top, /<code class="mono">21n5nc…<span class="tail">fMMLNz<\/span><\/code><\/button>/u);
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
  // A phone shows the labels, without their tails, not the marks alone.
  assert.match(phone, /\.hdr-r \.wpill \.tail \{ display: none; \}/u);
  assert.doesNotMatch(phone, /\.hdr-r \.wpill > :not\(\.av\) \{ display: none; \}/u);
});

test("the Contracts sheet lists every address in full, per route, and names no one as running it", () => {
  const groups = contractGroups(testnet);
  assert.deepEqual(groups.map((group) => group.title), ["Networks", "Sepolia ↔ Dusk", "Dusk ↔ DuskEVM", "Used to read Dusk"]);
  // The Sepolia routes are listed, as not running.
  assert.equal(groups[1].note, "Not running on testnet right now.");
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
  ]) {
    assert.ok(html.includes(`<code class="mono">${value}</code>`), value);
    assert.ok(html.includes(`data-copy="${value}"`), value);
  }
  assert.ok(html.includes(`https://explorer.testnet.dusk.network/accounts/?key=${testnet.service.account}`));
  // The Terms of use and Privacy policy, and nothing more: no operator, and no contract said to hold or keep DUSK.
  assert.match(
    html,
    /<p class="about-links"><a href="https:\/\/dusk\.network\/terms-of-use" target="_blank" rel="noreferrer">Terms of use<\/a><span class="sep" aria-hidden="true">·<\/span><a href="https:\/\/dusk\.network\/privacy-policy" target="_blank" rel="noreferrer">Privacy policy<\/a><\/p>/u,
  );
  assert.doesNotMatch(html, /Operated by|Keeps the|no function to send|holds the DUSK/u);
  assert.equal(groups[1].rows.find((row) => row.label === "Migration contract").note, "");
  assert.equal(groups[2].rows.find((row) => row.label === "Bridge contract on Dusk").note, "Takes deposits.");
  assert.match(html, /<p class="small t2 gnote">Not running on testnet right now\.<\/p>/u);
  assert.ok(!html.includes(TIMES));

  // Mainnet: BSC both ways, its account paying out migrations too; Ethereum one way, with its payer.
  const main = contractGroups(mainnet);
  assert.deepEqual(main.map((group) => group.title), ["Networks", "BNB Smart Chain ↔ Dusk", "Ethereum → Dusk", "Used to read Dusk"]);
  assert.deepEqual(main[1].rows.map((row) => row.label), ["BEP20 DUSK", "Migration contract", "Bridge account on Dusk", "Pays out from"]);
  // The address the network's file says pays the route out, linked on BscScan.
  assert.deepEqual([main[1].rows[3].value, main[1].rows[3].href], [mainnet.service.payoutAddress, `https://bscscan.com/address/${mainnet.service.payoutAddress}`]);
  assert.match(main[1].rows[2].note, /It also pays out what comes from BNB Smart Chain\.$/u);
  assert.deepEqual(main[2].rows.map((row) => [row.label, row.value]), [
    ["ERC20 DUSK", mainnet.evmNetworks.ethereum.tokenContract],
    ["Migration contract", mainnet.evmNetworks.ethereum.migrationContract],
    ["Pays out on Dusk", mainnet.evmNetworks.ethereum.payoutAccount],
  ]);

  // No route names who runs it, whatever a deployment sets.
  const operated = profile("mainnet", { VITE_SERVICE_OPERATOR: "Example B.V." });
  assert.ok(contractGroups(operated).every((group) => !("operator" in group)));
  assert.doesNotMatch(contractsSheet({ badge: "Mainnet", groups: contractGroups(operated) }), /Operated by|Example B\.V\./u);
  assert.deepEqual(contractGroups(mainnet)[0].rows[1], { label: "DuskEVM", muted: true, value: "not on Mainnet yet" });
  assert.match(networkSheet({ badge: "Mainnet", isTestnet: false, networks: contractGroups(mainnet)[0].rows, otherName: "Testnet", otherSite: "" }), /Real DUSK\. Testnet has its own bridge\./u);
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
  assert.match(page, /<p class="recip">to your MetaMask <b class="mono">0xd63b…8df4<\/b> · <button type="button" class="linkish" data-action="recipient-edit">Change<\/button><\/p>/u);
  // The route row, one line until it's opened: steps, fees, what's public.
  assert.match(page, /<summary>.*<span>~1 min · fee up to 0\.005 DUSK<\/span>/u);
  assert.match(page, /<p class="pubnote"><b>Public on Dusk and DuskEVM, and linked:<\/b> your Dusk account wallet-both\.dusk \(21n5nc…fMMLNz\), 0xd63b…8df4 and the amount\.<\/p>/u);
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
        { disabled: "No route from DuskEVM", id: "ethereum", name: "Sepolia" },
        { id: "dusk", name: "Dusk", note: "≈ 7 days, three steps · up to 0.051 DUSK a step on Dusk", selected: true },
        { disabled: "It's where it comes from", id: "dusk-evm", name: "DuskEVM" },
      ],
    }),
  );
  assert.match(page, /<div class="netmenu" role="listbox" aria-label="Where it goes"><p class="netmenu-t">Where it goes<\/p>/u);
  assert.match(page, /data-net="ethereum" aria-selected="false" aria-disabled="true">.*<span class="nm">Sepolia<\/span><span class="sb">No route from DuskEVM<\/span>/u);
  assert.match(page, /data-net="dusk" aria-selected="true">.*<span class="sb">≈ 7 days, three steps/u);
  assert.match(page, /data-side="to" aria-haspopup="listbox" aria-expanded="true"/u);
});
test("a proof's review says it moves no DUSK and what it costs; a claim, where the DUSK goes", () => {
  const amountLux = 1_008n * 10n ** 9n;
  const other = { destination: testnet.service.account };
  // Paying another account than Dusk Wallet's says so, by the wallet's .dusk name.
  const prove = actionLead("prove", other, { account: ACCOUNT, amountLux, maturity: 604_800, maxLux: 51_000_000n, name: "alice.dusk" });
  assert.deepEqual(prove, {
    amount: "0.051",
    label: "Proving costs up to",
    line: "No DUSK moves now. Claim 7 days after you prove.",
    notYours: "This withdrawal pays 25z9o6…5Etftt, not alice.dusk.",
  });
  // Once the request is ready, the date a proof made now can be claimed from: exact against a resolved game.
  const when = (ms) => formatDateTime(ms, { locale: "en-GB", now: Date.UTC(2026, 9, 28), timeZone: "Europe/Amsterdam" });
  const at = Date.UTC(2026, 10, 9, 2, 20);
  assert.equal(actionLead("prove", other, { claim: { at, exact: true }, maturity: 604_800, maxLux: 1n, when }).line, "No DUSK moves now. If you prove now, you can claim from 9 Nov, 03:20 CET.");
  assert.equal(actionLead("prove", other, { claim: { at, exact: false }, maturity: 604_800, maxLux: 1n, when }).line, "No DUSK moves now. If you prove now, you can claim from about 9 Nov, 03:20 CET.");
  const claim = actionLead("finalize", { destination: ACCOUNT }, { account: ACCOUNT, amountLux, maxLux: 51_000_000n });
  assert.deepEqual(claim, { amount: "1,008", chain: "dusk", label: "You claim", line: "To 21n5nc…fMMLNz on Dusk · costs up to 0.051 DUSK", notYours: "" });
  assert.equal(
    actionLead("finalize", other, { account: ACCOUNT, amountLux, maxLux: 1n }).notYours,
    "This withdrawal pays 25z9o6…5Etftt, not your connected Dusk account.",
  );

  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Prove on Dusk", feeRows: [], lead: prove,
    privacy: "x", steps: [], sub: "", walletCheckName: "Dusk Wallet",
  });
  assert.match(sheet, /<div class="k">Proving costs up to<\/div><div class="v num">0\.051<span class="u">DUSK<\/span>/u);
  // A warning before the steps, not a line among them.
  assert.match(sheet, /<div class="group pad warn-box" role="note"><div class="note">.*<b>Another account gets this DUSK\.<\/b> This withdrawal pays 25z9o6…5Etftt, not alice\.dusk\./u);
  assert.ok(sheet.indexOf("warn-box") < sheet.indexOf('class="group kvs"'));
  assert.doesNotMatch(sheet, /You send|You receive/u);
});

test("a review says what becomes public right under what moves, before the checks and the steps", () => {
  const privacy = "Public on Dusk and Sepolia, and linked: your Dusk account alice.dusk (qxwSid…kQ2Bgr), 0x7568…b72D and the amount.";
  const at = (sheet, part) => sheet.indexOf(part);
  // A transfer: under You send and You receive, above the checks, the fees and the wallet's lines.
  const send = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [{ html: "You have <b>1,480.905 DUSK</b>", ok: true }], confirmLabel: "Send 2 DUSK", feeRows: [{ key: "fee", label: "Network fee", value: "up to 0.0025 DUSK" }],
    notYours: "This pays bob.dusk, not alice.dusk.", privacy, receive: { amount: "1", chain: "ethereum", unit: "ERC20 DUSK", where: "Sepolia" },
    send: { amount: "2", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, lines: [], title: "Send from Dusk", walletName: "Dusk Wallet", what: "", when: "Now" }], sub: "", walletCheckName: "Dusk Wallet",
  });
  const order = ["You receive", "Public on Dusk and Sepolia, and linked:", "warn-box", 'class="ck"', 'class="group kvs"', "will show"].map((part) => at(send, part));
  assert.ok(order.every((index, i) => index > (order[i - 1] ?? -1)), JSON.stringify(order));
  assert.equal(send.match(/Public on Dusk/gu).length, 1);
  // A proof: under what it costs.
  const prove = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Prove on Dusk", feeRows: [],
    lead: { amount: "0.051", label: "Proving costs up to", line: "No DUSK moves now.", notYours: "" }, privacy, steps: [], sub: "", walletCheckName: "Dusk Wallet",
  });
  assert.ok(at(prove, "Proving costs up to") < at(prove, "Public on Dusk") && at(prove, "Public on Dusk") < at(prove, 'class="group kvs"'));
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
  assert.match(dusk, /<a href="https:\/\/dusk\.network\/terms-of-use" target="_blank" rel="noreferrer">Terms of use<\/a><a href="https:\/\/dusk\.network\/privacy-policy" target="_blank" rel="noreferrer">Privacy policy<\/a><\/nav><\/footer>/u);
  assert.doesNotMatch(dusk, /Operated by|run-by|Example B\.V\.|How the bridge works|support/iu);
});

test("the bridge screen and My transfers each have a page heading", () => {
  assert.match(cardPage(cardVmFor()), /<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Bridge DUSK<\/h1>/u);
  assert.match(cardPage({ activity: "", needsCount: 0, tab: "activity" }), /<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">My transfers<\/h1>/u);
  // The entry line under the card, after it.
  const page = cardPage(cardVmFor({ entry: [{ href: "#/move/ethereum-to-dusk", name: "Ethereum" }] }));
  assert.ok(page.indexOf('<p class="entry">') > page.indexOf('data-region="cta"'));
});

test("a proof's review says the account that proves becomes public too", () => {
  assert.equal(
    actionPrivacy("prove", "The amount is public.", { account: ACCOUNT, name: "alice.dusk" }),
    "The amount is public. So is your Dusk account alice.dusk, as the one that proves it.",
  );
  assert.match(actionPrivacy("finalize", "x", { account: ACCOUNT }), / So is your Dusk account 21n5nc…fMMLNz, as the one that claims it\.$/u);
  assert.match(actionPrivacy("prove", "x"), / So is your Dusk account, as the one that proves it\.$/u);
});

test("a withdrawal claimed outside this browser reads as claimed", () => {
  const entry = { amountLux: "1000000000", destination: ACCOUNT, hash: `0x${"34".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", sender: EVM, stage: "finalized", status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T["duskevm-withdrawal"], url: "https://bridge.example/#/transfer/x" });
  assert.match(model.details.find((row) => row.label === "Claim on Dusk").html, />Claimed</u);
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
  // A receipt names your own account by it, any other by its short code.
  const entry = { amountLux: "100000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const url = "https://bridge.example/#/transfer/x";
  assert.match(receiptModel(entry, { cfg: testnet, own: { account: ACCOUNT, name: "alice.dusk" }, route: T["duskevm-deposit"], url }).fromTo, /^From alice\.dusk on Dusk/u);
  assert.match(receiptModel(entry, { cfg: testnet, own: { account: "someone else", name: "bob.dusk" }, route: T["duskevm-deposit"], url }).fromTo, /^From <code class="mono">21n5nc…fMMLNz<\/code> on Dusk/u);
});

test("a typed .dusk name shows the account it points to, and wrong capitals offer the fix", () => {
  const to = { ...cardVmFor().to, editing: true, input: "alice.dusk", label: "Recipient on Dusk", net: { id: "dusk", name: "Dusk" }, placeholder: "A Dusk account or .dusk name", resolved: { address: ACCOUNT, name: "alice.dusk" } };
  const vm = cardVmFor({ to });
  const page = cardPage(vm);
  // The field wraps, so the whole address shows on a phone.
  assert.match(page, /<textarea id="recipient" name="recipient" class="mono-input wrap-input" rows="2"[^>]*>alice\.dusk<\/textarea>/u);
  assert.ok(page.includes(`alice.dusk points to <code class="mono wrap">${ACCOUNT}</code>`));
  const note = (patch) => cardRegions({ ...vm, to: { ...to, resolved: null, ...patch } })["recipient-note"];
  assert.equal(note({ looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.match(note({ error: "x", fix: EVM }), /<button type="button" class="linkish" data-action="recipient-fix">If every character is right, fix the capitals<\/button>/u);
  assert.equal(note({}), "");
});
test("About this page names, in one line, the servers the page reads from", async () => {
  const line = serversLine(testnet);
  assert.equal(
    line,
    "This page reads from testnet.nodes.dusk.network (the Dusk node and its archive), rpc.testnet.evm.dusk.network (DuskEVM), ethereum-sepolia-rpc.publicnode.com (Sepolia) and testnet.dusk.domains (for .dusk names).",
  );
  // In the About sheet the footer opens, with the contracts.
  assert.match(footer({ links: {}, officialSite: "" }), /<button type="button" class="linkish" data-action="open-about" aria-haspopup="dialog">About this page<\/button>/u);
  const sheet = contractsSheet({ badge: "Testnet", groups: contractGroups(testnet), servers: line });
  assert.match(sheet, /<h3 class="gt">Servers<\/h3><p class="card about-servers">This page reads from testnet\.nodes\.dusk\.network/u);
  assert.ok(sheet.indexOf("Servers") < sheet.indexOf("Bridge contract on Dusk"));
  // The names' host is the one each network's pinned release fetches its lens driver from.
  for (const cfg of [testnet, mainnet]) assert.ok(serversLine(cfg).includes(`${new URL(releaseFor(cfg.dusk.chainId).artifactBaseUrl).host} (for .dusk names)`));
});

test("My transfers can follow a Dusk account without a wallet, and stop", () => {
  const page = (watch) => activityPanel({ empty: "e", groups: {}, lede: "l", syncText: "", watch });
  const form = page({ busy: false, error: "", following: "", input: "" });
  assert.match(form, /<form class="group pad watch" data-form="watch">\s*<label for="watch" class="l1">Follow a Dusk account<\/label>/u);
  assert.match(form, /placeholder="A Dusk account or \.dusk name"/u);
  assert.match(page({ busy: false, error: "bob.dusk isn't an active .dusk name.", following: "", input: "bob.dusk" }), /role="alert">bob\.dusk isn&#039;t an active \.dusk name\.<\/p>/u);
  const following = page({ following: "alice.dusk" });
  assert.match(following, /Following alice\.dusk\. <button type="button" class="linkish" data-action="unwatch">Stop following<\/button>/u);
  assert.doesNotMatch(following, /data-form="watch"/u);
  // With Dusk Wallet connected, there's nothing to follow.
  assert.doesNotMatch(page(null), /Follow a Dusk account|Following/u);
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
  // Before the withdrawal exists: the card's route row and its quote.
  assert.match(routeLine(route, testnet, { gasPrice }), /· up to 0\.102 DUSK a step on Dusk$/u);
  const form = buildQuote(route, "1", { balance: null, cfg: testnet, gasPrice });
  assert.equal(form.rows.find((row) => row.key === "fee-dusk").value, "up to 0.102 DUSK a step");
  // Once it exists, with its own gas: the card, the receipt, and the review's request.
  const entry = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: route.id, sourceAt: Date.UTC(2026, 9, 1), stage: "ready_to_prove", status: "pending", withdrawalGas: withdrawalGas.toString() };
  assert.equal(receiptModel(entry, { cfg: testnet, gasPrice, route, url: "https://bridge.example/#/transfer/w" }).actionFee, "Network fee up to 0.102 DUSK, from your public balance");
  const request = withdrawalGasLimit(withdrawalGas) * gasPrice;
  assert.equal(request, withdrawalStepMax({ gasPrice, withdrawalGas }));
  assert.equal(actionLead("prove", entry, { maxLux: request }).amount, "0.102");
  assert.match(actionLead("finalize", entry, { maxLux: request }).line, /costs up to 0\.102 DUSK$/u);
});

test("the pages say what's public and what to do, without explaining what they already show", () => {
  const route = T["duskevm-deposit"];
  const entry = { amountLux: "25000000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: route.id, sender: ACCOUNT, sourceAt: Date.UTC(2026, 9, 26, 9, 31), status: "pending" };
  const receipt = receiptPage({ ...receiptModel(entry, { cfg: testnet, now: entry.sourceAt + 60_000, route, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  const review = reviewSheet({ canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Send", feeRows: [], privacy: cardVmFor().privacy, receive: { amount: "25", chain: "dusk-evm", unit: "DUSK", where: "DuskEVM" }, send: { amount: "25", chain: "dusk", unit: "DUSK", where: "Dusk" }, steps: [{ current: true, lines: [], title: "Send from Dusk", walletName: "Dusk Wallet", what: "", when: "Now" }], sub: "Dusk to DuskEVM", walletCheckName: "Dusk Wallet" });
  const card = cardPage(cardVmFor({ routeOpen: true }));
  const about = contractsSheet({ badge: "Testnet", groups: contractGroups(testnet), servers: serversLine(testnet) });
  for (const page of [receipt, review, card, about]) {
    // Reassurance and lines that repeat the page are gone.
    assert.doesNotMatch(page, /doesn't let anyone move|public balances only|You can close this page|public on both networks anyway|Keep the receipt link|holds the DUSK while|safety window|First time\?|What it reads from/u);
  }
  // What's public, what to check, and what sharing shows stay, once each.
  assert.equal(review.match(/Public on Dusk and DuskEVM, and linked:/gu)?.length, 1);
  assert.match(review, /Check each line against Dusk Wallet\./u);
  assert.equal(receipt.match(/Anyone with the link can see this transfer\./gu)?.length, 1);
  // The deposit's step says nothing the hero, the caption or the details don't.
  assert.deepEqual(receiptModel(entry, { cfg: testnet, now: entry.sourceAt + 60_000, route, url: "x" }).view.steps.map((step) => step.detail), ["", "", ""]);
});

test("a Dusk recipient handed over in the link reads as Paying, with a way to change it", () => {
  const line = (route, options) => recipientLine(route, { destination: ACCOUNT, ...options });
  assert.equal(line(T.migration, { handedOver: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>');
  // Even when it's the connected account; another one is said.
  assert.equal(line(T["duskevm-withdrawal"], { connected: true, duskName: "alice.dusk", handedOver: true, own: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>');
  assert.equal(line(T.migration, { connected: true, handedOver: true }), 'Paying <b class="mono">21n5nc…fMMLNz</b>, not your connected account');
  // Otherwise as before.
  assert.equal(line(T.migration, {}), 'to <b class="mono">21n5nc…fMMLNz</b>');
  assert.equal(line(T.migration, { duskName: "alice.dusk", own: true }), "to your account <b>alice.dusk</b>");
  assert.equal(line(T.migration, { resolved: { address: ACCOUNT, name: "bob.dusk" } }), 'to <b>bob.dusk</b> (21n5nc…fMMLNz)');
  assert.doesNotMatch(recipientLine(T.service ?? { to: { kind: "evm" } }, { destination: "0x5a3D8e1B7c2f4A6b9E0d1C3f5a7B9c2D4e6F8a01", own: true, walletName: "your EVM wallet" }), /your your/u);
  assert.equal(recipientLine(T.migration, {}), "Connect Dusk Wallet, or add a Dusk account");
  assert.equal(recipientLine(T["duskevm-deposit"], { destination: EVM, own: true, walletName: "MetaMask" }), 'to your MetaMask <b class="mono">0xd63b…8df4</b>');
  // The card: the line, then Change.
  const page = cardPage(cardVmFor({ to: { ...cardVmFor().to, label: "Recipient on Dusk", line: line(T.migration, { handedOver: true }), net: { id: "dusk", name: "Dusk" } } }));
  assert.match(page, /<p class="recip">Paying <b class="mono">21n5nc…fMMLNz<\/b> · <button type="button" class="linkish" data-action="recipient-edit">Change<\/button><\/p>/u);
});

test("with more than one Dusk wallet to choose from, each is offered by name, and so is one left alone", () => {
  const two = walletsSheet({ wallets: [{ id: "a", name: "Dusk Wallet", rdns: "network.dusk.wallet" }, { id: "b<", name: "Piewallet", rdns: "com.piewallet" }] });
  assert.match(two, /<h2 id="sheet-title">Choose a wallet<\/h2><p class="sub">More than one Dusk wallet is installed\. Choose the one to connect\.<\/p>/u);
  assert.deepEqual([...two.matchAll(/data-action="choose-dusk" data-wallet="([^"]+)">.*?<span class="nm">([^<]+)<\/span><span class="sb">([^<]+)<\/span>/gu)].map((match) => match.slice(1)), [
    ["a", "Dusk Wallet", "network.dusk.wallet"],
    ["b&lt;", "Piewallet", "com.piewallet"],
  ]);
  // The wallet chosen here before is gone: the one left is offered, not taken for you.
  const one = walletsSheet({ wallets: [{ id: "a", name: "Dusk Wallet", rdns: "network.dusk.wallet" }] });
  assert.match(one, /<p class="sub">The wallet you used here before isn't installed\. Choose the one to connect\.<\/p>/u);
  assert.equal([...one.matchAll(/data-action="choose-dusk"/gu)].length, 1);
});
