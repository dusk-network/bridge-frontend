// What each page shows, from the app's state: pure, so the pages can be
// checked without a browser. The controller fetches and stores; views.js
// writes the HTML.

import { transferLedger } from "@dusk-network/app-core/bridge";
import { claimAfterProving, claimText } from "@dusk-network/networks/duskevm";
import { aboutTime, durationWords, formatEvmAddress } from "@dusk-network/networks/format";

import { explorerAddressUrl } from "./contracts.js";
import { groupTransfers, shownFor } from "./discovery.js";
import { aboutFee, formatDateTime, formatDusk, formatLux, formatMaxFee, formatShort, formatToken, formatTokenShort, formatUnitsGrouped } from "./format.js";
import { HYPERLANE_GAS } from "./hyperlane.js";
import { gasCoin, networkName, routeTitle, routeUnits, tokenName } from "./names.js";
import { transferHref } from "./permalink.js";
import { buildQuote, routeDuskFees, withdrawalStepMax } from "./quote.js";
import { routeTime, routeTimeText } from "./route-times.js";
import { explorerTxUrl, failedAtSource, heldForAnother, heldInEscrow, html, short, transferSubline, transferView } from "./transfer-view.js";
import { copyButton } from "./views.js";
import { revokeLines } from "./wallet-lines.js";

export const DUSK_WALLET_URL = "https://docs.dusk.network/use/wallets/#dusk-wallet";

const WEI_PER_LUX = 1_000_000_000n;

/** The wallet a page names: "MetaMask", or a plain description. */
export const evmWalletName = (evm) => evm?.walletName || "your EVM wallet";

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

const capital = (line) => `${line.charAt(0).toUpperCase()}${line.slice(1)}`;

/**
 * A route under the card, time then what it costs: one line, or two for a
 * withdrawal, whose steps on Dusk come days apart. The fees are summed where
 * they're paid in one coin, as the most a Dusk fee can be or as estimated on
 * an EVM chain, from the same quote (`quote`) as the review; a bridge fee
 * taken from the amount says so. The time is this network's (`routeTime`),
 * left out where it isn't known. The split, and the rest, are behind the line.
 */
export function routeLines(route, cfg, { gasPrice = 1n, quote = null, timing } = {}) {
  const time = routeTime(route, cfg, timing);
  if (route.mode === "duskevm-withdrawal") {
    const steps =
      time?.prove && time.wait
        ? `${routeTimeText(time)}: send, prove after ${aboutTime(time.prove)}, claim ${durationWords(time.wait)} later`
        : time?.wait
          ? `Send, prove, then claim ${durationWords(time.wait)} later`
          : "Send, then prove and claim on Dusk";
    const onDusk = `${formatMaxFee(2n * withdrawalStepMax({ gasPrice }))} DUSK on Dusk`;
    const l2 = quote?.evmFeeWei ?? null;
    return [steps, l2 === null ? `Then up to ${onDusk}` : `Network fee ${aboutFee(l2, 18, "DUSK")}, then up to ${onDusk}`];
  }
  const coin = gasCoin(cfg, route.from.id);
  let cost;
  if (route.mode === "hyperlane" && route.signer === "dusk") {
    const fee = quote?.bridgeFeeLux ?? null;
    cost = fee === null ? "fees in DUSK" : `fees up to ${formatMaxFee(fee + (quote.gasMaxLux ?? 0n))} DUSK`;
  } else if (route.mode === "hyperlane") {
    const fee = quote?.bridgeFeeWei ?? null;
    const gas = quote?.evmFeeWei ?? null;
    cost = fee === null || gas === null ? `fees in ${coin}` : `fees ${aboutFee(fee + gas, 18, coin)}`;
  } else if (route.mode === "duskevm-deposit") cost = `fee up to ${formatMaxFee(routeDuskFees(route, { gasPrice }).send.maxLux)} DUSK`;
  else if (route.mode === "service-transfer") cost = `bridge fee ${formatDusk(cfg.service.feeLux)}, from the amount`;
  else cost = quote?.evmFeeWei ? `network fee ${aboutFee(quote.evmFeeWei, 18, coin)}` : `network fee in ${coin}`;
  return [capital([routeTimeText(time), cost].filter(Boolean).join(" · "))];
}

