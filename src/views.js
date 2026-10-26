// The pages as HTML, from view models the controller builds. Calm and
// single-column: grouped surfaces, pill buttons, colour only where it means
// something (amber Pending, red Failed, violet Testnet, a green dot for
// Mainnet). Addresses and hashes are shown in full where they're checked,
// with a copy button and an explorer link, in a font without ligatures.

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

export function header(vm) {
  const net = `<button type="button" class="net ${vm.isTestnet ? "test" : "main"}" data-action="open-network" aria-haspopup="dialog" aria-label="Network: ${html(vm.badge)}. Show network details"><span class="dot"></span>${html(vm.badge)}${icon("chev-d")}</button>`;
  const count = vm.needsCount ? `<span class="cnt" aria-label="${vm.needsCount} need you">${vm.needsCount}</span>` : "";
  const nav = `<nav class="navs" aria-label="Pages"><a href="#/" ${vm.nav === "move" ? 'aria-current="page"' : ""}>Move DUSK</a><a href="#/transfers" ${vm.nav === "mine" ? 'aria-current="page"' : ""}>My transfers${count}</a></nav>`;
  const contracts = `<button type="button" class="hlink" data-action="open-contracts" aria-haspopup="dialog">${icon("doc")}Contracts</button>`;
  return `<header class="hdr"><div class="hdr-in">
    <a class="brand" href="#/" aria-label="Dusk Bridge, start">${GLYPH}<span>Dusk Bridge</span></a>
    ${net}
    ${nav}
    <div class="hdr-r">${contracts}${duskPill(vm.dusk)}${evmPill(vm.evm)}</div>
    <button type="button" class="menu-btn" data-action="toggle-menu" aria-expanded="${vm.menuOpen ? "true" : "false"}" aria-controls="menu" aria-label="Menu">${icon("menu")}</button>
  </div>
  <div id="menu" class="menu" ${vm.menuOpen ? "" : "hidden"}>
    <a href="#/">Move DUSK</a><a href="#/transfers">My transfers${count}</a><a href="#/lookup">Look up a transfer</a>
    <button type="button" data-action="open-contracts">Contracts and operators</button>
    <div class="menu-wallets">${duskPill(vm.dusk)}${evmPill(vm.evm)}</div>
  </div></header>`;
}

