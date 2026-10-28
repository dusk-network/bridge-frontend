import assert from "node:assert/strict";
import test from "node:test";

import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";
import {
  WALLET_CANCELLED,
  actionErrorOf,
  explorerTxUrl,
  friendlyWalletError,
  privacyLine,
  short,
  transferSubline,
  transferView,
} from "./transfer-view.js";
import { receiptModel } from "./page-models.js";
import { receiptPage, reviewSheet, transferRow } from "./views.js";

const cfg = {
  dusk: { explorerUrl: "https://apps.testnet.dusk.network/explorer/" },
  duskEvm: { depositSeconds: 60, explorerUrl: "https://explorer.testnet.evm.dusk.network" },
  evmNetworks: { ethereum: { explorerUrl: "https://sepolia.etherscan.io", migrationSeconds: 3_600 } },
  profile: "testnet",
  service: { delaySeconds: 3_600, feeLux: 1_000_000_000n, network: "ethereum" },
};
// What the chains said: an output every 1,700 s, a 7-day proof maturity.
const timing = { chain: { withdrawal: { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 } } };
const deposit = { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-dusk-evm", mode: "duskevm-deposit", signer: "dusk", to: { id: "dusk-evm", kind: "evm" } };
const withdrawal = { from: { id: "dusk-evm", kind: "evm" }, id: "dusk-evm-to-dusk", mode: "duskevm-withdrawal", signer: "evm", to: { id: "dusk", kind: "dusk" } };
const service = { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-ethereum", mode: "service-transfer", signer: "dusk", to: { id: "ethereum", kind: "evm" } };
const migration = { from: { id: "ethereum", kind: "evm" }, id: "ethereum-to-dusk", mode: "migration", signer: "evm", to: { id: "dusk", kind: "dusk" } };
const DUSK_HASH = "ce".repeat(32);
const L2_HASH = `0x${"34".repeat(32)}`;
const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
const AMS = "Europe/Amsterdam";
// Times on a 24-hour clock, as an English or Dutch viewer sees them.
const GB = "en-GB";

test("explorer links point at each network's own explorer", () => {
  assert.equal(
    explorerTxUrl(cfg, "dusk", `0x${DUSK_HASH}`),
    `https://apps.testnet.dusk.network/explorer/transactions/transaction?id=${DUSK_HASH}`,
  );
  assert.equal(explorerTxUrl(cfg, "dusk-evm", "34".repeat(32)), `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`);
  assert.equal(explorerTxUrl(cfg, "ethereum", L2_HASH), `https://sepolia.etherscan.io/tx/${L2_HASH}`);
});

test("short forms are the same everywhere: 0x and 4 + 4, or 6 + 6", () => {
  assert.equal(short(EVM), "0x3E5B…a11d");
  // An address kept in lower case reads with its checksum's capitals, as wallets write it.
  assert.equal(short(EVM.toLowerCase()), "0x3E5B…a11d");
  assert.equal(short(ACCOUNT), "21n5nc…fMMLNz");
  assert.equal(short("abc"), "abc");
});

test("a deposit shows Pending with its steps, then Completed with both transactions", () => {
  const now = Date.UTC(2026, 9, 26, 9, 40);
  const sent = { amountLux: "25000000000", destination: EVM, hash: DUSK_HASH, sender: ACCOUNT, sentHere: true, sourceAt: Date.UTC(2026, 9, 26, 9, 31, 12), status: "pending" };
  const pending = transferView(sent, { cfg, now, route: deposit, locale: GB, timeZone: AMS });
  assert.equal(pending.title, "Sending 25 DUSK to DuskEVM");
  assert.equal(pending.statusWord, "Pending");
  assert.deepEqual(pending.steps.map((step) => [step.title, step.state]), [
    ["Sent from Dusk", "done"],
    ["Confirmed on Dusk", "done"],
    ["Arriving on DuskEVM", "now"],
  ]);
  assert.equal(pending.steps[0].href, `https://apps.testnet.dusk.network/explorer/transactions/transaction?id=${DUSK_HASH}`);
  assert.equal(pending.steps[1].atText, "Today, 10:31 CET");
  assert.equal(pending.steps[2].detail, "");
  assert.equal(pending.late, false);

  const done = transferView(
    { ...sent, destinationAt: Date.UTC(2026, 9, 26, 9, 31, 19), destinationHash: L2_HASH, status: "completed" },
    { cfg, now, route: deposit, locale: GB, timeZone: AMS, year: true },
  );
  assert.equal(done.title, "25 DUSK arrived on DuskEVM");
  assert.equal(done.statusWord, "Completed");
  assert.equal(done.steps[2].title, "Arrived on DuskEVM");
  assert.equal(done.steps[2].href, `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`);
  assert.equal(done.steps[2].atText, "Mon 26 Oct 2026, 10:31 CET");
  assert.equal(transferView({ hash: DUSK_HASH, note: "Nope.", status: "failed" }, { cfg, route: deposit }).statusWord, "Failed");

  // Late past twice its usual time and a quarter of an hour more: 16 minutes here.
  assert.equal(transferView(sent, { cfg, now: sent.sourceAt + 16 * 60_000, route: deposit }).late, false);
  const late = transferView(sent, { cfg, now: sent.sourceAt + 17 * 60_000, route: deposit });
  assert.equal(late.late, true);
  assert.match(transferSubline(late, sent, deposit, cfg, { locale: GB, timeZone: AMS }), / · taking longer than usual$/u);
  // Without a usual time on this network, nothing is late.
  const unknown = { ...cfg, duskEvm: { ...cfg.duskEvm, depositSeconds: null } };
  assert.equal(transferView(sent, { cfg: unknown, now: sent.sourceAt + 86_400_000, route: deposit }).late, false);
});

test("a payout to another chain says what arrives after the bridge fee", () => {
  const view = transferView({ amountLux: "50000000000", hash: DUSK_HASH, sourceAt: Date.UTC(2026, 9, 26, 9, 12), status: "pending" }, { cfg, now: Date.UTC(2026, 9, 26, 9, 30), route: service, locale: GB, timeZone: AMS });
  assert.equal(view.title, "Sending 50 DUSK to Ethereum (Sepolia)");
  assert.equal(
    transferSubline(view, { sourceAt: Date.UTC(2026, 9, 26, 9, 12) }, service, cfg, { locale: GB, now: Date.UTC(2026, 9, 26, 9, 30), timeZone: AMS }),
    "Sent Today, 10:12 CET · takes ~1 hour",
  );
  const done = transferView({ amountLux: "50000000000", hash: DUSK_HASH, status: "completed" }, { cfg, route: service });
  assert.equal(done.title, "49 DUSK arrived on Ethereum (Sepolia)");
  assert.equal(transferView({ amountLux: "1000000000000", hash: L2_HASH, status: "pending" }, { cfg, route: migration }).title, "Moving 1,000 ERC20 DUSK to Dusk");
});

test("a withdrawal shows its three steps, their times and the next action", () => {
  const sentAt = Date.UTC(2026, 9, 23, 14, 20);
  const now = Date.UTC(2026, 9, 28);
  const ready = transferView({ amountLux: "200000000000", hash: L2_HASH, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.deepEqual(ready.steps.map(({ title, state }) => [title, state]), [
    ["Sent on DuskEVM", "done"],
    ["Prove on Dusk", "turn"],
    ["Claim on Dusk", "todo"],
  ]);
  assert.equal(ready.steps[0].atText, "23 Oct, 16:20 CEST");
  // Its fee is the receipt's, next to the Prove button.
  assert.equal(ready.steps[1].detail, "Ready now");
  assert.equal(ready.steps[2].detail, "7 days after you prove");
  // Before it can be proved: from when it can, about an output after it was sent.
  const sent = transferView({ hash: L2_HASH, sourceAt: sentAt, stage: "waiting_for_output", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.equal(sent.steps[1].detail, "From about 23 Oct, 16:48 CEST");
  assert.equal(transferSubline(sent, { sourceAt: sentAt, stage: "waiting_for_output" }, withdrawal, cfg, { locale: GB, now, timeZone: AMS }), "Prove from about 23 Oct, 16:48 CEST");
  // Where the chain hasn't said, no time at all.
  const unread = transferView({ hash: L2_HASH, sourceAt: sentAt, stage: "waiting_for_output", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS });
  assert.deepEqual(unread.steps.slice(1).map(({ detail }) => detail), ["", ""]);
  assert.equal(transferSubline(unread, { sourceAt: sentAt, stage: "waiting_for_output" }, withdrawal, cfg, { locale: GB, now, timeZone: AMS }), "Sent 23 Oct, 16:20 CEST");
  assert.deepEqual(ready.action, { blocked: "", failure: "", kind: "prove", label: "Prove on Dusk" });
  assert.equal(ready.title, "Prove the withdrawal of 200 DUSK");
  assert.deepEqual(ready.tracker.map(({ label }) => label), ["Sent", "Prove now", "Claim"]);

  // Proven only by another account: the user still proves, and is told why.
  const other = transferView({ hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { cfg, route: withdrawal });
  assert.equal(other.steps[1].detail, "Another account proved it. Prove it yourself to claim it.");
  // Whom it pays where that's another account: the list and the review say the same.
  const paying = (destination, account) =>
    transferView({ destination, hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { account, cfg, route: withdrawal }).steps[1].detail;
  assert.equal(paying(ACCOUNT, ACCOUNT), "Another account proved it. Prove it yourself to claim it.");
  const stranger = `25z9o6${"x".repeat(40)}5Etftt`;
  // Proving and claiming it still pays that account: said plainly, by your .dusk name where you have one.
  assert.equal(paying(stranger, ACCOUNT), "Another account proved it. This pays 25z9o6…5Etftt, not your connected Dusk account. If you prove and claim, the DUSK still goes there.");
  assert.equal(paying(stranger, ""), "Another account proved it. This pays 25z9o6…5Etftt. If you prove and claim, the DUSK still goes there.");
  const named = { amountLux: "1008000000000", destination: stranger, hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" };
  const namedView = transferView(named, { account: ACCOUNT, cfg, name: "alice.dusk", route: withdrawal });
  assert.equal(namedView.steps[1].detail, "Another account proved it. This pays 25z9o6…5Etftt, not alice.dusk. If you prove and claim, the DUSK still goes there.");
  assert.equal(transferSubline(namedView, named, withdrawal, cfg, { account: ACCOUNT, name: "alice.dusk" }), namedView.steps[1].detail);
  // Not "your withdrawal": it may pay another account.
  assert.equal(namedView.title, "Prove the withdrawal of 1,008 DUSK");
  assert.equal(other.action.kind, "prove");
  assert.equal(other.tracker[1].label, "Proven by another");

  // Ready to claim with the proof this browser sent: only that account can.
  const proved = { hash: L2_HASH, id: "w", proofAccount: ACCOUNT, proofSubmitter: `0x${"2c".repeat(20)}`, proveHash: "ab".repeat(32), sourceAt: sentAt, stage: "ready_to_finalize", status: "pending" };
  const claimWith = (submitter) => transferView(proved, { cfg, route: withdrawal, submitter }).action;
  assert.equal(claimWith(`0x${"2C".repeat(20)}`).blocked, "");
  assert.equal(claimWith(null).blocked, "");
  // A prover counts only once a proof was sent from here, not as a guess.
  assert.equal(transferView({ ...proved, proveHash: undefined }, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}` }).action.blocked, "");
  const elsewhere = claimWith(`0x${"3d".repeat(20)}`);
  assert.equal(elsewhere.blocked, "Switch Dusk Wallet to 21n5nc…fMMLNz, the account that proved it. Only that account can claim.");
  assert.equal(transferView({ ...proved, proofAccount: undefined }, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}` }).action.blocked, "Switch Dusk Wallet to the account that proved it. Only that account can claim.");
  // The receipt and the list say so in place of the Claim button.
  const receipt = receiptPage({ ...receiptModel(proved, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}`, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  assert.match(receipt, /<p class="note">.*Switch Dusk Wallet to 21n5nc…fMMLNz, the account that proved it/u);
  assert.doesNotMatch(receipt, /data-action="withdrawal-finalize"/u);
  assert.match(transferRow({ action: elsewhere, amountText: "200 DUSK", href: "#", id: "w", pair: ["dusk-evm", "dusk"], status: "pending", statusWord: "Pending", subline: "", title: "DuskEVM to Dusk" }), /Switch account to claim/u);
  assert.match(receiptPage({ ...receiptModel(proved, { cfg, route: withdrawal, submitter: `0x${"2c".repeat(20)}`, url: "https://bridge.example/#/transfer/x" }), canAct: true }), /data-action="withdrawal-finalize"/u);
});

test("a waiting withdrawal counts down to its claim time, across a clock change", () => {
  const provenAt = Date.UTC(2026, 9, 24, 12, 38);
  const now = Date.UTC(2026, 9, 26, 9, 38);
  const waiting = transferView(
    {
      amountLux: "200000000000",
      destination: ACCOUNT,
      hash: L2_HASH,
      proveHash: DUSK_HASH,
      provenAt,
      readyAt: (provenAt + 7 * 86_400_000) / 1_000,
      readyAtExact: true,
      sourceAt: Date.UTC(2026, 9, 23, 14, 20),
      stage: "proven_waiting",
      status: "pending",
    },
    { cfg, now, route: withdrawal, locale: GB, timeZone: AMS },
  );
  assert.deepEqual(waiting.steps.map(({ state }) => state), ["done", "done", "now"]);
  assert.equal(waiting.steps[1].atText, "24 Oct, 14:38 CEST");
  assert.equal(waiting.steps[1].detail, "By you");
  assert.equal(waiting.steps[1].hash, DUSK_HASH);
  assert.deepEqual(
    { at: waiting.countdown.atText, exact: waiting.countdown.exact, left: waiting.countdown.left, note: waiting.countdown.clockNote },
    { at: "31 Oct, 13:38 CET", exact: true, left: "5 days 3 hours", note: "clocks went back on 25 Oct" },
  );
  assert.equal(waiting.tracker[2].label, "Claim in 5 days 3 hours");
  assert.equal(
    transferSubline(waiting, { readyAt: (provenAt + 7 * 86_400_000) / 1_000, stage: "proven_waiting" }, withdrawal, cfg, { now, locale: GB, timeZone: AMS }),
    "Claim from 31 Oct, 13:38 CET · 5 days 3 hours left",
  );
  assert.equal(waiting.action, null);

  const rejected = transferView({ hash: L2_HASH, proofRejected: true, stage: "proven_waiting", status: "pending" }, { cfg, now, route: withdrawal });
  assert.equal(rejected.steps[2].detail, "The proof was rejected. Prove again once DuskEVM reports a new output.");
  assert.equal(rejected.countdown, null);

  const refused = transferView({ actionError: WITHDRAWAL_GAS_REFUSAL, hash: L2_HASH, stage: "ready_to_finalize", status: "pending" }, { cfg, route: withdrawal });
  assert.equal(refused.action.label, "Claim on Dusk");
  assert.equal(refused.action.failure, WITHDRAWAL_GAS_REFUSAL);
  assert.equal(refused.title, "DUSK is ready to claim");
});

test("what becomes public names the accounts themselves, not a label", () => {
  // By its .dusk name too, as the wallet's window says it.
  assert.equal(
    privacyLine(deposit, cfg, { dusk: ACCOUNT, evm: EVM, name: "alice.dusk" }),
    "Public on Dusk and DuskEVM, and linked: your Dusk account alice.dusk (21n5nc…fMMLNz), 0x3E5B…a11d and the amount.",
  );
  assert.equal(
    privacyLine(deposit, cfg, { dusk: ACCOUNT, evm: EVM }),
    "Public on Dusk and DuskEVM, and linked: your Dusk account 21n5nc…fMMLNz, 0x3E5B…a11d and the amount.",
  );
  // From the sending side to the paid one, on both networks.
  assert.equal(
    privacyLine(migration, cfg, { dusk: ACCOUNT, evm: EVM }),
    "Public on Ethereum (Sepolia) and Dusk, and linked: 0x3E5B…a11d, the Dusk account 21n5nc…fMMLNz and the amount.",
  );
  assert.equal(privacyLine(service, cfg, {}), "Public on Dusk and Ethereum (Sepolia), and linked: your Dusk account, your EVM address and the amount.");
});

test("wallet errors say what happened, naming the wallet", () => {
  assert.equal(friendlyWalletError({ code: 4001 }), "You cancelled in your wallet, so nothing was sent.");
  // viem wraps an EVM wallet's rejection in its own error.
  assert.equal(
    friendlyWalletError({ cause: { code: 4001 }, shortMessage: "User rejected the request." }, "evm"),
    "You cancelled in your wallet, so nothing was sent.",
  );
  assert.match(friendlyWalletError({ code: 4100, message: "Wallet locked" }), /^The Dusk wallet is locked/u);
  assert.match(friendlyWalletError({ code: 4100 }, "evm"), /^The EVM wallet is locked/u);
  assert.match(friendlyWalletError({ code: 4900 }, "evm"), /^The EVM wallet disconnected/u);
});

test("a rejected proof isn't shown as proven, and promises no claim", () => {
  const at = Date.UTC(2026, 9, 20, 12);
  // The Portal rejected the proof and a new output is out: prove again.
  const again = transferView({ hash: L2_HASH, proveAt: at, provenAt: at, sourceAt: at - 3_600_000, stage: "ready_to_prove", status: "pending" }, { cfg, route: withdrawal });
  assert.deepEqual([again.steps[1].title, again.steps[1].state], ["Prove on Dusk", "turn"]);
  assert.equal(again.action.kind, "prove");
  // Rejected, with no new output yet: no claim date, here or in the list.
  const rejected = { hash: L2_HASH, proofRejected: true, provenAt: at, sourceAt: at - 3_600_000, stage: "proven_waiting", status: "pending" };
  const view = transferView(rejected, { cfg, now: at + 86_400_000, route: withdrawal });
  assert.equal(transferSubline(view, rejected, withdrawal, cfg, { now: at + 86_400_000 }), "The proof was rejected. Prove again once DuskEVM reports a new output.");
});

test("a withdrawal's card dates each step: sent, proven, and from when it can be claimed", () => {
  const sentAt = Date.UTC(2026, 8, 24, 10, 0);
  const provenAt = Date.UTC(2026, 8, 25, 10, 0);
  // The claim date is the chain's: none is made up from the proof and a fixed wait.
  const unread = transferView(
    { amountLux: "1008000000000", hash: L2_HASH, provenAt, sourceAt: sentAt, stage: "proven_waiting", status: "pending" },
    { cfg, now: provenAt + 60_000, route: withdrawal, locale: GB, timeZone: AMS, timing },
  );
  assert.equal(unread.tracker[2].when, "");
  assert.equal(unread.countdown, null);
  assert.equal(unread.steps[2].detail, "7 days after the proof at the soonest");
  const waiting = transferView(
    { amountLux: "1008000000000", hash: L2_HASH, provenAt, readyAt: (provenAt + 7 * 86_400_000) / 1_000, sourceAt: sentAt, stage: "proven_waiting", status: "pending" },
    { cfg, now: provenAt + 60_000, route: withdrawal, locale: GB, timeZone: AMS, timing },
  );
  assert.deepEqual(waiting.tracker.map(({ label, when }) => [label, when]), [
    ["Sent", "24 Sept"],
    ["Proven", "25 Sept"],
    ["Claim in 6 days 23 hours", "from about 2 Oct"],
  ]);
  const html = transferRow({ amountText: "1,008 DUSK", href: "#/t", id: "w", pair: ["dusk-evm", "dusk"], status: "pending", statusWord: "Pending", subline: "", title: "DuskEVM to Dusk", tracker: waiting.tracker });
  assert.match(html, /<span>Sent<\/span><span class="when">24 Sept<\/span>/u);
  assert.match(html, /Claim in 6 days 23 hours from about 2 Oct: in progress/u);
  // Claimed: its day; not sent yet: none.
  const claimedAt = Date.UTC(2026, 9, 2, 12, 0);
  const claimed = transferView({ claimAt: claimedAt, hash: L2_HASH, provenAt, sourceAt: sentAt, stage: "finalized", status: "completed" }, { cfg, route: withdrawal, locale: GB, timeZone: AMS });
  assert.deepEqual(claimed.tracker.map(({ when }) => when), ["24 Sept", "25 Sept", "2 Oct"]);
  assert.deepEqual(transferView({ hash: L2_HASH, stage: "submitted", status: "pending" }, { cfg, route: withdrawal }).tracker.map(({ when }) => when), ["", "", ""]);
});

test("after the proof, the claim date reads as the chain gives it: exact, about, or late at the soonest", () => {
  // wallet-both.dusk's withdrawal: proved 26 Oct, 03:20:39 UTC; claimable from 2 Nov, 03:20:39 UTC.
  const provenAt = Date.UTC(2026, 9, 26, 3, 20, 39);
  const at = Date.UTC(2026, 10, 2, 3, 20, 39);
  const now = Date.UTC(2026, 9, 28, 3, 10);
  const base = { amountLux: "1000000000", hash: L2_HASH, provenAt, readyAt: at / 1_000, sourceAt: provenAt - 86_400_000, stage: "proven_waiting", status: "pending" };
  const view = (patch) => transferView({ ...base, ...patch }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  const subline = (patch) => transferSubline(view(patch), { ...base, ...patch }, withdrawal, cfg, { now, locale: GB, timeZone: AMS });
  // Exact once its game has resolved.
  assert.equal(view({ readyAtExact: true }).countdown.line, "Claim from 2 Nov, 04:20 CET");
  assert.equal(subline({ readyAtExact: true }), "Claim from 2 Nov, 04:20 CET · 5 days left");
  // Before that, the earliest: "about".
  assert.equal(view({}).countdown.line, "Claim from about 2 Nov, 04:20 CET");
  // Its game's resolution late: at the soonest.
  const late = view({ claimOverdue: true });
  assert.equal(late.countdown.line, "Waiting for DuskEVM to settle this proof. Claim from 2 Nov, 04:20 CET at the soonest.");
  assert.equal(subline({ claimOverdue: true }), late.countdown.line);
  // The receipt says it under the countdown, and its claim step doesn't repeat it.
  const model = receiptModel({ ...base }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing, url: "https://bridge.example/#/transfer/x" });
  assert.equal(model.view.steps[2].detail, "");
  assert.match(receiptPage({ ...model, canAct: true }), /<div class="k">You can claim in<\/div><div class="v">5 days<\/div><div class="s">Claim from about Mon 2 Nov 2026, 04:20 CET<\/div>/u);
});

test("a late claim says only the wait and its soonest date: no countdown, nothing for a calendar", () => {
  // Its game unresolved an hour past its clock: the date moves on with each check.
  const provenAt = Date.UTC(2026, 9, 26, 3, 20, 39);
  const now = Date.UTC(2026, 9, 28, 3, 10);
  const entry = { amountLux: "1000000000", claimOverdue: true, hash: L2_HASH, provenAt, readyAt: Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000, sourceAt: provenAt - 86_400_000, stage: "proven_waiting", status: "pending" };
  const model = receiptModel(entry, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing, url: "https://bridge.example/#/transfer/x" });
  const html = receiptPage({ ...model, canAct: true });
  assert.match(html, /<div class="group count"><p>Waiting for DuskEVM to settle this proof\. Claim from Mon 2 Nov 2026, 04:20 CET at the soonest\.<\/p><\/div>/u);
  assert.doesNotMatch(html, /You can claim in/u);
  assert.doesNotMatch(html, /data-action="calendar"/u);
  // In My transfers, its claim step counts down to nothing either.
  const view = transferView(entry, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.deepEqual([view.tracker[2].label, view.tracker[2].when], ["Claim", "from 2 Nov at the soonest"]);
});

test("a proof or claim you rejected in your wallet says so in grey, as a deposit's review does, not as a failure", () => {
  // Kept on the transfer: a rejection as itself, anything else as its reason.
  assert.equal(actionErrorOf({ code: 4001, message: "User rejected the request." }), WALLET_CANCELLED);
  assert.equal(actionErrorOf({ cause: { code: 4001 } }), WALLET_CANCELLED);
  assert.equal(actionErrorOf(new Error("The node refused it.")), "The node refused it.");
  const at = Date.UTC(2026, 9, 7, 7, 7);
  const entry = { actionError: WALLET_CANCELLED, amountLux: "1008000000000", hash: L2_HASH, id: "w", provenByOther: true, sourceAt: at, stage: "ready_to_prove", status: "pending" };
  const view = transferView(entry, { cfg, route: withdrawal });
  assert.equal(view.action.failure, "You cancelled in your wallet, so nothing was sent.");
  const receipt = receiptPage({ ...receiptModel(entry, { cfg, route: withdrawal, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  assert.match(receipt, /<div class="action-box"><p class="message">You cancelled in your wallet, so nothing was sent\.<\/p><button type="button" class="btn pri" data-action="withdrawal-prove"/u);
  assert.doesNotMatch(receipt, /message error|Try again/u);
  // A proof that did fail is still red, and offered again.
  const failed = receiptPage({ ...receiptModel({ ...entry, actionError: "Proof transaction failed: out of gas" }, { cfg, route: withdrawal, url: "x" }), canAct: true });
  assert.match(failed, /<p class="message error">The proof wasn&#039;t sent\. Try again\.<\/p>/u);
  // In the review, the same: grey for a rejection, red for a failure.
  const sheet = (error) => reviewSheet({ canConfirm: true, cfgLinks: { explorer: () => null }, checks: [], confirmLabel: "Prove on Dusk", error, feeRows: [], lead: { amount: "0.051", label: "Proving costs up to", line: "" }, privacy: "x", steps: [], sub: "", walletCheckName: "Dusk Wallet" });
  assert.match(sheet(WALLET_CANCELLED), /<div class="sheet-foot"><p class="message" role="status">You cancelled in your wallet, so nothing was sent\.<\/p>/u);
  assert.match(sheet("The Dusk wallet disconnected. Reconnect it and try again."), /<p class="message error" role="alert">The Dusk wallet disconnected/u);
});
