// The bridge page: a start page of tasks, one form per task with its quote,
// a review sheet with what moves, to whom and what it costs, a receipt per
// transfer at its own link, and Activity read from the networks.
// Chain state comes from the deployment's own node and RPCs; the wallets
// are asked only for accounts, signatures and sends, but for Hyperlane's
// Sepolia reads, which go through the EVM wallet while it's on Sepolia.

import { topGap } from "@dusk-network/app-core/history";
import { toDuskName } from "@duskdomains/sdk/names";

import { entryId, minedTransfer, readActivity, recordActivity, saveActivity, updateActivity, useActivityNetwork } from "./activity.js";
import { NOTICE_WORDS, createArrivalNotice, createEndWatch } from "./arrival-notice.js";
import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";
import { cardRoute, choosePair, entryRoutes, flipRoute, followsWallets, fromChoices, handedOverRecipient, primaryButton, routeBetween, toChoices, tokenChoices, tokenOf } from "./bridge-card.js";
import { claimReminder } from "./calendar.js";
import { createClaimWatch } from "./claim-watch.js";
import { showCopied } from "./copied.js";
import { config } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { followAfterDiscovery, mergeTransfer, mergeTransfers, partyKey } from "./discovery.js";
import { createDiscoveryRuns } from "./discovery-runs.js";
import { depositRequest } from "./dusk-deposit.js";
import { createDuskAdded, createDuskOffer } from "./dusk-offer.js";
import { createDuskConnection, disconnectDusk, ensureDuskConnected, sendDuskContractCall, sendDuskTransfer } from "./dusk-wallet.js";
import { duskEvmNetwork, submitDuskEvmWithdrawal } from "./duskevm-withdrawal.js";
import { addDusk, canAddDusk, connectEvmWallet, ensureEvmChain, evmMoved, getEvmState, initializeEvmWallet, subscribeEvmWallet } from "./evm-wallet.js";
import { createFormReads } from "./form-reads.js";
import { amountForInput, amountForUnits, formatDusk, formatLux, formatDuskPlain, formatMaxFee, formatToken, formatUnitsGrouped } from "./format.js";
import { HYPERLANE_GAS, U64_MAX, duskRecipientHash } from "./hyperlane.js";
import { inboundCharge, sendToDusk } from "./hyperlane-evm.js";
import { approveRequest, claimRequest, feeChanged, transferRemoteRequest } from "./hyperlane-requests.js";
import { callDetails, claimKey, escrowOnTheWay, evmReviewParts, heldFor, nowHeld, rebuilding, recheckApproval, recheckClaim, withClaimSent } from "./hyperlane-review.js";
import { deliveryLinkDue } from "./hyperlane-tracking.js";
import { approveMigration, minedAs, revokeMigration, submitMigration } from "./legacy-migration.js";
import { bridgeTasks, chainName, gasCoin, linkedRoute, networkName, networkNames, notRunning, routeUnits, tokenName } from "./names.js";
import {
  actionLead,
  actionPrivacy,
  addDuskOffer,
  balanceLine,
  pricedReview,
  recipientLine,
  DUSK_WALLET_URL,
  evmWalletName,
  busyNotes,
  feeNotes,
  openApproval,
  receiptModel,
  replacedLine,
  reviewChecks,
  revokeReview,
  routeDetailRows,
  routeLines,
  transfersModel,
} from "./page-models.js";
import { pageStorage } from "./page-storage.js";
import { canonicalHash, moveHref, pageUrl, parseLocation, quotesOn, receiptUrl, transferHref } from "./permalink.js";
import { buildQuote, parseAmount, withdrawalStepMax } from "./quote.js";
import { serviceTransferRequest } from "./service-transfer.js";
import { createServices, proofSubmitterFor } from "./services.js";
import { createLookupFlow } from "./lookup-flow.js";
import { createMigrationFees } from "./migration-fees.js";
import { createReceiptLookups } from "./receipt-lookups.js";
import { createRouteStatus, statusLine } from "./route-status.js";
import { arrivalDue, routeTime, routeTimeText } from "./route-times.js";
import { checkDuskRecipient, checkEvmRecipient, evmBridgeContracts, settledEvmRecipient } from "./recipient.js";
import { readWatched, saveWatched, watchTarget } from "./watched-account.js";
import { SIGNER_MOVED, createReviewSession, notSent, sameSigner, sentActionPatch } from "./review-session.js";
import { createScheduler, duskFeePaid, takenByAnother } from "./tracking.js";
import { approveLines, duskCallLines, duskTransferLines, migrateLines, withdrawLines } from "./wallet-lines.js";
import { CONNECT_CANCELLED, CONTRACT_RECIPIENT, PUBLIC_LINE, actionErrorOf, friendlyWalletError, walletCancelled, html, privacyLine, proverMismatch, short, switchToProver, transferView } from "./transfer-view.js";
import {
  activityPanel,
  cardPage,
  cardRegions,
  contractsSheet,
  copyFaces,
  duskSheet,
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
import { NOT_TRANSACTION_ID } from "./resolve.js";

const WEI_PER_LUX = 1_000_000_000n;
/** How often the card reads what Hyperlane's routes hold while a transfer to its account is on its way. */
const ESCROW_EVERY_MS = 15_000;
// Per visit: about two months of a sparse Dusk history, and about 25 days of
// DuskEVM blocks (100,000 per request); "Older transfers" carries on.
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
  // Claims of what Hyperlane's routes hold, sent from this page: each said as
  // sent until its transaction is in a block, failed, or isn't found for long.
  const claimWatch = createClaimWatch({
    node: services.node,
    // Kept across reloads, per network: a claim waiting for its transaction is still followed.
    storage: pageStorage(),
    storageKey: `dusk-bridge:hyperlane-claims:v1:${cfg.profile}`,
    onEnd: (_key, outcome) => {
      if (outcome.error) announce(outcome.error);
      // The card's box offers Claim again, drawn around whatever has focus, and reads what's held now.
      refreshFormAndHeader();
      void loadReads();
    },
  });
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
  // What's signed on Dusk while the network is busy may take longer: said, never blocking.
  const duskBusy = () => busyNotes(formReads.reads.networkBusy);
  const busyFor = (route) => (route.signer === "dusk" ? duskBusy() : []);
  /** Reads the gas price again; the page is drawn again where it moved. */
  const refreshPrice = () => formReads.price();
  // Says when a transfer ends to whoever isn't looking. A phone's browser can't notify from a page.
  const arrivals = createArrivalNotice({
    available: () => !isPhone(),
    onOpen: (href) => {
      globalThis.location.hash = href;
    },
  });
  // Whose ends are told: the transfers this visit saw on their way, so opening the page reads out no old arrivals.
  const ends = createEndWatch();
  // DUSK added to the EVM wallet from this page this visit, by chain, address and wallet: said where its offer was.
  const duskAdded = createDuskAdded();
  const duskAddedTo = (network) => duskAdded.has(network, state.evmState);
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
    // A claim waiting for its transaction shows on each transfer it pays: none offers another.
    const entries = state.activity.map((entry) => withClaimSent(entry, claimWatch.pending));
    return transfersModel(entries, { account: duskAccount(), accounts: accounts(), cfg, name: duskName(), owner: listedDusk(), routeOf, submitter: proofSubmitterFor(duskAccount()), timing: timing() });
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
      ? `${names["dusk-evm"]} isn't live yet`
      : `Not on ${names.badge}`;

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
    form.approvalNote = "";
    if (before?.to.kind !== route.to.kind) {
      form.recipientInput = "";
      form.recipientEditing = false;
    }
    formReads.reset(["migration", "l2", "hyperlane"]);
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
    return checkEvmRecipient(typed, { bridgeContracts: evmBridgeContracts(cfg, route.to.id) });
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
    if (route.mode === "hyperlane") {
      const read = reads.hyperlane ?? {};
      return route.signer === "dusk"
        ? buildQuote(route, state.form.amount, { balance: reads.duskBalance, cfg, gasPrice: reads.gasPrice, hyperlane: read, timing: timing() })
        : buildQuote(route, state.form.amount, {
            balance: read.evm?.balance ?? null,
            cfg,
            evm: { deliveryFeeWei: read.evm?.deliveryFeeWei ?? null, gas: read.gas ?? null, gasCoinWei: read.evm?.gasCoinWei ?? null, priceWei: read.evm?.gasPriceWei ?? null },
            timing: timing(),
          });
    }
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

  /** What the migration contract may still take on `route`, as the chain said it last. */
  const approvalOpen = (route) =>
    openApproval(route, { allowanceWei: formReads.reads.migration?.allowanceWei, balanceWei: formReads.reads.migration?.balanceWei, evm: evmAccount(), paused: route.paused });

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

  /** The card's networks to choose from, each by its route's time, with DuskEVM shown as not live yet where it isn't. */
  function networkChoices(side, route) {
    const nameOf = (id) => networkName(cfg, id);
    const paused = notRunning(cfg);
    const choices = side === "from" ? fromChoices(routes, route.from.id, nameOf, paused) : toChoices(routes, route.from.id, route.to.id, nameOf, paused, tokenOf(route));
    const listed = choices.map((choice) => ({
      ...choice,
      name: nameOf(choice.id),
      // Its fees are on the card as soon as it's picked.
      note: choice.route ? routeTimeText(routeTime(choice.route, cfg, timing())) : "",
    }));
    if (!cfg.duskEvm.enabled) listed.push({ disabled: "Not live yet", id: "dusk-evm", name: names["dusk-evm"] });
    return listed;
  }

  function cardVm() {
    const route = formRoute();
    const quote = quoteFor(route);
    const reads = formReads.reads;
    const phoneOnly = isPhone() && !duskState().installed;
    // ERC20 or BEP20 DUSK on Ethereum and BNB Smart Chain, DUSK on Dusk and DuskEVM.
    const { receive: receiveUnit, send: unit } = routeUnits(route);
    // What the source holds: the public balance on Dusk, the wallet's on an EVM chain; a Hyperlane route's token.
    const holdings =
      route.mode === "hyperlane"
        ? route.signer === "evm"
          ? reads.hyperlane?.evm?.balance
          : route.hyperlane.native
            ? reads.duskBalance
            : reads.hyperlane?.tokenBalance
        : route.signer === "dusk"
          ? reads.duskBalance
          : route.mode === "migration"
            ? reads.migration?.balanceWei
            : reads.l2?.balanceWei;
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
    });
    const toVm = {
      canReset: Boolean(state.form.recipientInput) && Boolean(route.to.kind === "dusk" ? duskAccount() : evmAccount()),
      editing: state.form.recipientEditing || (!destination && Boolean(state.form.recipientInput)),
      // Nothing to change yet: one is added.
      empty: !destination,
      error: typed?.error ?? "",
      fix: typed?.fix ?? "",
      input: state.form.recipientInput,
      // "alice" for alice.dusk, as the wallets offer it.
      suggest: typed?.suggest ?? "",
      // The To panel above names the network.
      label: "Recipient",
      line,
      looking: typed?.pending ? typed.name : "",
      net: netOf(route.to.id),
      placeholder: route.to.kind === "dusk" ? "Account or .dusk name" : "0x…",
      resolved,
      contract: paysContract(route, destination),
    };
    // A paused route says so on its button.
    let notice = null;
    if (route.signer === "dusk" && phoneOnly && !route.paused)
      notice = {
        actions: `<div class="btn-row"><button type="button" class="btn sec sm" data-copy="${html(globalThis.location?.href ?? "")}" aria-label="Copy this page's link">${copyFaces("Copy link", "Copied")}</button>${globalThis.navigator?.share ? '<button type="button" class="btn sec sm" data-action="share">Share link</button>' : ""}</div>`,
        html: "Needs Dusk Wallet on a computer",
        icon: "laptop",
      };
    else if (route.mode === "duskevm-withdrawal" && phoneOnly && !route.paused)
      notice = { html: "Prove and claim need Dusk Wallet on a computer", icon: "phone" };
    const button = primaryButton({
      amountError: quote.error,
      amountLux: quote.amountLux,
      // What Review names: the amount as typed, in what's sent.
      amountText: quote.amountLux === null ? "" : `${route.mode === "hyperlane" ? formatUnitsGrouped(quote.amountLux, route.amountDecimals) : formatLux(quote.amountLux)} ${unit}`,
      connectsRecipient: route.to.kind === "evm" && !evmAccount() && !state.form.recipientInput,
      destination,
      destinationError: toVm.error,
      duskInstalled: duskState().installed,
      // Connected before and locked since: it's unlocked, as the header says.
      duskLocked: Boolean(duskState().authorized) && !duskAccount(),
      insufficient: Boolean(quote.insufficient),
      looking: toVm.looking,
      paused: notRunning(cfg),
      phoneOnly,
      route,
      signerConnected: signerReady(route),
      switchTo: switchTo(route),
      switching: Boolean(state.form.switching),
      // What's short: the token, or the coin its fees are paid in.
      unit: quote.short ?? unit,
      waiting: quote.waiting ?? "",
    });
    return {
      amount: state.form.amount,
      amountError: quote.insufficient ? "" : quote.error,
      // Beside the balance of the way back, while the wallet holds none: it can show the DUSK once there is some.
      addDusk:
        route.mode === "migration"
          ? addDuskOffer(route, {
              added: duskAddedTo(cfg.evmNetworks[route.from.id]),
              balanceWei: reads.migration?.balanceWei ?? null,
              evm: state.evmState,
              takes: canAddDusk(cfg.evmNetworks[route.from.id]),
              wayBack: Boolean(routeBetween(routes, route.to.id, route.from.id)),
            })
          : null,
      // What the migration contract may still take, as the chain says, and the word once it's revoked.
      approval: approvalOpen(route),
      approvalNote: state.form.approvalNote ?? "",
      button: { ...button, href: DUSK_WALLET_URL },
      canFlip: Boolean(flipRoute(routes, route)),
      canMax: quote.maxLux !== null && quote.maxLux !== undefined && quote.maxLux > 0n,
      // DUSK on Ethereum or BNB Smart Chain, for whoever doesn't know to pick it as From.
      entry: entryRoutes(routes, route).map((item) => ({ href: moveHref(item.id), name: networkName(cfg, item.from.id) })),
      error: state.form.error,
      // What Hyperlane's routes hold for the connected Dusk account, to claim.
      escrow: escrowVm(),
      // A bridge fee more than the amount, said under the route line; it blocks nothing.
      // Under the route line, blocking nothing: a bridge fee more than the amount, a busy network.
      warnings: route.paused ? [] : [...feeNotes(quote), ...busyFor(route)],
      from: {
        balance: balance.text,
        balanceExact: balance.exact,
        balanceLabel: route.signer === "dusk" && !(route.mode === "hyperlane" && !route.hyperlane.native) ? "Public balance" : "Balance",
        net: netOf(route.from.id),
      },
      fromChoices: state.form.menu === "from" ? networkChoices("from", route) : [],
      menu: state.form.menu,
      needsCount: transfersVm().needs,
      notice,
      // What becomes public, behind the route line.
      privacy: privacyLine(route, cfg, {
        dusk: route.to.kind === "dusk" ? destination : duskAccount(),
        evm: route.to.kind === "dusk" ? evmAccount() : destination,
        name: duskPartyName(route.to.kind === "dusk" ? destination : duskAccount(), resolved),
      }),
      quote,
      receive: quote.receiveLux !== null && quote.receiveLux > 0n ? formatUnitsGrouped(quote.receiveLux, route.amountDecimals) : "",
      receiveUnit,
      // Under the card, its time and fees in a line, and what they sum behind it. None on a paused route.
      routeLines: route.paused ? [] : routeLines(route, cfg, { gasPrice: duskGasPrice(), quote, timing: timing() }),
      routeOpen: state.form.routeOpen,
      routeRows: route.paused ? [] : routeDetailRows(route, quote),
      status: statusLine(routeStatus.get(route), { amountLux: quote.amountLux }),
      tab: "bridge",
      to: toVm,
      toChoices: state.form.menu === "to" ? networkChoices("to", route) : [],
      // The tokens the pair moves, where it moves more than one.
      tokens: tokenChoices(routes, route),
      unit,
    };
  }

  /**
   * What each Hyperlane route holds in escrow for the connected Dusk account,
   * for the card's box: the amounts, each with its route, and a claim sent
   * from here in its place.
   */
  function escrowVm() {
    const read = formReads.reads.escrow;
    const account = escrowAccount(formRoute());
    if (!cfg.hyperlane?.enabled || !read || !account || read.account !== account) return null;
    const waiting = read.held.filter((each) => each.pending > 0n);
    if (!waiting.length) return null;
    const own = account === duskAccount();
    // Without DUSK for its own claim's fee, another account can claim it for this one, from this link.
    const noFee = own && read.balance !== null && read.balance !== undefined && read.balance < HYPERLANE_GAS.claim.limit * duskGasPrice();
    return {
      held: waiting.map((each) => ({
        account: own ? "" : account,
        amount: formatToken(each.pending, each.token),
        route: each.token.routes.in,
        sent: claimWatch.pending(claimKey(each.token.routes.in, account)) ? "Claim sent, waiting for Dusk" : "",
      })),
      link: noFee ? pageUrl(moveHref(waiting[0].token.routes.in, { to: account })) : "",
      owner: own ? "" : duskPartyName(account, typedRecipient(formRoute())) || short(account),
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
  /** What Hyperlane's routes hold for the card's account, read again: a transfer to it landed in escrow, or may. */
  function refreshEscrow() {
    void formReads.escrow(escrowAccount(formRoute()));
  }

  /**
   * While a transfer to the card's account is on its way into Dusk, what the
   * routes hold for it is read again every 15 seconds, so its Claim shows as
   * it lands; not while the page is hidden or off the card.
   */
  function watchEscrow() {
    setTimeout(() => {
      if (globalThis.document?.visibilityState !== "hidden" && isCardPage()) {
        const account = escrowAccount(formRoute());
        if (account && escrowOnTheWay(state.activity, account, routeOf)) refreshEscrow();
      }
      watchEscrow();
    }, ESCROW_EVERY_MS);
  }

  function loadReads() {
    const route = formRoute();
    if (!route) return undefined;
    routeStatus.open(route);
    return formReads.load({ dusk: duskAccount(), escrowFor: escrowAccount(route), evm: evmAccount(), gas: gasInputs(route), route });
  }

  /**
   * The Dusk account whose escrow the card shows: on Hyperlane's way into
   * Dusk, the recipient, typed or handed over in a link, as anyone can claim
   * for another account; else the connected one.
   */
  function escrowAccount(route) {
    if (route?.mode === "hyperlane" && route.to.kind === "dusk" && state.form?.recipientInput && !destinationError(route)) return destinationFor(route) || duskAccount();
    return duskAccount();
  }

  /** What gas estimates need: the amount in wei and the Dusk recipient. */
  function gasInputs(route) {
    const recipient = destinationFor(route);
    const valid = recipient && !destinationError(route);
    // A Hyperlane route quotes, and estimates, with the transfer's own amount and recipient.
    if (route.mode === "hyperlane") {
      const { lux: units } = parseAmount(state.form?.amount, route.amountDecimals);
      return {
        amount: units && units <= U64_MAX ? units : undefined,
        dusk: duskAccount(),
        escrowFor: escrowAccount(route),
        recipient: route.to.kind === "evm" && valid ? recipient : undefined,
        recipientHash: route.to.kind === "dusk" && valid ? duskRecipientHash(recipient) : undefined,
      };
    }
    const { lux } = parseAmount(state.form?.amount);
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
    const before = state.activity;
    state.activity = list;
    for (const entry of ends.ended(before, list)) {
      const route = routeOf(entry.routeId);
      if (route) {
        // Its state in a sentence: "1 EURd arrived on Sepolia".
        const { headline: title } = transferView(entry, { cfg, route });
        announce(`${title}.`);
        arrivals.ended({ href: transferHref(entry.hash), id: entry.id, title });
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
      const after = state.activity.find((item) => item.id === id);
      ends.checked(after);
      // Delivered into escrow: the card's box offers its Claim now, not on the next visit.
      if (nowHeld(entry, after)) refreshEscrow();
    } catch (error) {
      setActivity(updateActivity(id, { lastCheckedAt: Date.now(), trackingError: error instanceof Error ? error.message : String(error) }));
    }
    renderChrome();
    if (state.page.page === "transfers" || (state.page.page === "transfer" && canonicalHash(entry.hash) === state.page.hash)) renderMain();
    return state.activity.find((item) => item.id === id) ?? null;
  }
  const scheduler = createScheduler({
    check: checkEntry,
    // Arrived before the transaction that delivered it was found: looked for a while longer.
    more: (entry) => deliveryLinkDue(entry, routeOf(entry.routeId)),
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
    // Whose transfers these are, as labels: the Dusk account by its .dusk name where it has one.
    const dusk = duskAccount() ? { account: duskAccount(), name: duskName() } : watching;
    const who = [
      dusk ? (dusk.name ? html(dusk.name) : `<code class="mono">${html(short(dusk.account))}</code>`) : "",
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
        : "Connect a wallet or follow an account";
    return activityPanel({
      canAct: duskState().installed,
      empty,
      emptyActions: who.length ? "" : `<div class="btn-row">${duskState().installed ? '<button type="button" class="btn sec sm" data-action="connect-dusk">Connect Dusk Wallet</button>' : ""}<button type="button" class="btn sec sm" data-action="connect-evm">Connect EVM wallet</button></div>`,
      groups,
      lede: who.join(" · "),
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
      if (entry.status === "pending" || !entry.status || deliveryLinkDue(entry, routeOf(entry.routeId))) track(entry.id);
      return;
    }
    await receiptLookups.open(hash);
  }

  // What each migration on a receipt paid on its own chain, with the approval
  // it spent: read as the receipt shows it, again as the transfer moves on,
  // and again where the chain couldn't say, while a receipt needs it.
  const migrationFees = createMigrationFees({
    isOpen: (hash) => state.page.page === "transfer" && bareHash(state.page.hash) === bareHash(hash),
    onChange: () => renderMain(),
    read: (entry, route) => services.tracking.migrationEvm(entry, route),
  });

  function receiptHtml() {
    const hash = state.page.hash;
    const entry = entryForHash(hash);
    if (!entry) {
      const lookup = receiptLookups.get(hash);
      if (lookup?.missing) return receiptPage({ hash, missing: lookup.missing });
      return receiptPage({ loading: "Looking up this transfer…" });
    }
    const route = routeOf(entry.routeId);
    if (!route) return receiptPage({ hash, missing: `This transfer's route isn't on ${names.badge}` });
    return receiptPage({
      ...receiptModel(withClaimSent(entry, claimWatch.pending), {
        // Cancelled in the wallet: the migration that spent its approval since, which counts its fee.
        approvalSpentBy: entry.replaced ? migrationFees.spentBy(entry, route, state.activity) : false,
        cfg,
        evm: migrationFees.fact(entry, route),
        gasPrice: duskGasPrice(),
        own: { account: duskAccount(), name: duskName() },
        owner: listedDusk(),
        route,
        submitter: proofSubmitterFor(duskAccount()),
        timing: timing(),
        url: receiptUrl(entry.hash),
        wallet: {
          ...state.evmState,
          addedDusk: route.to.kind === "evm" && duskAddedTo(cfg.evmNetworks[route.to.id]),
          addsDusk: route.to.kind === "evm" && canAddDusk(cfg.evmNetworks[route.to.id]),
        },
      }),
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
    } else if (state.sheet === "dusk") {
      dialog.className = "sheet narrow";
      dialog.innerHTML = duskSheet({ account: duskAccount(), name: duskName() });
    }
  }

  // -------------------------------------------------------------------------
  // Review and send
  // -------------------------------------------------------------------------

  // The explorer pages of the accounts and contracts a wallet's window shows, for its lines under Details.
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

  /** Whether a review's request goes to the EVM wallet: a transfer it sends, or a revoke. */
  const evmStep = (review) => review.kind === "send" || review.kind === "revoke";

  function reviewVm() {
    const review = reviews.current;
    const route = routeOf(review.routeId);
    const walletName = route.signer === "dusk" || !evmStep(review) ? "Dusk Wallet" : evmWalletName(state.evmState);
    const step = review.steps[review.current];
    return {
      cfgLinks: explorerFor,
      // Its request built, and nothing it checked failing.
      canConfirm: !review.busy && !review.stale && Boolean(step?.ready) && review.checks.every((check) => check.ok),
      checks: review.checks,
      // On another chain, it's asked for first, as the card does.
      confirmLabel: review.busy ? review.busyLabel || `Waiting for ${walletName}…` : (evmStep(review) && switchTo(route) ? `Switch to ${switchTo(route)}` : step?.confirmLabel) ?? "Confirm",
      error: review.error,
      // Two steps: what each does, in a row of its own until the first is done.
      feeRows: review.stepsLine ? [...review.feeRows, { key: "steps", label: "Steps", value: review.stepsLine }] : review.feeRows,
      // The fees as one figure, where they're split.
      fees: review.fees ?? null,
      lead: review.lead ?? null,
      notYours: review.notYours ?? "",
      notes: review.notes ?? [],
      warnings: review.warnings ?? [],
      privacy: review.privacy,
      receive: review.receive,
      send: review.send,
      steps: review.steps.map((item, index) => ({ ...item, current: index === review.current })),
      sub: review.sub,
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
    // A Hyperlane route's token in its own decimals; DUSK to the Lux.
    const amountText = route.mode === "hyperlane" ? formatUnitsGrouped(lux, route.amountDecimals) : formatLux(lux);
    const checks = reviewChecks(route, { cfg, destination, duskAccount: duskAccount(), evm: state.evmState, quote, reads: formReads.reads });
    // The .dusk name of whom it pays, where there's one: the connected account's, or a typed name's. On an EVM chain, the connected wallet where it's that.
    const payeeName =
      route.to.kind === "dusk"
        ? destination === duskAccount() ? duskName() : (typedRecipient(route)?.name ?? "")
        : evmAccount() && destination === checkEvmRecipient(evmAccount()).address ? `your ${evmWalletName(state.evmState).replace(/^your /u, "")}` : "";
    const base = {
      checks,
      error: "",
      feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
      // The fees as one figure, their split under Details.
      fees: quote.fees ?? null,
      kind: "send",
      // Said in amber, blocking nothing: a bridge fee more than the amount, a busy network.
      warnings: [...feeNotes(quote), ...busyFor(route)],
      // A contract, or DUSK paid to another Dusk account than the connected one: said first.
      paysConnected: route.to.kind === "evm" && evmAccount() && destination === checkEvmRecipient(evmAccount()).address ? destination : "",
      paysTo: destination,
      notYours: paysContract(route, destination)
        ? CONTRACT_RECIPIENT
        : route.to.kind === "dusk" && duskAccount() && destination !== duskAccount()
          ? `Not your connected account${payeeName ? `: it pays ${payeeName}` : ""}`
          : "",
      privacy: PUBLIC_LINE,
      // Whom it pays, in full, where it's checked.
      receive: {
        account: destination,
        amount: route.mode === "hyperlane" ? formatUnitsGrouped(quote.receiveLux ?? lux, route.amountDecimals) : formatLux(quote.receiveLux ?? lux),
        chain: route.to.id,
        full: true,
        unit: routeUnits(route).receive,
        where: [to, payeeName].filter(Boolean).join(" · "),
      },
      routeId: route.id,
      send: {
        account: route.signer === "dusk" ? (duskName() ? "" : short(duskAccount())) : short(evmAccount()),
        amount: amountText,
        chain: route.from.id,
        unit: routeUnits(route).send,
        where: route.signer === "dusk" && duskName() ? `${from} · ${duskName()}` : from,
      },
      signer: { account: signerNow(route.signer), wallet: route.signer },
      amountLux: lux,
      destination,
    };
    if (route.mode === "hyperlane") return openHyperlaneReview(route, { ...base, amountText, quote, walletName }, opener);
    if (route.mode === "migration") {
      const network = route.from.id;
      const migration = formReads.reads.migration ?? {};
      const needsApproval = (migration.allowanceWei ?? 0n) < lux * WEI_PER_LUX;
      // An approval not used up is replaced by this one, not added to.
      const replaces = needsApproval ? replacedLine(migration.allowanceWei ?? 0n, tokenName(network)) : "";
      const token = tokenName(network);
      const gasPrice = migration.gasPriceWei ?? null;
      const fee = (gas) => (gasPrice && gas ? gas * gasPrice : null);
      const chain = cfg.evmNetworks[network];
      // What each window will show is under Details; an approval's spender, which the wallet doesn't name, in full.
      const steps = [];
      if (needsApproval)
        steps.push({
          confirmLabel: `Approve ${amountText} ${token}`,
          lines: approveLines({ amountLux: lux, cfg, fee: fee(migration.gas?.approve), network }),
          ready: true,
          spender: { address: chain.migrationContract, name: "Dusk migration contract" },
          title: `Approve exactly ${amountText} ${token}`,
          walletName,
        });
      steps.push({
        confirmLabel: `Migrate ${amountText} ${token}`,
        lines: migrateLines({ amountLux: lux, cfg, duskAccount: destination, fee: fee(migration.gas?.migrate), network }),
        ready: true,
        title: "Migrate",
        walletName,
      });
      reviews.start({
        ...base,
        current: 0,
        notes: replaces ? [replaces] : [],
        steps,
        stepsLine: needsApproval ? `Approve exactly ${amountText} ${token}, then migrate` : "",
        sub: "",
      });
      openSheet("review", opener);
      return;
    }
    if (route.mode === "duskevm-withdrawal") {
      reviews.start({
        ...base,
        current: 0,
        steps: [
          {
            confirmLabel: `Send ${amountText} DUSK`,
            lines: withdrawLines({ amountLux: lux, cfg, duskAccount: destination, fee: quote.evmFeeWei ?? null }),
            ready: true,
            title: `Send on ${from}`,
            walletName,
          },
        ],
        sub: "Step 1 of 3. Then prove and claim on Dusk, with Dusk Wallet.",
      });
      openSheet("review", opener);
      return;
    }
    // From Dusk: the request is built now and sent as reviewed.
    const review = reviews.start({
      ...base,
      current: 0,
      // A payout goes through the bridge's own account, with the address it pays as the memo: the wallet shows both.
      steps: [{ confirmLabel: `Send ${amountText} DUSK`, ready: false, title: "Send from Dusk", wait: "Preparing…", walletName: "Dusk Wallet" }],
      sub: "",
    });
    openSheet("review", opener);
    await reviews.fill(
      review,
      // At the price the page quoted: the review and the request say the same fee.
      async () => {
        const request =
          route.mode === "duskevm-deposit"
            ? await depositRequest({ amountLux: lux, gasPrice: duskGasPrice(), node: services.node, recipient: destination })
            : await serviceTransferRequest({ amountLux: lux, destination, gasPrice: duskGasPrice(), node: services.node });
        // What Dusk Wallet's window will show, for Details.
        const lines =
          route.mode === "duskevm-deposit"
            ? await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: duskAccount(), fromName: duskName(), note: "The DuskEVM bridge contract on Dusk." })
            : duskTransferLines({ amountLux: request.amountLux, chainId: cfg.dusk.chainId, from: duskAccount(), fromName: duskName(), gas: request.gas, memo: request.memo, to: request.to });
        return { lines, request };
      },
      ({ lines, request }) => {
        review.request = request;
        review.steps[0] = { ...review.steps[0], lines, ready: true };
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

  /**
   * The review of a revoke: what the migration contract may take now, and the
   * approval of 0 the EVM wallet will show, once its gas is estimated.
   */
  async function openRevokeReview(opener) {
    const route = formRoute();
    if (!route || route.mode !== "migration" || !evmAccount()) return;
    const network = route.from.id;
    const walletName = evmWalletName(state.evmState);
    const parts = (feeWei) => revokeReview(route, { cfg, evm: state.evmState, feeWei, reads: formReads.reads, walletName: walletName === "your EVM wallet" ? "your wallet" : walletName });
    const before = parts(null);
    const review = reviews.start({
      ...before,
      current: 0,
      error: "",
      kind: "revoke",
      routeId: route.id,
      signer: { account: evmAccount(), wallet: "evm" },
      steps: before.steps.map((step) => ({ ...step, ready: false, wait: "Preparing…" })),
    });
    openSheet("review", opener);
    await reviews.fill(
      review,
      () => services.evmReads.revokeGas(network, review.signer.account),
      (gas) => {
        const price = formReads.reads.migration?.gasPriceWei;
        Object.assign(review, parts(gas && price ? gas * price : null));
      },
      (error) => {
        review.error = friendlyWalletError(error, "evm");
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
    // What its button says: a proof, or a claim of what it pays out.
    const confirmLabel = (amountLux) => (kind === "prove" ? "Prove" : amountLux === null ? "Claim" : `Claim ${formatLux(amountLux)} DUSK`);
    const first = lead(stepMax);
    const review = reviews.start({
      amountLux: entry.amountLux,
      checks: [],
      current: 0,
      entryId: id,
      error: "",
      feeRows: first.rows,
      kind,
      lead: first,
      // Only the account that proved can claim with that proof.
      notes: kind === "prove" ? ["Only the account that proves can claim"] : [],
      // Signed on Dusk: a busy network is said.
      warnings: duskBusy(),
      privacy: actionPrivacy(kind),
      routeId: route.id,
      steps: [{ confirmLabel: confirmLabel(view.amount), ready: false, title: kind === "prove" ? "Prove the withdrawal" : "Claim the DUSK", wait: "Preparing…", walletName: "Dusk Wallet" }],
      sub: kind === "prove" ? "Step 2 of 3: prove" : "Step 3 of 3: claim",
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
        // What Dusk Wallet's window will show, as it reads the call, for Details.
        const lines = await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: account, fromName: account === duskAccount() ? duskName() : "", note: "The DuskEVM withdrawal portal on Dusk." });
        return { account, claim, decoded, lines, request };
      },
      ({ account, claim, decoded, lines, request }) => {
        // Prepared for the account Dusk Wallet had then: only it can confirm,
        // and it's the one the proof or claim makes public.
        review.signer = { account, wallet: "dusk" };
        review.request = request;
        // What it pays and to whom, as the call carries them, as Dusk Wallet reads them.
        review.lead = lead(BigInt(request.gas.limit) * BigInt(request.gas.price), claim, decoded);
        review.feeRows = review.lead.rows;
        review.steps[0] = { ...review.steps[0], confirmLabel: confirmLabel(decoded ? decoded.amountWei / WEI_PER_LUX : view.amount), lines, ready: true };
      },
      (error) => {
        review.error = friendlyWalletError(error, "dusk");
      },
    );
    if (state.sheet === "review" && reviews.current === review) renderSheet();
  }

  // -------------------------------------------------------------------------
  // Hyperlane: transfers both ways, and claims of what a route holds
  // -------------------------------------------------------------------------

  /**
   * The quote of a Hyperlane transfer from Dusk at the fee and gas price its
   * request was built with, for the review's fee rows and checks.
   */
  function hyperlaneReviewAt(route, review, request) {
    const read = { ...(formReads.reads.hyperlane ?? {}), fee: request.fee ?? formReads.reads.hyperlane?.fee ?? null };
    const quote = buildQuote(route, state.form?.amount ?? amountForUnits(review.amountLux, route.amountDecimals), {
      balance: formReads.reads.duskBalance,
      cfg,
      gasPrice: BigInt(request.gas.price),
      hyperlane: read,
      timing: timing(),
    });
    return {
      checks: reviewChecks(route, { cfg, destination: review.destination, duskAccount: duskAccount(), evm: state.evmState, quote, reads: { ...formReads.reads, hyperlane: read } }),
      feeRows: quote.rows.filter((row) => !["send", "receive"].includes(row.key)),
      // The fees as one figure, their split under Details.
      fees: quote.fees ?? null,
      // At the request's own fee: one that moved past the amount, or back under it, says so.
      warnings: [...feeNotes(quote), ...busyFor(route)],
    };
  }

  /**
   * A transfer back to Dusk's review at delivery fee `fee`: its fee rows,
   * its checks, and whether its step can be sent (`evmReviewParts`), with
   * what the route said of its account when the review was read.
   */
  function showEvmReview(review, route, fee) {
    const parts = evmReviewParts(route, {
      amountLux: review.amountLux,
      cfg,
      destination: review.destination,
      duskAccount: duskAccount(),
      evm: state.evmState,
      fee,
      reads: formReads.reads,
      registered: review.registered,
      timing: timing(),
    });
    review.checks = parts.checks;
    review.deliveryFee = parts.deliveryFee;
    review.feeRows = parts.feeRows;
    review.fees = parts.fees;
    review.firstToAccount = parts.firstToAccount;
    review.steps[0] = { ...review.steps[0], lines: parts.lines, ready: parts.ready };
  }

  /**
   * The review of a Hyperlane transfer. Back to Dusk: one step in the EVM
   * wallet, ready once the delivery fee, and whether the route pays the
   * reviewed account yet, are read for it; the fee is read again as it's
   * sent. To the EVM chain: one step in Dusk Wallet, with an approval first
   * where a token's route can't take the amount yet. Each Dusk step's
   * request is built after its checks, once the step before it is in a
   * block, and is what's sent.
   */
  async function openHyperlaneReview(route, base, opener) {
    const { amountText, quote, walletName, ...rest } = base;
    const token = route.hyperlane;
    const unit = route.token.symbol;
    const from = networkName(cfg, route.from.id);
    const to = networkName(cfg, route.to.id);
    if (route.signer === "evm") {
      // Whether its account waits for a claim is said once read for it, not as the form read another.
      const unread = evmReviewParts(route, {
        amountLux: base.amountLux,
        cfg,
        destination: base.destination,
        duskAccount: duskAccount(),
        evm: state.evmState,
        fee: quote.bridgeFeeWei ?? null,
        reads: formReads.reads,
        registered: null,
        timing: timing(),
      });
      const review = reviews.start({
        ...rest,
        checks: unread.checks,
        current: 0,
        feeRows: unread.feeRows,
        firstToAccount: false,
        registered: null,
        steps: [{ confirmLabel: `Send ${amountText} ${unit}`, ready: false, title: `Send on ${from}`, wait: "Reading the fee…", walletName }],
        sub: "",
      });
      openSheet("review", opener);
      await reviews.fill(
        review,
        () =>
          Promise.all([
            // What its send checks again: both routers, the token's pause on Dusk, and the whole charge.
            inboundCharge(services.hyperlane, token, { amount: review.amountLux, recipientHash: duskRecipientHash(review.destination) }).then((charge) => charge.native),
            services.hyperlane.escrow(duskRecipientHash(review.destination), [token]).then(([one]) => one?.registered ?? null),
          ]),
        ([fee, registered]) => {
          review.registered = registered;
          showEvmReview(review, route, fee);
        },
        (error) => {
          review.error = friendlyWalletError(error, "evm");
        },
      );
      if (state.sheet === "review" && reviews.current === review) renderSheet();
      return;
    }
    // Whether an approval comes first isn't known until the route's allowance is read: no review before.
    if (quote.steps === null) return;
    const approves = quote.steps === 2;
    // The route that an approval lets take the amount, in full: the security check of an approval.
    const steps = [];
    if (approves)
      steps.push({
        confirmLabel: `Approve ${amountText} ${unit}`,
        kind: "approve",
        ready: false,
        spender: { address: token.dusk.route, name: `the bridge's ${unit} route` },
        title: `Approve exactly ${amountText} ${unit}`,
        wait: "Preparing…",
        walletName: "Dusk Wallet",
      });
    steps.push({ confirmLabel: `Send ${amountText} ${unit}`, kind: "send", ready: false, title: "Send from Dusk", wait: "Preparing…", walletName: "Dusk Wallet" });
    const review = reviews.start({
      ...rest,
      current: 0,
      steps,
      stepsLine: approves ? `Approve exactly ${amountText} ${unit}, then send` : "",
      sub: "",
    });
    openSheet("review", opener);
    await prepareHyperlaneStep(review, route);
  }

  /** Builds the request of a Hyperlane review's current Dusk step, after its checks: what's sent. */
  async function prepareHyperlaneStep(review, route) {
    const token = route.hyperlane;
    const step = review.steps[review.current];
    const gasPrice = duskGasPrice();
    await reviews.fill(
      review,
      async () => {
        const sender = review.signer.account;
        const deps = { amount: review.amountLux, cfg, gasPrice, node: services.node, reads: services.hyperlane, recipient: review.destination, sender, token };
        const request = step.kind === "approve" ? await approveRequest(deps) : await transferRemoteRequest(deps);
        // What Dusk Wallet can't read, and says to check on the site, has its own fold; what it reads, its window's lines under Details.
        const call = await callDetails(request, { cfg, reads: services.hyperlane, token });
        const lines = call
          ? null
          : await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: sender, fromName: sender === duskAccount() ? duskName() : "", note: `The ${route.token.symbol} token on Dusk.` });
        return { call, lines, request };
      },
      ({ call, lines, request }) => {
        review.request = request;
        review.steps[review.current] = { ...review.steps[review.current], call, lines, ready: true };
        // The fee rows and the checks at the request's own fee and price, the approval's too.
        Object.assign(review, hyperlaneReviewAt(route, review, request));
      },
      (error) => {
        review.error = friendlyWalletError(error, "dusk");
      },
    );
    if (state.sheet === "review" && reviews.current === review) renderSheet();
  }

  /** Waits for a Dusk transaction this page sent to be in a block, as the step after it needs. */
  async function includedOnDusk(hash, what) {
    for (let tries = 0; tries < 30; tries += 1) {
      const tx = await services.node.transaction(hash).catch(() => null);
      if (tx?.error) throw Object.assign(new Error(`The ${what} failed on Dusk: ${tx.error}`), { code: "FAILED_ON_DUSK" });
      if (tx) return tx;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(`The ${what} isn't in a block yet. Check Dusk Wallet's activity, then review again.`);
  }

  /**
   * Sends a Hyperlane review's current step. Back to Dusk, from the EVM
   * wallet, with the delivery fee read again as it's sent. To the EVM chain,
   * an approval first, waited for until it's in a block, then the transfer,
   * checked again as it's signed: a fee that moved shows on the review, and
   * nothing goes until it's confirmed again.
   */
  async function confirmHyperlane(review, route) {
    const token = route.hyperlane;
    if (route.signer === "evm") {
      let hash;
      try {
        hash = await sendToDusk(cfg, {
          account: review.signer?.account,
          amount: review.amountLux,
          reads: services.hyperlane,
          recipient: review.destination,
          reviewedFee: review.deliveryFee ?? null,
          token,
        });
      } catch (error) {
        if (error?.code !== "FEE_CHANGED") throw error;
        // The new fee on the review's rows and checks alike; nothing goes until it's confirmed again.
        showEvmReview(review, route, error.fee);
        review.busy = false;
        review.error = error.message;
        announce(error.message);
        renderSheet();
        reviews.stepShown();
        return;
      }
      sent({
        amountLux: review.amountLux.toString(),
        destination: review.destination,
        firstToAccount: review.firstToAccount || undefined,
        hash,
        parties: [evmAccount(), review.destination],
        routeId: route.id,
        sender: evmAccount(),
      });
      void followMined(route, hash);
      return;
    }
    const step = review.steps[review.current];
    if (step.kind === "approve") {
      // An approval sent already is waited for again, not sent again; one that
      // failed is. Before it goes, every check the transfer after it needs is
      // made again: the route as booked, the Mailbox's room, the token.
      if (!review.approvalHash) {
        const again = await recheckApproval(review.request, {
          amount: review.amountLux,
          cfg,
          gasPrice: BigInt(review.request.gas.price),
          node: services.node,
          reads: services.hyperlane,
          recipient: review.destination,
          sender: review.signer.account,
          token,
        });
        if (again.changed) {
          // Shown again, at what's asked now: nothing goes until that's confirmed.
          const moved = again.request.fee !== review.request.fee ? feeChanged(formatDusk(again.request.fee)) : "The approval changed since the review. Check it again.";
          rebuilding(review);
          review.busy = false;
          review.error = moved;
          announce(moved);
          renderSheet();
          await prepareHyperlaneStep(review, route);
          reviews.stepShown();
          return;
        }
        review.approvalHash = (await sendDuskContractCall(review.request, { account: review.signer?.account })).hash;
      }
      review.busyLabel = "Waiting for Dusk…";
      renderSheet();
      try {
        // Kept with the transfer: its fee is part of what it cost.
        review.approvalFeeLux = duskFeePaid(await includedOnDusk(review.approvalHash, "approval"));
      } catch (error) {
        if (error?.code === "FAILED_ON_DUSK") review.approvalHash = null;
        throw error;
      }
      Object.assign(review, { busy: false, busyLabel: "", current: review.current + 1, request: null, stepsLine: "", sub: "Approved. Step 2: send" });
      announce("Approved. Step 2 is ready.");
      void loadReads();
      renderSheet();
      reviews.stepShown();
      await prepareHyperlaneStep(review, route);
      return;
    }
    try {
      // Checked again as it's signed: the route's quote must still be the reviewed one.
      await transferRemoteRequest({
        amount: review.amountLux,
        cfg,
        gasPrice: BigInt(review.request.gas.price),
        node: services.node,
        reads: services.hyperlane,
        recipient: review.destination,
        reviewedFee: review.request.fee,
        sender: review.signer.account,
        token,
      });
    } catch (error) {
      if (error?.code !== "FEE_CHANGED") throw error;
      rebuilding(review);
      review.busy = false;
      review.error = error.message;
      announce(error.message);
      renderSheet();
      await prepareHyperlaneStep(review, route);
      reviews.stepShown();
      return;
    }
    const scanFrom = await headBlock(route.to.id);
    const { hash } = await sendDuskContractCall(review.request, { account: review.signer?.account });
    sent({
      amountLux: review.amountLux.toString(),
      approvalFeeLux: review.approvalHash ? review.approvalFeeLux : undefined,
      approvalHash: review.approvalHash ?? undefined,
      destination: review.destination,
      hash,
      parties: [duskAccount(), review.destination],
      routeId: route.id,
      scanFrom,
      sender: duskAccount(),
    });
  }

  /**
   * The review of a claim of what a Hyperlane route holds: from a transfer's
   * receipt or row (`data-id`), for its account, or from the card's box
   * (`data-route`), for the connected account. Its own account claims it;
   * another can claim it for it, paying only the network fee.
   */
  async function openClaimReview(target) {
    const entry = target.dataset.id ? state.activity.find((item) => item.id === target.dataset.id) : null;
    const route = routeOf(entry ? entry.routeId : target.dataset.route);
    if (!route || route.mode !== "hyperlane") return;
    // Dusk Wallet signs it: first the wallet, where there's one to choose, or none connected.
    if (state.dusk?.choices.length || !duskAccount()) return connectDusk(target);
    const token = route.hyperlane;
    // The account it's held for: the transfer's, known here or by its hash, or else the card's.
    const account = entry ? entry.destination || (entry.recipientHash === duskRecipientHash(duskAccount()) ? duskAccount() : "") : target.dataset.account || duskAccount();
    if (!account) {
      announce("This transfer's Dusk account isn't known on this page. Its own account can claim it from the card.");
      return;
    }
    // A claim sent for the account on this route pays out all it holds: it's waited for, not sent twice.
    if (claimWatch.pending(claimKey(route.id, account))) {
      announce("Claim sent, waiting for Dusk.");
      return;
    }
    const gasPrice = duskGasPrice();
    const amountOf = (pending) => (pending === null ? "" : formatUnitsGrouped(pending, route.amountDecimals));
    // What moves and whom it pays, in full; for another account, that you pay only the network fee.
    const lead = (signer, pending) => ({
      amount: amountOf(pending),
      chain: "dusk",
      label: "You claim",
      notYours: signer === account ? "" : "Not your account: you pay only the network fee",
      payee: account,
      unit: route.token.symbol,
    });
    const feeRows = (maxLux) => [{ key: "fee", label: "Network fee", value: `up to ${formatMaxFee(maxLux)} DUSK` }];
    const confirmLabel = (signer, pending) => (signer === account && pending !== null ? `Claim ${amountOf(pending)} ${route.token.symbol}` : "Claim for it");
    const held = entry?.heldLux ? BigInt(entry.heldLux) : (formReads.reads.escrow?.held.find((each) => each.token.symbol === token.symbol)?.pending ?? null);
    const own = account === duskAccount();
    const review = reviews.start({
      amountLux: held,
      checks: [],
      current: 0,
      entryId: entry?.id ?? null,
      error: "",
      feeRows: feeRows((own ? HYPERLANE_GAS.claim : HYPERLANE_GAS.claimFor).limit * gasPrice),
      kind: "claim",
      // Signed on Dusk: a busy network is said.
      warnings: duskBusy(),
      lead: lead(duskAccount(), held),
      privacy: own ? "Public: your account and the amount" : PUBLIC_LINE,
      // Whose escrow it claims: what the card says is claimed, once it's sent.
      claimFor: account,
      routeId: route.id,
      signer: { account: duskAccount(), wallet: "dusk" },
      steps: [{ confirmLabel: confirmLabel(duskAccount(), held), ready: false, title: own ? "Claim from the bridge" : "Claim for this account", wait: "Preparing…", walletName: "Dusk Wallet" }],
      sub: "",
    });
    openSheet("review", target);
    await reviews.fill(
      review,
      async () => {
        const { account: signer } = await ensureDuskConnected(cfg.dusk.chainId);
        review.signer = { account: signer, wallet: "dusk" };
        const request = await claimRequest({ account, cfg, gasPrice, node: services.node, reads: services.hyperlane, signer, token });
        return { call: await callDetails(request, { cfg, reads: services.hyperlane, token }), request, signer };
      },
      ({ call, request, signer }) => {
        review.signer = { account: signer, wallet: "dusk" };
        review.request = request;
        review.amountLux = request.pending;
        review.lead = lead(signer, request.pending);
        review.feeRows = feeRows(BigInt(request.gas.limit) * BigInt(request.gas.price));
        review.privacy = signer === account ? "Public: your account and the amount" : PUBLIC_LINE;
        review.steps[0] = { ...review.steps[0], call, confirmLabel: confirmLabel(signer, request.pending), ready: true, title: signer === account ? "Claim from the bridge" : "Claim for this account" };
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
      if (evmStep(review) && switchTo(route)) {
        await ensureEvmChain(signingChain(route));
        review.busy = false;
        reviews.stepShown();
        renderSheet();
        return;
      }
      // A claim of what a Hyperlane route holds, built again as it's sent:
      // what it pays out changed, it's reviewed again. Sent, the card's box
      // and each transfer it pays out wait for its transaction.
      if (review.kind === "claim") {
        const again = await recheckClaim(review.request, {
          account: review.claimFor,
          cfg,
          node: services.node,
          reads: services.hyperlane,
          signer: review.signer.account,
          token: route.hyperlane,
        });
        if (again.changed) {
          const amount = formatUnitsGrouped(again.request.pending, route.amountDecimals);
          review.request = again.request;
          review.amountLux = again.request.pending;
          review.lead = { ...review.lead, amount };
          review.steps[0] = {
            ...review.steps[0],
            call: await callDetails(again.request, { cfg, reads: services.hyperlane, token: route.hyperlane }),
            confirmLabel: review.signer.account === review.claimFor ? `Claim ${amount} ${route.token.symbol}` : review.steps[0].confirmLabel,
          };
          review.busy = false;
          review.error = `The bridge now holds ${formatToken(again.request.pending, route.token)} for this account`;
          announce(review.error);
          renderSheet();
          reviews.stepShown();
          return;
        }
        const { hash } = await sendDuskContractCall(review.request, { account: review.signer?.account });
        review.busy = false;
        closeSheet();
        claimWatch.sent(claimKey(review.routeId, review.claimFor), hash);
        const paid = new Set([review.entryId, ...heldFor(state.activity, review.routeId, review.claimFor).map((each) => each.id)].filter(Boolean));
        for (const id of paid) {
          setActivity(updateActivity(id, { actionError: null, pendingAction: "claim", pendingAt: Date.now(), pendingHash: hash }));
          track(id);
        }
        announce("Claim sent.");
        render();
        return;
      }
      if (route.mode === "hyperlane") return await confirmHyperlane(review, route);
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
      // A revoke goes out from the account it was reviewed for; with nothing
      // approved any more, the wallet is asked for nothing.
      if (review.kind === "revoke") {
        await revokeMigration(cfg.evmNetworks[route.from.id], { account: review.signer?.account });
        review.busy = false;
        closeSheet();
        if (state.form) state.form.approvalNote = "The approval is revoked.";
        announce("The approval is revoked.");
        await loadReads();
        // Drawn again as reads land, the word keeps focus by its id.
        root.querySelector("#approval-note")?.focus();
        return;
      }
      // An EVM step goes out from the account it was reviewed for, which the
      // wallet is asked for again once it's on the chain.
      if (route.mode === "migration") {
        const network = cfg.evmNetworks[route.from.id];
        const step = review.steps[review.current];
        const amount = formatDuskPlain(review.amountLux);
        if (step.title.startsWith("Approve")) {
          // Kept with the transfer: its gas is part of what it cost.
          review.approvalHash = await approveMigration(network, amount, { account: review.signer?.account });
          review.current += 1;
          review.sub = "Approved. Step 2: migrate";
          review.stepsLine = "";
          review.busy = false;
          announce("Approval confirmed. Step 2 is ready.");
          // The allowance changed: read it again, with the migration's gas.
          await loadReads();
          renderSheet();
          reviews.stepShown();
          return;
        }
        const hash = await submitMigration(network, amount, review.destination, { account: review.signer?.account });
        sent({
          amountLux: review.amountLux.toString(),
          approvalHash: review.approvalHash,
          destination: review.destination,
          hash,
          parties: [evmAccount(), review.destination],
          routeId: route.id,
          sender: evmAccount(),
        });
        void followMined(route, hash);
        return;
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
        notSent(review, error, { announce, wallet: evmStep(review) && route.signer === "evm" ? "evm" : "dusk" });
        if (review.entryId) {
          // Kept on the transfer: its receipt says so behind the sheet, grey when you cancelled.
          setActivity(updateActivity(review.entryId, { actionError: actionErrorOf(error) }));
          if (state.page.page === "transfer") renderMain();
        }
        renderSheet();
      }
    }
  }

  /**
   * A migration sent from here, followed until it's mined. Sped up in the
   * wallet, it's mined under another hash: its transfer, and its receipt on
   * screen, go by that one. Cancelled or replaced there, it moved nothing.
   */
  async function followMined(route, hash) {
    let found;
    try {
      found = await minedAs(cfg.evmNetworks[route.from.id], hash);
    } catch {
      return;
    }
    const next = minedTransfer(state.activity, { hash, mined: found.hash, replaced: found.replaced, routeId: route.id });
    if (!next) return;
    // Sped up, it goes by its mined hash: its end is told as the one sent here.
    ends.moved(entryId(route.id, hash), next.id);
    setActivity(saveActivity(next.items));
    track(next.id);
    if (state.page.page !== "transfer" || canonicalHash(hash) !== state.page.hash) return;
    const now = state.activity.find((item) => item.id === next.id);
    if (now && canonicalHash(now.hash) !== state.page.hash) globalThis.location.replace(transferHref(now.hash));
    else renderMain();
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
    ends.sent(entryId(entry.routeId, entry.hash));
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

  /**
   * "Add DUSK to <wallet>", pressed: drawn again whatever the wallet answers,
   * as it then stands. Once it added DUSK, that's said, and shown where the
   * offer was, which focus goes to; where the offer went from under the press
   * otherwise, focus goes to the page. A refusal says nothing, and leaves the
   * offer, and focus, where they were.
   */
  const duskOffer = createDuskOffer({
    add: addDusk,
    redraw: (added, network) => {
      if (added) duskAdded.remember(network, state.evmState);
      if (isCardPage()) refreshForm();
      else renderMain();
      if (added) announce(`DUSK added to ${evmWalletName(state.evmState)}.`);
      const focused = globalThis.document?.activeElement;
      if (!focused || focused === globalThis.document?.body) (slot("main").querySelector("#dusk-added") ?? slot("main").querySelector("#main"))?.focus({ preventScroll: true });
    },
  });

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
      state.lookup.error = NOT_TRANSACTION_ID;
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
    state.lookup.error = found?.message ?? "No bridge transfer with this ID yet";
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
      state.form.approvalNote = "";
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
      "add-dusk": () => {
        const network = cfg.evmNetworks[target.dataset.net];
        return network ? duskOffer.press(network) : undefined;
      },
      calendar: downloadCalendar,
      "close-sheet": closeByPerson,
      // What a Hyperlane route holds for an account, from its transfer or the card's box.
      "escrow-claim": () => openClaimReview(target),
      // Not in the moment the review or its next step comes up (review-session.js).
      confirm: () => (reviews.confirmable ? confirmReview() : undefined),
      "choose-dusk": () => chooseDusk(target.dataset.wallet),
      // The connected Dusk Wallet: another profile, or none.
      "open-dusk": () => openSheet("dusk", target),
      "dusk-disconnect": async () => {
        closeSheet();
        const failed = await disconnectDusk(state.dusk);
        if (failed) return showError(failed);
        announce("Dusk Wallet is disconnected.");
        render();
      },
      "dusk-other-profile": async () => {
        closeSheet();
        // The wallet asks which profile again once this page let go of this one, and only then.
        const failed = await disconnectDusk(state.dusk);
        if (failed) return showError(failed);
        await connectDusk(target);
        render();
      },
      "connect-dusk": () => connectDusk(target),
      "connect-evm": connectEvm,
      "discover-more": () => discover({ more: true }),
      // What an approval not used up still lets go, to its review: Approve is skipped.
      "approval-finish": () => {
        const route = formRoute();
        const open = route && approvalOpen(route);
        if (!open?.finishLux) return undefined;
        state.form.amount = amountForInput(open.finishLux);
        state.form.approvalNote = "";
        const input = root.querySelector("#amount");
        if (input) input.value = state.form.amount;
        refreshForm();
        loadGasSoon();
        return openReview(target);
      },
      "approval-revoke": () => openRevokeReview(target),
      max: () => {
        const route = formRoute();
        const quote = quoteFor(route);
        if (quote.maxLux === null || quote.maxLux === undefined) return;
        state.form.amount = route.mode === "hyperlane" ? amountForUnits(quote.maxLux, route.amountDecimals) : amountForInput(quote.maxLux);
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
      // The route's approval couldn't be read: read what the card needs again.
      "read-again": () => {
        void loadReads();
        renderMain();
      },
      "pick-net": () => {
        if (target.getAttribute("aria-disabled") === "true") return;
        const route = formRoute();
        const net = target.dataset.net;
        // The token stays where the new pair moves it.
        const token = tokenOf(route);
        const next = target.dataset.side === "from" ? choosePair(routes, { from: net, to: route.to.id, token }) : routeBetween(routes, route.from.id, net, token);
        if (next) setPair(next);
        state.form.menu = null;
        renderMain();
        root.querySelector(`[data-action="open-menu"][data-side="${target.dataset.side}"]`)?.focus();
      },
      "pick-token": () => {
        const next = routes.find((route) => route.id === target.dataset.route);
        if (next) setPair(next);
        state.form.menu = null;
        renderMain();
        root.querySelector('[data-action="open-menu"][data-side="token"]')?.focus();
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
      // A claim a transfer says it sent before this page loaded: no other is offered until it settles.
      for (const entry of state.activity)
        if (entry.status === "pending" && entry.pendingAction === "claim" && entry.pendingHash && entry.recipientHash) claimWatch.resume(claimKey(entry.routeId, entry.recipientHash), entry.pendingHash, entry.pendingAt);
      if (state.page.page === "transfer") void openReceipt(state.page.hash);
      watchEscrow();
      const [dusk] = await Promise.all([createDuskConnection().catch(() => null), initializeEvmWallet().catch(() => getEvmState())]);
      state.dusk = dusk;
      dusk?.subscribe((next) => {
        const previous = state.duskState.selectedProfile?.account ?? null;
        const changed = next.selectedProfile?.account !== previous;
        state.duskState = next;
        lookUpName(duskAccount());
        if (changed) {
          if (signerMoved(reviews.current) && state.sheet === "review") renderSheet();
          formReads.reset(["duskBalance", "escrow", "hyperlane"]);
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
        const moved = evmMoved(state.evmState, next);
        const chainChanged = moved.chain;
        const accountChanged = moved.account;
        // Another wallet at the same address and chain changes what the page says it did, as "DUSK added to <wallet>".
        const changed = accountChanged || chainChanged || moved.wallet;
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
          formReads.reset(["migration", "l2", "hyperlane"]);
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
