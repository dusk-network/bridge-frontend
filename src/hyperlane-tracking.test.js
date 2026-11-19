import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { duskRecipientHash } from "./hyperlane.js";
import { NOT_A_TRANSFER, deliveryLinkDue } from "./hyperlane-tracking.js";
import { createTracking } from "./tracking.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const byId = Object.fromEntries(buildRoutes(cfg).map((route) => [route.id, route]));
const T = Object.fromEntries(cfg.hyperlane.tokens.map((token) => [token.symbol, token]));

const NOW = Date.parse("2026-11-18T09:20:00Z");
const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
// Live transaction 86123720…: 95.085867 EURd to Sepolia, and its message.
const OUT_HASH = "86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f";
const OUT_ID = "0xed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b";
const OUT_TX = {
  blockHeight: 4_888_567n,
  blockTimestamp: 1_794_993_221n,
  callData: { contractId: T.EURd.dusk.route, data: "0000000000000000000000008a51d0619286d937699d85c1a2c88d67a5a1b75da736aa00000000002be5aa0500000000", fnName: "transfer_remote" },
  error: null,
  gasSpent: 2_216_155,
  json: { deposit: 16_876_000_000, fee: { gas_price: "1" }, sender: ACCOUNT },
};
const IN_HASH = "0x662c6163ce754cf4dea9c50db789967a43d20fd42d4fc378447a1eed26aaab06";
const IN_ID = "0x8bfceee4fc2bb2d10246a3b7c7ac8f75538cded9501f44382df39123c0f86db6";

/** The chains as a check finds them, each read counted. */
function world(state) {
  const asked = [];
  const reads = {
    deliveredOnDusk: async (id) => (asked.push("deliveredOnDusk"), state.deliveredOnDusk?.(id) ?? false),
    deliveredOnEvm: async (id) => (asked.push("deliveredOnEvm"), state.deliveredOnEvm?.(id) ?? false),
    dispatchedId: async (hash, height) => (asked.push("dispatchedId"), hash === OUT_HASH && height === OUT_TX.blockHeight ? OUT_ID : null),
    escrow: async (hash, tokens) => tokens.map((token) => ({ pending: state.held?.(hash) ?? 0n, registered: !state.held, token })),
    evmHead: async () => 12_162_036n,
    evmTransfer: async () => (asked.push("evmTransfer"), state.evmTransfer ?? null),
    evmValue: async () => 132_000_000_001n,
    processedOnDusk: async (id, { from, to }) => (asked.push(`processedOnDusk:${from}-${to}`), state.deliveredBy?.(id, from, to) ?? null),
    processedOnEvm: async (id, from) => (asked.push(`processedOnEvm:${from}`), state.processed ?? null),
  };
  const node = {
    latestBlock: async () => state.tip ?? { height: 4_888_200n, timestamp: 1_794_989_544n },
    transaction: async (hash) => (asked.push(`tx:${hash.slice(0, 4)}`), state.txs?.[hash] ?? null),
  };
  return { asked, tracking: createTracking({ config: cfg, hyperlane: reads, node, now: () => NOW }) };
}

const refresh = (state, entry, routeId) => world(state).tracking.refresh(entry, byId[routeId]);

