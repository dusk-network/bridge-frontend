import { isAccount } from "@dusk-network/networks/account";
import { getAddress, isAddress } from "viem";

/**
 * A Dusk account: the base58 of a compressed BLS12-381 public key. Any 96
 * bytes decode, so the key itself is checked (`isAccount`): DUSK sent to one
 * that isn't a key could never be spent.
 */
export function normalizeDuskAddress(input) {
  const value = String(input ?? "").trim();
  if (!isAccount(value)) throw new Error("Enter a valid Dusk account.");
  return value;
}

export function normalizeEvmAddress(input) {
  const value = String(input ?? "").trim();
  if (!isAddress(value)) throw new Error("Enter a valid 20-byte EVM address.");
  return getAddress(value);
}
