// The bridge page: a start page of tasks, one form per task with its quote,
// a review sheet that lists what each wallet will show, a receipt per
// transfer at its own link, and My transfers read from the networks.
// Chain state comes from the deployment's own node and RPCs; the wallets
// are asked only for accounts, signatures and sends.

import { topGap } from "@dusk-network/app-core/history";
import { toDuskName } from "@duskdomains/sdk/names";

import { entryId, readActivity, recordActivity, saveActivity, updateActivity, useActivityNetwork } from "./activity.js";
import { NOTICE_WORDS, createArrivalNotice } from "./arrival-notice.js";
import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";
import { cardRoute, choosePair, entryRoutes, flipRoute, followsWallets, fromChoices, handedOverRecipient, primaryButton, routeBetween, toChoices } from "./bridge-card.js";
import { claimReminder } from "./calendar.js";
import { showCopied } from "./copied.js";
import { config } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { followAfterDiscovery, mergeTransfer, mergeTransfers, partyKey } from "./discovery.js";
import { createDiscoveryRuns } from "./discovery-runs.js";
import { depositRequest } from "./dusk-deposit.js";
import { createDuskConnection, ensureDuskConnected, sendDuskContractCall, sendDuskTransfer } from "./dusk-wallet.js";
import { duskEvmNetwork, submitDuskEvmWithdrawal } from "./duskevm-withdrawal.js";
import { connectEvmWallet, ensureEvmChain, getEvmState, initializeEvmWallet, subscribeEvmWallet } from "./evm-wallet.js";
import { createFormReads } from "./form-reads.js";
import { amountForInput, formatLux, formatDuskPlain } from "./format.js";
import { approveMigration, submitMigration } from "./legacy-migration.js";
import { bridgeTasks, chainName, linkedRoute, networkName, networkNames, notRunning, routeUnits, tokenName } from "./names.js";
import {
  actionLead,
  actionPrivacy,
  balanceLine,
  pricedReview,
  recipientLine,
  DUSK_WALLET_URL,
  evmWalletName,
  receiptModel,
  reviewChecks,
  routeLine,
  routeSteps,
  transfersModel,
} from "./page-models.js";
import { canonicalHash, moveHref, parseLocation, quotesOn, receiptUrl, transferHref } from "./permalink.js";
import { buildQuote, parseAmount, withdrawalStepMax } from "./quote.js";
import { serviceTransferRequest } from "./service-transfer.js";
import { createServices, proofSubmitterFor } from "./services.js";
import { createLookupFlow } from "./lookup-flow.js";
import { createReceiptLookups } from "./receipt-lookups.js";
import { createRouteStatus, statusLine } from "./route-status.js";
import { arrivalDue, routeTime } from "./route-times.js";
import { checkDuskRecipient, checkEvmRecipient, settledEvmRecipient } from "./recipient.js";
import { readWatched, saveWatched, watchTarget } from "./watched-account.js";
import { SIGNER_MOVED, createReviewSession, notSent, sameSigner, sentActionPatch } from "./review-session.js";
import { createScheduler, takenByAnother } from "./tracking.js";
import { CONNECT_CANCELLED, CONTRACT_RECIPIENT, actionErrorOf, friendlyWalletError, walletCancelled, html, privacyLine, proverMismatch, short, switchToProver, transferView } from "./transfer-view.js";
import {
  activityPanel,
  cardPage,
  cardRegions,
  contractsSheet,
  copyFaces,
  footer,
  header,
  lookupPage,
  networkSheet,
  receiptPage,
  reviewSheet,
  strip,
  unavailablePage,
  walletsSheet,
} from "./views.js";
import { approveLines, duskCallLines, duskTransferLines, migrateLines, withdrawLines } from "./wallet-lines.js";

const WEI_PER_LUX = 1_000_000_000n;
// Per visit: about two months of a sparse Dusk history, and about 25 days of
// DuskEVM blocks (100,000 per request); "Look further back" carries on.
const DISCOVERY_REQUESTS = { dusk: 6, evm: 12 };
const DISCOVERY_FRESH_MS = 60_000;

const isPhone = () =>
  Boolean(
    globalThis.matchMedia?.("(pointer: coarse) and (hover: none)").matches ||
      /Android|iPhone|iPad|Mobile/u.test(globalThis.navigator?.userAgent ?? ""),
  );