/** Said under the card's route line and on the review, where a bridge fee in the coin sent is more than what's sent. */
export const FEE_OVER_AMOUNT = "Bridge fee is more than the amount";

/**
 * What the card and the review say of a quote's fees beside their rows: that
 * the bridge fee is more than the amount, where it is (`feeOverAmount`).
 * Said, never blocking.
 */
export const feeNotes = (quote) => (quote?.feeOverAmount ? [FEE_OVER_AMOUNT] : []);

/** Said on the card and the review of what's signed on Dusk while what waits there asks more than the gas price pays. */
export const NETWORK_BUSY = "Network busy: this may take longer";

/** The busy line, where the network is busy (`busy`, read with the gas price), for what's signed on Dusk. */
export const busyNotes = (busy) => (busy ? [NETWORK_BUSY] : []);

/**
 * Which step a review's button takes, where it takes more than one: an
 * approval and the transfer after it, "1 of 2" then "2 of 2"; a withdrawal's
 * own three (`review.stepOf`). None while the wallet's asked or the chain's
 * switched (`switching`): those are no step of it.
 */
export function stepOfReview(review, { switching = false } = {}) {
  if (review.busy || switching) return null;
  if (review.stepOf) return review.stepOf;
  return review.steps.length > 1 ? { at: review.current + 1, of: review.steps.length } : null;
}

/**
 * What the card keeps behind its route line, from the quote's rows: the
 * split of the fees it sums, and a withdrawal's claim.
 */
