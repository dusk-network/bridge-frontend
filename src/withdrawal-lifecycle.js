// Withdrawal stages in words, as the web wallet shows them (main, 25 Oct).

import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";

/**
 * How long DuskEVM usually takes to report a withdrawal to Dusk. Outputs are
 * proposed about every half hour, a little behind the DuskEVM chain.
 */
export const WITHDRAWAL_REPORT_SECONDS = 3_600;

/**
 * The waiting period after the proof, for when Dusk's own value isn't known:
 * the proof maturity delay on DuskEVM testnet.
 */
export const WITHDRAWAL_WAITING_PERIOD_SECONDS = 604_800;

const STAGES = new Map([
  ["submitted", { label: "Processing", message: "", step: 0 }],
  [
    "waiting_for_output",
    {
      label: "Not on Dusk yet",
      message: `Usually within ${roughDuration(WITHDRAWAL_REPORT_SECONDS)}.`,
      step: 1,
    },
  ],
  [
    "ready_to_prove",
    {
      label: "Prove on Dusk",
      message: "Step 1 of 2. Fee from your public account.",
      step: 1,
    },
  ],
  ["prove_submitted", { label: "Proof sent", message: "", step: 1 }],
  ["proven_waiting", { label: "Waiting period", message: "", step: 2 }],
  [
    "ready_to_finalize",
    {
      label: "Claim on Dusk",
      message: "Step 2 of 2. Fee from your public account.",
      step: 2,
    },
  ],
  ["finalize_submitted", { label: "Claim sent", message: "", step: 2 }],
  ["finalized", { label: "Completed", message: "", step: 3 }],
  [
    "failed",
    { label: "Failed", message: "Your DUSK is still on DuskEVM.", step: 0 },
  ],
]);

const UNKNOWN = { label: "Status unavailable", message: "", step: 0 };

export const withdrawalStageLabel = (stage) =>
  (STAGES.get(stage) ?? UNKNOWN).label;

/** How many of the three steps (sent, proved, claimed) are done. */
export const withdrawalStepsDone = (stage) =>
  (STAGES.get(stage) ?? UNKNOWN).step;

/** The action the stage waits for, if the user can take it now. */
export function withdrawalNextAction(stage) {
  if (stage === "ready_to_prove") return "prove";
  if (stage === "ready_to_finalize") return "finalize";
  return null;
}

/**
 * The line shown when the proof or the claim couldn't be sent, at the stage
 * that offers to send it again. The gas refusal keeps its own line, since
 * trying again would be refused too.
 */
export function withdrawalActionFailure(stage, error = "") {
  if (stage === "ready_to_prove")
    return error === WITHDRAWAL_GAS_REFUSAL
      ? error
      : "The proof wasn't sent. Try again.";
  if (stage === "ready_to_finalize")
    return error === WITHDRAWAL_GAS_REFUSAL
      ? error
      : "The claim wasn't sent. Try again.";
  return "";
}

/**
 * Dusk's Portal lets only the account that proved a withdrawal claim with
 * that proof, so another account's proof doesn't spare the user their own.
 */
export const PROVEN_BY_OTHER_ACCOUNT =
  "Proven by another account, which only lets that account claim. Prove it yourself to claim it.";

export function withdrawalSentMessage(waitingPeriodSeconds = null) {
  const total =
    WITHDRAWAL_REPORT_SECONDS +
    Number(waitingPeriodSeconds ?? WITHDRAWAL_WAITING_PERIOD_SECONDS);
  return `Two steps on Dusk, about ${roughDuration(total)} in total.`;
}

/**
 * A duration in words, rounded for "about" and "within": "a minute",
 * "an hour", "7 days".
 */
export function roughDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "an hour" : `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "31 Oct, 14:20", in the user's locale and time zone. */
export function formatClaimTime(milliseconds, locale) {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(milliseconds);
}

/**
 * The claim time once Dusk knows it, otherwise the time left: estimated from
 * the proof, or the usual waiting period. A rejected proof can't be claimed.
 */
function waitingPeriodMessage(item, now) {
  if (item.proofRejected)
    return "The proof was rejected. Prove again once DuskEVM reports a new output.";
  const claimAt = item.readyAt ? Number(item.readyAt) * 1_000 : NaN;
  if (item.readyAt && item.readyAtExact)
    return `Claim from ${formatClaimTime(claimAt)}.`;
  const remaining =
    claimAt > now ? (claimAt - now) / 1_000 : WITHDRAWAL_WAITING_PERIOD_SECONDS;
  return `Claim in about ${roughDuration(remaining)}.`;
}

export function withdrawalStageMessage(item, now = Date.now()) {
  if (item?.stage === "proven_waiting") return waitingPeriodMessage(item, now);
  return (STAGES.get(item?.stage) ?? UNKNOWN).message;
}
