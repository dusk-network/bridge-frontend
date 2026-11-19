// What scripts/hyperlane-live.mjs says of a route's way back, from what
// Sepolia answered. A read that failed is said as unknown, never as 0, and
// nothing is weighed against it.

import { formatToken, formatUnitsGrouped } from "../src/format.js";

const eth = (wei) => `${formatUnitsGrouped(wei, 18)} ETH`;
const known = (value) => value !== null && value !== undefined;

/**
 * The line for one token back to Dusk: its delivery fee, its gas, what the
 * address holds of the token and of ETH, and what's short where that's known.
 * `evm` is `reads.evmState`'s answer, `gas` the transfer's gas or null.
 */
export function backLine({ amount, evm, gas, token }) {
  const fee = evm?.deliveryFeeWei;
  const held = evm?.balance;
  const coins = evm?.gasCoinWei;
  const gasWei = known(gas) && known(evm?.gasPriceWei) ? BigInt(gas) * BigInt(evm.gasPriceWei) : null;
  const short = [];
  if (known(held) && held < amount) short.push("send it there first");
  if (known(coins) && known(fee) && gasWei !== null && coins < fee + gasWei) short.push("too little ETH");
  return (
    `  Back to Dusk: bridge fee ${known(fee) ? eth(fee) : "unknown"}, gas ${gasWei === null ? "unknown" : `about ${eth(gasWei)}`}; ` +
    `the address holds ${known(held) ? formatToken(held, token) : `an unknown amount of ${token.symbol}`} and ${known(coins) ? eth(coins) : "unknown ETH"}` +
    `${short.length ? ` (${short.join("; ")})` : ""}.`
  );
}