export function routeDetailRows(route, quote) {
  return quote.rows.filter((row) => ["bridge", "fee", "fee-dusk", "total", "when"].includes(row.key));
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
 * replaces. "" with none.
 */
export function replacedLine(allowanceWei, unit) {
  return allowanceWei > 0n ? `Replaces the open approval of ${approved(allowanceWei, unit)}` : "";
}

/**
 * On a review that skips Approve: which approval covers the amount, and what
 * of it stays approved once the amount went. HTML, its values in bold.
 */
function coveredLine(allowanceWei, amountLux, unit) {
  if (allowanceWei >= NO_LIMIT) return "An earlier approval with no limit covers this. It stays approved.";
  const left = allowanceWei - amountLux * WEI_PER_LUX;
  const stays = left > 0n ? approved(left, unit) : "";
  return `An earlier approval of <b class="num">${html(approved(allowanceWei, unit))}</b> covers this. ${
    stays ? `<b class="num">${html(capital(stays))}</b> stays approved.` : "Nothing stays approved."
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
  // Said only where it fails: what keeps Confirm off.
  const checks =
    migration.gasCoinWei === null || migration.gasCoinWei === undefined
      ? []
      : [
          {
            html: `Not enough ${html(coin)} for the network fee: you have <b class="num">${html(formatShort(migration.gasCoinWei, 18).text)} ${html(coin)}</b>`,
            ok: feeWei ? migration.gasCoinWei >= feeWei : migration.gasCoinWei > 0n,
          },
        ];
  return {
    checks,
    feeRows: [{ key: "fee", label: "Network fee", value: feeWei ? aboutFee(feeWei, 18, coin) : `paid in ${coin}` }],
    lead: {
      amount: allowance >= NO_LIMIT ? "No limit" : allowance < WEI_PER_LUX ? `less than ${formatLux(1n)}` : formatLux(allowance / WEI_PER_LUX),
      chain: network,
      label: "Approved now",
      line: `${from} · ${who}`,
      unit: allowance >= NO_LIMIT ? "" : unit,
    },
    privacy: "Public: your account and the revoke",
    // What the wallet's window will show, the token, the spender and the new limit, 0, under Details.
    steps: [{ confirmLabel: "Revoke approval", lines: revokeLines({ cfg, fee: feeWei, network }), ready: true, title: "Revoke the approval", walletName }],
    sub: "",
  };
}

/**
 * "Add DUSK to <wallet>": DUSK of a route's EVM chain, for the connected EVM
 * wallet to show, where that wallet takes the request and hasn't added it for
 * this address and chain here (`takes`). On the receipt of a transfer to that
 * chain once it arrived there, at the wallet's own address; on the way back's
 * form (`wayBack`: a route out pays DUSK on its chain) while the wallet holds
 * none. Once this visit added it (`added`), what's there in its place:
 * "DUSK added to MetaMask." Null elsewhere.
 */
export function addDuskOffer(route, { added = false, balanceWei = null, entry = null, evm = null, status = "", takes = false, wayBack = false }) {
  if (!(takes || added) || !evm?.account) return null;
  const arrived = Boolean(entry) && route.mode === "service-transfer" && status === "completed" && String(entry.destination ?? "").toLowerCase() === evm.account.toLowerCase();
  const holdsNone = !entry && route.mode === "migration" && wayBack && balanceWei === 0n;
  if (!arrived && !holdsNone) return null;
  const network = holdsNone ? route.from.id : route.to.id;
  return added ? { added: `DUSK added to ${evmWalletName(evm)}.`, network } : { label: `Add DUSK to ${evmWalletName(evm)}`, network };
}

// ---------------------------------------------------------------------------
// The review's checked facts
// ---------------------------------------------------------------------------

/**
 * Facts the review checks before any wallet opens, each true or not, and
 * said only where one fails, as what keeps Confirm off: balances, to the Lux
 * as what it sends is, and gas. Lines that are always said (`note`): an
 * earlier approval that covers the amount, and what stays approved after it.
 * Where it goes is the review's own line.
 */
export function reviewChecks(route, { cfg, destination, duskAccount, evm, quote, reads }) {
  if (route.mode === "hyperlane") return hyperlaneChecks(route, { cfg, destination, duskAccount, evm, quote, reads });
  const checks = [];
  const from = networkName(cfg, route.from.id);
  const lux = quote.amountLux ?? 0n;
  const has = (amount) => `you have <b class="num">${html(amount)}</b>`;
  if (route.mode === "duskevm-deposit" || route.mode === "service-transfer") {
    const balance = reads.duskBalance;
    if (balance !== null && balance !== undefined)
      checks.push({ html: `Not enough DUSK for this and the network fee: ${has(formatDusk(balance))}`, ok: quote.maxLux !== null && lux <= quote.maxLux });
    return checks;
  }
  if (route.mode === "migration") {
    const coin = gasCoin(cfg, route.from.id);
    const token = tokenName(route.from.id);
    const migration = reads.migration ?? {};
    if (migration.balanceWei !== null && migration.balanceWei !== undefined)
      checks.push({ html: `Not enough ${html(token)}: ${has(`${formatUnitsGrouped(migration.balanceWei, 18, 9)} ${token}`)}`, ok: lux * WEI_PER_LUX <= migration.balanceWei });
    if (migration.gasCoinWei !== null && migration.gasCoinWei !== undefined)
      checks.push({
        html: `Not enough ${html(coin)} for the network fee${quote.evmFeeWei ? ` (${html(aboutFee(quote.evmFeeWei, 18, coin))})` : ""}: ${has(`${formatShort(migration.gasCoinWei, 18).text} ${coin}`)}`,
        ok: quote.evmFeeWei ? migration.gasCoinWei >= quote.evmFeeWei : migration.gasCoinWei > 0n,
      });
    // Approve is skipped: which approval covers the amount, read on the chain.
    const allowance = migration.allowanceWei ?? 0n;
    if (lux > 0n && allowance >= lux * WEI_PER_LUX) checks.push({ html: coveredLine(allowance, lux, token), note: true, ok: true });
    return checks;
  }
  const l2 = reads.l2 ?? {};
  if (l2.balanceWei !== null && l2.balanceWei !== undefined)
    checks.push({
      html: `Not enough DUSK on ${html(from)} for this and its network fee: ${has(`${formatUnitsGrouped(l2.balanceWei, 18, 9)} DUSK`)}`,
      ok: quote.maxLux !== null && lux <= quote.maxLux,
    });
  return checks;
}

/**
 * A Hyperlane transfer's checked facts, said only where one fails: what the
 * sending side holds, to the unit, and the fees' coin. To Dusk, that the
 * first transfer to an account waits for its claim, where the route says the
 * account isn't paid there yet (`reads.hyperlane.registered`), is always said.
 */
function hyperlaneChecks(route, { cfg, quote, reads }) {
  const checks = [];
  const { token } = route;
  const units = quote.amountLux ?? 0n;
  const read = reads.hyperlane ?? {};
  const has = (amount) => `you have <b class="num">${html(amount)}</b>`;
  if (route.signer === "dusk") {
    const balance = reads.duskBalance;
    const fees = (quote.bridgeFeeLux ?? 0n) + (quote.gasMaxLux ?? 0n);
    if (token.symbol !== "DUSK" && read.tokenBalance !== null && read.tokenBalance !== undefined)
      checks.push({ html: `Not enough ${html(token.symbol)}: ${has(formatToken(read.tokenBalance, token))}`, ok: units <= read.tokenBalance });
    if (balance !== null && balance !== undefined && quote.bridgeFeeLux !== null && quote.bridgeFeeLux !== undefined)
      checks.push(
        token.symbol === "DUSK"
          ? { html: `Not enough DUSK for this and the fees: ${has(formatDusk(balance))}`, ok: quote.maxLux !== null && units <= quote.maxLux }
          : { html: `Not enough DUSK for the fees (up to ${html(formatDusk(fees))}): ${has(formatDusk(balance))}`, ok: balance >= fees },
      );
    // An approval left open covers the amount: always said, as there's no approval step.
    if (token.symbol !== "DUSK" && quote.steps === 1 && read.allowance)
      checks.push({ html: `An earlier approval of <b class="num">${html(formatToken(read.allowance, token))}</b> covers this, so you aren't asked to approve`, note: true, ok: true });
    return checks;
  }
  const coin = gasCoin(cfg, route.from.id);
  const state = read.evm ?? {};
  if (state.balance !== null && state.balance !== undefined)
    checks.push({ html: `Not enough ${html(token.symbol)}: ${has(formatToken(state.balance, token))}`, ok: units <= state.balance });
  if (state.gasCoinWei !== null && state.gasCoinWei !== undefined && quote.bridgeFeeWei !== null && quote.bridgeFeeWei !== undefined) {
    const held = has(`${formatShort(state.gasCoinWei, 18).text} ${coin}`);
    // Gas not known yet is no gas: the check says what it covers.
    if (quote.evmFeeWei === null || quote.evmFeeWei === undefined)
      checks.push({ html: `Not enough ${html(coin)} for the bridge fee (${html(aboutFee(quote.bridgeFeeWei, 18, coin))}): ${held}`, ok: state.gasCoinWei >= quote.bridgeFeeWei });
    else {
      const fees = quote.bridgeFeeWei + quote.evmFeeWei;
      checks.push({ html: `Not enough ${html(coin)} for the fees (${html(aboutFee(fees, 18, coin))}): ${held}`, ok: state.gasCoinWei >= fees });
    }
  }
  if (read.registered === false)
    checks.push({
      html: `First ${html(token.symbol)} to this account: held until claimed (fee up to ${html(formatMaxFee(HYPERLANE_GAS.claim.limit * (reads.gasPrice ?? 1n)))} DUSK)`,
      note: true,
      ok: true,
    });
  return checks;
}

