import assert from "node:assert/strict";
import test from "node:test";

import { createReviewSession, sameSigner } from "./review-session.js";

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
