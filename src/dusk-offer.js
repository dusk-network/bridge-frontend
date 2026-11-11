// "Add DUSK to <wallet>", pressed: the wallet is asked one request at a time
// (evm-wallet.js's addDusk). Whatever it answers, the offer is drawn again as
// the wallet then stands: gone once it added DUSK, or from a wallet that
// answered it can't take the request; still there after a refusal, which
// says nothing.

/**
 * @param {object} options
 * @param {(network: object) => Promise<boolean>} options.add asks the wallet: whether it added DUSK
 * @param {(added: boolean, network: object) => void} options.redraw draws the offer as the wallet now stands, and what it was for
 */
/**
 * Where DUSK was added from this page this visit: the chain, the address and
 * the wallet that took it. "DUSK added to <wallet>" is said to that wallet
 * only: another connected at the same address, as Rabby after MetaMask, was
 * never asked.
 */
export function createDuskAdded() {
  const added = [];
  const same = (network, evm) => (each) => each.chainId === network.chainId && each.account === String(evm.account).toLowerCase() && each.provider === evm.provider;
  return Object.freeze({
    /** The connected wallet `evm` added DUSK of `network`. */
    remember(network, evm) {
      if (network?.chainId && evm?.account && evm.provider) added.push({ account: String(evm.account).toLowerCase(), chainId: network.chainId, provider: evm.provider });
    },
    /** Whether the connected wallet `evm`, as it is now, added DUSK of `network` here this visit. */
    has(network, evm) {
      return Boolean(network?.chainId && evm?.account && evm.provider) && added.some(same(network, evm));
    },
  });
}

export function createDuskOffer({ add, redraw }) {
  let asking = false;
  return Object.freeze({
    /** Asks the wallet to add DUSK of `network`, unless it's being asked already: whether it did. */
    async press(network) {
      if (asking) return false;
      asking = true;
      let added = false;
      try {
        added = (await add(network)) === true;
      } catch {
        added = false;
      } finally {
        asking = false;
      }
      redraw(added, network);
      return added;
    },
  });
}
