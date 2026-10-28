// The pages as HTML, from view models the controller builds, in the Dusk web
// wallet's look: its top bar, a form beside its summary, lists and detail
// panels on one neutral surface family, pill buttons, and colour only where
// it means something (amber Pending, red Failed, violet Testnet, a green dot
// for Mainnet). Addresses and hashes are shown in full where they're
// checked, with a copy button and an explorer link, in Söhne Mono.

import { GLYPH, chainMark, icon, pairMark } from "./icons.js";
import { html, short } from "./transfer-view.js";

export const copyButton = (value, label) =>
  `<button type="button" class="icon-btn" data-copy="${html(value)}" aria-label="Copy ${html(label)}" title="Copy">${icon("copy")}</button>`;

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

const statusWord = (status, word) =>
  status === "completed" ? "" : `<span class="st ${status}"><span class="dot"></span>${html(word)}</span>`;

/** What's public, its networks in bold: "Public on Dusk and DuskEVM, and linked:" then the parties. */
export function publicLine(text) {
  const at = String(text ?? "").indexOf(": ");
  return at < 0 ? html(text) : `<b>${html(text.slice(0, at + 1))}</b> ${html(text.slice(at + 2))}`;
}

// ---------------------------------------------------------------------------
// Header, strip and footer
// ---------------------------------------------------------------------------

export function strip(vm) {
  if (!vm.isTestnet) return "";
  const link = vm.otherSite
    ? `<span class="sep" aria-hidden="true">·</span><a href="${html(vm.otherSite)}" rel="noreferrer">Go to the Mainnet bridge ${icon("ext")}</a>`
    : "";
  return `<div class="strip" role="note">Testnet <span class="sep" aria-hidden="true">·</span> Test DUSK has no value${link}</div>`;
}

