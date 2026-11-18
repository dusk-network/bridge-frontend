// Follows a Hyperlane transfer to its end, rebuilt from its route and source
// transaction, as every transfer is. Its message ID is the Mailbox's on the
// sending side: Dusk's `dispatch_id` event, or the EVM chain's `DispatchId`
// log. It's delivered once the other side's Mailbox says so (`delivered`);
// until then it's on its way, however often that's read, since a read can
// come from a block or two back. The transaction that delivered it is the
// one the other side's Mailbox processed it in. To Dusk, a route holds the
// first transfer to an account in escrow until it's claimed: the transfer
// waits for that, and for a claim sent from here, to its transaction.

import { duskRecipientHash, readTransferRemoteArgs } from "./hyperlane.js";
import { networkName } from "./names.js";

/** Sepolia makes a block every 12 seconds. */
const EVM_BLOCK_SECONDS = 12;
/** How far back a delivery's log is looked for: about a week of blocks. */
const EVM_LOOKBACK = 50_000n;
/** Dusk makes a block about every 10 seconds. */
const DUSK_BLOCK_SECONDS = 10;
/** How many blocks before the one it's looked for up to a delivery's transaction is looked for in, in one query. */
const DELIVERY_BLOCKS = 40n;
/** How often those blocks are read for it, as the node's events can trail its state, before it's left without. */
const DELIVERY_SCANS = 3;
/** How often the EVM chain's delivery log is looked for, as a public RPC can trail the chain, before it's left without: a light read. */
const DELIVERY_LOG_TRIES = 20;
/** How long a claim sent from here is waited for once the escrow reads empty: past it, the payout is what counts. */
const CLAIM_WAIT_MS = 10 * 60_000;

const bare = (hex) => String(hex ?? "").toLowerCase().replace(/^0x/u, "");

const pending = (note, extra = {}) => ({ ...extra, note, status: "pending" });
const failed = (note, extra = {}) => ({ ...extra, note, status: "failed" });
const completed = (extra = {}) => ({ ...extra, note: "", status: "completed" });

/** Why a transaction followed on a route isn't a transfer on it: it moved nothing there. */
export const NOT_A_TRANSFER = "This transaction isn't a transfer on this route.";

/**
 * Whether a Hyperlane transfer that arrived is still without the
 * transaction that delivered it, and worth another look for it, as when its
 * receipt opens or its check comes round: on Dusk, by its Mailbox's event,
 * a few times; on the EVM chain, by its Mailbox's log, for longer.
 */
