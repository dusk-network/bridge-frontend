// Gas limits for the bridge's Dusk contract calls, the same numbers the web
// wallet uses. Only the gas a transaction uses is charged, but a failed one is
// charged its whole limit, so each operation gets its own limit.

/** Bridge deposits spend about 2M gas on mainnet and testnet. */
export const DEPOSIT_GAS_LIMIT = 5_000_000n;

/**
 * Proving and claiming a withdrawal spend about 2.3M gas. Claiming hands the
 * Portal's remaining gas to the withdrawal's own call and consumes the
 * withdrawal even if that call runs out, so both get a far larger limit.
 */
export const WITHDRAWAL_GAS_LIMIT = 50_000_000n;

/** The gas limit no bridge transaction goes above. */
export const DEFAULT_GAS_LIMIT_UPPER = 1_000_000_000n;

/** Why a proof or claim that needs more gas than the bound isn't sent. */
export const WITHDRAWAL_GAS_REFUSAL =
  "This withdrawal needs more gas than the wallet allows, so it wasn't sent.";

/**
 * The limit to prove or claim a withdrawal with: the withdrawal limit plus
 * the gas the withdrawal itself asks for. Above the bound it isn't sent, since
 * less gas could leave the withdrawal's call short.
 */
export function withdrawalGasLimit(
  withdrawalGas = 0n,
  upper = DEFAULT_GAS_LIMIT_UPPER,
) {
  const limit = WITHDRAWAL_GAS_LIMIT + BigInt(withdrawalGas);
  if (limit > BigInt(upper)) throw new Error(WITHDRAWAL_GAS_REFUSAL);
  return limit;
}

/** Gas for the wallet: the operation's limit at the node's current price. */
export async function gasAtNodePrice(limit, node) {
  return Object.freeze({
    limit: BigInt(limit).toString(),
    price: (await node.gasPrice()).toString(),
  });
}