test("a transfer to Sepolia is found by its message, on its way until Sepolia's Mailbox says it's delivered", async () => {
  const entry = { hash: OUT_HASH, routeId: "dusk-to-sepolia-eurd" };
  assert.deepEqual(await refresh({}, entry, "dusk-to-sepolia-eurd"), { note: "Waiting for Dusk.", status: "pending" });
  const seen = await refresh({ txs: { [OUT_HASH]: OUT_TX } }, entry, "dusk-to-sepolia-eurd");
  assert.deepEqual(seen, {
    amountLux: "95085867",
    bridgeFeeLux: "16876000000",
    destination: EVM,
    feeLux: "2216155",
    messageId: OUT_ID,
    note: "On its way to Sepolia.",
    onTheWay: true,
    sender: ACCOUNT,
    sourceAt: 1_794_993_221_000,
    status: "pending",
  });
  // A read that says it isn't delivered never ends it: the next one may.
  const later = { ...entry, ...seen };
  assert.equal((await refresh({ deliveredOnEvm: () => false, txs: { [OUT_HASH]: OUT_TX } }, later, "dusk-to-sepolia-eurd")).status, "pending");
  const processed = { at: 1_794_993_240_000, hash: "0xfdd8a84db201bfc08be9983224c7982f8c70ca0691f1b69c11c9930f2a401fd8" };
  const { asked, tracking } = world({ deliveredOnEvm: (id) => id === OUT_ID, processed, txs: { [OUT_HASH]: OUT_TX } });
  const done = await tracking.refresh({ ...later, scanFrom: "12160500" }, byId["dusk-to-sepolia-eurd"]);
  assert.deepEqual([done.status, done.destinationHash, done.destinationAt, done.receivedLux], ["completed", processed.hash, processed.at, "95085867"]);
  // The message ID it knew isn't looked for again; the delivery's log from the block before it was sent.
  assert.deepEqual(asked, [`tx:${OUT_HASH.slice(0, 4)}`, "deliveredOnEvm", "processedOnEvm:12160500"]);
  // Where the chain gives no log, it arrived when this page saw it go by.
  const unlogged = await refresh({ deliveredOnEvm: () => true, txs: { [OUT_HASH]: OUT_TX } }, later, "dusk-to-sepolia-eurd");
  assert.deepEqual([unlogged.status, unlogged.destinationAt, unlogged.destinationHash], ["completed", NOW, undefined]);
});

test("a Dusk transaction that isn't a transfer on the route, or failed, moved nothing to Sepolia", async () => {
  const entry = { hash: OUT_HASH, routeId: "dusk-to-sepolia-usdd" };
  // Sent to the EURd route, it isn't a USDd transfer.
  assert.equal((await refresh({ txs: { [OUT_HASH]: OUT_TX } }, entry, "dusk-to-sepolia-usdd")).note, NOT_A_TRANSFER);
  const call = { ...OUT_TX, callData: { ...OUT_TX.callData, fnName: "approve" } };
  assert.equal((await refresh({ txs: { [OUT_HASH]: call } }, entry, "dusk-to-sepolia-eurd")).note, NOT_A_TRANSFER);
  const failed = await refresh({ txs: { [OUT_HASH]: { ...OUT_TX, error: "Panic" } } }, entry, "dusk-to-sepolia-eurd");
  assert.deepEqual([failed.status, failed.note, failed.sourceFailed], ["failed", "The transfer failed on Dusk.", true]);
  // DUSK's route takes its amount with the fee: the bridge fee is what's above it.
  const native = { ...OUT_TX, callData: { ...OUT_TX.callData, contractId: T.DUSK.dusk.route }, json: { ...OUT_TX.json, deposit: 16_876_000_000 + 95_085_867 } };
  assert.equal((await refresh({ txs: { [OUT_HASH]: native } }, entry, "dusk-to-sepolia")).bridgeFeeLux, "16876000000");
});