export function createAppController(root, { cfg = config, routes = bridgeRoutes, services = createServices() } = {}) {
  const names = networkNames(cfg);
  const tasks = bridgeTasks(cfg, routes);
  const routeOf = (id) => routes.find((route) => route.id === id) ?? getBridgeRoute(id);
  // This network's transfers only, whatever else this site served before.
  useActivityNetwork(cfg.profile);
  const state = {
    activity: readActivity(),
    dusk: null,
    duskState: { installed: false, selectedProfile: null },
    evmState: getEvmState(),
    form: null,
    lookup: { busy: false, error: "", query: "" },
    page: parseLocation(globalThis.location?.hash),
    sheet: null,
    // A Dusk account followed without a wallet, and its form on My transfers.
    watch: { busy: false, error: "", input: "" },
    watching: readWatched(cfg.profile),
  };
  const duskState = () => state.dusk?.state ?? state.duskState;
  const duskAccount = () => duskState().selectedProfile?.account ?? "";
  // The Dusk account My transfers lists: the connected one, or else the followed one.
  const listedDusk = () => duskAccount() || state.watching?.account || "";
  // The profile's .dusk name: the one Dusk Wallet sends once it checked the
  // name points back to the account (Dusk Connect passes on only a canonical
  // .dusk name), or else the account's verified primary name, looked up
  // through this page's node.
  const namesFound = new Map();
  const namesAsked = new Set();
  const duskName = () => duskState().selectedProfile?.name || namesFound.get(duskAccount()) || "";
  function lookUpName(account) {
    if (!account || namesFound.has(account) || namesAsked.has(account) || duskState().selectedProfile?.name || !services.names) return;
    // Asked once at a time; a failed lookup is asked again on the next change.
    namesAsked.add(account);
    services.names
      .primaryName(account)
      .then((name) => {
        namesFound.set(account, name);
        if (!name || account !== duskAccount()) return;
        renderChrome();
        if (isCardPage()) refreshFormAndHeader();
        else renderMain();
      })
      .catch(() => {})
      .finally(() => namesAsked.delete(account));
  }
  const evmAccount = () => state.evmState.account ?? "";
  const tracked = new Set();
  /** Draws again what quotes a fee or a time: the card's parts, or the page. Look up quotes neither. */
  function requote() {
    if (!quotesOn(state.page)) return;
    if (isCardPage()) refreshForm();
    else renderMain();
  }
  // Balances and gas for the form; an older answer never overwrites a newer
  // one. A gas price read again is quoted at once.
  const formReads = createFormReads({ onChange: () => refreshFormAndHeader(), onPrice: () => requote(), services });
  // One gas price for every "up to" fee on the page, and for the requests its
  // reviews send: the node's, as last read.
  const duskGasPrice = () => formReads.reads.gasPrice ?? 1n;
  /** Reads the gas price again; the page is drawn again where it moved. */
  const refreshPrice = () => formReads.price();
  // Says when a transfer ends to whoever isn't looking. A phone's browser can't notify from a page.
  const arrivals = createArrivalNotice({
    available: () => !isPhone(),
    onOpen: (href) => {
      globalThis.location.hash = href;
    },
  });
  // How the card's route is doing. It's only said: nothing waits for it.
  const routeStatus = createRouteStatus({ onChange: () => refreshForm(), read: (route) => services.status(route) });
  // The review on screen; a request prepared for it fills nothing else.
  const reviews = createReviewSession();
  // How long each route takes on this network: what the chains said, and
  // what this browser's own transfers took. Every page reads it from here.
  const timing = () => ({ chain: services.times?.get() ?? null, transfers: state.activity });
  /** Asks the chains again where it's been a while, and shows the page again if a time moved. */
  function refreshTimes() {
    services.times
      ?.refresh()
      .then((moved) => {
        if (moved) requote();
      })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Layout: slots that render on their own, so typing is never interrupted.
  // -------------------------------------------------------------------------

  root.innerHTML = `<button type="button" class="skip" data-action="skip">Skip to content</button><div data-slot="strip"></div><div data-slot="header"></div><div class="page-slot" data-slot="main"></div><div data-slot="footer"></div><dialog class="sheet" data-slot="sheet" aria-labelledby="sheet-title"></dialog><div class="sr-only" aria-live="polite" data-slot="live"></div>`;
  const slot = (name) => root.querySelector(`[data-slot="${name}"]`);
  const dialog = slot("sheet");
  let sheetOpener = null;

  function announce(text) {
    const live = slot("live");
    live.textContent = "";
    setTimeout(() => {
      live.textContent = text;
    }, 50);
  }

  // -------------------------------------------------------------------------
  // View models
  // -------------------------------------------------------------------------

  function duskVm() {
    const current = duskState();
    if (!current.installed) return { getUrl: DUSK_WALLET_URL, state: "missing" };
    if (duskAccount()) return { account: duskAccount(), name: duskName(), state: "connected" };
    return { state: current.authorized ? "locked" : "connect" };
  }

  const evmVm = () =>
    evmAccount()
      ? { account: evmAccount(), chainName: chainName(cfg, state.evmState.chainId), state: "connected", walletName: state.evmState.walletName }
      : { state: "connect" };

  const accounts = () => [listedDusk(), evmAccount()].filter(Boolean);

  function transfersVm() {
    return transfersModel(state.activity, { account: duskAccount(), accounts: accounts(), cfg, name: duskName(), owner: listedDusk(), routeOf, submitter: proofSubmitterFor(duskAccount()), timing: timing() });
  }

  function headerVm() {
    const other = cfg.profile === "testnet" ? "mainnet" : "testnet";
    const page = state.page.page;
    return {
      badge: names.badge,
      dusk: duskVm(),
      evm: evmVm(),
      isTestnet: cfg.profile === "testnet",
      needsCount: transfersVm().needs,
      otherName: other === "mainnet" ? "Mainnet" : "Testnet",
      otherSite: cfg.links.sites[other],
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderChrome() {
    const vm = headerVm();
    slot("strip").innerHTML = strip(vm);
    slot("header").innerHTML = header(vm);
    slot("footer").innerHTML = footer({
      links: {
        // The guide for this network's main route: migration on Mainnet, DuskEVM on Testnet.
        docs: cfg.profile === "testnet" && cfg.duskEvm.enabled ? cfg.links.docs.duskEvm : cfg.links.docs.migration,
        privacy: cfg.links.privacy,
        status: cfg.links.status,
        terms: cfg.links.terms,
      },
      officialSite: cfg.links.sites[cfg.profile],
    });
  }

  /** Re-renders the page, keeping focus and the caret where they were. */
  // An address field grows to show the whole address: its end is what people compare.
  function fitHeight(field) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + 2}px`;
  }

  /** What finds a control again once the page is drawn anew: its id, or everything its data says. */
  function controlSelector(control) {
    if (control?.id) return `[id=${JSON.stringify(control.id)}]`;
    if (!control?.dataset?.action) return "";
    return [...control.attributes]
      .filter(({ name }) => name.startsWith("data-"))
      .map(({ name, value }) => `[${name}=${JSON.stringify(value)}]`)
      .join("");
  }

  let drawn = "";
  function renderMain({ focus = false } = {}) {
    const next = pageHtml();
    // A receipt is looked at again every few seconds: when nothing changed, it
    // stays as it is, with keyboard focus and a screen reader's place in it.
    if (!focus && next === drawn && state.page.page === "transfer") return;
    drawn = next;
    const active = globalThis.document?.activeElement;
    const selector = controlSelector(active);
    const keep = active && slot("main").contains(active) && selector ? { selector, start: active.selectionStart, end: active.selectionEnd } : null;
    slot("main").innerHTML = next;
    for (const field of slot("main").querySelectorAll(".wrap-input")) fitHeight(field);
    if (keep) {
      // Only the same control: another with the same action could do something else.
      const matches = slot("main").querySelectorAll(keep.selector);
      const again = matches.length === 1 ? matches[0] : null;
      if (again) {
        again.focus();
        try {
          if (keep.start !== null && keep.start !== undefined) again.setSelectionRange(keep.start, keep.end);
        } catch {}
      }
    } else if (focus) slot("main").querySelector("#main")?.focus({ preventScroll: false });
  }

  function render(options) {
    renderChrome();
    renderMain(options);
    if (state.sheet) renderSheet();
  }

  function pageHtml() {
    const { page } = state.page;
    if (page === "transfer") return receiptHtml();
    if (page === "lookup") return lookupPage(state.lookup);
    if (page === "move" && !linkFor(state.page.task)) return unavailablePage({ title: unavailableTitle(state.page.task) });
    // The card: its Bridge tab, or its Activity tab for My transfers.
    return cardHtml(page === "transfers" ? "activity" : "bridge");
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------

  /** The route a link names: by its ID, one of the three routes, or an earlier name. */
  const linkFor = (name) => linkedRoute(name, tasks, routes);

  /** Why a link opens no card: DuskEVM not on this network yet, or no such route here. */
  const unavailableTitle = (id) =>
    ["duskevm", "to-duskevm", "from-duskevm", "dusk-to-dusk-evm", "dusk-evm-to-dusk"].includes(id) && !cfg.duskEvm.enabled
      ? `${names["dusk-evm"]} isn't on ${names.badge} yet`
      : `This bridge doesn't offer that on ${names.badge}`;

  /**
   * The card's state. A link to a route opens it on that route, with the
   * Dusk recipient the link hands over, once, as the page opens (`follow`):
   * after that the card keeps whatever is picked. The card otherwise opens
   * on the pair the connected wallets suggest. A link to a route that isn't
   * here opens none.
   */
  function ensureCard(page = state.page, { follow = false } = {}) {
    const linked = page?.page === "move" ? linkFor(page.task) : null;
    if (!state.form) {
      const route = cardRoute(page, tasks, routes, { dusk: Boolean(duskAccount()), evm: Boolean(evmAccount()) });
      if (!route) return null;
      state.form = {
        amount: "",
        error: "",
        // A recipient handed over in the link, while it's the one shown.
        handedOver: "",
        // What each .dusk name typed as the recipient pointed to when looked up.
        lookups: {},
        menu: null,
        pairChosen: Boolean(linked),
        recipientEditing: false,
        recipientInput: "",
        routeId: route.id,
        routeOpen: false,
      };
      handOver(page, route);
    } else if (follow && linked) {
      setPair(linked);
      handOver(page, linked);
    }
    return state.form;
  }

  /**
   * The Dusk recipient a link hands over: filled in and shown as "Paying …"
   * until it's changed. Connecting Dusk Wallet doesn't replace it.
   */
  function handOver(page, route) {
    const to = handedOverRecipient(page, route);
    if (!to || !state.form) return;
    state.form.recipientInput = to;
    state.form.recipientEditing = false;
    state.form.handedOver = to;
  }

  /** Moves the card to `route`: its reads start again, and a typed recipient of the other kind goes. */
  function setPair(route, { chosen = true } = {}) {
    const form = state.form;
    if (!route || !form) return;
    form.menu = null;
    form.pairChosen ||= chosen;
    if (route.id === form.routeId) return;
    const before = routeOf(form.routeId);
    form.routeId = route.id;
    form.error = "";
    if (before?.to.kind !== route.to.kind) {
      form.recipientInput = "";
      form.recipientEditing = false;
    }
    formReads.reset(["migration", "l2"]);
    void loadReads();
    lookUpRecipientCode();
  }

  /** Before anything was picked or typed, the card follows the wallets as they connect. */
  function followWallets() {
    const form = state.form;
    if (!followsWallets(form)) return;
    const route = cardRoute({ page: "home" }, tasks, routes, { dusk: Boolean(duskAccount()), evm: Boolean(evmAccount()) });
    if (route && route.id !== form.routeId) setPair(route, { chosen: false });
  }

  const formRoute = () => (state.form ? routeOf(state.form.routeId) : null);

  /** The typed recipient, checked: its address, a .dusk name's account, or why it isn't one. */
  function typedRecipient(route, form = state.form) {
    const typed = form?.recipientInput?.trim();
    if (!typed) return null;
    if (route.to.kind === "dusk") return checkDuskRecipient(typed, form.lookups);
    const network = cfg.evmNetworks[route.to.id];
    return checkEvmRecipient(typed, { bridgeContracts: [network?.tokenContract, network?.migrationContract] });
  }

  /**
   * Where the transfer goes: the typed recipient's address, or the connected
   * account on that side. EVM addresses in their checksummed form, so every
   * line names them the same way the wallet does.
   */
  function destinationFor(route, form = state.form) {
    const typed = typedRecipient(route, form);
    if (typed) return typed.address ?? "";
    if (route.to.kind === "dusk") return duskAccount();
    return evmAccount() ? checkEvmRecipient(evmAccount()).address ?? evmAccount() : "";
  }

  /** A Dusk account's .dusk name in what's said public: the connected one's, or a typed name's. */
  const duskPartyName = (account, typed = null) =>
    !account ? "" : account === duskAccount() ? duskName() : typed?.name && typed.address === account ? typed.name : "";

  function destinationError(route) {
    return typedRecipient(route)?.error ?? "";
  }

  let codeTimer = null;
  /** An EVM recipient typed is looked at, a moment after typing stops: a contract is said. */
  function lookUpRecipientCode() {
    clearTimeout(codeTimer);
    const form = state.form;
    const route = formRoute();
    const address = route?.to.kind === "evm" ? typedRecipient(route)?.address : null;
    const key = `${route?.to.id}:${address}`;
    if (!address || !form || form.codes?.[key] !== undefined || !services.evmReads?.hasCode) return;
    codeTimer = setTimeout(() => {
      services.evmReads
        .hasCode(route.to.id, address)
        .then((contract) => {
          form.codes = { ...form.codes, [key]: contract };
          if (state.form !== form) return;
          refreshForm();
          // A review opened before the answer came: it says so too.
          const review = reviews.current;
          if (contract && review?.paysTo === address && state.sheet === "review") {
            review.notYours = CONTRACT_RECIPIENT;
            renderSheet();
          }
        })
        .catch(() => {});
    }, 300);
  }

  /** Whether where a route pays is known to be a contract. */
  const paysContract = (route, destination) => route.to.kind === "evm" && state.form?.codes?.[`${route.to.id}:${destination}`] === true;

  let nameTimer = null;
  /** A .dusk name typed as the Dusk recipient is looked up, a moment after typing stops. */
  function lookUpRecipientName() {
    clearTimeout(nameTimer);
    const form = state.form;
    const route = formRoute();
    // The typed .dusk name, as Dusk Domains spells it, where it can be one.
    const name = toDuskName(form?.recipientInput ?? "");
    if (!route || route.to.kind !== "dusk" || !name || !services.names) return;
    const known = form.lookups[name];
    // An answer is used for a minute; a failed lookup is tried again.
    if (known && !known.failed && Date.now() - known.at < 60_000) return;
    nameTimer = setTimeout(() => {
      services.names
        .resolveName(name)
        .then(
          (found) => ({ ...found, at: Date.now() }),
          () => ({ at: Date.now(), failed: true }),
        )
        .then((found) => {
          form.lookups[name] = found;
          if (state.form !== form || form.recipientInput.trim().toLowerCase() !== name) return;
          refreshForm();
          loadGasSoon();
        });
    }, 300);
  }

  function quoteFor(route) {
    const reads = formReads.reads;
    if (route.signer === "dusk")
      return buildQuote(route, state.form.amount, { balance: reads.duskBalance, cfg, gasPrice: reads.gasPrice, timing: timing() });
    if (route.mode === "migration") {
      const migration = reads.migration ?? {};
      return buildQuote(route, state.form.amount, {
        allowanceWei: migration.allowanceWei ?? 0n,
        balance: migration.balanceWei ?? null,
        cfg,
        evmGas: { approve: migration.gas?.approve, migrate: migration.gas?.migrate, priceWei: migration.gasPriceWei },
        timing: timing(),
      });
    }
    const l2 = reads.l2 ?? {};
    return buildQuote(route, state.form.amount, {
      balance: l2.balanceWei ?? null,
      cfg,
      evmGas: { priceWei: l2.gasPriceWei, withdraw: l2.gas },
      gasPrice: reads.gasPrice,
      timing: timing(),
    });
  }

  function signerReady(route) {
    return route.signer === "dusk" ? Boolean(duskAccount()) : Boolean(evmAccount());
  }

  /** The chain an EVM wallet signs `route` on. */
  const signingChain = (route) => (route.from.id === "dusk-evm" ? duskEvmNetwork() : cfg.evmNetworks[route.from.id]);

  /** The chain to switch to: where the wallet that signs `route` says it's on another. Else "". */
  function switchTo(route) {
    const on = state.evmState.chainId;
    return route.signer === "evm" && evmAccount() && on && on !== signingChain(route)?.chainId ? networkName(cfg, route.from.id) : "";
  }

  const netOf = (id) => ({ id, name: networkName(cfg, id) });

  /** The card's networks to choose from, with DuskEVM shown as not live yet where it isn't. */
  function networkChoices(side, route) {
    const nameOf = (id) => networkName(cfg, id);
    const paused = notRunning(cfg);
    const choices = side === "from" ? fromChoices(routes, route.from.id, nameOf, paused) : toChoices(routes, route.from.id, route.to.id, nameOf, paused);
    const listed = choices.map((choice) => ({
      ...choice,
      name: nameOf(choice.id),
      note: choice.route ? routeLine(choice.route, cfg, { gasPrice: duskGasPrice(), timing: timing() }) : "",
    }));
    if (!cfg.duskEvm.enabled) listed.push({ disabled: `Not on ${names.badge} yet`, id: "dusk-evm", name: names["dusk-evm"] });
    return listed;
  }

  function cardVm() {
    const route = formRoute();
    const quote = quoteFor(route);
    const to = networkName(cfg, route.to.id);
    const reads = formReads.reads;
    const walletName = evmWalletName(state.evmState);
    const phoneOnly = isPhone() && !duskState().installed;
    // ERC20 or BEP20 DUSK on Ethereum and BNB Smart Chain, DUSK on Dusk and DuskEVM.
    const { receive: receiveUnit, send: unit } = routeUnits(route);
    // What the source holds: the public balance on Dusk, the wallet's on an EVM chain.
    const holdings = route.signer === "dusk" ? reads.duskBalance : route.mode === "migration" ? reads.migration?.balanceWei : reads.l2?.balanceWei;
    const balance = balanceLine(route, holdings);
    const destination = destinationFor(route);
    const typed = typedRecipient(route);
    // A typed .dusk name, once its lookup found the account it points to.
    const resolved = typed?.name && typed.address ? { address: typed.address, name: typed.name } : null;
    const destinationIsOwn =
      route.to.kind === "dusk" ? destination && destination === duskAccount() : destination && destination.toLowerCase() === evmAccount().toLowerCase();
    const line = recipientLine(route, {
      connected: Boolean(duskAccount()),
      destination,
      duskName: duskName(),
      // A recipient the link handed over, as long as it's the one typed.
      handedOver: Boolean(state.form.handedOver) && state.form.recipientInput === state.form.handedOver,
      own: Boolean(destinationIsOwn),
      resolved,
      walletName,
    });
    const toVm = {
      canReset: Boolean(state.form.recipientInput) && Boolean(route.to.kind === "dusk" ? duskAccount() : evmAccount()),
      editing: state.form.recipientEditing || (!destination && Boolean(state.form.recipientInput)),
      error: typed?.error ?? "",
      fix: typed?.fix ?? "",
      input: state.form.recipientInput,
      // "alice" for alice.dusk, as the wallets offer it.
      suggest: typed?.suggest ?? "",
      label: `Recipient on ${to}`,
      line,
      looking: typed?.pending ? typed.name : "",
      net: netOf(route.to.id),
      placeholder: route.to.kind === "dusk" ? "A Dusk account or .dusk name" : "0x…",
      resolved,
      contract: paysContract(route, destination),
    };
    let notice = null;
    if (route.paused) notice = { html: `${html(notRunning(cfg))}.`, icon: "info" };
    else if (route.signer === "dusk" && phoneOnly)
      notice = {
        actions: `<div class="btn-row"><button type="button" class="btn sec sm" data-copy="${html(globalThis.location?.href ?? "")}" aria-label="Copy this page's link">${copyFaces("Copy link", "Copied")}</button>${globalThis.navigator?.share ? '<button type="button" class="btn sec sm" data-action="share">Share link</button>' : ""}</div>`,
        html: "This needs Dusk Wallet on a computer.",
        icon: "laptop",
      };
    else if (route.mode === "duskevm-withdrawal" && phoneOnly)
      notice = { html: "Step 1 works here. Prove and claim need Dusk Wallet on a computer.", icon: "phone" };
    const button = primaryButton({
      amountError: quote.error,
      amountLux: quote.amountLux,
      connectsRecipient: route.to.kind === "evm" && !evmAccount() && !state.form.recipientInput,
      destination,
      destinationError: toVm.error,
      duskInstalled: duskState().installed,
      insufficient: Boolean(quote.insufficient),
      looking: toVm.looking,
      phoneOnly,
      route,
      signerConnected: signerReady(route),
      switchTo: switchTo(route),
      switching: Boolean(state.form.switching),
      unit,
    });
    return {
      amount: state.form.amount,
      amountError: quote.insufficient ? "" : quote.error,
      button: { ...button, href: DUSK_WALLET_URL },
      canFlip: Boolean(flipRoute(routes, route)),
      canMax: quote.maxLux !== null && quote.maxLux !== undefined && quote.maxLux > 0n,
      // DUSK on Ethereum or BNB Smart Chain, for whoever doesn't know to pick it as From.
      entry: entryRoutes(routes, route).map((item) => ({ href: moveHref(item.id), name: networkName(cfg, item.from.id) })),
      error: state.form.error,
      from: { balance: balance.text, balanceExact: balance.exact, balanceLabel: route.signer === "dusk" ? "Public balance" : "Balance", net: netOf(route.from.id) },
      fromChoices: state.form.menu === "from" ? networkChoices("from", route) : [],
      menu: state.form.menu,
      needsCount: transfersVm().needs,
      notice,
      privacy: privacyLine(route, cfg, {
        dusk: route.to.kind === "dusk" ? destination : duskAccount(),
        evm: route.to.kind === "dusk" ? evmAccount() : destination,
        name: duskPartyName(route.to.kind === "dusk" ? destination : duskAccount(), resolved),
      }),
      quote,
      receive: quote.receiveLux !== null && quote.receiveLux > 0n ? formatLux(quote.receiveLux) : "",
      receiveUnit,
      routeLine: routeLine(route, cfg, { gasPrice: duskGasPrice(), timing: timing() }),
      routeOpen: state.form.routeOpen,
      status: statusLine(routeStatus.get(route), { amountLux: quote.amountLux }),
      steps: routeSteps(route, quote),
      tab: "bridge",
      to: toVm,
      toChoices: state.form.menu === "to" ? networkChoices("to", route) : [],
      unit,
    };
  }

  function cardHtml(tab) {
    const form = ensureCard();
    if (tab === "activity") return cardPage({ activity: activityHtml(), needsCount: transfersVm().needs, tab: "activity" });
    if (!form) return unavailablePage({ title: unavailableTitle("") });
    return cardPage(cardVm());
  }

  /**
   * Brings the card up to date without touching its inputs: every region the
   * view declares (balance and Max, what arrives, the route, the button), and
   * the amount's and the recipient's errors.
   */
  function refreshForm() {
    if (!isCardPage() || !state.form || !slot("main").querySelector(".bcard [data-region]")) return;
    const main = slot("main");
    const vm = cardVm();
    for (const [name, markup] of Object.entries(cardRegions(vm))) {
      const region = main.querySelector(`[data-region="${name}"]`);
      if (region && region.innerHTML !== markup) region.innerHTML = markup;
    }
    main.querySelector('[data-region="receive"]')?.classList.toggle("empty", !vm.receive);
    const error = main.querySelector("#amount-error");
    if (error) error.textContent = vm.amountError ?? "";
    const amount = main.querySelector("#amount");
    if (amount) {
      if (vm.amountError) amount.setAttribute("aria-invalid", "true");
      else amount.removeAttribute("aria-invalid");
    }
    const recipientError = main.querySelector("#recipient-error");
    if (recipientError) recipientError.textContent = vm.to.error ?? "";
    const recipient = main.querySelector("#recipient");
    if (recipient) {
      if (vm.to.error) recipient.setAttribute("aria-invalid", "true");
      else recipient.removeAttribute("aria-invalid");
    }
  }

  const isCardPage = () => state.page.page === "home" || (state.page.page === "move" && Boolean(linkFor(state.page.task)));

  /** Balances and prices for the form's route, from the node and the chains. */
  function loadReads() {
    const route = formRoute();
    if (!route) return undefined;
    routeStatus.open(route);
    return formReads.load({ dusk: duskAccount(), evm: evmAccount(), gas: gasInputs(route), route });
  }

  /** What gas estimates need: the amount in wei and the Dusk recipient. */
  function gasInputs(route) {
    const { lux } = parseAmount(state.form?.amount);
    const recipient = destinationFor(route);
    const valid = recipient && !destinationError(route);
    if (route.mode === "migration") return { amountWei: (lux ?? 1n) * WEI_PER_LUX, duskAccount: valid ? recipient : undefined };
    return lux && valid ? { amountWei: lux * WEI_PER_LUX, duskAccount: recipient } : {};
  }

  let gasTimer = null;
  /** Gas estimates follow the amount, a moment after typing stops. */
  function loadGasSoon() {
    clearTimeout(gasTimer);
    gasTimer = setTimeout(() => {
      const route = formRoute();
      if (route) void formReads.estimate({ evm: evmAccount(), gas: gasInputs(route), route });
    }, 400);
  }

  function refreshFormAndHeader() {
    renderChrome();
    if (isCardPage()) {
      const main = slot("main");
      // While the amount has focus, its regions are replaced around it.
      if (!main.contains(globalThis.document?.activeElement) || globalThis.document?.activeElement?.id !== "amount") renderMain();
      else refreshForm();
    }
  }

  // -------------------------------------------------------------------------
  // Transfers: the kept list, tracking and discovery
  // -------------------------------------------------------------------------

  function setActivity(list) {
    const before = new Map(state.activity.map((entry) => [entry.id, entry.status]));
    state.activity = list;
    for (const entry of list) {
      const previous = before.get(entry.id);
      if (previous && previous !== entry.status && entry.status !== "pending") {
        const route = routeOf(entry.routeId);
        if (route) {
          const { title } = transferView(entry, { cfg, route });
          announce(`${title}.`);
          arrivals.ended({ href: transferHref(entry.hash), id: entry.id, title });
        }
      }
    }
  }

  async function checkEntry(id) {
    const entry = state.activity.find((item) => item.id === id);
    const route = entry && routeOf(entry.routeId);
    if (!entry || !route) return null;
    try {
      const patch = await services.tracking.refresh(entry, route, { others: state.activity });
      const parties = [...new Set([...(entry.parties ?? []), patch.sender, patch.destination].filter(Boolean).map(partyKey))];
      // Checks run side by side: a payout another transfer took meanwhile
      // isn't this one's. It's looked for again on the next check.
      setActivity(
        takenByAnother(entry, patch, state.activity)
          ? updateActivity(id, { lastCheckedAt: Date.now() })
          : updateActivity(id, { ...patch, lastCheckedAt: Date.now(), parties, trackingError: null }),
      );
    } catch (error) {
      setActivity(updateActivity(id, { lastCheckedAt: Date.now(), trackingError: error instanceof Error ? error.message : String(error) }));
    }
    renderChrome();
    if (state.page.page === "transfers" || (state.page.page === "transfer" && canonicalHash(entry.hash) === state.page.hash)) renderMain();
    return state.activity.find((item) => item.id === id) ?? null;
  }
  const scheduler = createScheduler({
    check: checkEntry,
    // Its receipt on screen, around when it usually arrives: checked every 5
    // seconds, so the receipt says it arrived soon after it did.
    due: (entry) => {
      const route = routeOf(entry.routeId);
      return state.page.page === "transfer" && canonicalHash(entry.hash) === state.page.hash && Boolean(route) && arrivalDue(route, routeTime(route, cfg, timing()), entry);
    },
  });

  function track(id, { delay = 0 } = {}) {
    if (delay) setTimeout(() => scheduler.track(id), delay);
    else scheduler.track(id);
    tracked.add(id);
  }

  function addEntry(entry) {
    const id = entryId(entry.routeId, entry.hash);
    const existing = state.activity.find((item) => item.id === id);
    setActivity(recordActivity(mergeTransfer(existing, { ...entry, createdAt: entry.createdAt ?? new Date().toISOString(), id })));
    track(id);
    return id;
  }

  // Discovery for the connected accounts, one run at a time; an account
  // changed during a run is read right after it.
  const discoveryRuns = createDiscoveryRuns({
    accounts: () => ({ dusk: listedDusk() || null, evm: evmAccount() || null }),
    freshMs: DISCOVERY_FRESH_MS,
    onChange: () => {
      renderChrome();
      if (state.page.page === "transfers") renderMain();
    },
    read: async (who) => {
      const found = await services.discovery.discover({
        dusk: who.dusk,
        duskRequests: DISCOVERY_REQUESTS.dusk,
        evm: who.evm,
        evmRequests: DISCOVERY_REQUESTS.evm,
      });
      const known = new Set(state.activity.map((entry) => entry.id));
      setActivity(saveActivity(mergeTransfers(state.activity, found.entries)));
      // New or unfinished transfers are followed, a little apart.
      let delay = 0;
      for (const entry of state.activity)
        if (followAfterDiscovery(entry, { known, tracked })) {
          track(entry.id, { delay });
          delay += 250;
        }
      return { errors: found.errors, sources: found.sources };
    },
  });
  const discover = (options) => discoveryRuns.run(options);

  /** Follows a Dusk account, or a .dusk name's account, without a wallet. */
  async function watchAccount(input) {
    if (state.watch.busy) return;
    state.watch = { busy: true, error: "", input: String(input ?? "") };
    renderMain();
    const found = await watchTarget(input, { resolveName: (name) => (services.names ? services.names.resolveName(name) : Promise.reject(new Error("names"))) });
    if (found.error) {
      state.watch = { busy: false, error: found.error, input: String(input ?? "") };
      if (state.page.page === "transfers") renderMain();
      return;
    }
    state.watching = found;
    state.watch = { busy: false, error: "", input: "" };
    saveWatched(cfg.profile, found);
    discoveryRuns.expire();
    void discover();
    if (state.page.page === "transfers") renderMain();
  }

  function activityHtml() {
    const vm = transfersVm();
    const watching = !duskAccount() && state.watching ? state.watching : null;
    const who = [
      duskAccount()
        ? `Dusk account ${duskName() ? html(duskName()) : `<code class="mono">${html(short(duskAccount()))}</code>`}`
        : watching
          ? `Dusk account ${watching.name ? `${html(watching.name)} (<code class="mono">${html(short(watching.account))}</code>)` : `<code class="mono">${html(short(watching.account))}</code>`}`
          : "",
      evmAccount() ? `<code class="mono">${html(short(evmAccount()))}</code>` : "",
    ].filter(Boolean);
    const discovery = discoveryRuns.state;
    const sources = discovery.sources;
    const more = Object.values(sources).some((source) => source?.covered && topGap(source.covered, source.target ?? 0));
    let syncText = "";
    if (discovery.running) syncText = "Reading the networks…";
    else if (discovery.errors.length) syncText = "Some networks didn't answer. It tries again on your next visit.";
    const groups = vm.groups;
    const empty = vm.count
      ? ""
      : who.length
        ? discovery.running
          ? "Looking for transfers…"
          : "No transfers yet."
        : "Connect a wallet or follow a Dusk account to see its transfers.";
    return activityPanel({
      canAct: duskState().installed,
      empty,
      emptyActions: who.length ? "" : `<div class="btn-row">${duskState().installed ? '<button type="button" class="btn sec sm" data-action="connect-dusk">Connect Dusk Wallet</button>' : ""}<button type="button" class="btn sec sm" data-action="connect-evm">Connect EVM wallet</button></div>`,
      groups,
      lede: who.length ? `${who.join(" and ")}.` : "",
      more: more && !discovery.running,
      syncing: discovery.running,
      syncText,
      // Without a connected Dusk account: follow one by its account or .dusk name.
      watch: duskAccount() ? null : { ...state.watch, following: watching ? watching.name || short(watching.account) : "" },
    });
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  // Dusk hashes go without 0x and EVM ones with it; a pasted or linked hash
  // may carry either, so they're compared without it.
  const bareHash = (hash) => canonicalHash(hash)?.replace(/^0x/u, "") ?? null;

  function entryForHash(hash) {
    const value = bareHash(hash);
    return (value && state.activity.find((entry) => bareHash(entry.hash) === value)) ?? null;
  }

  // A receipt opened by its hash alone: the transfer is looked up, and looked
  // up again while nothing knows it yet.
  const receiptLookups = createReceiptLookups({
    isOpen: (hash) => state.page.page === "transfer" && state.page.hash === hash,
    onChange: (hash) => {
      if (state.page.page === "transfer" && state.page.hash === hash) renderMain();
    },
    onFound: (found, hash) => {
      addEntry({ followed: true, hash: found.hash, routeId: found.routeId });
      // A payout's hash opens the migration it paid: its receipt is the migration's.
      if (bareHash(found.hash) !== bareHash(hash)) globalThis.location.replace(transferHref(found.hash));
      else if (state.page.page === "transfer") renderMain();
    },
    resolve: (hash) => services.resolve(hash),
  });

  async function openReceipt(hash) {
    const entry = entryForHash(hash);
    if (entry) {
      if (entry.status === "pending" || !entry.status) track(entry.id);
      return;
    }
    await receiptLookups.open(hash);
  }

  function receiptHtml() {
    const hash = state.page.hash;
    const entry = entryForHash(hash);
    if (!entry) {
      const lookup = receiptLookups.get(hash);
      if (lookup?.missing) return receiptPage({ hash, missing: lookup.missing });
      return receiptPage({ loading: "Finding this transfer on the networks…" });
    }
    const route = routeOf(entry.routeId);
    if (!route) return receiptPage({ hash, missing: "This transfer's route isn't on this network's bridge." });
    return receiptPage({
      ...receiptModel(entry, { cfg, gasPrice: duskGasPrice(), own: { account: duskAccount(), name: duskName() }, owner: listedDusk(), route, submitter: proofSubmitterFor(duskAccount()), timing: timing(), url: receiptUrl(entry.hash) }),
      canAct: duskState().installed,
      notice: arrivals.state(),
    });
  }

  /** Draws the receipt's line about being told again, with focus on what took the press's place. */
  function showNotice() {
    renderMain();
    const line = root.querySelector("#notify");
    (line?.querySelector("button") ?? line)?.focus();
    const words = NOTICE_WORDS[arrivals.state()];
    if (words) announce(words);
  }

  // -------------------------------------------------------------------------
  // Sheets
  // -------------------------------------------------------------------------

  function openSheet(kind, opener) {
    // A step of its own in the history: a phone's Back closes the review, not the page.
    if (kind === "review" && state.sheet !== "review" && !globalThis.history?.state?.reviewSheet) {
      globalThis.history?.pushState?.({ reviewSheet: true }, "");
    }
    state.sheet = kind;
    sheetOpener = opener ?? globalThis.document?.activeElement ?? null;
    renderSheet();
    if (!dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    dialog.querySelector(".sheet-body")?.scrollTo?.(0, 0);
    const first = dialog.querySelector("[data-autofocus]") ?? dialog.querySelector("h2");
    if (first) {
      first.setAttribute("tabindex", "-1");
      first.focus();
    }
  }

  /** Closed by hand: the review's step in the history goes too. */
  function closeByPerson() {
    closeSheet();
    if (globalThis.history?.state?.reviewSheet) globalThis.history.back();
  }

  function closeSheet() {
    if (reviews.current?.busy) return;
    state.sheet = null;
    reviews.end();
    if (dialog.open) dialog.close?.();
    dialog.removeAttribute("open");
    dialog.innerHTML = "";
    dialog.className = "sheet";
    if (sheetOpener?.isConnected) sheetOpener.focus();
    sheetOpener = null;
  }

  function renderSheet() {
    if (state.sheet === "contracts") {
      dialog.className = "sheet wide";
      dialog.innerHTML = contractsSheet({
        badge: names.badge,
        groups: contractGroups(cfg),
        links: { privacy: cfg.links.privacy, terms: cfg.links.terms },
        servers: serversLine(cfg),
      });
    } else if (state.sheet === "network") {
      const other = cfg.profile === "testnet" ? "mainnet" : "testnet";
      dialog.className = "sheet narrow";
      dialog.innerHTML = networkSheet({
        badge: names.badge,
        isTestnet: cfg.profile === "testnet",
        networks: contractGroups(cfg)[0].rows,
        otherName: other === "mainnet" ? "Mainnet" : "Testnet",
        otherSite: cfg.links.sites[other],
      });
    } else if (state.sheet === "review" && reviews.current) {
      dialog.className = "sheet wide";
      dialog.innerHTML = reviewSheet(reviewVm());
    } else if (state.sheet === "wallets") {
      dialog.className = "sheet narrow";
      dialog.innerHTML = walletsSheet({ wallets: state.dusk?.choices ?? [] });
    }
  }

  // -------------------------------------------------------------------------
  // Review and send
  // -------------------------------------------------------------------------

  const explorerFor = { explorer: (network, address) => explorerAddressUrl(cfg, network, address) };

  // A review is for the account it was opened with. When the wallet switches,
  // confirming would sign as another, so the review says so and can't be confirmed.
  const signerNow = (wallet) => (wallet === "evm" ? evmAccount() : duskAccount());
  function signerMoved(review) {
    if (!review?.signer || sameSigner(review, signerNow(review.signer.wallet))) return false;
    review.stale = true;
    review.error = SIGNER_MOVED[review.signer.wallet];
    return true;
  }

  function reviewVm() {
    const review = reviews.current;
    const route = routeOf(review.routeId);
    const walletName = route.signer === "dusk" || review.kind !== "send" ? "Dusk Wallet" : evmWalletName(state.evmState);
    const step = review.steps[review.current];
    return {
      after: review.after ?? "",
      canConfirm: !review.busy && !review.stale && Boolean(step?.lines) && review.checks.every((check) => check.ok),
      cfgLinks: explorerFor,
      checks: review.checks,
      // On another chain, it's asked for first, as the card does.
      confirmLabel: review.busy ? `Waiting for ${walletName}…` : (review.kind === "send" && switchTo(route) ? `Switch to ${switchTo(route)}` : step?.confirmLabel) ?? "Confirm",
      error: review.error,
      feeRows: review.feeRows,
      lead: review.lead ?? null,
      notYours: review.notYours ?? "",
      privacy: review.privacy,
      receive: review.receive,
      send: review.send,
      steps: review.steps.map((item, index) => ({ ...item, current: index === review.current })),
      sub: review.sub,
      walletCheckName: walletName === "Dusk Wallet" ? "Dusk Wallet" : walletName === "your EVM wallet" ? "your wallet" : walletName,
    };
  }

  async function openReview(opener) {
    const route = formRoute();
    if (!route) return;
    if (!signerReady(route)) {
      await (route.signer === "dusk" ? connectDusk(opener) : connectEvm());
      return;
    }
    const quote = quoteFor(route);
    const destination = destinationFor(route);
    if (quote.amountLux === null || quote.error || !destination || destinationError(route)) return;
    const from = networkName(cfg, route.from.id);
    const to = networkName(cfg, route.to.id);
    const lux = quote.amountLux;
    const walletName = evmWalletName(state.evmState);
    const amountText = formatLux(lux);
    const checks = reviewChecks(route, { cfg, destination, duskAccount: duskAccount(), evm: state.evmState, quote, reads: formReads.reads });
    const base = {
      checks,
      error: "",
      feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
      kind: "send",
      // A contract, or DUSK paid to another Dusk account than the connected one: said before the steps.
      paysConnected: route.to.kind === "evm" && evmAccount() && destination === checkEvmRecipient(evmAccount()).address ? destination : "",
      paysTo: destination,
      notYours: paysContract(route, destination)
        ? CONTRACT_RECIPIENT
        : route.to.kind === "dusk" && duskAccount() && destination !== duskAccount()
          ? `This pays ${typedRecipient(route)?.name ?? short(destination)}${typedRecipient(route)?.name ? ` (${short(destination)})` : ""}, not ${duskName() || "your connected Dusk account"}.`
          : "",
      privacy: privacyLine(route, cfg, {
        dusk: route.to.kind === "dusk" ? destination : duskAccount(),
        evm: route.to.kind === "dusk" ? evmAccount() : destination,
        name: duskPartyName(route.to.kind === "dusk" ? destination : duskAccount(), typedRecipient(route)),
      }),
      receive: {
        amount: formatLux(quote.receiveLux ?? lux),
        chain: route.to.id,
        unit: routeUnits(route).receive,
        where: `${to} · ${
          route.to.kind === "dusk" && destination === duskAccount() && duskName()
            ? duskName()
            : typedRecipient(route)?.name
              ? `${typedRecipient(route).name} · ${short(destination)}`
              : short(destination)
        }`,
      },
      routeId: route.id,
      send: {
        amount: amountText,
        chain: route.from.id,
        unit: routeUnits(route).send,
        where: `${from} · ${route.signer === "dusk" ? duskName() || short(duskAccount()) : short(evmAccount())}`,
      },
      signer: { account: signerNow(route.signer), wallet: route.signer },
      amountLux: lux,
      destination,
    };
    if (route.mode === "migration") {
      const network = route.from.id;
      const migration = formReads.reads.migration ?? {};
      const needsApproval = (migration.allowanceWei ?? 0n) < lux * WEI_PER_LUX;
      const gasPrice = migration.gasPriceWei ?? null;
      const fee = (gas) => (gasPrice && gas ? gas * gasPrice : null);
      const steps = [];
      if (needsApproval)
        steps.push({
          confirmLabel: `Approve ${amountText} ${tokenName(network)} in ${walletName === "your EVM wallet" ? "your wallet" : walletName}`,
          lines: approveLines({ amountLux: lux, cfg, fee: fee(migration.gas?.approve), network }),
          title: `Approve exactly ${amountText} ${tokenName(network)}`,
          walletName,
          what: `Lets the Dusk migration contract take <b>exactly ${html(amountText)} ${html(tokenName(network))}</b> from <code class="mono">${html(short(evmAccount()))}</code>.`,
        });
      steps.push({
        confirmLabel: `Migrate ${amountText} DUSK`,
        lines: migrateLines({ amountLux: lux, cfg, duskAccount: destination, fee: fee(migration.gas?.migrate), network }),
        title: "Migrate",
        walletName,
        what: `Locks the ${html(tokenName(network))} in the migration contract. The bridge then pays <b>${html(amountText)} DUSK</b> to <code class="mono">${html(short(destination))}</code> on Dusk.`,
      });
      reviews.start({
        ...base,
        after: needsApproval ? "Step 2 opens when the approval is confirmed." : "",
        current: 0,
        steps,
        sub: `${tokenName(network)} on ${from} to Dusk${steps.length === 2 ? ` · ${walletName === "your EVM wallet" ? "your wallet" : walletName} asks you twice` : ""}`,
      });
      openSheet("review", opener);
      return;
    }
    if (route.mode === "duskevm-withdrawal") {
      const l2 = formReads.reads.l2 ?? {};
      reviews.start({
        ...base,
        after: "Then prove and claim on Dusk, with Dusk Wallet.",
        current: 0,
        steps: [
          {
            confirmLabel: `Send ${amountText} DUSK in ${walletName === "your EVM wallet" ? "your wallet" : walletName}`,
            lines: withdrawLines({ amountLux: lux, cfg, duskAccount: destination, fee: l2.gas && l2.gasPriceWei ? l2.gas * l2.gasPriceWei : null }),
            title: `Send on ${from}`,
            walletName,
          },
        ],
        sub: `${from} to Dusk · step 1 of 3`,
      });
      openSheet("review", opener);
      return;
    }
    // From Dusk: the request is built now and sent as reviewed.
    const review = reviews.start({
      ...base,
      current: 0,
      steps: [
        {
          confirmLabel: route.mode === "duskevm-deposit" ? `Send ${amountText} DUSK to ${to}` : `Send ${amountText} DUSK`,
          lines: null,
          linesNote: "Preparing the request…",
          title: "Send from Dusk",
          walletName: "Dusk Wallet",
          // A payout goes through the bridge's own account: the wallet shows it as the recipient.
          what:
            route.mode === "service-transfer"
              ? `Sends <b>${html(amountText)} DUSK</b> to the bridge account, with your ${html(to)} address as the memo. The bridge pays it out.`
              : "",
        },
      ],
      sub: `Dusk to ${to}`,
    });
    openSheet("review", opener);
    await reviews.fill(
      review,
      async () => {
        // At the price the page quoted: the review and the request say the same fee.
        const request =
          route.mode === "duskevm-deposit"
            ? await depositRequest({ amountLux: lux, gasPrice: duskGasPrice(), node: services.node, recipient: destination })
            : await serviceTransferRequest({ amountLux: lux, destination, gasPrice: duskGasPrice(), node: services.node });
        const lines =
          route.mode === "duskevm-deposit"
            ? await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: duskAccount(), fromName: duskName(), note: "The DuskEVM bridge contract on Dusk." })
            : duskTransferLines({ amountLux: request.amountLux, chainId: cfg.dusk.chainId, from: duskAccount(), fromName: duskName(), gas: request.gas, memo: request.memo, to: request.to });
        return { lines, request };
      },
      ({ lines, request }) => {
        review.request = request;
        review.steps[0] = { ...review.steps[0], lines };
        // The fee rows and the balance check at the request's price, so
        // Confirm waits if the balance no longer covers it.
        Object.assign(
          review,
          pricedReview(route, {
            amount: state.form.amount,
            cfg,
            destination,
            duskAccount: duskAccount(),
            evm: state.evmState,
            gasPrice: BigInt(request.gas.price),
            reads: formReads.reads,
            timing: timing(),
          }),
        );
      },
      (error) => {
        review.error = friendlyWalletError(error, "dusk");
      },
    );
    if (state.sheet === "review" && reviews.current === review) renderSheet();
  }

  async function openActionReview(id, kind, opener) {
    const entry = state.activity.find((item) => item.id === id);
    const route = entry && routeOf(entry.routeId);
    if (!entry || !route || !services.withdrawals) return;
    // Dusk Wallet signs it: first the wallet, where there's one to choose.
    if (state.dusk?.choices.length) return connectDusk(opener);
    const view = transferView(entry, { cfg, route, timing: timing() });
    const label = kind === "prove" ? "Prove on Dusk" : "Claim on Dusk";
    // The price the page quoted the step at: the review and the request use it too.
    const gasPrice = duskGasPrice();
    // What this step costs at most: an estimate until the request is ready.
    const stepMax = withdrawalStepMax({ gasPrice, withdrawalGas: entry.withdrawalGas ? BigInt(entry.withdrawalGas) : 0n });
    // A proof says when it can be claimed: by the Portal's wait until the request says the date.
    // Once it's ready, what it pays and to whom are its call's own, as Dusk Wallet reads them.
    const lead = (maxLux, claim = null, decoded = null) =>
      actionLead(kind, decoded ? { ...entry, destination: decoded.recipient.account ?? decoded.recipient.contractId } : entry, {
        account: duskAccount(),
        amountLux: decoded ? decoded.amountWei / WEI_PER_LUX : view.amount,
        claim,
        maturity: view.time?.maturity ?? null,
        maxLux,
        name: duskName(),
      });
    const review = reviews.start({
      amountLux: entry.amountLux,
      checks: [],
      current: 0,
      entryId: id,
      error: "",
      feeRows: [],
      kind,
      lead: lead(stepMax),
      privacy: actionPrivacy(kind, privacyLine(route, cfg, { dusk: entry.destination, evm: entry.sender, name: duskPartyName(entry.destination) }), { account: duskAccount(), name: duskName() }),
      receive: { amount: view.amount === null ? "" : formatLux(view.amount), chain: "dusk", unit: "DUSK", where: `Dusk · ${short(entry.destination ?? "")}` },
      routeId: route.id,
      send: { amount: view.amount === null ? "" : formatLux(view.amount), chain: "dusk-evm", unit: "DUSK", where: `${names["dusk-evm"]} · ${short(entry.sender ?? "")}` },
      steps: [
        {
          confirmLabel: label,
          // Only the account that proved can claim with that proof.
          custody: kind === "prove" ? "Only the account that proves can claim with that proof." : "",
          lines: null,
          linesNote: "Preparing the request…",
          title: kind === "prove" ? "Prove the withdrawal" : "Claim the DUSK",
          walletName: "Dusk Wallet",
        },
      ],
      sub: `${names["dusk-evm"]} to Dusk · ${kind === "prove" ? "step 2 of 3" : "step 3 of 3"}`,
    });
    openSheet("review", opener);
    await reviews.fill(
      review,
      async () => {
        const { account } = await ensureDuskConnected(cfg.dusk.chainId);
        // From here the review is for this account: a switch while it's
        // prepared leaves it stale, and the request reads this account's proof.
        review.signer = { account, wallet: "dusk" };
        const submitter = proofSubmitterFor(account);
        // Only the account that proved can claim with its proof.
        if (kind === "finalize" && proverMismatch(entry, submitter)) throw new Error(switchToProver(entry));
        // The package's checked call, as it is, at the price the page quoted.
        const { claim, decoded, request } = await services.withdrawals.request(kind, entry.hash, { price: gasPrice, submitter });
        // What the call carries, as Dusk Wallet reads it from the call.
        const lines = await duskCallLines({
          ...request,
          chainId: cfg.dusk.chainId,
          from: account,
          fromName: account === duskAccount() ? duskName() : "",
          note: "The DuskEVM withdrawal portal on Dusk.",
        });
        return { account, claim, decoded, lines, request };
      },
      ({ account, claim, decoded, lines, request }) => {
        // Prepared for the account Dusk Wallet had then: only it can confirm,
        // and it's the one the proof or claim makes public.
        review.signer = { account, wallet: "dusk" };
        review.privacy = actionPrivacy(kind, privacyLine(route, cfg, { dusk: entry.destination, evm: entry.sender, name: duskPartyName(entry.destination) }), { account, name: duskName() });
        review.request = request;
        review.lead = lead(BigInt(request.gas.limit) * BigInt(request.gas.price), claim, decoded);
        review.steps[0] = { ...review.steps[0], lines };
      },
      (error) => {
        review.error = friendlyWalletError(error, "dusk");
      },
    );
    if (state.sheet === "review" && reviews.current === review) renderSheet();
  }

  async function confirmReview() {
    const review = reviews.current;
    if (!review || review.busy) return;
    if (review.stale || signerMoved(review)) {
      renderSheet();
      return;
    }
    const route = routeOf(review.routeId);
    review.busy = true;
    review.error = "";
    renderSheet();
    try {
      if (review.kind === "send" && switchTo(route)) {
        await ensureEvmChain(signingChain(route));
        review.busy = false;
        reviews.stepShown();
        renderSheet();
        return;
      }
      if (review.kind === "prove" || review.kind === "finalize") {
        const { hash } = await sendDuskContractCall(review.request, { account: review.signer?.account });
        const entry = state.activity.find((item) => item.id === review.entryId);
        // Recorded for the account the review was for, which signed it.
        setActivity(updateActivity(review.entryId, sentActionPatch(review, hash, proofSubmitterFor)));
        review.busy = false;
        closeSheet();
        track(review.entryId);
        announce(review.kind === "prove" ? "Proof sent." : "Claim sent.");
        if (state.page.page !== "transfer" && entry) globalThis.location.hash = transferHref(entry.hash);
        else render();
        return;
      }
      // An EVM step goes out from the account it was reviewed for, which the
      // wallet is asked for again once it's on the chain.
      if (route.mode === "migration") {
        const network = cfg.evmNetworks[route.from.id];
        const step = review.steps[review.current];
        const amount = formatDuskPlain(review.amountLux);
        if (step.title.startsWith("Approve")) {
          await approveMigration(network, amount, { account: review.signer?.account });
          review.current += 1;
          review.sub = "The first step went through. One step left.";
          review.after = "";
          review.busy = false;
          announce("Approval confirmed. Step 2 is ready.");
          // The allowance changed: read it again, with the migration's gas.
          await loadReads();
          renderSheet();
          reviews.stepShown();
          return;
        }
        const hash = await submitMigration(network, amount, review.destination, { account: review.signer?.account });
        return sent({
          amountLux: review.amountLux.toString(),
          destination: review.destination,
          hash,
          parties: [evmAccount(), review.destination],
          routeId: route.id,
          sender: evmAccount(),
        });
      }
      if (route.mode === "duskevm-withdrawal") {
        const result = await submitDuskEvmWithdrawal({ account: review.signer?.account, amount: formatDuskPlain(review.amountLux), duskAccount: review.destination });
        return sent({
          amountLux: review.amountLux.toString(),
          destination: result.duskAccount,
          hash: result.hash,
          parties: [evmAccount(), result.duskAccount],
          routeId: route.id,
          sender: evmAccount(),
          stage: "submitted",
        });
      }
      const scanFrom = await headBlock(route.mode === "duskevm-deposit" ? "dusk-evm" : route.to.id);
      // The reviewed request, as the account it was reviewed for.
      const send = route.mode === "duskevm-deposit" ? sendDuskContractCall : sendDuskTransfer;
      const { hash } = await send(review.request, { account: review.signer?.account });
      return sent({
        amountLux: review.amountLux.toString(),
        destination: review.destination,
        hash,
        parties: [duskAccount(), review.destination],
        routeId: route.id,
        scanFrom,
        sender: duskAccount(),
      });
    } catch (error) {
      if (reviews.current === review) {
        // Why, on the review and in the live region: a cancel is heard as a cancel.
        notSent(review, error, { announce, wallet: review.kind === "send" && route.signer === "evm" ? "evm" : "dusk" });
        if (review.entryId) {
          // Kept on the transfer: its receipt says so behind the sheet, grey when you cancelled.
          setActivity(updateActivity(review.entryId, { actionError: actionErrorOf(error) }));
          if (state.page.page === "transfer") renderMain();
        }
        renderSheet();
      }
    }
  }

  async function headBlock(network) {
    try {
      return BigInt(await services.rpc(network, "eth_blockNumber", [])).toString();
    } catch {
      return undefined;
    }
  }

  function sent(entry) {
    if (reviews.current) reviews.current.busy = false;
    closeSheet();
    addEntry({ ...entry, sentHere: true });
    state.form = null;
    announce("Sent. The receipt follows it from here.");
    globalThis.location.hash = transferHref(entry.hash);
  }

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  async function connectDusk(opener) {
    try {
      if (!state.dusk) return;
      // Several wallets, or not the one chosen before: you choose, Dusk Connect won't.
      if (state.dusk.choices.length) {
        openSheet("wallets", opener);
        return;
      }
      await state.dusk.connect();
      forgetConnectRefusal();
    } catch (error) {
      showError(connectError(error, "dusk"));
    }
  }

  async function chooseDusk(id) {
    closeSheet();
    try {
      await state.dusk.connect(id);
    } catch (error) {
      showError(friendlyWalletError(error, "dusk"));
    }
  }

  async function connectEvm() {
    try {
      state.evmState = await connectEvmWallet();
    } catch (error) {
      showError(connectError(error, "evm"));
    }
  }

  /** Asks the EVM wallet for the chain the card's route sends from. Nothing is sent. */
  async function switchChain() {
    const form = state.form;
    const route = formRoute();
    if (!route || form.switching) return;
    form.switching = true;
    form.error = "";
    refreshForm();
    try {
      await ensureEvmChain(signingChain(route));
    } catch (error) {
      form.error = connectError(error, "evm");
      form.switchError = form.error;
    }
    form.switching = false;
    if (state.form === form) refreshForm();
  }

  /** Why a switch didn't go stops mattering once the wallet's chain moved after all. */
  function forgetSwitchError() {
    if (state.form?.error && state.form.error === state.form.switchError) state.form.error = "";
  }

  /** Why connecting a wallet didn't: nothing was being sent. */
  const connectError = (error, wallet) => (walletCancelled(error) ? CONNECT_CANCELLED : friendlyWalletError(error, wallet));

  /** A refusal stops mattering once the wallet connected after all. */
  function forgetConnectRefusal() {
    if (state.form?.error === CONNECT_CANCELLED) state.form.error = "";
  }

  function showError(message) {
    if (state.form && isCardPage()) {
      state.form.error = message;
      renderMain();
    } else announce(message);
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  function navigate() {
    const next = parseLocation(globalThis.location?.hash);
    if (state.sheet === "review") closeSheet();
    state.page = next;
    if (isCardPage()) {
      ensureCard(next, { follow: true });
      void loadReads();
    }
    if (next.page === "transfer") void openReceipt(next.hash);
    if (next.page === "transfers") void discover();
    refreshTimes();
    // Pages that quote a fee outside the card read the node's gas price
    // again, so they quote what the wallet will. Look up quotes none.
    if (quotesOn(next) && !isCardPage()) void refreshPrice();
    if (next.page === "lookup") {
      lookupFlow.cancel();
      state.lookup = { busy: false, error: "", query: next.query ?? state.lookup.query ?? "" };
    }
    render({ focus: true });
    globalThis.scrollTo?.(0, 0);
  }

  const lookupFlow = createLookupFlow({ isOpen: () => state.page.page === "lookup", resolve: (hash) => services.resolve(hash) });

  async function lookup(query) {
    const hash = canonicalHash(query);
    state.lookup = { busy: Boolean(hash), error: "", query };
    if (!hash) {
      state.lookup.error = "That isn't a transaction hash. It has 64 hex characters, after 0x on EVM chains.";
      renderMain();
      root.querySelector("#lookup")?.focus();
      return;
    }
    renderMain();
    const known = entryForHash(hash);
    if (known) {
      state.lookup.busy = false;
      globalThis.location.hash = transferHref(known.hash);
      return;
    }
    const result = await lookupFlow.find(hash);
    // A newer lookup, or another page, took over: this answer is dropped.
    if (result.stale) return;
    const { found } = result;
    state.lookup.busy = false;
    if (found?.routeId) {
      addEntry({ followed: true, hash: found.hash, routeId: found.routeId });
      globalThis.location.hash = transferHref(found.hash);
      return;
    }
    state.lookup.error = found?.message ?? "No bridge transfer with this hash was found. If you just sent it, try again in a minute.";
    renderMain();
    root.querySelector("#lookup")?.focus();
  }

  function downloadCalendar() {
    const entry = entryForHash(state.page.hash);
    const route = entry && routeOf(entry.routeId);
    if (!entry || !route) return;
    const view = transferView(entry, { cfg, route, timing: timing() });
    // A late claim's date is only the soonest: it's not put in a calendar.
    if (!view.countdown || view.countdown.overdue) return;
    const ics = claimReminder({
      amount: view.amountText || "DUSK",
      claimAt: view.countdown.at,
      exact: view.countdown.exact,
      hash: entry.hash,
      url: receiptUrl(entry.hash),
    });
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const link = globalThis.document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `claim-dusk-${short(entry.hash).replace("…", "-")}.ics`;
    globalThis.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
    announce("The calendar file is downloading.");
  }

  // Copy says Copied on its own button (copied.js); a copy refused says so to screen readers.
  async function copy(value, button) {
    try {
      await globalThis.navigator.clipboard.writeText(value);
    } catch {
      announce("Copying isn't allowed here. Select the text instead.");
      return;
    }
    showCopied(button, { announce });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  root.addEventListener("input", (event) => {
    const { name, value } = event.target;
    if (event.target.classList?.contains("wrap-input")) fitHeight(event.target);
    // What's typed outside the card is kept too, so drawing the page again keeps it.
    if (name === "lookup") state.lookup.query = value;
    if (name === "watch") state.watch.input = value;
    if (!state.form) return;
    if (name === "amount") {
      state.form.amount = value;
      state.form.error = "";
      refreshForm();
      loadGasSoon();
    } else if (name === "recipient") {
      // Pasted across lines or with spaces, it's still one address. An EVM
      // address takes its checksum's capitals once it's a whole one.
      const typed = value.replace(/\s+/gu, "");
      state.form.recipientInput = formRoute()?.to.kind === "evm" ? settledEvmRecipient(typed) : typed;
      if (state.form.recipientInput !== typed) {
        const { selectionEnd, selectionStart } = event.target;
        event.target.value = state.form.recipientInput;
        if (value.length === typed.length) event.target.setSelectionRange(selectionStart, selectionEnd);
      }
      refreshForm();
      loadGasSoon();
      lookUpRecipientName();
      lookUpRecipientCode();
    }
  });

  // The route row's open state stays as it was when the card is drawn again.
  root.addEventListener(
    "toggle",
    (event) => {
      if (state.form && event.target.matches?.("details.route")) state.form.routeOpen = event.target.open;
    },
    true,
  );

  // Escape closes the network list.
  root.addEventListener("keydown", (event) => {
    // The network list is a list: arrows move through what can be picked.
    const list = event.target.closest?.(".netmenu");
    if (list && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const options = [...list.querySelectorAll('[role="option"]:not([disabled]):not([aria-disabled="true"])')];
      const at = options.indexOf(event.target);
      const next = { ArrowDown: at + 1, ArrowUp: at - 1, End: options.length - 1, Home: 0 }[event.key];
      event.preventDefault();
      options[Math.max(0, Math.min(options.length - 1, next))]?.focus();
      return;
    }
    if (event.key === "Escape" && state.form?.menu) {
      const side = state.form.menu;
      state.form.menu = null;
      renderMain();
      root.querySelector(`[data-action="open-menu"][data-side="${side}"]`)?.focus();
    }
  });

  root.addEventListener("submit", (event) => {
    if (event.target.dataset.form === "lookup") {
      event.preventDefault();
      void lookup(new FormData(event.target).get("lookup") ?? "");
    }
    if (event.target.dataset.form === "watch") {
      event.preventDefault();
      void watchAccount(new FormData(event.target).get("watch") ?? "");
    }
  });

  root.addEventListener("click", (event) => {
    // A click outside the network list closes it.
    if (state.form?.menu && !event.target.closest(".netsel") && isCardPage()) {
      state.form.menu = null;
      renderMain();
      if (!event.target.closest("[data-action]")) return;
    }
    // A link to the route already open opens it again: no hash change says so.
    const move = event.target.closest('a[href^="#/move/"]');
    if (move && move.getAttribute("href") === globalThis.location?.hash) {
      event.preventDefault();
      navigate();
      return;
    }
    const copyTarget = event.target.closest("[data-copy]");
    if (copyTarget) {
      event.preventDefault();
      void copy(copyTarget.dataset.copy, copyTarget);
      return;
    }
    const target = event.target.closest("[data-action]");
    const action = target?.dataset.action;
    if (!action) {
      // A click on the dialog's backdrop closes it.
      if (event.target === dialog && !reviews.current?.busy) closeByPerson();
      return;
    }
    const actions = {
      calendar: downloadCalendar,
      "close-sheet": closeByPerson,
      // Not in the moment the review or its next step comes up (review-session.js).
      confirm: () => (reviews.confirmable ? confirmReview() : undefined),
      "choose-dusk": () => chooseDusk(target.dataset.wallet),
      "connect-dusk": () => connectDusk(target),
      "connect-evm": connectEvm,
      "discover-more": () => discover({ more: true }),
      max: () => {
        const route = formRoute();
        const quote = quoteFor(route);
        if (quote.maxLux === null || quote.maxLux === undefined) return;
        state.form.amount = amountForInput(quote.maxLux);
        const input = root.querySelector("#amount");
        if (input) input.value = state.form.amount;
        refreshForm();
        loadGasSoon();
      },
      "notify-off": () => {
        arrivals.stop();
        showNotice();
      },
      "notify-on": async () => {
        await arrivals.choose();
        showNotice();
      },
      "open-about": () => openSheet("contracts", target),
      "open-contracts": () => openSheet("contracts", target),
      "open-network": () => openSheet("network", target),
      "recipient-edit": () => {
        state.form.recipientEditing = true;
        renderMain();
        root.querySelector("#recipient")?.focus();
      },
      // Only the capitals were off: the address with its checksum's capitals.
      "recipient-fix": () => {
        const fix = typedRecipient(formRoute())?.fix;
        if (!fix) return;
        state.form.recipientInput = fix;
        renderMain();
        root.querySelector("#recipient")?.focus();
        loadGasSoon();
        lookUpRecipientCode();
      },
      // "Did you mean alice.dusk?": the name goes in the field and is looked up.
      "recipient-suggest": () => {
        const name = typedRecipient(formRoute())?.suggest;
        if (!name) return;
        state.form.recipientInput = name;
        renderMain();
        root.querySelector("#recipient")?.focus();
        lookUpRecipientName();
        lookUpRecipientCode();
        loadGasSoon();
      },
      "recipient-reset": () => {
        state.form.recipientInput = "";
        state.form.recipientEditing = false;
        renderMain();
        void loadReads();
      },
      review: () => openReview(target),
      share: () => globalThis.navigator.share?.({ title: "Dusk Bridge", url: globalThis.location.href }).catch(() => {}),
      unwatch: () => {
        state.watching = null;
        saveWatched(cfg.profile, null);
        discoveryRuns.expire();
        renderMain();
      },
      skip: () => slot("main").querySelector("#main")?.focus(),
      "switch-chain": switchChain,
      // The card: its network lists, the flip, and the recipient and gas.
      "open-menu": () => {
        const side = target.dataset.side;
        state.form.menu = state.form.menu === side ? null : side;
        renderMain();
        root.querySelector('.netmenu .netopt[aria-selected="true"], .netmenu .netopt:not([aria-disabled="true"])')?.focus();
      },
      "close-menu": () => {
        state.form.menu = null;
        renderMain();
      },
      "pick-net": () => {
        if (target.getAttribute("aria-disabled") === "true") return;
        const route = formRoute();
        const net = target.dataset.net;
        const next = target.dataset.side === "from" ? choosePair(routes, { from: net, to: route.to.id }) : routeBetween(routes, route.from.id, net);
        if (next) setPair(next);
        state.form.menu = null;
        renderMain();
        root.querySelector(`[data-action="open-menu"][data-side="${target.dataset.side}"]`)?.focus();
      },
      flip: () => {
        const back = flipRoute(routes, formRoute());
        if (!back) return;
        setPair(back);
        renderMain();
        root.querySelector('[data-action="flip"]')?.focus();
      },
      settings: () => {
        state.form.recipientEditing = true;
        state.form.routeOpen = true;
        renderMain();
        root.querySelector("#recipient")?.focus();
      },
      "withdrawal-finalize": () => openActionReview(target.dataset.id, "finalize", target),
      "withdrawal-prove": () => openActionReview(target.dataset.id, "prove", target),
    };
    if (actions[action]) {
      event.preventDefault();
      void actions[action]();
    }
  });

  // Escape closes a sheet; the dialog's own cancel is routed the same way.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeByPerson();
  });

  globalThis.addEventListener?.("hashchange", navigate);
  // A phone's Back from a review: its step in the history is gone, so it closes.
  globalThis.addEventListener?.("popstate", () => {
    if (state.sheet === "review" && !globalThis.history?.state?.reviewSheet) closeSheet();
  });

  // On a phone, the card's button stays above the keyboard: the height the
  // keyboard covers, from the visual viewport, as the web wallet keeps it.
  const viewport = globalThis.visualViewport;
  if (viewport) {
    const keyboardInset = () =>
      root.style.setProperty("--keyboard-inset", `${Math.max(0, Math.round(globalThis.innerHeight - viewport.height - viewport.offsetTop))}px`);
    viewport.addEventListener("resize", keyboardInset);
    viewport.addEventListener("scroll", keyboardInset);
    keyboardInset();
  }

  return {
    async start() {
      // First of all: a transfer can end as the page opens, before the wallets answer.
      globalThis.addEventListener?.("focus", arrivals.seen);
      globalThis.document?.addEventListener("visibilitychange", arrivals.seen);
      if (isCardPage()) ensureCard();
      render();
      for (const entry of state.activity) if (entry.status === "pending" || !entry.status) track(entry.id);
      if (state.page.page === "transfer") void openReceipt(state.page.hash);
      const [dusk] = await Promise.all([createDuskConnection().catch(() => null), initializeEvmWallet().catch(() => getEvmState())]);
      state.dusk = dusk;
      dusk?.subscribe((next) => {
        const previous = state.duskState.selectedProfile?.account ?? null;
        const changed = next.selectedProfile?.account !== previous;
        state.duskState = next;
        lookUpName(duskAccount());
        if (changed) {
          if (signerMoved(reviews.current) && state.sheet === "review") renderSheet();
          formReads.reset(["duskBalance"]);
          discoveryRuns.expire();
          for (const entry of state.activity)
            if (entry.status === "pending" && routeOf(entry.routeId)?.mode === "duskevm-withdrawal") track(entry.id);
          void discover();
          followWallets();
          if (isCardPage()) void loadReads();
        }
        renderChrome();
        if (changed || !isCardPage()) renderMain();
      });
      subscribeEvmWallet((next) => {
        const chainChanged = next.chainId !== state.evmState.chainId;
        const accountChanged = next.account !== state.evmState.account;
        const changed = accountChanged || chainChanged;
        state.evmState = next;
        if (accountChanged) {
          if (next.account) forgetConnectRefusal();
          // What's reviewed pays the wallet's account as it was: it's stale once that's another.
          const reviewing = reviews.current;
          if (reviewing?.paysConnected && String(next.account ?? "").toLowerCase() !== reviewing.paysConnected.toLowerCase()) {
            reviewing.stale = true;
            reviewing.error = SIGNER_MOVED.evm;
            if (state.sheet === "review") renderSheet();
          }
          if (signerMoved(reviews.current) && state.sheet === "review") renderSheet();
          formReads.reset(["migration", "l2"]);
          discoveryRuns.expire();
          void discover();
        }
        renderChrome();
        if (accountChanged) followWallets();
        if (chainChanged) forgetSwitchError();
        if (changed) {
          renderMain();
          if (isCardPage()) void loadReads();
        }
        // The review's button follows the wallet's chain; a double-click doesn't land on what it became.
        if (chainChanged && state.sheet === "review" && reviews.current) {
          reviews.stepShown();
          renderSheet();
        }
      });
      const refreshDusk = () => {
        if (globalThis.document?.visibilityState === "hidden") return;
        void dusk?.wallet.refresh().catch(() => {});
      };
      globalThis.addEventListener?.("focus", refreshDusk);
      globalThis.document?.addEventListener("visibilitychange", refreshDusk);
      if (isCardPage()) void loadReads();
      // The gas price every "up to" fee is figured at, on any page that quotes one.
      else if (quotesOn(state.page)) void refreshPrice();
      refreshTimes();
      void discover();
      render();
    },
  };
}
