// Gas for the bridge's Dusk contract calls: each operation's limit, as every
// Dusk app sets it (@dusk-network/networks/gas), at the price Dusk Wallet
// starts from (`defaultGasPrice`). Only the gas a transaction uses is
// charged, but a failed one is charged its whole limit, so each operation
// gets its own limit. A proof's or a claim's comes with its call
// (@dusk-network/app-core/duskevm-withdrawals).

/** Why a proof or claim that needs more gas than the bound isn't sent. */
export const WITHDRAWAL_GAS_REFUSAL =
  "This withdrawal needs more gas than the wallet allows, so it wasn't sent.";

/** The lowest gas price a network takes, in Lux: 1. */
export const GAS_PRICE_MINIMUM = 1n;

/** The most a default gas price goes up to: 5 times the minimum. */
const GAS_PRICE_CEILING = 5n * GAS_PRICE_MINIMUM;

/** What a block takes, as Rusk has it on mainnet and testnet: 1,000 transactions, 3,000,000,000 gas. */
const BLOCK_TRANSACTIONS = 1_000;
const BLOCK_GAS = 3_000_000_000n;

/** A whole number a node's answer gives, as a number or as text, or null. */
function whole(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === "string" && /^\d+$/u.test(value.trim()) ? BigInt(value.trim()) : null;
}

/**
 * The gas price both Dusk wallets start a transaction from, by their one rule
 * (@dusk-network/app-core/gas, defaultGasPrice, from app-core 0.20), from what
 * waits in the node's mempool (`mempool`, each `{ gasPrice, gasLimit }`): the
 * network's minimum while it all fits in the next block, as every
 * transaction at the minimum goes in then; once more waits, its median, the
 * two middle prices' mean rounded down, within the minimum and 5 times it.
 * The minimum where the node can't say. Dusk Wallet calls a site's price of
 * twice its own or more a high fee: the node's median of what waits, which
 * one transaction at a high price sets, can be thousands of times it.
 */
export function defaultGasPrice(mempool) {
  if (!Array.isArray(mempool)) return GAS_PRICE_MINIMUM;
  let gas = 0n;
  const prices = [];
  for (const tx of mempool) {
    gas += whole(tx?.gasLimit) ?? 0n;
    const price = whole(tx?.gasPrice);
    if (price !== null) prices.push(price);
  }
  if ((mempool.length < BLOCK_TRANSACTIONS && gas < BLOCK_GAS) || !prices.length) return GAS_PRICE_MINIMUM;
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2n;
  return median < GAS_PRICE_MINIMUM ? GAS_PRICE_MINIMUM : median > GAS_PRICE_CEILING ? GAS_PRICE_CEILING : median;
}

/**
 * Gas for the wallet: the operation's limit at the price Dusk Wallet starts
 * from, as the page last read it and quoted it (`price`), or else as the
 * node's mempool says it now (`node.gasPrice`). One price for the quote, the
 * review and the request: one fee everywhere, which the wallet's window
 * reads as the network's.
 */
export async function gasAtNodePrice(limit, node, price = null) {
  return Object.freeze({
    limit: BigInt(limit).toString(),
    price: (price ?? (await node.gasPrice())).toString(),
  });
}
