// The pages as HTML, from view models the controller builds, in the Dusk web
// wallet's look: its top bar, a form beside its summary, lists and detail
// panels on one neutral surface family, pill buttons, and colour only where
// it means something (amber In progress, red Failed, violet Testnet, a green
// dot for Mainnet). Whom a transfer pays is shown in full where it's
// checked, on the review and the receipt; other accounts and transactions
// short, in full on copy, with an explorer link, in Söhne Mono.

import { formatContractId, formatEvmAddress } from "@dusk-network/networks/format";

import { NOTICE_WORDS } from "./arrival-notice.js";
import { GLYPH, chainMark, icon, pairMark } from "./icons.js";
import { CONNECT_CANCELLED, CONTRACT_RECIPIENT, LATER_STEP_CANCELLED, WALLET_CANCELLED, html, short } from "./transfer-view.js";

/** The faces of a Copy button: its icon or words, then what it shows once it copied (copied.js). */
export const copyFaces = (face, copied) =>
  `<span class="copy-swap" aria-hidden="true"><span class="copy-swap__from">${face}</span><span class="copy-swap__to">${copied}</span></span>`;

export const copyButton = (value, label) =>
  `<button type="button" class="icon-btn" data-copy="${html(value)}" aria-label="Copy ${html(label)}" title="Copy">${copyFaces(icon("copy"), icon("check"))}</button>`;

/** Where a short amount leaves digits out, all of them, on hover. */
const exactTitle = (exact, text) => (exact && exact !== text ? ` title="${html(exact)}"` : "");

/** A wait's words, with a small ring that turns beside them from the start (still with reduced motion). */
export const waiting = (text) => `<span class="waiting"><span class="spin" aria-hidden="true"></span><span>${html(text)}</span></span>`;

export const explorerLink = (href, label) =>
  href
    ? `<a class="icon-btn" href="${html(href)}" target="_blank" rel="noreferrer" aria-label="${html(label)} (opens in a new tab)" title="Open in explorer">${icon("ext")}</a>`
    : "";

/** A full address or hash: wrapped monospace, copy, explorer. */
export function fullValue({ explorer, label, value }) {
  if (!value) return "";
  return `<span class="fullval"><code class="mono">${html(value)}</code><span class="full-actions">${copyButton(value, label)}${explorerLink(explorer, `${label} in the explorer`)}</span></span>`;
}

const statusPill = (status, word) =>
  status === "completed"
    ? `<span class="spill done">${icon("check")}${html(word)}</span>`
    : status === "failed"
      ? `<span class="spill failed"><span class="dot"></span>${html(word)}</span>`
      : `<span class="spill pending"><span class="dot"></span>${html(word)}</span>`;

/**
 * Why a step didn't go: red when it failed, grey when you cancelled it in
 * your wallet. `live` announces it as it appears, as the review and the card do.
 */
export const messageLine = (text, { live = true } = {}) =>
  [CONNECT_CANCELLED, LATER_STEP_CANCELLED, WALLET_CANCELLED].includes(text)
    ? `<p class="message"${live ? ' role="status"' : ""}>${html(text)}</p>`
    : `<p class="message error"${live ? ' role="alert"' : ""}>${html(text)}</p>`;

/** What's public, its networks in bold: "Public on Dusk and DuskEVM, and linked:" then the parties. */
export function publicLine(text) {
  const at = String(text ?? "").indexOf(": ");
  return at < 0 ? html(text) : `<b>${html(text.slice(0, at + 1))}</b> ${html(text.slice(at + 2))}`;
}

// ---------------------------------------------------------------------------
// Header, strip and footer
// ---------------------------------------------------------------------------

/** On testnet, under the header: test DUSK is worth nothing. The badge says Testnet. */
export function strip(vm) {
  if (!vm.isTestnet) return "";
  const link = vm.otherSite
    ? `<span class="sep" aria-hidden="true">·</span><a href="${html(vm.otherSite)}" rel="noreferrer">Mainnet bridge ${icon("ext")}</a>`
    : "";
  return `<div class="strip" role="note">Test DUSK has no value${link}</div>`;
}

/** "0x756859…04b72D", its tail in a span a phone leaves out ("0x756859…"), so the header labels both wallets. */
function shortLabel(value) {
  // 6…6, as the card writes the same account; a phone shows its head alone.
  const text = short(value);
  const cut = text.indexOf("…") + 1;
  return cut ? `${html(text.slice(0, cut))}<span class="tail">${html(text.slice(cut))}</span>` : html(text);
}

