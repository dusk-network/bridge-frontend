// What a transfer says, on its receipt and in My transfers: the title, both
// accounts, each step with its time and transaction, the next action, the
// claim countdown, who holds the DUSK, and what to do when it's late. Built
// from the stored entry and its route; no balances, no network requests.

import {
  clockChangeBetween,
  clockChangeNote,
  durationWords,
  formatDateTime,
  formatDusk,
  formatFee,
} from "./format.js";
import { networkName } from "./names.js";
import { routeDuskFees } from "./quote.js";
import { STATUS_WORDS } from "./tracking.js";
import {
  PROVEN_BY_OTHER_ACCOUNT,
  WITHDRAWAL_REPORT_SECONDS,
  WITHDRAWAL_WAITING_PERIOD_SECONDS,
  roughDuration,
  withdrawalActionFailure,
  withdrawalNextAction,
} from "./withdrawal-lifecycle.js";

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

const amountOf = (entry) =>
  entry.amountLux !== undefined && entry.amountLux !== null ? BigInt(entry.amountLux) : null;

/** How long after sending a transfer counts as late, per route. */
export function lateAfterSeconds(route, cfg) {
  if (route.mode === "duskevm-deposit") return 15 * 60;
  if (route.mode === "service-transfer") return 2 * (cfg.service?.delaySeconds ?? 3_600);
  if (route.mode === "migration") return 2 * (cfg.migrationDelaySeconds ?? 3_600);
  return 3 * WITHDRAWAL_REPORT_SECONDS;
}

/** Who holds the DUSK while the transfer runs, in one line. */
export function custodyLine(route, cfg, entry = {}) {
  const to = networkName(cfg, route.to.id);
  if (route.mode === "migration")
    return "The migration contract keeps the old DUSK locked: it has no function to send them out. The bridge then pays the same amount from its own Dusk account.";
  if (route.mode === "service-transfer")
    return `The bridge account on Dusk keeps the DUSK you send. The bridge then pays out the amount minus its fee as DUSK on ${to}.`;
  if (route.mode === "duskevm-deposit")
    return `The DuskEVM bridge contract on Dusk holds the DUSK while it is on ${to}.`;
  const recipient = entry.destination ? short(entry.destination) : "the Dusk account in the withdrawal";
  return `Until it's claimed, the DUSK waits in the DuskEVM bridge contract on Dusk. A claim always pays ${recipient}.`;
}

/** What becomes public, in one line, naming the accounts themselves. */
export function privacyLine(route, cfg, { dusk, evm } = {}) {
  const duskText = dusk ? `Dusk account ${short(dusk)}` : "Dusk account";
  const evmText = evm ? short(evm) : "your EVM address";
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  if (route.mode === "migration")
    return `${evmText}, the amount and the ${duskText} it pays are visible on ${from}, and the payout on Dusk names the ${from} transaction, so anyone can link them.`;
  if (route.mode === "service-transfer")
    return `Your ${duskText}, the amount and the ${to} address in the memo are visible on Dusk, and the payout on ${to} links to it.`;
  if (route.mode === "duskevm-deposit")
    return `Your ${duskText}, ${evmText} and the amount are visible on Dusk and DuskEVM, and linked to each other.`;
  return `${evmText}, the ${duskText} it pays and the amount are visible on DuskEVM and Dusk, and linked to each other.`;
}

function step(key, title, state, extra = {}) {
  return { at: null, detail: "", hash: null, key, network: null, state, title, ...extra };
}

/** The claim time of a waiting withdrawal, and how sure it is. */
function claimTiming(entry, now) {
  if (entry.readyAt) return { at: Number(entry.readyAt) * 1_000, exact: Boolean(entry.readyAtExact) };
  const proof = entry.provenAt ?? entry.proveAt;
  if (proof) return { at: proof + WITHDRAWAL_WAITING_PERIOD_SECONDS * 1_000, exact: false };
  return { at: null, exact: false, from: now };
}

const REJECTED_PROOF = "The proof was rejected. Prove again once DuskEVM reports a new output.";

