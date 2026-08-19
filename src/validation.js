import { getAddress, isAddress } from "viem";

export function normalizeEvmAddress(input) {
  const value = String(input ?? "").trim();
  if (!isAddress(value)) throw new Error("Enter a valid 20-byte EVM address.");
  return getAddress(value);
}

export function normalizeTransactionHash(input) {
  const value = String(input ?? "").trim();
  if (!/^0x[0-9a-f]{64}$/iu.test(value))
    throw new Error("Enter a valid transaction hash.");
  return value.toLowerCase();
}

export function shortAddress(value, start = 7, end = 5) {
  if (!value) return "Not connected";
  return value.length <= start + end + 1
    ? value
    : `${value.slice(0, start)}…${value.slice(-end)}`;
}
