// What an activity entry says: its status word, the line under it, links to
// both sides, and for withdrawals the three steps with their times.

import { formatUnits } from "./amount.js";
import { shortAddress } from "./validation.js";
import { STATUS_WORDS } from "./tracking.js";
import {
  PROVEN_BY_OTHER_ACCOUNT,
  WITHDRAWAL_WAITING_PERIOD_SECONDS,
  formatClaimTime,
  roughDuration,
  withdrawalActionFailure,
  withdrawalNextAction,
  withdrawalStageMessage,
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

/** A transaction's page on the network's explorer. */
export function explorerTxUrl(cfg, network, hash) {
  if (!hash) return null;
  if (network === "dusk")
    return `${cfg.dusk.explorerUrl.replace(/\/+$/u, "")}/transactions/transaction?id=${withoutPrefix(hash)}`;
  const explorer =
    network === "dusk-evm" ? cfg.duskEvm.explorerUrl : cfg.evmNetworks[network]?.explorerUrl;
  return explorer ? `${explorer.replace(/\/+$/u, "")}/tx/${withPrefix(hash)}` : null;
}

const time = (ms) => (ms ? formatClaimTime(ms) : "");

function withdrawalSteps(entry, route, now) {
  const stage = entry.stage ?? "submitted";
  const evmName = route.from.label;
  const duskName = route.to.label;
  const proved = entry.provenAt || ["proven_waiting", "ready_to_finalize", "finalize_submitted", "finalized"].includes(stage);
  const claimed = stage === "finalized";
  const proveDetail = () => {
    // The Portal's own time, or this browser's proof transaction when the
    // Portal counts block heights instead of time.
    if (entry.provenAt || entry.proveAt) return time(entry.provenAt ?? entry.proveAt);
    if (stage === "prove_submitted") return "Proof sent";
    if (stage === "ready_to_prove") return "Ready. Step 1 of 2. Fee from your public account.";
    if (stage === "waiting_for_output") return withdrawalStageMessage(entry, now);
    return "";
  };
  const claimDetail = () => {
    if (claimed) return entry.claimAt ? time(entry.claimAt) : "";
    if (stage === "finalize_submitted") return "Claim sent";
    if (stage === "ready_to_finalize") return "Ready. Step 2 of 2. Fee from your public account.";
    if (stage === "proven_waiting") return withdrawalStageMessage(entry, now);
    return `About ${roughDuration(WITHDRAWAL_WAITING_PERIOD_SECONDS)} after the proof`;
  };
  return [
    {
      detail: entry.sourceAt ? time(entry.sourceAt) : "Processing",
      done: Boolean(entry.sourceAt) && stage !== "submitted",
      label: `Sent on ${evmName}`,
    },
    {
      detail: proveDetail(),
      done: Boolean(proved),
      label: `Proved on ${duskName}`,
      link: entry.proveHash ? { hash: entry.proveHash, network: "dusk" } : null,
    },
    {
      detail: claimDetail(),
      done: claimed,
      label: `Claimed on ${duskName}`,
      link: entry.claimHash ? { hash: entry.claimHash, network: "dusk" } : null,
    },
  ];
}

function withdrawalNote(entry, status) {
  if (status === "failed") return entry.note ?? "";
  if (status === "pending" && entry.stage === "ready_to_prove" && entry.provenByOther)
    return PROVEN_BY_OTHER_ACCOUNT;
  return "";
}

/**
 * @param {object} entry the stored activity entry
 * @param {object} options
 * @param {object} options.cfg the deployment config
 * @param {object | undefined} options.route the entry's route, if this deployment has it
 */
export function activityView(entry, { cfg, now = Date.now(), route }) {
  const status = entry.status === "completed" || entry.status === "failed" ? entry.status : "pending";
  const amount =
    entry.amountLux !== undefined && entry.amountLux !== null
      ? `${formatUnits(BigInt(entry.amountLux), 9)} DUSK`
      : entry.amount
        ? `${entry.amount} DUSK`
        : "";
  if (!route)
    return {
      action: null,
      amount,
      links: [],
      note: "This route isn't available on this network.",
      status: STATUS_WORDS[status],
      steps: [],
      title: entry.routeId,
    };
  const sourceNetwork = route.from.kind === "dusk" ? "dusk" : route.from.id;
  const destinationNetwork = route.to.kind === "dusk" ? "dusk" : route.to.id;
  const links = [
    { href: explorerTxUrl(cfg, sourceNetwork, entry.hash), label: `${route.from.label} transaction` },
  ];
  if (entry.destinationHash)
    links.push({
      href: explorerTxUrl(cfg, destinationNetwork, entry.destinationHash),
      label: `${route.to.label} transaction`,
    });
  const withdrawal = route.mode === "duskevm-withdrawal";
  const steps = withdrawal
    ? withdrawalSteps(entry, route, now).map((step) => ({
        ...step,
        href: step.link ? explorerTxUrl(cfg, step.link.network, step.link.hash) : null,
      }))
    : [];
  const actionKind = withdrawal && status === "pending" ? withdrawalNextAction(entry.stage) : null;
  return {
    action: actionKind
      ? {
          failure: entry.actionError ? withdrawalActionFailure(entry.stage, entry.actionError) : "",
          kind: actionKind,
          label: actionKind === "prove" ? "Prove on Dusk" : "Claim on Dusk",
        }
      : null,
    amount,
    destination: entry.destination ? shortAddress(entry.destination, 8, 6) : "",
    links: links.filter((link) => link.href),
    note: withdrawal ? withdrawalNote(entry, status) : entry.note ?? "",
    sentAt: entry.sourceAt ? time(entry.sourceAt) : "",
    status: STATUS_WORDS[status],
    steps,
    title: `${route.from.label} → ${route.to.label}`,
    trackingError: entry.trackingError ? "Status unavailable. Retrying." : "",
  };
}

export function renderActivityItem(entry, view, { busy = false } = {}) {
  const meta = [view.amount, view.status, view.sentAt].filter(Boolean).join(" · ");
  const steps = view.steps.length
    ? `<ol class="activity-steps">${view.steps
        .map(
          (step) =>
            `<li class="${step.done ? "done" : ""}"><span>${html(step.label)}</span><span>${html(step.detail)}${step.href ? ` · <a href="${html(step.href)}" target="_blank" rel="noreferrer">Transaction</a>` : ""}</span></li>`,
        )
        .join("")}</ol>`
    : "";
  const links = view.links.length
    ? `<div class="activity-links">${view.links
        .map(
          (link) =>
            `<a href="${html(link.href)}" target="_blank" rel="noreferrer">${html(link.label)}</a>`,
        )
        .join("")}</div>`
    : "";
  const action = view.action
    ? `${view.action.failure ? `<p class="activity-note error">${html(view.action.failure)}</p>` : ""}<button type="button" data-action="withdrawal-${view.action.kind}" data-id="${html(entry.id)}" ${busy ? "disabled" : ""}>${html(view.action.label)}</button>`
    : "";
  return `<li class="activity-item" data-status="${html(entry.status ?? "pending")}"><div class="activity-head"><strong>${html(view.title)}</strong><span>${html(meta)}</span>${view.destination ? `<span>To ${html(view.destination)}</span>` : ""}</div>${view.note ? `<p class="activity-note">${html(view.note)}</p>` : ""}${view.trackingError ? `<p class="activity-note">${html(view.trackingError)}</p>` : ""}${steps}${action}${links}</li>`;
}

/** Wallet errors in plain words, naming the wallet that raised them. */
export function friendlyWalletError(error, wallet = "dusk") {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code];
  const name = wallet === "evm" ? "EVM wallet" : "Dusk wallet";
  if (codes.includes(4001) || error?.name === "UserRejectedRequestError")
    return "The wallet request was cancelled.";
  if (codes.includes(4100) || /wallet (?:is )?locked/iu.test(error?.message ?? ""))
    return `The ${name} is locked. Unlock it, reconnect, and try again.`;
  if (codes.includes(4900))
    return `The ${name} disconnected. Reconnect it and try again.`;
  return error?.shortMessage ?? (error instanceof Error ? error.message : String(error));
}
