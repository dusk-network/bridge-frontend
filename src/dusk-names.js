// The connected Dusk account's verified primary .dusk name, read through the
// deployment's own node from the Dusk Domains lens, as the explorer reads it.
// Dusk Wallet may send the name itself; where it doesn't, this asks. The
// reader and its pinned releases load only when there's an account to name,
// and it checks the lens's driver and every reply against the release.

import { decodeBase58 } from "./base58.js";

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

  return Object.freeze({
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
