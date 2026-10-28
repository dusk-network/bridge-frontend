// "Look up a transfer": a pasted hash is looked up on the networks. Only the
// latest lookup counts, and only while its page is open: an answer that
// comes after a newer lookup, or after the page was left, is dropped, so it
// can't take the user elsewhere.

/**
 * @param {object} options
 * @param {(hash: string) => Promise<{ routeId?: string, hash?: string, message?: string }|null>} options.resolve
 * @param {() => boolean} options.isOpen whether the lookup page is on screen
 */
export function createLookupFlow({ isOpen, resolve }) {
  let latest = 0;
  return Object.freeze({
    /** Drops any lookup still running: the page was left or opened again. */
    cancel() {
      latest += 1;
    },
    /** `{ found }` (null when nothing knows it), or `{ stale: true }` for an answer no longer wanted. */
    async find(hash) {
      const token = ++latest;
      let found = null;
      try {
        found = await resolve(hash);
      } catch {
        found = null;
      }
      return token === latest && isOpen() ? { found } : { stale: true };
    },
  });
}