test("a transfer to Dusk waits for Sepolia, is delivered by its message, and arrives or is held for the account's claim", async () => {
  const hash = duskRecipientHash(ACCOUNT);
  const sent = { amount: 540_488_790n, destination: 1146442572, recipient: hash };
  const receipt = { at: 1_794_988_944_000, blockNumber: 12_160_156n, failed: false, feeWei: 264_964_239_360n, from: EVM, messageId: IN_ID, sent, to: T.DUSK.evm.token.toLowerCase() };
  const entry = { destination: ACCOUNT, hash: IN_HASH, routeId: "sepolia-to-dusk" };
  // No receipt yet, as a load-balanced RPC can say: it waits, never fails.
  assert.deepEqual(await refresh({}, entry, "sepolia-to-dusk"), { note: "Waiting for Sepolia.", status: "pending" });
  const way = await refresh({ evmTransfer: receipt }, entry, "sepolia-to-dusk");
  assert.deepEqual(way, {
    amountLux: "540488790",
    bridgeFeeWei: "132000000001",
    feeWei: "264964239360",
    messageId: IN_ID,
    note: "On its way to Dusk.",
    onTheWay: true,
    recipientHash: hash,
    sender: EVM,
    sourceAt: 1_794_988_944_000,
    status: "pending",
  });
  // Delivered to an account the route pays straight away: it arrived.
  const direct = await refresh({ deliveredOnDusk: (id) => id === IN_ID, evmTransfer: receipt }, { ...entry, ...way }, "sepolia-to-dusk");
  assert.deepEqual([direct.status, direct.escrow, direct.destinationAt, direct.delivered], ["completed", null, NOW, true]);
  // The first to the account waits in escrow: held, and needing a claim.
  const held = await refresh({ deliveredOnDusk: () => true, evmTransfer: receipt, held: () => 540_488_790n }, { ...entry, ...way }, "sepolia-to-dusk");
  assert.deepEqual([held.status, held.escrow, held.heldLux, held.note], ["pending", "held", "540488790", "Held on Dusk until it's claimed."]);
  // Once delivered, Sepolia isn't asked again.
  const claimHash = "cd".repeat(32);
  const { asked, tracking } = world({ held: () => 540_488_790n, txs: {} });
  const waiting = await tracking.refresh({ ...entry, ...way, ...held, pendingAction: "claim", pendingAt: NOW - 20_000, pendingHash: claimHash }, byId["sepolia-to-dusk"]);
  assert.equal(waiting.note, "Claim sent, waiting for Dusk.");
  assert.ok(!asked.includes("evmTransfer") && !asked.includes("deliveredOnDusk"), asked.join());
  // The claim in a block, and nothing held: claimed.
  const claimTx = { blockTimestamp: 1_794_989_100n, error: null, gasSpent: 1_908_588, json: { fee: { gas_price: "1" } } };
  const claimed = await refresh({ txs: { [claimHash]: claimTx } }, { ...entry, ...way, ...held, pendingAction: "claim", pendingAt: NOW - 20_000, pendingHash: claimHash }, "sepolia-to-dusk");
  assert.deepEqual(
    [claimed.status, claimed.escrow, claimed.claimHash, claimed.claimAt, claimed.claimFeeLux, claimed.destinationAt, claimed.pendingAction],
    ["completed", "claimed", claimHash, 1_794_989_100_000, "1908588", 1_794_989_100_000, null],
  );
  // A claim that failed on Dusk is said, and offered again.
  const refused = await refresh({ held: () => 1n, txs: { [claimHash]: { ...claimTx, error: "Panic" } } }, { ...entry, ...way, ...held, pendingAction: "claim", pendingAt: NOW - 20_000, pendingHash: claimHash }, "sepolia-to-dusk");
  assert.deepEqual([refused.status, refused.escrow, refused.actionError, refused.pendingAction], ["pending", "held", "The claim failed on Dusk: Panic", null]);
});

test("a Sepolia transaction that failed, or isn't a transfer to Dusk on the route, moved nothing", async () => {
  const receipt = { at: 1, blockNumber: 1n, failed: false, feeWei: 1n, from: EVM, messageId: IN_ID, sent: { amount: 1n, destination: 1146442572, recipient: duskRecipientHash(ACCOUNT) }, to: T.EURd.evm.token.toLowerCase() };
  const entry = { hash: IN_HASH, routeId: "sepolia-to-dusk" };
  assert.deepEqual(
    [
      await refresh({ evmTransfer: { ...receipt, failed: true } }, entry, "sepolia-to-dusk-eurd"),
      await refresh({ evmTransfer: receipt }, entry, "sepolia-to-dusk"),
      await refresh({ evmTransfer: { ...receipt, sent: { ...receipt.sent, destination: 1 } } }, entry, "sepolia-to-dusk-eurd"),
    ].map((patch) => [patch.status, patch.note]),
    [
      ["failed", "The transfer failed on Sepolia."],
      ["failed", NOT_A_TRANSFER],
      ["failed", NOT_A_TRANSFER],
    ],
  );
  // A Dusk account this browser had for it that isn't the one paid is dropped.
  const other = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
  assert.equal((await refresh({ evmTransfer: receipt }, { ...entry, destination: other }, "sepolia-to-dusk-eurd")).destination, null);
});

