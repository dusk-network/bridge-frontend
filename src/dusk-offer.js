// "Add DUSK to <wallet>", pressed: the wallet is asked one request at a time
// (evm-wallet.js's addDusk). Whatever it answers, the offer is drawn again as
// the wallet then stands: gone once it added DUSK, or from a wallet that
// answered it can't take the request; still there after a refusal, which
// says nothing.

/**
 * @param {object} options
 * @param {(network: object) => Promise<boolean>} options.add asks the wallet: whether it added DUSK
 * @param {(added: boolean) => void} options.redraw draws the offer as the wallet now stands
 */
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
      redraw(added);
      return added;
    },
  });
}