function duskPill(dusk) {
  if (dusk.state === "missing")
    return `<a class="wpill cta" href="${html(dusk.getUrl)}" target="_blank" rel="noreferrer">Get Dusk Wallet ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
  if (dusk.state !== "connected")
    return `<button type="button" class="wpill cta" data-action="connect-dusk">${dusk.state === "locked" ? "Unlock Dusk Wallet" : "Connect Dusk Wallet"}</button>`;
  // The account by its .dusk name where it has one; a long one ends in an ellipsis, in full on hover.
  // Pressed, it offers another profile, or to disconnect (`duskSheet`).
  const who = dusk.name ? `<span class="nm" title="${html(dusk.name)}">${html(dusk.name)}</span>` : `<code class="mono">${shortLabel(dusk.account)}</code>`;
  return `<button type="button" class="wpill" data-action="open-dusk" aria-haspopup="dialog" aria-label="Dusk Wallet, account ${html(dusk.name ? `${dusk.name}, ${dusk.account}` : dusk.account)}"><span class="av">${chainMark("dusk", "xs")}</span>${who}</button>`;
}

/**
 * The connected Dusk Wallet: the profile this page uses, another profile
 * (the page lets go of this one and asks the wallet again, where it lets you
 * choose), or none. A wallet whose own profile switch doesn't reach the page
 * is changed here.
 */
export function duskSheet({ account, name }) {
  const who = name ? `<b>${html(name)}</b> (<code class="mono">${html(short(account))}</code>)` : `<code class="mono">${html(short(account))}</code>`;
  return `<div class="sheet-head"><div><h2 id="sheet-title">Dusk Wallet</h2><p class="sub">${who}</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div>
  <div class="sheet-body"><div class="btn-row"><button type="button" class="btn sec sm" data-action="dusk-other-profile">Switch profile</button><button type="button" class="btn sec sm" data-action="dusk-disconnect">Disconnect</button></div></div>`;
}

function evmPill(evm) {
  if (evm.state !== "connected")
    return `<button type="button" class="wpill cta" data-action="connect-evm">Connect EVM wallet</button>`;
  return `<button type="button" class="wpill" data-action="connect-evm" aria-label="${html(evm.walletName || "EVM wallet")}, ${html(evm.account)}${evm.chainName ? `, on ${html(evm.chainName)}` : ""}"><span class="av">${icon("wallet")}</span><code class="mono">${shortLabel(evm.account)}</code>${evm.chainName ? `<span class="chainchip">${html(evm.chainName)}</span>` : ""}</button>`;
}

/** The thin top bar: the name, the network, the wallets. The card's tabs are the pages. */
export function header(vm) {
  const net = `<button type="button" class="net ${vm.isTestnet ? "test" : "main"}" data-action="open-network" aria-haspopup="dialog" aria-label="Network: ${html(vm.badge)}. Show network details"><span class="dot"></span><span class="net-name">${html(vm.badge)}</span>${icon("chev-d")}</button>`;
  return `<header class="hdr"><div class="hdr-in">
    <a class="brand" href="#/" aria-label="Dusk Bridge, start">${GLYPH}<span>Dusk Bridge</span></a>
    <div class="hdr-r">${net}${duskPill(vm.dusk)}${evmPill(vm.evm)}</div>
  </div></header>`;
}

/** The Terms of use and Privacy policy, as links. */
const termsLinks = (links) =>
  [
    links.terms ? `<a href="${html(links.terms)}" target="_blank" rel="noreferrer" aria-label="Terms of use">Terms</a>` : "",
    links.privacy ? `<a href="${html(links.privacy)}" target="_blank" rel="noreferrer" aria-label="Privacy policy">Privacy</a>` : "",
  ].filter(Boolean);

export function footer(vm) {
  const links = [
    `<button type="button" class="linkish" data-action="open-about" aria-haspopup="dialog" aria-label="About this page">About</button>`,
    vm.links.docs ? `<a href="${html(vm.links.docs)}" target="_blank" rel="noreferrer">How the bridge works</a>` : "",
    vm.links.status ? `<a href="${html(vm.links.status)}" target="_blank" rel="noreferrer">Status</a>` : "",
    ...termsLinks(vm.links),
  ].filter(Boolean);
  const site = vm.officialSite ? `<span>Official site: ${html(vm.officialSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}</span>` : "";
  return `<footer class="foot"><nav aria-label="About the bridge">${links.join("")}</nav>${site}</footer>`;
}

// ---------------------------------------------------------------------------
// The bridge card: From, a flip, To, the route, one button
// ---------------------------------------------------------------------------

export function quoteRows(quote) {
  return quote.rows
    .map(
      (row) =>
        `<div class="kv${row.strong ? " total" : ""}"><dt class="k">${html(row.label)}</dt><dd class="v">${row.html ?? `<span class="stack"><span class="num">${html(row.value)}</span>${row.detail ? `<span class="small">${html(row.detail)}</span>` : ""}</span>`}</dd></div>`,
    )
    .join("");
}

/**
 * Under the recipient: the account a typed name points to, the lookup, the
 * capitals' fix, or the .dusk name a bare name likely is.
 */
function recipientNote(to) {
  if (to.resolved) return `${html(to.resolved.name)} points to <code class="mono wrap">${html(to.resolved.address)}</code>`;
  if (to.looking) return `Looking up ${html(to.looking)}…`;
  if (to.fix) return `<button type="button" class="linkish" data-action="recipient-fix">If every character is right, fix the capitals</button>`;
  if (to.suggest) return `<button type="button" class="linkish" data-action="recipient-suggest">Did you mean ${html(to.suggest)}?</button>`;
  if (to.contract) return CONTRACT_RECIPIENT;
  return "";
}

const netButton = (side, net, open) =>
  `<button type="button" class="netbtn" data-action="open-menu" data-side="${side}" aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}" aria-label="${side === "from" ? "From" : "To"}: ${html(net.name)}. Choose the network">${chainMark(net.id)}<span>${html(net.name)}</span>${icon("chev-d")}</button>`;

/** The networks to choose from: under the button on a computer, a sheet from the bottom on a phone. */
function netMenu(side, choices) {
  const title = side === "from" ? "From" : "To";
  // Why one can't be picked, where that isn't plain (`disabled` in words), or its route's time.
  const sub = (choice) => (typeof choice.disabled === "string" ? choice.disabled : choice.note);
  const options = choices
    .map(
      (choice) =>
        `<button type="button" class="netopt" role="option" data-action="pick-net" data-side="${side}" data-net="${html(choice.id)}" aria-selected="${choice.selected ? "true" : "false"}"${choice.disabled ? ' aria-disabled="true"' : ""}>${chainMark(choice.id)}<span><span class="nm">${html(choice.name)}</span>${sub(choice) ? `<span class="sb">${html(sub(choice))}</span>` : ""}</span>${choice.selected ? icon("check") : ""}</button>`,
    )
    .join("");
  return `<div class="netscrim" data-action="close-menu"></div><div class="netmenu" role="listbox" aria-label="${title}"><p class="netmenu-t">${title}</p>${options}</div>`;
}

/**
 * The tokens a pair moves, to choose one: under the token on a computer, a
 * sheet from the bottom on a phone. Two that send the same say what arrives.
 */
function tokenMenu(choices) {
  const options = choices
    .map(
      (choice) =>
        `<button type="button" class="netopt" role="option" data-action="pick-token" data-route="${html(choice.id)}" aria-selected="${choice.selected ? "true" : "false"}"><span class="tk" aria-hidden="true">${html(choice.symbol.charAt(0))}</span><span><span class="nm">${html(choice.symbol)}</span>${choice.name || choice.note ? `<span class="sb">${html([choice.name, choice.note].filter(Boolean).join(" · "))}</span>` : ""}</span>${choice.selected ? icon("check") : ""}</button>`,
    )
    .join("");
  return `<div class="netscrim" data-action="close-menu"></div><div class="netmenu" role="listbox" aria-label="Token"><p class="netmenu-t">Token</p>${options}</div>`;
}

/** What's sent, by its token: a choice where the pair moves more than one. */
function tokenControl(vm) {
  const mark = `${chainMark(vm.from.net.id)}${html(vm.unit)}`;
  if (!vm.tokens?.length) return `<span class="token">${mark}</span>`;
  const open = vm.menu === "token";
  return `<div class="netsel"><button type="button" class="token tokbtn" data-action="open-menu" data-side="token" aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}" aria-label="Token: ${html(vm.unit)}. Choose the token">${mark}${icon("chev-d")}</button>${open ? tokenMenu(vm.tokens) : ""}</div>`;
}

/**
 * Above the card, what Hyperlane's routes hold for the connected Dusk
 * account, or a typed one: the first transfer to an account waits until it's
 * claimed. Each token with its Claim; once a claim is sent, that, in its
 * place. Without DUSK for its own claim's fee, a link another account claims
 * it with.
 */
function escrowBox(escrow) {
  if (!escrow?.held?.length) return "";
  const amounts = escrow.held.map((each) => each.amount);
  const listed = amounts.length > 1 ? `${amounts.slice(0, -1).join(", ")} and ${amounts.at(-1)}` : amounts[0];
  // Another account's: anyone can claim it for it, paying only the network fee.
  const lead = escrow.owner ? `<b>Held for ${html(escrow.owner)}:</b>` : "<b>Held for you on Dusk:</b>";
  const why = escrow.link ? " · No DUSK for the fee: share this link" : "";
  const buttons = escrow.link
    ? `<button type="button" class="btn sec sm" data-copy="${html(escrow.link)}" aria-label="Copy the link another account claims it with">${copyFaces("Copy link", "Copied")}</button>`
    : escrow.held
        .map((each) =>
          each.sent
            ? `<span class="small t2">${html(each.sent)}</span>`
            : `<button type="button" class="btn sec sm" data-action="escrow-claim" data-route="${html(each.route)}"${each.account ? ` data-account="${html(each.account)}"` : ""}>Claim ${html(each.amount)}${each.account ? " for it" : ""}</button>`,
        )
        .join("");
  return `<div class="card notice-box" role="note"><div class="note">${icon("info")}<span>${lead} <span class="num">${html(listed)}</span>${why}</span></div><div class="btn-row">${buttons}</div></div>`;
}

/** The card's one button: a link where it leads to Dusk Wallet's page. */
function primaryControl(button) {
  if (button.action === "get-dusk")
    return `<a class="btn pri full" href="${html(button.href)}" target="_blank" rel="noreferrer">${html(button.label)} ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
  return `<button type="button" class="btn pri full" data-action="${html(button.action ?? "none")}" ${button.enabled ? "" : "disabled"}>${html(button.label)}</button>`;
}

/**
 * "Add DUSK to MetaMask", for the EVM wallet to show the DUSK of a chain, in
 * the look of where it stands; once added from here, "DUSK added to
 * MetaMask." in its place, which focus can take.
 */
const addDuskButton = (offer, look) =>
  offer.added
    ? `<span class="small" id="dusk-added" tabindex="-1">${html(offer.added)}</span>`
    : `<button type="button" class="${look}" data-action="add-dusk" data-net="${html(offer.network)}">${html(offer.label)}</button>`;

/**
 * Above the way back's form, an approval not used up, as the chain says it:
 * what the Dusk migration contract may still take, with Finish and Revoke.
 * Once it's revoked, that, in its place.
 */
function approvalBox(open, note = "") {
  if (!open) return note ? `<p class="message" id="approval-note" role="status" tabindex="-1">${html(note)}</p>` : "";
  const finish = open.finishLux > 0n ? '<button type="button" class="btn sec sm" data-action="approval-finish">Finish</button>' : "";
  return `<div class="card notice-box" role="note"><div class="note">${icon("info")}<span><b>Open approval:</b> the Dusk migration contract may still take <b class="num">${html(open.text)}</b> from <code class="mono">${html(short(open.evm))}</code>.</span></div><div class="btn-row">${finish}<button type="button" class="btn sec sm" data-action="approval-revoke">Revoke</button></div></div>`;
}

/**
 * The route's line under the card: its time and fees, then its warnings,
 * which block nothing (`warnings`: a bridge fee more than the amount, a
 * busy network), then how it's doing where that bears on a transfer. Its
 * split behind it, where there's one (`routeRows`): a summary that opens,
 * else a plain line.
 */
function routeHead(vm, open) {
  const lines = [...vm.routeLines.map((line) => `<span>${html(line)}</span>`), ...(vm.warnings ?? []).map((note) => `<span class="route-status warn">${html(note)}</span>`)].join("");
  // How it's doing, where that bears on a transfer; else it's under the line, with the fees.
  const status = vm.status?.inline ? `<span class="route-status${vm.status.warn ? " warn" : ""}">${html(vm.status.text)}</span>` : "";
  const sum = `${icon("clock")}<span class="route-sum">${lines}${status}</span>`;
  return open ? `<summary>${sum}${icon("chev-d", "chev")}</summary>` : `<div class="route-head">${sum}</div>`;
}

/**
 * The parts of the card that follow balances, prices, the amount and the
 * recipient. The page renders each in a `data-region` and replaces them all
 * when anything changes, so none goes stale while someone types. A paused
 * route has no route line: its button says so.
 */
export function cardRegions(vm) {
  const folds = vm.routeRows.length > 0;
  return {
    approval: approvalBox(vm.approval, vm.approvalNote),
    cta: `${vm.error ? messageLine(vm.error) : ""}${primaryControl(vm.button)}`,
    escrow: escrowBox(vm.escrow),
    // The label once there's a balance to label.
    "from-foot": `<span>${vm.from.balance ? html(vm.from.balanceLabel) : ""}</span><span class="bal">${vm.from.balance ? `<span class="num"${exactTitle(vm.from.balanceExact, vm.from.balance)}>${html(vm.from.balance)}</span>` : ""}${vm.canMax ? '<button type="button" class="mini" data-action="max">Max</button>' : ""}${vm.addDusk ? addDuskButton(vm.addDusk, "mini") : ""}</span>`,
    receive: html(vm.receive || "0"),
    "recipient-note": recipientNote(vm.to),
    // Behind the route line: the fees' split and the steps, how the route is doing as usual, and what's public.
    route: vm.routeLines.length
      ? `${routeHead(vm, folds)}${
          folds
            ? `<dl class="kvs" aria-label="Fees">${quoteRows({ rows: vm.routeRows })}</dl>${vm.status && !vm.status.inline ? `<p class="pubnote">${html(vm.status.text)}</p>` : ""}${vm.privacy ? `<p class="pubnote">${publicLine(vm.privacy)}</p>` : ""}`
            : ""
        }`
      : "",
  };
}

/**
 * Under the card, for whoever holds DUSK on Ethereum or BNB Smart Chain and
 * doesn't know to pick it as From: each chain a link that sets it.
 */
export function entryLine(entry) {
  if (!entry?.length) return "";
  const links = entry.map(({ href, name }) => `<a href="${html(href)}" aria-label="Migrate DUSK from ${html(name)} to Dusk">${html(name)}</a>`);
  return `<p class="entry">Migrate from ${links.join(' <span aria-hidden="true">·</span> ')}</p>`;
}

export function cardPage(vm) {
  const top = `<div class="bcard-top"><nav class="tabs" aria-label="Bridge and activity"><a class="tab" href="#/" ${vm.tab === "bridge" ? 'aria-current="page"' : ""}>Bridge</a><a class="tab" href="#/transfers" ${vm.tab === "activity" ? 'aria-current="page"' : ""}>Activity${vm.needsCount ? `<span class="cnt" aria-label="${vm.needsCount} need you">${vm.needsCount}</span>` : ""}</a></nav>${
    vm.tab === "bridge" ? `<button type="button" class="icon-btn tip" data-action="settings" aria-label="Recipient" data-tip="Recipient">${icon("sliders")}</button>` : ""
  }</div>`;
  // Each screen has its heading; the tabs show which one it is.
  if (vm.tab === "activity") return `<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Activity</h1><section class="bcard wide" aria-label="Activity">${top}${vm.activity}</section></main>`;
  const regions = cardRegions(vm);
  const notice = vm.notice
    ? `<div class="card notice-box" role="note"><div class="note">${icon(vm.notice.icon ?? "info")}<span>${vm.notice.html}</span></div>${vm.notice.actions ?? ""}</div>`
    : "";
  const from = `<div class="panel"><div class="panel-h"><span class="panel-l">From</span><div class="netsel">${netButton("from", vm.from.net, vm.menu === "from")}${vm.menu === "from" ? netMenu("from", vm.fromChoices) : ""}</div></div>
      <div class="amt-row"><input id="amount" name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0" value="${html(vm.amount)}" aria-label="Amount, in ${html(vm.unit)}" aria-describedby="amount-help amount-error"${vm.amountError ? ' aria-invalid="true"' : ""}>${tokenControl(vm)}</div>
      <div class="panel-f" id="amount-help" data-region="from-foot">${regions["from-foot"]}</div>
      <p class="field-error" id="amount-error" role="status">${html(vm.amountError ?? "")}</p>
    </div>`;
  const flip = `<div class="flip-row"><button type="button" class="flip" data-action="flip" aria-label="Swap From and To"${vm.canFlip ? "" : ' disabled title="No route back"'}>${icon("arrow-d")}</button></div>`;
  // Under the field: what a typed name points to, the lookup, or the capitals' fix.
  const note = `<p class="small t2 rnote" id="recipient-note" data-region="recipient-note" aria-live="polite">${regions["recipient-note"]}</p>`;
  const recipient = vm.to.editing
    ? `<div class="recip-edit"><label class="panel-l" for="recipient">${html(vm.to.label)}</label><textarea id="recipient" name="recipient" class="mono-input wrap-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${html(vm.to.placeholder)}" aria-describedby="recipient-error recipient-note"${vm.to.error ? ' aria-invalid="true"' : ""}>${html(vm.to.input)}</textarea><p class="field-error" id="recipient-error" role="alert">${html(vm.to.error ?? "")}</p>${note}${vm.to.canReset ? '<button type="button" class="linkish" data-action="recipient-reset">Use mine</button>' : ""}</div>`
    : `<p class="recip">${vm.to.line} · <button type="button" class="linkish" data-action="recipient-edit">${vm.to.empty ? "Add" : "Change"}</button></p>${note}`;
  const to = `<div class="panel"><div class="panel-h"><span class="panel-l">To</span><div class="netsel">${netButton("to", vm.to.net, vm.menu === "to")}${vm.menu === "to" ? netMenu("to", vm.toChoices) : ""}</div></div>
      <div class="amt-row"><span class="out${vm.receive ? "" : " empty"}" data-region="receive">${regions.receive}</span><span class="token">${chainMark(vm.to.net.id)}${html(vm.receiveUnit)}</span></div>
      <div class="panel-f"><span>You receive</span></div>
      ${recipient}
    </div>`;
  return `<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Bridge DUSK</h1>
    <section class="bcard" aria-label="Bridge">${top}${notice}<div data-region="escrow">${regions.escrow}</div><div data-region="approval">${regions.approval}</div>${from}${flip}${to}
      ${!vm.routeLines.length ? "" : vm.routeRows.length ? `<details class="route" data-region="route"${vm.routeOpen ? " open" : ""}>${regions.route}</details>` : `<div class="route" data-region="route">${regions.route}</div>`}
      <div class="cta" data-region="cta">${regions.cta}</div>
    </section>${entryLine(vm.entry)}
  </main>`;
}

// ---------------------------------------------------------------------------
// Review sheet
// ---------------------------------------------------------------------------

// The top of a wallet's window: its title, the amount, to whom, its small
// print and its tag. A cost ("Costs up to 0.051 DUSK") takes its own line,
// then what it's for ("for a 1,008 DUSK withdrawal that pays …").
function walletHead(head) {
  const amount = head.amount ? `${head.lead ? `${html(head.lead)} ` : ""}<span class="num">${html(head.amount)}</span>` : "";
  const to = head.to
    ? `${html(head.prefix ?? "to")} <code class="mono" title="${html(head.toFull ?? head.to)}">${html(head.to)}</code>${head.where ? ` ${html(head.where)}` : ""}`
    : "";
  const lines = (head.prefix ? [amount, to] : [[amount, to].filter(Boolean).join(" ")]).filter(Boolean);
  return `<div class="wlhd"><div class="wlt">${html(head.title)}</div>${lines.map((line) => `<div class="wlto">${line}</div>`).join("")}${head.sub ? `<div class="wlto">${html(head.sub)}</div>` : ""}${head.tag ? `<span class="tag">${icon("check")}${html(head.tag)}</span>` : ""}</div>`;
}

/**
 * What a wallet's window will show, line by line, in its order and words:
 * under the review's Details, so in one list, what the window folds last.
 */
export function walletLines(lines, cfgLinks) {
  const head = lines.find((line) => line.kind === "head");
  // What everyone sees, under the window's head and before its fee, as the window says it.
  const visible = lines.find((line) => line.kind === "visible");
  const row = (line) => {
    const text = `<span class="${line.mono ? "mono wrap" : "num"}"${line.full ? ` title="${html(line.full)}"` : ""}>${html(line.value)}</span>`;
    // A contract by its network's name reads "DuskEVM bridge · 2257e5…a1b31d", the "·" kept with its ID.
    const value = line.address
      ? `${line.value ? `<span class="wl-name">${html(line.value)}</span>` : ""}${fullValue({ explorer: cfgLinks.explorer(line.network, line.address), label: line.label, value: line.address })}`
      : line.name
        ? `<span class="wl-contract"><span class="wl-name">${html(line.name)}</span> <span class="wl-id">· ${text}</span></span>`
        : line.suffix
          ? `<span>${text}<span class="t2"> · ${html(line.suffix)}</span></span>`
          : text;
    return `<div class="wl${line.gap ? " gap" : ""}"><dt>${html(line.label)}</dt><dd>${value}${line.note ? `<span class="wl-note">${html(line.note)}</span>` : ""}</dd></div>`;
  };
  // What the window folds under its own Details (the function, the hash, the site's words) comes last.
  const ordered = [...lines.filter((line) => !line.kind && !line.fold), ...lines.filter((line) => line.fold)];
  return `${head ? walletHead(head) : ""}${visible ? `<p class="note wl-visible">${icon("eye")}<span>${html(visible.text)}</span></p>` : ""}<dl class="wls">${ordered.map(row).join("")}</dl>`;
}

// Before what it costs: it pays another account than the connected one, or a contract.
const otherAccount = (text) =>
  `<div class="group pad warn-box" role="note"><div class="note">${icon("person")}<span>${html(text)}</span></div></div>`;

// A proof's or a claim's review leads with what moves and whom it pays, in full; a revoke's with what's approved.
function actionLead(lead) {
  const unit = lead.unit ?? "DUSK";
  const line = lead.payee ? `To <code class="mono wrap">${html(lead.payee)}</code> on Dusk${lead.line ? ` · ${html(lead.line)}` : ""}` : html(lead.line);
  return `<div class="flow group lead"><div><div class="k">${html(lead.label)}</div><div class="v num">${html(lead.amount)}${unit ? `<span class="u">${html(unit)}</span>` : ""}</div><div class="w">${lead.chain ? chainMark(lead.chain, "xs") : ""}<span>${line}</span></div></div></div>`;
}

/** One side of what moves: its network, the .dusk name where there's one, then its account, in full where it's paid (`full`). */
const flowSide = (part) =>
  `${chainMark(part.chain, "xs")}<span>${html(part.where)}${part.account ? ` · <code class="mono${part.full ? " wrap" : ""}">${html(part.account)}</code>` : ""}</span>`;

/** One line of a call the wallet can't read: an ID or address in its own type, all of it on hover; else a value and what it is. */
const callRow = (row) =>
  `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v">${
    row.mono
      ? `<code class="mono${row.wrap ? " wrap" : ""}"${row.full ? ` title="${html(row.full)}"` : ""}>${html(row.value)}</code>`
      : `<span class="stack"><span class="num">${html(row.value)}</span>${row.detail ? `<span class="small">${html(row.detail)}</span>` : ""}</span>`
  }</dd></div>`;

/** A line the review always says, by itself: what's held, what stays approved, a fee past the amount. HTML. */
const noteLine = (text) => `<p class="note">${icon("info")}<span>${text}</span></p>`;

/** The fee rows a review sums into one figure, where there's more than one: their split is for reference. */
const FEE_KEYS = ["fee", "bridge", "fee-dusk"];

/**
 * A review's rows: an approval's spender in full, which the wallet may not
 * name; the fees as one figure, `fees` where they're more than one; then the
 * rest, as the total where it isn't the amount and the fees, and the time.
 * For reference (`split`): the fees' split.
 */
function reviewRows(vm, step) {
  const rows = vm.feeRows ?? [];
  const fees = rows.filter((row) => FEE_KEYS.includes(row.key));
  const rest = rows.filter((row) => !FEE_KEYS.includes(row.key));
  const split = fees.length > 1 && vm.fees;
  // In full, with its copy, and its explorer page where it has one (`network`); a Dusk contract has none.
  const spenderId = step?.spender ? (/^0x/u.test(step.spender.address) ? formatEvmAddress(step.spender.address) : formatContractId(step.spender.address)) : "";
  const spender = step?.spender
    ? [
        {
          html: `<span class="stack"><span>${html(step.spender.name)}</span>${fullValue({ explorer: step.spender.network ? vm.cfgLinks?.explorer(step.spender.network, spenderId) : null, label: "Spender", value: spenderId })}</span>`,
          key: "spender",
          label: "Spender",
        },
      ]
    : [];
  return { shown: [...spender, ...(split ? [vm.fees] : fees), ...rest], split: split ? fees : [] };
}

// A value as the review compares it: an EVM address or a hex ID in any case and with or without 0x, the rest as it reads.
const sameKey = (value) => {
  const text = String(value).replace(/\s+/gu, " ").trim();
  return /^(?:0x)?[0-9a-f]{40,64}$/iu.test(text) ? text.toLowerCase().replace(/^0x/u, "") : text;
};

// Window lines the review says itself or the screen implies: the network (the badge and From say it), the fee and the total, the change.
const IMPLIED_LINES = new Set(["Estimated change", "Network", "Network fee", "Total"]);

/**
 * What a review keeps for reference: the fees' split (`split`), what else
 * the step's wallet window will show (`lines`), and a call that window can't
 * read, to check against it (`call`). Nothing the review says already: its
 * amounts, its accounts and spender, its rows. And nothing twice: the
 * window's head and fee lines restate them.
 */
function reviewReference(vm, step, rows) {
  const said = new Set();
  const say = (...values) => {
    for (const value of values) if (value) said.add(sameKey(value));
  };
  for (const side of [vm.send, vm.receive].filter(Boolean)) say(`${side.amount} ${side.unit}`, side.account, ...String(side.where ?? "").split(" · "));
  if (vm.lead) say(`${vm.lead.amount} ${vm.lead.unit ?? "DUSK"}`, vm.lead.payee);
  if (step?.spender) say(step.spender.address, step.spender.name);
  for (const row of [...rows.shown, ...rows.split]) say(row.value);
  const fresh = (...values) => !values.some((value) => value && said.has(sameKey(value)));
  const ready = Boolean(step?.ready);
  return {
    call: ready && step.call?.length ? step.call.filter((row) => fresh(row.full, row.value)) : [],
    lines: ready && step.lines?.length && !step.call?.length ? step.lines.filter((line) => !line.kind && !IMPLIED_LINES.has(line.label) && fresh(line.address, line.full, line.value)) : [],
    split: rows.split,
  };
}

const CALL_TITLE = "Call details, to check against Dusk Wallet";

/**
 * The review: what moves, from whom and to whom in full, the spender of an
 * approval in full, the one line on what's public, what could cost money
 * said once, the fees as one figure, the total where it isn't the amount and
 * the fees, and the time; with two steps, the button says which it takes. A
 * check is said only where it fails, as what keeps Confirm off. That's whole
 * by itself. Its reference (`reviewReference`) is under Details, with a call
 * the window can't read in a fold of its own.
 */
export function reviewSheet(vm) {
  const step = vm.steps.find((each) => each.current);
  const rows = reviewRows(vm, step);
  const ref = reviewReference(vm, step, rows);
  const split = ref.split.length ? `<dl class="group kvs">${quoteRows({ rows: ref.split })}</dl>` : "";
  const preview = ref.lines.length ? `<div class="wlh">${html(step.walletName)} will also show</div>${walletLines(ref.lines, vm.cfgLinks)}` : "";
  const callRows = ref.call.length ? `<dl class="group kvs">${ref.call.map(callRow).join("")}</dl>` : "";
  const failing = vm.checks.filter((check) => !check.ok);
  const checks = failing.length
    ? `<ul class="ck" aria-label="Checked">${failing.map((check) => `<li class="bad">${icon("info")}<span>${check.html}</span></li>`).join("")}</ul>`
    : "";
  // Warnings that block nothing, in amber as the card says them: a bridge fee more than the amount, a busy network.
  const warnings = (vm.warnings ?? []).map((text) => `<p class="note warn">${icon("info")}<span>${html(text)}</span></p>`).join("");
  const notes = [...vm.checks.filter((check) => check.ok && check.note).map((check) => check.html), ...(vm.notes ?? []).map(html)].map(noteLine).join("");
  // Another account paid: said first, after what's public.
  const notYours = vm.lead ? vm.lead.notYours : vm.notYours;
  const decision = `${vm.lead ? actionLead(vm.lead) : `<div class="flow group">
      <div><div class="k">You send</div><div class="v num">${html(vm.send.amount)}<span class="u">${html(vm.send.unit)}</span></div><div class="w">${flowSide(vm.send)}</div></div>
      <div class="dn" aria-hidden="true">${icon("back", "down")}</div>
      <div><div class="k">You receive</div><div class="v num">${html(vm.receive.amount)}<span class="u">${html(vm.receive.unit)}</span></div><div class="w">${flowSide(vm.receive)}</div></div>
    </div>`}
    <p class="note">${icon("eye")}<span>${publicLine(vm.privacy)}</span></p>
    ${notYours ? otherAccount(notYours) : ""}
    ${warnings}
    ${notes}
    ${checks}
    <dl class="group kvs">${quoteRows({ rows: rows.shown })}</dl>
    ${step && !step.ready ? `<p class="small t2">${waiting(step.wait ?? "Preparing…")}</p>` : ""}`;
  const body = `<div class="sheet-body">${decision}
    ${split || preview ? `<details class="wl-more"><summary>Details</summary>${split}${preview}</details>` : ""}
    ${callRows ? `<details class="wl-more"><summary>${CALL_TITLE}</summary>${callRows}</details>` : ""}
  </div>`;
  return `<div class="sheet-head"><div><h2 id="sheet-title">Review</h2>${vm.sub ? `<p class="sub">${html(vm.sub)}</p>` : ""}</div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close the review">${icon("close")}</button></div>
  ${body}
  <div class="sheet-foot">${vm.error ? messageLine(vm.error) : ""}<div class="btn-pair"><button type="button" class="btn sec" data-action="close-sheet">Cancel</button><button type="button" class="btn pri" data-action="confirm" ${vm.canConfirm ? "" : "disabled"}>${html(vm.confirmLabel)}${vm.stepOf ? `<span class="of"><span class="sr-only">, step </span>${vm.stepOf.at} of ${vm.stepOf.of}</span>` : ""}</button></div></div>`;
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function stepList(steps) {
  return `<ol class="steps">${steps
    .map((step) => {
      const mark = step.state === "done" ? icon("check") : step.state === "failed" ? icon("close") : "";
      const right = [
        step.atText ? `<span class="num">${html(step.atText)}</span>` : "",
        step.href ? `<a class="lnk" href="${html(step.href)}" target="_blank" rel="noreferrer">Explorer ${icon("ext")}<span class="sr-only"> for ${html(step.title)} (opens in a new tab)</span></a>` : "",
      ].join("");
      // The step keeps its transaction short, with copy; Details has the rest.
      const hash = step.hash ? `<span class="hashline"><code class="mono" title="${html(step.hash)}">${html(short(step.hash))}</code>${copyButton(step.hash, `${step.title} transaction ID`)}</span>` : "";
      return `<li class="step ${step.state}"><span class="mk" aria-hidden="true">${mark}</span><span class="tt">${html(step.title)}<span class="sr-only">, ${html(stateWord(step.state))}</span></span><span class="rt">${right}</span>${step.detail ? `<span class="ds">${html(step.detail)}</span>` : ""}${hash ? `<span class="ds">${hash}</span>` : ""}${step.action ?? ""}</li>`;
    })
    .join("")}</ol>`;
}

const stateWord = (state) =>
  ({ done: "done", failed: "failed", now: "in progress", todo: "not yet", turn: "your turn" })[state] ?? state;

/** On a receipt whose transfer is on its way: being told when it arrives, as far as this browser can. */
const arrivalNotice = (state) =>
  `<p class="small t2 notify" id="notify" tabindex="-1">${
    state === "offer"
      ? '<button type="button" class="linkish" data-action="notify-on">Notify me</button>'
      : `${html(NOTICE_WORDS[state])}${state === "on" ? ' <button type="button" class="linkish" data-action="notify-off">Turn off</button>' : ""}`
  }</p>`;

/** Back to Activity, where every transfer is listed. */
const backLink = `<a class="bk" href="#/transfers">${icon("back")}Activity</a>`;

export function receiptPage(vm) {
  if (vm.loading)
    return `<main class="col" id="main" tabindex="-1"><div class="topbar">${backLink}<h1 class="ti">Transfer</h1></div><p class="t2" role="status">${waiting(vm.loading)}</p></main>`;
  if (vm.missing)
    return `<main class="col" id="main" tabindex="-1"><div class="topbar">${backLink}<h1 class="ti">Transfer</h1></div><div class="group pad"><p>${html(vm.missing)}</p><p class="small t2"><code class="mono wrap">${html(vm.hash)}</code></p></div><p class="links-row"><a class="lnk" href="#/lookup">Look up another ${icon("search")}</a></p></main>`;
  const view = vm.view;
  // When it can be claimed: "Claim from …" or "Claim from about …", counted
  // down. Late, the date is only the soonest and moves on each check: the
  // wait is said, with no countdown and nothing to put in a calendar.
  const countdown = view.countdown?.overdue
    ? `<div class="group count"><p>${html(view.countdown.line)}</p></div>`
    : view.countdown
      ? `<div class="group count"><div><div class="k">You can claim in</div><div class="v">${html(view.countdown.left)}</div><div class="s">${html(view.countdown.line)}${view.countdown.clockNote ? ` (${html(view.countdown.clockNote)})` : ""}</div></div><button type="button" class="btn sec sm" data-action="calendar">${icon("calendar")}Add to calendar</button></div>`
      : "";
  const action = view.action
    ? vm.canAct === false
      ? `<div class="action-box">${actionNeedsWallet(view.action.kind)}</div>`
      : view.action.blocked
        ? `<div class="action-box"><p class="note">${icon("info")}<span>${html(view.action.blocked)}</span></p></div>`
        : `<div class="action-box">${view.action.failure ? messageLine(view.action.failure, { live: false }) : ""}<button type="button" class="btn ${view.action.quiet ? "sec" : "pri"}" data-action="${html(view.action.command ?? `withdrawal-${view.action.kind}`)}" data-id="${html(vm.id)}">${html(view.action.label)}</button><span class="small t2">${html(vm.actionFee ?? "")}</span></div>`
    : "";
  const value = (row) => `<span class="num"${exactTitle(row.exact, row.value)}>${html(row.value)}</span>`;
  const details = vm.details
    .map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v">${row.html ?? (row.detail ? `<span class="stack">${value(row)}<span class="small">${html(row.detail)}</span></span>` : value(row))}</dd></div>`)
    .join("");
  const notes = vm.notes.map((note) => `<p class="note">${icon(note.icon ?? "info")}<span>${note.html}</span></p>`).join("");
  const fees = vm.fees?.text ? `<p class="small t2">Fees <span class="num"${exactTitle(vm.fees.exact, vm.fees.text)}>${html(vm.fees.text)}</span></p>` : "";
  // The transfer and its steps on the left; its details folded in a panel
  // beside them, as the web wallet shows a transaction.
  const side = details ? `<section class="rc-side" aria-label="Details"><details><summary class="gh">Details</summary><dl class="kvs">${details}</dl></details></section>` : "";
  return `<main class="page rc" id="main" tabindex="-1">
    <div class="rc-main">
      <div class="topbar">${backLink}</div>
      <div class="hero">
        <div class="okc ${view.status}" aria-hidden="true">${view.status === "completed" ? icon("check") : view.status === "failed" ? icon("close") : pairMark(view.pair[0], view.pair[1])}</div>
        <h1 class="t">${html(view.title)}</h1>
        ${vm.fromTo ? `<p class="l">${vm.fromTo}</p>` : ""}
        <div class="pl" role="status">${statusPill(view.status, view.statusWord)}${vm.caption ? `<span class="cap">${html(vm.caption)}</span>` : ""}</div>
      </div>
      ${countdown}
      <section aria-labelledby="progress-h"><h2 class="sr-only" id="progress-h">Progress</h2><div class="group pad">${stepList(view.steps)}</div>${action}${vm.addDusk ? `<div class="action-box">${addDuskButton(vm.addDusk, "btn sec sm")}</div>` : ""}${vm.arrives && vm.notice ? arrivalNotice(vm.notice) : ""}</section>
      ${fees}
      ${notes}
      <div class="lk"><span>${icon("link")}Receipt link</span>${copyButton(vm.url, "receipt link")}</div>
      <p class="small t2">Anyone with the link can see this transfer.</p>
      <div class="bt"><a class="btn ${view.status === "completed" ? "pri" : "sec"}" href="#/">New transfer</a></div>
    </div>
    ${side}
  </main>`;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function trackerBars(tracker) {
  if (!tracker) return "";
  return `<div class="trk" aria-hidden="true">${tracker
    .map((part) => `<div class="${part.state}"><i></i><span>${html(part.label)}</span>${part.when ? `<span class="when">${html(part.when)}</span>` : ""}</div>`)
    .join("")}</div><span class="sr-only">${tracker.map((part) => `${part.label}${part.when ? ` ${part.when}` : ""}: ${stateWord(part.state)}`).join(", ")}</span>`;
}