/**
 * The line under To that says who's paid: the recipient by its .dusk name
 * or short form, "Paying …" for a Dusk recipient a link handed over
 * (`handedOver`), saying so when Dusk Wallet is `connected` with another
 * account, or "No recipient". HTML, its values escaped.
 */
export function recipientLine(route, { connected = false, destination = "", duskName = "", handedOver = false, own = false, resolved = null } = {}) {
  const dusk = route.to.kind === "dusk";
  if (!destination) return "No recipient";
  if (handedOver && dusk) return `Paying <b class="mono">${html(short(destination))}</b>${connected && !own ? ", not your connected account" : ""}`;
  if (resolved) return `<b>${html(resolved.name)}</b> (${html(short(destination))})`;
  return own && dusk && duskName ? `<b>${html(duskName)}</b>` : `<b class="mono">${html(short(destination))}</b>`;
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

const extIcon =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 6h10v10"/><path d="M18 6 6 18"/></svg>';

/**
 * An account, address or transaction ID in a receipt's Details: in full,
 * with copy, and its explorer page where there is one.
 */
function fullValue(value, { copy, explorer = null, label }) {
  return `<span class="fullval"><code class="mono">${html(value)}</code><span class="full-actions">${copyButton(value, copy)}${explorer ? `<a class="icon-btn" href="${html(explorer)}" target="_blank" rel="noreferrer" aria-label="${html(label)} in the explorer (opens in a new tab)">${extIcon}</a>` : ""}</span></span>`;
}

function addressHtml(cfg, network, address, label) {
  if (!address) return "";
  // An EVM address with its checksum's capitals, as every app writes it.
  const value = /^0x[0-9a-f]{40}$/iu.test(address) ? formatEvmAddress(address) : address;
  return fullValue(value, { copy: label, explorer: explorerAddressUrl(cfg, network, value), label });
}

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
    fees: quote.fees ?? null,
  };
}

