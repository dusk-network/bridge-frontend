// My transfers: what the connected accounts did through the bridge, read from
// the networks so the list is the same on any device. The Dusk account's
// archive history gives its deposits, its transfers to the bridge account and
// the payouts of its migrations; DuskEVM's bridge events give the EVM
// address's withdrawals. Each source is synced a bounded number of requests
// per visit and kept here per network and account; a transfer found twice, or
// found and also sent from this browser, is one entry.

import { decodeFunctionData, parseAbi } from "viem";

import { syncDuskHistory } from "./dusk-history.js";
import { syncWithdrawals } from "./l2-withdrawals.js";
import { entryId } from "./activity.js";
import { decodeDepositArgs, DEPOSIT_FN_NAME } from "./dusk-deposit.js";
import { withdrawalNextAction } from "./withdrawal-lifecycle.js";

const WEI_PER_LUX = 1_000_000_000n;
const TERMINAL = new Set(["completed", "failed"]);
const STORAGE_PREFIX = "dusk-bridge:discovery:v1";

const defaultStorage = () => globalThis.localStorage;

/** Who a transfer involves, compared without EVM checksum case. */
export const partyKey = (value) => {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-f]{40}$/iu.test(text) ? text.toLowerCase() : text;
};

export const stateKey = (cfg, kind, account) => `${STORAGE_PREFIX}:${cfg.profile}:${kind}:${partyKey(account)}`;