/** Prove and Claim need Dusk Wallet: without it, the row says so instead. */
const actionNeedsWallet = (kind) =>
  `<span class="tag">${icon("laptop")}${kind === "prove" ? "Prove" : "Claim"} with Dusk Wallet</span>`;

export function transferRow(row, { canAct = true } = {}) {
  let right;
  // Its group says its state; the whole row opens its receipt.
  if (!row.action) right = `<span class="lnk" aria-hidden="true">${icon("chev-r")}</span>`;
  else if (!canAct) right = actionNeedsWallet(row.action.kind);
  // A claim waiting for the account that proved it: its receipt says which.
  else if (row.action.blocked) right = `<span class="tag">${icon("info")}Switch account to claim</span>`;
  else
    // Someone else's withdrawal is offered quietly.
    right = `<button type="button" class="btn ${row.action.quiet ? "sec" : "pri"} xs" data-action="${html(row.action.command ?? `withdrawal-${row.action.kind}`)}" data-id="${html(row.id)}">${html(row.action.kind === "prove" ? "Prove" : "Claim")}<span class="sr-only"> ${html(row.amountText)} from ${html(row.title)}</span></button>`;
  // Whom it pays and its transaction, so equal transfers are told apart.
  const to = row.to ? `To ${row.to.name ? html(row.to.name) : `<code class="mono">${html(row.to.address)}</code>`}` : "";
  const meta = [to, row.hash ? `<code class="mono">${html(row.hash)}</code>` : ""].filter(Boolean).join(" · ");
  return `<li class="tr" data-status="${html(row.status)}"><a class="tr-link" href="${html(row.href)}" aria-label="${html(row.title)}, ${html(row.amountText)}, ${html(row.statusWord)}. Open the receipt"${exactTitle(row.amountExact, row.amountText)}></a>${pairMark(row.pair[0], row.pair[1])}<div class="tr-main"><div class="t1">${html(row.title)}</div><div class="t2">${html(row.subline)}</div>${meta ? `<div class="t3">${meta}</div>` : ""}${trackerBars(row.tracker)}</div><div class="rt"><span class="am num">${html(row.amountText)}</span>${right}</div></li>`;
}

