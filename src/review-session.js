// The review sheet shows one review at a time, and its wallet requests are
// prepared after it opens. A preparation fills only the review that started
// it: if that review is closed and another opened meanwhile, even for the
// same route, the old request is dropped, so Confirm sends exactly what the
// open review shows. A review is also for one signer, the account it showed:
// once the wallet signs as another, it can't be confirmed. Its Confirm takes
// no click in the moment the review, or its next step, comes up: a
// double-click on Review must not land on it.

import { LATER_STEP_CANCELLED, duskWalletChanged, friendlyWalletError, walletCancelled } from "./transfer-view.js";

/** What a review says once its wallet switched account: it can't be confirmed. */
export const SIGNER_MOVED = Object.freeze({
  dusk: "Dusk Wallet switched to another account since this review opened. Close it and review again.",
  evm: "Your EVM wallet switched to another account since this review opened. Close it and review again.",
});

/** Whether `account` is the one `review` was opened for (`review.signer`). */
export function sameSigner(review, account) {
  const signer = review?.signer;
  if (!signer?.account) return true;
  // EVM addresses ignore case; base58 Dusk accounts don't.
  return signer.wallet === "evm"
    ? signer.account.toLowerCase() === String(account ?? "").toLowerCase()
    : signer.account === account;
}

/** How long Confirm ignores clicks once a review or its next step is up, in ms. */
export const CONFIRM_GUARD_MS = 500;

export function createReviewSession({ now = () => Date.now() } = {}) {
  let open = null;
  let shownAt = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    /** The review on screen, or null. */
    get current() {
      return open;
    },
    start(review) {
      open = review;
      shownAt = now();
      return review;
    },
    /** The open review's next step is up: Confirm waits again. */
    stepShown() {
      shownAt = now();
    },
    /**
     * Whether Confirm takes a click: not within CONFIRM_GUARD_MS of the review
     * or its step coming up. It looks as always meanwhile, not turned off.
     * Nor while the step's wallet lines aren't up, as when its request is
     * built again: what would be sent isn't shown.
     */
    get confirmable() {
      const step = open?.steps?.[open.current ?? 0];
      return now() - shownAt >= CONFIRM_GUARD_MS && (!open?.steps || Boolean(step?.lines));
    },
    end() {
      open = null;
    },
    /**
     * Prepares `review`'s request: `apply` gets the result, or `fail` the
     * error, only while `review` is still the one on screen.
     */
    async fill(review, prepare, apply, fail) {
      let result;
      try {
        result = await prepare();
      } catch (error) {
        if (open === review) fail?.(error);
        return false;
      }
      if (open !== review) return false;
      apply(result);
      return true;
    },
  });
}

/**
 * What a sent proof or claim records: the account its review was for, which
 * signed it, never whichever account Dusk Wallet shows by the time it's sent.
 * `submitterOf` turns a Dusk account into the address the Portal knows it by.
 */
export function sentActionPatch(review, hash, submitterOf) {
  const account = review?.signer?.account ?? "";
  return {
    actionError: null,
    pendingAction: review.kind,
    pendingHash: hash,
    proofAccount: account || undefined,
    proofSubmitter: account ? submitterOf(account) : undefined,
    stage: review.kind === "prove" ? "prove_submitted" : "finalize_submitted",
  };
}

/**
 * Puts on `review` why its request wasn't sent, and says it in the page's
 * live region too (`announce`), so a screen reader hears what became of this
 * request, never an older transfer's news: that you cancelled it in your
 * wallet, that the wallet came back as another account or, as Dusk Connect
 * refuses, changed network or account as it went out, which leaves the
 * review stale, or why it failed, naming `wallet`.
 */
export function notSent(review, error, { announce, wallet = "dusk" }) {
  const moved = error?.code === "DUSK_ACCOUNT_CHANGED" ? "dusk" : error?.code === "EVM_ACCOUNT_CHANGED" ? "evm" : "";
  const changed = wallet === "dusk" ? duskWalletChanged(error) : "";
  review.busy = false;
  if (moved || changed) review.stale = true;
  review.error = moved
    ? SIGNER_MOVED[moved]
    : changed
      ? `${changed}, so nothing was sent. Close it and review again.`
      : review.current > 0 && walletCancelled(error)
        ? LATER_STEP_CANCELLED
        : friendlyWalletError(error, wallet);
  announce(review.error);
  return review;
}
