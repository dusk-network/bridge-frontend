// The bridge page: a start page of tasks, one form per task with its quote,
// a review sheet that lists what each wallet will show, a receipt per
// transfer at its own link, and My transfers read from the networks.
// Chain state comes from the deployment's own node and RPCs; the wallets
// are asked only for accounts, signatures and sends.

import { entryId, readActivity, recordActivity, saveActivity, updateActivity, useActivityNetwork } from "./activity.js";
import { bridgeRoutes, getBridgeRoute } from "./bridge-routes.js";
import { claimReminder } from "./calendar.js";
import { config } from "./config.js";
import { contractGroups, explorerAddressUrl, serversLine } from "./contracts.js";
import { followAfterDiscovery, mergeTransfer, mergeTransfers, partyKey } from "./discovery.js";
import { createDiscoveryRuns } from "./discovery-runs.js";
import { depositRequest, submitDuskEvmDeposit } from "./dusk-deposit.js";
import { topGap } from "./dusk-history.js";
import { createDuskConnection, ensureDuskConnected, sendDuskContractCall } from "./dusk-wallet.js";
import { submitDuskEvmWithdrawal } from "./duskevm-withdrawal.js";
import { connectEvmWallet, getEvmState, initializeEvmWallet, subscribeEvmWallet } from "./evm-wallet.js";
import { createFormReads } from "./form-reads.js";
import { formatDusk, formatFee, formatLux, formatUnitsGrouped } from "./format.js";
import { approveMigration, submitMigration } from "./legacy-migration.js";
import { bridgeTasks, networkName, networkNames } from "./names.js";
import {
  actionLead,
  actionPrivacy,
  availableLine,
  pricedReview,
  DUSK_WALLET_URL,
  evmWalletName,
  landingTasks,
  lateLine,
  receiptModel,
  reviewChecks,
  transfersModel,
} from "./page-models.js";
import { canonicalHash, parseLocation, receiptUrl, transferHref } from "./permalink.js";
import { buildQuote, parseAmount, routeDuskFees } from "./quote.js";
import { serviceTransferRequest, submitServiceTransfer } from "./service-transfer.js";
import { createServices, proofSubmitterFor } from "./services.js";
import { createLookupFlow } from "./lookup-flow.js";
import { createReceiptLookups } from "./receipt-lookups.js";
import { checkDuskRecipient, checkEvmRecipient, isDuskName } from "./recipient.js";
import { readWatched, saveWatched, watchTarget } from "./watched-account.js";
import { createReviewSession, sameSigner, sentActionPatch } from "./review-session.js";
import { createScheduler, takenByAnother } from "./tracking.js";
import { friendlyWalletError, html, privacyLine, proverMismatch, short, switchToProver, transferView } from "./transfer-view.js";
import {
  contractsSheet,
  footer,
  formPage,
  formRegions,
  header,
  landing,
  lookupPage,
  networkSheet,
  receiptPage,
  reviewSheet,
  strip,
  transfersPage,
} from "./views.js";
import { approveLines, duskCallLines, duskTransferLines, migrateLines, withdrawLines } from "./wallet-lines.js";
import { withdrawalDetails } from "./withdrawals.js";

