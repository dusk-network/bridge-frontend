// What a transfer says, on its receipt and in Activity: the title, both
// accounts, each step with its time and transaction, the next action, the
// claim countdown, and when it's late. Built from the stored entry, its route
// and how long the route takes on this network; no balances, no network
// requests.

import { claimText, evmAddressOf } from "@dusk-network/networks/duskevm";
import { durationWords, formatContractId, formatEvmAddress, shortAccount } from "@dusk-network/networks/format";

import {
  clockChangeBetween,
  clockChangeNote,
  formatDateTime,
  formatDusk,
  formatShort,
  formatShortDay,
  formatToken,
  formatTokenShort,
} from "./format.js";
import { duskRecipientHash } from "./hyperlane.js";
import { networkName, tokenName } from "./names.js";
import { lateAfterSeconds, routeTime, routeTimeText } from "./route-times.js";
import { STATUS_WORDS } from "./tracking.js";
import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";

export const html = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const withPrefix = (hash) => (String(hash).startsWith("0x") ? hash : `0x${hash}`);
const withoutPrefix = (hash) => String(hash).replace(/^0x/iu, "");

/** A transaction's page on its network's explorer. */
export function explorerTxUrl(cfg, network, hash) {
  if (!hash) return null;
  if (network === "dusk")
    return `${cfg.dusk.explorerUrl.replace(/\/+$/u, "")}/transactions/transaction?id=${withoutPrefix(hash)}`;
  const explorer = network === "dusk-evm" ? cfg.duskEvm.explorerUrl : cfg.evmNetworks[network]?.explorerUrl;
  return explorer ? `${explorer.replace(/\/+$/u, "")}/tx/${withPrefix(hash)}` : null;
}

