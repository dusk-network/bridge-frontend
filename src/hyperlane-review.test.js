import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { createClaimWatch } from "./claim-watch.js";
import { loadConfig } from "./config.js";
import { duskRecipientHash } from "./hyperlane.js";
import { NOTHING_TO_CLAIM } from "./hyperlane-requests.js";
import { claimKey, evmReviewParts, heldFor, recheckClaim } from "./hyperlane-review.js";
import { amountsIn, byLabel, exactly, textOf } from "./pages.fixtures.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));
const T = Object.fromEntries(cfg.hyperlane.tokens.map((token) => [token.symbol, token]));

const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";

test("a transfer back to Dusk is reviewed at one delivery fee: its rows, its check of the coin for the fees and its wallet lines", () => {
  const route = byId["sepolia-to-dusk-eurd"];
  // The form read 0.000132 ETH; the review reads 0.0005, and the wallet holds 0.0004.
  const reads = { gasPrice: 1n, hyperlane: { evm: { balance: 50_000_000n, deliveryFeeWei: 132_000_000_000_000n, gasCoinWei: 400_000_000_000_000n, gasPriceWei: 1n }, gas: 250_000n, registered: true } };
  const parts = evmReviewParts(route, { amountLux: 10_000_000n, cfg, destination: ACCOUNT, duskAccount: ACCOUNT, evm: { account: EVM }, fee: 500_000_000_000_000n, reads, registered: true });
  const bridge = parts.feeRows.find((row) => row.key === "bridge");
  assert.match(bridge.value, /0\.0005 ETH/u);
  const coins = parts.checks.find((check) => /\bETH\b/u.test(check.html));
  assert.equal(coins.ok, false);
  assert.match(coins.html, /0\.0005/u);
  assert.equal(byLabel(parts.lines).Value.value, "0.0005 ETH");
  assert.equal(parts.deliveryFee, 500_000_000_000_000n);
});

test("the first transfer's claim is said for the account the review pays, as read for it, whatever the form read", () => {
  const route = byId["sepolia-to-dusk-eurd"];
  // The form read another recipient's word: the route pays it already.
  const reads = { gasPrice: 1n, hyperlane: { evm: { balance: 50_000_000n, gasCoinWei: 10n ** 18n, gasPriceWei: 1n }, gas: 250_000n, registered: true } };
  const first = evmReviewParts(route, { amountLux: 10_000_000n, cfg, destination: OTHER, duskAccount: ACCOUNT, evm: { account: EVM }, fee: 1n, reads, registered: false });
  assert.equal(first.firstToAccount, true);
  const paid = evmReviewParts(route, { amountLux: 10_000_000n, cfg, destination: OTHER, duskAccount: ACCOUNT, evm: { account: EVM }, fee: 1n, reads: { ...reads, hyperlane: { ...reads.hyperlane, registered: false } }, registered: true });
  assert.equal(paid.firstToAccount, false);
  // Said where it's the first: a check of its own, for this token, with the claim's fee; and what the transfer does says it.
  const known = new Set(paid.checks.map((check) => check.html));
  const claim = first.checks.filter((check) => !known.has(check.html));
  assert.equal(claim.length, 1);
  assert.match(textOf(claim[0].html), exactly("EURd"));
  assert.deepEqual(amountsIn(claim[0].html), ["0.003 DUSK"]);
  assert.notEqual(first.what, paid.what);
});

test("a reviewed claim is built again as it's sent: unchanged it goes, another amount is reviewed again, nothing held isn't sent", async () => {
  const chain = (pending) => ({
    node: { accountBalance: async () => 10n ** 12n, gasPrice: async () => 1n },
    reads: { escrow: async () => [{ pending, registered: true, token: T.EURd }], paused: async () => false },
  });
  const deps = (pending) => ({ account: ACCOUNT, cfg, ...chain(pending), signer: ACCOUNT, token: T.EURd });
  const reviewed = { fnName: "claim_pending", gas: { limit: "3000000", price: "2" }, pending: 10_000_000n };
  assert.deepEqual(await recheckClaim(reviewed, deps(10_000_000n)).then(({ changed, request }) => [changed, request.gas.price]), [false, "2"]);
  const more = await recheckClaim(reviewed, deps(25_000_000n));
  assert.deepEqual([more.changed, more.request.pending], [true, 25_000_000n]);
  await assert.rejects(recheckClaim(reviewed, deps(0n)), { message: NOTHING_TO_CLAIM });
});

