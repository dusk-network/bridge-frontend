import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { bridgeTasks } from "./names.js";
import { actionLead, actionPrivacy, availableLine, landingTasks, pricedReview, receiptModel, reviewChecks, transfersModel } from "./page-models.js";
import { buildQuote, withdrawalStepMax } from "./quote.js";
import { withdrawalGasLimit } from "./gas.js";
import { transferView } from "./transfer-view.js";
import { contractsSheet, footer, formPage, formRegions, header, landing, networkSheet, receiptPage, reviewSheet, transfersPage, walletLines } from "./views.js";
import { encodeDepositArgs } from "./dusk-deposit.js";
import { chainMark, pairMark } from "./icons.js";
import { approveLines, duskCallLines, duskTransferLines, middle, migrateLines, walletFee } from "./wallet-lines.js";

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
const EVM = "0xd63bB1959D64E236f63DDC62c37248708ffE8df4";
const explorer = { explorer: (network, address) => explorerAddressUrl(testnet, network, address) };
// The lookalike that must never appear where addresses are checked.
const TIMES = "×";

test("the start page gives each task its time and cost, and on phones whether it works there", () => {
  const tasks = landingTasks(testnet, bridgeTasks(testnet, buildRoutes(testnet)), { phone: true });
  assert.deepEqual(
    tasks.map((task) => [task.title, task.meta, task.phoneTag?.text]),
    [
      ["Move old DUSK to Dusk", "About an hour · two wallet steps · a network fee in ETH", "Works on this phone"],
      ["Move DUSK to DuskEVM", "Usually arrives within a minute · network fee up to 0.005 DUSK", "Needs a computer"],
      // A claim's limit is 50M plus the withdrawal's own gas, so the most a step costs is above 0.05.
      ["Move DUSK from DuskEVM to Dusk", "Three steps over about 7 days · up to 0.051 DUSK a step on Dusk", "Step 1 works here. Prove and claim need a computer."],
      ["Send DUSK to Ethereum (Sepolia)", "Usually within an hour · 1 DUSK bridge fee, taken from the amount", "Needs a computer"],
    ],
  );
  // With Dusk Wallet installed, the phone notes go.
  assert.ok(landingTasks(testnet, bridgeTasks(testnet, buildRoutes(testnet)), { duskInstalled: true, phone: true }).every((task) => !task.phoneTag));

  const main = landingTasks(mainnet, bridgeTasks(mainnet, buildRoutes(mainnet)));
  assert.deepEqual(main.map((task) => task.title), ["Move old DUSK to Dusk", "Move DUSK to DuskEVM", "Send DUSK to BNB Smart Chain"]);
  assert.equal(main[1].unavailable, "DuskEVM · not on Mainnet yet");
  assert.match(main[0].meta, /a network fee in ETH or BNB$/u);
  const html = landing({ canShare: false, dusk: { getUrl: "https://docs.dusk.network/use/wallets/#dusk-wallet", state: "missing" }, evm: { state: "connect" }, pageUrl: "", phone: false, tasks: main });
  assert.match(html, /DuskEVM · not on Mainnet yet/u);
  assert.doesNotMatch(html, /href="#\/move\/to-duskevm"/u);
});