export { friendlyWalletError };

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
    menuOpen: false,
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
  // name points back to the account, or else the account's verified primary
  // name, looked up through this page's node.
  const namesFound = new Map();
  const namesAsked = new Set();
  const duskName = () => {
    const sent = duskState().selectedProfile?.name;
    const name = typeof sent === "string" && sent ? sent : namesFound.get(duskAccount()) ?? "";
    return /^[^\s<>"'&]{1,64}\.dusk$/u.test(name) ? name : "";
  };
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
        if (state.page.page === "move") refreshFormAndHeader();
        else renderMain();
      })
      .catch(() => {})
      .finally(() => namesAsked.delete(account));
  }
  const evmAccount = () => state.evmState.account ?? "";
  const tracked = new Set();
  // Balances and gas for the form; an older answer never overwrites a newer one.
  const formReads = createFormReads({ onChange: () => refreshFormAndHeader(), services });
  // One gas price for every "up to" fee on the page: the node's, as last read.
  const duskGasPrice = () => formReads.reads.gasPrice ?? 1n;
  // The review on screen; a request prepared for it fills nothing else.
  const reviews = createReviewSession();

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

  function chainNameFor(chainId) {
    if (!chainId) return "";
    if (cfg.duskEvm.enabled && chainId === cfg.duskEvm.chainId) return names["dusk-evm"];
    const match = Object.values(cfg.evmNetworks).find((network) => network.configured && network.chainId === chainId);
    return match ? names[match.id] : `chain ${chainId}`;
  }

  const evmVm = () =>
    evmAccount()
      ? { account: evmAccount(), chainName: chainNameFor(state.evmState.chainId), state: "connected", walletName: state.evmState.walletName }
      : { state: "connect" };

  const accounts = () => [listedDusk(), evmAccount()].filter(Boolean);

  function transfersVm() {
    return transfersModel(state.activity, { account: duskAccount(), accounts: accounts(), cfg, gasPrice: duskGasPrice(), routeOf, submitter: proofSubmitterFor(duskAccount()) });
  }

  function headerVm() {
    const other = cfg.profile === "testnet" ? "mainnet" : "testnet";
    const page = state.page.page;
    return {
      badge: names.badge,
      dusk: duskVm(),
      evm: evmVm(),
      isTestnet: cfg.profile === "testnet",
      menuOpen: state.menuOpen,
      nav: page === "transfers" || page === "transfer" || page === "lookup" ? "mine" : "move",
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
      operators: [
        cfg.migrations.length && cfg.operators.migration ? { name: cfg.operators.migration, route: "moving old DUSK" } : null,
        cfg.service && cfg.operators.service ? { name: cfg.operators.service, route: `Dusk to ${networkName(cfg, cfg.service.network)}` } : null,
        cfg.duskEvm.enabled && cfg.operators.duskEvm ? { name: cfg.operators.duskEvm, route: "DuskEVM" } : null,
      ].filter(Boolean),
    });
  }

  /** Re-renders the page, keeping focus and the caret where they were. */
  // An address field grows to show the whole address: its end is what people compare.
  function fitHeight(field) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + 2}px`;
  }

  function renderMain({ focus = false } = {}) {
    const active = globalThis.document?.activeElement;
    const keep = active && slot("main").contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    slot("main").innerHTML = pageHtml();
    for (const field of slot("main").querySelectorAll(".wrap-input")) fitHeight(field);
    if (keep) {
      const again = slot("main").querySelector(`#${keep.id}`);
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
    if (page === "move") return formHtml();
    if (page === "transfer") return receiptHtml();
    if (page === "transfers") return transfersHtml();
    if (page === "lookup") return lookupPage(state.lookup);
    return landing({
      canShare: Boolean(globalThis.navigator?.share),
      dusk: duskVm(),
      evm: evmVm(),
      pageUrl: globalThis.location?.href ?? "",
      phone: isPhone() && !duskState().installed,
      tasks: landingTasks(cfg, tasks, { duskInstalled: duskState().installed, gasPrice: duskGasPrice(), phone: isPhone() }),
    });
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------

  function taskFor(id) {
    return tasks.find((task) => task.id === id) ?? null;
  }

  function ensureForm(taskId) {
    const task = taskFor(taskId);
    if (!task) return null;
    if (state.form?.taskId !== taskId)
      state.form = {
        amount: "",
        error: "",
        // What each .dusk name typed as the recipient pointed to when looked up.
        lookups: {},
        recipientEditing: false,
        recipientInput: "",
        routeId: task.routes[0].id,
        taskId,
      };
    return state.form;
  }

  const formRoute = () => (state.form ? routeOf(state.form.routeId) : null);

  /** The typed recipient, checked: its address, a .dusk name's account, or why it isn't one. */
  function typedRecipient(route, form = state.form) {
    const typed = form?.recipientInput?.trim();
    if (!typed) return null;
    return route.to.kind === "dusk" ? checkDuskRecipient(typed, form.lookups) : checkEvmRecipient(typed);
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

  let nameTimer = null;
  /** A .dusk name typed as the Dusk recipient is looked up, a moment after typing stops. */
  function lookUpRecipientName() {
    clearTimeout(nameTimer);
    const form = state.form;
    const route = formRoute();
    const typed = form?.recipientInput?.trim() ?? "";
    if (!route || route.to.kind !== "dusk" || !isDuskName(typed) || !services.names) return;
    const name = typed.toLowerCase();
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
      return buildQuote(route, state.form.amount, { balance: reads.duskBalance, cfg, gasPrice: reads.gasPrice });
    if (route.mode === "migration") {
      const migration = reads.migration ?? {};
      return buildQuote(route, state.form.amount, {
        allowanceWei: migration.allowanceWei ?? 0n,
        balance: migration.balanceWei ?? null,
        cfg,
        evmGas: { approve: migration.gas?.approve, migrate: migration.gas?.migrate, priceWei: migration.gasPriceWei },
      });
    }
    const l2 = reads.l2 ?? {};
    return buildQuote(route, state.form.amount, {
      balance: l2.balanceWei ?? null,
      cfg,
      evmGas: { priceWei: l2.gasPriceWei, withdraw: l2.gas },
      gasPrice: reads.gasPrice,
    });
  }

  function signerReady(route) {
    return route.signer === "dusk" ? Boolean(duskAccount()) : Boolean(evmAccount());
  }

  function formVm() {
    const task = taskFor(state.form.taskId);
    const route = formRoute();
    const quote = quoteFor(route);
    const from = networkName(cfg, route.from.id);
    const to = networkName(cfg, route.to.id);
    const reads = formReads.reads;
    const walletName = evmWalletName(state.evmState);
    const phoneOnly = isPhone() && !duskState().installed;
    let fromRow;
    if (route.signer === "dusk") {
      fromRow = {
        balance: reads.duskBalance === null ? "" : `<b class="num">${html(formatDusk(reads.duskBalance, 4))}</b>public balance`,
        chain: "dusk",
        label: `From ${from}`,
        value: !duskAccount()
          ? `<span class="t2">Dusk Wallet isn't connected</span>`
          : duskName()
            ? `<span>${html(duskName())}</span>`
            : `<code class="mono">${html(short(duskAccount()))}</code>`,
        valueNote: !duskAccount() ? "" : duskName() ? `${short(duskAccount())} · your Dusk account` : "your Dusk account",
      };

    } else {
      const holdings = route.mode === "migration" ? reads.migration?.balanceWei : reads.l2?.balanceWei;
      fromRow = {
        balance:
          holdings === null || holdings === undefined
            ? ""
            : `<b class="num">${html(formatUnitsGrouped(holdings, 18, 4))} ${route.mode === "migration" ? "old DUSK" : "DUSK"}</b>on ${html(from)}`,
        chain: route.from.id,
        label: `From ${from}`,
        value: evmAccount() ? `<code class="mono">${html(short(evmAccount()))}</code>` : `<span class="t2">No EVM wallet connected</span>`,
        valueNote: evmAccount() ? `your ${walletName}` : "",
      };

    }
    const destination = destinationFor(route);
    const typed = typedRecipient(route);
    // A typed .dusk name, once its lookup found the account it points to.
    const resolved = typed?.name && typed.address ? { address: typed.address, name: typed.name } : null;
    const destinationIsOwn =
      route.to.kind === "dusk" ? destination && destination === duskAccount() : destination && destination.toLowerCase() === evmAccount().toLowerCase();
    const toVm = {
      canReset: Boolean(state.form.recipientInput) && Boolean(route.to.kind === "dusk" ? duskAccount() : evmAccount()),
      chain: route.to.id,
      editing: state.form.recipientEditing || !destination,
      empty: route.to.kind === "dusk" ? "Connect Dusk Wallet or paste a Dusk account" : "Connect an EVM wallet or paste a 0x address",
      error: typed?.error ?? "",
      fix: typed?.fix ?? "",
      input: state.form.recipientInput,
      label: `To ${to}`,
      looking: typed?.pending ? typed.name : "",
      // Your own Dusk account by its .dusk name, its short code beside it;
      // a typed name the same way.
      name: resolved ? resolved.name : destinationIsOwn && route.to.kind === "dusk" ? duskName() : "",
      placeholder: route.to.kind === "dusk" ? "A Dusk account or .dusk name" : "0x…",
      resolved,
      value: destination,
      valueNote: destinationIsOwn
        ? route.to.kind === "dusk"
          ? duskName() || resolved
            ? `${short(destination)} · your Dusk account`
            : "your Dusk account"
          : `your ${walletName}, on ${to}`
        : resolved
          ? short(destination)
          : "",
    };
    let notice = null;
    if (route.signer === "dusk" && phoneOnly)
      notice = {
        actions: `<div class="btn-row"><button type="button" class="btn sec sm" data-copy="${html(globalThis.location?.href ?? "")}" aria-label="Copy this page's link">Copy link</button>${globalThis.navigator?.share ? '<button type="button" class="btn sec sm" data-action="share">Share link</button>' : ""}</div>`,
        html: "This needs Dusk Wallet, the browser extension for computers. Open this page on your computer to send.",
        icon: "laptop",
      };
    else if (route.signer === "dusk" && !duskState().installed)
      notice = {
        html: `Sending from Dusk needs Dusk Wallet, the official Dusk browser extension. <a href="${html(DUSK_WALLET_URL)}" target="_blank" rel="noreferrer">Get Dusk Wallet</a>.`,
      };
    else if (route.mode === "duskevm-withdrawal" && phoneOnly)
      notice = { html: "Step 1 works here. Prove and claim need Dusk Wallet on a computer later.", icon: "phone" };
    const ready = signerReady(route);
    const amountOk = quote.amountLux !== null && !quote.error;
    const destinationOk = Boolean(destination) && !toVm.error;
    const reviewLabel = ready
      ? "Review"
      : route.signer === "dusk"
        ? duskState().installed
          ? "Connect Dusk Wallet"
          : phoneOnly
            ? "Send from a computer"
            : "Get Dusk Wallet to send"
        : "Connect EVM wallet";
    return {
      amount: state.form.amount,
      amountError: quote.error,
      ...availableLine(route, quote.maxLux),
      balanceNote: route.signer === "dusk" ? "Your public balance. Shielded and staked DUSK aren't included." : "",
      canReview: ready ? amountOk && destinationOk : route.signer === "dusk" ? duskState().installed : true,
      error: state.form.error,
      firstTime: !transfersVm().count,
      from: fromRow,
      notice,
      privacy: privacyLine(route, cfg, {
        dusk: route.to.kind === "dusk" ? destination : duskAccount(),
        evm: route.to.kind === "dusk" ? evmAccount() : destination,
        name: duskPartyName(route.to.kind === "dusk" ? destination : duskAccount(), resolved),
      }),
      quote,
      reviewHint:
        ready && amountOk && !destinationOk
          ? toVm.looking
            ? `Looking up ${toVm.looking}…`
            : toVm.error
              ? "Fix the address first."
              : "Add where it goes first."
          : "",
      reviewLabel,
      routeId: route.id,
      sources: task.routes.map((item) => ({ id: item.id, name: networkName(cfg, item.from.id) })),
      title: task.title,
      to: toVm,
      unit: route.mode === "migration" ? "old DUSK" : "DUSK",
    };
  }

  function formHtml() {
    if (!ensureForm(state.page.task)) {
      const disabled = state.page.task === "to-duskevm" && !cfg.duskEvm.enabled;
      return `<main class="col" id="main" tabindex="-1"><h1>${disabled ? `${html(names["dusk-evm"])} isn't on ${html(names.badge)} yet` : "That task isn't here"}</h1><p class="lede">${disabled ? "Moving DUSK to DuskEVM opens here once it is live." : "This bridge doesn't offer it on this network."}</p><p class="links-row"><a class="lnk" href="#/">All tasks</a></p></main>`;
    }
    return formPage(formVm());
  }

  /**
   * Brings the form up to date without touching its inputs: every region the
   * view declares (balance, Available and Max, quote, privacy, hint), the
   * amount's error and the button.
   */
  function refreshForm() {
    if (state.page.page !== "move" || !state.form) return;
    const main = slot("main");
    const vm = formVm();
    for (const [name, markup] of Object.entries(formRegions(vm))) {
      const region = main.querySelector(`[data-region="${name}"]`);
      if (region && region.innerHTML !== markup) region.innerHTML = markup;
    }
    const error = main.querySelector("#amount-error");
    if (error) error.textContent = vm.amountError ?? "";
    const amount = main.querySelector("#amount");
    if (amount) {
      if (vm.amountError) amount.setAttribute("aria-invalid", "true");
      else amount.removeAttribute("aria-invalid");
      amount.closest(".bigamt")?.classList.toggle("invalid", Boolean(vm.amountError));
    }
    const recipientError = main.querySelector("#recipient-error");
    if (recipientError) recipientError.textContent = vm.to.error ?? "";
    const recipient = main.querySelector("#recipient");
    if (recipient) {
      if (vm.to.error) recipient.setAttribute("aria-invalid", "true");
      else recipient.removeAttribute("aria-invalid");
    }
    const button = main.querySelector('[data-action="review"]');
    if (button) {
      button.disabled = !vm.canReview;
      button.textContent = vm.reviewLabel;
    }
  }

  /** Balances and prices for the form's route, from the node and the chains. */
  function loadReads() {
    const route = formRoute();
    if (!route) return undefined;
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
    if (state.page.page === "move") {
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
        if (route) announce(`${transferView(entry, { cfg, route }).title}.`);
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
  const scheduler = createScheduler({ check: checkEntry });

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

  function transfersHtml() {
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
    else if (discovery.errors.length) syncText = "Some of the networks didn't answer just now. Showing what this device knows; it tries again on your next visit.";
    else if (discovery.at) syncText = "Read from the networks just now.";
    const groups = vm.groups;
    const empty = vm.count
      ? ""
      : who.length
        ? discovery.running
          ? "Looking for transfers…"
          : "No bridge transfers found for these accounts yet."
        : "Connect a wallet, or follow a Dusk account below, to see its transfers. Transfers you send or look up on this device show here too.";
    return transfersPage({
      canAct: duskState().installed,
      empty,
      emptyActions: who.length ? "" : `<div class="btn-row">${duskState().installed ? '<button type="button" class="btn sec sm" data-action="connect-dusk">Connect Dusk Wallet</button>' : ""}<button type="button" class="btn sec sm" data-action="connect-evm">Connect EVM wallet</button></div>`,
      groups,
      lede: who.length
        ? `${who.join(" and ")}. Read from the networks, so the list is the same on any device. Transfers you followed here show too.`
        : "Transfers you send or look up on this device.",
      more: more && !discovery.running,
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
      ...receiptModel(entry, { cfg, gasPrice: duskGasPrice(), own: { account: duskAccount(), name: duskName() }, route, submitter: proofSubmitterFor(duskAccount()), url: receiptUrl(entry.hash) }),
      canAct: duskState().installed,
    });
  }

  // -------------------------------------------------------------------------
  // Sheets
  // -------------------------------------------------------------------------

  function openSheet(kind, opener) {
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
      dialog.innerHTML = contractsSheet({ badge: names.badge, groups: contractGroups(cfg), servers: serversLine(cfg) });
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
    }
  }

  // -------------------------------------------------------------------------
  // Review and send
  // -------------------------------------------------------------------------

  const explorerFor = { explorer: (network, address) => explorerAddressUrl(cfg, network, address) };

  // A review is for the account it was opened with. When the wallet switches,
  // confirming would sign as another, so the review says so and can't be confirmed.
  const signerNow = (wallet) => (wallet === "evm" ? evmAccount() : duskAccount());
  const SIGNER_MOVED = {
    dusk: "Dusk Wallet switched to another account since this review opened. Close it and review again.",
    evm: "Your EVM wallet switched to another account since this review opened. Close it and review again.",
  };
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
      confirmLabel: review.busy ? `Waiting for ${walletName}…` : step?.confirmLabel ?? "Confirm",
      error: review.error,
      feeRows: review.feeRows,
      late: review.late,
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
      await (route.signer === "dusk" ? connectDusk() : connectEvm());
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
      late: lateLine(route, cfg),
      // DUSK paid to another Dusk account than the connected one: said before the steps.
      notYours:
        route.to.kind === "dusk" && duskAccount() && destination !== duskAccount()
          ? `This pays ${typedRecipient(route)?.name ?? short(destination)}${typedRecipient(route)?.name ? ` (${short(destination)})` : ""}, not ${duskName() ? `your ${duskName()}` : "your connected Dusk account"}.`
          : "",
      privacy: `${privacyLine(route, cfg, {
        dusk: route.to.kind === "dusk" ? destination : duskAccount(),
        evm: route.to.kind === "dusk" ? evmAccount() : destination,
        name: duskPartyName(route.to.kind === "dusk" ? destination : duskAccount(), typedRecipient(route)),
      })} Seeing them doesn't let anyone move your DUSK.`,
      receive: {
        amount: formatLux(quote.receiveLux ?? lux),
        chain: route.to.id,
        unit: "DUSK",
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
        unit: route.mode === "migration" ? "old DUSK" : "DUSK",
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
          confirmLabel: `Approve ${amountText} old DUSK in ${walletName === "your EVM wallet" ? "your wallet" : walletName}`,
          custody: "Nothing moves yet. The old DUSK stays in your wallet.",
          lines: approveLines({ amountLux: lux, cfg, fee: fee(migration.gas?.approve), network }),
          title: `Approve exactly ${amountText} old DUSK`,
          walletName,
          what: `Lets the Dusk migration contract take <b>exactly ${html(amountText)} old DUSK</b> from <code class="mono">${html(short(evmAccount()))}</code>.`,
          when: "Now",
        });
      steps.push({
        confirmLabel: `Migrate ${amountText} DUSK`,
        custody: "The migration contract keeps the old DUSK locked: it has no function to send them out.",
        lines: migrateLines({ amountLux: lux, cfg, duskAccount: destination, fee: fee(migration.gas?.migrate), network }),
        title: "Migrate",
        walletName,
        what: `Moves the ${html(amountText)} old DUSK into the contract. The bridge then pays <b>${html(amountText)} DUSK</b> to Dusk account <code class="mono">${html(short(destination))}</code> from its own Dusk account.`,
        when: needsApproval ? "After step 1" : "Now",
      });
      reviews.start({
        ...base,
        after: needsApproval ? "Step 2 opens when the approval is confirmed." : "",
        current: 0,
        steps,
        sub: `Old DUSK on ${from} to Dusk · ${walletName === "your EVM wallet" ? "your wallet" : walletName} asks you ${steps.length === 2 ? "twice" : "once"}`,
      });
      openSheet("review", opener);
      return;
    }
    if (route.mode === "duskevm-withdrawal") {
      const l2 = formReads.reads.l2 ?? {};
      reviews.start({
        ...base,
        after: "Then prove and claim on Dusk with Dusk Wallet: My transfers says when.",
        current: 0,
        steps: [
          {
            confirmLabel: `Send ${amountText} DUSK in ${walletName === "your EVM wallet" ? "your wallet" : walletName}`,
            custody: custodyFor(route, destination),
            lines: withdrawLines({ amountLux: lux, cfg, duskAccount: destination, fee: l2.gas && l2.gasPriceWei ? l2.gas * l2.gasPriceWei : null }),
            title: `Send on ${from}`,
            walletName,
            what: `Starts the withdrawal of <b>${html(amountText)} DUSK</b> to Dusk account <code class="mono">${html(short(destination))}</code>.`,
            when: "Now",
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
          custody: custodyFor(route, destination),
          lines: null,
          linesNote: "Preparing the request…",
          title: "Send from Dusk",
          walletName: "Dusk Wallet",
          what:
            route.mode === "duskevm-deposit"
              ? `Sends <b>${html(amountText)} DUSK</b> into the DuskEVM bridge, for <code class="mono">${html(short(destination))}</code> on ${html(to)}.`
              : `Sends <b>${html(amountText)} DUSK</b> to the bridge account, with your ${html(to)} address as the memo.`,
          when: "Now",
        },
      ],
      sub: `Dusk to ${to} · Dusk Wallet asks you once`,
    });
    openSheet("review", opener);
    await reviews.fill(
      review,
      async () => {
        const request =
          route.mode === "duskevm-deposit"
            ? await depositRequest({ amountLux: lux, node: services.node, recipient: destination })
            : await serviceTransferRequest({ amountLux: lux, destination, node: services.node });
        const lines =
          route.mode === "duskevm-deposit"
            ? await duskCallLines({ ...request, chainId: cfg.dusk.chainId, from: duskAccount(), fromName: duskName(), note: "The DuskEVM bridge contract on Dusk." })
            : duskTransferLines({ amountLux: request.amountLux, from: duskAccount(), fromName: duskName(), gas: request.gas, memo: request.memo, to: request.to });
        return { lines, request };
      },
      ({ lines, request }) => {
        review.request = request;
        review.steps[0] = { ...review.steps[0], lines };
        // The request carries the node's price now: the fee rows and the
        // balance check follow it, so Confirm waits if it no longer fits.
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
          }),
        );
      },
      (error) => {
        review.error = friendlyWalletError(error, "dusk");
      },
    );
    if (state.sheet === "review" && reviews.current === review) renderSheet();
  }

  function custodyFor(route, destination) {
    if (route.mode === "duskevm-withdrawal")
      return `Until it's claimed, the DUSK waits in the DuskEVM bridge contract on Dusk. A claim always pays ${short(destination)}.`;
    if (route.mode === "duskevm-deposit") return "The DuskEVM bridge contract on Dusk holds the DUSK while it is on DuskEVM.";
    return `The bridge account on Dusk keeps the DUSK you send, and pays out the amount minus its fee on ${networkName(cfg, route.to.id)}.`;
  }

  async function openActionReview(id, kind, opener) {
    const entry = state.activity.find((item) => item.id === id);
    const route = entry && routeOf(entry.routeId);
    if (!entry || !route || !services.withdrawals) return;
    const view = transferView(entry, { cfg, route });
    const label = kind === "prove" ? "Prove on Dusk" : "Claim on Dusk";
    // What this step costs at most: an estimate until the request is ready.
    const fees = routeDuskFees(route, { gasPrice: duskGasPrice(), withdrawalGas: entry.withdrawalGas ? BigInt(entry.withdrawalGas) : 0n });
    const lead = (maxLux) => actionLead(kind, entry, { account: duskAccount(), amountLux: view.amount, maxLux, name: duskName() });
    const review = reviews.start({
      amountLux: entry.amountLux,
      checks: [],
      current: 0,
      entryId: id,
      error: "",
      feeRows: [],
      kind,
      late: "",
      lead: lead((kind === "prove" ? fees.prove : fees.claim).maxLux),
      privacy: actionPrivacy(kind, privacyLine(route, cfg, { dusk: entry.destination, evm: entry.sender, name: duskPartyName(entry.destination) }), { account: duskAccount(), name: duskName() }),
      receive: { amount: view.amount === null ? "" : formatLux(view.amount), chain: "dusk", unit: "DUSK", where: `Dusk · ${short(entry.destination ?? "")}` },
      routeId: route.id,
      send: { amount: view.amount === null ? "" : formatLux(view.amount), chain: "dusk-evm", unit: "DUSK", where: `${names["dusk-evm"]} · ${short(entry.sender ?? "")}` },
      steps: [
        {
          confirmLabel: label,
          custody:
            kind === "prove"
              ? "Your proof starts the 7 days. Only the account that proves can claim with that proof."
              : `The claim releases the DUSK from the DuskEVM bridge contract to ${short(entry.destination ?? "the Dusk account in the withdrawal")}.`,
          lines: null,
          linesNote: "Preparing the request. This reads the withdrawal's proof from DuskEVM…",
          title: kind === "prove" ? "Prove the withdrawal" : "Claim the DUSK",
          walletName: "Dusk Wallet",
          what:
            kind === "prove"
              ? "Proves on Dusk that DuskEVM recorded this withdrawal. After about 7 days, you can claim it."
              : `Claims <b>${html(view.amountText)}</b> on Dusk. It arrives in <code class="mono">${html(short(entry.destination ?? ""))}</code>.`,
          when: "Now",
        },
      ],
      sub: `${names["dusk-evm"]} to Dusk · ${kind === "prove" ? "step 2 of 3" : "step 3 of 3"} · Dusk Wallet asks you once`,
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
        const prepared =
          kind === "prove"
            ? await services.withdrawals.prepareProve(entry.hash, { proofSubmitter: submitter })
            : await services.withdrawals.prepareFinalize(entry.hash, { proofSubmitter: submitter });
        const request = await services.portalRequest(prepared);
        // What the call carries, as Dusk Wallet reads it from the call.
        const details = prepared.withdrawal ? withdrawalDetails(prepared.withdrawal) : null;
        const lines = await duskCallLines({
          ...request,
          chainId: cfg.dusk.chainId,
          from: account,
          fromName: account === duskAccount() ? duskName() : "",
          note: "The DuskEVM withdrawal portal on Dusk.",
          withdrawal: details && { ...details, value: prepared.withdrawal.value },
        });
        return { account, lines, request };
      },
      ({ account, lines, request }) => {
        // Prepared for the account Dusk Wallet had then: only it can confirm,
        // and it's the one the proof or claim makes public.
        review.signer = { account, wallet: "dusk" };
        review.privacy = actionPrivacy(kind, privacyLine(route, cfg, { dusk: entry.destination, evm: entry.sender, name: duskPartyName(entry.destination) }), { account, name: duskName() });
        review.request = request;
        review.lead = lead(BigInt(request.gas.limit) * BigInt(request.gas.price));
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
      if (route.mode === "migration") {
        const network = cfg.evmNetworks[route.from.id];
        const step = review.steps[review.current];
        const amount = formatLux(review.amountLux).replace(/,/gu, "");
        if (step.title.startsWith("Approve")) {
          await approveMigration(network, amount);
          review.current += 1;
          review.after = "";
          review.busy = false;
          announce("Approval confirmed. Step 2 is ready.");
          // The allowance changed: read it again, with the migration's gas.
          await loadReads();
          renderSheet();
          return;
        }
        const hash = await submitMigration(network, amount, review.destination);
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
        const result = await submitDuskEvmWithdrawal({ amount: formatLux(review.amountLux).replace(/,/gu, ""), duskAccount: review.destination });
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
      const { hash } =
        route.mode === "duskevm-deposit"
          ? await submitDuskEvmDeposit({ account: review.signer?.account, request: review.request })
          : await submitServiceTransfer({ account: review.signer?.account, request: review.request });
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
        review.busy = false;
        // A reconnect came back as another account: the review is stale.
        if (error?.code === "DUSK_ACCOUNT_CHANGED") review.stale = true;
        review.error =
          error?.code === "DUSK_ACCOUNT_CHANGED"
            ? SIGNER_MOVED.dusk
            : friendlyWalletError(error, review.kind === "send" && route.signer === "evm" ? "evm" : "dusk");
        if (review.entryId) setActivity(updateActivity(review.entryId, { actionError: error?.message ?? String(error) }));
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

  async function connectDusk() {
    try {
      if (!state.dusk) return;
      await state.dusk.connect();
    } catch (error) {
      showError(friendlyWalletError(error, "dusk"));
    }
  }

  async function connectEvm() {
    try {
      state.evmState = await connectEvmWallet();
    } catch (error) {
      showError(friendlyWalletError(error, "evm"));
    }
  }

  function showError(message) {
    if (state.form && state.page.page === "move") {
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
    state.menuOpen = false;
    if (next.page === "move") {
      ensureForm(next.task);
      void loadReads();
    }
    if (next.page === "transfer") void openReceipt(next.hash);
    if (next.page === "transfers") void discover();
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
    const view = transferView(entry, { cfg, route });
    if (!view.countdown) return;
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

  async function copy(value, button) {
    try {
      await globalThis.navigator.clipboard.writeText(value);
      announce("Copied.");
      button?.classList.add("copied");
      setTimeout(() => button?.classList.remove("copied"), 1_200);
    } catch {
      announce("Copying isn't allowed here. Select the text instead.");
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  root.addEventListener("input", (event) => {
    const { name, value } = event.target;
    if (event.target.classList?.contains("wrap-input")) fitHeight(event.target);
    if (!state.form) return;
    if (name === "amount") {
      state.form.amount = value;
      state.form.error = "";
      refreshForm();
      loadGasSoon();
    } else if (name === "recipient") {
      // Pasted across lines or with spaces, it's still one address.
      state.form.recipientInput = value.replace(/\s+/gu, "");
      refreshForm();
      loadGasSoon();
      lookUpRecipientName();
    }
  });

  root.addEventListener("change", (event) => {
    if (event.target.name === "source" && state.form) {
      state.form.routeId = event.target.value;
      formReads.reset(["migration"]);
      renderMain();
      void loadReads();
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
    // A link chosen in the phone menu closes it, even to the page already open.
    if (state.menuOpen && event.target.closest(".menu a")) {
      state.menuOpen = false;
      setTimeout(renderChrome, 0);
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
      if (event.target === dialog && !reviews.current?.busy) closeSheet();
      return;
    }
    const actions = {
      calendar: downloadCalendar,
      "close-sheet": closeSheet,
      confirm: confirmReview,
      "connect-dusk": connectDusk,
      "connect-evm": connectEvm,
      "discover-more": () => discover({ more: true }),
      max: () => {
        const route = formRoute();
        const quote = quoteFor(route);
        if (quote.maxLux === null || quote.maxLux === undefined) return;
        state.form.amount = formatLux(quote.maxLux).replace(/,/gu, "");
        const input = root.querySelector("#amount");
        if (input) input.value = state.form.amount;
        refreshForm();
        loadGasSoon();
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
      "toggle-menu": () => {
        state.menuOpen = !state.menuOpen;
        renderChrome();
        root.querySelector('[data-action="toggle-menu"]')?.focus();
      },
      "withdrawal-finalize": () => openActionReview(target.dataset.id, "finalize", target),
      "withdrawal-prove": () => openActionReview(target.dataset.id, "prove", target),
    };
    if (actions[action]) {
      event.preventDefault();
      if (state.menuOpen && action !== "toggle-menu" && target.closest(".menu")) {
        state.menuOpen = false;
        renderChrome();
      }
      void actions[action]();
    }
  });

  // Escape closes a sheet; the dialog's own cancel is routed the same way.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSheet();
  });

  globalThis.addEventListener?.("hashchange", navigate);

  return {
    async start() {
      if (state.page.page === "move") ensureForm(state.page.task);
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
          if (state.page.page === "move") void loadReads();
        }
        renderChrome();
        if (changed || state.page.page !== "move") renderMain();
      });
      subscribeEvmWallet((next) => {
        const changed = next.account !== state.evmState.account || next.chainId !== state.evmState.chainId;
        const accountChanged = next.account !== state.evmState.account;
        state.evmState = next;
        if (accountChanged) {
          if (signerMoved(reviews.current) && state.sheet === "review") renderSheet();
          formReads.reset(["migration", "l2"]);
          discoveryRuns.expire();
          void discover();
        }
        renderChrome();
        if (changed) {
          if (state.page.page === "move") {
            renderMain();
            void loadReads();
          } else renderMain();
        }
      });
      const refreshDusk = () => {
        if (globalThis.document?.visibilityState === "hidden") return;
        void dusk?.wallet.refresh().catch(() => {});
      };
      globalThis.addEventListener?.("focus", refreshDusk);
      globalThis.document?.addEventListener("visibilitychange", refreshDusk);
      if (state.page.page === "move") void loadReads();
      // The gas price every "up to" fee is figured at, on any page.
      else void formReads.price().then((moved) => moved && state.page.page !== "move" && renderMain());
      void discover();
      render();
    },
  };
}
