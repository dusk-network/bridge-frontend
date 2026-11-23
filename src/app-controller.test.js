import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAppController } from "./app-controller.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { useDuskWallet } from "./dusk-wallet.js";
import { duskRecipientHash } from "./hyperlane.js";
import { networks } from "@dusk-network/networks";
import { partsOf, textOf } from "./pages.fixtures.js";

// The page as testnet's site runs it, with its settings from deployments.json.
globalThis.__DUSK_BRIDGE_CONFIG__ = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"))["https://bridge.testnet.dusk.network/"];
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const routes = buildRoutes(cfg);

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const OTHER = "213qXNRaEAXrgJTFxXsPMeFasiEtPVJwZ3x2wKgZog2kXtXE7ovGRFfn1spfKBU4AUitAS91nM5T7HSvwRiyYCHLRaTTnJQbZn1TKnDySEiKZxX8vyodtWorbMuybDV5JJ9Y";
const EVM = "0x75685f9D88749B583732B40d56fe007cD404b72D";
const SENT_AT = Date.parse("2026-11-20T09:00:00Z");

// USDd held on Dusk for an account this page knows only by its hash: anyone can claim it for it.
const HELD = {
  amountLux: "32156353",
  delivered: true,
  deliveredAt: SENT_AT + 120_000,
  escrow: "held",
  hash: `0x${"34".repeat(32)}`,
  id: `sepolia-to-dusk-usdd:0x${"34".repeat(32)}`,
  recipientHash: duskRecipientHash(OTHER),
  routeId: "sepolia-to-dusk-usdd",
  sender: EVM,
  sentHere: true,
  sourceAt: SENT_AT,
  status: "pending",
};
// A withdrawal ready to prove, for the connected account.
const WITHDRAWAL = {
  amountLux: "1008000000000",
  destination: ACCOUNT,
  hash: `0x${"35".repeat(32)}`,
  id: `dusk-evm-to-dusk:0x${"35".repeat(32)}`,
  routeId: "dusk-evm-to-dusk",
  sender: EVM,
  sentHere: true,
  sourceAt: SENT_AT,
  stage: "ready_to_prove",
  status: "pending",
  withdrawalGas: "519542",
};

/** Lets what's under way finish: wallet and network answers, each a promise away. */
async function settle() {
  for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** What the controller draws into and listens on: the slots it looks up, the page's live region and sheet among them. */
function pageRoot() {
  const element = (extra = {}) => ({
    attributes: [],
    className: "",
    contains: () => false,
    dataset: {},
    innerHTML: "",
    listeners: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    removeAttribute() {},
    setAttribute() {},
    style: { removeProperty() {}, setProperty() {} },
    textContent: "",
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    },
    ...extra,
  });
  const slots = {
    footer: element(),
    header: element(),
    live: element(),
    main: element(),
    sheet: element({
      close() {
        this.open = false;
      },
      open: false,
      showModal() {
        this.open = true;
      },
    }),
    strip: element(),
  };
  const root = element({ querySelector: (selector) => slots[/data-slot="(\w+)"/u.exec(selector)?.[1]] ?? null });
  /** A press on the control `data` describes, as the page's click handler gets it. */
  root.press = async (data) => {
    const control = { dataset: data };
    const target = { closest: (selector) => (selector === "[data-action]" ? control : null), dataset: data };
    for (const listener of root.listeners.click) listener({ preventDefault() {}, target });
    await settle();
  };
  return { root, slots };
}

/** The wallet's answer when the request is cancelled there. */
const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

/** Dusk Wallet, connected to `account` where one is given, that refuses to connect and doesn't let go when asked. */
function duskWallet(account) {
  return {
    connect: async () => {
      throw rejected();
    },
    disconnect: async () => false,
    provider: { name: "Dusk Wallet" },
    providers: [{ name: "Dusk Wallet", rdns: "network.dusk.wallet", uuid: "dusk-wallet" }],
    ready: async () => {},
    refresh: async () => {},
    state: { authorized: Boolean(account), chainId: cfg.dusk.chainId, installed: true, selectedProfile: account ? { account } : null },
    subscribe: () => () => {},
    switchChain: async () => {},
  };
}

/** The networks, as far as these pages read them: nothing new, and a proof the Portal can't prepare yet. */
const services = {
  discovery: { discover: async () => ({ entries: [], errors: [], sources: {} }) },
  names: { primaryName: async () => "", resolveName: async () => ({ account: null }) },
  node: { gasPrice: async () => 1n, networkGas: async () => ({ busy: false, price: 1n }), transaction: async () => null },
  resolve: async () => null,
  status: async () => null,
  times: { get: () => null, refresh: async () => false },
  tracking: { migrationEvm: async () => null, refresh: async (entry) => ({ status: entry.status }) },
  withdrawals: {
    request: async () => {
      throw new Error("DuskEVM hasn't reported an output that covers this withdrawal yet.");
    },
  },
};

