// When a DuskEVM withdrawal can be claimed on Dusk, worked out from the chain
// the way the Portal checks a claim:
// - the proof has matured: `proofMaturityDelaySeconds` after it was made;
// - its dispute game has resolved for the proposal and is final:
//   `disputeGameFinalityDelaySeconds` after it resolved.
// It's exact once the game has resolved. Before that, the game resolves no
// sooner than its clock runs out (`maxClockDuration` after it was created),
// which gives the earliest date, an estimate.
//
// The times are the contracts' own. The deployed testnet contracts count Dusk
// block height × 10; the others count block time and compare strictly, so a
// claim there comes a second later.

import { durationWords } from "./format.js";
import { aboutWords } from "./route-times.js";

export const GAME_STATUS = Object.freeze({ CHALLENGER_WINS: 1, DEFENDER_WINS: 2, IN_PROGRESS: 0 });

/** A game still unresolved this long past the earliest it could resolve is overdue. */
export const OVERDUE_SECONDS = 3_600n;

const distance = (a, b) => (a > b ? a - b : b - a);

/**
 * The clock a deployment's contracts keep, read from one of their times:
 * "height" (Dusk block height × 10, as the deployed testnet contracts count)
 * or "timestamp" (block time). At the tip the two are decades apart, so a
 * time is on whichever it's nearer.
 */
export function contractClock(sample, tip) {
  const time = BigInt(sample);
  return distance(time, 10n * BigInt(tip.height)) < distance(time, BigInt(tip.timestamp)) ? "height" : "timestamp";
}

/** The contracts' time at the tip. */
export const contractNow = (clock, tip) => (clock === "height" ? 10n * BigInt(tip.height) : BigInt(tip.timestamp));

/**
 * A contract time as wall-clock milliseconds. On the height clock it's
 * counted from the tip, at Dusk's 10 seconds a block.
 */
export function wallTime(seconds, clock, tip) {
  const time = BigInt(seconds);
  const wall = clock === "height" ? BigInt(tip.timestamp) + time - 10n * BigInt(tip.height) : time;
  return Number(wall) * 1_000;
}

/**
 * When a withdrawal can be claimed.
 *
 * @param {object} input
 * @param {bigint | number | null} [input.provenAt] the Portal's proof time; none for a proof made now
 * @param {{ createdAt: bigint | number, resolvedAt: bigint | number, status: number }} input.game
 *   its dispute game, from the game's hub
 * @param {{ maturitySeconds: bigint | number, finalitySeconds: bigint | number, maxClockSeconds: bigint | number }} input.timing
 *   the Portal's delays and the game's clock limit
 * @param {{ clock?: "height" | "timestamp" }} [input.network] the deployment's clock, read from the game's own time when not given
 * @param {{ height: bigint | number, timestamp: bigint | number }} input.tip Dusk's latest block
 * @returns {{ at: number | null, exact: boolean, overdue: boolean }} `at` in
 *   milliseconds; null when the game's challenger won, or the hub doesn't know the game
 */
export function claimFrom({ provenAt = null, game, timing, network = {}, tip }) {
  const created = BigInt(game?.createdAt ?? 0);
  const status = Number(game?.status ?? GAME_STATUS.IN_PROGRESS);
  if (created === 0n || status === GAME_STATUS.CHALLENGER_WINS) return { at: null, exact: false, overdue: false };
  const clock = network.clock ?? contractClock(created, tip);
  const now = contractNow(clock, tip);
  const strict = clock === "height" ? 0n : 1n;
  const resolved = status === GAME_STATUS.DEFENDER_WINS;
  // The earliest the game resolves: once its clock has run out, and not before now.
  const settles = created + BigInt(timing.maxClockSeconds);
  const resolvedAt = resolved ? BigInt(game.resolvedAt) : now > settles ? now : settles;
  const proof = provenAt ? BigInt(provenAt) : now;
  const matured = proof + BigInt(timing.maturitySeconds) + strict;
  const final = resolvedAt + BigInt(timing.finalitySeconds) + strict;
  return {
    at: wallTime(matured > final ? matured : final, clock, tip),
    exact: resolved,
    overdue: !resolved && now > settles + OVERDUE_SECONDS,
  };
}

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
