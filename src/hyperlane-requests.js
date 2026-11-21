// The requests a Hyperlane transfer sends, each built only once everything
// it needs is read and checked: a Dusk call that fails is charged its whole
// gas limit, so nothing goes to Dusk Wallet that the chain would refuse. The
// review shows the request built here, and the same request is sent.
//
// To the EVM chain: `transfer_remote` on the token's route on Dusk, its
// deposit the route's own quote, read now, and for DUSK the amount too; a
// token issued on Dusk is approved for the route first, with the token's
// `approve`, where the route can't take the amount yet. Back to Dusk:
// `transferRemote` on the EVM chain's token, its value the token's quote for
// delivery, read as it's sent. A route's escrow is claimed by the account it
// waits for (`claim_pending`), or, for it, by another (`claim_pending_for`).

import { decodeBase58, isAccount } from "@dusk-network/networks/account";
import { getAddress } from "viem";

import { formatDusk, formatToken } from "./format.js";
import { gasAtNodePrice } from "./gas.js";
import { HYPERLANE_GAS, approveArgs, carries, duskRecipientHash, evmRecipient, transferRemoteArgs } from "./hyperlane.js";
import { networkName } from "./names.js";

/** Why an amount isn't sent: none, or more than a route carries. */
export const NOT_CARRIED = "Enter an amount above 0 that one transfer can carry.";
/** Why a claim isn't sent: the route holds nothing for the account. */
export const NOTHING_TO_CLAIM = "Nothing is waiting for this account on this route.";
/** Why a transfer isn't sent: the review's bridge fee is no longer the route's. */
export const feeChanged = (fee) => `Bridge fee is now ${fee}`;

const notEnough = (needed, held) => `It needs ${needed}, with its fees, and you have ${held}. Nothing was sent.`;
const notHeld = (held) => `You have ${held}, less than this transfer. Nothing was sent.`;

/** What the wallet shows as the site's own words, which it doesn't check. */
const display = (label, recipient) => (recipient ? { label, recipient } : { label });

/** Why a request isn't sent: its gas limit is past the most this deployment asks the wallet for. */
export const overGasCeiling = (what) => `This ${what} needs more gas than the wallet allows, so it wasn't sent.`;

/**
 * Gas for a request at the node's price, within `cfg.gasLimitUpper`, the
 * most this deployment asks the wallet for: a request that needs more is
 * refused, never sent with less.
 */
function boundedGas(limit, { cfg, gasPrice, node, what }) {
  if (cfg?.gasLimitUpper && limit > BigInt(cfg.gasLimitUpper)) throw new Error(overGasCeiling(what));
  return gasAtNodePrice(limit, node, gasPrice);
}

/** The token is paused: nothing of it moves, so a call that would move it fails. */
const pausedNote = (token) => `${token.symbol} is paused on Dusk, so nothing was sent.`;

/**
 * Whether a transfer to `recipient` could go on `token`'s route now, the
 * checks before any of its steps: a 20-byte EVM recipient, the route as the
 * book names it, and the Mailbox's room for the route's quote, read for the
 * transfer itself. The recipient, with its checksum, and the quote.
 */
async function transferCould({ amount, reads, recipient, token }) {
  // Only a 20-byte address: no EVM route delivers to anything else.
  evmRecipient(recipient);
  const to = getAddress(String(recipient).trim().toLowerCase());
  await reads.checkRoute(token);
  const fee = await reads.dispatchFee(token, { amount, recipient: to });
  return { fee, to };
}

/**
 * A transfer to the EVM chain, `transfer_remote` on the token's route, as
 * Dusk Wallet receives it, after its checks: an amount above 0 within a
 * u64, a 20-byte EVM recipient, the route as the book names it and the
 * Mailbox's room, the route's quote read now (`fee`, which the deposit
 * pays), and DUSK for it all; for a token issued on Dusk, the token not
 * paused, held, and approved for the route. `reviewedFee`, the fee a review
 * showed, refuses one that changed since. Throws why it can't be sent.
 */
