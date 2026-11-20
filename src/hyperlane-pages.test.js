import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { groupTransfers } from "./discovery.js";
import { duskRecipientHash } from "./hyperlane.js";
import { balanceLine, receiptModel, reviewChecks, routeDetailRows, routeLines, transfersModel } from "./page-models.js";
import { buildQuote } from "./quote.js";
import { cardPage, cardRegions, receiptPage, transferRow } from "./views.js";
import { tokenChoices } from "./bridge-card.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));
const routeOf = (id) => byId[id];

const GB = "en-GB";
const AMS = "Europe/Amsterdam";
const NOW = Date.parse("2026-11-18T09:20:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";

// Live transaction 86123720…, 95.085867 EURd to Sepolia, on its way.
const OUT = {
  amountLux: "95085867",
  bridgeFeeLux: "16876000000",
  destination: EVM,
  feeLux: "2216155",
  hash: "86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f",
  id: "dusk-to-sepolia-eurd:86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f",
  messageId: "0xed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b",
  routeId: "dusk-to-sepolia-eurd",
  sender: ACCOUNT,
  sourceAt: Date.parse("2026-11-18T09:13:41Z"),
  status: "pending",
};
// A USDd transfer to Dusk, delivered, and held for the account's claim.
const HELD = {
  amountLux: "32156353",
  bridgeFeeWei: "132000000001",
  delivered: true,
  deliveredAt: Date.parse("2026-11-18T09:21:30Z"),
  destination: ACCOUNT,
  escrow: "held",
  feeWei: "235736000000",
  hash: "0x194470f65cdcb660042f9c87df42c83c5b8b88200e20f4faa6be6273e3c07c75",
  heldLux: "32156353",
  id: "sepolia-to-dusk-usdd:0x194470f65cdcb660042f9c87df42c83c5b8b88200e20f4faa6be6273e3c07c75",
  messageId: "0x8bfceee4fc2bb2d10246a3b7c7ac8f75538cded9501f44382df39123c0f86db6",
  parties: [EVM.toLowerCase(), ACCOUNT],
  recipientHash: duskRecipientHash(ACCOUNT),
  routeId: "sepolia-to-dusk-usdd",
  sender: EVM,
  sourceAt: Date.parse("2026-11-18T09:20:38Z"),
  status: "pending",
};

const receipt = (entry, extra = {}) =>
  receiptModel(entry, { cfg, gasPrice: 1n, locale: GB, now: NOW, own: { account: ACCOUNT, name: "" }, route: routeOf(entry.routeId), timeZone: AMS, url: "https://bridge.test/#/transfer/x", ...extra });
const steps = (model) => model.view.steps.map(({ detail, state, title }) => [title, state, detail]);
const details = (model) => Object.fromEntries(model.details.map((row) => [row.label, row.value ?? row.html]));

test("a transfer to Sepolia shows its message on its way, its fees in DUSK, and Sepolia's transaction once it arrives", () => {
  const model = receipt(OUT);
  assert.deepEqual([model.view.title, model.view.headline], ["95.085867 EURd · Dusk → Sepolia", "Sending 95.085867 EURd to Sepolia"]);
  // Its message is under Details.
  assert.deepEqual(steps(model), [
    ["Sent from Dusk", "done", ""],
    ["Arriving on Sepolia", "now", ""],
  ]);
  assert.equal(model.caption, "~20 s");
  // The fees, in the coin they were paid in, in one line; each under Details.
  assert.deepEqual(model.fees, { exact: "16.878216155 DUSK", text: "16.8782 DUSK" });
  const rows = details(model);
  assert.deepEqual(
    ["You sent", "Bridge fee", "Network fee", "You receive"].map((label) => rows[label]),
    ["95.085867 EURd", "16.876 DUSK", "0.002216155 DUSK", "95.085867 EURd"],
  );
  // Under Details, in full.
  assert.match(rows["Message ID"], /<code class="mono">0xed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b<\/code>/u);
  assert.match(rows.To, /https:\/\/sepolia\.etherscan\.io\/address\/0x8A51d0619286d937699D85c1a2c88D67A5a1B75d/u);
  assert.match(rows["Dusk transaction"], /https:\/\/explorer\.testnet\.dusk\.network\/transactions\/transaction\?id=86123720/u);
  assert.equal(model.arrives, true);

  const done = receipt({ ...OUT, destinationAt: OUT.sourceAt + 19_000, destinationHash: "0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8", status: "completed" });
  assert.equal(done.view.headline, "95.085867 EURd arrived on Sepolia");
  assert.deepEqual(done.view.steps.at(-1).href, "https://sepolia.etherscan.io/tx/0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8");
  assert.equal(details(done)["You received"], "95.085867 EURd");
});

test("a transfer to Dusk the route holds needs its account's claim, there and in the list", () => {
  const model = receipt(HELD);
  assert.deepEqual([model.view.title, model.view.headline], ["32.156353 USDd · Sepolia → Dusk", "32.156353 USDd is ready to claim"]);
  assert.deepEqual(steps(model), [
    ["Sent from Sepolia", "done", ""],
    ["Delivered to Dusk", "done", "First transfer to this account: held until claimed"],
    ["Claim on Dusk", "turn", ""],
  ]);
  assert.deepEqual(model.view.action, { blocked: "", command: "escrow-claim", failure: "", kind: "claim", label: "Claim 32.156353 USDd", quiet: false });
  assert.equal(model.actionFee, "Network fee up to 0.003 DUSK");
  // Nothing comes by itself: it isn't offered to be told when it arrives.
  assert.equal(model.arrives, false);
  assert.deepEqual(
    ["You sent", "Bridge fee", "Network fee", "You receive"].map((label) => details(model)[label]),
    ["32.156353 USDd", "0.000000132000000001 ETH", "0.000000235736 ETH", "32.156353 USDd"],
  );
  const page = receiptPage({ ...model, canAct: true });
  assert.match(page, /<button type="button" class="btn pri" data-action="escrow-claim" data-id="sepolia-to-dusk-usdd:0x1944[^"]*">Claim 32\.156353 USDd<\/button>/u);

  // In Activity it needs you, with Claim on its row.
  const list = transfersModel([HELD], { account: ACCOUNT, accounts: [ACCOUNT], cfg, locale: GB, now: NOW, routeOf, timeZone: AMS });
  assert.equal(list.needs, 1);
  const [row] = list.groups.needs;
  // USDd to the cent, as a list writes money; every digit on hover.
  assert.deepEqual([row.title, row.amountText, row.amountExact, row.subline], ["Sepolia → Dusk", "32.15 USDd", "32.156353 USDd", "Held until claimed"]);
  assert.match(transferRow(row), /data-action="escrow-claim"/u);

  // Held for another account: anyone can claim it for it, so it's offered quietly, apart.
  assert.deepEqual(Object.entries(groupTransfers([HELD], routeOf, OTHER)).filter(([, list]) => list.length).map(([key]) => key), ["other"]);
  const forOther = receipt(HELD, { own: { account: OTHER, name: "" } });
  assert.equal(forOther.view.action.quiet, true);
  // Whose claim it is, on its button.
  assert.equal(forOther.view.action.label, "Claim for xGX8tZ…zQjkw9");
  assert.equal(forOther.actionFee, "Network fee up to 0.08 DUSK");
});

test("a transfer to Dusk says it waits for a claim as soon as it's known to be the account's first, and once claimed, that it arrived", () => {
  const way = { ...HELD, delivered: false, escrow: undefined, firstToAccount: true, heldLux: undefined };
  assert.deepEqual(steps(receipt(way)), [
    ["Sent from Sepolia", "done", ""],
    ["Arriving on Dusk", "now", ""],
    ["Claim on Dusk", "todo", "First transfer to this account: held until claimed"],
  ]);
  const claimAt = Date.parse("2026-11-18T09:25:00Z");
  const claimed = receipt({ ...HELD, claimAt, claimFeeLux: "1908588", claimHash: "cd".repeat(32), destinationAt: claimAt, escrow: "claimed", status: "completed" });
  assert.equal(claimed.view.headline, "32.156353 USDd arrived on Dusk");
  assert.deepEqual(claimed.view.steps.map(({ state, title }) => [title, state]), [
    ["Sent from Sepolia", "done"],
    ["Delivered to Dusk", "done"],
    ["Claimed on Dusk", "done"],
  ]);
  assert.equal(details(claimed)["Claim fee"], "0.001908588 DUSK");
  assert.match(details(claimed).Claim, /transactions\/transaction\?id=cdcd/u);
  // Paid straight away, no claim at all.
  const direct = receipt({ ...HELD, destinationAt: HELD.deliveredAt, escrow: null, status: "completed" });
  assert.deepEqual(direct.view.steps.map(({ title }) => title), ["Sent from Sepolia", "Arrived on Dusk"]);
  // Looked up by its hash alone, its account is said by its hash.
  assert.match(details(receipt({ ...HELD, destination: undefined }))["To (account hash)"], /0x2acf0348cca26cf2d0a4ecbddde6e7abd3d54b2e581a73a7741301e1b411b69b/u);
});

test("a Hyperlane route's line and checks say its time, its fees summed in their coin, and the first transfer's claim", () => {
  // The bridge fee and the most the network fee can be, in one: the split is behind the line.
  assert.deepEqual(routeLines(byId["dusk-to-sepolia"], cfg, { quote: { bridgeFeeLux: 16_876_000_000n, gasMaxLux: 5_000_000n } }), ["~20 s · fees up to 16.881 DUSK"]);
  assert.deepEqual(routeLines(byId["dusk-to-sepolia-eurd"], cfg), ["~20 s · fees in DUSK"]);
  assert.deepEqual(routeLines(byId["sepolia-to-dusk-usdd"], cfg), ["~1 min · fees in ETH"]);
  assert.deepEqual(routeLines(byId["sepolia-to-dusk-usdd"], cfg, { quote: { bridgeFeeWei: 132_000_000_001n, evmFeeWei: 4_696_029n } }), ["~1 min · fees <0.000001 ETH"]);
  const split = routeDetailRows(byId["dusk-to-sepolia"], buildQuote(byId["dusk-to-sepolia"], "1", { cfg, gasPrice: 1n, hyperlane: { fee: 16_876_000_000n } }));
  // Behind the line: each fee, what it is or usually comes to, and the steps.
  assert.deepEqual(split.map((row) => [row.label, row.value, row.detail ?? ""]), [
    ["Bridge fee", "16.876 DUSK", "on top of the amount"],
    ["Network fee", "up to 0.005 DUSK", "usually ~0.0022 DUSK"],
    ["Total", "up to 17.881 DUSK", ""],
    ["Steps", "One, in Dusk Wallet", ""],
  ]);
  assert.deepEqual(balanceLine(byId["sepolia-to-dusk"], 2_599_214_807n), { exact: "2.599214807 DUSK", text: "2.5992 DUSK" });
  // EURd and USDd to the cent, rounded down; never 0 for what isn't.
  assert.deepEqual(balanceLine(byId["sepolia-to-dusk-eurd"], 265_883_514n), { exact: "265.883514 EURd", text: "265.88 EURd" });
  assert.deepEqual(balanceLine(byId["dusk-to-sepolia-usdd"], 1_000_000n), { exact: "1 USDd", text: "1 USDd" });
  assert.equal(balanceLine(byId["dusk-to-sepolia-usdd"], 4_000n).text, "0.004 USDd");

  const route = byId["sepolia-to-dusk-usdd"];
  const evm = { deliveryFeeWei: 132_000_000_001n, gas: 276_237n, gasCoinWei: 29_971_344_846_295_543n, priceWei: 17n };
  const quote = buildQuote(route, "10", { balance: 71_508_029n, cfg, evm });
  const reads = { gasPrice: 1n, hyperlane: { evm: { balance: 71_508_029n, gasCoinWei: evm.gasCoinWei }, registered: false } };
  const checks = reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads });
  // Each check is said only where it fails; the first transfer's claim, always.
  assert.deepEqual(checks.map((check) => [check.ok, Boolean(check.note)]), [[true, false], [true, false], [true, true]]);
  assert.equal(checks[0].html, 'Not enough USDd: you have <b class="num">71.508029 USDd</b>');
  assert.equal(checks[2].html, "First USDd to this account: held until claimed (fee up to 0.003 DUSK)");
  // An account the route pays already: no claim to mention.
  assert.equal(reviewChecks(route, { cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, quote, reads: { hyperlane: { registered: true } } }).length, 0);

  const out = byId["dusk-to-sepolia-eurd"];
  const ctx = { allowance: 20_000_000n, fee: 16_876_000_000n, tokenBalance: 49_805_396_789n };
  const outQuote = buildQuote(out, "10", { balance: 20_000_000_000n, cfg, gasPrice: 1n, hyperlane: ctx });
  const outChecks = reviewChecks(out, { cfg, destination: EVM, duskAccount: ACCOUNT, evm: { account: EVM, walletName: "MetaMask" }, quote: outQuote, reads: { duskBalance: 20_000_000_000n, hyperlane: ctx } });
  assert.deepEqual(
    outChecks.map((check) => [check.ok, check.html.replace(/<[^>]+>/gu, "")]),
    [
      [true, "Not enough EURd: you have 49,805.396789 EURd"],
      [true, "Not enough DUSK for the fees (up to 16.881 DUSK): you have 20 DUSK"],
    ],
  );
});