test("the review checks the facts first, then lists the wallet's lines with full addresses", async () => {
  const route = T.migration;
  const lux = 1_000_000_000_000n;
  const reads = { migration: { allowanceWei: 0n, balanceWei: 2_500n * 10n ** 18n, gasCoinWei: 21_300_000_000_000_000n, gasPriceWei: 2_000_000_000n } };
  const quote = buildQuote(route, "1000", { allowanceWei: 0n, balance: reads.migration.balanceWei, cfg: testnet, evmGas: { approve: 46_000n, migrate: 70_000n, priceWei: 2_000_000_000n } });
  const checks = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote, reads });
  assert.deepEqual(checks.map((check) => check.ok), [true, true, true, true]);
  assert.match(checks[0].html, /2,500 old DUSK<\/b> at <code class="mono">0xd63b…8df4<\/code> on Ethereum \(Sepolia\)/u);
  assert.match(checks[1].html, /0\.0213 ETH<\/b> for the network fee, about 0\.00023 ETH needed for both steps/u);
  // Not enough ETH is caught before the wallet opens.
  const poor = reviewChecks(route, { cfg: testnet, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { migration: { ...reads.migration, gasCoinWei: 1n } } });
  assert.equal(poor[1].ok, false);

  const approve = approveLines({ amountLux: lux, cfg: testnet, fee: 92_000_000_000_000n, network: "ethereum" });
  const migrate = migrateLines({ amountLux: lux, cfg: testnet, duskAccount: ACCOUNT, fee: null, network: "ethereum" });
  assert.deepEqual(approve.map((line) => line.label), ["Network", "Token", "Spender", "Spending cap", "Network fee"]);
  assert.equal(approve[0].value, "Ethereum (Sepolia), chain 11155111");
  assert.equal(approve[3].value, "1,000 old DUSK");
  const amountLine = migrate.find((line) => line.label === "amount");
  assert.equal(amountLine.value, "1000000000000000000000");
  assert.match(amountLine.note, /^= 1,000 DUSK\./u);
  assert.equal(migrate.find((line) => line.label === "Estimated change").value, "−1,000 old DUSK");
  assert.match(migrate.find((line) => line.label === "mainnetDuskAddress").note, /^Your Dusk account that receives the DUSK/u);

  const sheet = reviewSheet({
    canConfirm: true,
    cfgLinks: explorer,
    checks,
    confirmLabel: "Approve 1,000 old DUSK in MetaMask",
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    privacy: "x",
    receive: { amount: "1,000", chain: "dusk", unit: "DUSK", where: "Dusk" },
    send: { amount: "1,000", chain: "ethereum", unit: "old DUSK", where: "Ethereum (Sepolia)" },
    steps: [
      { current: true, lines: approve, title: "Approve exactly 1,000 old DUSK", walletName: "MetaMask", what: "", when: "Now" },
      { current: false, lines: migrate, title: "Migrate", walletName: "MetaMask", what: "", when: "After step 1" },
    ],
    sub: "",
    walletCheckName: "MetaMask",
  });
  // Every address in full, with a copy button and an explorer link: never 4 + 4 alone.
  for (const address of [testnet.evmNetworks.ethereum.migrationContract, testnet.evmNetworks.ethereum.tokenContract, ACCOUNT]) {
    assert.ok(sheet.includes(`<code class="mono">${address}</code>`), address);
    assert.ok(sheet.includes(`data-copy="${address}"`), address);
  }
  assert.ok(sheet.includes(`https://sepolia.etherscan.io/address/${testnet.evmNetworks.ethereum.migrationContract}`));
  assert.match(sheet, />Cancel<\/button><button type="button" class="btn pri" data-action="confirm" >Approve 1,000 old DUSK in MetaMask</u);
  assert.ok(!sheet.includes(TIMES));
});

// Dusk Wallet's approval windows (ux/extension-approvals): each line's label
// and value as the window prints it, group by group.
const rowsOf = (lines) => lines.filter((line) => line.kind !== "head");
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
    "Function", "Call data", "From the site, not checked by the wallet",
  ]);
  assert.deepEqual(groupsOf(lines), ["Network fee", "Contract"]);
  assert.deepEqual(foldOf(lines), ["Function", "Call data", "From the site, not checked by the wallet"]);
  assert.equal(valueOf(lines, "DuskEVM recipient").address, SHOT);
  assert.equal(valueOf(lines, "Amount").value, "0.1 DUSK");
  assert.deepEqual([valueOf(lines, "From").value, valueOf(lines, "From").suffix], ["21n5nc…fMMLNz", "Public"]);
  assert.equal(valueOf(lines, "Network fee").value, "up to 0.005 DUSK");
  assert.equal(valueOf(lines, "Total").value, "up to 0.105 DUSK");
  assert.deepEqual([valueOf(lines, "Contract").value, valueOf(lines, "Contract").full], ["0x2257e5…eea1b31d", `0x${DUSKEVM.VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID}`]);
  assert.equal(valueOf(lines, "Call data").value, "40 bytes · sha256=2f64b19f5ac0…731c7c2a");
  assert.equal(valueOf(lines, "Call data").note, "Older Dusk Wallet versions show the call as bytes; check the sha256.");
  assert.equal(valueOf(lines, "Deposit").value, "0.1 DUSK");

  const view = walletLines(lines, explorer);
  assert.match(view, /<div class="wlhd"><div class="wlt">Bridge to DuskEVM<\/div><div class="wlto"><span class="num">0\.1 DUSK<\/span> to <code class="mono" title="0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e">0x96BA…893e<\/code> on DuskEVM<\/div><span class="tag">/u);
  assert.ok(view.includes(`<code class="mono">${SHOT}</code>`));
  assert.match(view, /<div class="wl gap"><dt>Network fee<\/dt>/u);
  assert.match(view, /<span class="mono wrap" title="21n5nc[^"]+">21n5nc…fMMLNz<\/span><span class="t2"> · Public<\/span>/u);
  // The function, the hash and the site's words sit under Details, as in the window.
  assert.match(view, /<\/dl><details class="wl-more"><summary>Details<\/summary><dl class="wls"><div class="wl"><dt>Function<\/dt>/u);
  assert.ok(view.indexOf("sha256=") > view.indexOf("<summary>Details</summary>"));
  // With the .dusk name Dusk Wallet sent, From reads as the window does.
  const named = await duskCallLines({ ...shotDeposit, chainId: "dusk:2", from: ACCOUNT, fromName: "alice.dusk" });
  assert.deepEqual([valueOf(named, "From").value, valueOf(named, "From").suffix, valueOf(named, "From").note], ["alice.dusk", "Public", undefined]);

  // Where Dusk Wallet doesn't read the call (Mainnet, another contract,
  // arguments that aren't a deposit), the list is its plain contract call window.
  for (const other of [{ chainId: "dusk:1" }, { chainId: "dusk:2", contractId: "ab".repeat(32) }, { chainId: "dusk:2", fnArgs: Uint8Array.from([1, 2, 3]) }]) {
    const plain = await duskCallLines({ ...shotDeposit, ...other, from: ACCOUNT });
    assert.deepEqual(plain[0], { amount: "0.1 DUSK", kind: "head", title: "Contract call" });
    assert.deepEqual(labelsOf(plain), ["From", "Contract", "Deposit", "Function", "Call data", "Network fee", "Total", "From the site, not checked by the wallet"]);
    assert.equal(valueOf(plain, "Call data").note, "Dusk Wallet shows this call as bytes; check the sha256.");
  }
});