function duskPill(dusk) {
  if (dusk.state === "missing")
    return `<a class="wpill cta" href="${html(dusk.getUrl)}" target="_blank" rel="noreferrer">Get Dusk Wallet ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
  if (dusk.state !== "connected")
    return `<button type="button" class="wpill cta" data-action="connect-dusk">${dusk.state === "locked" ? "Unlock Dusk Wallet" : "Connect Dusk Wallet"}</button>`;
  // The account by its .dusk name where Dusk Wallet sent one.
  const who = dusk.name ? `<span class="nm">${html(dusk.name)}</span>` : `<code class="mono">${html(short(dusk.account))}</code>`;
  return `<button type="button" class="wpill" data-action="connect-dusk" aria-label="Dusk Wallet, account ${html(dusk.name ? `${dusk.name}, ${dusk.account}` : dusk.account)}"><span class="av">${chainMark("dusk", "xs")}</span>${who}</button>`;
}

function evmPill(evm) {
  if (evm.state !== "connected")
    return `<button type="button" class="wpill cta" data-action="connect-evm">Connect EVM wallet</button>`;
  return `<button type="button" class="wpill" data-action="connect-evm" aria-label="${html(evm.walletName || "EVM wallet")}, ${html(evm.account)}${evm.chainName ? `, on ${html(evm.chainName)}` : ""}"><span class="av">${icon("wallet")}</span><code class="mono">${html(short(evm.account))}</code>${evm.chainName ? `<span class="chainchip">${html(evm.chainName)}</span>` : ""}</button>`;
}

/** The thin top bar: the name, the network, the wallets. The card's tabs are the pages. */
export function header(vm) {
  const net = `<button type="button" class="net ${vm.isTestnet ? "test" : "main"}" data-action="open-network" aria-haspopup="dialog" aria-label="Network: ${html(vm.badge)}. Show network details"><span class="dot"></span><span class="net-name">${html(vm.badge)}</span>${icon("chev-d")}</button>`;
  return `<header class="hdr"><div class="hdr-in">
    <a class="brand" href="#/" aria-label="Dusk Bridge, start">${GLYPH}<span>Dusk Bridge</span></a>
    <div class="hdr-r">${net}${duskPill(vm.dusk)}${evmPill(vm.evm)}</div>
  </div></header>`;
}

/**
 * Who runs the bridge: "Operated by Dusk", or by route where the routes have
 * different operators.
 */
export function operatedBy({ operator = "", operators = [] } = {}) {
  if (operator) return `Operated by ${html(operator)}`;
  const each = operators.map(({ name, route }) => `${html(name)} for ${html(route)}`);
  return each.length ? `Operated by ${each.join(" · ")}` : "";
}

/** The terms and privacy notice the bridge is offered under, as links. */
const termsLinks = (links) =>
  [
    links.terms ? `<a href="${html(links.terms)}" target="_blank" rel="noreferrer">Terms of use</a>` : "",
    links.privacy ? `<a href="${html(links.privacy)}" target="_blank" rel="noreferrer">Privacy policy</a>` : "",
  ].filter(Boolean);

export function footer(vm) {
  const links = [
    `<button type="button" class="linkish" data-action="open-about" aria-haspopup="dialog">About this page</button>`,
    vm.links.docs ? `<a href="${html(vm.links.docs)}" target="_blank" rel="noreferrer">How the bridge works</a>` : "",
    vm.links.status ? `<a href="${html(vm.links.status)}" target="_blank" rel="noreferrer">Status</a>` : "",
    ...termsLinks(vm.links),
  ].filter(Boolean);
  const site = vm.officialSite ? `<span>Official site: ${html(vm.officialSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}</span>` : "";
  const runBy = operatedBy(vm);
  return `<footer class="foot"><nav aria-label="About the bridge">${links.join("")}</nav>${site}${runBy ? `<span class="run-by">${runBy}</span>` : ""}</footer>`;
}

// ---------------------------------------------------------------------------
// The bridge card: From, a flip, To, the route, one button
// ---------------------------------------------------------------------------

export function quoteRows(quote) {
  return quote.rows
    .map(
      (row) =>
        `<div class="kv${row.strong ? " total" : ""}"><dt class="k">${html(row.label)}</dt><dd class="v"><span class="stack"><span class="num">${html(row.value)}</span>${row.detail ? `<span class="small">${html(row.detail)}</span>` : ""}</span></dd></div>`,
    )
    .join("");
}

/** Under the recipient: the account a typed name points to, the lookup, or the capitals' fix. */
function recipientNote(to) {
  if (to.resolved) return `${html(to.resolved.name)} points to <code class="mono wrap">${html(to.resolved.address)}</code>`;
  if (to.looking) return `Looking up ${html(to.looking)}…`;
  if (to.fix) return `<button type="button" class="linkish" data-action="recipient-fix">If every character is right, fix the capitals</button>`;
  return "";
}

const netButton = (side, net, open) =>
  `<button type="button" class="netbtn" data-action="open-menu" data-side="${side}" aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}" aria-label="${side === "from" ? "From" : "To"}: ${html(net.name)}. Choose the network">${chainMark(net.id)}<span>${html(net.name)}</span>${icon("chev-d")}</button>`;

/** The networks to choose from: under the button on a computer, a sheet from the bottom on a phone. */
function netMenu(side, choices) {
  const title = side === "from" ? "Where it comes from" : "Where it goes";
  const options = choices
    .map(
      (choice) =>
        `<button type="button" class="netopt" role="option" data-action="pick-net" data-side="${side}" data-net="${html(choice.id)}" aria-selected="${choice.selected ? "true" : "false"}"${choice.disabled ? ' aria-disabled="true"' : ""}>${chainMark(choice.id)}<span><span class="nm">${html(choice.name)}</span>${choice.disabled || choice.note ? `<span class="sb">${html(choice.disabled || choice.note)}</span>` : ""}</span>${choice.selected ? icon("check") : ""}</button>`,
    )
    .join("");
  return `<div class="netscrim" data-action="close-menu"></div><div class="netmenu" role="listbox" aria-label="${title}"><p class="netmenu-t">${title}</p>${options}</div>`;
}

/** The card's one button: a link where it leads to Dusk Wallet's page. */
function primaryControl(button) {
  if (button.action === "get-dusk")
    return `<a class="btn pri full" href="${html(button.href)}" target="_blank" rel="noreferrer">${html(button.label)} ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
  return `<button type="button" class="btn pri full" data-action="${html(button.action ?? "none")}" ${button.enabled ? "" : "disabled"}>${html(button.label)}</button>`;
}

/**
 * The parts of the card that follow balances, prices, the amount and the
 * recipient. The page renders each in a `data-region` and replaces them all
 * when anything changes, so none goes stale while someone types.
 */
export function cardRegions(vm) {
  const leaves = vm.quote.leaves
    ? `<div class="kv"><dt class="k">Leaves your Dusk account</dt><dd class="v"><span class="num">${html(vm.quote.leaves)}</span></dd></div>`
    : "";
  return {
    cta: `${vm.error ? `<p class="message error" role="alert">${html(vm.error)}</p>` : ""}${primaryControl(vm.button)}`,
    "from-foot": `<span>${html(vm.from.balanceLabel)}</span><span class="bal">${vm.from.balance ? `<span class="num">${html(vm.from.balance)}</span>` : ""}${vm.canMax ? '<button type="button" class="mini" data-action="max">Max</button>' : ""}</span>`,
    receive: html(vm.receive || "0"),
    "recipient-note": recipientNote(vm.to),
    route: `<summary>${icon("clock")}<span>${html(vm.routeLine)}</span>${icon("chev-d", "chev")}</summary>
      <dl class="kvs" aria-label="Quote"><div class="kv"><dt class="k">Steps</dt><dd class="v">${html(vm.steps)}</dd></div>${quoteRows({ rows: vm.quote.rows.filter((row) => !["send", "receive", "arrives"].includes(row.key)) })}${leaves}</dl>
      <p class="pubnote">${publicLine(vm.privacy)}</p>`,
  };
}

/**
 * Under the card, for whoever holds DUSK on Ethereum or BNB Smart Chain and
 * doesn't know to pick it as From: each chain a link that sets it.
 */
export function entryLine(entry) {
  if (!entry?.length) return "";
  const links = entry.map(({ href, name }) => `<a href="${html(href)}" aria-label="Move DUSK from ${html(name)} to Dusk">${html(name)}</a>`);
  const chains = links.length > 1 ? `${links.slice(0, -1).join(", ")} or ${links.at(-1)}` : links[0];
  return `<p class="entry">Have DUSK on ${chains}? Move it to Dusk.</p>`;
}

export function cardPage(vm) {
  const top = `<div class="bcard-top"><nav class="tabs" aria-label="Bridge and activity"><a class="tab" href="#/" ${vm.tab === "bridge" ? 'aria-current="page"' : ""}>Bridge</a><a class="tab" href="#/transfers" ${vm.tab === "activity" ? 'aria-current="page"' : ""}>Activity${vm.needsCount ? `<span class="cnt" aria-label="${vm.needsCount} need you">${vm.needsCount}</span>` : ""}</a></nav>${
    vm.tab === "bridge" ? `<button type="button" class="icon-btn tip" data-action="settings" aria-label="Recipient and gas" data-tip="Recipient and gas">${icon("sliders")}</button>` : ""
  }</div>`;
  // Each screen has its heading; the tabs show which one it is.
  if (vm.tab === "activity") return `<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">My transfers</h1><section class="bcard wide" aria-label="Activity">${top}${vm.activity}</section></main>`;
  const regions = cardRegions(vm);
  const notice = vm.notice
    ? `<div class="card notice-box" role="note"><div class="note">${icon(vm.notice.icon ?? "info")}<span>${vm.notice.html}</span></div>${vm.notice.actions ?? ""}</div>`
    : "";
  const from = `<div class="panel"><div class="panel-h"><span class="panel-l">From</span><div class="netsel">${netButton("from", vm.from.net, vm.menu === "from")}${vm.menu === "from" ? netMenu("from", vm.fromChoices) : ""}</div></div>
      <div class="amt-row"><input id="amount" name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0" value="${html(vm.amount)}" aria-label="Amount, in ${html(vm.unit)}" aria-describedby="amount-help amount-error"${vm.amountError ? ' aria-invalid="true"' : ""}><span class="token">${chainMark(vm.from.net.id)}${html(vm.unit)}</span></div>
      <div class="panel-f" id="amount-help" data-region="from-foot">${regions["from-foot"]}</div>
      <p class="field-error" id="amount-error" role="alert">${html(vm.amountError ?? "")}</p>
    </div>`;
  const flip = `<div class="flip-row"><button type="button" class="flip" data-action="flip" aria-label="Swap From and To"${vm.canFlip ? "" : ' disabled title="No route back"'}>${icon("arrow-d")}</button></div>`;
  // Under the field: what a typed name points to, the lookup, or the capitals' fix.
  const note = `<p class="small t2 rnote" id="recipient-note" data-region="recipient-note" aria-live="polite">${regions["recipient-note"]}</p>`;
  const recipient = vm.to.editing
    ? `<div class="recip-edit"><label class="panel-l" for="recipient">${html(vm.to.label)}</label><textarea id="recipient" name="recipient" class="mono-input wrap-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${html(vm.to.placeholder)}" aria-describedby="recipient-error recipient-note"${vm.to.error ? ' aria-invalid="true"' : ""}>${html(vm.to.input)}</textarea><p class="field-error" id="recipient-error" role="alert">${html(vm.to.error ?? "")}</p>${note}${vm.to.canReset ? '<button type="button" class="linkish" data-action="recipient-reset">Use my account</button>' : ""}</div>`
    : `<p class="recip">${vm.to.line} · <button type="button" class="linkish" data-action="recipient-edit">Change</button></p>${note}`;
  const to = `<div class="panel"><div class="panel-h"><span class="panel-l">To</span><div class="netsel">${netButton("to", vm.to.net, vm.menu === "to")}${vm.menu === "to" ? netMenu("to", vm.toChoices) : ""}</div></div>
      <div class="amt-row"><span class="out${vm.receive ? "" : " empty"}" data-region="receive">${regions.receive}</span><span class="token">${chainMark(vm.to.net.id)}${html(vm.receiveUnit)}</span></div>
      <div class="panel-f"><span>You receive</span></div>
      ${recipient}
    </div>`;
  return `<main class="swap" id="main" tabindex="-1"><h1 class="sr-only">Bridge DUSK</h1>
    <section class="bcard" aria-label="Bridge">${top}${notice}${from}${flip}${to}
      <details class="route" data-region="route"${vm.routeOpen ? " open" : ""}>${regions.route}</details>
      <div class="cta" data-region="cta">${regions.cta}</div>
    </section>${entryLine(vm.entry)}
  </main>`;
}

// ---------------------------------------------------------------------------
// Review sheet
// ---------------------------------------------------------------------------

// The top of a wallet's window: its title, the amount, to whom, and its tag.
function walletHead(head) {
  const to = head.to
    ? ` to <code class="mono" title="${html(head.toFull ?? head.to)}">${html(head.to)}</code>${head.where ? ` ${html(head.where)}` : ""}`
    : "";
  return `<div class="wlhd"><div class="wlt">${html(head.title)}</div>${head.amount || to ? `<div class="wlto">${head.amount ? `<span class="num">${html(head.amount)}</span>` : ""}${to}</div>` : ""}${head.sub ? `<div class="wlto">${html(head.sub)}</div>` : ""}${head.tag ? `<span class="tag">${icon("check")}${html(head.tag)}</span>` : ""}</div>`;
}

export function walletLines(lines, cfgLinks) {
  const head = lines.find((line) => line.kind === "head");
  const row = (line) => {
    const text = `<span class="${line.mono ? "mono wrap" : "num"}"${line.full ? ` title="${html(line.full)}"` : ""}>${html(line.value)}</span>`;
    const value = line.address
      ? `${line.value ? `<span class="wl-name">${html(line.value)}</span>` : ""}${fullValue({ explorer: cfgLinks.explorer(line.network, line.address), label: line.label, value: line.address })}`
      : line.suffix
        ? `<span>${text}<span class="t2"> · ${html(line.suffix)}</span></span>`
        : text;
    return `<div class="wl${line.gap ? " gap" : ""}"><dt>${html(line.label)}</dt><dd>${value}${line.note ? `<span class="wl-note">${html(line.note)}</span>` : ""}</dd></div>`;
  };
  const shown = lines.filter((line) => line.kind !== "head" && !line.fold);
  // What the window folds under Details: the function, the hash, the site's words.
  const folded = lines.filter((line) => line.fold);
  return `${head ? walletHead(head) : ""}<dl class="wls">${shown.map(row).join("")}</dl>${
    folded.length ? `<details class="wl-more"><summary>Details</summary><dl class="wls">${folded.map(row).join("")}</dl></details>` : ""
  }`;
}

// Before the steps: the DUSK goes to another account than the connected one.
const otherAccount = (text) =>
  `<div class="group pad warn-box" role="note"><div class="note">${icon("person")}<span><b>Another account gets this DUSK.</b> ${html(text)}</span></div></div>`;

// A proof's or a claim's review leads with what the step costs and what moves.
function actionLead(lead) {
  return `<div class="flow group lead"><div><div class="k">${html(lead.label)}</div><div class="v num">${html(lead.amount)}<span class="u">DUSK</span></div><div class="w">${lead.chain ? chainMark(lead.chain, "xs") : ""}<span>${html(lead.line)}</span></div></div></div>${lead.notYours ? otherAccount(lead.notYours) : ""}`;
}

export function reviewSheet(vm) {
  const checks = vm.checks.length
    ? `<ul class="ck" aria-label="Checked">${vm.checks
        .map((check) => `<li class="${check.ok ? "ok" : "bad"}">${icon(check.ok ? "check" : "info")}<span>${check.html}</span></li>`)
        .join("")}</ul>`
    : "";
  const steps = vm.steps
    .map(
      (step, index) => `<section class="req${step.current ? "" : " wait"}" aria-labelledby="req-${index}">
      <h3 id="req-${index}"><span class="no">${index + 1}</span>${html(step.title)}<span class="tag">${html(step.when)}</span></h3>
      ${step.what ? `<p>${step.what}</p>` : ""}
      ${step.custody ? `<p class="small t2">${html(step.custody)}</p>` : ""}
      <div class="wlh">${html(step.walletName)} will show</div>
      ${step.lines ? walletLines(step.lines, vm.cfgLinks) : `<p class="small t2">${html(step.linesNote ?? "Preparing…")}</p>`}
    </section>`,
    )
    .join("");
  return `<div class="sheet-head"><div><h2 id="sheet-title">Review</h2><p class="sub">${html(vm.sub)}</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close the review">${icon("close")}</button></div>
  <div class="sheet-body">
    ${vm.lead ? actionLead(vm.lead) : `<div class="flow group">
      <div><div class="k">You send</div><div class="v num">${html(vm.send.amount)}<span class="u">${html(vm.send.unit)}</span></div><div class="w">${chainMark(vm.send.chain, "xs")}${html(vm.send.where)}</div></div>
      <div class="dn" aria-hidden="true">${icon("back", "down")}</div>
      <div><div class="k">You receive</div><div class="v num">${html(vm.receive.amount)}<span class="u">${html(vm.receive.unit)}</span></div><div class="w">${chainMark(vm.receive.chain, "xs")}${html(vm.receive.where)}</div></div>
    </div>${vm.notYours ? otherAccount(vm.notYours) : ""}`}
    ${checks}
    <dl class="group kvs">${quoteRows({ rows: vm.feeRows })}</dl>
    ${steps}
    <p class="note">${icon("eye")}<span>${publicLine(vm.privacy)}</span></p>
  </div>
  <div class="sheet-foot">${vm.error ? `<p class="message error" role="alert">${html(vm.error)}</p>` : ""}<p class="hint">Check each line against ${html(vm.walletCheckName)}.</p><div class="btn-pair"><button type="button" class="btn sec" data-action="close-sheet">Cancel</button><button type="button" class="btn pri" data-action="confirm" ${vm.canConfirm ? "" : "disabled"}>${html(vm.confirmLabel)}</button></div>${vm.after ? `<p class="small t2">${html(vm.after)}</p>` : ""}</div>`;
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
      // The full hash is in Details; the step keeps a short one, with copy.
      const hash = step.hash ? `<span class="hashline"><code class="mono">${html(short(step.hash))}</code>${copyButton(step.hash, `${step.title} transaction hash`)}</span>` : "";
      return `<li class="step ${step.state}"><span class="mk" aria-hidden="true">${mark}</span><span class="tt">${html(step.title)}<span class="sr-only">, ${html(stateWord(step.state))}</span></span><span class="rt">${right}</span>${step.detail ? `<span class="ds">${html(step.detail)}</span>` : ""}${hash ? `<span class="ds">${hash}</span>` : ""}${step.action ?? ""}</li>`;
    })
    .join("")}</ol>`;
}

const stateWord = (state) =>
  ({ done: "done", failed: "failed", now: "in progress", todo: "not yet", turn: "your turn" })[state] ?? state;

export function receiptPage(vm) {
  if (vm.loading)
    return `<main class="col" id="main" tabindex="-1"><div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Transfer</h1></div><p class="t2" role="status">${html(vm.loading)}</p></main>`;
  if (vm.missing)
    return `<main class="col" id="main" tabindex="-1"><div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Transfer</h1></div><div class="group pad"><p>${html(vm.missing)}</p><p class="small t2"><code class="mono wrap">${html(vm.hash)}</code></p></div><p class="links-row"><a class="lnk" href="#/lookup">Look up another transfer ${icon("search")}</a></p></main>`;
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
      ? `<div class="action-box">${actionNeedsWallet(view.action.kind)}<span class="small t2">Dusk Wallet is a browser extension for computers.</span></div>`
      : view.action.blocked
        ? `<div class="action-box"><p class="note">${icon("info")}<span>${html(view.action.blocked)}</span></p></div>`
        : `<div class="action-box">${view.action.failure ? `<p class="message error">${html(view.action.failure)}</p>` : ""}<button type="button" class="btn pri" data-action="withdrawal-${view.action.kind}" data-id="${html(vm.id)}">${html(view.action.label)}</button><span class="small t2">${html(vm.actionFee ?? "")}</span></div>`
    : "";
  const details = vm.details
    .map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v">${row.html ?? `<span class="num">${html(row.value)}</span>`}</dd></div>`)
    .join("");
  const notes = vm.notes.map((note) => `<p class="note">${icon(note.icon ?? "info")}<span>${note.html}</span></p>`).join("");
  // The transfer and its steps on the left; its details in a panel beside
  // them, as the web wallet shows a transaction.
  return `<main class="page rc" id="main" tabindex="-1">
    <div class="rc-main">
      <div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a></div>
      <div class="hero">
        <div class="okc ${view.status}" aria-hidden="true">${view.status === "completed" ? icon("check") : view.status === "failed" ? icon("close") : pairMark(view.pair[0], view.pair[1])}</div>
        <h1 class="t">${html(view.title)}</h1>
        <p class="l">${vm.fromTo}</p>
        <div class="pl" role="status">${statusPill(view.status, view.statusWord)}<span class="cap">${html(vm.caption)}</span></div>
      </div>
      ${countdown}
      <section aria-labelledby="progress-h"><h2 class="gh" id="progress-h">Progress</h2><div class="group pad">${stepList(view.steps)}</div>${action}</section>
      ${notes}
      <div class="lk"><span>${icon("link")}Receipt link</span><code class="mono">${html(vm.url)}</code>${copyButton(vm.url, "receipt link")}</div>
      <p class="small t2">Anyone with the link can see this transfer.</p>
      <div class="bt"><a class="btn ${view.status === "completed" ? "pri" : "sec"}" href="#/">New transfer</a><a class="btn sec" href="#/transfers">My transfers</a></div>
    </div>
    <section class="rc-side" aria-labelledby="details-h"><h2 class="gh" id="details-h">Details</h2><dl class="kvs">${details}</dl></section>
  </main>`;
}

