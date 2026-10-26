import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { contractGroups, explorerAddressUrl } from "./contracts.js";
import { bridgeTasks } from "./names.js";
import { landingTasks, receiptModel, reviewChecks, transfersModel } from "./page-models.js";
import { buildQuote } from "./quote.js";
import { contractsSheet, formPage, landing, networkSheet, receiptPage, reviewSheet, transfersPage } from "./views.js";
import { approveLines, argsSummary, duskCallLines, duskTransferLines, migrateLines } from "./wallet-lines.js";

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
      ["Move DUSK from DuskEVM to Dusk", "Three steps over about 7 days · up to 0.05 DUSK per step on Dusk", "Step 1 works here. Prove and claim need a computer."],
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
    confirmLabel: "Approve 1,000 DUSK in MetaMask",
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    privacy: "x",
    receive: { amount: "1,000", chain: "dusk", unit: "DUSK", where: "Dusk" },
    send: { amount: "1,000", chain: "ethereum", unit: "old DUSK", where: "Ethereum (Sepolia)" },
    steps: [
      { current: true, lines: approve, title: "Approve exactly 1,000 DUSK", walletName: "MetaMask", what: "", when: "Now" },
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
  assert.match(sheet, />Cancel<\/button><button type="button" class="btn pri" data-action="confirm" >Approve 1,000 DUSK in MetaMask</u);
  assert.ok(!sheet.includes(TIMES));
});

test("Dusk Wallet's lines match what the extension prints, args hash included", async () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  assert.equal(await argsSummary(bytes), "3 bytes · sha256=039058c6f2c0…011cfb81");
  const call = await duskCallLines({
    contractId: testnet.duskEvm.l1StandardBridgeContractId,
    depositLux: 25_000_000_000n,
    display: { label: "Bridge 25 DUSK to DuskEVM", recipient: EVM },
    fnArgs: bytes,
    fnName: "depositETHToWithValue",
    from: ACCOUNT,
    gas: { limit: "5000000", price: "1" },
    network: { chainId: "dusk:2", name: "Testnet" },
  });
  // In the popup's own order and words (Dusk Wallet, main 392a521).
  assert.deepEqual(call.map((line) => line.label), [
    "Network", "From", "Contract", "Privacy", "Function", "Args (opaque bytes)", "Amount", "Deposit", "Network fee (max)", "Total (max)", "Site-provided details (unverified)",
  ]);
  const value = (lines, label) => lines.find((line) => line.label === label).value;
  assert.equal(value(call, "Network"), "Testnet, dusk:2");
  assert.equal(value(call, "Contract"), `0x${testnet.duskEvm.l1StandardBridgeContractId}`);
  assert.equal(value(call, "Deposit"), "25 DUSK");
  assert.equal(value(call, "Network fee (max)"), "0.005 DUSK");
  assert.equal(value(call, "Total (max)"), "25.005 DUSK");
  const transfer = duskTransferLines({ amountLux: 2_000_000_000n, from: ACCOUNT, gas: { limit: "2500000", price: "1" }, memo: EVM, network: { chainId: "dusk:2", name: "Testnet" }, to: testnet.service.account });
  assert.deepEqual(transfer.map((line) => line.label), ["Network", "From", "Privacy", "To", "Amount", "Memo", "Network fee (max)", "Total (max)"]);
  assert.equal(value(transfer, "Memo"), EVM);
  assert.equal(value(transfer, "Network fee (max)"), "0.0025 DUSK");
  assert.equal(value(transfer, "Total (max)"), "2.0025 DUSK");
  assert.equal(transfer[3].address, testnet.service.account);
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
    testnet.duskEvm.l1StandardBridgeContractId,
    testnet.duskEvm.optimismPortalContractId,
    testnet.duskEvm.disputeGameFactoryContractId,
    "0x4200000000000000000000000000000000000010",
    "0x4200000000000000000000000000000000000016",
    testnet.multicall.contractId,
  ])
    assert.ok(html.includes(`<code class="mono">${value}</code>`), value);
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
  assert.match(html, /Leaves your Dusk account: <span class="num">up to 25\.005 DUSK<\/span>/u);
  assert.match(html, /<b>Public\.<\/b>/u);
  assert.ok(!html.includes(TIMES));
});