test("a claim pays out every transfer its route holds for the account, and only those", () => {
  const hash = duskRecipientHash(ACCOUNT);
  const held = (id, patch = {}) => ({ escrow: "held", id, recipientHash: hash, routeId: "sepolia-to-dusk-eurd", status: "pending", ...patch });
  const entries = [held("a"), held("b"), held("other-route", { routeId: "sepolia-to-dusk-usdd" }), held("other-account", { recipientHash: duskRecipientHash(OTHER) }), held("paid", { escrow: "claimed", status: "completed" })];
  assert.deepEqual(heldFor(entries, "sepolia-to-dusk-eurd", ACCOUNT).map((entry) => entry.id), ["a", "b"]);
  // By the account it pays, known by name or by hash alike.
  assert.equal(claimKey("sepolia-to-dusk-eurd", ACCOUNT), claimKey("sepolia-to-dusk-eurd", hash));
  assert.notEqual(claimKey("sepolia-to-dusk-eurd", ACCOUNT), claimKey("sepolia-to-dusk-usdd", ACCOUNT));
});

test("a claim sent from the card is said as sent until its transaction is in a block, failed, or not found for ten minutes", async () => {
  let now = 0;
  const timers = [];
  const txs = {};
  const ended = [];
  const watch = createClaimWatch({
    clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
    node: { transaction: async (hash) => txs[hash] ?? null },
    now: () => now,
    onEnd: (key, outcome) => ended.push([key, outcome]),
    setTimer: (run) => (timers.push(run), run),
  });
  const tick = async (ms) => {
    now += ms;
    for (const run of timers.splice(0)) await run();
  };
  watch.sent("eurd:me", "aa");
  // No timer can say it's done: a slow block keeps it sent.
  await tick(20_000);
  assert.equal(watch.pending("eurd:me").hash, "aa");
  txs.aa = { error: null };
  await tick(5_000);
  assert.equal(watch.pending("eurd:me"), null);
  assert.deepEqual(ended.shift(), ["eurd:me", { hash: "aa", state: "done" }]);
  // Failed on Dusk: Claim is offered again, with why.
  watch.sent("eurd:me", "bb");
  txs.bb = { error: "Panic" };
  await tick(5_000);
  assert.deepEqual(ended.shift(), ["eurd:me", { error: "The claim failed on Dusk: Panic", hash: "bb", state: "failed" }]);
  // Never found: let go after ten minutes, and the escrow read again says what's held.
  watch.sent("eurd:me", "cc");
  for (let i = 0; i < 119; i += 1) await tick(5_000);
  assert.equal(watch.pending("eurd:me").hash, "cc");
  await tick(5_001);
  assert.deepEqual(ended.shift(), ["eurd:me", { hash: "cc", state: "lapsed" }]);
  watch.stop();
});

test("the card reads what the routes hold again while a transfer to the account is on its way, and once one is delivered into escrow", async () => {
  const { escrowOnTheWay, nowHeld } = await import("./hyperlane-review.js");
  const hash = duskRecipientHash(ACCOUNT);
  const routeOf = (id) => byId[id];
  const way = { recipientHash: hash, routeId: "sepolia-to-dusk-eurd", status: "pending" };
  assert.equal(escrowOnTheWay([way], ACCOUNT, routeOf), true);
  // Just sent, before its receipt is read: by the account it pays.
  assert.equal(escrowOnTheWay([{ destination: ACCOUNT, routeId: "sepolia-to-dusk" }], ACCOUNT, routeOf), true);
  // Held already, arrived, another account's, or going out of Dusk: nothing to look out for.
  assert.equal(escrowOnTheWay([{ ...way, escrow: "held" }], ACCOUNT, routeOf), false);
  assert.equal(escrowOnTheWay([{ ...way, status: "completed" }], ACCOUNT, routeOf), false);
  assert.equal(escrowOnTheWay([{ ...way, recipientHash: duskRecipientHash(OTHER) }], ACCOUNT, routeOf), false);
  assert.equal(escrowOnTheWay([{ destination: EVM, routeId: "dusk-to-sepolia-eurd", status: "pending" }], ACCOUNT, routeOf), false);
  assert.equal(escrowOnTheWay([way], "", routeOf), false);
  // A check that finds it held now: the box is read at once.
  assert.equal(nowHeld(way, { ...way, escrow: "held" }), true);
  assert.equal(nowHeld({ ...way, escrow: "held" }, { ...way, escrow: "held" }), false);
  assert.equal(nowHeld(way, { ...way, status: "completed" }), false);
});

