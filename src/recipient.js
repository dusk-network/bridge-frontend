// What a typed recipient is: an EVM address, checked against the checksum
// its capitals carry, a Dusk account, or a .dusk name and the account it
// points to. Pure: a name's lookup comes in from outside. What a .dusk name
// is, and what's wrong with one, are Dusk Domains' rules (@duskdomains/sdk).

import { asDuskName, isDuskName, nameProblem, toDuskName } from "@duskdomains/sdk/names";
import { getAddress, isAddress, zeroAddress } from "viem";

import { normalizeDuskAddress } from "./validation.js";

export const NOT_EVM_ADDRESS = "Not an EVM address (0x + 40 hex)";
export const EVM_CHECKSUM_MISMATCH = "Checksum mismatch: a character may be wrong";
export const ZERO_ADDRESS_RECIPIENT = "That's the zero address, not a wallet";
// Whichever route's token or bridge contract it is.
export const BRIDGE_CONTRACT_RECIPIENT = "That's a bridge contract, not a wallet";
export const NOT_DUSK_RECIPIENT = "Not a Dusk account or .dusk name";

/**
 * `{ address }` in its checksummed form, or `{ error }`. When only the
 * capitals are off, `fix` is the address with its checksum's capitals. What
 * nobody could spend from is refused: the zero address, and `bridgeContracts`,
 * the route's own, which are easy to paste from an explorer.
 */
export function checkEvmRecipient(input, { bridgeContracts = [] } = {}) {
  const value = String(input ?? "").trim();
  if (!/^0x[0-9a-f]{40}$/iu.test(value)) return { error: NOT_EVM_ADDRESS };
  const lower = value.toLowerCase();
  if (lower === zeroAddress) return { error: ZERO_ADDRESS_RECIPIENT };
  if (bridgeContracts.some((contract) => contract?.toLowerCase() === lower)) return { error: BRIDGE_CONTRACT_RECIPIENT };
  if (isAddress(value)) return { address: getAddress(value) };
  return { error: EVM_CHECKSUM_MISMATCH, fix: getAddress(lower) };
}

/**
 * What nobody could spend from on the EVM network `networkId`, for
 * `checkEvmRecipient`: its DUSK token and migration contracts, and on
 * Hyperlane's chain every contract in Hyperlane's book, whichever of its
 * tokens the deployment runs.
 */
export function evmBridgeContracts(cfg, networkId) {
  const network = cfg.evmNetworks?.[networkId];
  const hyperlane = cfg.hyperlane && networkId === cfg.hyperlane.network ? (cfg.hyperlane.evmContracts ?? []) : [];
  return [network?.tokenContract, network?.migrationContract, ...hyperlane].filter(Boolean);
}

/** A typed EVM recipient once it's an address: with its checksum's capitals. Anything else as typed. */
export const settledEvmRecipient = (typed) => checkEvmRecipient(typed).address ?? typed;

// Why a .dusk name can't be one, by what Dusk Domains finds wrong with it.
// Word joiners keep "a–z" and "0–9" whole where a phone wraps the line.
const NAME_PROBLEM = Object.freeze({
  characters: "names use a\u2060–\u2060z, 0\u2060–\u20609 and hyphens",
  hyphen: "names don't start or end with a hyphen",
});

/**
 * A Dusk recipient: `{ address }` for an account, `{ address, name }` for a
 * name whose lookup found its public account, `{ name, pending: true }` while
 * it's looked up, or `{ error }`, with the .dusk name it likely is
 * (`suggest`) where it reads as one typed without its ending. `lookups` maps
 * lower-case names to what their lookup gave: `{ account }`, `{ status }` or
 * `{ failed: true }`.
 */
export function checkDuskRecipient(input, lookups = {}) {
  const value = String(input ?? "").trim();
  if (!isDuskName(value)) {
    try {
      return { address: normalizeDuskAddress(value) };
    } catch {
      const suggest = asDuskName(value);
      return suggest ? { error: NOT_DUSK_RECIPIENT, suggest } : { error: NOT_DUSK_RECIPIENT };
    }
  }
  // A name Dusk Domains can't hold is never looked up.
  const problem = nameProblem(value);
  if (problem) {
    const name = value.toLowerCase();
    return { error: NAME_PROBLEM[problem] ? `${name} isn't a valid .dusk name: ${NAME_PROBLEM[problem]}.` : `${name} isn't a valid .dusk name.`, name };
  }
  const name = toDuskName(value);
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