// ---------------------------------------------------------------------------
// My transfers
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
  if (!row.action) right = statusWord(row.status, row.statusWord) || `<span class="lnk">Receipt ${icon("chev-r")}</span>`;
  else if (!canAct) right = actionNeedsWallet(row.action.kind);
  // A claim waiting for the account that proved it: its receipt says which.
  else if (row.action.blocked) right = `<span class="tag">${icon("info")}Switch account to claim</span>`;
  else
    right = `<button type="button" class="btn pri xs" data-action="withdrawal-${row.action.kind}" data-id="${html(row.id)}">${html(row.action.kind === "prove" ? "Prove" : "Claim")}<span class="sr-only"> ${html(row.amountText)} from ${html(row.title)}</span></button>`;
  return `<li class="tr" data-status="${html(row.status)}"><a class="tr-link" href="${html(row.href)}" aria-label="${html(row.title)}, ${html(row.amountText)}, ${html(row.statusWord)}. Open the receipt"></a>${pairMark(row.pair[0], row.pair[1])}<div class="tr-main"><div class="t1">${html(row.title)}</div><div class="t2">${html(row.subline)}</div>${trackerBars(row.tracker)}</div><div class="rt"><span class="am num">${html(row.amountText)}</span>${right}</div></li>`;
}

/**
 * Without a connected Dusk account, as on a phone: follow one by its account
 * or .dusk name, read-only, or stop following it.
 */