test("a transfer to Dusk the wallet cancelled, or replaced with another, ends there: it moved nothing", async () => {
  const { asked, tracking } = world({});
  const cancelled = await tracking.refresh({ hash: IN_HASH, replaced: "cancelled", routeId: "sepolia-to-dusk" }, byId["sepolia-to-dusk"]);
  assert.deepEqual([cancelled.status, cancelled.note, cancelled.sourceFailed], ["failed", "It was cancelled in the wallet, so nothing moved.", true]);
  const replaced = await tracking.refresh({ hash: IN_HASH, replaced: "replaced", routeId: "sepolia-to-dusk" }, byId["sepolia-to-dusk"]);
  assert.equal(replaced.note, "The wallet sent another transaction in its place, so nothing moved.");
  // Its own hash has no receipt to wait for.
  assert.deepEqual(asked, []);
});

test("a claim sent for a held transfer is followed to its transaction, even where the escrow already reads empty", async () => {
  const hash = duskRecipientHash(ACCOUNT);
  const claimHash = "cd".repeat(32);
  const held = { delivered: true, deliveryScans: 3, destination: ACCOUNT, escrow: "held", hash: IN_HASH, messageId: IN_ID, recipientHash: hash, routeId: "sepolia-to-dusk" };
  const claiming = { ...held, pendingAction: "claim", pendingAt: NOW - 20_000, pendingHash: claimHash };
  // The payout is out, but the claim isn't found yet: it waits for it, for its time and fee.
  const early = await refresh({}, claiming, "sepolia-to-dusk");
  assert.deepEqual([early.status, early.note, early.pendingAction], ["pending", "Claim sent, waiting for Dusk.", undefined]);
  const claimTx = { blockTimestamp: 1_794_989_100n, error: null, gasSpent: 1_908_588, json: { fee: { gas_price: "1" } } };
  const found = await refresh({ txs: { [claimHash]: claimTx } }, claiming, "sepolia-to-dusk");
  assert.deepEqual([found.status, found.claimHash, found.claimFeeLux, found.pendingAction], ["completed", claimHash, "1908588", null]);
  // A claim not found in ten minutes is let go: the payout is what counts.
  const lapsed = await refresh({}, { ...claiming, pendingAt: NOW - 11 * 60_000 }, "sepolia-to-dusk");
  assert.deepEqual([lapsed.status, lapsed.escrow, lapsed.pendingAction, lapsed.pendingHash], ["completed", "claimed", null, null]);
});

