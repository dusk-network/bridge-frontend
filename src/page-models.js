// What each page shows, from the app's state: pure, so the pages can be
// checked without a browser. The controller fetches and stores; views.js
// writes the HTML.

import { transferLedger } from "@dusk-network/app-core/bridge";
import { claimAfterProving, proveNowText } from "@dusk-network/networks/duskevm";
import { formatEvmAddress } from "@dusk-network/networks/format";

import { explorerAddressUrl } from "./contracts.js";
import { groupTransfers, shownFor } from "./discovery.js";
import { aboutFee, formatDateTime, formatDusk, formatLux, formatMaxFee, formatShort, formatUnitsGrouped } from "./format.js";
import { gasCoin, networkName, routeTitle, routeUnits, tokenName } from "./names.js";
import { transferHref } from "./permalink.js";
import { buildQuote, routeDuskFees, stepFeeText, withdrawalStepMax } from "./quote.js";
import { routeTime, routeTimeText } from "./route-times.js";
import { explorerTxUrl, html, short, transferSubline, transferView } from "./transfer-view.js";
import { copyButton } from "./views.js";
import { revokeLines } from "./wallet-lines.js";

export const DUSK_WALLET_URL = "https://docs.dusk.network/use/wallets/#dusk-wallet";

const WEI_PER_LUX = 1_000_000_000n;

/** The wallet a page names: "MetaMask", or a plain description. */
export const evmWalletName = (evm) => evm?.walletName || "your EVM wallet";

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

/**
 * A route in one line, time then cost: the card's route row and its network
 * list. The time is this network's (`routeTime`), left out where it isn't
 * known; the fee comes from the same calculation as the quote and the review.
 * A migration takes the wallet steps its quote counts (`steps`): one where an
 * earlier approval covers the amount.
 */