test("the card offers the pair's tokens beside the amount, and what the routes hold for the account above it", () => {
  const route = byId["dusk-to-sepolia-eurd"];
  const quote = buildQuote(route, "10", { balance: 20_000_000_000n, cfg, gasPrice: 1n, hyperlane: { allowance: 0n, fee: 16_876_000_000n, tokenBalance: 49_805_396_789n } });
  const vm = {
    amount: "10",
    amountError: "",
    button: { action: "review", enabled: true, label: "Review 10 EURd" },
    canFlip: true,
    canMax: true,
    error: "",
    escrow: { held: [{ amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }, { amount: "2 DUSK", route: "sepolia-to-dusk", sent: "Claim sent, waiting for Dusk" }] },
    from: { balance: "49,805.3967 EURd", balanceLabel: "Balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    menu: null,
    needsCount: 0,
    notice: null,
    quote,
    receive: "10",
    receiveUnit: "EURd",
    routeLines: routeLines(route, cfg, { quote }),
    routeOpen: false,
    routeRows: routeDetailRows(route, quote),
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient", line: '<b class="mono">0x8A51d0…a1B75d</b>', looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    tokens: tokenChoices(buildRoutes(cfg), route),
    unit: "EURd",
  };
  const page = cardPage(vm);
  assert.match(page, /<button type="button" class="token tokbtn" data-action="open-menu" data-side="token" aria-haspopup="listbox" aria-expanded="false" aria-label="Token: EURd\. Choose the token">/u);
  const open = cardPage({ ...vm, menu: "token" });
  assert.match(open, /<div class="netmenu" role="listbox" aria-label="Token">/u);
  assert.deepEqual([...open.matchAll(/data-action="pick-token" data-route="([^"]+)" aria-selected="(true|false)"/gu)].map((match) => [match[1], match[2]]), [
    ["dusk-to-sepolia", "false"],
    ["dusk-to-sepolia-eurd", "true"],
    ["dusk-to-sepolia-usdd", "false"],
  ]);
  // One token on the pair: no choice, the token as it was.
  assert.match(cardPage({ ...vm, tokens: [] }), /<span class="token"><span class="cm/u);
  // What waits for the account, with Claim, or the claim sent in its place.
  const { escrow, route: row } = cardRegions(vm);
  assert.match(escrow, /<b>Held for you on Dusk:<\/b> <span class="num">10 USDd and 2 DUSK<\/span><\/span>/u);
  assert.match(escrow, /<button type="button" class="btn sec sm" data-action="escrow-claim" data-route="sepolia-to-dusk-usdd">Claim 10 USDd<\/button><span class="small t2">Claim sent, waiting for Dusk<\/span>/u);
  assert.equal(cardRegions({ ...vm, escrow: null }).escrow, "");
  // Another account's, typed or handed over: claimed for it.
  const other = cardRegions({ ...vm, escrow: { held: [{ account: ACCOUNT, amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }], link: "", owner: "xGX8tZ…zQjkw9" } }).escrow;
  assert.match(other, /<b>Held for xGX8tZ…zQjkw9:<\/b> <span class="num">10 USDd<\/span><\/span>/u);
  assert.match(other, new RegExp(`data-action="escrow-claim" data-route="sepolia-to-dusk-usdd" data-account="${ACCOUNT}">Claim 10 USDd for it</button>`, "u"));
  // Without DUSK for its own claim's fee: the link another account claims it with, in place of Claim.
  const link = "https://bridge.test/#/move/sepolia-to-dusk-usdd?to=" + ACCOUNT;
  const stuck = cardRegions({ ...vm, escrow: { held: [{ account: "", amount: "10 USDd", route: "sepolia-to-dusk-usdd", sent: "" }], link, owner: "" } }).escrow;
  assert.match(stuck, /<span class="num">10 USDd<\/span> · No DUSK for the fee: share this link<\/span>/u);
  assert.ok(stuck.includes(`data-copy="${link}"`) && !stuck.includes("escrow-claim"), stuck);
  // Both fees in one line, the split behind it, with what each is, and the steps.
  assert.match(row, /<span>~20 s · fees up to 16\.884 DUSK<\/span>/u);
  assert.match(row, /<dt class="k">Bridge fee<\/dt><dd class="v"><span class="stack"><span class="num">16\.876 DUSK<\/span><span class="small">paid in DUSK<\/span><\/span><\/dd>/u);
  assert.match(row, /<dt class="k">Network fee<\/dt><dd class="v"><span class="stack"><span class="num">up to 0\.008 DUSK<\/span><span class="small">usually ~0\.0041 DUSK, for two wallet steps<\/span><\/span><\/dd>/u);
  assert.match(row, /<dt class="k">Steps<\/dt><dd class="v"><span class="stack"><span class="num">Approve, then send, in Dusk Wallet<\/span><\/span><\/dd>/u);
  assert.match(page, /data-region="escrow"/u);
});

test("where Sepolia's own DUSK route runs beside Hyperlane's, the token list says what each DUSK arrives as", () => {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet", VITE_PAUSED_ROUTES: "none" };
  const running = loadConfig();
  delete globalThis.__DUSK_BRIDGE_CONFIG__;
  const all = buildRoutes(running);
  const route = all.find((each) => each.id === "dusk-to-sepolia");
  const page = cardPage({
    amount: "",
    amountError: "",
    button: { action: "review", enabled: false, label: "Enter an amount" },
    canFlip: true,
    canMax: false,
    error: "",
    escrow: null,
    from: { balance: "", balanceLabel: "Public balance", net: { id: "dusk", name: "Dusk" } },
    fromChoices: [],
    menu: "token",
    needsCount: 0,
    notice: null,
    quote: buildQuote(route, "", { balance: null, cfg: running, gasPrice: 1n, hyperlane: {} }),
    receive: "",
    receiveUnit: "DUSK",
    routeLines: [],
    routeOpen: false,
    routeRows: [],
    tab: "bridge",
    to: { editing: false, error: "", fix: "", input: "", label: "Recipient", line: "", looking: "", net: { id: "ethereum", name: "Sepolia" }, placeholder: "0x…", resolved: null },
    toChoices: [],
    tokens: tokenChoices(all, route),
    unit: "DUSK",
  });
  const options = [...page.matchAll(/data-action="pick-token" data-route="([^"]+)"[^>]*>.*?<span class="nm">([^<]+)<\/span><span class="sb">([^<]+)<\/span>/gu)].map((match) => [match[1], match[2], match[3]]);
  assert.deepEqual(options.slice(0, 2), [
    ["dusk-to-ethereum", "DUSK", "Dusk · Arrives as ERC20 DUSK"],
    ["dusk-to-sepolia", "DUSK", "Dusk · Arrives as DUSK"],
  ]);
});