test("a transfer to Dusk is linked to the transaction that delivered it, by the Mailbox's process_id event around when it should", async () => {
  const hash = duskRecipientHash(ACCOUNT);
  const delivery = "bbf13d74c6451e0d5042b550ad543f359db88b8ec40916f0fb5f298bfe457a25";
  // Sent on Sepolia at 1_794_988_944; the tip is 4_888_200, at 1_794_989_544: ten minutes, 60 blocks, later.
  const way = { amountLux: "540488790", destination: ACCOUNT, hash: IN_HASH, messageId: IN_ID, onTheWay: true, recipientHash: hash, routeId: "sepolia-to-dusk", sourceAt: 1_794_988_944_000 };
  const sent = { amount: 540_488_790n, destination: 1146442572, recipient: hash };
  const state = {
    deliveredBy: (id, from, to) => (id === IN_ID && from <= 4_888_146n && 4_888_146n <= to ? { hash: delivery, height: 4_888_146n } : null),
    deliveredOnDusk: () => true,
    evmTransfer: { at: 1_794_988_944_000, blockNumber: 12_160_156n, failed: false, feeWei: 1n, from: EVM, messageId: IN_ID, sent, to: T.DUSK.evm.token.toLowerCase() },
    txs: { [delivery]: { blockTimestamp: 1_794_989_004n, error: null } },
  };
  const { asked, tracking } = world(state);
  const done = await tracking.refresh({ ...way, delivered: false }, byId["sepolia-to-dusk"]);
  assert.deepEqual([done.status, done.deliveryHash, done.deliveredAt, done.destinationAt], ["completed", delivery, 1_794_989_004_000, 1_794_989_004_000]);
  // Not seen on its way lately: about a minute after it was sent, 54 blocks before the tip, the blocks around then.
  assert.ok(asked.includes("processedOnDusk:4888136-4888176"), asked.join());
  // Seen on its way at the last check, 15 seconds ago: it arrived since, in the blocks up to the tip.
  const watched = world({ ...state, tip: { height: 4_888_150n, timestamp: 1_794_989_044n } });
  const seen = await watched.tracking.refresh({ ...way, delivered: false, lastCheckedAt: NOW - 15_000 }, byId["sepolia-to-dusk"]);
  assert.equal(seen.deliveryHash, delivery);
  assert.ok(watched.asked.includes("processedOnDusk:4888110-4888150"), watched.asked.join());
  // Not found: the same blocks read again on the next checks, three times at most, then left.
  const missing = await refresh({ ...state, deliveredBy: () => null, held: () => 1n }, { ...way, delivered: true }, "sepolia-to-dusk");
  assert.deepEqual([missing.deliveryScans, missing.deliveryNear, missing.deliveryHash], [1, "4888176", undefined]);
  const again = world({ ...state, held: () => 1n, tip: { height: 4_888_400n, timestamp: 1_794_991_544n } });
  assert.equal((await again.tracking.refresh({ ...way, ...missing, delivered: true }, byId["sepolia-to-dusk"])).deliveryHash, delivery);
  assert.ok(again.asked.includes("processedOnDusk:4888136-4888176"), again.asked.join());
  const given = world({ ...state, deliveredBy: () => null, held: () => 1n });
  await given.tracking.refresh({ ...way, delivered: true, deliveryScans: 3 }, byId["sepolia-to-dusk"]);
  assert.ok(!given.asked.some((each) => each.startsWith("processedOnDusk")), given.asked.join());
  // A node that can't say holds up nothing: it arrived, and its transaction is looked for again.
  const unread = await refresh({ ...state, deliveredBy: () => Promise.reject(new Error("Dusk node query failed with HTTP 502.")) }, { ...way, delivered: false }, "sepolia-to-dusk");
  assert.deepEqual([unread.status, unread.deliveryScans, unread.deliveryHash], ["completed", 1, undefined]);
  // An arrived transfer left without it is looked at once more when its receipt opens, until it's been tried enough.
  const arrived = { ...way, delivered: true, status: "completed" };
  assert.deepEqual(
    [
      deliveryLinkDue({ ...arrived, deliveryScans: 1 }, byId["sepolia-to-dusk"]),
      deliveryLinkDue({ ...arrived, deliveryScans: 3 }, byId["sepolia-to-dusk"]),
      deliveryLinkDue({ ...arrived, deliveryHash: delivery }, byId["sepolia-to-dusk"]),
      deliveryLinkDue({ ...arrived, status: "pending" }, byId["sepolia-to-dusk"]),
      // To Sepolia, it's the EVM chain's transaction: here, found.
      deliveryLinkDue({ ...arrived, destinationHash: "0x664d3c1b73db3e2de775cd99abefcb1745303180ee412b812de157d5a5de1a98" }, byId["dusk-to-sepolia"]),
    ],
    [true, false, false, false, false],
  );
});

