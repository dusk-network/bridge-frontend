import assert from "node:assert/strict";
import test from "node:test";

import { DuskSdkError } from "@dusk/connect";

import { SIGNER_MOVED, createReviewSession, notSent, sameSigner, sentActionPatch } from "./review-session.js";
import { WALLET_CANCELLED, friendlyWalletError } from "./transfer-view.js";

test("a request prepared for a closed review never fills the next one, even on the same route", async () => {
  const reviews = createReviewSession();
  const first = reviews.start({ amountLux: 1_000_000_000n, routeId: "dusk-to-dusk-evm" });
  let release;
  const filling = reviews.fill(
    first,
    () => new Promise((resolve) => (release = resolve)),
    // As the sheet does: the request goes to the review on screen.
    (request) => {
      reviews.current.request = request;
    },
  );

  // Closed while the request was being built, then reopened with another amount.
  reviews.end();
  const second = reviews.start({ amountLux: 2_000_000_000n, routeId: "dusk-to-dusk-evm" });
  release({ amountLux: 1_000_000_000n });

  assert.equal(await filling, false);
  assert.equal(second.request, undefined);
  assert.equal(reviews.current, second);
});

test("the open review gets its own request, and a failure only while it's open", async () => {
  const reviews = createReviewSession();
  const review = reviews.start({ routeId: "dusk-to-ethereum" });
  assert.equal(await reviews.fill(review, async () => "request", (request) => (review.request = request)), true);
  assert.equal(review.request, "request");

  const errors = [];
  const closing = reviews.start({ routeId: "dusk-to-ethereum" });
  const failing = reviews.fill(closing, () => Promise.reject(new Error("node down")), () => {}, (error) => errors.push(error.message));
  reviews.end();
  await failing;
  assert.deepEqual(errors, []);
  await reviews.fill(reviews.start({}), () => Promise.reject(new Error("node down")), () => {}, (error) => errors.push(error.message));
  assert.deepEqual(errors, ["node down"]);
});

test("a review can be confirmed only by the account it was opened for", () => {
  const dusk = { signer: { account: "21n5ncAbC", wallet: "dusk" } };
  assert.equal(sameSigner(dusk, "21n5ncAbC"), true);
  // Base58 tells cases apart; a switched or disconnected wallet doesn't match.
  assert.equal(sameSigner(dusk, "21n5ncabc"), false);
  assert.equal(sameSigner(dusk, ""), false);
  const evm = { signer: { account: "0xAbC0", wallet: "evm" } };
  assert.equal(sameSigner(evm, "0xabc0"), true);
  assert.equal(sameSigner(evm, "0xabc1"), false);
  // Still preparing: no account was shown yet.
  assert.equal(sameSigner({ signer: null }, "0xabc1"), true);
});

test("a sent proof records the account its review was for, not the one connected by then", () => {
  const review = { kind: "prove", signer: { account: "A", wallet: "dusk" } };
  const patch = sentActionPatch(review, "aa".repeat(32), (account) => `submitter of ${account}`);
  assert.deepEqual(patch, {
    actionError: null,
    pendingAction: "prove",
    pendingHash: "aa".repeat(32),
    proofAccount: "A",
    proofSubmitter: "submitter of A",
    stage: "prove_submitted",
  });
  assert.equal(sentActionPatch({ kind: "finalize", signer: { account: "A" } }, "h", () => "x").stage, "finalize_submitted");
});

test("a request that wasn't sent says why on the review and in the page's live region alike", () => {
  // Joost's deposit, rejected in the wallet: the live region says that, never
  // an older transfer's arrival.
  const said = [];
  const announce = (text) => said.push(text);
  const deposit = notSent({ busy: true }, { code: 4001, message: "User rejected the request." }, { announce });
  assert.deepEqual([deposit.busy, deposit.error, deposit.stale], [false, WALLET_CANCELLED, undefined]);
  // The wallet came back as another account: the review can't be confirmed.
  const moved = notSent({ busy: true }, { code: "DUSK_ACCOUNT_CHANGED" }, { announce });
  assert.deepEqual([moved.error, moved.stale], [SIGNER_MOVED.dusk, true]);
  // The EVM wallet switched account while it switched chain: the same.
  const switched = notSent({ busy: true }, { code: "EVM_ACCOUNT_CHANGED" }, { announce, wallet: "evm" });
  assert.deepEqual([switched.busy, switched.error, switched.stale], [false, SIGNER_MOVED.evm, true]);
  // Anything else in plain words, naming the wallet that refused.
  notSent({}, { code: 4100 }, { announce, wallet: "evm" });
  assert.deepEqual(said, [WALLET_CANCELLED, SIGNER_MOVED.dusk, SIGNER_MOVED.evm, "The EVM wallet is locked. Unlock it, reconnect, and try again."]);
});

test("a send Dusk Connect refused because Dusk Wallet changed network or account leaves the review stale, in plain words", () => {
  // As Dusk Connect refuses: nothing went to the wallet.
  const refused = (reason) => new DuskSdkError("Wallet changed before sending", { data: { reason } });
  const network = notSent({ busy: true }, refused("network_changed"), { announce: () => {} });
  assert.deepEqual([network.busy, network.stale, network.error], [false, true, "Dusk Wallet switched network, so nothing was sent. Close it and review again."]);
  const session = notSent({ busy: true }, refused("session_changed"), { announce: () => {} });
  assert.deepEqual([session.stale, session.error], [true, "Dusk Wallet locked or changed accounts, so nothing was sent. Close it and review again."]);
  // Refused while connecting, outside a review: try again.
  assert.equal(friendlyWalletError(refused("session_changed")), "Dusk Wallet locked or changed accounts. Try again.");
  // Any other refusal leaves the review as it was.
  assert.equal(notSent({ busy: true }, new DuskSdkError("Wallet network changed", { data: { reason: "other" } }), { announce: () => {} }).stale, undefined);
});