/**
 * Without a connected Dusk account, as on a phone: follow one by its account
 * or .dusk name, read-only, or stop following it.
 */
function watchBlock(watch) {
  // Whom it follows is the list's lede.
  if (watch.following)
    return `<p class="small t2 watching"><button type="button" class="linkish" data-action="unwatch" aria-label="Stop following ${html(watch.following)}">Stop following</button></p>`;
  return `<form class="group pad watch" data-form="watch">
      <label for="watch" class="l1">Follow a Dusk account</label>
      <textarea id="watch" name="watch" class="mono-input wrap-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Account or .dusk name" aria-describedby="watch-error">${html(watch.input ?? "")}</textarea>
      <p class="field-error" id="watch-error" role="alert">${html(watch.error ?? "")}</p>
      <button type="submit" class="btn sec sm" ${watch.busy ? "disabled" : ""}>${watch.busy ? "Looking…" : "Show transfers"}</button>
    </form>`;
}

/** The card's Activity tab: whose transfers these are, then the list, newest first in each group. */
export function activityPanel(vm) {
  const group = (title, rows) =>
    rows.length
      ? `<h2 class="sec-t">${html(title)}</h2><ul class="list trs">${rows.map((row) => transferRow(row, { canAct: vm.canAct !== false })).join("")}</ul>`
      : "";
  const body = vm.empty
    ? `<div class="empty"><p>${html(vm.empty)}</p>${vm.emptyActions ?? ""}</div>`
    : `${group("Needs you", vm.groups.needs)}${group("In progress", vm.groups.progress)}${group("Sent to someone else", vm.groups.other ?? [])}${group("Completed", vm.groups.done)}${group("Failed", vm.groups.failed)}`;
  return `<div class="act">
    <div class="act-h"><p class="lede">${vm.lede}</p><a class="btn sec sm" href="#/lookup">${icon("search")}Look up</a></div>
    <p class="small t2 sync" role="status" aria-live="polite">${vm.syncing ? waiting(vm.syncText) : html(vm.syncText)}</p>
    ${vm.watch ? watchBlock(vm.watch) : ""}
    ${body}
    ${vm.more ? `<p class="links-row"><button type="button" class="btn sec sm" data-action="discover-more">Older transfers</button></p>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------
// Look up
// ---------------------------------------------------------------------------

/** A link to a task this network's bridge doesn't have: that, and the way back. */
export function unavailablePage(vm) {
  return `<main class="col" id="main" tabindex="-1"><h1>${html(vm.title)}</h1><p class="links-row"><a class="lnk" href="#/">Back to the bridge</a></p></main>`;
}

export function lookupPage(vm) {
  return `<main class="col" id="main" tabindex="-1">
    <div class="topbar">${backLink}<h1 class="ti">Look up a transfer</h1></div>
    <form class="group pad" data-form="lookup">
      <label for="lookup" class="l1">Transaction ID</label>
      <input id="lookup" name="lookup" class="mono-input" autocomplete="off" spellcheck="false" value="${html(vm.query)}" aria-describedby="lookup-error">
      <p class="field-error" id="lookup-error" role="alert">${html(vm.error ?? "")}</p>
      <button type="submit" class="btn pri full" ${vm.busy ? "disabled" : ""}>${vm.busy ? "Looking…" : "Find transfer"}</button>
    </form>
  </main>`;
}

// ---------------------------------------------------------------------------
// Sheets: contracts, network
// ---------------------------------------------------------------------------

/** A contract or account in About: in full, as main lists them, with copy and its explorer page where there is one. */
const idValue = (row) => fullValue({ explorer: row.href, label: row.label, value: row.value });

/**
 * About this page: the Terms of use and Privacy policy, the servers it reads
 * from, then the contracts and accounts of each route, each in full. What
 * each does is behind Details, once for all that do the same. The networks
 * are the network sheet's.
 */
export function contractsSheet(vm) {
  const groups = vm.groups.filter((group) => group.id !== "networks");
  const sections = groups
    .map((group) => {
      const rows = group.rows.map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v">${idValue(row)}</dd></div>`).join("");
      const docs = group.docs ? `<a class="lnk" href="${html(group.docs)}" target="_blank" rel="noreferrer">Guide ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>` : "";
      const title = group.title ? `<h3 class="gt">${html(group.title)}${group.paused ? " · paused" : ""}${docs}</h3>` : "";
      return `<section class="cgroup">${title}<dl class="group kvs">${rows}</dl></section>`;
    })
    .join("");
  const does = new Map();
  for (const group of groups) for (const row of group.rows) if (row.note) does.set(row.note, [...(does.get(row.note) ?? []), row.label]);
  const details = does.size
    ? `<details class="wl-more"><summary>Details</summary>${[...does].map(([note, labels]) => `<p class="small t2">${html(labels.join(", "))}: ${html(note)}</p>`).join("")}</details>`
    : "";
  const terms = termsLinks(vm.links ?? {});
  const about = terms.length ? `<p class="about-links">${terms.join('<span class="sep" aria-hidden="true">·</span>')}</p>` : "";
  const servers = vm.servers ? `<section class="cgroup"><p class="card about-servers">${html(vm.servers)}</p></section>` : "";
  return `<div class="sheet-head"><div><h2 id="sheet-title">About · ${html(vm.badge)}</h2></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div><div class="sheet-body">${about}${servers}${sections}${details}</div>`;
}

/** The Dusk wallets installed, to choose the one this page uses: by name, and the ID each gives itself. */
export function walletsSheet(vm) {
  const rows = vm.wallets
    .map(
      (wallet) =>
        `<li><button type="button" class="netopt" data-action="choose-dusk" data-wallet="${html(wallet.id)}"><span class="av">${icon("wallet")}</span><span><span class="nm">${html(wallet.name)}</span><span class="sb">${html(wallet.rdns)}</span></span>${icon("chev-r")}</button></li>`,
    )
    .join("");
  return `<div class="sheet-head"><div><h2 id="sheet-title">Choose a wallet</h2>${vm.wallets.length > 1 ? "" : `<p class="sub">The wallet you used here before isn't installed.</p>`}</div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div>
  <div class="sheet-body"><ul class="group wallets">${rows}</ul></div>`;
}

/** The network badge's sheet: its chains, and the other network's bridge where there's one. */
export function networkSheet(vm) {
  const other = vm.otherSite
    ? `<a class="btn sec sm full" href="${html(vm.otherSite)}" rel="noreferrer">${html(vm.otherName)} bridge ${icon("ext")}</a>`
    : "";
  return `<div class="sheet-head"><div><h2 id="sheet-title"><span class="net ${vm.isTestnet ? "test" : "main"} static"><span class="dot"></span>${html(vm.badge)}</span></h2></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div>
  <div class="sheet-body"><dl class="group kvs">${vm.networks.map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v ${row.muted ? "t2" : "mono"}">${html(row.value)}</dd></div>`).join("")}</dl>${other}</div>`;
}