export function routeLine(route, cfg, { gasPrice = 1n, steps = 2, timing } = {}) {
  const cost =
    route.mode === "duskevm-deposit"
      ? [`fee up to ${formatMaxFee(routeDuskFees(route, { gasPrice }).send.maxLux)} DUSK`]
      : route.mode === "duskevm-withdrawal"
        ? ["three steps", `${stepFeeText({ gasPrice })} on Dusk`]
        : route.mode === "service-transfer"
          ? [`${formatDusk(cfg.service.feeLux)} bridge fee`]
          : [steps === 1 ? "one wallet step" : "two wallet steps", `fee in ${gasCoin(cfg, route.from.id)}`];
  const line = [routeTimeText(routeTime(route, cfg, timing)), ...cost].filter(Boolean).join(" · ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

// ---------------------------------------------------------------------------
// An approval not used up, on the way back
// ---------------------------------------------------------------------------

/** Past what any token holds: an approval with no limit, as wallets give one. */
export const NO_LIMIT = 2n ** 255n;

/** What an approval lets the migration contract take, as a page says it: "0.03 BEP20 DUSK", or less than a Lux. */
const approved = (wei, unit) => (wei < WEI_PER_LUX ? `less than ${formatLux(1n)} ${unit}` : `${formatLux(wei / WEI_PER_LUX)} ${unit}`);

/**
 * What the Dusk migration contract may still take from the EVM wallet, as the
 * chain says (`allowanceWei`), above the way back's form: null with nothing
 * approved, or before it's read. Finish goes to the review of what it still
 * lets go of what the wallet holds (`finishLux`), none on a route that isn't
 * running; Revoke takes it back.
 */
export function openApproval(route, { allowanceWei, balanceWei, evm, paused = false }) {
  if (route.mode !== "migration" || !evm || allowanceWei === null || allowanceWei === undefined || allowanceWei <= 0n) return null;
  const unit = tokenName(route.from.id);
  const lets = allowanceWei / WEI_PER_LUX;
  const held = balanceWei === null || balanceWei === undefined ? 0n : balanceWei / WEI_PER_LUX;
  return {
    evm,
    finishLux: paused ? 0n : lets < held ? lets : held,
    text: allowanceWei >= NO_LIMIT ? `any amount of ${unit}` : approved(allowanceWei, unit),
  };
}

/**
 * On a review whose approval step replaces an approval not used up: what it
 * replaces, as a sentence. "" with none.
 */
export function replacedLine(allowanceWei, unit) {
  return allowanceWei > 0n ? `It replaces the earlier approval of ${approved(allowanceWei, unit)}.` : "";
}

/**
 * On a review that skips Approve: which approval covers the amount, and what
 * of it stays approved once the amount went. HTML, its values in bold.
 */
function coveredLine(allowanceWei, amountLux, unit) {
  if (allowanceWei >= NO_LIMIT) return "An earlier approval with no limit covers this, so you aren't asked to approve. It stays approved after it.";
  const left = allowanceWei - amountLux * WEI_PER_LUX;
  const stays = left > 0n ? approved(left, unit) : "";
  return `An earlier approval of <b class="num">${html(approved(allowanceWei, unit))}</b> covers this, so you aren't asked to approve. ${
    stays ? `<b class="num">${html(stays.charAt(0).toUpperCase() + stays.slice(1))}</b> stays approved after it.` : "None of it stays approved after it."
  }`;
}

/**
 * A revoke's review: what's approved now, the gas for an approval of 0
 * (`feeWei`, once estimated), and the one step its wallet shows.
 */
export function revokeReview(route, { cfg, evm, feeWei = null, reads, walletName }) {
  const network = route.from.id;
  const from = networkName(cfg, network);
  const coin = gasCoin(cfg, network);
  const unit = tokenName(network);
  const migration = reads.migration ?? {};
  const allowance = migration.allowanceWei ?? 0n;
  const who = short(evm?.account);
  const checks =
    migration.gasCoinWei === null || migration.gasCoinWei === undefined
      ? []
      : [
          {
            html: `You have <b class="num">${html(formatShort(migration.gasCoinWei, 18).text)} ${html(coin)}</b> for the network fee${feeWei ? `, ${html(aboutFee(feeWei, 18, coin))} needed for the step` : ""}`,
            ok: feeWei ? migration.gasCoinWei >= feeWei : migration.gasCoinWei > 0n,
          },
        ];
  return {
    checks,
    feeRows: [{ detail: "one wallet step", key: "fee", label: "Network fee", value: feeWei ? aboutFee(feeWei, 18, coin) : `paid in ${coin}` }],
    lead: {
      amount: allowance >= NO_LIMIT ? "No limit" : allowance < WEI_PER_LUX ? `less than ${formatLux(1n)}` : formatLux(allowance / WEI_PER_LUX),
      chain: network,
      label: "Approved now",
      line: `${from} · ${who} · No DUSK moves`,
      unit: allowance >= NO_LIMIT ? "" : unit,
    },
    privacy: `Public on ${from}: ${who} and that it revokes its approval.`,
    steps: [
      {
        confirmLabel: `Revoke in ${walletName}`,
        lines: revokeLines({ cfg, fee: feeWei, network }),
        title: "Revoke the approval",
        walletName,
        what: `Sets what the Dusk migration contract may take from <code class="mono">${html(who)}</code> to 0.`,
      },
    ],
    sub: `${unit} on ${from} · nothing moves`,
  };
}

/** Who does what, in one line: the route's steps and the wallets they take. */
export function routeSteps(route, quote = null) {
  if (route.mode === "duskevm-withdrawal") return "Send on DuskEVM, then prove and claim on Dusk";
  if (route.mode === "migration") return quote?.steps === 1 ? "One, in your EVM wallet" : "Approve, then migrate, in your EVM wallet";
  return "One, in Dusk Wallet";
}

// ---------------------------------------------------------------------------
// The review's checked facts
// ---------------------------------------------------------------------------

/**
 * Facts the review checks before any wallet opens, each true or not:
 * balances, to the Lux as what it sends is, gas, and where the payout goes.
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
        html: `You have <b class="num">${html(formatDusk(balance))}</b> in your public balance, enough for ${html(formatDusk(lux))} and the network fee`,
        ok: quote.maxLux !== null && lux <= quote.maxLux,
      });
    checks.push({
      html:
        route.mode === "service-transfer"
          ? `The payout goes to <code class="mono">${html(short(destination))}</code> on ${html(to)}, written in the memo`
          : `It goes to <code class="mono">${html(short(destination))}</code> on ${html(to)}${evm?.account && destination?.toLowerCase() === evm.account.toLowerCase() ? `, your ${html(evmWalletName(evm))}` : ""}`,
      ok: true,
    });
    return checks;
  }
  if (route.mode === "migration") {
    const coin = gasCoin(cfg, route.from.id);
    const migration = reads.migration ?? {};
    if (migration.balanceWei !== null && migration.balanceWei !== undefined)
      checks.push({
        html: `You have <b class="num">${html(formatUnitsGrouped(migration.balanceWei, 18, 9))} ${html(tokenName(route.from.id))}</b> at <code class="mono">${html(short(evm?.account))}</code> on ${html(from)}`,
        ok: lux * WEI_PER_LUX <= migration.balanceWei,
      });
    if (migration.gasCoinWei !== null && migration.gasCoinWei !== undefined)
      checks.push({
        html: `You have <b class="num">${html(formatShort(migration.gasCoinWei, 18).text)} ${html(coin)}</b> for the network fee${quote.evmFeeWei ? `, ${html(aboutFee(quote.evmFeeWei, 18, coin))} needed for ${quote.steps === 2 ? "both steps" : "the step"}` : ""}`,
        ok: quote.evmFeeWei ? migration.gasCoinWei >= quote.evmFeeWei : migration.gasCoinWei > 0n,
      });
    // Approve is skipped: which approval covers the amount, read on the chain.
    const allowance = migration.allowanceWei ?? 0n;
    if (lux > 0n && allowance >= lux * WEI_PER_LUX) checks.push({ html: coveredLine(allowance, lux, tokenName(route.from.id)), ok: true });
    checks.push({
      html: `The payout goes to Dusk account <code class="mono">${html(short(destination))}</code>${duskAccount && destination === duskAccount ? ", your connected account" : ""}`,
      ok: true,
    });
    return checks;
  }
  const l2 = reads.l2 ?? {};
  if (l2.balanceWei !== null && l2.balanceWei !== undefined)
    checks.push({
      html: `You have <b class="num">${html(formatUnitsGrouped(l2.balanceWei, 18, 9))} DUSK</b> on ${html(from)}, enough for ${html(formatDusk(lux))} and its network fee`,
      ok: quote.maxLux !== null && lux <= quote.maxLux,
    });
  checks.push({
    html: `It pays Dusk account <code class="mono">${html(short(destination))}</code>${duskAccount && destination === duskAccount ? ", your connected account" : ""}`,
    ok: true,
  });
  return checks;
}

/**
 * The line under To that says who's paid: the recipient by its .dusk name
 * or short form, "to your account …" when it's the connected one, "Paying …"
 * for a Dusk recipient a link handed over (`handedOver`), saying so when
 * Dusk Wallet is `connected` with another account, or what's missing. HTML,
 * its values escaped.
 */
export function recipientLine(route, { connected = false, destination = "", duskName = "", handedOver = false, own = false, resolved = null, walletName = "your EVM wallet" } = {}) {
  const dusk = route.to.kind === "dusk";
  if (!destination) return dusk ? "Connect Dusk Wallet, or add a Dusk account" : "Connect an EVM wallet, or add a 0x address";
  if (handedOver && dusk) return `Paying <b class="mono">${html(short(destination))}</b>${connected && !own ? ", not your connected account" : ""}`;
  const who = resolved
    ? `<b>${html(resolved.name)}</b> (${html(short(destination))})`
    : own && dusk && duskName
      ? `<b>${html(duskName)}</b>`
      : `<b class="mono">${html(short(destination))}</b>`;
  const yours = dusk ? "your account" : walletName.startsWith("your ") ? walletName : `your ${walletName}`;
  return own ? `to ${yours} ${who}` : `to ${who}`;
}

/** A late transfer's note: that it is, and who to ask where the deployment names one. */
export function lateLine(cfg) {
  const ask = cfg.links?.support
    ? ` Contact <a href="${html(cfg.links.support)}" target="_blank" rel="noreferrer">${html(cfg.links.supportLabel || "support")}</a> with the receipt link.`
    : "";
  return `<b>Taking longer than usual.</b>${ask}`;
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function addressHtml(cfg, network, address, label) {
  if (!address) return "";
  // An EVM address with its checksum's capitals, as every app writes it.
  const value = /^0x[0-9a-f]{40}$/iu.test(address) ? formatEvmAddress(address) : address;
  const explorer = explorerAddressUrl(cfg, network, value);
  return `<span class="fullval"><code class="mono">${html(value)}</code><span class="full-actions">${copyButton(value, label)}${explorer ? `<a class="icon-btn" href="${html(explorer)}" target="_blank" rel="noreferrer" aria-label="${html(label)} in the explorer (opens in a new tab)">${extIcon}</a>` : ""}</span></span>`;
}

const extIcon =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 6h10v10"/><path d="M18 6 6 18"/></svg>';

/**
 * A Dusk review's fee rows and checks at the price its request was built
 * with: the node's price can have risen since the form read it, for a
 * higher fee or a balance that no longer covers it.
 */
export function pricedReview(route, { amount, cfg, destination, duskAccount, evm, gasPrice, reads, timing }) {
  const quote = buildQuote(route, amount, { balance: reads.duskBalance, cfg, gasPrice, timing });
  return {
    checks: reviewChecks(route, { cfg, destination, duskAccount, evm, quote, reads }),
    feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
  };
}

/**
 * What the source of `route` holds, as the form's balance line writes it, and
 * in full for whoever asks: Lux on Dusk, wei on an EVM chain. Empty until it's read.
 */
export function balanceLine(route, holdings) {
  if (holdings === null || holdings === undefined) return { exact: "", text: "" };
  const { exact, text } = formatShort(holdings, route.signer === "dusk" ? 9 : 18);
  const { send: unit } = routeUnits(route);
  return { exact: `${exact} ${unit}`, text: `${text} ${unit}` };
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
    available: migration ? `${formatLux(maxLux, 4)} ${tokenName(route.from.id)}` : formatDusk(maxLux, 4),
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
  return `${base} So is your Dusk account${who ? ` ${who}` : ""}, as the one that ${kind === "prove" ? "proves" : "claims"} it.`;
}

/**
 * The top of a proof's or a claim's review: what the step costs at most
 * (`maxLux`) and what moves. A proof moves no DUSK; a claim pays the
 * withdrawal's account. When that isn't Dusk Wallet's `account`, it says so,
 * by its .dusk `name` where there is one. A proof says when it can be
 * claimed: from `claim`, the date for a proof made now, once the request is
 * ready (`when` writes it); until then from `maturity`, the Portal's wait in
 * seconds, where it's known.
 */
export function actionLead(kind, entry, { account = "", amountLux = null, claim = null, maturity = null, maxLux, name = "", when = (ms) => formatDateTime(ms) }) {
  const cost = formatMaxFee(maxLux);
  const pays = entry.destination ?? "";
  const payee = !pays ? "the withdrawal's Dusk account" : /^[0-9a-f]{64}$/u.test(pays) ? `the Dusk contract ${short(pays)}` : short(pays);
  // Said before the steps: the DUSK goes to another account than Dusk Wallet's.
  const notYours =
    account && pays && pays !== account ? `This withdrawal pays ${payee}, not ${name || "your connected Dusk account"}.` : "";
  return kind === "prove"
    ? {
        amount: cost,
        label: "Proving costs up to",
        line: `No DUSK moves now.${claim?.at ? ` ${proveNowText(claim, when)}.` : maturity ? ` ${claimAfterProving(maturity)}` : ""}`,
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

/**
 * Whether a failed transfer failed on its own chain, so that nothing moved. One
 * the bridge didn't pay out left the account all the same. Records kept before
 * this was noted say so in their note.
 */
const failedAtSource = (entry) =>
  entry.sourceFailed === true || /^The (transfer failed on|migration failed on|Dusk transaction failed)/u.test(entry.note ?? "");

const known = (value) => value !== undefined && value !== null;

/**
 * Which transactions a migration's gas counts: the approval it spent with it,
 * or the migration alone, saying so where that approval can't be read (logs
 * that old no longer given, none found, or its receipt unread).
 */
function gasCounts(gas, evm) {
  if (gas?.parts?.includes("approval")) return "approval and migration";
  const unread = ["beyond", "unread"].includes(evm?.approvalState) || (evm?.approvalState === "found" && !known(evm.approval?.gasWei));
  return unread ? "migration; its approval can't be read" : "migration";
}

/**
 * A transfer's amounts on its receipt, the same in every Dusk app
 * (`transferLedger`): what was sent, the bridge's fee, the network's, what was
 * received, each to the Lux, and gas as wallets write it, with the rest on
 * hover. What failed on its own chain moved nothing, so its fee stands alone.
 * A migration's gas is what its chain says it and the approval it spent paid
 * (`evm`, from `migrationFacts`), whichever app signed that approval.
 */
function ledgerRows(entry, { cfg, evm = null, from, locale, route, status }) {
  const migration = route.mode === "migration";
  // Cancelled or replaced in the wallet, the migration was never mined: what
  // it cost is the approval this browser sent for it.
  const cancelled = migration && Boolean(entry.replaced) && known(entry.approvalFeeWei);
  const ledger = transferLedger({
    evm: migration && !entry.replaced ? evm : null,
    failed: status === "failed" && failedAtSource(entry),
    gasWei: cancelled ? BigInt(entry.approvalFeeWei) : undefined,
    locale,
    network: cfg.network,
    networkFee: [entry.feeLux, entry.proveFeeLux, entry.claimFeeLux],
    received: entry.receivedLux,
    route: route.id,
    sent: entry.amountLux,
  });
  if (!ledger) return [];
  const label = (line) =>
    ({
      bridgeFee: "Bridge fee",
      gas: ledger.networkFee ? `Fee on ${from}` : "Network fee",
      networkFee: "Network fee",
      received: line.expected && status !== "completed" ? "You receive" : "You received",
      sent: "You sent",
    })[line.key];
  // Which transactions a migration's fee counts.
  const counts = !migration ? "" : cancelled ? "approval" : gasCounts(ledger.gas, evm);
  return ledger.lines.map((line) =>
    line.key === "gas"
      ? { detail: counts, exact: `${line.exact} ${line.coin}`, label: label(line), value: `${line.text} ${line.coin}` }
      : { label: label(line), value: `${line.exact} ${line.coin}` },
  );
}

/**
 * The receipt of one transfer. No balances: the link may be shared. `owner`
 * is the Dusk account the page is for, Dusk Wallet's (`own`) or a followed one.
 * `evm` is what a migration did on its own chain, as `migrationFacts` read it.
 */
export function receiptModel(entry, { cfg, evm = null, gasPrice = 1n, locale, now = Date.now(), own = null, owner = own?.account ?? "", route, submitter = null, timeZone, timing, url }) {
  const view = transferView(entry, { account: own?.account ?? "", cfg, locale, name: own?.name ?? "", now, owner, route, submitter, timeZone, timing, year: true });
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  // Your own Dusk account by its .dusk name, others by their short code.
  const named = (account) =>
    own?.name && account === own.account ? html(own.name) : `<code class="mono">${html(short(account))}</code>`;
  const fromAccount = entry.sender ? `${named(entry.sender)} on ${html(from)}` : `${html(from)}`;
  const toAccount = entry.destination ? `${named(entry.destination)} on ${html(to)}` : html(to);
  const time = (ms) => (ms ? formatDateTime(ms, { locale, now, timeZone, year: true }) : "");
  let caption = "";
  if (view.status === "completed") {
    const at = entry.destinationAt ?? entry.claimAt;
    caption = at ? `Arrived ${time(at)}.` : "Completed.";
    if (route.mode === "migration") caption += " It's in the public balance on Dusk.";
  } else if (view.status === "failed") caption = view.note;
  else if (view.time) caption = `Takes ${routeTimeText(view.time)}`;

  const sourceNetwork = route.from.kind === "dusk" ? "dusk" : route.from.id;
  const destinationNetwork = route.to.kind === "dusk" ? "dusk" : route.to.id;
  const details = ledgerRows(entry, { cfg, evm, from, locale, route, status: view.status });
  if (entry.sender) details.push({ html: addressHtml(cfg, sourceNetwork, entry.sender, `sender on ${from}`), label: `From, on ${from}` });
  if (entry.destination) details.push({ html: addressHtml(cfg, destinationNetwork, entry.destination, `recipient on ${to}`), label: `To, on ${to}` });
  // The approval the migration spent, as its chain says, or the one this browser sent for it.
  const approval = route.mode !== "migration" ? null : evm?.approvalState === "found" && evm.approval?.hash ? evm.approval.hash : entry.approvalHash;
  if (approval) details.push({ html: txHtml(cfg, sourceNetwork, approval, `${from} approval`), label: `${from} approval` });
  details.push({ html: txHtml(cfg, sourceNetwork, entry.hash, `${from} transaction`), label: `${from} transaction` });
  if (route.mode === "duskevm-withdrawal") {
    const pendingProof = entry.pendingAction === "prove" ? entry.pendingHash : null;
    const pendingClaim = entry.pendingAction === "finalize" ? entry.pendingHash : null;
    const proof = entry.proveHash ?? pendingProof;
    const proven = ["proven_waiting", "ready_to_finalize", "finalize_submitted", "finalized"].includes(entry.stage);
    details.push({
      html: proof
        ? txHtml(cfg, "dusk", proof, "proof transaction")
        : `<span class="t2">${proven ? "Proved" : entry.provenByOther ? "Only by another account" : "Not proved yet"}</span>`,
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

  const notes = [];
  if (view.late) notes.push({ html: lateLine(cfg) });
  if (view.trackingError) notes.push({ html: html(view.trackingError) });

  const stepMax = withdrawalStepMax({ gasPrice, withdrawalGas: entry.withdrawalGas ? BigInt(entry.withdrawalGas) : 0n });
  // The countdown says when a claim can be made: its step doesn't say it again.
  if (view.countdown) view.steps = view.steps.map((item) => (item.key === "claim" ? { ...item, detail: "" } : item));
  return {
    actionFee: view.action ? `Network fee up to ${formatMaxFee(stepMax)} DUSK, from your public balance` : "",
    // It comes by itself, so there's something to be told of. A withdrawal comes when you claim it.
    arrives: view.status === "pending" && route.mode !== "duskevm-withdrawal",
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
  return `<span class="fullval"><code class="mono">${html(hash)}</code><span class="full-actions">${copyButton(hash, `the ${label} hash`)}${href ? `<a class="icon-btn" href="${html(href)}" target="_blank" rel="noreferrer" aria-label="The ${html(label)} in the explorer (opens in a new tab)">${extIcon}</a>` : ""}</span></span>`;
}

// ---------------------------------------------------------------------------
// My transfers
// ---------------------------------------------------------------------------

/**
 * My transfers, in groups. `owner` is the Dusk account the list is for: Dusk
 * Wallet's (`account`), or a followed one. A withdrawal that pays another
 * account waits apart from what needs the user.
 */
export function transfersModel(entries, { account = "", accounts, cfg, locale, name = "", now = Date.now(), owner = account, routeOf, submitter = null, timeZone, timing }) {
  const shown = entries.filter((entry) => routeOf(entry.routeId) && shownFor(entry, accounts));
  const groups = groupTransfers(shown, routeOf, owner);
  const row = (entry) => {
    const route = routeOf(entry.routeId);
    const view = transferView(entry, { account, cfg, locale, name, now, owner, route, submitter, timeZone, timing });
    return {
      action: view.action,
      amountExact: view.amountExact,
      amountText: view.amountText,
      // Its transaction, as the receipt and Look up know it.
      hash: short(entry.hash),
      href: transferHref(entry.hash),
      id: entry.id,
      pair: view.pair,
      status: view.status,
      statusWord: view.statusWord,
      subline: transferSubline(view, entry, route, cfg, { account, locale, name, now, timeZone }),
      title: routeTitle(cfg, route),
      // Whom it pays: your account by its .dusk name, any other by its short form.
      to: !entry.destination ? null : entry.destination === account && name ? { name } : { address: short(entry.destination) },
      tracker: view.tracker,
    };
  };
  return {
    count: shown.length,
    groups: Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map(row)])),
    needs: groups.needs.length,
  };
}
