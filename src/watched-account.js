// A Dusk account followed on this device without a wallet, as on a phone:
// My transfers reads its transfers from the networks, as it reads a
// connected account's. Nothing can be sent from it. Kept per network, in
// this browser only.

import { checkDuskRecipient, isDuskName } from "./recipient.js";
import { normalizeDuskAddress } from "./validation.js";

const keyFor = (profile) => `dusk-bridge:watched:${profile}`;

/** The followed account, `{ account, name }`, or null. */
export function readWatched(profile, storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(keyFor(profile)) ?? "null");
    if (!value || typeof value.account !== "string") return null;
    return { account: normalizeDuskAddress(value.account), name: isDuskName(value.name) ? String(value.name).toLowerCase() : "" };
  } catch {
    return null;
  }
}

/** Keeps the followed account on this device, or forgets it (null). */
export function saveWatched(profile, watched, storage = globalThis.localStorage) {
  try {
    if (watched) storage?.setItem(keyFor(profile), JSON.stringify({ account: watched.account, name: watched.name ?? "" }));
    else storage?.removeItem(keyFor(profile));
  } catch {
    // Not stored: it's followed for this visit only.
  }
}

/**
 * What was typed to follow: `{ account, name }` for a Dusk account or a
 * .dusk name's public account, or `{ error }`. Names are looked up with
 * `resolveName`, as the form's recipient is.
 */
export async function watchTarget(input, { resolveName }) {
  const typed = String(input ?? "").replace(/\s+/gu, "");
  if (!typed) return { error: "Paste a Dusk account, or type a .dusk name." };
  if (!isDuskName(typed)) {
    const checked = checkDuskRecipient(typed);
    return checked.address ? { account: checked.address, name: "" } : { error: checked.error };
  }
  const name = typed.toLowerCase();
  // A name Dusk Domains can't hold isn't looked up.
  const invalid = checkDuskRecipient(name).error;
  if (invalid) return { error: invalid };
  let found;
  try {
    found = await resolveName(name);
  } catch {
    found = { failed: true };
  }
  const checked = checkDuskRecipient(name, { [name]: found });
  return checked.address ? { account: checked.address, name } : { error: checked.error };
}
