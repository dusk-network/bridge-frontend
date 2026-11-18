// Claims of what a Hyperlane route holds, sent from this page, followed to
// their transaction: one is said as sent until its transaction is in a
// block, or failed, or isn't found for long, whatever the escrow reads
// meanwhile. Each is kept by its route and account (`claimKey`), where the
// card's box and the transfers it pays out look for it, and in `storage`,
// so a reload follows it on.

/** How often a claim's transaction is looked for. */
const EVERY_MS = 5_000;
/** How long a claim's transaction is looked for before it's let go: the escrow read again says what's held. */
const GIVE_UP_MS = 10 * 60_000;

/**
 * @param {object} deps
 * @param {{ transaction: (hash: string) => Promise<object | null> }} deps.node the Dusk node
 * @param {(key: string, outcome: { error?: string, hash: string, state: "done" | "failed" | "lapsed" }) => void} deps.onEnd a claim's transaction was found, or let go
 * @param {() => number} [deps.now]
 * @param {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } | null} [deps.storage] where the claims are kept across reloads
 * @param {string} [deps.storageKey]
 */
export function createClaimWatch({ clearTimer = clearTimeout, everyMs = EVERY_MS, giveUpMs = GIVE_UP_MS, node, now = Date.now, onEnd, setTimer = setTimeout, storage = null, storageKey = "" }) {
  const claims = new Map();

  function keep() {
    try {
      storage?.setItem(storageKey, JSON.stringify([...claims].map(([key, claim]) => ({ at: claim.at, hash: claim.hash, key }))));
    } catch {
      // Kept for this visit only.
    }
  }

  function end(key, claim, outcome) {
    claims.delete(key);
    keep();
    onEnd(key, { ...outcome, hash: claim.hash });
  }

  /** Follows the claim for `key`, sent at `at` under `hash`, in place of one before it. */
  function follow(key, hash, at) {
    const before = claims.get(key);
    if (before) clearTimer(before.timer);
    const claim = { at, hash };
    claims.set(key, claim);
    keep();
    claim.timer = setTimer(() => check(key, claim), everyMs);
  }

  async function check(key, claim) {
    if (claims.get(key) !== claim) return;
    const tx = await node.transaction(claim.hash).catch(() => null);
    // Sent again meanwhile, or let go: that one's followed instead.
    if (claims.get(key) !== claim) return;
    if (tx) return end(key, claim, tx.error ? { error: `The claim failed on Dusk: ${tx.error}`, state: "failed" } : { state: "done" });
    if (now() - claim.at > giveUpMs) return end(key, claim, { state: "lapsed" });
    claim.timer = setTimer(() => check(key, claim), everyMs);
  }

  // What a page before this one was following.
  try {
    for (const { at, hash, key } of JSON.parse(storage?.getItem(storageKey) ?? "[]")) if (key && hash) follow(key, hash, Number(at) || now());
  } catch {
    // Nothing kept, or nothing readable.
  }

  return Object.freeze({
    /** The claim sent for `key` and still followed: its hash and when it was sent. */
    pending(key) {
      const claim = claims.get(key);
      return claim ? { at: claim.at, hash: claim.hash } : null;
    },
    /** Follows the claim sent now for `key` under `hash`, in place of one sent before. */
    sent: (key, hash) => follow(key, hash, now()),
    /** Follows a claim sent earlier, at `at`, as a transfer it pays keeps it, unless one is followed already. */
    resume(key, hash, at) {
      if (!claims.has(key)) follow(key, hash, at ?? now());
    },
    stop() {
      for (const claim of claims.values()) clearTimer(claim.timer);
      claims.clear();
    },
  });
}