/**
 * The page at `hash`, its transfers kept in this browser, Dusk Wallet
 * connected to `account` (or `wallet`); its timers stand still unless the
 * test moves them. `go` follows a link to another page.
 */
async function openPage(t, hash, activity, { account = ACCOUNT, network = services, wallet = duskWallet(account) } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const items = new Map([[`dusk-bridge:activity:v2:${cfg.profile}`, JSON.stringify(activity)]]);
  const events = {};
  globalThis.localStorage = { getItem: (key) => items.get(key) ?? null, removeItem: (key) => items.delete(key), setItem: (key, value) => items.set(key, String(value)) };
  globalThis.location = { hash, origin: "https://bridge.example", pathname: "/" };
  globalThis.document = { activeElement: null, addEventListener() {}, hasFocus: () => true, visibilityState: "visible" };
  globalThis.addEventListener = (type, listener) => (events[type] ??= []).push(listener);
  t.after(() => {
    delete globalThis.localStorage;
    delete globalThis.location;
    delete globalThis.document;
    delete globalThis.addEventListener;
  });
  useDuskWallet(wallet);
  const page = pageRoot();
  await createAppController(page.root, { cfg, routes, services: network }).start();
  page.go = async (next) => {
    globalThis.location.hash = next;
    for (const listener of events.hashchange ?? []) listener();
    await settle();
  };
  return page;
}

/** A request the wallet answers when the test says: `refuse` cancels it there. */
function waiting() {
  const asked = [];
  const ask = () =>
    new Promise((resolve, reject) => {
      asked.push({ refuse: () => reject(rejected()), resolve });
    });
  return { ask, asked };
}

/** What the page's message says, as shown, and what the live region read out, once what's under way finished. */
async function said(t, slots) {
  await settle();
  const shown = partsOf(slots.main.innerHTML, "message").map(textOf);
  t.mock.timers.tick(100);
  await settle();
  return { heard: slots.live.textContent, shown };
}