function withdrawalSteps(entry, cfg, { now, timeZone, year }) {
  const stage = entry.stage ?? "submitted";
  const time = (ms) => (ms ? formatDateTime(ms, { timeZone, year }) : "");
  // The current stage decides: a proof the Portal rejected leaves the
  // withdrawal ready to prove again, whatever proof times are kept.
  const proved = ["proven_waiting", "ready_to_finalize", "finalize_submitted", "finalized"].includes(stage);
  const claimed = stage === "finalized";
  const fees = routeDuskFees({ mode: "duskevm-withdrawal" }, { gasPrice: 1n });
  const sent = step("sent", `Sent on ${networkName(cfg, "dusk-evm")}`, entry.sourceAt ? "done" : "now", {
    at: entry.sourceAt ?? null,
    atText: time(entry.sourceAt),
    detail: entry.sourceAt ? "" : "Waiting for DuskEVM to include it",
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
          ? PROVEN_BY_OTHER_ACCOUNT
          : `Ready now · network fee up to ${formatFee(fees.prove.maxLux, 9, { round: "up" })} DUSK`,
      hash: entry.pendingHash ?? null,
      network: "dusk",
    });
  else if (stage === "prove_submitted")
    prove = step("prove", "Prove on Dusk", "now", { detail: "Proof sent, waiting for Dusk", hash: entry.pendingHash ?? null, network: "dusk" });
  else
    prove = step("prove", "Prove on Dusk", entry.sourceAt ? "now" : "todo", {
      detail: entry.sourceAt
        ? `DuskEVM usually reports a withdrawal to Dusk within ${roughDuration(WITHDRAWAL_REPORT_SECONDS)}. Then you can prove it.`
        : "",
    });

  let claim;
  if (claimed)
    claim = step("claim", "Claimed on Dusk", "done", {
      at: entry.claimAt ?? null,
      atText: time(entry.claimAt),
      detail: entry.destination ? `The DUSK arrived in ${short(entry.destination)}` : "",
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
    const timing = claimTiming(entry, now);
    claim = step("claim", "Claim on Dusk", "now", {
      detail: timing.at
        ? `${timing.exact ? "From" : "From about"} ${formatDateTime(timing.at, { timeZone, year })}`
        : `About ${roughDuration(WITHDRAWAL_WAITING_PERIOD_SECONDS)} after the proof`,
    });
  } else
    claim = step("claim", "Claim on Dusk", "todo", {
      detail: `About ${roughDuration(WITHDRAWAL_WAITING_PERIOD_SECONDS)} after the proof`,
    });
  return [sent, prove, claim];
}

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
        detail: entry.sentHere ? "Signed in Dusk Wallet" : "",
        hash: entry.hash,
        network: "dusk",
      }),
    );
  steps.push(
    step("confirmed", route.mode === "migration" ? `Migration confirmed on ${from}` : `Confirmed on ${from}`, confirmed ? "done" : failed ? "failed" : "now", {
      at: entry.sourceAt ?? null,
      atText: time(entry.sourceAt),
      detail: confirmed ? `Confirmed by the ${from} network` : failed ? entry.note ?? "" : `Waiting for ${from}`,
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
      detail: arrived
        ? entry.destination
          ? `To ${short(entry.destination)}`
          : ""
        : failed
          ? ""
          : `${arrivalWords(route, cfg)}${entry.destination ? `, to ${short(entry.destination)}` : ""}`,
      hash: entry.destinationHash ?? null,
      network: route.to.kind === "dusk" ? "dusk" : route.to.id,
    }),
  );
  return steps;
}

function arrivalWords(route, cfg) {
  if (route.mode === "duskevm-deposit") return "Usually within a minute";
  if (route.mode === "service-transfer") return `Usually within ${roughDuration(cfg.service?.delaySeconds ?? 3_600)}`;
  return `Usually within ${roughDuration(cfg.migrationDelaySeconds ?? 3_600)}`;
}