test("a proof or claim lists what the withdrawal pays, to whom, and who sent it", async () => {
  const withdrawal = { amountWei: 1_008n * 10n ** 18n, from: "0x7568a1b3cc6b2f2e3e8fdd2fa77e0c5a0dbcb72d", recipient: ACCOUNT, value: 1_008n * 10n ** 18n };
  const portal = {
    chainId: "dusk:2",
    contractId: DUSKEVM.VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID,
    display: { label: "Prove a DuskEVM withdrawal" },
    fnArgs: Uint8Array.from([1, 2, 3]),
    fnName: "proveWithdrawalTransaction",
    from: ACCOUNT,
    gas: { limit: "50519542", price: "1" },
    withdrawal,
  };
  const prove = await duskCallLines(portal);
  assert.deepEqual(prove[0], {
    amount: "1,008 DUSK",
    kind: "head",
    tag: "Known DuskEVM bridge call",
    title: "Prove a DuskEVM withdrawal",
    to: "21n5nc…fMMLNz",
    toFull: ACCOUNT,
    where: "on Dusk",
  });
  assert.deepEqual(labelsOf(prove), [
    "Pays to", "Amount", "Sent from DuskEVM",
    "Network fee", "Total",
    "Contract", "Function", "Call data",
    "From the site, not checked by the wallet",
  ]);
  assert.equal(valueOf(prove, "Pays to").address, ACCOUNT);
  assert.equal(valueOf(prove, "Amount").value, "1,008 DUSK");
  // The sender as the window checksums it.
  assert.equal(valueOf(prove, "Sent from DuskEVM").address, "0x7568A1b3Cc6B2f2E3e8FdD2FA77e0C5A0dBCb72d");
  // A maximum rounds up past 4 decimals, so it never reads lower than it can be.
  assert.equal(valueOf(prove, "Network fee").value, "up to 0.0506 DUSK");
  assert.equal(valueOf(prove, "Total").value, "up to 0.0506 DUSK");
  assert.equal(valueOf(prove, "Contract").value, "0x14eeb3…a93fb1b9");
  assert.equal(valueOf(prove, "Call data").value, "3 bytes · sha256=039058c6f2c0…011cfb81");

  // A claim for a contract, and an amount finer than a Lux, read as the window reads them.
  const contractId = `21a5cb174bbd7dd0ae${"1".repeat(46)}`;
  const claim = await duskCallLines({
    ...portal,
    fnName: "finalizeWithdrawalTransaction",
    withdrawal: { ...withdrawal, amountWei: 10n ** 18n + 1n, recipient: contractId, value: 10n ** 18n + 1n },
  });
  assert.deepEqual([claim[0].title, claim[0].amount, claim[0].to, claim[0].where], ["Claim a DuskEVM withdrawal", "1.000000000000000001 DUSK", "21a5cb…111111", "on Dusk, a contract"]);
  assert.deepEqual([rowsOf(claim)[0].label, rowsOf(claim)[0].value], ["Pays to contract", contractId]);

  // A withdrawal the window can't read (none, or amounts that differ) is a plain contract call.
  for (const unread of [undefined, { ...withdrawal, value: 1n }]) {
    const plain = await duskCallLines({ ...portal, withdrawal: unread });
    assert.deepEqual(plain[0], { amount: "", kind: "head", title: "Contract call" });
    assert.deepEqual(labelsOf(plain), ["From", "Contract", "Function", "Call data", "Network fee", "Total", "From the site, not checked by the wallet"]);
  }
});

test("a transfer lists Dusk Wallet's Pay window: amount and recipient, the fee, then from, to and memo", () => {
  const lines = duskTransferLines({ amountLux: 2_000_000_000n, from: ACCOUNT, gas: { limit: "2500000", price: "1" }, memo: EVM, to: testnet.service.account });
  assert.deepEqual(lines[0], { amount: "2 DUSK", kind: "head", title: "Pay", to: middle(testnet.service.account, 6, 6), toFull: testnet.service.account });
  assert.deepEqual(labelsOf(lines), ["Network fee", "Total", "From", "To", "Memo"]);
  assert.deepEqual(groupsOf(lines), ["Network fee", "From"]);
  assert.equal(valueOf(lines, "Network fee").value, "up to 0.0025 DUSK");
  assert.equal(valueOf(lines, "Total").value, "up to 2.0025 DUSK");
  assert.equal(valueOf(lines, "To").address, testnet.service.account);
  assert.equal(valueOf(lines, "Memo").value, EVM);
});