function watchBlock(watch) {
  if (watch.following)
    return `<p class="small t2 watching">Following ${html(watch.following)}. <button type="button" class="linkish" data-action="unwatch">Stop following</button></p>`;
  return `<form class="group pad watch" data-form="watch">
      <label for="watch" class="l1">Follow a Dusk account</label>
      <textarea id="watch" name="watch" class="mono-input wrap-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="A Dusk account or .dusk name" aria-describedby="watch-error">${html(watch.input ?? "")}</textarea>
      <p class="field-error" id="watch-error" role="alert">${html(watch.error ?? "")}</p>
      <button type="submit" class="btn sec sm" ${watch.busy ? "disabled" : ""}>${watch.busy ? "Looking…" : "Show its transfers"}</button>
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
    : `${group("Needs you", vm.groups.needs)}${group("In progress", vm.groups.progress)}${group("Completed", vm.groups.done)}${group("Didn't go through", vm.groups.failed)}`;
  return `<div class="act">
    <div class="act-h"><p class="lede">${vm.lede}</p><a class="btn sec sm" href="#/lookup">${icon("search")}Look up</a></div>
    <p class="small t2 sync" role="status" aria-live="polite">${html(vm.syncText)}</p>
    ${vm.watch ? watchBlock(vm.watch) : ""}
    ${body}
    ${vm.more ? `<p class="links-row"><button type="button" class="btn sec sm" data-action="discover-more">Look further back</button></p>` : ""}
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
    <div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Look up a transfer</h1></div>
    <form class="group pad" data-form="lookup">
      <label for="lookup" class="l1">Transaction hash</label>
      <input id="lookup" name="lookup" class="mono-input" autocomplete="off" spellcheck="false" placeholder="The hash of the transaction you sent" value="${html(vm.query)}" aria-describedby="lookup-error">
      <p class="field-error" id="lookup-error" role="alert">${html(vm.error ?? "")}</p>
      <button type="submit" class="btn pri full" ${vm.busy ? "disabled" : ""}>${vm.busy ? "Looking…" : "Find the transfer"}</button>
    </form>
  </main>`;
}

// ---------------------------------------------------------------------------
// Sheets: contracts, network
// ---------------------------------------------------------------------------

export function contractsSheet(vm) {
  const groups = vm.groups
    .map((group) => {
      const rows = group.rows
        .map((row) =>
          row.network
            ? `<div class="crow"><div class="k">${html(row.label)}</div>${fullValue({ explorer: row.href, label: row.label, value: row.value })}${row.note ? `<p class="small t2">${html(row.note)}</p>` : ""}</div>`
            : `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v ${row.muted ? "t2" : "mono"}">${html(row.value)}</dd></div>`,
        )
        .join("");
      const operator = group.operator ? `<div class="kv"><dt class="k">Operated by</dt><dd class="v">${html(group.operator)}</dd></div>` : "";
      const docs = group.docs ? `<a class="lnk" href="${html(group.docs)}" target="_blank" rel="noreferrer">Guide ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>` : "";
      const note = group.note ? `<p class="small t2 gnote">${html(group.note)}</p>` : "";
      return `<section class="cgroup"><h3 class="gt">${html(group.title)}${docs}</h3>${note}<div class="group ${group.id === "networks" ? "kvs" : "crows"}">${rows}${operator}</div></section>`;
    })
    .join("");
  // Who runs it and on what terms, what the page reads from, then the
  // contracts and accounts of each route.
  const runBy = operatedBy(vm);
  const terms = termsLinks(vm.links ?? {});
  const about = runBy || terms.length ? `<p class="about-op">${[runBy ? `<span>${runBy}</span>` : "", ...terms].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>')}</p>` : "";
  const servers = vm.servers ? `<section class="cgroup"><h3 class="gt">Servers</h3><p class="card about-servers">${html(vm.servers)}</p></section>` : "";
  return `<div class="sheet-head"><div><h2 id="sheet-title">About this page · ${html(vm.badge)}</h2><p class="sub">Check these against your wallet before you confirm.</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div><div class="sheet-body">${about}${servers}${groups}</div>`;
}

export function networkSheet(vm) {
  const other = vm.otherSite
    ? `<a class="btn sec sm full" href="${html(vm.otherSite)}" rel="noreferrer">Go to the ${html(vm.otherName)} bridge ${icon("ext")}</a>`
    : "";
  const line = vm.isTestnet
    ? `Test DUSK only. ${vm.otherSite ? `Mainnet has its own bridge at ${html(vm.otherSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}.` : "Mainnet has its own bridge."}`
    : `Real DUSK. ${vm.otherSite ? `Testnet has its own bridge at ${html(vm.otherSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}.` : "Testnet has its own bridge."}`;
  return `<div class="sheet-head"><div><h2 id="sheet-title"><span class="net ${vm.isTestnet ? "test" : "main"} static"><span class="dot"></span>${html(vm.badge)}</span></h2><p class="sub">${line}</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div>
  <div class="sheet-body"><dl class="group kvs">${vm.networks.map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v ${row.muted ? "t2" : "mono"}">${html(row.value)}</dd></div>`).join("")}</dl>${other}</div>`;
}