/**
 * What the source of `route` holds, as the form's balance line writes it, and
 * in full for whoever asks: Lux on Dusk, wei on an EVM chain. Empty until it's read.
 */
export function balanceLine(route, holdings) {
  if (holdings === null || holdings === undefined) return { exact: "", text: "" };
  // A Hyperlane route's token, in its own decimals, on either side: EURd and USDd to the cent.
  const { exact, text } = route.mode === "hyperlane" ? formatTokenShort(holdings, route.token) : formatShort(holdings, route.signer === "dusk" ? 9 : 18);
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
  if (route.mode === "hyperlane")
    return { available: formatToken(maxLux, route.token, 4), availableLabel: route.token.symbol === "DUSK" && route.signer === "dusk" ? "Available after fees" : "Available", canMax: maxLux > 0n };
  const migration = route.mode === "migration";
  return {
    available: migration ? `${formatLux(maxLux, 4)} ${tokenName(route.from.id)}` : formatDusk(maxLux, 4),
    availableLabel: migration ? "Available" : "Available after fees",
    canMax: maxLux > 0n,
  };
}

/**
 * What a proof or a claim makes public: the Dusk account that sends it is
 * linked to the withdrawal for good.
 */
export function actionPrivacy(kind) {
  return kind === "prove" ? "Public: your account, as the prover" : "Public: your account and the claim";
}

/**
 * The top of a proof's or a claim's review: the withdrawal and whom it pays,
 * in full, with what the step costs at most (`maxLux`) as its fee row. When
 * it pays another account than Dusk Wallet's `account`, it says so. A proof
 * says when it can be claimed: from `claim`, the date for a proof made now,
 * once the request is ready (`when` writes it); until then from `maturity`,
 * the Portal's wait in seconds, where it's known. A claim pays out `amountLux`.
 */
export function actionLead(kind, entry, { account = "", amountLux = null, claim = null, maturity = null, maxLux, name = "", when = (ms) => formatDateTime(ms) }) {
  // A Dusk account, or a contract by its ID: in full, as the review shows whom a transfer pays.
  const pays = entry.destination ?? "";
  // Said first: the DUSK goes to another account than Dusk Wallet's.
  const notYours = account && pays && pays !== account ? `Not ${name || "your connected account"}` : "";
  const rows = [{ key: "fee", label: "Network fee", value: `up to ${formatMaxFee(maxLux)} DUSK` }];
  if (kind === "prove" && claim?.at) rows.push({ key: "when", label: "When", value: claimText(claim, when) });
  else if (kind === "prove" && maturity) rows.push({ key: "when", label: "When", value: claimAfterProving(maturity) });
  // A proof moves nothing: said beside whom the withdrawal pays, as it decides whether to prove.
  const moves = kind === "prove" ? "No DUSK moves now" : "";
  return {
    amount: amountLux === null ? "" : formatLux(amountLux),
    chain: "dusk",
    label: kind === "prove" ? "Withdrawal" : "You claim",
    line: pays ? moves : ["To the withdrawal's Dusk account", moves].filter(Boolean).join(" · "),
    notYours,
    payee: pays,
    rows,
  };
}

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

