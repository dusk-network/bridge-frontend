// What a withdrawal's stage asks of the user, as the web wallet words it.

import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";

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