test("a transfer to Sepolia delivered before its log can be read arrives without its transaction, which later checks look for", async () => {
  const route = byId["dusk-to-sepolia-eurd"];
  const sent = { hash: OUT_HASH, messageId: OUT_ID, onTheWay: true, routeId: "dusk-to-sepolia-eurd", scanFrom: "12160500" };
  const delivered = { deliveredOnEvm: () => true, txs: { [OUT_HASH]: OUT_TX } };
  // The Mailbox says delivered; the RPC has no log yet.
  const first = await refresh(delivered, sent, "dusk-to-sepolia-eurd");
  assert.deepEqual([first.status, first.destinationHash, first.destinationAt, first.deliveryScans], ["completed", undefined, NOW, 1]);
  const arrived = { ...sent, ...first };
  assert.equal(deliveryLinkDue(arrived, route), true);
  // Still none, checked later: only the tries are counted; when this page saw it arrive stays.
  const second = await refresh(delivered, arrived, "dusk-to-sepolia-eurd");
  assert.deepEqual(second, { deliveryScans: 2 });
  // Found: its transaction, and when it really arrived.
  const processed = { at: 1_794_993_240_000, hash: "0x664d3c1b73db3e2de775cd99abefcb1745303180ee412b812de157d5a5de1a98" };
  const found = await refresh({ ...delivered, processed }, { ...arrived, ...second }, "dusk-to-sepolia-eurd");
  assert.deepEqual(found, { destinationAt: processed.at, destinationHash: processed.hash });
  assert.equal(deliveryLinkDue({ ...arrived, ...found }, route), false);
  // Looked for a while, then left.
  assert.equal(deliveryLinkDue({ ...arrived, deliveryScans: 19 }, route), true);
  assert.equal(deliveryLinkDue({ ...arrived, deliveryScans: 20 }, route), false);
});

test("a claim that failed on Dusk is kept with its transaction and what it cost, and the claim is offered again", async () => {
  const claimHash = "cd".repeat(32);
  const claiming = { delivered: true, deliveryScans: 3, destination: ACCOUNT, escrow: "held", hash: IN_HASH, messageId: IN_ID, pendingAction: "claim", pendingAt: NOW - 20_000, pendingHash: claimHash, recipientHash: duskRecipientHash(ACCOUNT), routeId: "sepolia-to-dusk" };
  const failedTx = { blockTimestamp: 1_794_989_100n, error: "Panic", gasSpent: 3_000_000, json: { fee: { gas_price: "1" } } };
  const out = await refresh({ held: () => 1n, txs: { [claimHash]: failedTx } }, claiming, "sepolia-to-dusk");
  assert.deepEqual(
    [out.status, out.escrow, out.actionError, out.claimFailedHash, out.claimFailedFeeLux, out.pendingAction, out.pendingHash],
    ["pending", "held", "The claim failed on Dusk: Panic", claimHash, "3000000", null, null],
  );
  // Another that fails too: both were paid for.
  const again = await refresh({ held: () => 1n, txs: { ["ef".repeat(32)]: failedTx } }, { ...claiming, ...out, pendingAction: "claim", pendingHash: "ef".repeat(32) }, "sepolia-to-dusk");
  assert.deepEqual([again.claimFailedHash, again.claimFailedFeeLux], ["ef".repeat(32), "6000000"]);
});

test("a claim not found in ten minutes is let go while the escrow still holds the transfer: it's offered again", async () => {
  const claimHash = "cd".repeat(32);
  const held = { delivered: true, deliveryScans: 3, destination: ACCOUNT, escrow: "held", hash: IN_HASH, messageId: IN_ID, recipientHash: duskRecipientHash(ACCOUNT), routeId: "sepolia-to-dusk" };
  const old = await refresh({ held: () => 1n }, { ...held, pendingAction: "claim", pendingAt: NOW - 11 * 60_000, pendingHash: claimHash }, "sepolia-to-dusk");
  assert.deepEqual([old.status, old.note, old.pendingAction, old.pendingHash], ["pending", "Held on Dusk until it's claimed.", null, null]);
  // Within the ten minutes, it's still waited for.
  const recent = await refresh({ held: () => 1n }, { ...held, pendingAction: "claim", pendingAt: NOW - 60_000, pendingHash: claimHash }, "sepolia-to-dusk");
  assert.deepEqual([recent.note, recent.pendingAction], ["Claim sent, waiting for Dusk.", undefined]);
});