export function loadState(key, storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveState(key, state, storage = defaultStorage()) {
  try {
    storage?.setItem(key, JSON.stringify(state));
  } catch {
    // Storage can be full or refused; the next visit reads the network again.
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * One transfer from two reads of it: values the update knows replace what was
 * kept, a transfer that ended stays ended, and both sides' parties are kept.
 */
export function mergeTransfer(existing, update) {
  if (!existing) return { status: "pending", ...update, parties: [...new Set((update.parties ?? []).filter(Boolean).map(partyKey))] };
  const merged = { ...existing };
  for (const [key, value] of Object.entries(update))
    if (value !== undefined && value !== null && key !== "parties") merged[key] = value;
  if (TERMINAL.has(existing.status) && !TERMINAL.has(update.status)) {
    merged.status = existing.status;
    merged.note = existing.note;
  }
  merged.parties = [...new Set([...(existing.parties ?? []), ...(update.parties ?? [])].filter(Boolean).map(partyKey))];
  merged.sentHere = Boolean(existing.sentHere || update.sentHere);
  merged.createdAt = [existing.createdAt, update.createdAt].filter(Boolean).sort()[0] ?? existing.createdAt;
  return merged;
}

/** Entries by id, each transfer once. */
export function mergeTransfers(kept, updates) {
  const byId = new Map(kept.map((entry) => [entry.id, entry]));
  for (const update of updates) {
    const id = update.id ?? entryId(update.routeId, update.hash);
    byId.set(id, mergeTransfer(byId.get(id), { ...update, id }));
  }
  return [...byId.values()];
}

/** Whether a transfer involves one of `accounts`, or was followed on this device. */
export function shownFor(entry, accounts) {
  if (entry.sentHere || entry.followed) return true;
  const wanted = new Set(accounts.filter(Boolean).map(partyKey));
  return (entry.parties ?? []).some((party) => wanted.has(partyKey(party)));
}

const timeOf = (entry) =>
  entry.sourceAt ?? entry.destinationAt ?? (entry.createdAt ? Date.parse(entry.createdAt) : 0);

/** Where a transfer goes on My transfers. */
export function transferGroup(entry, route) {
  if (entry.status === "completed") return "done";
  if (entry.status === "failed") return "failed";
  if (route?.mode === "duskevm-withdrawal" && !entry.pendingAction && withdrawalNextAction(entry.stage))
    return "needs";
  return "progress";
}

/** Needs you, In progress, Completed and Failed, newest first. */
export function groupTransfers(entries, routeOf) {
  const groups = { done: [], failed: [], needs: [], progress: [] };
  for (const entry of entries) groups[transferGroup(entry, routeOf(entry.routeId))].push(entry);
  for (const list of Object.values(groups)) list.sort((a, b) => timeOf(b) - timeOf(a));
  return groups;
}

// ---------------------------------------------------------------------------
// From what the networks say to entries
// ---------------------------------------------------------------------------

/** An archive record as a transfer entry, or null when it isn't one yet. */
export function entryFromHistory(record, account, cfg) {
  const parties = [account, record.destination];
  if (record.kind === "deposit")
    return {
      amountLux: record.amountLux,
      destination: record.destination ?? undefined,
      hash: record.hash,
      parties,
      routeId: "dusk-to-dusk-evm",
      sender: account,
      sourceAt: record.sourceAt ?? undefined,
    };
  if (record.kind === "service" && cfg.service)
    return {
      amountLux: record.amountLux,
      destination: record.destination ?? undefined,
      hash: record.hash,
      parties,
      routeId: `dusk-to-${cfg.service.network}`,
      sender: account,
      sourceAt: record.sourceAt ?? undefined,
    };
  if (record.kind === "payout" && record.routeId)
    return {
      amountLux: record.amountLux,
      destination: account,
      destinationAt: record.payoutAt ?? undefined,
      destinationHash: record.hash,
      hash: record.sourceHash,
      parties: [account, record.sender],
      routeId: record.routeId,
      sender: record.sender ?? undefined,
      sourceAt: record.sourceAt ?? undefined,
      status: "completed",
    };
  return null;
}

/** A DuskEVM bridge log as a withdrawal entry. */
export function entryFromWithdrawal(record, address) {
  return {
    amountLux: (BigInt(record.amountWei) / WEI_PER_LUX).toString(),
    destination: record.destination ?? undefined,
    hash: record.hash,
    parties: [address, record.destination],
    routeId: "dusk-evm-to-dusk",
    sender: address,
  };
}

const MIGRATE_ABI = parseAbi(["function migrate(uint256 amount, string mainnetDuskAddress)"]);

/**
 * Whether a migration call pays `account` exactly this payout's amount: the
 * memo is public, so a transfer naming someone else's migration, or carrying
 * another amount, isn't its payout. With the payout account known, only
 * transfers from it count.
 */
function paysAsMigrated(record, tx, account, payer) {
  try {
    const { args } = decodeFunctionData({ abi: MIGRATE_ABI, data: tx.input });
    return (
      args[1] === account &&
      (args[0] / WEI_PER_LUX).toString() === String(record.amountLux) &&
      (!payer || record.payer === payer)
    );
  } catch {
    return false;
  }
}

/**
 * Payouts whose memo names a migration: kept when that EVM transaction is a
 * migration to `account` of the amount paid, with its route; rejected when
 * every configured chain says it isn't. A chain that can't be asked leaves
 * the payout to the next visit. One batch per chain.
 */
export async function verifyPayouts(records, { account, cfg, rpcBatch }) {
  const open = records.filter((record) => record.kind === "payout" && !record.routeId && !record.rejected);
  if (!open.length) return [];
  const settled = new Set();
  const unknown = new Set();
  const changed = [];
  for (const network of cfg.migrations) {
    const contract = String(cfg.evmNetworks[network].migrationContract).toLowerCase();
    const waiting = open.filter((record) => !settled.has(record.hash));
    if (!waiting.length) break;
    let results;
    try {
      results = await rpcBatch(
        network,
        waiting.map((record) => ({ method: "eth_getTransactionByHash", params: [record.sourceHash] })),
      );
    } catch {
      for (const record of waiting) unknown.add(record.hash);
      continue;
    }
    waiting.forEach((record, index) => {
      const tx = results[index];
      // No answer for this one: whether it's a migration isn't known yet.
      if (tx === undefined) {
        unknown.add(record.hash);
        return;
      }
      if (!tx || String(tx.to ?? "").toLowerCase() !== contract) return;
      settled.add(record.hash);
      // Only the chain's payout account pays its migrations, where it's known.
      if (paysAsMigrated(record, tx, account, cfg.evmNetworks[network].payoutAccount || null))
        Object.assign(record, { routeId: `${network}-to-dusk`, sender: String(tx.from ?? "").toLowerCase() });
      else record.rejected = true;
      changed.push(record);
    });
  }
  // A memo that is no migration on any configured chain isn't one.
  for (const record of open)
    if (!settled.has(record.hash) && !unknown.has(record.hash)) {
      record.rejected = true;
      changed.push(record);
    }
  return changed;
}

/** Times and recipients for new archive records: one aliased node request. */
async function addDetails(records, node) {
  const missing = records.filter(
    (record) => !record.rejected && (record.kind === "payout" ? record.payoutAt : record.sourceAt) === undefined,
  );
  await Promise.all(
    missing.map(async (record) => {
      try {
        const tx = await node.transaction(record.hash);
        const at = tx?.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
        if (record.kind === "payout") record.payoutAt = at;
        else record.sourceAt = at;
        if (record.kind === "deposit" && tx?.callData?.fnName === DEPOSIT_FN_NAME && !record.destination)
          record.destination = decodeDepositArgs(tx.callData.data).to;
      } catch {
        // Left for the tracker, which reads the transaction anyway.
      }
    }),
  );
}

/**
 * Finds the connected accounts' transfers.
 *
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.node the Dusk node client
 * @param {(network: string, method: string, params: unknown[]) => Promise<any>} deps.rpc
 * @param {(network: string, calls: object[]) => Promise<any[]>} deps.rpcBatch
 * @param {Storage} [deps.storage]
 */
export function createDiscovery({ cfg, node, rpc, rpcBatch, storage = defaultStorage() }) {
  const running = new Map();

  async function duskAccount(account, maxRequests) {
    const key = stateKey(cfg, "dusk", account);
    const { state } = await syncDuskHistory({
      account,
      cfg,
      maxRequests,
      query: (selection) => node.query(selection),
      state: loadState(key, storage),
    });
    const records = Object.values(state.entries);
    await verifyPayouts(records, { account, cfg, rpcBatch });
    await addDetails(records, node);
    saveState(key, state, storage);
    return { entries: records.map((record) => entryFromHistory(record, account, cfg)).filter(Boolean), state };
  }

  async function evmAddress(address, maxRequests) {
    const key = stateKey(cfg, "l2", address);
    const { state } = await syncWithdrawals({
      address,
      bridge: cfg.duskEvm.l2StandardBridgeAddress,
      maxRequests,
      rpc: (method, params) => rpc("dusk-evm", method, params),
      state: loadState(key, storage),
    });
    saveState(key, state, storage);
    return { entries: Object.values(state.entries).map((record) => entryFromWithdrawal(record, address)), state };
  }

  /** Each source once at a time; a second call waits for the running one. */
  function once(key, run) {
    if (!running.has(key)) running.set(key, run().finally(() => running.delete(key)));
    return running.get(key);
  }

  return Object.freeze({
    /**
     * Reads what is new for the accounts given, and older heights within the
     * request budgets. Returns the entries found and the sources' coverage.
     */
    async discover({ dusk, duskRequests, evm, evmRequests }) {
      const jobs = [];
      if (dusk) jobs.push(once(`dusk:${dusk}`, () => duskAccount(dusk, duskRequests)).then((r) => ({ ...r, source: "dusk" })));
      if (evm && cfg.duskEvm.enabled)
        jobs.push(once(`l2:${partyKey(evm)}`, () => evmAddress(evm, evmRequests)).then((r) => ({ ...r, source: "l2" })));
      const results = await Promise.allSettled(jobs);
      return {
        entries: results.flatMap((result) => (result.status === "fulfilled" ? result.value.entries : [])),
        errors: results.filter((result) => result.status === "rejected").map((result) => result.reason),
        sources: Object.fromEntries(
          results.filter((result) => result.status === "fulfilled").map((result) => [result.value.source, result.value.state]),
        ),
      };
    },
  });
}

/**
 * Whether a transfer discovery returned is followed now: an unfinished one
 * that's new or not followed yet, and a finished one the history left
 * without its start, as a migration found by its payout lacks its sent time
 * and network fee: once a visit, until a check fills them in.
 */
export function followAfterDiscovery(entry, { known, tracked }) {
  if (entry.status === "pending") return !known.has(entry.id) || !tracked.has(entry.id);
  return entry.status === "completed" && !entry.sourceAt && !tracked.has(entry.id);
}