export function footer(vm) {
  const links = [
    `<button type="button" class="linkish" data-action="open-contracts">Contracts and operators</button>`,
    vm.links.docs ? `<a href="${html(vm.links.docs)}" target="_blank" rel="noreferrer">How the bridge works</a>` : "",
    vm.links.status ? `<a href="${html(vm.links.status)}" target="_blank" rel="noreferrer">Status</a>` : "",
    vm.links.terms ? `<a href="${html(vm.links.terms)}" target="_blank" rel="noreferrer">Terms</a>` : "",
    vm.links.privacy ? `<a href="${html(vm.links.privacy)}" target="_blank" rel="noreferrer">Privacy</a>` : "",
  ].filter(Boolean);
  const site = vm.officialSite ? `<span>Official site: ${html(vm.officialSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}</span>` : "";
  // Who runs each route, where that's configured.
  const operators = (vm.operators ?? []).map(({ name, route }) => `${html(name)} for ${html(route)}`);
  const runBy = operators.length ? `<p class="small t2 run-by">Run by ${operators.join(" · ")}.</p>` : "";
  return `<footer class="foot"><nav aria-label="About the bridge">${links.join("")}</nav>${site}${runBy}</footer>`;
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

export function landing(vm) {
  const rows = vm.tasks
    .map((task) => {
      const tag = task.phoneTag
        ? `<span class="tag${task.phoneTag.ok ? " ok" : ""}">${icon(task.phoneTag.ok ? "phone" : "laptop")}${html(task.phoneTag.text)}</span>`
        : "";
      if (task.unavailable)
        return `<li class="row off"><span class="pair-wrap">${pairMark(task.pair[0], task.pair[1])}</span><div><div class="tt">${html(task.title)}</div><div class="sb">${html(task.unavailable)}</div></div></li>`;
      return `<li><a class="row" href="#/move/${html(task.id)}">${pairMark(task.pair[0], task.pair[1])}<div><div class="tt">${html(task.title)}</div><div class="sb">${html(task.what)}</div><div class="sb">${html(task.meta)}</div>${tag ? `<div class="sb">${tag}</div>` : ""}</div>${icon("chev-r", "chev")}</a></li>`;
    })
    .join("");
  const phone = vm.phone
    ? `<div class="group pad note-box"><div class="note">${icon("phone")}<span><b>On this phone</b> you can move old DUSK with a mobile EVM wallet and follow your transfers. Dusk Wallet is a browser extension for computers, so sending from Dusk happens there.</span></div><div class="btn-row"><button type="button" class="btn sec sm" data-copy="${html(vm.pageUrl)}" aria-label="Copy this page's link">${icon("link")}Copy link</button>${vm.canShare ? `<button type="button" class="btn sec sm" data-action="share">${icon("share")}Share link</button>` : ""}</div></div>`
    : "";
  const wallets = `<h2 class="sec-t">Wallets you'll need</h2><ul class="group list">
    <li class="row w">${chainMark("dusk")}<div><div class="tt">Dusk Wallet</div><div class="sb">To send from Dusk, and to prove and claim. The official Dusk browser extension.</div></div>${vm.dusk.state === "connected" ? '<span class="t2 small">Connected</span>' : vm.dusk.state === "missing" ? `<a class="btn sec sm" href="${html(vm.dusk.getUrl)}" target="_blank" rel="noreferrer">Get it ${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>` : '<button type="button" class="btn sec sm" data-action="connect-dusk">Connect</button>'}</li>
    <li class="row w"><span class="cm">${icon("wallet")}</span><div><div class="tt">An EVM wallet</div><div class="sb">MetaMask, Rabby or similar. For old DUSK and for DuskEVM.</div></div>${vm.evm.state === "connected" ? '<span class="t2 small">Connected</span>' : '<button type="button" class="btn sec sm" data-action="connect-evm">Connect</button>'}</li>
  </ul>`;
  return `<main class="col" id="main" tabindex="-1">
    <h1>What do you want to do?</h1>
    <p class="lede">Pick a task. You see the cost and the time before anything is sent.</p>
    ${phone}
    <ul class="group list tasks">${rows}</ul>
    ${wallets}
    <p class="links-row"><a href="#/transfers" class="lnk strong">Sent something before? My transfers ${icon("chev-r")}</a><a href="#/lookup" class="lnk">Look up a transfer ${icon("search")}</a></p>
  </main>`;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function quoteRows(quote) {
  return quote.rows
    .map(
      (row) =>
        `<div class="kv${row.strong ? " total" : ""}"><dt class="k">${html(row.label)}</dt><dd class="v"><span class="stack"><span class="num">${html(row.value)}</span>${row.detail ? `<span class="small">${html(row.detail)}</span>` : ""}</span></dd></div>`,
    )
    .join("");
}

export function quoteBlock(vm) {
  const leaves = vm.quote.leaves ? `<p class="small t2 leaves">Leaves your Dusk account: <span class="num">${html(vm.quote.leaves)}</span></p>` : "";
  const first = vm.firstTime ? `<p class="hint">First time? Try a small amount first.</p>` : "";
  return `<dl class="group kvs" aria-label="Quote">${quoteRows(vm.quote)}</dl>${leaves}${first}`;
}

function accountRow({ balance, chain, label, value, valueNote, wallet }) {
  return `<div class="group acc">${chainMark(chain)}<div class="acc-main"><div class="l1">${html(label)}</div><div class="l2">${value}${valueNote ? ` <span class="t2 small">${html(valueNote)}</span>` : ""}</div>${wallet ? `<div class="small t2">${wallet}</div>` : ""}</div>${balance ? `<div class="r">${balance}</div>` : ""}</div>`;
}

const availability = (vm) =>
  vm.available
    ? `<span>${html(vm.availableLabel ?? "Available")} <span class="num">${html(vm.available)}</span></span>${vm.canMax ? '<button type="button" class="mini" data-action="max">Max</button>' : ""}`
    : `<span>${html(vm.availableNote ?? "")}</span>`;

/**
 * The parts of the form that follow balances, prices, the amount and the
 * recipient. The page renders each in a `data-region` and replaces them all
 * when anything changes, so none goes stale while someone types.
 */
export function formRegions(vm) {
  return {
    avail: availability(vm),
    from: accountRow(vm.from),
    privacy: html(vm.privacy),
    quote: quoteBlock(vm),
    "review-hint": html(vm.reviewHint ?? ""),
  };
}

export function formPage(vm) {
  const regions = formRegions(vm);
  const head = `<div class="topbar"><a class="bk" href="#/">${icon("back")}All tasks</a><h1 class="ti">${html(vm.title)}</h1><span></span></div>`;
  const pick = vm.sources.length > 1
    ? `<div class="seg" role="radiogroup" aria-label="Old DUSK on">${vm.sources
        .map((source) => `<label class="seg-opt"><input type="radio" name="source" value="${html(source.id)}" ${source.id === vm.routeId ? "checked" : ""}><span>${html(source.name)}</span></label>`)
        .join("")}</div>`
    : "";
  const notice = vm.notice ? `<div class="group pad notice-box" role="note"><div class="note">${icon(vm.notice.icon ?? "info")}<span>${vm.notice.html}</span></div>${vm.notice.actions ?? ""}</div>` : "";
  const from = `<div data-region="from">${regions.from}</div>`;
  const amount = `<div class="amount-field"><label for="amount" class="amount-label">Amount</label><div class="bigamt${vm.amountError ? " invalid" : ""}"><input id="amount" name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0" value="${html(vm.amount)}" aria-describedby="amount-help amount-error"${vm.amountError ? ' aria-invalid="true"' : ""}><span class="u">${html(vm.unit)}</span></div><div class="avail" id="amount-help" data-region="avail">${regions.avail}</div>${vm.balanceNote ? `<p class="small t2 center">${html(vm.balanceNote)}</p>` : ""}<p class="field-error" id="amount-error" role="alert">${html(vm.amountError ?? "")}</p></div>`;
  const to = vm.to.editing
    ? `<div class="group acc edit">${chainMark(vm.to.chain)}<div class="acc-main"><label class="l1" for="recipient">${html(vm.to.label)}</label><input id="recipient" name="recipient" class="mono-input" autocomplete="off" spellcheck="false" placeholder="${html(vm.to.placeholder)}" value="${html(vm.to.input)}" aria-describedby="recipient-error"${vm.to.error ? ' aria-invalid="true"' : ""}><p class="field-error" id="recipient-error" role="alert">${html(vm.to.error ?? "")}</p></div>${vm.to.canReset ? '<button type="button" class="linkish" data-action="recipient-reset">Use my account</button>' : ""}</div>`
    : accountRow({
        chain: vm.to.chain,
        label: vm.to.label,
        value: vm.to.name
          ? `<span>${html(vm.to.name)}</span>`
          : vm.to.value
            ? `<code class="mono">${html(short(vm.to.value))}</code>`
            : `<span class="t2">${html(vm.to.empty)}</span>`,
        valueNote: vm.to.valueNote,
        balance: `<button type="button" class="linkish" data-action="recipient-edit">Change</button>`,
      });
  const button = `<button type="button" class="btn pri full" data-action="review" ${vm.canReview ? "" : "disabled"}>${html(vm.reviewLabel)}</button>`;
  return `<main class="col" id="main" tabindex="-1">${head}${pick}${notice}${from}${amount}${to}<div data-region="quote">${regions.quote}</div>
    <p class="note">${icon("eye")}<span><b>Public.</b> <span data-region="privacy">${regions.privacy}</span> The bridge works with public balances only. Seeing them doesn't let anyone move your DUSK.</span></p>
    ${vm.error ? `<p class="message error" role="alert">${html(vm.error)}</p>` : ""}
    <div class="cta-bar">${button}<p class="small t2 center" data-region="review-hint">${regions["review-hint"]}</p></div>
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

// A proof's or a claim's review leads with what the step costs and what moves.
function actionLead(lead) {
  return `<div class="flow group lead"><div><div class="k">${html(lead.label)}</div><div class="v num">${html(lead.amount)}<span class="u">DUSK</span></div><div class="w">${lead.chain ? chainMark(lead.chain, "xs") : ""}<span>${html(lead.line)}</span></div></div></div>${lead.notYours ? `<p class="note">${icon("info")}<span>${html(lead.notYours)}</span></p>` : ""}`;
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
      <p>${step.what}</p>
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
    </div>`}
    ${checks}
    <dl class="group kvs">${quoteRows({ rows: vm.feeRows })}</dl>
    ${steps}
    <p class="note">${icon("eye")}<span><b>Public.</b> ${html(vm.privacy)}</span></p>
    ${vm.late ? `<p class="note">${icon("info")}<span>${vm.late}</span></p>` : ""}
  </div>
  <div class="sheet-foot">${vm.error ? `<p class="message error" role="alert">${html(vm.error)}</p>` : ""}<p class="hint">Check each line against ${html(vm.walletCheckName)} before you confirm.</p><div class="btn-pair"><button type="button" class="btn sec" data-action="close-sheet">Cancel</button><button type="button" class="btn pri" data-action="confirm" ${vm.canConfirm ? "" : "disabled"}>${html(vm.confirmLabel)}</button></div>${vm.after ? `<p class="small t2">${html(vm.after)}</p>` : ""}</div>`;
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
    return `<main class="col" id="main" tabindex="-1"><div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Transfer</h1><span></span></div><p class="t2 center" role="status">${html(vm.loading)}</p></main>`;
  if (vm.missing)
    return `<main class="col" id="main" tabindex="-1"><div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Transfer</h1><span></span></div><div class="group pad"><p>${html(vm.missing)}</p><p class="small t2"><code class="mono wrap">${html(vm.hash)}</code></p></div><p class="links-row"><a class="lnk" href="#/lookup">Look up another transfer ${icon("search")}</a></p></main>`;
  const view = vm.view;
  const countdown = view.countdown
    ? `<div class="group count"><div><div class="k">You can claim in</div><div class="v">${html(view.countdown.left)}</div><div class="s">${view.countdown.exact ? "" : "About "}${html(view.countdown.atText)}${view.countdown.clockNote ? ` (${html(view.countdown.clockNote)})` : ""}</div></div><button type="button" class="btn sec sm" data-action="calendar">${icon("calendar")}Add to calendar</button></div>`
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
  return `<main class="rc" id="main" tabindex="-1">
    <div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><span></span><span></span></div>
    <div class="hero">
      <div class="okc ${view.status}" aria-hidden="true">${view.status === "completed" ? icon("check") : view.status === "failed" ? icon("close") : pairMark(view.pair[0], view.pair[1])}</div>
      <h1 class="t">${html(view.title)}</h1>
      <p class="l">${vm.fromTo}</p>
      <div class="pl" role="status">${statusPill(view.status, view.statusWord)}<span class="cap">${html(vm.caption)}</span></div>
    </div>
    ${countdown}
    <div class="grid">
      <section aria-labelledby="progress-h"><h2 class="gh" id="progress-h">Progress</h2><div class="group pad">${stepList(view.steps)}</div>${action}</section>
      <section aria-labelledby="details-h"><h2 class="gh" id="details-h">Details</h2><dl class="group kvs">${details}</dl></section>
    </div>
    ${notes}
    <div class="lk"><span>${icon("link")}Receipt link</span><code class="mono">${html(vm.url)}</code>${copyButton(vm.url, "receipt link")}</div>
    <p class="small t2 center">Anyone with this link can see this transfer. It is public on both networks anyway.</p>
    <div class="bt"><a class="btn ${view.status === "completed" ? "pri" : "sec"}" href="#/">New transfer</a><a class="btn sec" href="#/transfers">My transfers</a></div>
  </main>`;
}

// ---------------------------------------------------------------------------
// My transfers
// ---------------------------------------------------------------------------

function trackerBars(tracker) {
  if (!tracker) return "";
  return `<div class="trk" aria-hidden="true">${tracker
    .map((part) => `<div class="${part.state}"><i></i><span>${html(part.label)}</span></div>`)
    .join("")}</div><span class="sr-only">${tracker.map((part) => `${part.label}: ${stateWord(part.state)}`).join(", ")}</span>`;
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

export function transfersPage(vm) {
  const group = (title, rows) =>
    rows.length
      ? `<h2 class="sec-t">${html(title)}</h2><ul class="group list trs">${rows.map((row) => transferRow(row, { canAct: vm.canAct !== false })).join("")}</ul>`
      : "";
  const body = vm.empty
    ? `<div class="group pad empty"><p>${html(vm.empty)}</p>${vm.emptyActions ?? ""}</div>`
    : `${group("Needs you", vm.groups.needs)}${group("In progress", vm.groups.progress)}${group("Completed", vm.groups.done)}${group("Didn't go through", vm.groups.failed)}`;
  return `<main class="tp" id="main" tabindex="-1">
    <div class="tp-h"><div><h1>My transfers</h1><p class="lede">${vm.lede}</p></div><a class="btn sec sm" href="#/lookup">${icon("search")}Look up</a></div>
    <p class="small t2" role="status" aria-live="polite">${html(vm.syncText)}</p>
    ${body}
    ${vm.more ? `<p class="links-row"><button type="button" class="btn sec sm" data-action="discover-more">Look further back</button></p>` : ""}
  </main>`;
}

// ---------------------------------------------------------------------------
// Look up
// ---------------------------------------------------------------------------

export function lookupPage(vm) {
  return `<main class="col" id="main" tabindex="-1">
    <div class="topbar"><a class="bk" href="#/transfers">${icon("back")}My transfers</a><h1 class="ti">Look up a transfer</h1><span></span></div>
    <form class="group pad" data-form="lookup">
      <label for="lookup" class="l1">Transaction hash</label>
      <input id="lookup" name="lookup" class="mono-input" autocomplete="off" spellcheck="false" placeholder="The hash of the transaction you sent" value="${html(vm.query)}" aria-describedby="lookup-help lookup-error">
      <p class="small t2" id="lookup-help">From Dusk, DuskEVM or the old-token chain: the transaction that started the transfer. The page finds its route.</p>
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
      return `<section class="cgroup"><h3 class="gt">${html(group.title)}${docs}</h3><div class="group ${group.id === "networks" ? "kvs" : "crows"}">${rows}${operator}</div></section>`;
    })
    .join("");
  return `<div class="sheet-head"><div><h2 id="sheet-title">Contracts and operators · ${html(vm.badge)}</h2><p class="sub">Check these against your wallet before you confirm.</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close contracts">${icon("close")}</button></div><div class="sheet-body">${groups}</div>`;
}

