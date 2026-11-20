// What a Hyperlane review shows that the chains can change while it's open.
// Back to Dusk: the delivery fee and whether the route pays the reviewed
// account yet, read for the review and shown together, so what the wallet is
// asked for is what the review says. A claim: built again as it's sent, and
// what it pays out.

import { amountForUnits } from "./format.js";
import { duskRecipientHash } from "./hyperlane.js";
import { approveRequest, claimRequest } from "./hyperlane-requests.js";
import { reviewChecks } from "./page-models.js";
import { buildQuote } from "./quote.js";

/**
 * A transfer back to Dusk's review at the delivery fee `fee` and the route's
 * word on whether it pays `destination` yet (`registered`), both read for
 * the review: its fee rows and its checks (the gas coin for the fees, the
 * first transfer's claim), all at that one fee, and whether its step can be
 * sent (`ready`): once the fee is read. `reads` is the form's, for the rest:
 * the token and gas coin held, the gas price and the transfer's gas.
 */
export function evmReviewParts(route, { amountLux, cfg, destination, duskAccount, evm, fee, reads, registered, timing }) {
  const read = { ...(reads.hyperlane ?? {}), registered };
  const state = read.evm ?? {};
  const quote = buildQuote(route, amountForUnits(amountLux, route.amountDecimals), {
    balance: state.balance ?? null,
    cfg,
    evm: { deliveryFeeWei: fee, gas: read.gas ?? null, gasCoinWei: state.gasCoinWei ?? null, priceWei: state.gasPriceWei ?? null },
    timing,
  });
  return {
    checks: reviewChecks(route, { cfg, destination, duskAccount, evm, quote, reads: { ...reads, hyperlane: read } }),
    deliveryFee: fee,
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
    firstToAccount: registered === false,
    // What the wallet is asked for is known once the fee is read.
    ready: fee !== null && fee !== undefined,
  };
}

/**
 * A reviewed claim, built again from the chain as it's sent, at the
 * reviewed gas price (`claimRequest`, with its checks). `changed` where it
 * would pay another amount than the review showed: the review shows the new
 * request and is confirmed again. Throws where it can't be sent, as when
 * nothing's held any more.
 */
export async function recheckClaim(reviewed, deps) {
  const request = await claimRequest({ ...deps, gasPrice: BigInt(reviewed.gas.price) });
  return { changed: request.pending !== reviewed.pending || request.fnName !== reviewed.fnName, request };
}

/**
 * A reviewed approval, built again from the chain as it's sent
 * (`approveRequest`, with every check the transfer after it needs: the
 * route as booked, the Mailbox's room, the token not paused and held, DUSK
 * for both steps). `changed` where it would ask for anything else than the
 * review showed, or the bridge fee the transfer after it pays moved: the
 * review shows it again, at the new fee. Throws where it can't be sent.
 * With no `reviewed`, the request to review.
 */
export async function recheckApproval(reviewed, deps) {
  const request = await approveRequest(deps);
  const hex = (bytes) => Array.from(bytes ?? [], (byte) => byte.toString(16).padStart(2, "0")).join("");
  const same =
    Boolean(reviewed) &&
    reviewed.contractId === request.contractId &&
    reviewed.fnName === request.fnName &&
    hex(reviewed.fnArgs) === hex(request.fnArgs) &&
    reviewed.fee === request.fee;
  return { changed: !same, request };
}

/**
 * A review's step whose request is built again, as when its fee moved: no
 * request meanwhile, so it can't be confirmed until the new one is built.
 */
export function rebuilding(review) {
  review.request = null;
  review.steps[review.current] = { ...review.steps[review.current], ready: false, wait: "Reading the new fee…" };
  return review;
}

/**
 * Where a claim of an account's escrow on a route is kept while its
 * transaction is waited for: by the route and the account's recipient hash,
 * so a transfer known only by the hash finds it too.
 */
export function claimKey(routeId, beneficiary) {
  const text = String(beneficiary ?? "");
  return `${routeId}:${text.startsWith("0x") ? text.toLowerCase() : duskRecipientHash(text) ?? text}`;
}

/**
 * A held transfer as its receipt and row show it while a claim of its
 * account's escrow on its route, sent from anywhere on this page, waits for
 * its transaction (`pending`, the claim watch's): claimed, so no other claim
 * is offered for it meanwhile.
 */
export function withClaimSent(entry, pending) {
  if (!entry || entry.pendingAction || entry.status !== "pending" || entry.escrow !== "held" || !entry.recipientHash) return entry;
  const claim = pending(claimKey(entry.routeId, entry.recipientHash));
  return claim ? { ...entry, pendingAction: "claim", pendingHash: claim.hash } : entry;
}

/**
 * Whether the card reads what the routes hold for `account` again soon: a
 * transfer to Dusk for it is on its way, and can land in escrow any moment.
 * One just sent is known by the account it pays until its hash is read.
 */
export function escrowOnTheWay(entries, account, routeOf) {
  const hash = duskRecipientHash(account);
  if (!hash) return false;
  return entries.some((entry) => {
    const route = routeOf(entry.routeId);
    const pays = entry.recipientHash ? entry.recipientHash === hash : entry.destination === account;
    return route?.mode === "hyperlane" && route.to.id === "dusk" && (entry.status === "pending" || !entry.status) && entry.escrow !== "held" && pays;
  });
}

/** Whether a check found a transfer to Dusk just delivered into escrow: the card's box is read again at once, for its Claim. */
export const nowHeld = (before, after) => after?.status === "pending" && after.escrow === "held" && before?.escrow !== "held";

/** The transfers a claim of `account`'s escrow on a route pays out: each the route holds for it. */
export function heldFor(entries, routeId, account) {
  const hash = duskRecipientHash(account);
  return entries.filter((entry) => entry.routeId === routeId && entry.status === "pending" && entry.escrow === "held" && Boolean(hash) && entry.recipientHash === hash);
}