export function deliveryLinkDue(entry, route) {
  if (route?.mode !== "hyperlane" || entry?.status !== "completed") return false;
  const tries = entry.deliveryScans ?? 0;
  return route.to.id === "dusk"
    ? Boolean(entry.delivered) && !entry.deliveryHash && tries < DELIVERY_SCANS
    : Boolean(entry.messageId) && !entry.destinationHash && tries < DELIVERY_LOG_TRIES;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg the deployment config
 * @param {object} deps.node the Dusk node
 * @param {object} deps.reads the Hyperlane reads (hyperlane-reads.js)
 * @param {(tx: object) => string | undefined} deps.feeOf what a Dusk transaction paid in gas, in Lux
 * @param {Record<string, string>} deps.replaced why a transfer the wallet cancelled or replaced moved nothing, by how (`cancelled`, `replaced`)
 * @param {() => number} [deps.now]
 */
export function createHyperlaneTracking({ cfg, feeOf, node, now = Date.now, reads, replaced }) {
  const name = (id) => networkName(cfg, id);

  /** Where a transfer's delivery log can be on the EVM chain: from the block before it was sent. */
  async function fromBlock(entry, sourceAt) {
    if (entry.scanFrom !== undefined && entry.scanFrom !== null) return BigInt(entry.scanFrom);
    if (!sourceAt) return null;
    const head = await reads.evmHead();
    const back = BigInt(Math.ceil(Math.max(0, now() - sourceAt) / 1_000 / EVM_BLOCK_SECONDS)) + 25n;
    return back > EVM_LOOKBACK ? null : head > back ? head - back : 0n;
  }

  /**
   * To the EVM chain: the transfer's call on Dusk, its message from the
   * Mailbox's `dispatch_id` event in the same transaction, then the EVM
   * Mailbox's word that it's delivered, with the transaction that did.
   */
  async function refreshOut(entry, route) {
    const token = route.hyperlane;
    const tx = await node.transaction(entry.hash);
    if (!tx) return pending(`Waiting for ${name("dusk")}.`);
    const sourceAt = tx.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
    const call = tx.callData;
    const args = call?.fnName === "transfer_remote" && bare(call.contractId) === token.dusk.route ? readTransferRemoteArgs(call.data ?? "") : null;
    if (!args || args.destination !== cfg.hyperlane.evm.domain) return failed(NOT_A_TRANSFER, { sourceAt });
    const deposit = BigInt(tx.json?.deposit ?? 0);
    const fee = token.native ? deposit - args.amount : deposit;
    const patch = {
      amountLux: args.amount.toString(),
      bridgeFeeLux: (fee > 0n ? fee : 0n).toString(),
      destination: args.recipient ?? args.recipient32,
      feeLux: feeOf(tx),
      sender: tx.json?.sender,
      sourceAt,
    };
    if (tx.error) return failed(`The transfer failed on ${name("dusk")}.`, { ...patch, sourceFailed: true });
    const messageId = entry.messageId ?? (await reads.dispatchedId(entry.hash, tx.blockHeight));
    if (!messageId) return pending(`Waiting for ${name("dusk")}.`, patch);
    patch.messageId = messageId;
    const to = name(route.to.id);
    if (!(await reads.deliveredOnEvm(messageId))) return pending(`On its way to ${to}.`, { ...patch, onTheWay: true });
    const from = await fromBlock(entry, sourceAt);
    const processed = from === null ? null : await reads.processedOnEvm(messageId, from).catch(() => null);
    return completed({
      ...patch,
      // When it arrived, where the chain says, or as this page saw it go by.
      destinationAt: processed?.at ?? entry.destinationAt ?? (entry.onTheWay ? now() : null),
      destinationHash: processed?.hash ?? undefined,
      // Its log not read yet: looked for again on the next checks (`deliveryLinkDue`).
      ...(processed ? {} : { deliveryScans: (entry.deliveryScans ?? 0) + 1 }),
      receivedLux: patch.amountLux,
    });
  }

  /**
   * To Dusk: the transfer's receipt on the EVM chain, its message from the
   * Mailbox's `DispatchId` log, then Dusk's Mailbox's word that it's
   * delivered, and then whether the route holds it in escrow for the
   * account. Once delivered, the EVM chain isn't read again.
   */
  async function refreshIn(entry, route) {
    const token = route.hyperlane;
    const from = name(route.from.id);
    // Cancelled or replaced in the wallet after it was sent: its own hash is never mined.
    if (entry.replaced) return failed(replaced[entry.replaced] ?? replaced.replaced, { sourceFailed: true });
    let patch;
    if (entry.delivered && entry.messageId && entry.recipientHash) patch = {};
    else {
      const read = await reads.evmTransfer(entry.hash, token);
      if (!read) return pending(`Waiting for ${from}.`);
      patch = { feeWei: read.feeWei === null ? undefined : read.feeWei.toString(), sender: read.from ?? undefined, sourceAt: read.at };
      if (read.failed) return failed(`The transfer failed on ${from}.`, { ...patch, sourceFailed: true });
      if (read.to !== token.evm.token.toLowerCase() || !read.sent || read.sent.destination !== cfg.hyperlane.dusk.domain || !read.messageId)
        return failed(NOT_A_TRANSFER, patch);
      Object.assign(patch, { amountLux: read.sent.amount.toString(), messageId: read.messageId, recipientHash: read.sent.recipient });
      if (entry.bridgeFeeWei === undefined) {
        const value = await reads.evmValue(entry.hash);
        if (value !== null) patch.bridgeFeeWei = value.toString();
      }
    }
    const messageId = patch.messageId ?? entry.messageId;
    const recipientHash = patch.recipientHash ?? entry.recipientHash;
    // A Dusk account this page knows is the one paid only where its hash is the transfer's.
    if (entry.destination && duskRecipientHash(entry.destination) !== recipientHash) patch.destination = null;
    if (!entry.delivered && !(await reads.deliveredOnDusk(messageId))) return pending(`On its way to ${name("dusk")}.`, { ...patch, onTheWay: true });
    const sourceAt = patch.sourceAt ?? entry.sourceAt;
    // When it arrived: its delivering transaction's block, else as this page saw it go by.
    const found = await deliveryOf(entry, messageId, sourceAt);
    const delivered = { ...patch, ...found, delivered: true, deliveredAt: found.deliveredAt ?? entry.deliveredAt ?? (entry.onTheWay ? now() : null) };
    let settled = await settleClaim(entry);
    // A claim not found in ten minutes is let go before anything else, held
    // or not: a dropped transaction never settles, and the claim is offered again.
    if (settled.waiting && !(entry.pendingAt && now() - entry.pendingAt <= CLAIM_WAIT_MS)) settled = { patch: { pendingAction: null, pendingHash: null }, waiting: false };
    const [escrow] = await reads.escrow(recipientHash, [token]);
    if (escrow.pending > 0n)
      return pending(settled.waiting ? "Claim sent, waiting for Dusk." : `Held on ${name("dusk")} until it's claimed.`, {
        ...delivered,
        ...settled.patch,
        escrow: "held",
        heldLux: escrow.pending.toString(),
      });
    // The payout is out. A claim sent from here is still found, for its time and fee.
    if (settled.waiting) return pending("Claim sent, waiting for Dusk.", { ...delivered, escrow: "held" });
    // Paid: straight away, or by a claim since.
    const claimed = entry.escrow === "held" || Boolean(settled.patch.claimHash ?? entry.claimHash);
    return completed({
      ...delivered,
      ...settled.patch,
      destinationAt: settled.patch.claimAt ?? entry.claimAt ?? delivered.deliveredAt,
      escrow: claimed ? "claimed" : null,
      receivedLux: entry.amountLux ?? patch.amountLux,
    });
  }

  /**
   * The Dusk transaction that delivered the message, and its block's time:
   * its Mailbox's `process_id` event, in the 41 blocks up to `deliveryNear`
   * (`nearDelivery`). Tried on a few checks, as the node's events can trail
   * its state, then left. A read that fails counts as a try: the transfer
   * arrived all the same.
   */
  async function deliveryOf(entry, messageId, sourceAt) {
    const tries = entry.deliveryScans ?? 0;
    if (entry.deliveryHash || tries >= DELIVERY_SCANS) return {};
    let near = entry.deliveryNear ? BigInt(entry.deliveryNear) : null;
    try {
      near ??= await nearDelivery(entry, sourceAt);
      const at = await reads.processedOnDusk(messageId, { from: near > DELIVERY_BLOCKS ? near - DELIVERY_BLOCKS : 0n, to: near });
      if (at) {
        const tx = await node.transaction(at.hash).catch(() => null);
        return { deliveryHash: at.hash, ...(tx?.blockTimestamp ? { deliveredAt: Number(tx.blockTimestamp) * 1_000 } : {}) };
      }
    } catch {
      // Tried again on the next check.
    }
    return { ...(near === null ? {} : { deliveryNear: near.toString() }), deliveryScans: tries + 1 };
  }

  /**
   * The block a delivery is looked for up to: the tip, where the last check,
   * recent enough, found the transfer on its way, so it arrived since; else
   * 30 blocks past where it should be, the route's usual time after it was
   * sent.
   */
  async function nearDelivery(entry, sourceAt) {
    const tip = await node.latestBlock();
    const since = entry.lastCheckedAt ? now() - entry.lastCheckedAt : Infinity;
    if (entry.onTheWay && !entry.delivered && since <= Number(DELIVERY_BLOCKS) * DUSK_BLOCK_SECONDS * 1_000) return tip.height;
    const expected = (sourceAt ?? now()) / 1_000 + (cfg.hyperlane.seconds?.in ?? 60);
    const behind = BigInt(Math.max(0, Math.ceil((Number(tip.timestamp) - expected) / DUSK_BLOCK_SECONDS)));
    const middle = tip.height > behind ? tip.height - behind : 0n;
    return middle + 30n < tip.height ? middle + 30n : tip.height;
  }

  /**
   * A claim this page sent for the transfer (`pendingAction`): settled once
   * its transaction is in a block, with its time and fee, or, where it
   * failed on Dusk, why, its transaction and what it cost, and it's offered
   * again.
   */
  async function settleClaim(entry) {
    if (entry.pendingAction !== "claim" || !entry.pendingHash) return { patch: {}, waiting: false };
    const tx = await node.transaction(entry.pendingHash).catch(() => null);
    if (!tx) return { patch: {}, waiting: true };
    if (tx.error) {
      // Every claim that failed was paid for: their fees add up.
      const fee = feeOf(tx);
      const paid = fee === undefined ? entry.claimFailedFeeLux : (BigInt(entry.claimFailedFeeLux ?? 0) + BigInt(fee)).toString();
      return {
        patch: { actionError: `The claim failed on Dusk: ${tx.error}`, claimFailedFeeLux: paid, claimFailedHash: entry.pendingHash, pendingAction: null, pendingHash: null },
        waiting: false,
      };
    }
    return {
      patch: { claimAt: tx.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null, claimFeeLux: feeOf(tx), claimHash: entry.pendingHash, pendingAction: null, pendingHash: null },
      waiting: false,
    };
  }

  /**
   * An arrived transfer's delivering transaction, where it wasn't found
   * when it arrived: only that, and its block's time, are looked for. What
   * became of the transfer isn't read again, so a node a block behind can't
   * undo it.
   */
  async function linkOf(entry, route) {
    if (route.from.id !== "dusk") {
      const found = await deliveryOf(entry, entry.messageId, entry.sourceAt);
      // Arrived straight away: it arrived when it was delivered.
      return found.deliveredAt && entry.escrow !== "claimed" && entry.escrow !== "held" ? { ...found, destinationAt: found.deliveredAt } : found;
    }
    const from = await fromBlock(entry, entry.sourceAt);
    const processed = from === null ? null : await reads.processedOnEvm(entry.messageId, from).catch(() => null);
    return processed ? { destinationAt: processed.at ?? entry.destinationAt, destinationHash: processed.hash } : { deliveryScans: (entry.deliveryScans ?? 0) + 1 };
  }

  /** The entry's state, from the chains; for one that arrived without its delivering transaction, that alone. */
  const refresh = (entry, route) =>
    entry.status === "completed" && deliveryLinkDue(entry, route) ? linkOf(entry, route) : route.from.id === "dusk" ? refreshOut(entry, route) : refreshIn(entry, route);

  return Object.freeze({ refresh });
}
