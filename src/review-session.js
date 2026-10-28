// The review sheet shows one review at a time, and its wallet requests are
// prepared after it opens. A preparation fills only the review that started
// it: if that review is closed and another opened meanwhile, even for the
// same route, the old request is dropped, so Confirm sends exactly what the
// open review shows. A review is also for one signer, the account it showed:
// once the wallet signs as another, it can't be confirmed.

/** Whether `account` is the one `review` was opened for (`review.signer`). */
export function sameSigner(review, account) {
  const signer = review?.signer;
  if (!signer?.account) return true;
  // EVM addresses ignore case; base58 Dusk accounts don't.
  return signer.wallet === "evm"
    ? signer.account.toLowerCase() === String(account ?? "").toLowerCase()
    : signer.account === account;
}

export function createReviewSession() {
  let open = null;
  return Object.freeze({
    /** The review on screen, or null. */
    get current() {
      return open;
    },
    start(review) {
      open = review;
      return review;
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