/** `text` with its middle left out: `head` characters, "…", `tail` characters. */
const middle = (text, head, tail) => (text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`);

/**
 * An account, address or transaction ID, shortened to 6…6 after any 0x:
 * EVM addresses "0xd63bB1…fE8df4", with their checksum's capitals, EVM
 * transactions "0x04a8a8…1b3213", Dusk accounts, transactions and contract
 * IDs "rz2gFT…3VGXyt". A dense list (`dense`) shortens to 4…4: "0xd63b…8df4".
 * The full value is always a copy or a hover away.
 */
export function short(value, { dense = false } = {}) {
  const text = String(value ?? "").trim();
  const [head, tail] = dense ? [4, 4] : [6, 6];
  if (/^0x[0-9a-f]{40}$/iu.test(text)) return middle(formatEvmAddress(text), head + 2, tail);
  if (/^0x[0-9a-f]{64}$/iu.test(text)) return middle(text.toLowerCase(), head + 2, tail);
  if (/^[0-9a-f]{64}$/iu.test(text)) return middle(formatContractId(text), head, tail);
  return dense ? middle(text, head, tail) : shortAccount(text);
}

/** The action a withdrawal's stage waits for, if the user can take it now. */
export const withdrawalNextAction = (stage) => (stage === "ready_to_prove" ? "prove" : stage === "ready_to_finalize" ? "finalize" : null);

/** What a proof or claim that couldn't be sent says, at the stage that offers to send it again. */
const ACTION_FAILURE = Object.freeze({
  ready_to_finalize: "The claim wasn't sent. Try again.",
  ready_to_prove: "The proof wasn't sent. Try again.",
});

/** What every page says when you reject a request in your wallet: never in red, it's your choice. */
export const WALLET_CANCELLED = "Cancelled in your wallet. Nothing was sent.";

/** Under a recipient that's a contract: it may be meant, as a smart wallet, so it's said, not refused. */
export const CONTRACT_RECIPIENT = "Contract, not a wallet: tokens may get stuck";

/** What it says when you reject connecting, where there's nothing to send. */
export const CONNECT_CANCELLED = "Cancelled in your wallet";

/** What it says when you reject a later step: the approval before it did go out. */
export const LATER_STEP_CANCELLED = "Cancelled. The approval stays; it won't ask again";

/** Whether the wallet's user rejected the request (4001), however the wallet wrapped it. */
export const walletCancelled = (error) =>
  [error?.code, error?.cause?.code, error?.cause?.cause?.code].includes(4001) || error?.name === "UserRejectedRequestError";

/** What a proof or claim that wasn't sent keeps on its transfer: that you cancelled it, or why it failed. */
export const actionErrorOf = (error) => (walletCancelled(error) ? WALLET_CANCELLED : error?.message ?? String(error));

/**
 * What changed when Dusk Connect sent nothing because Dusk Wallet switched
 * network, locked or changed accounts while a request was under way, or "".
 */
export function duskWalletChanged(error) {
  const reason = error?.data?.reason;
  if (reason === "network_changed") return "Dusk Wallet switched network";
  if (reason === "session_changed") return "Dusk Wallet locked or changed accounts";
  return "";
}

/** Wallet errors in plain words, naming the wallet that raised them. */
export function friendlyWalletError(error, wallet = "dusk") {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code];
  const name = wallet === "evm" ? "EVM wallet" : "Dusk wallet";
  if (walletCancelled(error)) return WALLET_CANCELLED;
  const changed = wallet === "dusk" ? duskWalletChanged(error) : "";
  if (changed) return `${changed}. Try again.`;
  if (codes.includes(4100) || /wallet (?:is )?locked/iu.test(error?.message ?? ""))
    return `The ${name} is locked. Unlock it, reconnect, and try again.`;
  if (codes.includes(4900)) return `The ${name} disconnected. Reconnect it and try again.`;
  return error?.shortMessage ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Whether Dusk Wallet's account isn't the one whose proof the withdrawal
 * waits on: the Portal lets only the account that proved claim with it.
 */
export const proverMismatch = (entry, submitter) =>
  Boolean(entry?.proveHash && entry.proofSubmitter && submitter && String(entry.proofSubmitter).toLowerCase() !== String(submitter).toLowerCase());

/** The stages at which the Portal holds a proof for the account a check was read for. */
const PROVED_STAGES = new Set(["proven_waiting", "ready_to_finalize", "finalize_submitted"]);

let submitterFor = { account: null, submitter: null };
/** The address the Portal knows a Dusk account's proofs by, in lower case: null for no account. */
function submitterOf(account) {
  if (submitterFor.account !== account) {
    let submitter = null;
    try {
      submitter = evmAddressOf(account).toLowerCase();
    } catch {}
    submitterFor = { account, submitter };
  }
  return submitterFor.submitter;
}

/**
 * Whether `owner` proved the withdrawal: with a proof or claim sent from this
 * browser, or as a check read for `owner`'s own account says
 * (`stageSubmitter`). A check read for another account, as the recipient's
 * with no wallet connected, says nothing of `owner`'s proof.
 */
export function provedBy(entry, owner) {
  if (!owner || !entry) return false;
  if ((entry.proveHash || entry.pendingAction) && entry.proofAccount === owner) return true;
  if (!PROVED_STAGES.has(entry.stage) || !entry.stageSubmitter) return false;
  return String(entry.stageSubmitter).toLowerCase() === submitterOf(owner);
}

/**
 * Whether a withdrawal is someone else's to finish: it pays a Dusk account
 * other than `owner`, the one the page is for (Dusk Wallet's, or the
 * followed one), and nobody, or another account, has proved it. Once `owner`
 * has, only `owner` can claim with that proof. With no `owner`, none is.
 */
export const sentToSomeoneElse = (entry, route, owner) =>
  route?.mode === "duskevm-withdrawal" &&
  Boolean(owner) &&
  Boolean(entry?.destination) &&
  entry.destination !== owner &&
  !provedBy(entry, owner);

/** What to do when another account proved it. */
export const switchToProver = (entry) =>
  entry?.proofAccount
    ? `Switch Dusk Wallet to ${short(entry.proofAccount)}, the account that proved it. Only that account can claim.`
    : "Switch Dusk Wallet to the account that proved it. Only that account can claim.";

/**
 * A proof by another account, in the list and on the receipt. When the
 * withdrawal pays the connected account (`account`), proving it yourself lets
 * you claim it. When it pays another, it says whom, and that proving and
 * claiming still pays that account, naming yours by its .dusk `name`.
 */
export function provenByOtherLine(entry, account = "", name = "") {
  const pays = entry?.destination ?? "";
  if (!pays || pays === account) return "Another account proved it. Prove it yourself to claim it.";
  return `Another account proved it. It pays ${short(pays)}${account ? `, not ${name || "you"}` : ""}`;
}

const amountOf = (entry) =>
  entry.amountLux !== undefined && entry.amountLux !== null ? BigInt(entry.amountLux) : null;

/** What a transfer makes public, in one line: the review names both accounts above it. */
export const PUBLIC_LINE = "Public: both accounts and the amount";

function step(key, title, state, extra = {}) {
  return { at: null, detail: "", hash: null, key, network: null, state, title, ...extra };
}

/**
 * When a waiting withdrawal can be claimed, as the chain says (`claimFrom`):
 * exact once its game has resolved, the earliest before that, and overdue
 * when the game's resolution is late. No date is made up from a fixed wait.
 */
function claimTiming(entry) {
  return entry.readyAt
    ? { at: Number(entry.readyAt) * 1_000, exact: Boolean(entry.readyAtExact), overdue: Boolean(entry.claimOverdue) }
    : { at: null, exact: false, overdue: false };
}

const REJECTED_PROOF = "The proof was rejected. Prove again once DuskEVM reports a new output.";

function withdrawalSteps(entry, cfg, { account, locale, name, now, time: usual, timeZone, year }) {
  const stage = entry.stage ?? "submitted";
  const time = (ms) => (ms ? formatDateTime(ms, { locale, now, timeZone, year }) : "");
  // The current stage decides: a proof the Portal rejected leaves the
  // withdrawal ready to prove again, whatever proof times are kept.
  const proved = ["proven_waiting", "ready_to_finalize", "finalize_submitted", "finalized"].includes(stage);
  const claimed = stage === "finalized";
  const sent = step("sent", `Sent on ${networkName(cfg, "dusk-evm")}`, entry.sourceAt ? "done" : "now", {
    at: entry.sourceAt ?? null,
    atText: time(entry.sourceAt),
    detail: entry.sourceAt ? "" : "Waiting for DuskEVM",
    hash: entry.hash,
    network: "dusk-evm",
  });
  let prove;
  if (proved)
    prove = step("prove", "Proved on Dusk", "done", {
      at: entry.provenAt ?? entry.proveAt ?? null,
      atText: time(entry.provenAt ?? entry.proveAt),
      detail: entry.proveHash ? "By you" : "",
      hash: entry.proveHash ?? null,
      network: "dusk",
    });
  else if (stage === "ready_to_prove")
    // Ready: its button says so.
    prove = step("prove", "Prove on Dusk", entry.pendingAction === "prove" ? "now" : "turn", {
      detail: entry.pendingAction === "prove"
        ? "Proof sent, waiting for Dusk"
        : entry.provenByOther
          ? provenByOtherLine(entry, account, name)
          : "",
      hash: entry.pendingHash ?? null,
      network: "dusk",
    });
  else if (stage === "prove_submitted")
    prove = step("prove", "Prove on Dusk", "now", { detail: "Proof sent, waiting for Dusk", hash: entry.pendingHash ?? null, network: "dusk" });
  else
    prove = step("prove", "Prove on Dusk", entry.sourceAt ? "now" : "todo", {
      // From when it can be proved: about an output after it was sent.
      detail: entry.sourceAt && usual?.prove ? `From about ${time(entry.sourceAt + usual.prove * 1_000)}` : "",
    });

  let claim;
  if (claimed)
    claim = step("claim", "Claimed on Dusk", "done", {
      at: entry.claimAt ?? null,
      atText: time(entry.claimAt),
      hash: entry.claimHash ?? null,
      network: "dusk",
    });
  else if (stage === "ready_to_finalize")
    claim = step("claim", "Claim on Dusk", entry.pendingAction === "finalize" ? "now" : "turn", {
      detail: entry.pendingAction === "finalize" ? "Claim sent, waiting for Dusk" : "",
      hash: entry.pendingHash ?? null,
      network: "dusk",
    });
  else if (stage === "finalize_submitted")
    claim = step("claim", "Claim on Dusk", "now", { detail: "Claim sent, waiting for Dusk", hash: entry.pendingHash ?? null, network: "dusk" });
  else if (stage === "proven_waiting" && entry.proofRejected)
    claim = step("claim", "Claim on Dusk", "todo", { detail: REJECTED_PROOF });
  else if (stage === "proven_waiting") {
    const timing = claimTiming(entry);
    claim = step("claim", "Claim on Dusk", "now", {
      detail: timing.overdue
        ? claimText(timing, time)
        : timing.at
          ? `${timing.exact ? "From" : "From about"} ${time(timing.at)}`
          : afterTheProof(usual),
    });
  } else claim = step("claim", "Claim on Dusk", "todo");
  return [sent, prove, claim];
}

/** A proven withdrawal whose date isn't read yet: "7 days after the proof at the soonest". */
const afterTheProof = (time) => (time?.maturity ? `${durationWords(time.maturity)} after the proof at the soonest` : "");

/**
 * The step of a transfer's own transaction: sent, and done once it's in a
 * block on its chain (`sourceAt`), with its time and transaction. One step,
 * not two: it's one transaction. Why one failed is the receipt's caption.
 */
function sentStep(entry, from, network, time) {
  const confirmed = Boolean(entry.sourceAt) || entry.status === "completed";
  return step("sent", `Sent from ${from}`, confirmed ? "done" : entry.status === "failed" ? "failed" : "now", {
    at: entry.sourceAt ?? null,
    atText: time(entry.sourceAt),
    hash: entry.hash,
    network,
  });
}

function sourceSteps(entry, route, cfg, { locale, now, timeZone, year }) {
  const time = (ms) => (ms ? formatDateTime(ms, { locale, now, timeZone, year }) : "");
  const to = networkName(cfg, route.to.id);
  const failed = entry.status === "failed";
  const confirmed = Boolean(entry.sourceAt) || entry.status === "completed";
  const arrived = entry.status === "completed";
  return [
    sentStep(entry, networkName(cfg, route.from.id), route.mode === "migration" ? route.from.id : "dusk", time),
    step("arrived", arrived ? `Arrived on ${to}` : `Arriving on ${to}`, arrived ? "done" : failed ? "todo" : confirmed ? "now" : "todo", {
      at: entry.destinationAt ?? null,
      atText: time(entry.destinationAt),
      hash: entry.destinationHash ?? null,
      network: route.to.kind === "dusk" ? "dusk" : route.to.id,
    }),
  ];
}

/** What a transfer a route holds for its account's claim says it is, in place of pending. */
export const HELD_WORD = "Held";

/** Why a transfer to Dusk waits for its claim, at the step it waits on. */
export const HELD_LINE = "First transfer to this account: held until claimed";

/**
 * A claim of escrow that went out and failed on Dusk: that, why, and what it
 * cost, which a wallet that didn't send it never says.
 */
function claimFailedLine(entry) {
  const why = String(entry.actionError ?? "").replace(/^The claim failed on Dusk:?\s*/u, "");
  const cost = entry.claimFailedFeeLux ? ` and cost ${formatDusk(BigInt(entry.claimFailedFeeLux))}` : "";
  return `The claim failed on Dusk${why ? ` (${why})` : ""}${cost}.`;
}

/** Whether a Hyperlane route holds a transfer to Dusk in escrow, for its account's claim. */
export const heldInEscrow = (entry, route) => route?.mode === "hyperlane" && entry?.status === "pending" && entry.escrow === "held";

/**
 * Whether a Hyperlane transfer held in escrow is someone else's to claim: it
 * pays another account than `owner`, the one the page is for, by its hash.
 */
export const heldForAnother = (entry, route, owner) =>
  heldInEscrow(entry, route) && Boolean(owner) && Boolean(entry.recipientHash) && entry.recipientHash !== duskRecipientHash(owner);

/**
 * A Hyperlane transfer's steps. To the EVM chain: sent, confirmed on Dusk,
 * then on its way by its message until it arrived there. To Dusk: sent on
 * the EVM chain, then on its way until Dusk's Mailbox delivered it, and,
 * where the route holds it for the account's claim, the claim.
 */
function hyperlaneSteps(entry, route, cfg, { locale, now, timeZone, year }) {
  const time = (ms) => (ms ? formatDateTime(ms, { locale, now, timeZone, year }) : "");
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  const failed = entry.status === "failed";
  const arrived = entry.status === "completed";
  const confirmed = Boolean(entry.sourceAt) || arrived;
  // Its message ID is under Details.
  if (route.from.id === "dusk")
    return [
      sentStep(entry, from, "dusk", time),
      step("arrived", arrived ? `Arrived on ${to}` : `Arriving on ${to}`, arrived ? "done" : failed ? "todo" : confirmed ? "now" : "todo", {
        at: entry.destinationAt ?? null,
        atText: time(entry.destinationAt),
        hash: entry.destinationHash ?? null,
        network: route.to.id,
      }),
    ];
  const held = entry.escrow === "held" || entry.escrow === "claimed";
  const claimed = entry.escrow === "claimed" || (held && arrived);
  const delivered = Boolean(entry.delivered) || arrived;
  const steps = [
    sentStep(entry, from, route.from.id, time),
    step("arrived", held ? "Delivered to Dusk" : delivered ? `Arrived on ${to}` : `Arriving on ${to}`, delivered ? "done" : failed ? "todo" : confirmed ? "now" : "todo", {
      at: held ? entry.deliveredAt ?? null : entry.destinationAt ?? entry.deliveredAt ?? null,
      atText: time(held ? entry.deliveredAt : entry.destinationAt ?? entry.deliveredAt),
      detail: delivered && held && !claimed ? HELD_LINE : "",
      // The transaction Dusk's Mailbox delivered it in, once found.
      hash: entry.deliveryHash ?? null,
      network: "dusk",
    }),
  ];
  // The first transfer to an account waits for its claim: said as soon as it's known.
  if (held || (entry.firstToAccount && !delivered && !failed))
    steps.push(
      claimed
        ? step("claim", "Claimed on Dusk", "done", { at: entry.claimAt ?? null, atText: time(entry.claimAt), hash: entry.claimHash ?? null, network: "dusk" })
        : step("claim", "Claim on Dusk", !held ? "todo" : entry.pendingAction === "claim" ? "now" : "turn", {
            // Ready: its button says so.
            detail: !held ? HELD_LINE : entry.pendingAction === "claim" ? "Claim sent, waiting for Dusk" : "",
            hash: entry.pendingHash ?? null,
            network: "dusk",
          }),
    );
  return steps;
}

/**
 * What moves and where, as the receipt's title: "1 EURd · Dusk → Sepolia",
 * "1,000 ERC20 DUSK · Sepolia → Dusk". Its state is its status pill's.
 */
function displayTitle(route, cfg, amount) {
  const moved =
    route.mode === "hyperlane"
      ? amount === null ? route.token.symbol : formatToken(amount, route.token)
      : route.mode === "migration"
        ? `${amount === null ? "" : `${formatDusk(amount).replace(" DUSK", "")} `}${tokenName(route.from.id)}`
        : amount === null ? "DUSK" : formatDusk(amount);
  return `${moved} · ${networkName(cfg, route.from.id)} → ${networkName(cfg, route.to.id)}`;
}

/** A transfer's state in a sentence, for what's announced or notified as it ends: "1 EURd arrived on Sepolia". */
function titleFor(entry, route, cfg, amount) {
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  if (route.mode === "hyperlane") {
    const moved = amount === null ? route.token.symbol : formatToken(amount, route.token);
    if (entry.status === "completed") return `${moved} arrived on ${to}`;
    if (entry.status === "failed") return `${moved} didn't reach ${to}`;
    if (entry.escrow === "held" && !entry.pendingAction) return `${moved} is ready to claim`;
    return `Sending ${moved} to ${to}`;
  }
  const text = amount === null ? "DUSK" : formatDusk(amount);
  const received =
    route.mode === "service-transfer" && amount !== null && cfg.service
      ? formatDusk(amount - BigInt(cfg.service.feeLux) > 0n ? amount - BigInt(cfg.service.feeLux) : 0n)
      : text;
  // A migration moves the chain's own DUSK token: "1,000 ERC20 DUSK".
  const token = route.mode === "migration" ? `${amount === null ? "" : `${formatDusk(amount).replace(" DUSK", "")} `}${tokenName(route.from.id)}` : text;
  if (entry.status === "completed") return `${received} arrived on ${to}`;
  if (entry.status === "failed")
    return route.mode === "duskevm-withdrawal" ? `The withdrawal failed on ${from}` : `${token} didn't reach ${to}`;
  if (route.mode === "duskevm-withdrawal") {
    if (entry.stage === "ready_to_finalize" && !entry.pendingAction) return `${text} is ready to claim`;
    if (entry.stage === "ready_to_prove" && !entry.pendingAction) return `Prove the withdrawal of ${text}`;
    return `Moving ${text} from ${from} to ${to}`;
  }
  if (route.mode === "migration") return `Moving ${token} to ${to}`;
  return `Sending ${text} to ${to}`;
}