/** A fee row's amount, for the receipt's total of what was paid in each coin. */
const paid = (amount, coin, decimals) => ({ amount: BigInt(amount), coin, decimals });

/**
 * A Hyperlane transfer's amounts on its receipt, each to its smallest unit:
 * what was sent and received, in its token, the bridge's fee and the
 * network's, each in the coin it was paid in, with the approval sent for it
 * on Dusk, and a claim's. What failed on its own chain moved nothing. Each
 * fee carries what it paid (`fee`), for the total.
 */
function hyperlaneLedger(entry, { cfg, route, status }) {
  const { token } = route;
  const coin = gasCoin(cfg, route.from.id);
  const amount = entry.amountLux === undefined || entry.amountLux === null ? null : BigInt(entry.amountLux);
  const wentThrough = !(status === "failed" && failedAtSource(entry));
  const wei = (value) => `${formatUnitsGrouped(value, 18)} ${coin}`;
  const dusk = (lux, label) => ({ fee: paid(lux, "DUSK", 9), label, value: formatDusk(BigInt(lux)) });
  const rows = [];
  if (amount !== null && wentThrough) rows.push({ label: "You sent", value: formatToken(amount, token) });
  if (route.from.id === "dusk") {
    if (known(entry.bridgeFeeLux) && wentThrough) rows.push(dusk(entry.bridgeFeeLux, "Bridge fee"));
    // The approval this browser sent first is part of what the transfer cost.
    const approved = known(entry.approvalFeeLux);
    if (known(entry.feeLux))
      rows.push({
        ...(approved ? { detail: "approval and transfer" } : {}),
        ...dusk(BigInt(entry.feeLux) + (approved ? BigInt(entry.approvalFeeLux) : 0n), "Network fee"),
      });
  } else {
    if (known(entry.bridgeFeeWei) && wentThrough) rows.push({ fee: paid(entry.bridgeFeeWei, coin, 18), label: "Bridge fee", value: wei(BigInt(entry.bridgeFeeWei)) });
    if (known(entry.feeWei)) rows.push({ fee: paid(entry.feeWei, coin, 18), label: "Network fee", value: wei(BigInt(entry.feeWei)) });
    if (known(entry.claimFeeLux)) rows.push(dusk(entry.claimFeeLux, "Claim fee"));
    // A claim that failed on Dusk was paid for all the same.
    if (known(entry.claimFailedFeeLux)) rows.push(dusk(entry.claimFailedFeeLux, "Failed claim fee"));
  }
  if (amount !== null && wentThrough && status !== "failed") rows.push({ label: status === "completed" ? "You received" : "You receive", value: formatToken(amount, token) });
  return rows;
}

/**
 * A transfer's amounts on its receipt, the same in every Dusk app
 * (`transferLedger`): what was sent, the bridge's fee, the network's, what was
 * received, each to the Lux, and gas as wallets write it, with the rest on
 * hover. What failed on its own chain moved nothing, so its fee stands alone.
 * A migration's gas is what its chain says it and the approval it spent paid
 * (`evm`, from `migrationFacts`), whichever app signed that approval. Each
 * fee carries what it paid (`fee`), for the total.
 */
function ledgerRows(entry, { approvalSpentBy = false, cfg, evm = null, from, locale, route, status }) {
  if (route.mode === "hyperlane") return hyperlaneLedger(entry, { cfg, route, status });
  const migration = route.mode === "migration";
  // Cancelled or replaced in the wallet, the migration was never mined: what
  // it cost is the approval this browser sent for it, until a migration
  // spends that approval and counts it (`approvalSpentBy`), once.
  const cancelled = migration && Boolean(entry.replaced) && known(entry.approvalFeeWei) && approvalSpentBy === false;
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
  // A withdrawal pays a network fee on each side: each says where.
  const both = Boolean(ledger.gas && ledger.networkFee);
  const label = (line) =>
    ({
      bridgeFee: "Bridge fee",
      gas: both ? `Network fee on ${from}` : "Network fee",
      networkFee: both ? "Network fee on Dusk" : "Network fee",
      received: line.expected && status !== "completed" ? "You receive" : "You received",
      sent: "You sent",
    })[line.key];
  const fee = (line) => (["bridgeFee", "gas", "networkFee"].includes(line.key) ? { fee: paid(line.amount, line.coin, line.decimals) } : {});
  // Which transactions a migration's fee counts.
  const counts = !migration ? "" : cancelled ? "approval" : gasCounts(ledger.gas, evm);
  return ledger.lines.map((line) =>
    line.key === "gas"
      ? { ...fee(line), detail: counts, exact: `${line.exact} ${line.coin}`, label: label(line), value: `${line.text} ${line.coin}` }
      : { ...fee(line), label: label(line), value: `${line.exact} ${line.coin}` },
  );
}

