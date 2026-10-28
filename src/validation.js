import { compressedDuskBlsPublicKeyToRaw } from "@dusk/evm-sdk";
import { getAddress, isAddress } from "viem";
import { decodeBase58 } from "./base58.js";

/**
 * A Dusk account: the base58 of a compressed BLS12-381 public key. Any 96
 * bytes decode, so the key itself is checked: DUSK sent to one that isn't
 * a key could never be spent.
 */
export function normalizeDuskAddress(input) {
  const value = String(input ?? "").trim();
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 96) throw new Error("Not 96 bytes.");
    compressedDuskBlsPublicKeyToRaw(bytes);
  } catch {
    throw new Error("Enter a valid Dusk account.");
  }
  return value;
}

export function normalizeEvmAddress(input) {
  const value = String(input ?? "").trim();
  if (!isAddress(value)) throw new Error("Enter a valid 20-byte EVM address.");
  return getAddress(value);
}
