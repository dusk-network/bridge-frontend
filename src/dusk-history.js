// A Dusk account's bridge transfers, from the archive's `moonlightHistory`,
// synced by block height and kept on this device per network and account.
// Ported from the wallet extension's activityHistory.js (its windows,
// coverage and page handling), keeping only what the bridge needs:
//
// - The archive answers ascending pages only, so a sync covers the chain from
//   the top down in windows: the newest first, wider windows below while they
//   hold few entries, narrower ones where a page fills.
// - Each request asks for both directions (sender and receiver) as GraphQL
//   aliases. A run makes a bounded number of requests; the kept coverage lets
//   the next run carry on where this one stopped, and a later visit asks only
//   for what is new.
// - An entry read twice is the same entry, by its hash.
//
// Of the account's history, it keeps deposits into the DuskEVM bridge,
// transfers to the operated bridge account, and payouts of old-DUSK
// migrations (incoming transfers whose memo is an EVM transaction hash).

import { fromHex } from "./data-driver.js";

/** Entries one history query returns per direction. */
export const PAGE = 50;
/** The first window: about a day of 10-second blocks. */
export const FIRST_WINDOW = 8_640;
/** Blocks under the last finalized one that count as covered: the archive may not have indexed them yet. */
export const FINALITY_MARGIN = 10;
/** History requests one run makes. */
export const RUN_REQUESTS = 6;

const MAX_WINDOW = 2 ** 40;
const TRANSFER_CONTRACT = `01${"0".repeat(62)}`;
const HASH = /^[0-9a-f]{64}$/u;
const EVM_TX_HASH = /^0x[0-9a-f]{64}$/iu;

// ---------------------------------------------------------------------------
// Coverage: disjoint [lo, hi] ranges of heights whose entries are all kept,
// highest first. (activityHistory.js)
// ---------------------------------------------------------------------------

/** `covered` with `[lo, hi]` added, touching and overlapping ranges joined. */
export function addCoverage(covered, lo, hi) {
  if (!(hi >= lo)) return covered.map((range) => [...range]);
  const ranges = [...covered.map((range) => [...range]), [lo, hi]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of ranges) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.reverse();
}

/** The highest range of `[0, target]` that `covered` misses, or null. */
export function topGap(covered, target) {
  let hi = target;
  for (const [a, b] of covered) {
    if (b < hi) return [b + 1, hi];
    hi = Math.min(hi, a - 1);
    if (hi < 0) return null;
  }
  return hi >= 0 ? [0, hi] : null;
}

export function nextWindow(window, count) {
  if (count < PAGE / 4) return Math.min(window * 8, MAX_WINDOW);
  if (count < PAGE / 2) return Math.min(window * 2, MAX_WINDOW);
  return window;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const history = (alias, direction, account, { from, page, to }) => {
  const args = [`${direction}: ${JSON.stringify(account)}`, `fromBlock: ${from}`];
  if (to !== undefined) args.push(`toBlock: ${to}`);
  args.push(`maxCount: ${PAGE}`);
  if (page > 1) args.push(`pageCount: ${page}`);
  return `${alias}: moonlightHistory(${args.join(", ")}) { json }`;
};

/** Both directions of `[from, to]` in one request; with `head`, the last finalized block too. */
export function rangeSelection(account, { from, head = false, page = 1, to }) {
  return [
    head ? "pair: lastBlockPair { json }" : "",
    history("out", "sender", account, { from, page, to }),
    history("in", "receiver", account, { from, page, to }),
  ]
    .filter(Boolean)
    .join(" ");
}

function readHead(data) {
  const finalized = Number(data?.pair?.json?.last_finalized_block?.[0]);
  if (!Number.isSafeInteger(finalized) || finalized < 0)
    throw new Error("The Dusk node gave no finalized height.");
  return finalized;
}

const listOf = (field) => (Array.isArray(field?.json) ? field.json : []);

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });

function memoText(hex) {
  const value = String(hex ?? "");
  if (!value || value.length % 2 || !/^[0-9a-f]+$/iu.test(value)) return "";
  try {
    return utf8.decode(fromHex(value)).trim();
  } catch {
    return "";
  }
}

const lower = (value) => String(value ?? "").toLowerCase();

/** The DuskEVM recipient a deposit names: the last 20 bytes of its `eth_bridge_initiated` event. */
function depositRecipient(events, bridgeId) {
  const event = events.find(
    (item) => lower(item.target) === bridgeId && item.topic === "eth_bridge_initiated" && typeof item.data === "string",
  );
  if (!event || event.data.length < 160) return null;
  return `0x${event.data.slice(-40).toLowerCase()}`;
}

/**
 * What a history entry is to the bridge, as `account` sees it, or null:
 * - `{ kind: "deposit", hash, amountLux, destination }`, into DuskEVM
 * - `{ kind: "service", hash, amountLux, destination }`, to the bridge account
 * - `{ kind: "payout", hash, amountLux, sourceHash }`, a migration paying out
 */