/**
 * What a receipt's fees came to, in each coin they were paid in, as its
 * main view says it: "16.8782 DUSK", "<0.000001 ETH + 0.0019 DUSK"; all of
 * it on hover (`exact`). "" with none.
 */
export function feesTotal(rows) {
  const coins = new Map();
  for (const { fee } of rows)
    if (fee) {
      // To 18 decimals, so a coin paid in two units (DUSK on DuskEVM and Dusk) adds up.
      const scaled = fee.amount * 10n ** BigInt(18 - fee.decimals);
      coins.set(fee.coin, (coins.get(fee.coin) ?? 0n) + scaled);
    }
  const parts = [...coins].map(([coin, total]) => {
    if (coin !== "DUSK") return { exact: `${formatUnitsGrouped(total, 18)} ${coin}`, text: aboutFee(total, 18, coin) };
    const lux = total / 1_000_000_000n;
    return { exact: formatDusk(lux), text: `${formatShort(lux, 9, "nearest").text} DUSK` };
  });
  return { exact: parts.map((part) => part.exact).join(" + "), text: parts.map((part) => part.text).join(" + ") };
}

/**
 * The receipt of one transfer. No balances: the link may be shared. `owner`
 * is the Dusk account the page is for, Dusk Wallet's (`own`) or a followed one.
 * `evm` is what a migration did on its own chain, as `migrationFacts` read it;
 * `approvalSpentBy`, for one cancelled in the wallet, the migration that
 * spent its approval since (false for none, null while that's being read).
 * `wallet` is the connected EVM wallet, with whether it takes adding DUSK of
 * the transfer's chain (`addsDusk`), and whether this visit added it (`addedDusk`).
 * Whom it pays is in full; under Details, every account and transaction too.
 */
