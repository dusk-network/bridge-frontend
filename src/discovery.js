// My transfers: what the connected accounts did through the bridge, read from
// the networks so the list is the same on any device. The Dusk account's
// archive history gives its deposits, its transfers to the bridge account and
// the payouts of its migrations (@dusk-network/app-core/bridge); DuskEVM's
// bridge events give the EVM address's withdrawals. Each source is synced a
// bounded number of requests per visit and kept here per network and
// account; a transfer found twice, or found and also sent from this browser,
// is one entry.

import { migrationPayoutOf } from "@dusk-network/app-core/bridge";
import { syncWithdrawals } from "@dusk-network/app-core/duskevm-withdrawals";
import { StaleHistoryError, createHistory } from "@dusk-network/app-core/history";
import { routes } from "@dusk-network/networks";

import { entryId } from "./activity.js";
import { pageStorage as defaultStorage } from "./page-storage.js";
import { sentToSomeoneElse, withdrawalNextAction } from "./transfer-view.js";

const WEI_PER_LUX = 1_000_000_000n;
const TERMINAL = new Set(["completed", "failed"]);
const STORAGE_PREFIX = "dusk-bridge:discovery:v1";

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

/** Whether `state` was kept. */
export function saveState(key, state, storage = defaultStorage()) {
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    // Storage can be full or refused; the next visit reads the network again.
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Dusk account's history (@dusk-network/app-core/history), kept as one
// JSON per network and account: its sync state, and of its entries only the
// bridge's, as records:
// - `{ kind: "deposit", hash, amountLux, destination }`, into DuskEVM
// - `{ kind: "service", hash, amountLux, destination }`, to the bridge account
// - `{ kind: "payout", hash, amountLux, routeId, sourceHash }`, a migration paying out
// each with its `blockHeight`, and its time once read: `sourceAt`, or a
// payout's `payoutAt`. A deposit's amount and DuskEVM address come from its
// call, with its time: an entry's `value` is what the account paid, a gas
// refund paid to another account included.
// ---------------------------------------------------------------------------

/** What an entry of the account's history is to the bridge, as a record, or null. */
function recordOf(entry, cfg) {
  const base = { blockHeight: entry.blockHeight, hash: entry.hash };
  if (entry.kind === "contract_call" && cfg.duskEvm.enabled && entry.counterparty === cfg.duskEvm.l1StandardBridgeContractId)
    return { ...base, destination: null, kind: "deposit" };
  // A memo of bytes rather than typed text names no address the bridge reads.
  if (entry.direction === "out" && entry.kind === "transfer" && cfg.service && entry.counterparty === cfg.service.account)
    return { ...base, amountLux: entry.value, destination: (!entry.memoBinary && entry.memo.trim()) || null, kind: "service" };
  // A transfer from a migration's payout account, with its hash as the memo,
  // of what it paid. One from an account that pays out both chains doesn't
  // say which it is for: left out.
  const payout = migrationPayoutOf(entry, cfg.network);
  if (payout?.route) return { ...base, amountLux: payout.amount.toString(), kind: "payout", routeId: payout.route, sourceHash: payout.hash };
  return null;
}

/** A record as the history asks after it: its time, and a deposit's call, until they're read. */
function entryOf(record, cfg) {
  const read = (record.kind === "payout" ? record.payoutAt : record.sourceAt) !== undefined;
  const bridge = record.destination ? { amount: record.amountLux, kind: "deposit", to: record.destination } : read ? null : undefined;
  return {
    blockHeight: record.blockHeight,
    hash: record.hash,
    ...(read ? { detailsAt: 1 } : {}),
    ...(record.kind === "deposit" ? { bridge, counterparty: cfg.duskEvm.l1StandardBridgeContractId } : {}),
  };
}

/** The store the history keeps one account's state and records in, under `key`. */
function historyStore(key, cfg, storage) {
  // A state storage refused, kept for the rest of the run, null once cleared:
  // the visit still lists what it found. Undefined while storage keeps it.
  let unsaved;
  const load = () => (unsaved === undefined ? loadState(key, storage) : unsaved);
  const keep = (state) => {
    unsaved = saveState(key, state, storage) ? undefined : state;
    return state;
  };
  // A reset chain's history is forgotten, and details are kept, only while
  // `check` says it's still the one the run read: another tab may have
  // started it over meanwhile.
  return {
    clear(check) {
      check?.(load());
      keep(null);
    },
    commit(entries, update) {
      const kept = load();
      const found = entries.map((entry) => recordOf(entry, cfg)).filter(Boolean);
      return keep({
        ...update(kept),
        // A record kept already stays as it is: it has its time.
        entries: { ...Object.fromEntries(found.map((record) => [record.hash, record])), ...kept?.entries },
      });
    },
    getState: load,
    list: ({ before, limit }) =>
      Object.values(load()?.entries ?? {})
        .filter((record) => before === undefined || record.blockHeight < before)
        .sort((a, b) => b.blockHeight - a.blockHeight)
        .slice(0, limit)
        .map((record) => entryOf(record, cfg)),
    patch(details, check) {
      const state = load();
      check?.(state);
      for (const [hash, found] of details) {
        const record = state?.entries?.[hash];
        if (!record) continue;
        record[record.kind === "payout" ? "payoutAt" : "sourceAt"] = found.timestamp;
        if (found.bridge?.kind === "deposit") {
          record.amountLux = found.bridge.amount;
          record.destination ||= found.bridge.to;
        }
      }
      if (state) keep(state);
    },
  };
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
  // An amount once known stays: the account's history reads what its balance
  // moved, a gas refund paid with the transfer included.
  const known = existing.amountLux !== undefined && existing.amountLux !== null;
  for (const [key, value] of Object.entries(update))
    if (value !== undefined && value !== null && key !== "parties" && !(key === "amountLux" && known)) merged[key] = value;
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

/**
 * Where a transfer goes on My transfers. A withdrawal under way that pays
 * another Dusk account than `owner`, the one the list is for, waits apart
 * while nobody, or another account, has proved it: it needs no one in
 * particular. Once `owner` has, only `owner` can claim it.
 */
export function transferGroup(entry, route, owner = "") {
  if (entry.status === "completed") return "done";
  if (entry.status === "failed") return "failed";
  if (sentToSomeoneElse(entry, route, owner)) return "other";
  if (route?.mode === "duskevm-withdrawal" && !entry.pendingAction && withdrawalNextAction(entry.stage))
    return "needs";
  return "progress";
}

/** Needs you, In progress, Sent to someone else, Completed and Failed, newest first. */
export function groupTransfers(entries, routeOf, owner = "") {
  const groups = { done: [], failed: [], needs: [], other: [], progress: [] };
  for (const entry of entries) groups[transferGroup(entry, routeOf(entry.routeId), owner)].push(entry);
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
  // A payout an earlier version kept unverified: the one route its payout account pays out.
  const paid = record.routeId || record.rejected ? [] : routes(cfg.network).filter((route) => route.kind === "migration" && route.payoutAccount && route.payoutAccount === record.payer);
  const routeId = record.routeId ?? (paid.length === 1 ? paid[0].id : null);
  if (record.kind === "payout" && routeId)
    return {
      amountLux: record.amountLux,
      destination: account,
      destinationAt: record.payoutAt ?? undefined,
      destinationHash: record.hash,
      hash: record.sourceHash,
      parties: [account, record.sender],
      routeId,
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

/**
 * Finds the connected accounts' transfers.
 *
 * @param {object} deps
 * @param {object} deps.archive the Dusk node's archive (@dusk-network/app-core/history)
 * @param {object} deps.cfg
 * @param {(network: string, method: string, params: unknown[]) => Promise<any>} deps.rpc
 * @param {Storage} [deps.storage]
 */
export function createDiscovery({ archive, cfg, rpc, storage = defaultStorage() }) {
  async function duskAccount(account, maxRequests) {
    const store = historyStore(stateKey(cfg, "dusk", account), cfg, storage);
    const history = createHistory({ account, archive, network: cfg.network, store });
    try {
      await history.sync({ maxDetailRequests: 0, maxRequests });
    } catch (error) {
      // Another run started the history over, as on a reset testnet: it's that run's now.
      if (!(error instanceof StaleHistoryError)) throw error;
    }
    // Times and DuskEVM addresses. What can't be read now is left for the
    // tracker, which reads the transaction anyway.
    await history.fillDetails(store.list({ limit: Infinity })).catch(() => {});
    const state = store.getState();
    return { entries: Object.values(state?.entries ?? {}).map((record) => entryFromHistory(record, account, cfg)).filter(Boolean), state };
  }

  async function evmAddress(address, maxRequests) {
    const key = stateKey(cfg, "l2", address);
    const { state } = await syncWithdrawals({
      address,
      bridge: cfg.duskEvm.predeploys.l2StandardBridge,
      duskEvm: { request: ({ method, params }) => rpc("dusk-evm", method, params) },
      maxRequests,
      state: loadState(key, storage),
    });
    saveState(key, state, storage);
    return { entries: Object.values(state.entries).map((record) => entryFromWithdrawal(record, address)), state };
  }

  return Object.freeze({
    /**
     * Reads what is new for the accounts given, and older heights within the
     * request budgets. Returns the entries found and the sources' coverage.
     * One run at a time: discovery-runs.js runs it.
     */
    async discover({ dusk, duskRequests, evm, evmRequests }) {
      const jobs = [];
      if (dusk) jobs.push(duskAccount(dusk, duskRequests).then((r) => ({ ...r, source: "dusk" })));
      if (evm && cfg.duskEvm.enabled) jobs.push(evmAddress(evm, evmRequests).then((r) => ({ ...r, source: "l2" })));
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