test("an arrived transfer looked at again for its delivering transaction keeps what became of it", async () => {
  // To Sepolia: a lagging RPC isn't asked whether it's delivered, nor can it say it isn't.
  const out = { delivered: true, destination: EVM, destinationAt: NOW - 30_000, deliveryScans: 1, hash: OUT_HASH, messageId: OUT_ID, routeId: "dusk-to-sepolia-eurd", scanFrom: "12160500", sourceAt: NOW - 60_000, status: "completed" };
  const lagging = world({ deliveredOnEvm: () => false, processed: { at: NOW - 40_000, hash: "0x664d3c1b73db3e2de775cd99abefcb1745303180ee412b812de157d5a5de1a98" } });
  const found = await lagging.tracking.refresh(out, byId["dusk-to-sepolia-eurd"]);
  assert.deepEqual(found, { destinationAt: NOW - 40_000, destinationHash: "0x664d3c1b73db3e2de775cd99abefcb1745303180ee412b812de157d5a5de1a98" });
  assert.ok(!lagging.asked.includes("deliveredOnEvm"), lagging.asked.join());
  // Still not found: only the try is counted.
  assert.deepEqual(await world({ deliveredOnEvm: () => false }).tracking.refresh(out, byId["dusk-to-sepolia-eurd"]), { deliveryScans: 2 });
  // To Dusk, claimed elsewhere: the escrow isn't read again, and it stays claimed.
  const claimed = { delivered: true, deliveredAt: NOW - 50_000, destination: ACCOUNT, destinationAt: NOW - 50_000, deliveryNear: "4888176", deliveryScans: 1, escrow: "claimed", hash: IN_HASH, messageId: IN_ID, recipientHash: duskRecipientHash(ACCOUNT), routeId: "sepolia-to-dusk", sourceAt: 1_794_988_944_000, status: "completed" };
  const delivery = "bbf13d74c6451e0d5042b550ad543f359db88b8ec40916f0fb5f298bfe457a25";
  const inbound = world({ deliveredBy: () => ({ hash: delivery, height: 4_888_146n }), held: () => 7n, txs: { [delivery]: { blockTimestamp: 1_794_989_004n, error: null } } });
  const linked = await inbound.tracking.refresh(claimed, byId["sepolia-to-dusk"]);
  assert.deepEqual(linked, { deliveredAt: 1_794_989_004_000, deliveryHash: delivery });
  assert.ok(!inbound.asked.includes("deliveredOnDusk") && !inbound.asked.includes("evmTransfer"), inbound.asked.join());
});

test("two transfers to Sepolia a relayer delivered in one transaction each arrive with it, matched by their own message IDs", async () => {
  const { takenByAnother } = await import("./tracking.js");
  const relayed = { at: NOW - 40_000, hash: "0x664d3c1b73db3e2de775cd99abefcb1745303180ee412b812de157d5a5de1a98" };
  const sent = { hash: OUT_HASH, id: "second", messageId: OUT_ID, onTheWay: true, routeId: "dusk-to-sepolia-eurd", scanFrom: "12160500" };
  // Another transfer's message went in the same transaction, and arrived with it first.
  const other = { destinationHash: relayed.hash, hash: "ab".repeat(32), id: "first", messageId: `0x${"12".repeat(32)}`, routeId: "dusk-to-sepolia-eurd", status: "completed" };
  const patch = await refresh({ deliveredOnEvm: () => true, processed: relayed, txs: { [OUT_HASH]: OUT_TX } }, sent, "dusk-to-sepolia-eurd");
  assert.deepEqual([patch.status, patch.destinationHash], ["completed", relayed.hash]);
  assert.equal(takenByAnother(sent, patch, [other, sent]), false);
  // A payout matched any other way is still one transfer's only.
  assert.equal(takenByAnother({ id: "deposit" }, { destinationHash: relayed.hash, status: "completed" }, [other]), true);
});