test("while a claim of an account's escrow on a route waits for its transaction, each transfer it pays says so, and offers no other", async () => {
  const { withClaimSent } = await import("./hyperlane-review.js");
  const hash = duskRecipientHash(ACCOUNT);
  const held = { escrow: "held", id: "a", recipientHash: hash, routeId: "sepolia-to-dusk-eurd", status: "pending" };
  const sent = new Map([[claimKey("sepolia-to-dusk-eurd", ACCOUNT), { at: 1, hash: "cd".repeat(32) }]]);
  const pending = (key) => sent.get(key) ?? null;
  assert.deepEqual(withClaimSent(held, pending), { ...held, pendingAction: "claim", pendingHash: "cd".repeat(32) });
  // Another route's, another account's, or one not held: as it is.
  for (const other of [{ ...held, routeId: "sepolia-to-dusk-usdd" }, { ...held, recipientHash: duskRecipientHash(OTHER) }, { ...held, escrow: "claimed", status: "completed" }]) assert.equal(withClaimSent(other, pending), other);
});

test("a reviewed approval is checked again as it's sent: the route as booked, its room and the token, or it isn't sent", async () => {
  const { recheckApproval } = await import("./hyperlane-review.js");
  const { ROUTE_NOT_AS_BOOKED } = await import("./hyperlane-reads.js");
  const world = (route = null) => ({
    node: { accountBalance: async () => 10n ** 12n, gasPrice: async () => 1n },
    reads: {
      allowance: async () => 0n,
      checkMailbox: async () => {},
      checkRoute: async () => {
        if (route) throw new Error(route);
      },
      dispatchFee: async () => 16_876_000_000n,
      paused: async () => false,
      tokenBalance: async () => 10n ** 9n,
    },
  });
  const deps = (route) => ({ amount: 1_000_000n, cfg, ...world(route), recipient: EVM, sender: ACCOUNT, token: T.EURd });
  const reviewed = (await recheckApproval(null, deps())).request;
  assert.deepEqual(await recheckApproval(reviewed, deps()).then(({ changed }) => changed), false);
  await assert.rejects(recheckApproval(reviewed, deps(ROUTE_NOT_AS_BOOKED)), { message: ROUTE_NOT_AS_BOOKED });
});

test("a claim sent before a reload is still followed after it, as is one a transfer of the account's says it sent", () => {
  const items = new Map();
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
  const deps = { clearTimer: () => {}, node: { transaction: async () => null }, now: () => 1_000, onEnd: () => {}, setTimer: () => 0, storage, storageKey: "claims" };
  createClaimWatch(deps).sent("eurd:me", "aa");
  // The page loads again.
  const after = createClaimWatch(deps);
  assert.deepEqual(after.pending("eurd:me"), { at: 1_000, hash: "aa" });
  // A transfer's own pending claim, from its stored hash and time.
  after.resume("usdd:me", "bb", 500);
  assert.deepEqual(createClaimWatch(deps).pending("usdd:me"), { at: 500, hash: "bb" });
});

test("a reviewed approval whose bridge fee moved isn't sent: it's shown again, at the new fee", async () => {
  const { recheckApproval } = await import("./hyperlane-review.js");
  const world = (fee) => ({
    node: { accountBalance: async () => 10n ** 12n, gasPrice: async () => 1n },
    reads: { checkMailbox: async () => {}, checkRoute: async () => {}, dispatchFee: async () => fee, paused: async () => false, tokenBalance: async () => 10n ** 9n },
  });
  const deps = (fee) => ({ amount: 1_000_000n, cfg, ...world(fee), recipient: EVM, sender: ACCOUNT, token: T.EURd });
  const reviewed = (await recheckApproval(null, deps(16_876_000_000n))).request;
  assert.equal((await recheckApproval(reviewed, deps(16_876_000_000n))).changed, false);
  const moved = await recheckApproval(reviewed, deps(17_000_000_000n));
  assert.deepEqual([moved.changed, moved.request.fee], [true, 17_000_000_000n]);
});

test("a step whose request is being built again can't be confirmed meanwhile", async () => {
  const { rebuilding } = await import("./hyperlane-review.js");
  const { createReviewSession } = await import("./review-session.js");
  let now = 0;
  const reviews = createReviewSession({ now: () => now });
  const review = reviews.start({ current: 0, request: { fnName: "transfer_remote" }, steps: [{ confirmLabel: "Send", lines: [{ label: "Method" }] }] });
  now += 1_000;
  assert.equal(reviews.confirmable, true);
  rebuilding(review);
  assert.deepEqual([review.request, review.steps[0].lines, Boolean(review.steps[0].linesNote), review.steps[0].confirmLabel], [null, null, true, "Send"]);
  // Confirm takes no click, whatever the button shows, until the new request's lines are up.
  assert.equal(reviews.confirmable, false);
  review.steps[0] = { ...review.steps[0], lines: [{ label: "Method" }] };
  assert.equal(reviews.confirmable, true);
});