export function bridgeEntry(account, raw, cfg) {
  const hash = lower(raw?.origin);
  const blockHeight = Number(raw?.block_height);
  if (!HASH.test(hash) || !Number.isSafeInteger(blockHeight)) return null;
  const events = (Array.isArray(raw?.events) ? raw.events : []).filter(
    (event) => event && typeof event === "object" && event.reverted !== true,
  );
  const bridgeId = cfg.duskEvm?.enabled ? lower(cfg.duskEvm.l1StandardBridgeContractId) : "";
  const base = { blockHeight, hash };
  for (const event of events) {
    if (lower(event.target) !== TRANSFER_CONTRACT || !event.data || typeof event.data !== "object") continue;
    const data = event.data;
    if (event.topic === "deposit" && bridgeId && data.sender === account && lower(data.receiver) === bridgeId)
      return {
        ...base,
        amountLux: String(data.value ?? "0"),
        destination: depositRecipient(events, bridgeId),
        kind: "deposit",
      };
    if (event.topic !== "moonlight") continue;
    if (cfg.service && data.sender === account && data.receiver === cfg.service.account)
      return {
        ...base,
        amountLux: String(data.value ?? "0"),
        destination: memoText(data.memo) || null,
        kind: "service",
      };
    const memo = memoText(data.memo);
    if (data.receiver === account && data.sender !== account && EVM_TX_HASH.test(memo))
      return { ...base, amountLux: String(data.value ?? "0"), kind: "payout", sourceHash: memo.toLowerCase() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** An empty sync state. */
export const emptyHistory = () => ({ covered: [], entries: {}, target: null, window: FIRST_WINDOW });

/**
 * One run over `account`'s history: what is new above the kept range, then
 * older heights, at most `maxRequests` requests. Returns the next state and
 * the bridge entries this run found.
 *
 * @param {object} options
 * @param {(selection: string) => Promise<object>} options.query the node's GraphQL
 * @param {string} options.account
 * @param {object} options.cfg
 * @param {object} [options.state] the kept state
 * @param {number} [options.maxRequests]
 */
export async function syncDuskHistory({ account, cfg, maxRequests = RUN_REQUESTS, query, state }) {
  const kept = state ?? emptyHistory();
  let covered = (kept.covered ?? []).map((range) => [...range]);
  let window = Number(kept.window) || FIRST_WINDOW;
  const entries = { ...(kept.entries ?? {}) };
  const found = [];
  let requests = 0;

  const take = (lists) => {
    for (const raw of lists.flat()) {
      const entry = bridgeEntry(account, raw, cfg);
      if (!entry || entries[entry.hash]) continue;
      entries[entry.hash] = entry;
      found.push(entry);
    }
  };

  /** One range; complete up to `completeTo`, lower if a page filled. */
  async function readRange(from, to, head = false) {
    requests += 1;
    const data = await query(rangeSelection(account, { from, head, to }));
    const out = listOf(data?.out);
    const inn = listOf(data?.in);
    take([out, inn]);
    let completeTo = to;
    let full = false;
    for (const list of [out, inn]) {
      if (list.length < PAGE) continue;
      full = true;
      const last = Number(list[list.length - 1]?.block_height);
      const below = Number.isSafeInteger(last) ? last - 1 : from - 1;
      completeTo = completeTo === undefined ? below : Math.min(completeTo, below);
    }
    return { completeTo, count: Math.max(out.length, inn.length), full, head: head ? readHead(data) : null };
  }

  // The head, with everything above the kept range in the same request.
  const keptTop = covered[0]?.[1];
  let target;
  if (keptTop === undefined) {
    requests += 1;
    target = readHead(await query("pair: lastBlockPair { json }")) - FINALITY_MARGIN;
  } else {
    const first = await readRange(keptTop + 1, undefined, true);
    target = first.head - FINALITY_MARGIN;
    const top = Math.min(first.completeTo ?? target, target);
    if (top > keptTop) covered = addCoverage(covered, keptTop + 1, top);
  }

  // Then what is missing, from the top down.
  while (requests < maxRequests) {
    const gap = topGap(covered, target);
    if (!gap) break;
    const [a, b] = gap;
    const lo = Math.max(a, b - window + 1);
    const range = await readRange(lo, b);
    if (!range.full) {
      covered = addCoverage(covered, lo, b);
      window = nextWindow(window, range.count);
    } else if (range.completeTo >= lo) {
      covered = addCoverage(covered, lo, range.completeTo);
      window = Math.max(1, Math.floor((range.completeTo - lo + 2) / 2));
    } else {
      // A page within one block: rare for one account; take that block alone next.
      window = 1;
      if (lo === b) covered = addCoverage(covered, lo, lo);
    }
  }

  return {
    found,
    requests,
    state: { covered, entries, target, updatedAt: Date.now(), window },
  };
}

/** Whether the kept history reaches the first block. */
export const historyComplete = (state) => Boolean(state?.covered?.length) && topGap(state.covered, state.target ?? 0) === null;