export function networkSheet(vm) {
  const other = vm.otherSite
    ? `<a class="btn sec sm full" href="${html(vm.otherSite)}" rel="noreferrer">Go to the ${html(vm.otherName)} bridge ${icon("ext")}</a>`
    : "";
  const line = vm.isTestnet
    ? `Test DUSK only. ${vm.otherSite ? `Mainnet has its own bridge at ${html(vm.otherSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}.` : "Mainnet has its own bridge."}`
    : `Real DUSK. ${vm.otherSite ? `Testnet has its own bridge at ${html(vm.otherSite.replace(/^https?:\/\//u, "").replace(/\/$/u, ""))}.` : "Testnet has its own bridge."}`;
  return `<div class="sheet-head"><div><h2 id="sheet-title"><span class="net ${vm.isTestnet ? "test" : "main"} static"><span class="dot"></span>${html(vm.badge)}</span></h2><p class="sub">${line}</p></div><button type="button" class="icon-btn round" data-action="close-sheet" aria-label="Close">${icon("close")}</button></div>
  <div class="sheet-body"><p class="small t2">Your EVM wallet should show these networks when it asks.</p><dl class="group kvs">${vm.networks.map((row) => `<div class="kv"><dt class="k">${html(row.label)}</dt><dd class="v ${row.muted ? "t2" : "mono"}">${html(row.value)}</dd></div>`).join("")}</dl>${other}</div>`;
}
