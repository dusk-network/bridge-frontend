// The transfers this browser knows: sent here, looked up here, or found on
// the networks for a connected account. An entry needs just its route and
// source transaction hash: the tracker rebuilds everything else from the
// chain, so a lost or cleared entry can be added back from its hash.

const STORAGE_KEY = "dusk-bridge:activity:v2";
const LEGACY_KEY = "dusk-bridge:activity:v1";
const MAX_ITEMS = 200;

const defaultStorage = () => globalThis.localStorage;

// Each network keeps its own list: a site that serves another network keeps
// that one's transfers apart, though route names such as ethereum-to-dusk
// are the same on both.
let network = "";

/** The network this page's transfers are kept for, such as "testnet". */
export function useActivityNetwork(profile) {
  network = String(profile ?? "");
}

const storageKey = () => (network ? `${STORAGE_KEY}:${network}` : STORAGE_KEY);

export function normalizeTxHash(hash) {
  const value = String(hash ?? "").trim().toLowerCase();
  return /^(0x)?[0-9a-f]{64}$/u.test(value) ? value : null;
}

export const entryId = (routeId, hash) =>
  `${routeId}:${normalizeTxHash(hash) ?? String(hash).toLowerCase()}`;

function validItem(item) {
  return (
    item &&
    typeof item.id === "string" &&
    typeof item.routeId === "string" &&
    typeof item.hash === "string"
  );
}

/** v1 kept status words and no hash field; the tracker re-derives both. */
function fromLegacy(item) {
  const hash = normalizeTxHash(item?.transactionHash ?? item?.id);
  if (!hash || typeof item?.routeId !== "string") return null;
  return {
    amount: item.amount ?? null,
    createdAt: item.createdAt ?? new Date().toISOString(),
    destination: item.destination ?? null,
    hash,
    id: entryId(item.routeId, hash),
    routeId: item.routeId,
    status: "pending",
  };
}

function load(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey()) ?? "null");
    if (Array.isArray(parsed)) return parsed.filter(validItem).slice(0, MAX_ITEMS);
    // The lists from before networks were kept apart, this version's or the
    // first one's, become the first network's to open here, and only its:
    // both are removed once it holds them.
    if (network) {
      const before = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      const first = Array.isArray(before) ? null : JSON.parse(storage.getItem(LEGACY_KEY) ?? "null");
      if (!Array.isArray(before) && !Array.isArray(first)) return [];
      const items = (Array.isArray(before) ? before.filter(validItem) : first.map(fromLegacy).filter(Boolean)).slice(0, MAX_ITEMS);
      try {
        storage.setItem(storageKey(), JSON.stringify(items));
        storage.removeItem(STORAGE_KEY);
        storage.removeItem(LEGACY_KEY);
      } catch {}
      return items;
    }
    const legacy = JSON.parse(storage.getItem(LEGACY_KEY) ?? "[]");
    return Array.isArray(legacy)
      ? legacy.map(fromLegacy).filter(Boolean).slice(0, MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

// What this page kept when the browser refused to store it (a private window,
// a full quota): it's read from here until a write succeeds again, so the
// list still works for this visit.
const unsaved = new WeakMap();

function save(items, storage) {
  const kept = items.slice(0, MAX_ITEMS);
  try {
    storage.setItem(storageKey(), JSON.stringify(kept));
    unsaved.delete(storage);
  } catch {
    unsaved.set(storage, kept);
  }
  return kept;
}

/** When a transfer happened, as far as this browser knows. */
const whenOf = (item) => item.sourceAt ?? item.destinationAt ?? (Date.parse(item.createdAt ?? "") || 0);

/**
 * Replaces the kept list with `items`, newest first. When there are more
 * than fit, the oldest go: a transfer found now is kept even if the list
 * is full, unless it's older than everything kept.
 */
export function saveActivity(items, storage = defaultStorage()) {
  const newestFirst = items.filter(validItem).sort((a, b) => whenOf(b) - whenOf(a));
  return storage ? save(newestFirst, storage) : newestFirst.slice(0, MAX_ITEMS);
}

export function readActivity(storage = defaultStorage()) {
  if (!storage) return [];
  return unsaved.get(storage) ?? load(storage);
}

/** Adds an entry, or merges into the one with the same route and hash. */
export function recordActivity(item, storage = defaultStorage()) {
  const hash = normalizeTxHash(item.hash) ?? item.hash;
  const id = entryId(item.routeId, hash);
  const items = readActivity(storage);
  const existing = items.find((entry) => entry.id === id);
  const next = {
    status: "pending",
    ...existing,
    ...item,
    createdAt: existing?.createdAt ?? item.createdAt ?? new Date().toISOString(),
    hash,
    id,
  };
  return storage
    ? save([next, ...items.filter((entry) => entry.id !== id)], storage)
    : [next];
}

export function updateActivity(id, patch, storage = defaultStorage()) {
  const items = readActivity(storage).map((item) =>
    item.id === id ? { ...item, ...patch } : item,
  );
  return storage ? save(items, storage) : items;
}

export function findActivity(id, storage = defaultStorage()) {
  return readActivity(storage).find((item) => item.id === id) ?? null;
}

export function clearActivity(storage = defaultStorage()) {
  storage?.removeItem(storageKey());
}
