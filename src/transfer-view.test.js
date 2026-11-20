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
import { proofSubmitterFor } from "./services.js";
import { receiptPage, transferRow } from "./views.js";

const cfg = {
  dusk: { explorerUrl: "https://explorer.testnet.dusk.network/" },
  duskEvm: { depositSeconds: 60, explorerUrl: "https://explorer.testnet.evm.dusk.network" },
  evmNetworks: { ethereum: { chainName: "Sepolia", explorerUrl: "https://sepolia.etherscan.io", migrationSeconds: 3_600 } },
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
// The DUSK amounts a line says, whatever words it says them with.
const amountsIn = (text) => [...String(text).matchAll(/\d[\d,]*(?:\.\d+)? (?:[A-Z0-9]+ )?DUSK\b/gu)].map((match) => match[0]);
const states = (items) => items.map(({ state }) => state);

test("explorer links point at each network's own explorer", () => {
  assert.equal(
    explorerTxUrl(cfg, "dusk", `0x${DUSK_HASH}`),
    `https://explorer.testnet.dusk.network/transactions/transaction?id=${DUSK_HASH}`,
  );
  assert.equal(explorerTxUrl(cfg, "dusk-evm", "34".repeat(32)), `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`);
  assert.equal(explorerTxUrl(cfg, "ethereum", L2_HASH), `https://sepolia.etherscan.io/tx/${L2_HASH}`);
});

test("short forms are the same everywhere: 0x and 4 + 4, or 6 + 6", () => {
  assert.equal(short(EVM), "0x3E5B…a11d");
  // An address kept in lower case reads with its checksum's capitals, as wallets write it.
  assert.equal(short(EVM.toLowerCase()), "0x3E5B…a11d");
  assert.equal(short(ACCOUNT), "21n5nc…fMMLNz");
  // An EVM transaction is cut as an EVM address is.
  assert.equal(short("0x04a8a8977dd251da49bd8997cf4d063ddc385f8d29b437b119bb3c79c11b3213"), "0x04a8…3213");
  // Dusk hashes and contract IDs: 6 + 6, in lower case.
  assert.equal(short(DUSK_HASH), "cecece…cecece");
  assert.equal(short("14EEB3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9"), "14eeb3…3fb1b9");
  assert.equal(short("abc"), "abc");
});

test("a deposit is pending through its steps, then completed with both transactions", () => {
  const now = Date.UTC(2026, 9, 26, 9, 40);
  const sent = { amountLux: "25000000000", destination: EVM, hash: DUSK_HASH, sender: ACCOUNT, sentHere: true, sourceAt: Date.UTC(2026, 9, 26, 9, 31, 12), status: "pending" };
  const pending = transferView(sent, { cfg, now, route: deposit, locale: GB, timeZone: AMS });
  assert.deepEqual(amountsIn(pending.title), ["25 DUSK"]);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.steps.map(({ key, state }) => [key, state]), [
    ["sent", "done"],
    ["confirmed", "done"],
    ["arrived", "now"],
  ]);
  assert.equal(pending.steps[0].href, `https://explorer.testnet.dusk.network/transactions/transaction?id=${DUSK_HASH}`);
  assert.equal(pending.steps[2].detail, "");
  assert.equal(pending.late, false);

  const done = transferView(
    { ...sent, destinationAt: Date.UTC(2026, 9, 26, 9, 31, 19), destinationHash: L2_HASH, status: "completed" },
    { cfg, now, route: deposit, locale: GB, timeZone: AMS, year: true },
  );
  assert.deepEqual(amountsIn(done.title), ["25 DUSK"]);
  assert.equal(done.status, "completed");
  assert.equal(done.steps[2].state, "done");
  assert.equal(done.steps[2].href, `https://explorer.testnet.evm.dusk.network/tx/${L2_HASH}`);
  assert.equal(transferView({ hash: DUSK_HASH, note: "Nope.", status: "failed" }, { cfg, route: deposit }).status, "failed");

  // Late past twice its usual time and a quarter of an hour more: 16 minutes here.
  assert.equal(transferView(sent, { cfg, now: sent.sourceAt + 16 * 60_000, route: deposit }).late, false);
  assert.equal(transferView(sent, { cfg, now: sent.sourceAt + 17 * 60_000, route: deposit }).late, true);
  // Without a usual time on this network, nothing is late.
  const unknown = { ...cfg, duskEvm: { ...cfg.duskEvm, depositSeconds: null } };
  assert.equal(transferView(sent, { cfg: unknown, now: sent.sourceAt + 86_400_000, route: deposit }).late, false);
});

