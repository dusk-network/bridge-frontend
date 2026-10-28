// What a transfer says, on its receipt and in My transfers: the title, both
// accounts, each step with its time and transaction, the next action, the
// claim countdown, and when it's late. Built from the stored entry, its route
// and how long the route takes on this network; no balances, no network
// requests.

import { formatEvmAddress, shortAccount } from "@dusk-network/networks/format";

import { claimText } from "./claim-date.js";
import {
  clockChangeBetween,
  clockChangeNote,
  durationWords,
  formatDateTime,
  formatDusk,
  formatShortDay,
} from "./format.js";
import { networkName, tokenName } from "./names.js";
import { aboutTime, lateAfterSeconds, routeTime } from "./route-times.js";
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

/**
 * As every Dusk app shortens them: "0xd63b…8DF4" for EVM addresses, with
 * their checksum's capitals; "rz2gFT…3VGXyt" for Dusk accounts and hashes.
 */
export function short(value) {
  const text = String(value ?? "");
  return /^0x[0-9a-f]{40}$/iu.test(text) ? formatEvmAddress(text, { short: true }) : shortAccount(text);
}

/** The action a withdrawal's stage waits for, if the user can take it now. */
export const withdrawalNextAction = (stage) => (stage === "ready_to_prove" ? "prove" : stage === "ready_to_finalize" ? "finalize" : null);

/** What a proof or claim that couldn't be sent says, at the stage that offers to send it again. */
const ACTION_FAILURE = Object.freeze({
  ready_to_finalize: "The claim wasn't sent. Try again.",
  ready_to_prove: "The proof wasn't sent. Try again.",
});

/** What every page says when you reject a request in your wallet: never in red, it's your choice. */
export const WALLET_CANCELLED = "You cancelled in your wallet, so nothing was sent.";

/** Whether the wallet's user rejected the request (4001), however the wallet wrapped it. */
export const walletCancelled = (error) =>
  [error?.code, error?.cause?.code, error?.cause?.cause?.code].includes(4001) || error?.name === "UserRejectedRequestError";

/** What a proof or claim that wasn't sent keeps on its transfer: that you cancelled it, or why it failed. */
export const actionErrorOf = (error) => (walletCancelled(error) ? WALLET_CANCELLED : error?.message ?? String(error));

/** Wallet errors in plain words, naming the wallet that raised them. */
export function friendlyWalletError(error, wallet = "dusk") {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code];
  const name = wallet === "evm" ? "EVM wallet" : "Dusk wallet";
  if (walletCancelled(error)) return WALLET_CANCELLED;
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
  const notYours = account ? `, not ${name || "your connected Dusk account"}` : "";
  return `Another account proved it. This pays ${short(pays)}${notYours}. If you prove and claim, the DUSK still goes there.`;
}

const amountOf = (entry) =>
  entry.amountLux !== undefined && entry.amountLux !== null ? BigInt(entry.amountLux) : null;

/**
 * What becomes public, in one line, naming the accounts themselves: the Dusk
 * one by its .dusk name too, when it has one (`name`), as the wallet shows it.
 */
export function privacyLine(route, cfg, { dusk, evm, name = "" } = {}) {
  const duskText = dusk ? `Dusk account ${name ? `${name} (${short(dusk)})` : short(dusk)}` : "Dusk account";
  const evmText = evm ? short(evm) : "your EVM address";
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  // From the sending side to the paid one, then the amount.
  const parties = route.from.kind === "dusk" ? `your ${duskText}, ${evmText}` : `${evmText}, the ${duskText}`;
  return `Public on ${from} and ${to}, and linked: ${parties} and the amount.`;
}

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
    prove = step("prove", "Proven on Dusk", "done", {
      at: entry.provenAt ?? entry.proveAt ?? null,
      atText: time(entry.provenAt ?? entry.proveAt),
      detail: entry.proveHash ? "By you" : "",
      hash: entry.proveHash ?? null,
      network: "dusk",
    });
  else if (stage === "ready_to_prove")
    prove = step("prove", "Prove on Dusk", entry.pendingAction === "prove" ? "now" : "turn", {
      detail: entry.pendingAction === "prove"
        ? "Proof sent, waiting for Dusk"
        : entry.provenByOther
          ? provenByOtherLine(entry, account, name)
          : "Ready now",
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
      detail: entry.pendingAction === "finalize" ? "Claim sent, waiting for Dusk" : "Ready now",
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
  } else claim = step("claim", "Claim on Dusk", "todo", { detail: usual?.maturity ? `${durationWords(usual.maturity)} after you prove` : "" });
  return [sent, prove, claim];
}

