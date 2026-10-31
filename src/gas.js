// Gas for the bridge's Dusk contract calls: each operation's limit, as every
// Dusk app sets it (@dusk-network/networks/gas), at the node's price. Only
// the gas a transaction uses is charged, but a failed one is charged its
// whole limit, so each operation gets its own limit. A proof's or a claim's
// comes with its call (@dusk-network/app-core/duskevm-withdrawals).

/** Why a proof or claim that needs more gas than the bound isn't sent. */
export const WITHDRAWAL_GAS_REFUSAL =
  "This withdrawal needs more gas than the wallet allows, so it wasn't sent.";

/**
 * Gas for the wallet: the operation's limit at the node's price, as the page
 * last read it and quoted it (`price`), or else as the node gives it now.
 * One price for the quote, the review and the request: one fee everywhere.
 */
export async function gasAtNodePrice(limit, node, price = null) {
  return Object.freeze({
    limit: BigInt(limit).toString(),
    price: (price ?? (await node.gasPrice())).toString(),
  });
}