export async function transferRemoteRequest({ amount, cfg, gasPrice = null, node, reads, recipient, reviewedFee = null, sender, token }) {
  if (!carries(amount)) throw new Error(NOT_CARRIED);
  const { fee, to } = await transferCould({ amount, reads, recipient, token });
  if (reviewedFee !== null && fee !== reviewedFee) throw Object.assign(new Error(feeChanged(formatDusk(fee))), { code: "FEE_CHANGED", fee });
  await reads.checkMailbox(token, fee);
  const gas = await boundedGas(HYPERLANE_GAS.transfer.limit, { cfg, gasPrice, node, what: "transfer" });
  const most = BigInt(gas.limit) * BigInt(gas.price);
  const deposit = token.native ? amount + fee : fee;
  const [balance, held, approved, paused] = await Promise.all([
    node.accountBalance(sender),
    token.native ? null : reads.tokenBalance(token, sender),
    token.native ? null : reads.allowance(token, sender),
    token.native ? false : reads.paused(token),
  ]);
  if (paused) throw new Error(pausedNote(token));
  if (!token.native && held < amount) throw new Error(notHeld(formatToken(held, token)));
  if (!token.native && approved < amount) throw new Error(`The route may take ${formatToken(approved, token)} of yours, less than this transfer. Approve it first.`);
  if (balance < deposit + most) throw new Error(notEnough(formatDusk(deposit + most), formatDusk(balance)));
  return {
    contractId: token.dusk.route,
    depositLux: deposit,
    display: display(`Bridge ${formatToken(amount, token)} to ${networkName(cfg, cfg.hyperlane.network)}`, to),
    fee,
    fnArgs: transferRemoteArgs({ amount, destination: cfg.hyperlane.evm.domain, recipient: to }),
    fnName: "transfer_remote",
    gas,
  };
}

/**
 * The approval of exactly `amount` of a token issued on Dusk for its route,
 * the token's `approve`, after its checks: the transfer after it to
 * `recipient` could go (`transferCould`, and the Mailbox's room), the token
 * isn't paused, `amount` is held, and there's DUSK for this step, the
 * transfer after it and the route's fee, so the approval isn't paid for a
 * transfer that couldn't follow.
 */
export async function approveRequest({ amount, cfg, gasPrice = null, node, reads, recipient, sender, token }) {
  if (!carries(amount)) throw new Error(NOT_CARRIED);
  if (token.native) throw new Error("DUSK needs no approval.");
  const { fee } = await transferCould({ amount, reads, recipient, token });
  await reads.checkMailbox(token, fee);
  // Both steps within the deployment's ceiling, before the first is paid for.
  const gas = await boundedGas(HYPERLANE_GAS.approve.limit, { cfg, gasPrice, node, what: "approval" });
  await boundedGas(HYPERLANE_GAS.transfer.limit, { cfg, gasPrice: gas.price, node, what: "transfer" });
  const [balance, held, paused] = await Promise.all([node.accountBalance(sender), reads.tokenBalance(token, sender), reads.paused(token)]);
  if (paused) throw new Error(pausedNote(token));
  if (held < amount) throw new Error(notHeld(formatToken(held, token)));
  const both = (BigInt(gas.limit) + HYPERLANE_GAS.transfer.limit) * BigInt(gas.price) + fee;
  if (balance < both) throw new Error(notEnough(formatDusk(both), formatDusk(balance)));
  return {
    contractId: token.dusk.token,
    display: display(`Let the bridge take ${formatToken(amount, token)}`),
    // The bridge fee the transfer after it pays, as read now: the approval's review shows it.
    fee,
    fnArgs: approveArgs({ amount, spender: token.dusk.route }),
    fnName: "approve",
    gas,
  };
}

/**
 * A claim of what a route holds in escrow for `account`: `claim_pending`,
 * signed by that account, or `claim_pending_for` its key, signed by
 * `signer`, another account, which pays only the network fee (the route
 * decodes the key on chain, so its limit is far larger). After its checks:
 * something is held, a token issued on Dusk isn't paused (its route pays it
 * out with the token's own transfer), the limit is within the deployment's
 * ceiling, and the signer has DUSK for the fee. `pending` is what it pays.
 */
export async function claimRequest({ account, cfg, gasPrice = null, node, reads, signer, token }) {
  if (!isAccount(account) || !isAccount(signer)) throw new Error("That isn't a Dusk account.");
  const own = account === signer;
  const [[held], paused] = await Promise.all([reads.escrow(duskRecipientHash(account), [token]), token.native ? false : reads.paused(token)]);
  if (!held || held.pending <= 0n) throw new Error(NOTHING_TO_CLAIM);
  if (paused) throw new Error(pausedNote(token));
  const gas = await boundedGas((own ? HYPERLANE_GAS.claim : HYPERLANE_GAS.claimFor).limit, { cfg, gasPrice, node, what: "claim" });
  const most = BigInt(gas.limit) * BigInt(gas.price);
  const balance = await node.accountBalance(signer);
  if (balance < most)
    throw new Error(
      own
        ? `Your account has ${formatDusk(balance)}, and the claim's fee can be up to ${formatDusk(most)}. Another Dusk account can claim it for you.`
        : notEnough(formatDusk(most), formatDusk(balance)),
    );
  const fnArgs = own ? new Uint8Array() : (await reads.driver()).encodeInputFn("claim_pending_for", JSON.stringify({ account: [...decodeBase58(account)] }));
  return {
    contractId: token.dusk.route,
    display: display(`Claim ${formatToken(held.pending, token)} from the bridge`),
    fnArgs,
    fnName: own ? "claim_pending" : "claim_pending_for",
    gas,
    pending: held.pending,
  };
}
