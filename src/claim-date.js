// What the pages say about when a DuskEVM withdrawal can be claimed on Dusk.
// The date itself is worked out the way the Portal checks a claim, as every
// Dusk app works it out (@dusk-network/networks/duskevm): `claimFrom` gives
// `{ at, exact, overdue }`, and these lines say it.

import { durationWords } from "./format.js";
import { aboutWords } from "./route-times.js";

/** "Claim 7 days after you prove.", from the Portal's proof maturity delay, in seconds. */
export const claimAfterProving = (maturity) => `Claim ${durationWords(maturity)} after you prove.`;

/** "You can prove about 30 minutes after sending.", from how often outputs come, in seconds. */
export const provingAfterSending = (prove) => `You can prove ${aboutWords(prove)} after sending.`;

/**
 * Before the proof: "Claim 7 days after you prove. You can prove about 30
 * minutes after sending.", from what the chain said (`routeTime`); "" until
 * it has.
 */
export function beforeProofText(time) {
  if (!time?.maturity) return "";
  return time.prove ? `${claimAfterProving(time.maturity)} ${provingAfterSending(time.prove)}` : claimAfterProving(time.maturity);
}

/**
 * After the proof: "Claim from Mon 2 Nov, 04:24 CET", "Claim from about …"
 * while the game hasn't resolved, or, with its resolution late, "Waiting for
 * DuskEVM to settle this proof. Claim from … at the soonest." `when` writes
 * the date.
 */
export function claimText(claim, when) {
  if (!claim?.at) return "";
  if (claim.overdue) return `Waiting for DuskEVM to settle this proof. Claim from ${when(claim.at)} at the soonest.`;
  return `Claim from ${claim.exact ? "" : "about "}${when(claim.at)}`;
}

/** On the prove review: "If you prove now, you can claim from Mon 9 Nov, 03:20 CET", or "from about …". */
export function proveNowText(claim, when) {
  if (!claim?.at) return "";
  return `If you prove now, you can claim from ${claim.exact ? "" : "about "}${when(claim.at)}`;
}