function titleFor(entry, route, cfg, amount) {
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  const text = amount === null ? "DUSK" : formatDusk(amount);
  const received =
    route.mode === "service-transfer" && amount !== null && cfg.service
      ? formatDusk(amount - BigInt(cfg.service.feeLux) > 0n ? amount - BigInt(cfg.service.feeLux) : 0n)
      : text;
  const old = route.mode === "migration" ? `${amount === null ? "" : `${formatDusk(amount).replace(" DUSK", "")} `}old DUSK` : text;
  if (entry.status === "completed") return `${received} arrived on ${to}`;
  if (entry.status === "failed")
    return route.mode === "duskevm-withdrawal" ? `The withdrawal failed on ${from}` : `${route.mode === "migration" ? old : text} didn't reach ${to}`;
  if (route.mode === "duskevm-withdrawal") {
    if (entry.stage === "ready_to_finalize" && !entry.pendingAction) return `${text} is ready to claim`;
    if (entry.stage === "ready_to_prove" && !entry.pendingAction) return `Prove your withdrawal of ${text}`;
    return `Moving ${text} from ${from} to ${to}`;
  }
  if (route.mode === "migration") return `Moving ${old} to ${to}`;
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
 */
export function transferView(entry, { cfg, now = Date.now(), route, submitter = null, timeZone, year = false }) {
  const status = entry.status === "completed" || entry.status === "failed" ? entry.status : "pending";
  const amount = amountOf(entry);
  const withdrawal = route.mode === "duskevm-withdrawal";
  const options = { now, timeZone, year };
  const steps = (withdrawal ? withdrawalSteps(entry, cfg, options) : sourceSteps({ ...entry, status }, route, cfg, options)).map(
    (item) => ({ ...item, href: item.hash && item.network ? explorerTxUrl(cfg, item.network, item.hash) : null }),
  );
  const fromNetwork = route.from.id;
  const toNetwork = route.to.id;
  const actionKind = withdrawal && status === "pending" && !entry.pendingAction ? withdrawalNextAction(entry.stage) : null;

  let countdown = null;
  if (withdrawal && status === "pending" && entry.stage === "proven_waiting" && !entry.proofRejected) {
    const timing = claimTiming(entry, now);
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
  const late =
    status === "pending" &&
    sentAt &&
    (!withdrawal || ["submitted", "waiting_for_output"].includes(entry.stage ?? "submitted")) &&
    now - sentAt > lateAfterSeconds(route, cfg) * 1_000;

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
    custody: custodyLine(route, cfg, entry),
    from: { account: entry.sender ?? null, network: fromNetwork },
    late: Boolean(late),
    lateText: late ? lateText(route, cfg) : "",
    note: status === "failed" ? entry.note ?? "" : "",
    pair: [fromNetwork, toNetwork],
    rowTitle: `${networkName(cfg, fromNetwork)} to ${networkName(cfg, toNetwork)}`,
    status,
    statusWord: STATUS_WORDS[status],
    steps,
    title: titleFor({ ...entry, status }, route, cfg, amount),
    to: { account: entry.destination ?? null, network: toNetwork },
    trackingError: entry.trackingError ? "Status unavailable. Trying again." : "",
    tracker: withdrawal ? steps.map((item) => ({ label: trackerLabel(item, entry, now), state: item.state })) : null,
  };
}

function lateText(route, cfg) {
  if (route.mode === "duskevm-deposit") return "Taking longer than usual. Deposits usually arrive within a minute.";
  if (route.mode === "service-transfer")
    return `Taking longer than usual. Payouts usually come within ${roughDuration(cfg.service?.delaySeconds ?? 3_600)}.`;
  if (route.mode === "migration")
    return `Taking longer than usual. Migrations are usually paid out within ${roughDuration(cfg.migrationDelaySeconds ?? 3_600)}.`;
  return `Taking longer than usual. DuskEVM usually reports a withdrawal to Dusk within ${roughDuration(WITHDRAWAL_REPORT_SECONDS)}.`;
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
export function transferSubline(view, entry, route, cfg, { now = Date.now(), timeZone } = {}) {
  const time = (ms) => formatDateTime(ms, { timeZone });
  if (view.status === "failed") return view.note || "This transfer didn't go through.";
  if (route.mode === "duskevm-withdrawal") {
    const stage = entry.stage ?? "submitted";
    if (view.status === "completed")
      return entry.claimAt ? `Claimed ${time(entry.claimAt)}` : "Claimed on Dusk";
    if (entry.pendingAction === "prove" || stage === "prove_submitted") return "Proof sent, waiting for Dusk";
    if (entry.pendingAction === "finalize" || stage === "finalize_submitted") return "Claim sent, waiting for Dusk";
    if (stage === "ready_to_prove")
      return entry.provenByOther ? PROVEN_BY_OTHER_ACCOUNT : "Ready to prove on Dusk";
    if (stage === "ready_to_finalize")
      return entry.readyAt ? `Ready to claim since ${time(Number(entry.readyAt) * 1_000)}` : "Ready to claim on Dusk";
    // A rejected proof never matures: it's proved again, once there's a new output.
    if (stage === "proven_waiting" && entry.proofRejected) return REJECTED_PROOF;
    if (stage === "proven_waiting")
      return view.countdown
        ? `Claim ${view.countdown.exact ? "from" : "from about"} ${view.countdown.atText} · ${view.countdown.left} left`
        : `Claim about ${roughDuration(WITHDRAWAL_WAITING_PERIOD_SECONDS)} after the proof`;
    return entry.sourceAt
      ? `Sent ${time(entry.sourceAt)} · DuskEVM usually reports it to Dusk within ${roughDuration(WITHDRAWAL_REPORT_SECONDS)}`
      : "Waiting for DuskEVM";
  }
  if (view.status === "completed") {
    const at = entry.destinationAt ?? entry.sourceAt;
    return at ? `${route.mode === "duskevm-deposit" ? "Arrived" : "Paid out"} ${time(at)}` : "Completed";
  }
  const sent = entry.sourceAt ? `Sent ${time(entry.sourceAt)}` : "Sent";
  const receive =
    route.mode === "service-transfer" && view.amount !== null && cfg.service
      ? ` · you receive ${formatDusk(view.amount - BigInt(cfg.service.feeLux))}`
      : "";
  return `${sent} · ${arrivalWords(route, cfg).toLowerCase()}${receive}`;
}
