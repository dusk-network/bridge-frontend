// A receipt opened by its hash alone looks the transfer up on the networks.
// One lookup runs at a time per hash. When nothing knows the hash yet (it
// isn't indexed, or a network didn't answer), it's looked up again while the
// receipt stays open; opening the receipt again always looks again.

export const NOT_FOUND = "No bridge transfer with this ID on this network yet";

/**
 * @param {object} options
 * @param {(hash: string) => Promise<{ routeId?: string, hash?: string, message?: string }|null>} options.resolve
 * @param {(found: { routeId: string, hash: string }, hash: string) => void} options.onFound
 * @param {(hash: string) => void} options.onChange the lookup's state changed
 * @param {(hash: string) => boolean} options.isOpen whether the hash's receipt is still on screen
 * @param {number} [options.retryMs]
 * @param {number} [options.retries] tries after the first, while open
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 */
export function createReceiptLookups({ isOpen, onChange, onFound, resolve, retries = 9, retryMs = 20_000, setTimer = setTimeout }) {
  const lookups = new Map();

  async function look(hash, tries) {
    if (lookups.get(hash)?.resolving) return;
    lookups.set(hash, { resolving: true });
    onChange(hash);
    let found = null;
    let answered = true;
    try {
      found = await resolve(hash);
    } catch {
      answered = false;
    }
    // Closed meanwhile: what it found isn't acted on, and opening it again looks again.
    if (!isOpen(hash)) {
      lookups.delete(hash);
      onChange(hash);
      return;
    }
    if (found?.routeId) {
      lookups.delete(hash);
      onFound(found, hash);
      return;
    }
    lookups.set(hash, { missing: found?.message ?? NOT_FOUND });
    onChange(hash);
    // A network that said what the transaction is answered for good.
    if ((!answered || !found) && tries < retries)
      setTimer(() => {
        if (isOpen(hash) && lookups.get(hash)?.missing) void look(hash, tries + 1);
      }, retryMs);
  }

  return Object.freeze({
    /** The lookup's state for `hash`: `{ resolving }`, `{ missing }`, or null. */
    get: (hash) => lookups.get(hash) ?? null,
    /** Looks `hash` up, unless a lookup for it is running. */
    open: (hash) => look(hash, 0),
  });
}