test("fees and totals read as Dusk Wallet writes them", () => {
  // A maximum: exact to 4 decimals, rounded up past them, trailing zeros trimmed.
  assert.deepEqual([0n, 49_999n, 50_000n, 2_500_000n, 5_000_000n, 105_000_000n, 1_000_010_000n, 12_345_678_912_345n].map(walletFee), [
    "0 DUSK", "0.0001 DUSK", "0.0001 DUSK", "0.0025 DUSK", "0.005 DUSK", "0.105 DUSK", "1.0001 DUSK", "12,345.679 DUSK",
  ]);
  assert.equal(middle("short", 6, 6), "short");
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
  const model = receiptModel(entry, { cfg: testnet, route: T["duskevm-deposit"], timeZone: "Europe/Amsterdam", url });
  assert.equal(model.view.title, "25 DUSK arrived on DuskEVM");
  assert.equal(model.caption, "Arrived Mon 26 Oct 2026, 10:31 CET.");
  assert.deepEqual(model.details.map((row) => row.label), ["Amount", "Network fee paid", "From, on Dusk", "To, on DuskEVM", "Dusk transaction", "DuskEVM transaction", "Sent"]);
  assert.equal(model.details[1].value, "0.002 DUSK on Dusk");
  const html = receiptPage(model);
  assert.ok(html.includes(`<code class="mono">${"38".repeat(32)}</code>`));
  assert.ok(html.includes(`<code class="mono">0x${"a1".repeat(32)}</code>`));
  assert.ok(html.includes(`<code class="mono">${url}</code>`));
  assert.ok(html.includes(`<code class="mono">${ACCOUNT}</code>`));
  assert.doesNotMatch(html, /balance|now holds/iu);
  assert.ok(!html.includes(TIMES));

  // While pending: what is usual and what to do when it's late. No contact is named unless configured.
  const pending = receiptModel({ ...entry, destinationHash: undefined, status: "pending" }, { cfg: testnet, now: entry.sourceAt + 60_000, route: T["duskevm-deposit"], url });
  assert.match(pending.notes.at(-1).html, /^Usually within a minute\. Not there after 15 minutes\? Keep the receipt link/u);
  const supported = profile("testnet", { ...DUSKEVM, VITE_SUPPORT_LABEL: "Dusk support", VITE_SUPPORT_URL: "https://support.example.org" });
  const withSupport = receiptModel({ ...entry, status: "pending" }, { cfg: supported, route: routesOf(supported)["duskevm-deposit"], url });
  assert.match(withSupport.notes.at(-1).html, /Contact <a href="https:\/\/support\.example\.org" target="_blank" rel="noreferrer">Dusk support<\/a> with the receipt link\./u);
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

test("My transfers groups the connected accounts' transfers and offers the next action", () => {
  const routeOf = (id) => buildRoutes(testnet).find((route) => route.id === id);
  const entries = [
    { amountLux: "120000000000", hash: `0x${"01".repeat(32)}`, id: "a", parties: [EVM.toLowerCase(), ACCOUNT], readyAt: Date.UTC(2026, 9, 24) / 1_000, routeId: "dusk-evm-to-dusk", stage: "ready_to_finalize", status: "pending" },
    { amountLux: "25000000000", destinationAt: Date.UTC(2026, 9, 26, 9, 31), hash: "02".repeat(32), id: "b", parties: [ACCOUNT, EVM.toLowerCase()], routeId: "dusk-to-dusk-evm", status: "completed" },
    { amountLux: "5000000000", hash: "03".repeat(32), id: "c", parties: ["someone-else"], routeId: "dusk-to-dusk-evm", status: "completed" },
    { amountLux: "5000000000", followed: true, hash: "04".repeat(32), id: "d", parties: [], routeId: "dusk-to-ethereum", status: "pending" },
  ];
  const model = transfersModel(entries, { accounts: [ACCOUNT, EVM], cfg: testnet, now: Date.UTC(2026, 9, 26, 10), routeOf, timeZone: "Europe/Amsterdam" });
  assert.equal(model.needs, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(model.groups).map(([key, rows]) => [key, rows.map((row) => row.id)])), { done: ["b"], failed: [], needs: ["a"], progress: ["d"] });
  const claim = model.groups.needs[0];
  assert.equal(claim.subline, "Ready to claim since Sat 24 Oct, 02:00 CEST");
  assert.equal(claim.action.kind, "finalize");
  assert.equal(claim.href, `#/transfer/0x${"01".repeat(32)}`);
  const html = transfersPage({ empty: "", groups: model.groups, lede: "x", more: false, syncText: "" });
  assert.match(html, /data-action="withdrawal-finalize" data-id="a">Claim<span class="sr-only"> 120 DUSK from DuskEVM to Dusk<\/span>/u);
  assert.match(html, /<h2 class="sec-t">Needs you<\/h2>/u);
});

test("the Contracts sheet lists every address in full, per route, with an operator only when configured", () => {
  const groups = contractGroups(testnet);
  assert.deepEqual(groups.map((group) => group.title), ["Networks", "Old DUSK from Ethereum (Sepolia)", "Dusk to Ethereum (Sepolia)", "Dusk and DuskEVM", "Used to read Dusk"]);
  assert.deepEqual(groups[0].rows.map((row) => [row.label, row.value]), [
    ["Dusk", "dusk:2"],
    ["DuskEVM", "chain 745"],
    ["Ethereum (Sepolia)", "chain 11155111"],
  ]);
  const html = contractsSheet({ badge: "Testnet", groups });
  for (const value of [
    testnet.evmNetworks.ethereum.migrationContract,
    testnet.evmNetworks.ethereum.tokenContract,
    testnet.service.account,
    // Dusk contracts as Dusk Wallet writes them: 0x and all 64 hex characters, copied the same.
    `0x${testnet.duskEvm.l1StandardBridgeContractId}`,
    `0x${testnet.duskEvm.optimismPortalContractId}`,
    `0x${testnet.duskEvm.disputeGameFactoryContractId}`,
    "0x4200000000000000000000000000000000000010",
    "0x4200000000000000000000000000000000000016",
    `0x${testnet.multicall.contractId}`,
  ]) {
    assert.ok(html.includes(`<code class="mono">${value}</code>`), value);
    assert.ok(html.includes(`data-copy="${value}"`), value);
  }
  assert.ok(html.includes(`https://apps.testnet.dusk.network/explorer/accounts/?key=${testnet.service.account}`));
  assert.doesNotMatch(html, /Operated by/u);
  assert.match(html, /Keeps the old DUSK locked\. It has no function to send them out\./u);
  assert.ok(!html.includes(TIMES));

  const operated = contractGroups(profile("mainnet", { VITE_SERVICE_OPERATOR: "Example B.V." }));
  assert.equal(operated.find((group) => group.id === "service").operator, "Example B.V.");
  assert.match(contractsSheet({ badge: "Mainnet", groups: operated }), /Operated by<\/dt><dd class="v">Example B\.V\.<\/dd>/u);
  assert.deepEqual(contractGroups(mainnet)[0].rows[1], { label: "DuskEVM", muted: true, value: "not on Mainnet yet" });
  assert.match(networkSheet({ badge: "Mainnet", isTestnet: false, networks: contractGroups(mainnet)[0].rows, otherName: "Testnet", otherSite: "" }), /Real DUSK\. Testnet has its own bridge\./u);
});

test("the form labels its amount and says what is public", () => {
  const quote = buildQuote(T["duskevm-deposit"], "25", { balance: 1_483_920_000_000n, cfg: testnet, gasPrice: 1n });
  const html = formPage({
    amount: "25",
    amountError: "",
    available: "1,483.915 DUSK",
    balanceNote: "Your public balance. Shielded and staked DUSK aren't included.",
    canMax: true,
    canReview: true,
    firstTime: true,
    from: { balance: "", chain: "dusk", label: "From Dusk", value: "x" },
    notice: null,
    privacy: "Your Dusk account 21n5nc…fMMLNz, 0xd63b…8df4 and the amount are visible on Dusk and DuskEVM, and linked to each other.",
    quote,
    reviewLabel: "Review",
    routeId: "dusk-to-dusk-evm",
    sources: [{ id: "dusk-to-dusk-evm", name: "Dusk" }],
    title: "Move DUSK to DuskEVM",
    to: { chain: "dusk-evm", label: "To DuskEVM", value: EVM, valueNote: "your MetaMask, on DuskEVM" },
    unit: "DUSK",
  });
  assert.match(html, /<label for="amount" class="amount-label">Amount<\/label>/u);
  assert.match(html, /First time\? Try a small amount first\./u);
  // The summary beside the form: its rows, what leaves the account, and the
  // button in the same card; what's public in one line, the rest folded.
  assert.match(html, /<dt class="k">Leaves your Dusk account<\/dt><dd class="v"><span class="num">up to 25\.005 DUSK<\/span><\/dd>/u);
  assert.match(html, /<div class="fp-side">\s*<section class="sum" aria-labelledby="sum-t"><h2 class="sum-t" id="sum-t">Summary<\/h2>/u);
  assert.match(html, /<details class="pub"><summary>.*<span>Public on both networks, and linked<\/span><\/summary><p><span data-region="privacy">Your Dusk account/u);
  assert.ok(html.indexOf('data-action="review"') > html.indexOf('class="sum"'));
  assert.ok(!html.includes(TIMES));
});

test("everything in the form that follows balances is a region the page refreshes while you type", () => {
  const quote = buildQuote(T["duskevm-deposit"], "25", { balance: 1_483_920_000_000n, cfg: testnet, gasPrice: 1n });
  const vm = {
    amount: "25",
    amountError: "",
    available: "1,483.915 DUSK",
    canMax: true,
    canReview: true,
    from: { balance: '<b class="num">1,483.92 DUSK</b>public balance', chain: "dusk", label: "From Dusk", value: "x" },
    privacy: "p",
    quote,
    reviewLabel: "Review",
    routeId: "dusk-to-dusk-evm",
    sources: [{ id: "dusk-to-dusk-evm", name: "Dusk" }],
    title: "Move DUSK to DuskEVM",
    to: { chain: "dusk-evm", label: "To DuskEVM", value: EVM },
    unit: "DUSK",
  };
  const regions = formRegions(vm);
  assert.match(regions.from, /1,483\.92 DUSK/u);
  assert.match(regions.avail, /Available <span class="num">1,483\.915 DUSK<\/span><\/span><button type="button" class="mini" data-action="max">Max<\/button>/u);
  const page = formPage(vm);
  // Each region is rendered as the refresh will replace it.
  assert.ok(page.includes(`<div data-region="from">${regions.from}</div>`));
  assert.ok(page.includes(`data-region="avail">${regions.avail}</div>`));
  for (const name of Object.keys(regions)) assert.ok(page.includes(`data-region="${name}"`), name);
});

test("a proof's review says it moves no DUSK and what it costs; a claim, where the DUSK goes", () => {
  const amountLux = 1_008n * 10n ** 9n;
  const other = { destination: testnet.service.account };
  // Paying another account than Dusk Wallet's says so, by the wallet's .dusk name.
  const prove = actionLead("prove", other, { account: ACCOUNT, amountLux, maxLux: 51_000_000n, name: "alice.dusk" });
  assert.deepEqual(prove, {
    amount: "0.051",
    label: "Proving costs up to",
    line: "No DUSK moves now. The 1,008 DUSK stays in the DuskEVM bridge until it's claimed, about 7 days after the proof.",
    notYours: "This withdrawal pays 25z9o6…5Etftt, not your alice.dusk. Proving it doesn't change that.",
  });
  const claim = actionLead("finalize", { destination: ACCOUNT }, { account: ACCOUNT, amountLux, maxLux: 51_000_000n });
  assert.deepEqual(claim, { amount: "1,008", chain: "dusk", label: "You claim", line: "To 21n5nc…fMMLNz on Dusk · costs up to 0.051 DUSK", notYours: "" });
  assert.equal(
    actionLead("finalize", other, { account: ACCOUNT, amountLux, maxLux: 1n }).notYours,
    "This withdrawal pays 25z9o6…5Etftt, not your connected Dusk account. The claim sends the DUSK there.",
  );

  const sheet = reviewSheet({
    canConfirm: true, cfgLinks: explorer, checks: [], confirmLabel: "Prove on Dusk", feeRows: [], lead: prove,
    privacy: "x", steps: [], sub: "", walletCheckName: "Dusk Wallet",
  });
  assert.match(sheet, /<div class="k">Proving costs up to<\/div><div class="v num">0\.051<span class="u">DUSK<\/span>/u);
  // A warning before the steps, not a line among them.
  assert.match(sheet, /<div class="group pad warn-box" role="note"><div class="note">.*<b>Another account gets this DUSK\.<\/b> This withdrawal pays 25z9o6…5Etftt, not your alice\.dusk\./u);
  assert.ok(sheet.indexOf("warn-box") < sheet.indexOf('class="group kvs"'));
  assert.doesNotMatch(sheet, /You send|You receive/u);
});

test("the form shows one number format: the balance and what's available, to 4 decimals", () => {
  // 1,483.112423314 DUSK less the 0.005 maximum fee.
  assert.deepEqual(availableLine(T["duskevm-deposit"], 1_483_107_423_314n), { available: "1,483.1074 DUSK", availableLabel: "Available after fees", canMax: true });
  assert.deepEqual(availableLine(T.migration, 2_500_000_000_000n), { available: "2,500 old DUSK", availableLabel: "Available", canMax: true });
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

test("the footer names who runs each route only where that's configured", () => {
  const bare = footer({ links: {}, officialSite: "" });
  assert.doesNotMatch(bare, /Run by|How the bridge works/u);
  const named = footer({
    links: { privacy: "https://example.org/privacy", terms: "https://example.org/terms" },
    officialSite: "",
    operators: [{ name: "Example B.V.", route: "Dusk to BNB Smart Chain" }, { name: "Dusk Network", route: "DuskEVM" }],
  });
  assert.match(named, /<p class="small t2 run-by">Run by Example B\.V\. for Dusk to BNB Smart Chain · Dusk Network for DuskEVM\.<\/p>/u);
  assert.match(named, />Terms<\/a><a href="https:\/\/example\.org\/privacy" target="_blank" rel="noreferrer">Privacy<\/a>/u);
});

test("a proof's review says the account that proves becomes public too", () => {
  assert.equal(
    actionPrivacy("prove", "The amount is public.", { account: ACCOUNT, name: "alice.dusk" }),
    "The amount is public. Your Dusk account alice.dusk will be visible too, as the account that proved it.",
  );
  assert.match(actionPrivacy("finalize", "x", { account: ACCOUNT }), /Your Dusk account 21n5nc…fMMLNz will be visible too, as the account that claimed it\.$/u);
  assert.match(actionPrivacy("prove", "x"), /Your Dusk account will be visible too/u);
});

test("a withdrawal claimed outside this browser reads as claimed", () => {
  const entry = { amountLux: "1000000000", destination: ACCOUNT, hash: `0x${"34".repeat(32)}`, id: "w", routeId: "dusk-evm-to-dusk", sender: EVM, stage: "finalized", status: "completed" };
  const model = receiptModel(entry, { cfg: testnet, route: T["duskevm-withdrawal"], url: "https://bridge.example/#/transfer/x" });
  assert.match(model.details.find((row) => row.label === "Claim on Dusk").html, />Claimed</u);
});

test("your Dusk account shows by the .dusk name Dusk Wallet sent", () => {
  const top = header({ badge: "Testnet", dusk: { account: ACCOUNT, name: "alice.dusk", state: "connected" }, evm: { state: "connect" }, isTestnet: true, nav: "move" });
  assert.match(top, /<span class="av">.*<\/span><span class="nm">alice\.dusk<\/span><\/button>/u);
  assert.doesNotMatch(header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { state: "connect" }, isTestnet: true }), /class="nm"/u);
  // A receipt names your own account by it, any other by its short code.
  const entry = { amountLux: "100000000", destination: EVM, hash: "38".repeat(32), id: "x", routeId: "dusk-to-dusk-evm", sender: ACCOUNT, status: "pending" };
  const url = "https://bridge.example/#/transfer/x";
  assert.match(receiptModel(entry, { cfg: testnet, own: { account: ACCOUNT, name: "alice.dusk" }, route: T["duskevm-deposit"], url }).fromTo, /^From alice\.dusk on Dusk/u);
  assert.match(receiptModel(entry, { cfg: testnet, own: { account: "someone else", name: "bob.dusk" }, route: T["duskevm-deposit"], url }).fromTo, /^From <code class="mono">21n5nc…fMMLNz<\/code> on Dusk/u);
});

test("a typed .dusk name shows the account it points to, and wrong capitals offer the fix", () => {
  const quote = buildQuote(T["duskevm-withdrawal"], "1", { balance: null, cfg: testnet, gasPrice: 1n });
  const vm = {
    amount: "1",
    amountError: "",
    available: "",
    from: { balance: "", chain: "dusk-evm", label: "From DuskEVM", value: "x" },
    privacy: "p",
    quote,
    reviewLabel: "Review",
    routeId: "dusk-evm-to-dusk",
    sources: [{ id: "dusk-evm-to-dusk", name: "DuskEVM" }],
    title: "Move DUSK to Dusk",
    to: { chain: "dusk", editing: true, input: "alice.dusk", label: "To Dusk", resolved: { address: ACCOUNT, name: "alice.dusk" }, value: ACCOUNT },
    unit: "DUSK",
  };
  const page = formPage(vm);
  // The field wraps, so the whole address shows on a phone.
  assert.match(page, /<textarea id="recipient" name="recipient" class="mono-input wrap-input" rows="2"[^>]*>alice\.dusk<\/textarea>/u);
  assert.ok(page.includes(`alice.dusk points to <code class="mono wrap">${ACCOUNT}</code>`));
  const note = (to) => formRegions({ ...vm, to: { ...vm.to, resolved: null, ...to } })["recipient-note"];
  assert.equal(note({ looking: "alice.dusk" }), "Looking up alice.dusk…");
  assert.match(note({ error: "x", fix: EVM }), /<button type="button" class="linkish" data-action="recipient-fix">If every character is right, fix the capitals<\/button>/u);
  assert.equal(note({}), "");
});

test("the wallet cards say which account is connected", () => {
  const html = landing({
    canShare: false,
    dusk: { account: ACCOUNT, name: "alice.dusk", state: "connected" },
    evm: { account: EVM, state: "connected" },
    pageUrl: "",
    phone: true,
    tasks: [],
  });
  assert.match(html, /Connected · <span class="who">alice\.dusk<\/span>/u);
  assert.match(html, /Connected · <span class="who">0xd63b…8df4<\/span>/u);
  assert.match(landing({ canShare: false, dusk: { account: ACCOUNT, state: "connected" }, evm: { state: "connect" }, pageUrl: "", phone: false, tasks: [] }), /Connected · <span class="who">21n5nc…fMMLNz<\/span>/u);
});

test("About this page names, in one line, the servers the page reads from", async () => {
  const line = serversLine(testnet);
  assert.equal(
    line,
    "This page reads from testnet.nodes.dusk.network (the Dusk node and its archive), rpc.testnet.evm.dusk.network (DuskEVM), ethereum-sepolia-rpc.publicnode.com (Ethereum (Sepolia)) and testnet.dusk.domains (for .dusk names).",
  );
  // In the About sheet the footer opens, with the contracts.
  assert.match(footer({ links: {}, officialSite: "" }), /<button type="button" class="linkish" data-action="open-about" aria-haspopup="dialog">About this page<\/button>/u);
  const sheet = contractsSheet({ badge: "Testnet", groups: contractGroups(testnet), servers: line });
  assert.match(sheet, /<h3 class="gt">Servers<\/h3><p class="card about-servers">This page reads from testnet\.nodes\.dusk\.network/u);
  assert.ok(sheet.indexOf("Servers") < sheet.indexOf("Bridge contract on Dusk"));
  // The names' host is the one each release fetches its lens driver from.
  const { default: releases } = await import("./dusk-domains-releases.js");
  for (const release of Object.values(releases)) assert.ok(serversLine({ ...testnet, dusk: { ...testnet.dusk, chainId: release.chainId } }).includes(`${new URL(release.artifactBaseUrl).host} (for .dusk names)`));
});

test("My transfers can follow a Dusk account without a wallet, and stop", () => {
  const page = (watch) => transfersPage({ empty: "e", groups: {}, lede: "l", syncText: "", watch });
  const form = page({ busy: false, error: "", following: "", input: "" });
  assert.match(form, /<form class="group pad watch" data-form="watch">\s*<label for="watch" class="l1">Follow a Dusk account<\/label>/u);
  assert.match(form, /placeholder="A Dusk account or \.dusk name"/u);
  assert.match(page({ busy: false, error: "bob.dusk isn't an active .dusk name.", following: "", input: "bob.dusk" }), /role="alert">bob\.dusk isn&#039;t an active \.dusk name\.<\/p>/u);
  const following = page({ following: "alice.dusk" });
  assert.match(following, /Following alice\.dusk on this device\. Nothing can be sent from here\. <button type="button" class="linkish" data-action="unwatch">Stop following<\/button>/u);
  assert.doesNotMatch(following, /data-form="watch"/u);
  // With Dusk Wallet connected, there's nothing to follow.
  assert.doesNotMatch(page(null), /Follow a Dusk account|Following/u);
});

test("a route is two marks with an arrow, and DuskEVM is told apart from Dusk", () => {
  assert.match(pairMark("dusk", "dusk-evm"), /^<span class="pair" aria-hidden="true"><span class="cm" aria-hidden="true">.*<\/span><svg class="ic pa"[^>]*><path d="M5 12h14"\/>.*<span class="cm evm" aria-hidden="true">.*<span class="evm-tag">EVM<\/span><\/span><\/span>$/u);
  assert.doesNotMatch(chainMark("dusk"), /evm-tag/u);
  for (const chain of ["ethereum", "bsc"]) assert.match(chainMark(chain), /<svg class="mk-svg" viewBox="0 0 24 24"[^>]*><path /u, chain);
});

test("the start page, the form, the review, the receipt and the card quote one fee a step", () => {
  const gasPrice = 2n;
  const route = T["duskevm-withdrawal"];
  const withdrawalGas = 519_542n;
  // Before the withdrawal exists: the start page and the form.
  const start = landingTasks(testnet, bridgeTasks(testnet, buildRoutes(testnet)), { gasPrice }).find((task) => task.id === "from-duskevm");
  assert.match(start.meta, /· up to 0\.102 DUSK a step on Dusk$/u);
  const form = buildQuote(route, "1", { balance: null, cfg: testnet, gasPrice });
  assert.equal(form.rows.find((row) => row.key === "fee-dusk").value, "up to 0.102 DUSK a step");
  // Once it exists, with its own gas: the card, the receipt, and the review's request.
  const entry = { amountLux: "1000000000", hash: `0x${"0c".repeat(32)}`, id: "w", routeId: route.id, sourceAt: Date.UTC(2026, 9, 1), stage: "ready_to_prove", status: "pending", withdrawalGas: withdrawalGas.toString() };
  assert.equal(transferView(entry, { cfg: testnet, gasPrice, route }).steps[1].detail, "Ready now · network fee up to 0.102 DUSK");
  assert.equal(receiptModel(entry, { cfg: testnet, gasPrice, route, url: "https://bridge.example/#/transfer/w" }).actionFee, "Network fee up to 0.102 DUSK, from your public balance");
  const request = withdrawalGasLimit(withdrawalGas) * gasPrice;
  assert.equal(request, withdrawalStepMax({ gasPrice, withdrawalGas }));
  assert.equal(actionLead("prove", entry, { maxLux: request }).amount, "0.102");
  assert.match(actionLead("finalize", entry, { maxLux: request }).line, /costs up to 0\.102 DUSK$/u);
});
