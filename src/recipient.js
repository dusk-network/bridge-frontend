// What a typed recipient is: an EVM address, checked against the checksum
// its capitals carry, a Dusk account, or a .dusk name and the account it
// points to. Pure: a name's lookup comes in from outside.

import { getAddress, isAddress } from "viem";

import { DUSK_NAME } from "./dusk-names.js";
import { normalizeDuskAddress } from "./validation.js";

export const NOT_EVM_ADDRESS = "That isn't an EVM address: 0x and 40 hex characters.";
export const EVM_CHECKSUM_MISMATCH =
  "The capital letters don't match this address's checksum, so a character may be wrong. Copy it again from your wallet.";
export const NOT_DUSK_RECIPIENT =
  "That isn't a Dusk account or a .dusk name. A Dusk account is the long base58 address your Dusk Wallet shows.";

/**
 * `{ address }` in its checksummed form, or `{ error }`. When only the
 * capitals are off, `fix` is the address with its checksum's capitals.
 */
export function checkEvmRecipient(input) {
  const value = String(input ?? "").trim();
  if (!/^0x[0-9a-f]{40}$/iu.test(value)) return { error: NOT_EVM_ADDRESS };
  if (isAddress(value)) return { address: getAddress(value) };
  return { error: EVM_CHECKSUM_MISMATCH, fix: getAddress(value.toLowerCase()) };
}

export const isDuskName = (value) => DUSK_NAME.test(String(value ?? "").trim());

/**
 * A Dusk recipient: `{ address }` for an account, `{ address, name }` for a
 * name whose lookup found its public account, `{ name, pending: true }` while
 * it's looked up, or `{ error }`. `lookups` maps lower-case names to what
 * their lookup gave: `{ account }`, `{ status }` or `{ failed: true }`.
 */
export function checkDuskRecipient(input, lookups = {}) {
  const value = String(input ?? "").trim();
  if (!isDuskName(value)) {
    try {
      return { address: normalizeDuskAddress(value) };
    } catch {
      return { error: NOT_DUSK_RECIPIENT };
    }
  }
  const name = value.toLowerCase();
  const found = lookups[name];
  if (!found) return { name, pending: true };
  if (found.failed) return { error: `Couldn't look up ${name} just now. Try again, or paste the Dusk account.`, name };
  if (found.account) {
    try {
      return { address: normalizeDuskAddress(found.account), name };
    } catch {
      return { error: `${name} doesn't point to a public Dusk account.`, name };
    }
  }
  if (found.status === "Unsupported") return { error: ".dusk names can't be looked up on this network. Paste the Dusk account.", name };
  if (found.status === "Active") return { error: `${name} doesn't point to a public Dusk account.`, name };
  return { error: `${name} isn't an active .dusk name.`, name };
}