test("away from the card, a disconnect Dusk Wallet refused shows on the page, in the words read out", async (t) => {
  const { root, slots } = await openPage(t, "#/transfers", [HELD]);
  assert.deepEqual(partsOf(slots.main.innerHTML, "message"), []);
  await root.press({ action: "dusk-disconnect" });
  const { heard, shown } = await said(t, slots);
  assert.deepEqual(shown, [heard]);
  assert.match(heard, /\bdidn't disconnect\b/u);
});

test("away from the card, a connect cancelled in the wallet shows on the page, as cancelled", async (t) => {
  // Activity without a wallet connected: its Connect Dusk Wallet.
  const { root, slots } = await openPage(t, "#/transfers", [], { account: null });
  await root.press({ action: "connect-dusk" });
  const { heard, shown } = await said(t, slots);
  assert.deepEqual(shown, [heard]);
  assert.match(heard, /\bcancelled\b/iu);
});

test("a claim for an account this page doesn't know says why on the page, in Activity and on the receipt", async (t) => {
  // The receipt by its hash, and by its hash without the 0x, as it can be pasted.
  for (const hash of ["#/transfers", `#/transfer/${HELD.hash}`, `#/transfer/${HELD.hash.slice(2)}`]) {
    const { root, slots } = await openPage(t, hash, [HELD]);
    // The quiet Claim for its account, as Activity's row and the receipt offer it.
    await root.press({ action: "escrow-claim", id: HELD.id });
    const { heard, shown } = await said(t, slots);
    assert.deepEqual(shown, [heard], hash);
    assert.match(heard, /\bisn't known\b/u, hash);
    // Nothing was asked of the wallet: no review opened.
    assert.equal(slots.sheet.open, false, hash);
    t.mock.timers.reset();
  }
});

test("a receipt opened by its hash without the 0x is drawn again as its transfer is checked", async (t) => {
  // Its next check finds it proved.
  let proved = false;
  const tracking = { ...services.tracking, refresh: async (entry) => (proved ? { stage: "proven_waiting", status: "pending" } : { status: entry.status }) };
  const { slots } = await openPage(t, `#/transfer/${WITHDRAWAL.hash.slice(2)}`, [WITHDRAWAL], { network: { ...services, tracking } });
  t.mock.timers.tick(1);
  await settle();
  const before = slots.main.innerHTML;
  proved = true;
  t.mock.timers.tick(15_000);
  await settle();
  assert.notEqual(slots.main.innerHTML, before);
});

test("a review whose request couldn't be prepared says why, and no longer that it's preparing; nothing can be confirmed", async (t) => {
  const { root, slots } = await openPage(t, "#/transfers", [WITHDRAWAL]);
  await root.press({ action: "withdrawal-prove", id: WITHDRAWAL.id });
  assert.equal(slots.sheet.open, true);
  const review = slots.sheet.innerHTML;
  const [why] = partsOf(review, "message").map(textOf);
  assert.match(why, /\boutput\b/u);
  assert.doesNotMatch(textOf(review), /\bPreparing\b/u);
  // Its Confirm stays off: there's no request to send.
  assert.match(review, /data-action="confirm" disabled/u);
  await settle();
});

test("a wallet's answer to a try made on another page says nothing on the page open now", async (t) => {
  for (const next of ["#/lookup", `#/transfer/${HELD.hash}`, "#/"]) {
    // Activity's Connect Dusk Wallet, cancelled in the wallet once another page is open.
    const connect = waiting();
    const { go, root, slots } = await openPage(t, "#/transfers", [HELD], { wallet: { ...duskWallet(null), connect: connect.ask } });
    await root.press({ action: "connect-dusk" });
    await go(next);
    connect.asked[0].refuse();
    const { heard, shown } = await said(t, slots);
    assert.deepEqual(shown, [], next);
    assert.doesNotMatch(heard, /\bcancelled\b/iu, next);
    t.mock.timers.reset();
  }
});

test("a try's answer says nothing once the page tried again", async (t) => {
  const connect = waiting();
  const { root, slots } = await openPage(t, "#/transfers", [], { wallet: { ...duskWallet(null), connect: connect.ask } });
  await root.press({ action: "connect-dusk" });
  await root.press({ action: "connect-dusk" });
  // The first try, cancelled while the second waits for the wallet.
  connect.asked[0].refuse();
  const { heard, shown } = await said(t, slots);
  assert.deepEqual(shown, []);
  assert.doesNotMatch(heard, /\bcancelled\b/iu);
  // The second's answer is the page's.
  connect.asked[1].refuse();
  const after = await said(t, slots);
  assert.deepEqual(after.shown, [after.heard]);
  assert.match(after.heard, /\bcancelled\b/iu);
});

test("why a claim for an unknown account didn't go stands while the transfer is held, and goes once it isn't", async (t) => {
  let claimed = false;
  const tracking = { ...services.tracking, refresh: async (entry) => (claimed ? { destinationAt: SENT_AT + 600_000, escrow: "claimed", status: "completed" } : { status: entry.status }) };
  const { root, slots } = await openPage(t, `#/transfer/${HELD.hash}`, [HELD], { network: { ...services, tracking } });
  await root.press({ action: "escrow-claim", id: HELD.id });
  assert.match((await said(t, slots)).shown.join(" "), /\bisn't known\b/u);
  // Checked again, still held: it stands.
  t.mock.timers.tick(15_000);
  await settle();
  assert.match(partsOf(slots.main.innerHTML, "message").map(textOf).join(" "), /\bisn't known\b/u);
  // Claimed by its account since: the receipt says so, and nothing more about claiming it.
  claimed = true;
  t.mock.timers.tick(15_000);
  await settle();
  assert.match(textOf(slots.main.innerHTML), /\bClaimed on Dusk\b/u);
  assert.deepEqual(partsOf(slots.main.innerHTML, "message"), []);
});

test("a refusal stays through the wallet's news when no account changed, and goes once one connected", async (t) => {
  let tell;
  const wallet = { ...duskWallet(null), subscribe: (listener) => ((tell = listener), () => {}) };
  const { root, slots } = await openPage(t, "#/transfers", [], { wallet });
  await root.press({ action: "connect-dusk" });
  assert.match((await said(t, slots)).shown.join(" "), /\bcancelled\b/iu);
  // Still no profile chosen, with or without one named.
  for (const news of [{ ...wallet.state }, { ...wallet.state, selectedProfile: undefined }]) {
    tell(news);
    await settle();
    assert.match(partsOf(slots.main.innerHTML, "message").map(textOf).join(" "), /\bcancelled\b/iu);
  }
  // Connected after all.
  tell({ ...wallet.state, authorized: true, selectedProfile: { account: ACCOUNT } });
  await settle();
  assert.deepEqual(partsOf(slots.main.innerHTML, "message"), []);
});

test("why a claim for an unknown account didn't go stays while that's so, through wallet switches, and goes once its account is known", async (t) => {
  // An EVM wallet in the page, which tells it when its account changes.
  const told = {};
  globalThis.ethereum = {
    on: (event, listener) => {
      told[event] = listener;
    },
    removeListener() {},
    request: async ({ method }) => (method === "eth_accounts" ? [EVM] : method === "eth_chainId" ? "0xaa36a7" : null),
  };
  t.after(() => delete globalThis.ethereum);
  let listener;
  const wallet = { ...duskWallet(ACCOUNT), subscribe: (each) => ((listener = each), () => {}) };
  // Dusk Wallet on another profile: its state, and its news of it.
  const switchTo = (account) => {
    wallet.state = { ...wallet.state, selectedProfile: { account } };
    listener(wallet.state);
  };
  const { root, slots } = await openPage(t, `#/transfer/${HELD.hash}`, [HELD], { wallet });
  const message = () => partsOf(slots.main.innerHTML, "message").map(textOf).join(" ");
  await root.press({ action: "escrow-claim", id: HELD.id });
  assert.match((await said(t, slots)).shown.join(" "), /\bisn't known\b/u);
  // The EVM wallet on another account: the transfer is held, its account unknown, as before.
  told.accountsChanged(["0x00000000000000000000000000000000000000e1"]);
  await settle();
  assert.match(message(), /\bisn't known\b/u);
  // Dusk Wallet on another account that isn't the one it pays: still unknown here.
  switchTo(networks.mainnet.routes.services[0].account);
  await settle();
  assert.match(message(), /\bisn't known\b/u);
  // On the account it pays: known now, and it can claim it, so the message goes.
  switchTo(OTHER);
  await settle();
  assert.equal(message(), "");
});

test("choosing another profile keeps why a claim didn't go while that's so, and drops it once the account it pays connects", async (t) => {
  let listener;
  let letGo;
  let next = networks.mainnet.routes.services[0].account;
  const wallet = { ...duskWallet(ACCOUNT), subscribe: (each) => ((listener = each), () => {}) };
  const switchTo = (account) => {
    wallet.state = { ...wallet.state, authorized: Boolean(account), selectedProfile: account ? { account } : null };
    listener(wallet.state);
  };
  // Dusk Wallet lets go when the test says, and connects the profile chosen next.
  wallet.disconnect = () =>
    new Promise((resolve) => {
      letGo = () => {
        switchTo(null);
        resolve(true);
      };
    });
  wallet.connect = async () => switchTo(next);
  const { root, slots } = await openPage(t, `#/transfer/${HELD.hash}`, [HELD], { wallet });
  const message = () => partsOf(slots.main.innerHTML, "message").map(textOf).join(" ");
  await root.press({ action: "escrow-claim", id: HELD.id });
  assert.match((await said(t, slots)).shown.join(" "), /\bisn't known\b/u);
  // Other profile: while Dusk Wallet lets go, and on an account that isn't the one it pays.
  await root.press({ action: "dusk-other-profile" });
  assert.match(message(), /\bisn't known\b/u);
  letGo();
  await settle();
  assert.match(message(), /\bisn't known\b/u);
  // Then on the account it pays: known now, so it goes.
  next = OTHER;
  await root.press({ action: "dusk-other-profile" });
  letGo();
  await settle();
  assert.equal(message(), "");
});

test("why a claim didn't go goes once its transfer isn't on the page: an EVM switch takes its row off Activity's list", async (t) => {
  const told = {};
  globalThis.ethereum = {
    on: (event, listener) => {
      told[event] = listener;
    },
    removeListener() {},
    request: async ({ method }) => (method === "eth_accounts" ? [EVM] : method === "eth_chainId" ? "0xaa36a7" : null),
  };
  t.after(() => delete globalThis.ethereum);
  // Held for an account this page doesn't know, sent from another device: listed by its EVM sender alone.
  const elsewhere = { ...HELD, parties: [EVM], sentHere: false };
  const { root, slots } = await openPage(t, "#/transfers", [elsewhere]);
  const message = () => partsOf(slots.main.innerHTML, "message").map(textOf).join(" ");
  await root.press({ action: "escrow-claim", id: elsewhere.id });
  assert.match((await said(t, slots)).shown.join(" "), /\bisn't known\b/u);
  assert.match(slots.main.innerHTML, new RegExp(elsewhere.hash, "u"));
  // The EVM wallet on an unrelated account: the row goes, and its message with it.
  told.accountsChanged(["0x00000000000000000000000000000000000000e1"]);
  await settle();
  assert.doesNotMatch(slots.main.innerHTML, new RegExp(elsewhere.hash, "u"));
  assert.equal(message(), "");
});