export function receiptModel(entry, { approvalSpentBy = false, cfg, evm = null, gasPrice = 1n, locale, now = Date.now(), own = null, owner = own?.account ?? "", route, submitter = null, timeZone, timing, url, wallet = null }) {
  const view = transferView(entry, { account: own?.account ?? "", cfg, locale, name: own?.name ?? "", now, owner, route, submitter, timeZone, timing, year: true });
  const from = networkName(cfg, route.from.id);
  const to = networkName(cfg, route.to.id);
  const sourceNetwork = route.from.kind === "dusk" ? "dusk" : route.from.id;
  const destinationNetwork = route.to.kind === "dusk" ? "dusk" : route.to.id;
  // The sender short, the account it pays in full, with its copy and explorer page: "mabvHs…yuwwqv → 0x0d7f0114…".
  // The arrow keeps with the account it points to, onto the next line if that's where it goes.
  const sender = entry.sender ? `<code class="mono">${html(short(entry.sender))}</code>` : "";
  const paid = entry.destination ? `<span class="paid">${addressHtml(cfg, destinationNetwork, entry.destination, `recipient on ${to}`)}</span>` : "";
  const fromTo = sender && paid ? `${sender}<span class="to">→ ${paid}</span>` : paid ? `<span class="to">To ${paid}</span>` : sender ? `From ${sender}` : "";
  // Its state is its pill: the caption says only why it failed, a claim on its way, or how long it takes
  // while it's on its way. A withdrawal that waits for you, to prove or to claim, says that on its steps.
  const waitsForYou = route.mode === "duskevm-withdrawal" && !["submitted", "waiting_for_output"].includes(entry.stage ?? "submitted");
  let caption = "";
  if (view.status === "failed") caption = view.note;
  else if (heldInEscrow(entry, route)) caption = entry.pendingAction === "claim" ? "Claim sent, waiting for Dusk" : "";
  else if (view.status === "pending" && view.time && !waitsForYou) caption = routeTimeText(view.time);

  // Its details: what the rest of the receipt doesn't say. The title says what moved, the line above
  // whom it paid, each step its time and its transaction, with their copy and explorer pages. A failed
  // one says what left the account, if anything did.
  const ledger = ledgerRows(entry, { approvalSpentBy, cfg, evm, from, locale, route, status: view.status });
  const moved = view.title.split(" · ")[0];
  const details = ledger.filter((row) => view.status === "failed" || !(["You receive", "You received", "You sent"].includes(row.label) && row.value === moved));
  if (entry.sender) details.push({ html: addressHtml(cfg, sourceNetwork, entry.sender, `sender on ${from}`), label: "From" });
  // Paid to a Dusk account by its hash, where this page doesn't know the account.
  if (!entry.destination && route.mode === "hyperlane" && entry.recipientHash)
    details.push({ html: fullValue(entry.recipientHash, { copy: "the Dusk account's hash" }), label: "To (account hash)" });
  // Hyperlane's message, the one each side's Mailbox knows it by.
  if (route.mode === "hyperlane" && entry.messageId) details.push({ html: fullValue(entry.messageId, { copy: "the message ID" }), label: "Message ID" });
  // The approval the migration spent, as its chain says, or the one this browser sent for it, as for a Hyperlane transfer of a token issued on Dusk.
  const approval =
    route.mode === "migration" ? (evm?.approvalState === "found" && evm.approval?.hash ? evm.approval.hash : entry.approvalHash) : route.mode === "hyperlane" ? entry.approvalHash : null;
  if (approval) details.push({ html: txHtml(cfg, sourceNetwork, approval, `${from} approval`), label: `${from} approval` });
  // A claim that failed on Dusk: no step keeps it.
  if (route.mode === "hyperlane" && entry.claimFailedHash) details.push({ html: txHtml(cfg, "dusk", entry.claimFailedHash, "failed claim transaction"), label: "Failed claim" });

  const notes = [];
  if (view.late) notes.push({ html: lateLine(cfg) });
  if (view.trackingError) notes.push({ html: html(view.trackingError) });

  const stepMax =
    route.mode === "hyperlane"
      ? (heldForAnother(entry, route, owner) ? HYPERLANE_GAS.claimFor : HYPERLANE_GAS.claim).limit * BigInt(gasPrice)
      : withdrawalStepMax({ gasPrice, withdrawalGas: entry.withdrawalGas ? BigInt(entry.withdrawalGas) : 0n });
  // The countdown says when a claim can be made: its step doesn't say it again.
  if (view.countdown) view.steps = view.steps.map((item) => (item.key === "claim" ? { ...item, detail: "" } : item));
  return {
    actionFee: view.action ? `Network fee up to ${formatMaxFee(stepMax)} DUSK` : "",
    // Arrived at the connected EVM wallet: it can show the DUSK.
    addDusk: addDuskOffer(route, { added: Boolean(wallet?.addedDusk), entry, evm: wallet, status: view.status, takes: Boolean(wallet?.addsDusk) }),
    // It comes by itself, so there's something to be told of. A withdrawal, or what a route holds for its claim, comes when you claim it.
    arrives: view.status === "pending" && route.mode !== "duskevm-withdrawal" && !heldInEscrow(entry, route),
    caption,
    details,
    // What its fees came to, in the main view; each one is under Details.
    fees: feesTotal(ledger),
    fromTo,
    id: entry.id,
    notes,
    url,
    view,
  };
}

function txHtml(cfg, network, hash, label) {
  return fullValue(hash, { copy: `the ${label} ID`, explorer: explorerTxUrl(cfg, network, hash), label: `The ${label}` });
}

// ---------------------------------------------------------------------------
// My transfers
// ---------------------------------------------------------------------------

/**
 * Activity, in groups. `owner` is the Dusk account the list is for: Dusk
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
