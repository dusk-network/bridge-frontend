// What each page shows, from the app's state: pure, so the pages can be
// checked without a browser. The controller fetches and stores; views.js
// writes the HTML.

import { explorerAddressUrl } from "./contracts.js";
import { groupTransfers, shownFor } from "./discovery.js";
import { aboutFee, formatDateTime, formatDusk, formatFee, formatLux, formatMaxFee, formatUnitsGrouped } from "./format.js";
import { gasCoin, networkName, networkNames, routeTitle } from "./names.js";
import { transferHref } from "./permalink.js";
import { arrivalText, buildQuote, routeDuskFees } from "./quote.js";
import {
  custodyLine,
  explorerTxUrl,
  html,
  lateAfterSeconds,
  privacyLine,
  short,
  transferSubline,
  transferView,
} from "./transfer-view.js";
import { roughDuration, WITHDRAWAL_REPORT_SECONDS, WITHDRAWAL_WAITING_PERIOD_SECONDS } from "./withdrawal-lifecycle.js";

export const DUSK_WALLET_URL = "https://docs.dusk.network/use/wallets/#dusk-wallet";

const WEI_PER_LUX = 1_000_000_000n;

/** The wallet a page names: "MetaMask", or a plain description. */
export const evmWalletName = (evm) => evm?.walletName || "your EVM wallet";

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

/** The start page's task rows, with time and cost, and on phones whether they work there. */
export function landingTasks(cfg, tasks, { duskInstalled = false, gasPrice = 1n, phone = false } = {}) {
  const names = networkNames(cfg);
  const fees = (mode) => routeDuskFees({ mode }, { gasPrice });
  const phoneLimited = phone && !duskInstalled;
  const rows = tasks.map((task) => {
    const route = task.routes[0];
    let meta;
    let phoneTag = null;
    if (task.id === "migrate") {
      const coins = [...new Set(task.routes.map((item) => gasCoin(cfg, item.from.id)))].join(" or ");
      meta = `About ${roughDuration(cfg.migrationDelaySeconds ?? 3_600)} · two wallet steps · a network fee in ${coins}`;
      phoneTag = { ok: true, text: "Works on this phone" };
    } else if (route.mode === "duskevm-deposit") {
      meta = `Usually arrives within a minute · network fee up to ${formatMaxFee(fees("duskevm-deposit").send.maxLux)} DUSK`;
      phoneTag = { ok: false, text: "Needs a computer" };
    } else if (route.mode === "duskevm-withdrawal") {
      meta = `Three steps over about ${roughDuration(WITHDRAWAL_REPORT_SECONDS + WITHDRAWAL_WAITING_PERIOD_SECONDS)} · up to ${formatMaxFee(fees("duskevm-withdrawal").claim.maxLux)} DUSK per step on Dusk`;
      phoneTag = { ok: true, text: "Step 1 works here. Prove and claim need a computer." };
    } else {
      meta = `Usually within ${roughDuration(cfg.service?.delaySeconds ?? 3_600)} · ${formatDusk(cfg.service.feeLux)} bridge fee, taken from the amount`;
      phoneTag = { ok: false, text: "Needs a computer" };
    }
    return {
      id: task.id,
      meta,
      pair: [route.from.id, route.to.id],
      phoneTag: phoneLimited ? phoneTag : null,
      title: task.title,
      what: task.what,
    };
  });
  if (!cfg.duskEvm.enabled)
    rows.splice(Math.min(1, rows.length), 0, {
      id: "to-duskevm",
      pair: ["dusk", "dusk-evm"],
      title: `Move DUSK to ${names["dusk-evm"]}`,
      unavailable: `${names["dusk-evm"]} · not on ${names.badge} yet`,
    });
  return rows;
}

// ---------------------------------------------------------------------------
// The review's checked facts
// ---------------------------------------------------------------------------

/**
 * Facts the review checks before any wallet opens, each true or not:
 * balances, gas, where the payout goes, and when it arrives.
 */
