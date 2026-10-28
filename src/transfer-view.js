// What a transfer says, on its receipt and in My transfers: the title, both
// accounts, each step with its time and transaction, the next action, the
// claim countdown, and when it's late. Built from the stored entry, its route
// and how long the route takes on this network; no balances, no network
// requests.

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
import { withdrawalActionFailure, withdrawalNextAction } from "./withdrawal-lifecycle.js";

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

/** "0xd63b…8df4" for EVM addresses, "rz2gFT…3VGXyt" for Dusk accounts and hashes. */
export function short(value) {
  const text = String(value ?? "");
  if (/^0x[0-9a-f]{40}$/iu.test(text)) return `${text.slice(0, 6)}…${text.slice(-4)}`;
  return text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-6)}` : text;
}

/** Wallet errors in plain words, naming the wallet that raised them. */
export function friendlyWalletError(error, wallet = "dusk") {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code];
  const name = wallet === "evm" ? "EVM wallet" : "Dusk wallet";
  if (codes.includes(4001) || error?.name === "UserRejectedRequestError")
    return "You cancelled in your wallet, so nothing was sent.";
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
 * A proof by another account, in the list and on the receipt: that proving it
 * yourself lets you claim, and whom it pays where that's another account than
 * the connected one (`account`).
 */
export function provenByOtherLine(entry, account = "") {
  const pays = entry?.destination ?? "";
  const payee = pays && pays !== account ? ` It pays ${short(pays)}${account ? ", not your connected Dusk account" : ""}.` : "";
  return `Another account proved it.${payee} Prove it yourself to claim it.`;
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
 * The claim time of a waiting withdrawal, and how sure it is: Dusk's own once
 * it gives one, else the proof time and this network's wait after it.
 */
function claimTiming(entry, now, time) {
  if (entry.readyAt) return { at: Number(entry.readyAt) * 1_000, exact: Boolean(entry.readyAtExact) };
  const proof = entry.provenAt ?? entry.proveAt;
  if (proof && time?.wait) return { at: proof + time.wait * 1_000, exact: false };
  return { at: null, exact: false, from: now };
}

const REJECTED_PROOF = "The proof was rejected. Prove again once DuskEVM reports a new output.";

function withdrawalSteps(entry, cfg, { account, now, time: usual, timeZone, year }) {
  const stage = entry.stage ?? "submitted";
  const time = (ms) => (ms ? formatDateTime(ms, { timeZone, year }) : "");
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
          ? provenByOtherLine(entry, account)
          : "Ready now",
      hash: entry.pendingHash ?? null,
      network: "dusk",
    });
  else if (stage === "prove_submitted")
    prove = step("prove", "Prove on Dusk", "now", { detail: "Proof sent, waiting for Dusk", hash: entry.pendingHash ?? null, network: "dusk" });
  else
    prove = step("prove", "Prove on Dusk", entry.sourceAt ? "now" : "todo", {
      // From when it can be proved: once DuskEVM reports it to Dusk.
      detail: entry.sourceAt && usual?.report ? `From about ${time(entry.sourceAt + usual.report * 1_000)}` : "",
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
    const timing = claimTiming(entry, now, usual);
    claim = step("claim", "Claim on Dusk", "now", {
      detail: timing.at
        ? `${timing.exact ? "From" : "From about"} ${formatDateTime(timing.at, { timeZone, year })}`
        : afterProof(usual),
    });
  } else claim = step("claim", "Claim on Dusk", "todo", { detail: afterProof(usual) });
  return [sent, prove, claim];
}

/** "~7 days after the proof", or nothing where the wait isn't known. */
const afterProof = (time) => (time?.wait ? `${aboutTime(time.wait)} after the proof` : "");

function sourceSteps(entry, route, cfg, { timeZone, year }) {
  const time = (ms) => (ms ? formatDateTime(ms, { timeZone, year }) : "");
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
    if (entry.stage === "ready_to_prove" && !entry.pendingAction) return `Prove your withdrawal of ${text}`;
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
 * @param {boolean} [options.year] dates as records: with the year
 * @param {string|null} [options.submitter] Dusk Wallet's account, as the Portal knows provers
 * @param {string} [options.account] the connected Dusk account
 * @param {object} [options.timing] what `routeTime` reads the route's time from
 */
export function transferView(entry, { account = "", cfg, now = Date.now(), route, submitter = null, timeZone, timing, year = false }) {
  const status = entry.status === "completed" || entry.status === "failed" ? entry.status : "pending";
  const amount = amountOf(entry);
  const withdrawal = route.mode === "duskevm-withdrawal";
  // How long the route takes on this network, as every page says it.
  const time = routeTime(route, cfg, { ...timing, now });
  const options = { account, now, time, timeZone, year };
  const steps = (withdrawal ? withdrawalSteps(entry, cfg, options) : sourceSteps({ ...entry, status }, route, cfg, options)).map(
    (item) => ({ ...item, href: item.hash && item.network ? explorerTxUrl(cfg, item.network, item.hash) : null }),
  );
  const fromNetwork = route.from.id;
  const toNetwork = route.to.id;
  const actionKind = withdrawal && status === "pending" && !entry.pendingAction ? withdrawalNextAction(entry.stage) : null;

  let countdown = null;
  if (withdrawal && status === "pending" && entry.stage === "proven_waiting" && !entry.proofRejected) {
    const timing = claimTiming(entry, now, time);
    if (timing.at) {
      const proof = entry.provenAt ?? entry.proveAt ?? null;
      const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const change = proof ? clockChangeBetween(proof, timing.at, zone) : null;
      countdown = {
        at: timing.at,
        atText: formatDateTime(timing.at, { timeZone, year }),
        clockNote: clockChangeNote(change, { now, timeZone: zone }),
        exact: timing.exact,
        left: durationWords(Math.max(0, (timing.at - now) / 1_000)),
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
          failure: entry.actionError ? withdrawalActionFailure(entry.stage, entry.actionError) : "",
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
      ? steps.map((item) => ({ label: trackerLabel(item, entry, now), state: item.state, when: trackerWhen(item, entry, now, timeZone, time) }))
      : null,
  };
}

/** The date under a withdrawal's step on its card: when it happened, or from when it can. */
function trackerWhen(item, entry, now, timeZone, time) {
  const day = (ms) => formatShortDay(ms, { timeZone });
  if (item.key === "sent") return entry.sourceAt ? day(entry.sourceAt) : "";
  if (item.state === "done") return item.at ? day(item.at) : "";
  if (item.key !== "claim" || entry.stage !== "proven_waiting" || entry.proofRejected) return "";
  const timing = claimTiming(entry, now, time);
  return timing.at ? `from ${timing.exact ? "" : "about "}${day(timing.at)}` : "";
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
  if (entry.stage === "proven_waiting" && entry.readyAt) {
    const left = Number(entry.readyAt) * 1_000 - now;
    return left > 0 ? `Claim in ${durationWords(left / 1_000)}` : "Claim";
  }
  return "Claim";
}

/** The line under a transfer in My transfers. */
export function transferSubline(view, entry, route, cfg, { account = "", now = Date.now(), timeZone } = {}) {
  const time = (ms) => formatDateTime(ms, { timeZone });
  if (view.status === "failed") return view.note || "This transfer didn't go through.";
  if (route.mode === "duskevm-withdrawal") {
    const stage = entry.stage ?? "submitted";
    if (view.status === "completed")
      return entry.claimAt ? `Claimed ${time(entry.claimAt)}` : "Claimed on Dusk";
    if (entry.pendingAction === "prove" || stage === "prove_submitted") return "Proof sent, waiting for Dusk";
    if (entry.pendingAction === "finalize" || stage === "finalize_submitted") return "Claim sent, waiting for Dusk";
    if (stage === "ready_to_prove")
      return entry.provenByOther ? provenByOtherLine(entry, account) : "Ready to prove on Dusk";
    if (stage === "ready_to_finalize")
      return entry.readyAt ? `Ready to claim since ${time(Number(entry.readyAt) * 1_000)}` : "Ready to claim on Dusk";
    // A rejected proof never matures: it's proved again, once there's a new output.
    if (stage === "proven_waiting" && entry.proofRejected) return REJECTED_PROOF;
    if (stage === "proven_waiting")
      return view.countdown
        ? `Claim ${view.countdown.exact ? "from" : "from about"} ${view.countdown.atText} · ${view.countdown.left} left`
        : view.time?.wait
          ? `Claim ${aboutTime(view.time.wait)} after the proof`
          : "Proven";
    if (!entry.sourceAt) return "Waiting for DuskEVM";
    return view.time?.report
      ? `Prove from about ${time(entry.sourceAt + view.time.report * 1_000)}`
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