/**
 * The view of one transfer.
 *
 * @param {object} entry the stored entry
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.route the entry's route
 * @param {number} [options.now]
 * @param {string} [options.timeZone] for tests; the viewer's own otherwise
 * @param {string} [options.locale] for tests: whose clock times are written on; the viewer's otherwise
 * @param {boolean} [options.year] dates as records: with the year
 * @param {string|null} [options.submitter] Dusk Wallet's account, as the Portal knows provers
 * @param {string} [options.account] the connected Dusk account
 * @param {string} [options.name] its .dusk name, where it has one
 * @param {string} [options.owner] the Dusk account the page is for: the connected one, or the followed one
 * @param {object} [options.timing] what `routeTime` reads the route's time from
 */
export function transferView(entry, { account = "", cfg, locale, name = "", now = Date.now(), owner = account, route, submitter = null, timeZone, timing, year = false }) {
  const status = entry.status === "completed" || entry.status === "failed" ? entry.status : "pending";
  const amount = amountOf(entry);
  const withdrawal = route.mode === "duskevm-withdrawal";
  const hyperlane = route.mode === "hyperlane";
  // Held for another account's claim: anyone can claim it for it, quietly.
  const held = heldInEscrow({ ...entry, status }, route);
  // Someone else's DUSK: its steps are never the user's turn, and its action is quiet.
  const forOther = status === "pending" && (sentToSomeoneElse(entry, route, owner) || heldForAnother({ ...entry, status }, route, owner));
  // How long the route takes on this network, as every page says it.
  const time = routeTime(route, cfg, { ...timing, now });
  const options = { account, locale, name, now, time, timeZone, year };
  const built = withdrawal ? withdrawalSteps(entry, cfg, options) : hyperlane ? hyperlaneSteps({ ...entry, status }, route, cfg, options) : sourceSteps({ ...entry, status }, route, cfg, options);
  const steps = built.map(
    (item) => ({
      ...item,
      href: item.hash && item.network ? explorerTxUrl(cfg, item.network, item.hash) : null,
      state: forOther && item.state === "turn" ? "now" : item.state,
    }),
  );
  const fromNetwork = route.from.id;
  const toNetwork = route.to.id;
  const actionKind = withdrawal && status === "pending" && !entry.pendingAction ? withdrawalNextAction(entry.stage) : held && !entry.pendingAction ? "claim" : null;

  let countdown = null;
  if (withdrawal && status === "pending" && entry.stage === "proven_waiting" && !entry.proofRejected) {
    const timing = claimTiming(entry);
    if (timing.at) {
      const proof = entry.provenAt ?? entry.proveAt ?? null;
      const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const change = proof ? clockChangeBetween(proof, timing.at, zone) : null;
      countdown = {
        at: timing.at,
        atText: formatDateTime(timing.at, { locale, now, timeZone, year }),
        clockNote: clockChangeNote(change, { now, timeZone: zone }),
        exact: timing.exact,
        left: durationWords(Math.max(0, (timing.at - now) / 1_000)),
        // "Claim from …", "Claim from about …", or, late, "Waiting for DuskEVM to settle this proof. …"
        line: claimText(timing, (ms) => formatDateTime(ms, { locale, now, timeZone, year })),
        overdue: timing.overdue,
      };
    }
  }

  const sentAt = entry.sourceAt ?? (entry.createdAt ? Date.parse(entry.createdAt) : null);
  const lateAfter = lateAfterSeconds(route, time);
  // What arrived, once it has, next to the word that says so, in what the route moves.
  const unit = hyperlane ? route.token.symbol : "DUSK";
  const moved = status === "completed" && route?.mode === "service-transfer" && cfg?.service?.feeLux && amount > BigInt(cfg.service.feeLux) ? amount - BigInt(cfg.service.feeLux) : amount;
  // As a list writes it: EURd and USDd to the cent, DUSK to 4 decimals.
  const shown = amount === null ? null : hyperlane ? formatTokenShort(moved, route.token) : formatShort(moved, 9);
  const late =
    status === "pending" &&
    sentAt &&
    lateAfter &&
    !held &&
    (!withdrawal || ["submitted", "waiting_for_output"].includes(entry.stage ?? "submitted")) &&
    now - sentAt > lateAfter * 1_000;

  return {
    action: actionKind
      ? {
          // A claim waits for the account that proved it.
          blocked: actionKind === "finalize" && proverMismatch(entry, submitter) ? switchToProver(entry) : "",
          // What the action's button does: a withdrawal's step, or an escrow's claim.
          command: held ? "escrow-claim" : `withdrawal-${actionKind}`,
          // Rejected in the wallet: that, as the deposit says it. Refused for
          // its gas: that, since trying again would be refused too.
          failure: !entry.actionError
            ? ""
            : held && entry.claimFailedHash
              ? claimFailedLine(entry)
              : entry.actionError === WALLET_CANCELLED || entry.actionError === WITHDRAWAL_GAS_REFUSAL || held
                ? held && entry.actionError !== WALLET_CANCELLED ? "The claim wasn't sent. Try again." : entry.actionError
                : ACTION_FAILURE[entry.stage],
          kind: actionKind,
          // What it does, and for whom where that's another account.
          label:
            actionKind === "prove"
              ? "Prove withdrawal"
              : held && forOther
                ? `Claim for ${entry.destination ? short(entry.destination) : "its account"}`
                : shown ? `Claim ${shown.exact} ${unit}` : "Claim",
          quiet: forOther,
        }
      : null,
    amount,
    // As a list writes it, and in full for whoever asks.
    amountExact: shown ? `${shown.exact} ${unit}` : "",
    amountText: shown ? `${shown.text} ${unit}` : "",
    countdown,
    from: { account: entry.sender ?? null, network: fromNetwork },
    // Its state in a sentence: what's announced, and notified, as it ends.
    headline: titleFor({ ...entry, status }, route, cfg, amount),
    late: Boolean(late),
    note: status === "failed" ? entry.note ?? "" : "",
    pair: [fromNetwork, toNetwork],
    status,
    // Delivered into escrow, or a withdrawal past its wait: it waits for its claim.
    statusWord: held || (withdrawal && status === "pending" && entry.stage === "ready_to_finalize" && !entry.pendingAction) ? HELD_WORD : STATUS_WORDS[status],
    steps,
    time,
    title: displayTitle(route, cfg, amount),
    to: { account: entry.destination ?? null, network: toNetwork },
    trackingError: entry.trackingError ? "Status unavailable, retrying" : "",
    tracker: withdrawal
      ? steps.map((item) => ({ label: trackerLabel(item, entry, now), state: item.state, when: trackerWhen(item, entry, timeZone) }))
      : null,
  };
}