/** A proven withdrawal whose date isn't read yet: "7 days after the proof at the soonest". */
const afterTheProof = (time) => (time?.maturity ? `${durationWords(time.maturity)} after the proof at the soonest` : "");

function sourceSteps(entry, route, cfg, { locale, now, timeZone, year }) {
  const time = (ms) => (ms ? formatDateTime(ms, { locale, now, timeZone, year }) : "");
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  const failed = entry.status === "failed";
  const confirmed = Boolean(entry.sourceAt) || entry.status === "completed";
  const steps = [];
  if (route.mode !== "migration")
    steps.push(
      step("sent", `Sent from ${from}`, "done", {
        hash: entry.hash,
        network: "dusk",
      }),
    );
  steps.push(
    step("confirmed", route.mode === "migration" ? `Migration confirmed on ${from}` : `Confirmed on ${from}`, confirmed ? "done" : failed ? "failed" : "now", {
      at: entry.sourceAt ?? null,
      atText: time(entry.sourceAt),
      detail: confirmed ? "" : failed ? entry.note ?? "" : `Waiting for ${from}`,
      hash: route.mode === "migration" ? entry.hash : null,
      network: route.mode === "migration" ? route.from.id : null,
    }),
  );
  const arrived = entry.status === "completed";
  const verb = route.mode === "duskevm-deposit" ? "Arrived on" : "Paid out on";
  steps.push(
    step("arrived", arrived ? `${verb} ${to}` : route.mode === "duskevm-deposit" ? `Arriving on ${to}` : `Paying out on ${to}`, arrived ? "done" : failed ? "todo" : confirmed ? "now" : "todo", {
      at: entry.destinationAt ?? null,
      atText: time(entry.destinationAt),
      hash: entry.destinationHash ?? null,
      network: route.to.kind === "dusk" ? "dusk" : route.to.id,
    }),
  );
  return steps;
}