test("a payout to another chain says what arrives after the bridge fee", () => {
  const view = transferView({ amountLux: "50000000000", hash: DUSK_HASH, sourceAt: Date.UTC(2026, 9, 26, 9, 12), status: "pending" }, { cfg, now: Date.UTC(2026, 9, 26, 9, 30), route: service, locale: GB, timeZone: AMS });
  assert.deepEqual(amountsIn(view.title), ["50 DUSK"]);
  assert.match(transferSubline(view, { sourceAt: Date.UTC(2026, 9, 26, 9, 12) }, service, cfg, { locale: GB, now: Date.UTC(2026, 9, 26, 9, 30), timeZone: AMS }), /~1 hour/u);
  const done = transferView({ amountLux: "50000000000", hash: DUSK_HASH, status: "completed" }, { cfg, route: service });
  assert.deepEqual(amountsIn(done.title), ["49 DUSK"]);
  assert.deepEqual(amountsIn(transferView({ amountLux: "1000000000000", hash: L2_HASH, status: "pending" }, { cfg, route: migration }).title), ["1,000 ERC20 DUSK"]);
});

test("a withdrawal shows its three steps, their times and the next action", () => {
  const sentAt = Date.UTC(2026, 9, 23, 14, 20);
  const now = Date.UTC(2026, 9, 28);
  const ready = transferView({ amountLux: "200000000000", hash: L2_HASH, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.deepEqual(ready.steps.map(({ key, state }) => [key, state]), [
    ["sent", "done"],
    ["prove", "turn"],
    ["claim", "todo"],
  ]);
  assert.match(ready.steps[2].detail, /7 days/u);
  // Before it can be proved: from when it can, about an output after it was sent.
  const sent = transferView({ hash: L2_HASH, sourceAt: sentAt, stage: "waiting_for_output", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.match(sent.steps[1].detail, /23 Oct, 16:48/u);
  assert.match(transferSubline(sent, { sourceAt: sentAt, stage: "waiting_for_output" }, withdrawal, cfg, { locale: GB, now, timeZone: AMS }), /23 Oct, 16:48/u);
  // Where the chain hasn't said, no time at all.
  const unread = transferView({ hash: L2_HASH, sourceAt: sentAt, stage: "waiting_for_output", status: "pending" }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS });
  assert.deepEqual(unread.steps.slice(1).map(({ detail }) => detail), ["", ""]);
  assert.doesNotMatch(transferSubline(unread, { sourceAt: sentAt, stage: "waiting_for_output" }, withdrawal, cfg, { locale: GB, now, timeZone: AMS }), /16:48/u);
  const { blocked, command, failure, kind, quiet } = ready.action;
  assert.deepEqual({ blocked, command, failure, kind, quiet }, { blocked: "", command: "withdrawal-prove", failure: "", kind: "prove", quiet: false });
  assert.deepEqual(amountsIn(ready.title), ["200 DUSK"]);
  assert.deepEqual(states(ready.tracker), ["done", "turn", "todo"]);

  // Proven only by another account: the user still proves.
  const other = transferView({ hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { cfg, route: withdrawal });
  assert.equal(other.steps[1].state, "turn");
  assert.equal(other.action.kind, "prove");
  // Whom it pays where that's another account: the list and the review say the same, naming it.
  const paying = (destination, account) =>
    transferView({ destination, hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" }, { account, cfg, route: withdrawal }).steps[1].detail;
  assert.doesNotMatch(paying(ACCOUNT, ACCOUNT), /21n5nc…fMMLNz/u);
  const stranger = `25z9o6${"x".repeat(40)}5Etftt`;
  // Proving and claiming it still pays that account: said plainly, by your .dusk name where you have one.
  assert.match(paying(stranger, ACCOUNT), /25z9o6…5Etftt/u);
  assert.match(paying(stranger, ""), /25z9o6…5Etftt/u);
  const named = { amountLux: "1008000000000", destination: stranger, hash: L2_HASH, provenByOther: true, sourceAt: sentAt, stage: "ready_to_prove", status: "pending" };
  const namedView = transferView(named, { account: ACCOUNT, cfg, name: "alice.dusk", route: withdrawal });
  assert.match(namedView.steps[1].detail, /25z9o6…5Etftt/u);
  assert.match(namedView.steps[1].detail, /alice\.dusk/u);
  assert.equal(transferSubline(namedView, named, withdrawal, cfg, { account: ACCOUNT, name: "alice.dusk" }), namedView.steps[1].detail);
  assert.deepEqual(amountsIn(namedView.title), ["1,008 DUSK"]);

  // Ready to claim with the proof this browser sent: only that account can.
  const proved = { hash: L2_HASH, id: "w", proofAccount: ACCOUNT, proofSubmitter: `0x${"2c".repeat(20)}`, proveHash: "ab".repeat(32), sourceAt: sentAt, stage: "ready_to_finalize", status: "pending" };
  const claimWith = (submitter) => transferView(proved, { cfg, route: withdrawal, submitter }).action;
  assert.equal(claimWith(`0x${"2C".repeat(20)}`).blocked, "");
  assert.equal(claimWith(null).blocked, "");
  // A prover counts only once a proof was sent from here, not as a guess.
  assert.equal(transferView({ ...proved, proveHash: undefined }, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}` }).action.blocked, "");
  const elsewhere = claimWith(`0x${"3d".repeat(20)}`);
  assert.match(elsewhere.blocked, /21n5nc…fMMLNz/u);
  assert.ok(transferView({ ...proved, proofAccount: undefined }, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}` }).action.blocked);
  // The receipt and the list say so in place of the Claim button.
  const receipt = receiptPage({ ...receiptModel(proved, { cfg, route: withdrawal, submitter: `0x${"3d".repeat(20)}`, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  assert.ok(receipt.includes(elsewhere.blocked), receipt);
  assert.doesNotMatch(receipt, /data-action="withdrawal-finalize"/u);
  const row = (action) => transferRow({ action, amountText: "200 DUSK", href: "#", id: "w", pair: ["dusk-evm", "dusk"], status: "pending", statusWord: "Pending", subline: "", title: "DuskEVM to Dusk" });
  assert.doesNotMatch(row(elsewhere), /data-action="withdrawal-finalize"/u);
  assert.match(row(claimWith(null)), /data-action="withdrawal-finalize"/u);
  assert.match(receiptPage({ ...receiptModel(proved, { cfg, route: withdrawal, submitter: `0x${"2c".repeat(20)}`, url: "https://bridge.example/#/transfer/x" }), canAct: true }), /data-action="withdrawal-finalize"/u);
});

test("a withdrawal that pays someone else asks nothing of you: no turn of yours, and a quiet Prove", () => {
  const stranger = `213qXN${"x".repeat(40)}V5JJ9Y`;
  const entry = { amountLux: "1008000000000", destination: stranger, hash: L2_HASH, id: "w", provenByOther: true, sourceAt: Date.UTC(2026, 9, 7, 7, 7), stage: "ready_to_prove", status: "pending" };
  const view = transferView(entry, { account: ACCOUNT, cfg, name: "alice.dusk", route: withdrawal, timing });
  assert.equal(view.action.quiet, true);
  assert.deepEqual(states(view.steps), ["done", "now", "todo"]);
  assert.deepEqual(states(view.tracker), ["done", "now", "todo"]);
  // Its receipt still offers Prove.
  const receipt = receiptPage({ ...receiptModel(entry, { cfg, own: { account: ACCOUNT, name: "alice.dusk" }, route: withdrawal, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  assert.match(receipt, /data-action="withdrawal-prove" data-id="w"/u);
  // A followed account counts as the one it's for.
  assert.equal(transferView(entry, { cfg, owner: ACCOUNT, route: withdrawal }).action.quiet, true);
  // One that pays you, or with no Dusk account known, is yours to prove.
  for (const [patch, options] of [[{ destination: ACCOUNT }, { account: ACCOUNT }], [{}, {}]]) {
    const own = transferView({ ...entry, ...patch }, { ...options, cfg, route: withdrawal });
    assert.deepEqual([own.action.quiet, own.steps[1].state], [false, "turn"]);
  }
  // Once you proved it, only you can claim with that proof: a Claim like any other.
  const proved = { ...entry, provenByOther: false, stage: "ready_to_finalize", stageSubmitter: proofSubmitterFor(ACCOUNT) };
  const claim = transferView(proved, { account: ACCOUNT, cfg, route: withdrawal });
  assert.deepEqual([claim.action.kind, claim.action.quiet, claim.steps[2].state], ["finalize", false, "turn"]);
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
  assert.deepEqual(states(waiting.steps), ["done", "done", "now"]);
  assert.equal(waiting.steps[1].hash, DUSK_HASH);
  // Seven days after the proof, on the viewer's clock: an hour earlier once the clocks went back.
  assert.deepEqual(
    { at: waiting.countdown.atText, exact: waiting.countdown.exact, left: waiting.countdown.left },
    { at: "31 Oct, 13:38 CET", exact: true, left: "5 days 3 hours" },
  );
  assert.match(waiting.tracker[2].label, /5 days 3 hours/u);
  const subline = transferSubline(waiting, { readyAt: (provenAt + 7 * 86_400_000) / 1_000, stage: "proven_waiting" }, withdrawal, cfg, { now, locale: GB, timeZone: AMS });
  assert.match(subline, /31 Oct, 13:38/u);
  assert.match(subline, /5 days 3 hours/u);
  assert.equal(waiting.action, null);

  const rejected = transferView({ hash: L2_HASH, proofRejected: true, stage: "proven_waiting", status: "pending" }, { cfg, now, route: withdrawal });
  assert.equal(rejected.countdown, null);

  const refused = transferView({ actionError: WITHDRAWAL_GAS_REFUSAL, hash: L2_HASH, stage: "ready_to_finalize", status: "pending" }, { cfg, route: withdrawal });
  assert.equal(refused.action.kind, "finalize");
  assert.equal(refused.action.failure, WITHDRAWAL_GAS_REFUSAL);
});

test("what becomes public names the accounts themselves, not a label", () => {
  // By its .dusk name too, as the wallet's window says it.
  const named = privacyLine(deposit, cfg, { dusk: ACCOUNT, evm: EVM, name: "alice.dusk" });
  for (const shown of [/alice\.dusk/u, /21n5nc…fMMLNz/u, /0x3E5B…a11d/u]) assert.match(named, shown);
  const plain = privacyLine(deposit, cfg, { dusk: ACCOUNT, evm: EVM });
  for (const shown of [/21n5nc…fMMLNz/u, /0x3E5B…a11d/u]) assert.match(plain, shown);
  // From the sending side to the paid one, on both networks.
  const back = privacyLine(migration, cfg, { dusk: ACCOUNT, evm: EVM });
  for (const shown of [/0x3E5B…a11d/u, /21n5nc…fMMLNz/u]) assert.match(back, shown);
  assert.ok(privacyLine(service, cfg, {}));
});

test("wallet errors say what happened, naming the wallet", () => {
  assert.equal(friendlyWalletError({ code: 4001 }), WALLET_CANCELLED);
  // viem wraps an EVM wallet's rejection in its own error.
  assert.equal(friendlyWalletError({ cause: { code: 4001 }, shortMessage: "User rejected the request." }, "evm"), WALLET_CANCELLED);
  assert.match(friendlyWalletError({ code: 4100, message: "Wallet locked" }), /\bDusk\b/u);
  assert.match(friendlyWalletError({ code: 4100 }, "evm"), /\bEVM\b/u);
  assert.match(friendlyWalletError({ code: 4900 }, "evm"), /\bEVM\b/u);
  // Locked and disconnected are told apart.
  assert.notEqual(friendlyWalletError({ code: 4100 }, "evm"), friendlyWalletError({ code: 4900 }, "evm"));
});

test("a rejected proof isn't shown as proven, and promises no claim", () => {
  const at = Date.UTC(2026, 9, 20, 12);
  // The Portal rejected the proof and a new output is out: prove again.
  const again = transferView({ hash: L2_HASH, proveAt: at, provenAt: at, sourceAt: at - 3_600_000, stage: "ready_to_prove", status: "pending" }, { cfg, route: withdrawal });
  assert.deepEqual([again.steps[1].key, again.steps[1].state], ["prove", "turn"]);
  assert.equal(again.action.kind, "prove");
  // Rejected, with no new output yet: no claim date, here or in the list.
  const rejected = { hash: L2_HASH, proofRejected: true, provenAt: at, sourceAt: at - 3_600_000, stage: "proven_waiting", status: "pending" };
  const view = transferView(rejected, { cfg, now: at + 86_400_000, route: withdrawal });
  assert.equal(view.countdown, null);
  assert.equal(view.tracker[2].when, "");
});

test("a withdrawal's card dates each step: sent, proved, and from when it can be claimed", () => {
  const sentAt = Date.UTC(2026, 8, 24, 10, 0);
  const provenAt = Date.UTC(2026, 8, 25, 10, 0);
  // The claim date is the chain's: none is made up from the proof and a fixed wait.
  const unread = transferView(
    { amountLux: "1008000000000", hash: L2_HASH, provenAt, sourceAt: sentAt, stage: "proven_waiting", status: "pending" },
    { cfg, now: provenAt + 60_000, route: withdrawal, locale: GB, timeZone: AMS, timing },
  );
  assert.equal(unread.tracker[2].when, "");
  assert.equal(unread.countdown, null);
  assert.match(unread.steps[2].detail, /7 days/u);
  const waiting = transferView(
    { amountLux: "1008000000000", hash: L2_HASH, provenAt, readyAt: (provenAt + 7 * 86_400_000) / 1_000, sourceAt: sentAt, stage: "proven_waiting", status: "pending" },
    { cfg, now: provenAt + 60_000, route: withdrawal, locale: GB, timeZone: AMS, timing },
  );
  const whens = waiting.tracker.map(({ when }) => when);
  assert.deepEqual(whens.slice(0, 2), ["24 Sept", "25 Sept"]);
  assert.match(whens[2], /2 Oct/u);
  assert.match(waiting.tracker[2].label, /6 days 23 hours/u);
  // Claimed: its day; not sent yet: none.
  const claimedAt = Date.UTC(2026, 9, 2, 12, 0);
  const claimed = transferView({ claimAt: claimedAt, hash: L2_HASH, provenAt, sourceAt: sentAt, stage: "finalized", status: "completed" }, { cfg, route: withdrawal, locale: GB, timeZone: AMS });
  assert.deepEqual(claimed.tracker.map(({ when }) => when), ["24 Sept", "25 Sept", "2 Oct"]);
  assert.deepEqual(transferView({ hash: L2_HASH, stage: "submitted", status: "pending" }, { cfg, route: withdrawal }).tracker.map(({ when }) => when), ["", "", ""]);
});

test("after the proof, the claim date is the chain's: exact, about, or late at the soonest", () => {
  // wallet-both.dusk's withdrawal: proved 26 Oct, 03:20:39 UTC; claimable from 2 Nov, 03:20:39 UTC.
  const provenAt = Date.UTC(2026, 9, 26, 3, 20, 39);
  const at = Date.UTC(2026, 10, 2, 3, 20, 39);
  const now = Date.UTC(2026, 9, 28, 3, 10);
  const base = { amountLux: "1000000000", hash: L2_HASH, provenAt, readyAt: at / 1_000, sourceAt: provenAt - 86_400_000, stage: "proven_waiting", status: "pending" };
  const view = (patch) => transferView({ ...base, ...patch }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  const subline = (patch) => transferSubline(view(patch), { ...base, ...patch }, withdrawal, cfg, { now, locale: GB, timeZone: AMS });
  const countdown = (patch) => (({ at: when, exact, overdue }) => [when, exact, overdue])(view(patch).countdown);
  // Exact once its game has resolved; before that, the earliest; its game's resolution late: at the soonest.
  assert.deepEqual(countdown({ readyAtExact: true }), [at, true, false]);
  assert.deepEqual(countdown({}), [at, false, false]);
  assert.deepEqual(countdown({ claimOverdue: true }), [at, false, true]);
  for (const patch of [{ readyAtExact: true }, {}, { claimOverdue: true }]) assert.match(view(patch).countdown.line, /2 Nov, 04:20 CET/u);
  assert.match(subline({ readyAtExact: true }), /5 days/u);
  assert.equal(subline({ claimOverdue: true }), view({ claimOverdue: true }).countdown.line);
  // The receipt says it under the countdown, and its claim step doesn't repeat it.
  const model = receiptModel({ ...base }, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing, url: "https://bridge.example/#/transfer/x" });
  assert.equal(model.view.steps[2].detail, "");
  const html = receiptPage({ ...model, canAct: true });
  assert.match(html, /5 days/u);
  assert.match(html, /2 Nov 2026, 04:20 CET/u);
});

test("a late claim says only the wait and its soonest date: no countdown, nothing for a calendar", () => {
  // Its game unresolved an hour past its clock: the date moves on with each check.
  const provenAt = Date.UTC(2026, 9, 26, 3, 20, 39);
  const now = Date.UTC(2026, 9, 28, 3, 10);
  const entry = { amountLux: "1000000000", claimOverdue: true, hash: L2_HASH, provenAt, readyAt: Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000, sourceAt: provenAt - 86_400_000, stage: "proven_waiting", status: "pending" };
  const model = receiptModel(entry, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing, url: "https://bridge.example/#/transfer/x" });
  const html = receiptPage({ ...model, canAct: true });
  assert.match(html, /2 Nov 2026, 04:20 CET/u);
  assert.doesNotMatch(html, /\b5 days\b/u);
  assert.doesNotMatch(html, /data-action="calendar"/u);
  // In My transfers, its claim step counts down to nothing either.
  const view = transferView(entry, { cfg, now, route: withdrawal, locale: GB, timeZone: AMS, timing });
  assert.doesNotMatch(view.tracker[2].label, /\d/u);
  assert.match(view.tracker[2].when, /2 Nov/u);
});

test("a proof or claim you rejected in your wallet is no failure: it says so, and offers the step again", () => {
  // Kept on the transfer: a rejection as itself, anything else as its reason.
  assert.equal(actionErrorOf({ code: 4001, message: "User rejected the request." }), WALLET_CANCELLED);
  assert.equal(actionErrorOf({ cause: { code: 4001 } }), WALLET_CANCELLED);
  assert.equal(actionErrorOf(new Error("The node refused it.")), "The node refused it.");
  const at = Date.UTC(2026, 9, 7, 7, 7);
  const entry = { actionError: WALLET_CANCELLED, amountLux: "1008000000000", hash: L2_HASH, id: "w", provenByOther: true, sourceAt: at, stage: "ready_to_prove", status: "pending" };
  const view = transferView(entry, { cfg, route: withdrawal });
  assert.equal(view.action.failure, WALLET_CANCELLED);
  const receipt = receiptPage({ ...receiptModel(entry, { cfg, route: withdrawal, url: "https://bridge.example/#/transfer/x" }), canAct: true });
  assert.match(receipt, /data-action="withdrawal-prove"/u);
  // A proof that did fail says something else, and is offered again.
  const failed = transferView({ ...entry, actionError: "Proof transaction failed: out of gas" }, { cfg, route: withdrawal });
  assert.ok(failed.action.failure);
  assert.notEqual(failed.action.failure, WALLET_CANCELLED);
  assert.equal(failed.action.kind, "prove");
});

test("a finished transfer out lists what arrived, as the receipt says it, not what was sent", () => {
  const sent = { amountLux: "3000000000", destination: "0x5a3D8e1B7c2f4A6b9E0d1C3f5a7B9c2D4e6F8a01", hash: "ab".repeat(32), routeId: service.id, status: "pending" };
  const withFee = { ...cfg, service: { ...cfg.service, feeLux: 1_000_000_000n } };
  const view = (entry) => transferView(entry, { cfg: withFee, route: service });

  assert.match(view(sent).amountText, /^3\b/u);
  assert.match(view({ ...sent, destinationAt: 1, status: "completed" }).amountText, /^2\b/u);
  // What it pays nothing for stays what was sent.
  assert.match(view({ ...sent, amountLux: "1000000000", destinationAt: 1, status: "completed" }).amountText, /^1\b/u);
});