/** The date under a withdrawal's step on its card: when it happened, or from when it can. */
function trackerWhen(item, entry, timeZone) {
  const day = (ms) => formatShortDay(ms, { timeZone });
  if (item.key === "sent") return entry.sourceAt ? day(entry.sourceAt) : "";
  if (item.state === "done") return item.at ? day(item.at) : "";
  if (item.key !== "claim" || entry.stage !== "proven_waiting" || entry.proofRejected) return "";
  const timing = claimTiming(entry);
  if (!timing.at) return "";
  // Late, the date is only the soonest.
  return timing.overdue ? `from ${day(timing.at)} at the soonest` : `from ${timing.exact ? "" : "about "}${day(timing.at)}`;
}

function trackerLabel(item, entry, now) {
  if (item.key === "sent") return "Sent";
  if (item.key === "prove") {
    if (item.state === "done") return entry.proveHash ? "Proved by you" : "Proved";
    if (entry.provenByOther) return "Proved by another";
    return item.state === "turn" ? "Prove now" : "Prove";
  }
  if (item.state === "done") return "Claimed";
  if (item.state === "turn") return "Claim now";
  // Late, the date moves on each check: no countdown to it.
  if (entry.stage === "proven_waiting" && entry.readyAt && !entry.claimOverdue) {
    const left = Number(entry.readyAt) * 1_000 - now;
    return left > 0 ? `Claim in ${durationWords(left / 1_000)}` : "Claim";
  }
  return "Claim";
}

