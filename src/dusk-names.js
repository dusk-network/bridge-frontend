// The connected Dusk account's verified primary .dusk name, read through the
// deployment's own node from the Dusk Domains lens, as the explorer reads it.
// Dusk Wallet may send the name itself; where it doesn't, this asks. The
// reader and its pinned releases load only when there's an account to name,
// and it checks the lens's driver and every reply against the release.

import { decodeBase58 } from "./base58.js";

/**
 * Where each network's Dusk Domains files come from: the lens's driver, the
 * only file the name reader fetches. The names themselves are read through
 * the node. (The releases list them too; this keeps them out of the first load.)
 */
export const NAME_FILE_HOSTS = Object.freeze({ "dusk:1": "dusk.domains", "dusk:2": "testnet.dusk.domains" });

/** How long a name's account is kept before it's read again. */
const NAME_KEPT_MS = 60_000;

/** A .dusk name as typed: labels and dots, ending in .dusk. */
export const DUSK_NAME = /^[^\s.]+(?:\.[^\s.]+)*\.dusk$/iu;

const loadReader = () =>
  Promise.all([import("@duskdomains/sdk/lens-reader"), import("./dusk-domains-releases.js")]).then(
    ([{ createLensReader }, { default: releases }]) => ({ createLensReader, releases }),
  );

/**
 * @param {object} options
 * @param {string} options.chainId this deployment's Dusk chain, such as "dusk:2"
 * @param {string} options.nodeUrl the node the lens is read through
 * @param {typeof fetch} [options.fetch]
 * @param {() => Promise<{ createLensReader: Function, releases: object }>} [options.load]
 */
export function createDuskNames({ chainId, fetch = globalThis.fetch?.bind(globalThis), load = loadReader, nodeUrl }) {
  let reader = null;
  const names = new Map();

  function readerFor() {
    if (!reader) {
      reader = load().then(({ createLensReader, releases }) => {
        const release = Object.values(releases).find((item) => item.chainId === chainId);
        return release ? createLensReader(release, { artifactBaseUrl: release.artifactBaseUrl, fetch, nodeUrl }) : null;
      });
      // A reader that failed to load is made again on the next lookup.
      reader.catch(() => {
        reader = null;
      });
    }
    return reader;
  }

  const resolved = new Map();

  return Object.freeze({
    /**
     * The public Dusk account a .dusk name points to, read and checked through
     * the lens: `{ account }`, or `{ status }` for a name that isn't active or
     * names no public account. A failed read throws and isn't kept; an answer
     * is kept for a minute, so a name typed again later is read again.
     */
    resolveName(name, { now = Date.now() } = {}) {
      const key = String(name ?? "").trim().toLowerCase();
      const kept = resolved.get(key);
      if (kept && now - kept.at < NAME_KEPT_MS) return kept.lookup;
      const lookup = (async () => {
        const lens = await readerFor();
        if (!lens) return { status: "Unsupported" };
        const { account, status } = await lens.resolveMoonlightAccount(key);
        return account ? { account } : { status };
      })();
      resolved.set(key, { at: now, lookup });
      lookup.catch(() => {
        if (resolved.get(key)?.lookup === lookup) resolved.delete(key);
      });
      return lookup;
    },

    /** The account's verified primary name, or "" without one; a failed lookup isn't kept. */
    primaryName(account) {
      const key = String(account ?? "");
      if (!names.has(key)) {
        const lookup = (async () => {
          let endpoint;
          try {
            endpoint = decodeBase58(key);
          } catch {
            return "";
          }
          if (endpoint.length !== 96) return "";
          const lens = await readerFor();
          const verified = lens ? await lens.verifyPrimary(endpoint) : null;
          return verified?.primary?.spelling ?? "";
        })();
        names.set(key, lookup);
        lookup.catch(() => {
          if (names.get(key) === lookup) names.delete(key);
        });
      }
      return names.get(key);
    },
  });
}