export function reviewChecks(route, { cfg, destination, duskAccount, evm, quote, reads }) {
  const checks = [];
  const to = networkName(cfg, route.to.id);
  const from = networkName(cfg, route.from.id);
  const lux = quote.amountLux ?? 0n;
  if (route.mode === "duskevm-deposit" || route.mode === "service-transfer") {
    const balance = reads.duskBalance;
    if (balance !== null && balance !== undefined)
      checks.push({
        html: `You have <b class="num">${html(formatDusk(balance, 4))}</b> in your public balance, enough for ${html(formatDusk(lux))} and the network fee`,
        ok: quote.maxLux !== null && lux <= quote.maxLux,
      });
    checks.push({
      html:
        route.mode === "service-transfer"
          ? `The payout goes to <code class="mono">${html(short(destination))}</code> on ${html(to)}, written in the memo`
          : `It goes to <code class="mono">${html(short(destination))}</code> on ${html(to)}${evm?.account && destination?.toLowerCase() === evm.account.toLowerCase() ? `, your ${html(evmWalletName(evm))}` : ""}`,
      ok: true,
    });
    if (route.mode === "service-transfer")
      checks.push({ html: `You receive <b class="num">${html(formatDusk(quote.receiveLux ?? 0n))}</b> after the ${html(formatDusk(cfg.service.feeLux))} bridge fee`, ok: true });
    checks.push({ html: `Arrives on ${html(to)} ${html(arrivalText(route, cfg))}`, ok: true });
    return checks;
  }
  if (route.mode === "migration") {
    const coin = gasCoin(cfg, route.from.id);
    const migration = reads.migration ?? {};
    if (migration.balanceWei !== null && migration.balanceWei !== undefined)
      checks.push({
        html: `You have <b class="num">${html(formatUnitsGrouped(migration.balanceWei, 18, 4))} old DUSK</b> at <code class="mono">${html(short(evm?.account))}</code> on ${html(from)}`,
        ok: lux * WEI_PER_LUX <= migration.balanceWei,
      });
    if (migration.gasCoinWei !== null && migration.gasCoinWei !== undefined)
      checks.push({
        html: `You have <b class="num">${html(formatUnitsGrouped(migration.gasCoinWei, 18, 4))} ${html(coin)}</b> for the network fee${quote.evmFeeWei ? `, ${html(aboutFee(quote.evmFeeWei, 18, coin))} needed for ${quote.steps === 2 ? "both steps" : "the step"}` : ""}`,
        ok: quote.evmFeeWei ? migration.gasCoinWei >= quote.evmFeeWei : migration.gasCoinWei > 0n,
      });
    checks.push({
      html: `The payout goes to Dusk account <code class="mono">${html(short(destination))}</code>${duskAccount && destination === duskAccount ? ", your connected account" : ""}. No bridge fee.`,
      ok: true,
    });
    checks.push({ html: `Arrives on Dusk ${html(arrivalText(route, cfg))}`, ok: true });
    return checks;
  }
  const l2 = reads.l2 ?? {};
  if (l2.balanceWei !== null && l2.balanceWei !== undefined)
    checks.push({
      html: `You have <b class="num">${html(formatUnitsGrouped(l2.balanceWei, 18, 4))} DUSK</b> on ${html(from)}, enough for ${html(formatDusk(lux))} and its network fee`,
      ok: quote.maxLux !== null && lux <= quote.maxLux,
    });
  checks.push({
    html: `It pays Dusk account <code class="mono">${html(short(destination))}</code>${duskAccount && destination === duskAccount ? ", your connected account" : ""}`,
    ok: true,
  });
  checks.push({
    html: `Then two steps on Dusk with Dusk Wallet: prove after about ${html(roughDuration(WITHDRAWAL_REPORT_SECONDS))}, claim about ${html(roughDuration(WITHDRAWAL_WAITING_PERIOD_SECONDS))} later`,
    ok: true,
  });
  return checks;
}