function titleFor(entry, route, cfg, amount) {
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
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
 * @param {object} [options.timing] what `routeTime` reads the route's time from
 */
export function transferView(entry, { account = "", cfg, locale, name = "", now = Date.now(), route, submitter = null, timeZone, timing, year = false }) {
  const status = entry.status === "completed" || entry.status === "failed" ? entry.status : "pending";
  const amount = amountOf(entry);
  const withdrawal = route.mode === "duskevm-withdrawal";
  // How long the route takes on this network, as every page says it.
  const time = routeTime(route, cfg, { ...timing, now });
  const options = { account, locale, name, now, time, timeZone, year };
  const steps = (withdrawal ? withdrawalSteps(entry, cfg, options) : sourceSteps({ ...entry, status }, route, cfg, options)).map(
    (item) => ({ ...item, href: item.hash && item.network ? explorerTxUrl(cfg, item.network, item.hash) : null }),
  );
  const fromNetwork = route.from.id;
  const toNetwork = route.to.id;
  const actionKind = withdrawal && status === "pending" && !entry.pendingAction ? withdrawalNextAction(entry.stage) : null;

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
  const late =
    status === "pending" &&
    sentAt &&
    lateAfter &&
    (!withdrawal || ["submitted", "waiting_for_output"].includes(entry.stage ?? "submitted")) &&
    now - sentAt > lateAfter * 1_000;

  return {
    action: actionKind
      ? {
          // A claim waits for the account that proved it.
          blocked: actionKind === "finalize" && proverMismatch(entry, submitter) ? switchToProver(entry) : "",
          // Rejected in the wallet: that, as the deposit says it. Refused for
          // its gas: that, since trying again would be refused too.
          failure: !entry.actionError
            ? ""
            : entry.actionError === WALLET_CANCELLED || entry.actionError === WITHDRAWAL_GAS_REFUSAL
              ? entry.actionError
              : ACTION_FAILURE[entry.stage],
          kind: actionKind,
          label: actionKind === "prove" ? "Prove on Dusk" : "Claim on Dusk",
        }
      : null,
    amount,
    amountText: amount === null ? "" : formatDusk(amount),
    countdown,
    from: { account: entry.sender ?? null, network: fromNetwork },
    late: Boolean(late),
    note: status === "failed" ? entry.note ?? "" : "",
    pair: [fromNetwork, toNetwork],
    rowTitle: `${networkName(cfg, fromNetwork)} to ${networkName(cfg, toNetwork)}`,
    status,
    statusWord: STATUS_WORDS[status],
    steps,
    time,
    title: titleFor({ ...entry, status }, route, cfg, amount),
    to: { account: entry.destination ?? null, network: toNetwork },
    trackingError: entry.trackingError ? "Status unavailable. Trying again." : "",
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
    if (item.state === "done") return entry.proveHash ? "Proven by you" : "Proven";
    if (entry.provenByOther) return "Proven by another";
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

/** The line under a transfer in My transfers. */
export function transferSubline(view, entry, route, cfg, { account = "", locale, name = "", now = Date.now(), timeZone } = {}) {
  const time = (ms) => formatDateTime(ms, { locale, now, timeZone });
  if (view.status === "failed") return view.note || "This transfer didn't go through.";
  if (route.mode === "duskevm-withdrawal") {
    const stage = entry.stage ?? "submitted";
    if (view.status === "completed")
      return entry.claimAt ? `Claimed ${time(entry.claimAt)}` : "Claimed on Dusk";
    if (entry.pendingAction === "prove" || stage === "prove_submitted") return "Proof sent, waiting for Dusk";
    if (entry.pendingAction === "finalize" || stage === "finalize_submitted") return "Claim sent, waiting for Dusk";
    if (stage === "ready_to_prove")
      return entry.provenByOther ? provenByOtherLine(entry, account, name) : "Ready to prove on Dusk";
    if (stage === "ready_to_finalize")
      return entry.readyAt ? `Ready to claim since ${time(Number(entry.readyAt) * 1_000)}` : "Ready to claim on Dusk";
    // A rejected proof never matures: it's proved again, once there's a new output.
    if (stage === "proven_waiting" && entry.proofRejected) return REJECTED_PROOF;
    if (stage === "proven_waiting") {
      if (!view.countdown) return view.time?.maturity ? `Claim ${afterTheProof(view.time)}` : "Proven";
      return view.countdown.overdue ? view.countdown.line : `${view.countdown.line} · ${view.countdown.left} left`;
    }
    if (!entry.sourceAt) return "Waiting for DuskEVM";
    return view.time?.prove
      ? `Prove from about ${time(entry.sourceAt + view.time.prove * 1_000)}`
      : `Sent ${time(entry.sourceAt)}`;
  }
  if (view.status === "completed") {
    const at = entry.destinationAt ?? entry.sourceAt;
    return at ? `${route.mode === "duskevm-deposit" ? "Arrived" : "Paid out"} ${time(at)}` : "Completed";
  }
  const sent = entry.sourceAt ? `Sent ${time(entry.sourceAt)}` : "Sent";
  const usual = view.late ? "taking longer than usual" : view.time ? `takes ${aboutTime(view.time.seconds)}` : "";
  return [sent, usual].filter(Boolean).join(" · ");
}
