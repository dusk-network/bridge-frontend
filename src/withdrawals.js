// DuskEVM -> Dusk withdrawals as this page shows and sends them. Where each
// one is, its proof and its claim come from
// @dusk-network/app-core/duskevm-withdrawals, which reads the Portal and the
// games through this page's Multicall for Dusk batcher and checks every call
// it builds. This page adds its words, the account a check is for, and the
// gas price and Dusk Wallet request a proof or claim goes with.

import { WithdrawalError, createWithdrawals } from "@dusk-network/app-core/duskevm-withdrawals";

import { WITHDRAWAL_GAS_REFUSAL, gasAtNodePrice } from "./gas.js";

/** Why a DuskEVM transaction isn't followed, proved or claimed as a withdrawal. */
export const NOT_A_DUSK_WITHDRAWAL = "That DuskEVM transaction isn't a DUSK withdrawal.";

/** Why a claim waits: the Portal lets only the account that proved claim with its proof. */
export const PROVED_BY_ANOTHER_ACCOUNT =
  "Another account proved this withdrawal. Your DUSK isn't affected, but only that account can claim with its proof: switch Dusk Wallet to it, or prove it again with this one.";

const NO_OUTPUT = "No finalized output proposal covering this withdrawal is ready yet.";
const REJECTED_WAITING = "The existing proof was rejected, but no replacement output proposal is available yet.";

/** Why a withdrawal waits, by the package's reason. */
const WAITS = Object.freeze({
  "game-in-progress": "The proof is accepted. Its dispute game is still in progress.",
  "game-not-final": "The proof is accepted. Wait for its dispute game to become final.",
  "game-unreadable": "The proof is accepted, but its dispute game can't be read right now.",
  "no-games": "No dispute games have been proposed yet.",
  "no-output": NO_OUTPUT,
  "portal-refuses": "The Portal doesn't take the claim yet.",
});

/** Why a withdrawal waits, kept with the transfer for its details: empty when it doesn't. */
export function waitWords(status) {
  if (status?.reason === "proof-rejected")
    return status.stage === "ready_to_prove"
      ? "The existing proof is not accepted by the portal, and a newer output proposal is available. Prove the withdrawal again."
      : REJECTED_WAITING;
  // As the search said it: the read that failed while a game was looked for.
  if (status?.reason === "no-output" && status.error) return status.error.message;
  return WAITS[status?.reason] ?? "";
}

/** Why a claim isn't ready for the account, by its status. */
function notReadyWords(status) {
  const waiting = waitWords(status);
  if (waiting) return waiting;
  if (status?.stage === "ready_to_prove")
    return status.provenByOther ? PROVED_BY_ANOTHER_ACCOUNT : "The withdrawal must be proven before it can be finalized.";
  if (status?.stage === "finalized") return "The withdrawal is already finalized.";
  return "The withdrawal is not ready to finalize yet.";
}

const REFUSED = Object.freeze({
  "bad-call": "The request didn't match this withdrawal, so it wasn't sent.",
  "bad-hash": "Enter a valid DuskEVM withdrawal transaction hash.",
  claimed: "This withdrawal is already claimed.",
  failed: "Withdrawal transaction failed on DuskEVM.",
  gas: WITHDRAWAL_GAS_REFUSAL,
  "not-a-withdrawal": NOT_A_DUSK_WITHDRAWAL,
  "not-found": "Withdrawal transaction was not found.",
});

/** A refusal of the package's in this page's words; any other error as it is. */
export function inWords(error) {
  if (!(error instanceof WithdrawalError)) return error;
  const { code, reason, status } = error;
  let words = REFUSED[code];
  if (code === "proven")
    words =
      status?.stage === "ready_to_finalize"
        ? "This account already proved this withdrawal. You can claim it now."
        : status?.reason === "proof-rejected"
          ? REJECTED_WAITING
          : "This account already proved this withdrawal. Claim it once the waiting period ends.";
  else if (code === "no-proof") words = reason === "no-games" ? WAITS["no-games"] : (error.cause?.message ?? NO_OUTPUT);
  else if (code === "not-ready") words = notReadyWords(status);
  return new Error(words ?? error.message, { cause: error });
}

/**
 * The deployment's withdrawals: read on its Dusk node through `fetch` (the
 * page's Multicall for Dusk batcher, which holds `maxBatch` reads a query),
 * on its Portal, factory and registry (`cfg.network`), with the pinned data
 * drivers the page loads, and DuskEVM through `rpc`. A check is for the
 * account given, else Dusk Wallet's (`connected`, its Portal address), else
 * the withdrawal's recipient's.
 */
export function createPageWithdrawals(cfg, { connected = () => null, drivers, fetch, maxBatch, node, rpc }) {
  const withdrawals = createWithdrawals({
    drivers,
    duskEvm: { request: ({ method, params }) => rpc("dusk-evm", method, params) },
    fetch,
    gameSearchDepth: cfg.duskEvm.bridgeGameSearchDepth,
    latestBlock: () => node.latestBlock(),
    maxBatch,
    network: cfg.network,
    nodeUrl: cfg.dusk.nodeUrl,
  });
  return Object.freeze({
    status: (hash, { proofGame = null, submitter = null } = {}) =>
      withdrawals.status(hash, { proofGame, submitter: submitter ?? connected() }),

    timing: () => withdrawals.timing(),

    /**
     * A proof (`kind` "prove") or a claim ("finalize") as Dusk Wallet
     * receives it, for `submitter`: the package's checked call as it is, at
     * the node's gas price as the page quoted it (`price`), or else the
     * node's now. With what its call does as the wallet reads it
     * (`decoded`), and for a proof when it can be claimed if it's sent now
     * (`claim`). It sends no DUSK, so it carries no deposit.
     */
    async request(kind, hash, { price = null, submitter }) {
      const gasLimitUpper = cfg.gasLimitUpper;
      let prepared;
      try {
        prepared =
          kind === "prove"
            ? await withdrawals.prepareProof(hash, { gasLimitUpper, submitter })
            : { call: await withdrawals.claimCall(hash, { gasLimitUpper, submitter }), claim: null };
      } catch (error) {
        throw inWords(error);
      }
      const { call } = prepared;
      if (call.deposit !== 0n) throw new Error("This request would send DUSK, so it wasn't sent.");
      return {
        claim: prepared.claim ?? null,
        decoded: call.decoded,
        request: {
          contractId: call.contractId,
          display: { label: kind === "prove" ? "Prove a DuskEVM withdrawal" : "Claim a DuskEVM withdrawal" },
          fnArgs: call.fnArgs,
          fnName: call.fnName,
          gas: await gasAtNodePrice(call.gasLimit, node, price),
        },
      };
    },
  });
}