/** The line under a transfer in Activity: its group says its state. */
export function transferSubline(view, entry, route, cfg, { account = "", locale, name = "", now = Date.now(), timeZone } = {}) {
  const time = (ms) => formatDateTime(ms, { locale, now, timeZone });
  if (view.status === "failed") return view.note || (entry.sourceAt ? time(entry.sourceAt) : "");
  if (heldInEscrow({ ...entry, status: view.status }, route))
    return entry.pendingAction === "claim"
      ? "Claim sent, waiting for Dusk"
      : entry.claimFailedHash && entry.actionError
        ? "The claim failed on Dusk"
        : "Held until claimed";
  if (route.mode === "duskevm-withdrawal") {
    const stage = entry.stage ?? "submitted";
    if (view.status === "completed")
      return entry.claimAt ? `Claimed ${time(entry.claimAt)}` : "Claimed on Dusk";
    if (entry.pendingAction === "prove" || stage === "prove_submitted") return "Proof sent, waiting for Dusk";
    if (entry.pendingAction === "finalize" || stage === "finalize_submitted") return "Claim sent, waiting for Dusk";
    if (stage === "ready_to_prove")
      return entry.provenByOther ? provenByOtherLine(entry, account, name) : "Ready to prove";
    if (stage === "ready_to_finalize")
      return entry.readyAt ? `Ready to claim since ${time(Number(entry.readyAt) * 1_000)}` : "Ready to claim";
    // A rejected proof never matures: it's proved again, once there's a new output.
    if (stage === "proven_waiting" && entry.proofRejected) return REJECTED_PROOF;
    if (stage === "proven_waiting") {
      if (!view.countdown) return view.time?.maturity ? `Claim ${afterTheProof(view.time)}` : "Proved";
      return view.countdown.overdue ? view.countdown.line : `${view.countdown.line} · ${view.countdown.left} left`;
    }
    if (!entry.sourceAt) return "Waiting for DuskEVM";
    return view.time?.prove
      ? `Prove from about ${time(entry.sourceAt + view.time.prove * 1_000)}`
      : `Sent ${time(entry.sourceAt)}`;
  }
  if (view.status === "completed") {
    const at = entry.destinationAt ?? entry.sourceAt;
    return at ? time(at) : "";
  }
  // When it was sent, and how long the route takes, as its receipt says it.
  const usual = view.late ? "Taking longer than usual" : routeTimeText(view.time);
  return [entry.sourceAt ? time(entry.sourceAt) : "", usual].filter(Boolean).join(" · ");
}