/** What to do when a transfer is late: when it's late, and who to ask. */
export function lateLine(route, cfg) {
  const after = roughDuration(lateAfterSeconds(route, cfg));
  const usual =
    route.mode === "duskevm-withdrawal"
      ? `DuskEVM usually reports a withdrawal to Dusk within ${roughDuration(WITHDRAWAL_REPORT_SECONDS)}`
      : `${arrivalText(route, cfg).replace(/^usually/u, "Usually")}`;
  const ask = cfg.links?.support
    ? `Contact <a href="${html(cfg.links.support)}" target="_blank" rel="noreferrer">${html(cfg.links.supportLabel || "support")}</a> with the receipt link.`
    : "Keep the receipt link: it shows where the transfer is on both networks.";
  return `${html(usual)}. Not there after ${html(after)}? ${ask}`;
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function addressHtml(cfg, network, value, label) {
  if (!value) return "";
  const explorer = explorerAddressUrl(cfg, network, value);
  return `<span class="fullval"><code class="mono">${html(value)}</code><span class="full-actions"><button type="button" class="icon-btn" data-copy="${html(value)}" aria-label="Copy ${html(label)}">${copyIcon}</button>${explorer ? `<a class="icon-btn" href="${html(explorer)}" target="_blank" rel="noreferrer" aria-label="${html(label)} in the explorer (opens in a new tab)">${extIcon}</a>` : ""}</span></span>`;
}

const copyIcon =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M9 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3"/></svg>';
const extIcon =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 6h10v10"/><path d="M18 6 6 18"/></svg>';

/**
 * A Dusk review's fee rows and checks at the price its request was built
 * with: the node's price can have risen since the form read it, for a
 * higher fee or a balance that no longer covers it.
 */
export function pricedReview(route, { amount, cfg, destination, duskAccount, evm, gasPrice, reads }) {
  const quote = buildQuote(route, amount, { balance: reads.duskBalance, cfg, gasPrice });
  return {
    checks: reviewChecks(route, { cfg, destination, duskAccount, evm, quote, reads }),
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
  };
}

/**
 * What the form offers to send, in the one number format of the form: up to
 * 4 decimals, trimmed, as the balance above it. Max leaves the network fee
 * where it comes from the same balance.
 */
export function availableLine(route, maxLux) {
  if (maxLux === null || maxLux === undefined) return { available: "", availableLabel: "", canMax: false };
  const migration = route.mode === "migration";
  return {
    available: migration ? `${formatLux(maxLux, 4)} old DUSK` : formatDusk(maxLux, 4),
    availableLabel: migration ? "Available" : "Available after fees",
    canMax: maxLux > 0n,
  };
}

/**
 * What a proof or a claim adds to what's public: the Dusk account that sends
 * it, by its .dusk name where Dusk Wallet sent one, is linked to the
 * withdrawal for good.
 */
export function actionPrivacy(kind, base, { account = "", name = "" } = {}) {
  const who = name || (account ? short(account) : "");
  return `${base} Your Dusk account${who ? ` ${who}` : ""} will be visible too, as the account that ${kind === "prove" ? "proved" : "claimed"} it.`;
}

/**
 * The top of a proof's or a claim's review: what the step costs at most
 * (`maxLux`) and what moves. A proof moves no DUSK; a claim pays the
 * withdrawal's account. When that isn't Dusk Wallet's `account`, it says so,
 * by its .dusk `name` where there is one.
 */
export function actionLead(kind, entry, { account = "", amountLux = null, maxLux, name = "" }) {
  const moving = amountLux === null ? "The DUSK" : `The ${formatLux(amountLux)} DUSK`;
  const cost = formatMaxFee(maxLux);
  const pays = entry.destination ?? "";
  const payee = !pays ? "the withdrawal's Dusk account" : /^[0-9a-f]{64}$/u.test(pays) ? `the Dusk contract ${short(pays)}` : short(pays);
  // Said before the steps: the step doesn't change where the DUSK goes.
  const notYours =
    account && pays && pays !== account
      ? `This withdrawal pays ${payee}, not ${name ? `your ${name}` : "your connected Dusk account"}. ${kind === "prove" ? "Proving it doesn't change that." : "The claim sends the DUSK there."}`
      : "";
  return kind === "prove"
    ? {
        amount: cost,
        label: "Proving costs up to",
        line: `No DUSK moves now. ${moving} stays in the DuskEVM bridge until it's claimed, about 7 days after the proof.`,
        notYours,
      }
    : {
        amount: amountLux === null ? "" : formatLux(amountLux),
        chain: "dusk",
        label: "You claim",
        line: `To ${payee} on Dusk · costs up to ${cost} DUSK`,
        notYours,
      };
}

/** The receipt of one transfer. No balances: the link may be shared. */
export function receiptModel(entry, { cfg, gasPrice = 1n, now = Date.now(), own = null, route, submitter = null, timeZone, url }) {
  const view = transferView(entry, { account: own?.account ?? "", cfg, gasPrice, now, route, submitter, timeZone, year: true });
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  // Your own Dusk account by its .dusk name, others by their short code.
  const named = (account) =>
    own?.name && account === own.account ? html(own.name) : `<code class="mono">${html(short(account))}</code>`;
  const fromAccount = entry.sender ? `${named(entry.sender)} on ${html(from)}` : `${html(from)}`;
  const toAccount = entry.destination ? `${named(entry.destination)} on ${html(to)}` : html(to);
  const time = (ms) => (ms ? formatDateTime(ms, { timeZone, year: true }) : "");
  let caption = "";
  if (view.status === "completed") {
    const at = entry.destinationAt ?? entry.claimAt;
    caption = at ? `Arrived ${time(at)}.` : "Completed.";
  } else if (view.status === "failed") caption = view.note;
  else if (route.mode === "duskevm-withdrawal") caption = "Three steps over about 7 days. You can close this page.";
  else caption = `${arrivalText(route, cfg).replace(/^usually/u, "Usually")}. You can close this page.`;

  const sourceNetwork = route.from.kind === "dusk" ? "dusk" : route.from.id;
  const destinationNetwork = route.to.kind === "dusk" ? "dusk" : route.to.id;
  const details = [];
  if (view.amount !== null) details.push({ label: route.mode === "migration" ? "You sent" : "Amount", value: route.mode === "migration" ? `${formatLux(view.amount)} old DUSK` : formatDusk(view.amount) });
  if (route.mode === "service-transfer" && view.amount !== null) {
    details.push({ label: "Bridge fee", value: formatDusk(cfg.service.feeLux) });
    details.push({ label: "You receive", value: formatDusk(view.amount - BigInt(cfg.service.feeLux) > 0n ? view.amount - BigInt(cfg.service.feeLux) : 0n) });
  }
  if (entry.feeLux) details.push({ label: "Network fee paid", value: `${formatFee(BigInt(entry.feeLux))} DUSK on ${from}` });
  if (entry.feeWei) details.push({ label: "Network fee paid", value: `${formatFee(BigInt(entry.feeWei), 18)} ${gasCoin(cfg, route.from.id)} on ${from}` });
  if (entry.proveFeeLux) details.push({ label: "Proof fee paid", value: `${formatFee(BigInt(entry.proveFeeLux))} DUSK on Dusk` });
  if (entry.claimFeeLux) details.push({ label: "Claim fee paid", value: `${formatFee(BigInt(entry.claimFeeLux))} DUSK on Dusk` });
  if (entry.sender) details.push({ html: addressHtml(cfg, sourceNetwork, entry.sender, `sender on ${from}`), label: `From, on ${from}` });
  if (entry.destination) details.push({ html: addressHtml(cfg, destinationNetwork, entry.destination, `recipient on ${to}`), label: `To, on ${to}` });
  details.push({ html: txHtml(cfg, sourceNetwork, entry.hash, `${from} transaction`), label: `${from} transaction` });
  if (route.mode === "duskevm-withdrawal") {
    const pendingProof = entry.pendingAction === "prove" ? entry.pendingHash : null;
    const pendingClaim = entry.pendingAction === "finalize" ? entry.pendingHash : null;
    const proof = entry.proveHash ?? pendingProof;
    const proven = ["proven_waiting", "ready_to_finalize", "finalize_submitted", "finalized"].includes(entry.stage);
    details.push({
      html: proof
        ? txHtml(cfg, "dusk", proof, "proof transaction")
        : `<span class="t2">${proven ? "Proven" : entry.provenByOther ? "Only by another account" : "Not proven yet"}</span>`,
      label: "Proof on Dusk",
    });
    const claim = entry.claimHash ?? pendingClaim;
    details.push({
      // Claimed outside this browser: finalized, without its transaction here.
      html: claim
        ? txHtml(cfg, "dusk", claim, "claim transaction")
        : `<span class="t2">${view.status === "failed" ? "None" : entry.stage === "finalized" ? "Claimed" : "Not claimed yet"}</span>`,
      label: "Claim on Dusk",
    });
  } else
    details.push({
      html: entry.destinationHash ? txHtml(cfg, destinationNetwork, entry.destinationHash, `${to} transaction`) : `<span class="t2">${view.status === "failed" ? "None" : "Shows when it arrives"}</span>`,
      label: `${to} transaction`,
    });
  if (entry.sourceAt) details.push({ label: "Sent", value: time(entry.sourceAt) });

  const notes = [{ html: html(view.custody), icon: "lock" }];
  if (route.mode === "duskevm-withdrawal" && entry.stage === "proven_waiting")
    notes.push({ html: "The 7 days are a safety window in the bridge's design. The countdown is the same on any device." });
  const early = route.mode !== "duskevm-withdrawal" || ["submitted", "waiting_for_output"].includes(entry.stage ?? "submitted");
  if (view.status === "pending" && early) notes.push({ html: view.late ? `<b>${html(view.lateText)}</b> ${lateLine(route, cfg)}` : lateLine(route, cfg) });
  if (view.trackingError) notes.push({ html: html(view.trackingError) });

  const fees =
    route.mode === "duskevm-withdrawal"
      ? routeDuskFees(route, { gasPrice, withdrawalGas: entry.withdrawalGas ? BigInt(entry.withdrawalGas) : 0n })
      : null;
  return {
    actionFee: view.action ? `Network fee up to ${formatMaxFee((view.action.kind === "prove" ? fees.prove : fees.claim).maxLux)} DUSK, from your public balance` : "",
    caption,
    details,
    fromTo: `From ${fromAccount} to ${toAccount}`,
    id: entry.id,
    notes,
    url,
    view,
  };
}

function txHtml(cfg, network, hash, label) {
  const href = explorerTxUrl(cfg, network, hash);
  return `<span class="fullval"><code class="mono">${html(hash)}</code><span class="full-actions"><button type="button" class="icon-btn" data-copy="${html(hash)}" aria-label="Copy the ${html(label)} hash">${copyIcon}</button>${href ? `<a class="icon-btn" href="${html(href)}" target="_blank" rel="noreferrer" aria-label="The ${html(label)} in the explorer (opens in a new tab)">${extIcon}</a>` : ""}</span></span>`;
}

// ---------------------------------------------------------------------------
// My transfers
// ---------------------------------------------------------------------------

export function transfersModel(entries, { account = "", accounts, cfg, gasPrice = 1n, now = Date.now(), routeOf, submitter = null, timeZone }) {
  const shown = entries.filter((entry) => routeOf(entry.routeId) && shownFor(entry, accounts));
  const groups = groupTransfers(shown, routeOf);
  const row = (entry) => {
    const route = routeOf(entry.routeId);
    const view = transferView(entry, { account, cfg, gasPrice, now, route, submitter, timeZone });
    return {
      action: view.action,
      amountText: view.amountText,
      href: transferHref(entry.hash),
      id: entry.id,
      pair: view.pair,
      status: view.status,
      statusWord: view.statusWord,
      subline: transferSubline(view, entry, route, cfg, { account, now, timeZone }),
      title: routeTitle(cfg, route),
      tracker: view.tracker,
    };
  };
  return {
    count: shown.length,
    groups: Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map(row)])),
    needs: groups.needs.length,
  };
}

export { short, custodyLine, privacyLine };
