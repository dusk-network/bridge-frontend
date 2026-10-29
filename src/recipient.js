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

/** A typed EVM recipient once it's an address: with its checksum's capitals. Anything else as typed. */
export const settledEvmRecipient = (typed) => checkEvmRecipient(typed).address ?? typed;

export const isDuskName = (value) => DUSK_NAME.test(String(value ?? "").trim());

/**
 * A part of a .dusk name, as Dusk Domains' SDK checks it (`validateLabel`):
 * 1 to 63 of a–z, 0–9 and hyphens, with no hyphen at either end. Its
 * `validateName` takes at most five parts, the last "dusk". The SDK isn't
 * imported for it: its entry point adds about 140 kB to the page's first
 * load. A test holds the two to the same answers.
 */
const NAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Why a .dusk name, in lower case, can't be one by Dusk Domains' rules, or
 * "" when it can. Such a name is never looked up.
 */
export function duskNameProblem(name) {
  const labels = name.split(".");
  if (labels.length <= 5 && labels.at(-1) === "dusk" && labels.every((label) => NAME_LABEL.test(label))) return "";
  // Word joiners keep "a–z" and "0–9" whole where a phone wraps the line.
  if (labels.some((label) => /[^a-z0-9-]/u.test(label))) return `${name} isn't a valid .dusk name: names use a\u2060–\u2060z, 0\u2060–\u20609 and hyphens.`;
  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) return `${name} isn't a valid .dusk name: names don't start or end with a hyphen.`;
  return `${name} isn't a valid .dusk name.`;
}

/**
 * The .dusk name a name typed without its ending, or with a dot after it,
 * likely means: "alice" or "alice.dusk." for alice.dusk, as the wallets offer
 * it. Nothing is looked up. Null for anything else, as an address: one with
 * a capital after its first letter, or an EVM address.
 */
export function asDuskName(input) {
  const typed = String(input ?? "").trim().replace(/\.+$/u, "");
  if (!typed || /[A-Z]/u.test(typed.slice(1)) || /^0x[0-9a-f]*$/iu.test(typed)) return null;
  const labels = typed.toLowerCase().split(".");
  const named = labels.at(-1) === "dusk" ? labels.slice(0, -1) : labels;
  return named.length > 0 && named.length <= 4 && named.every((label) => NAME_LABEL.test(label)) ? `${named.join(".")}.dusk` : null;
}

/** The typed .dusk name to look up, in lower case, or "" for anything else. */
export function nameToLookUp(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return isDuskName(name) && !duskNameProblem(name) ? name : "";
}

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
  const name = value.toLowerCase();
  const invalid = duskNameProblem(name);
  if (invalid) return { error: invalid, name };
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
