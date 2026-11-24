import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { networks } from "@dusk-network/networks";

// The page as testnet's site runs it, with its settings from deployments.json:
// set before the page's own modules load, as they read them then.
globalThis.__DUSK_BRIDGE_CONFIG__ = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"))["https://bridge.testnet.dusk.network/"];
const { createAppController } = await import("./app-controller.js");
const { buildRoutes } = await import("./bridge-routes.js");
const { loadConfig } = await import("./config.js");
const { useDuskWallet } = await import("./dusk-wallet.js");
const { duskRecipientHash } = await import("./hyperlane.js");
const { partsOf, textOf } = await import("./pages.fixtures.js");
const { duskEvmFeeMax } = await import("./quote.js");
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
async function openPage(t, hash, activity, { account = ACCOUNT, clock = false, network = services, wallet = duskWallet(account) } = {}) {
  t.mock.timers.enable({ apis: clock ? ["setTimeout", "setInterval", "Date"] : ["setTimeout", "setInterval"] });
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

test("a withdrawal is reviewed only once its fee is worked out for its call, and the wallet is asked for that fee's gas limit and price caps", async (t) => {
  // An EVM wallet on DuskEVM testnet, which keeps what it's asked to send.
  const sent = [];
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    request: async ({ method, params }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [EVM];
      if (method === "eth_chainId") return "0x2e9";
      if (method === "eth_sendTransaction") {
        sent.push(params[0]);
        return `0x${"ab".repeat(32)}`;
      }
      return null;
    },
  };
  t.after(() => delete globalThis.ethereum);
  // DuskEVM as testnet's RPC reads it: the call's own estimate where there's a call, else what a withdrawal usually needs.
  const evmReads = {
    withdrawalState: async (_owner, { amountWei, duskAccount } = {}) => {
      const estimated = Boolean(amountWei && duskAccount);
      return {
        balanceWei: 312n * 10n ** 18n,
        baseFeeWei: 10_000_000_000n,
        estimated,
        gas: estimated ? 138_439n : 140_000n,
        gasLimit: estimated ? 166_127n : 168_000n,
        gasPriceWei: 10_001_000_000n,
        l1FeeMaxWei: 379n,
        operatorFeeWei: estimated ? 24_071_158_578_548_300n : 24_320_000_007_200_000n,
        tipWei: 1_000_000n,
      };
    },
  };
  const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads } });
  const type = async (value) => {
    for (const listener of root.listeners.input) listener({ target: { classList: { contains: () => false }, name: "amount", value } });
    await settle();
  };
  // Typed, and Review pressed before the call is estimated: nothing to review yet.
  await type("1");
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, false);
  // Estimated for it: the review opens, and Confirm asks the wallet for what the fee was quoted at.
  t.mock.timers.tick(500);
  await settle();
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, true);
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  await settle();
  assert.deepEqual(
    sent.map(({ gas, maxFeePerGas, maxPriorityFeePerGas, value }) => ({ gas, maxFeePerGas, maxPriorityFeePerGas, value })),
    [{ gas: "0x288ef", maxFeePerGas: "0x4a8270a40", maxPriorityFeePerGas: "0xf4240", value: "0xde0b6b3a7640000" }],
  );
});

test("a withdrawal whose fee couldn't be worked out for its call isn't reviewed, and offers to try again", async (t) => {
  globalThis.ethereum = {
    on() {},
    removeListener() {},
    request: async ({ method }) => (method === "eth_accounts" ? [EVM] : method === "eth_chainId" ? "0x2e9" : null),
  };
  t.after(() => delete globalThis.ethereum);
  // DuskEVM's RPC refusing the call's estimate, not answering at all, or answering all but a part of
  // its fee (the oracle's getOperatorFee came back with an error), until it's tried again.
  for (const fails of ["estimate", "read", "part"]) {
    let failing = true;
    const evmReads = {
      withdrawalState: async () => {
        if (failing && fails === "read") throw new Error("fetch failed");
        const estimated = !failing || fails === "part";
        return {
          balanceWei: 312n * 10n ** 18n,
          baseFeeWei: 10_000_000_000n,
          estimated,
          gas: estimated ? 138_439n : 140_000n,
          gasLimit: estimated ? 166_127n : 168_000n,
          gasPriceWei: 10_001_000_000n,
          l1FeeMaxWei: 379n,
          operatorFeeWei: failing && fails === "part" ? null : estimated ? 24_071_158_578_548_300n : 24_320_000_007_200_000n,
          tipWei: 1_000_000n,
        };
      },
    };
    const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads } });
    for (const listener of root.listeners.input) listener({ target: { classList: { contains: () => false }, name: "amount", value: "1" } });
    await settle();
    t.mock.timers.tick(500);
    await settle();
    await root.press({ action: "review" });
    assert.equal(slots.sheet.open, false, fails);
    assert.match(slots.main.innerHTML, /data-action="read-again"/u, fails);
    // Tried again, and worked out this time: reviewed.
    failing = false;
    await root.press({ action: "read-again" });
    await root.press({ action: "review" });
    assert.equal(slots.sheet.open, true, fails);
    t.mock.timers.reset();
  }
});

/**
 * An EVM wallet on DuskEVM testnet at `account`, which keeps what it's asked
 * to send; `switchTo` moves it to another account, and `hold` keeps a method
 * waiting until `release`.
 */
function evmWallet(t, account = EVM, { chainId = "0x2e9" } = {}) {
  const sent = [];
  const told = {};
  const held = [];
  let holding = "";
  let now = account;
  globalThis.ethereum = {
    on: (event, listener) => {
      told[event] = listener;
    },
    removeListener() {},
    request: async ({ method, params }) => {
      if (method === holding) await new Promise((resolve) => held.push(resolve));
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [now];
      if (method === "eth_chainId") return chainId;
      if (method === "eth_sendTransaction") {
        sent.push(params[0]);
        return `0x${"ab".repeat(32)}`;
      }
      return null;
    },
  };
  t.after(() => delete globalThis.ethereum);
  return {
    hold: (method) => {
      holding = method;
    },
    release: () => {
      holding = "";
      for (const go of held.splice(0)) go();
    },
    sent,
    switchTo: (next) => {
      now = next;
      told.accountsChanged?.([next]);
    },
  };
}

/**
 * Dusk Wallet at `account`, which keeps what it's asked to send; `switchTo`
 * moves it to another profile, and `hold` keeps its session check, as a send
 * starts, waiting until `release`.
 */
function duskSender(account) {
  const sent = [];
  const held = [];
  let holding = false;
  let listener = () => {};
  const send = async (request) => {
    sent.push(request);
    return { hash: "cd".repeat(32) };
  };
  const wallet = {
    ...duskWallet(account),
    refresh: async () => {
      if (holding) await new Promise((resolve) => held.push(resolve));
    },
    sendContractCall: send,
    sendTransfer: send,
    subscribe: (each) => ((listener = each), () => {}),
  };
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const go of held.splice(0)) go();
    },
    sent,
    switchTo: (next) => {
      wallet.state = { ...wallet.state, selectedProfile: next ? { account: next } : null };
      listener(wallet.state);
    },
    wallet,
  };
}

/**
 * DuskEVM as testnet's RPC reads a withdrawal for 312 DUSK: its call's own
 * estimate where there's a call (`exact`), else the gas one usually needs.
 */
const withdrawalReads = ({ exact = { gas: 138_439n, gasLimit: 166_127n, operatorFeeWei: 24_071_158_578_548_300n } } = {}) => ({
  withdrawalState: async (_owner, { amountWei, duskAccount } = {}) => ({
    balanceWei: 312n * 10n ** 18n,
    baseFeeWei: 10_000_000_000n,
    estimated: Boolean(amountWei && duskAccount),
    gasPriceWei: 10_001_000_000n,
    l1FeeMaxWei: 379n,
    tipWei: 1_000_000n,
    ...(amountWei && duskAccount ? exact : { gas: 140_000n, gasLimit: 168_000n, operatorFeeWei: 24_320_000_007_200_000n }),
  }),
});

/** Until the open review's request is built, where that's after it opens: Confirm takes no press before. */
async function prepared(slots) {
  for (let turn = 0; turn < 20 && /data-action="confirm" disabled/u.test(slots.sheet.innerHTML); turn += 1) await settle();
}

/** Typed into the card's amount, as its input event comes. */
async function typeAmount(root, value) {
  for (const listener of root.listeners.input) listener({ target: { classList: { contains: () => false }, name: "amount", value } });
  await settle();
}

test("a review closes once a wallet switch changes what it would send, and nothing is sent: the Dusk account it pays, or the EVM account that signs it", async (t) => {
  for (const switched of ["dusk", "evm"]) {
    const evm = evmWallet(t);
    let listener;
    const wallet = { ...duskWallet(ACCOUNT), subscribe: (each) => ((listener = each), () => {}) };
    const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads: withdrawalReads() }, wallet });
    await typeAmount(root, "1");
    t.mock.timers.tick(500);
    await settle();
    // Reviewed paying the connected Dusk account, from the connected EVM account.
    await root.press({ action: "review" });
    assert.equal(slots.sheet.open, true, switched);
    // Dusk Wallet on another profile, which it would pay now, or the EVM wallet on another account, which would sign it.
    if (switched === "dusk") {
      wallet.state = { ...wallet.state, selectedProfile: { account: OTHER } };
      listener(wallet.state);
    } else evm.switchTo("0x00000000000000000000000000000000000000e1");
    await settle();
    assert.equal(slots.sheet.open, false, switched);
    t.mock.timers.tick(600);
    await root.press({ action: "confirm" });
    await settle();
    assert.deepEqual(evm.sent, [], switched);
    t.mock.timers.reset();
  }
});

test("an amount Max filled in is worked out again once its call's estimate changes the fee, keeping that whole fee aside", async (t) => {
  const evm = evmWallet(t);
  // Max at the gas a withdrawal usually needs, a limit of 168,000; its call's own estimate asks 170,000.
  const exact = { gas: 141_667n, gasLimit: 170_000n, operatorFeeWei: 24_585_714_293_000_000n };
  const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads: withdrawalReads({ exact }) } });
  await settle();
  await root.press({ action: "max" });
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(500);
  await settle();
  // Not more than there is: reviewed, and what's sent leaves the whole fee at that limit.
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, true);
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  await settle();
  const fee = duskEvmFeeMax({ baseFeeWei: 10_000_000_000n, l1FeeMaxWei: 379n, limit: exact.gasLimit, operatorFeeWei: exact.operatorFeeWei, tipWei: 1_000_000n });
  const most = ((312n * 10n ** 18n - fee) / 10n ** 9n) * 10n ** 9n;
  assert.deepEqual(
    evm.sent.map(({ gas, value }) => [gas, value]),
    [[`0x${exact.gasLimit.toString(16)}`, `0x${most.toString(16)}`]],
  );
});

test("a confirmed send that waits on a wallet stops before the wallet is asked once a switch changes what it would send, and nothing goes", async (t) => {
  // A withdrawal paying the connected Dusk profile: its EVM wallet still checking its chain as Dusk Wallet switches.
  {
    const evm = evmWallet(t);
    const dusk = duskSender(ACCOUNT);
    const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads: withdrawalReads() }, wallet: dusk.wallet });
    await typeAmount(root, "1");
    t.mock.timers.tick(500);
    await settle();
    await root.press({ action: "review" });
    t.mock.timers.tick(600);
    evm.hold("wallet_switchEthereumChain");
    await root.press({ action: "confirm" });
    dusk.switchTo(OTHER);
    await settle();
    evm.release();
    await settle();
    assert.deepEqual(evm.sent, []);
    assert.equal(slots.sheet.open, false);
    t.mock.timers.reset();
  }
  // A deposit paying the connected EVM account: Dusk Wallet still checking its session as the EVM wallet switches.
  {
    const evm = evmWallet(t);
    const dusk = duskSender(ACCOUNT);
    const { root, slots } = await openPage(t, "#/move/dusk-to-dusk-evm", [], { clock: true, wallet: dusk.wallet });
    await typeAmount(root, "1");
    t.mock.timers.tick(500);
    await settle();
    await root.press({ action: "review" });
    assert.equal(slots.sheet.open, true);
    await prepared(slots);
    t.mock.timers.tick(600);
    dusk.hold();
    await root.press({ action: "confirm" });
    evm.switchTo("0x00000000000000000000000000000000000000e1");
    await settle();
    dusk.release();
    await settle();
    assert.deepEqual(dusk.sent, []);
    assert.equal(slots.sheet.open, false);
  }
});

test("an amount Max filled in settles as a withdrawal's base fee moves up and down from read to read, and fits the fee it's reviewed at", async (t) => {
  const evm = evmWallet(t);
  // Each read of the call a base fee apart from the last, up and down, at a limit above the one Max started from.
  const exact = { gas: 141_667n, gasLimit: 170_000n, operatorFeeWei: 24_585_714_293_000_000n };
  let reads = 0;
  const evmReads = {
    withdrawalState: async (_owner, { amountWei, duskAccount } = {}) => {
      const call = Boolean(amountWei && duskAccount);
      if (call) reads += 1;
      return {
        balanceWei: 312n * 10n ** 18n,
        baseFeeWei: call && reads % 2 === 1 ? 10_000_100_000n : 10_000_000_000n,
        estimated: call,
        gasPriceWei: 10_001_000_000n,
        l1FeeMaxWei: 379n,
        tipWei: 1_000_000n,
        ...(call ? exact : { gas: 140_000n, gasLimit: 168_000n, operatorFeeWei: 24_320_000_007_200_000n }),
      };
    },
  };
  const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads } });
  await settle();
  await root.press({ action: "max" });
  for (let round = 0; round < 6; round += 1) {
    t.mock.timers.tick(500);
    await settle();
  }
  // Settled within a few reads, and reviewable.
  assert.ok(reads <= 3, `${reads} reads`);
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, true);
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  await settle();
  // What's sent fits the chain's balance check at the caps it was reviewed at.
  const [tx] = evm.sent;
  const most = BigInt(tx.value) + BigInt(tx.gas) * BigInt(tx.maxFeePerGas) + exact.operatorFeeWei + 2n * 379n + 10n ** 9n;
  assert.ok(most <= 312n * 10n ** 18n, String(most));
});

test("a send goes ahead when Dusk Wallet's session drops and comes back on the same profile, and not on another", async (t) => {
  for (const [back, sends] of [[ACCOUNT, 1], [OTHER, 0]]) {
    // A deposit from profile A, to the connected EVM account; as it's sent, the session reports no profile, then one.
    evmWallet(t);
    const dusk = duskSender(ACCOUNT);
    const { root, slots } = await openPage(t, "#/move/dusk-to-dusk-evm", [], { clock: true, wallet: dusk.wallet });
    await typeAmount(root, "1");
    t.mock.timers.tick(500);
    await settle();
    await root.press({ action: "review" });
    await prepared(slots);
    t.mock.timers.tick(600);
    dusk.hold();
    await root.press({ action: "confirm" });
    dusk.switchTo(null);
    await settle();
    dusk.switchTo(back);
    await settle();
    dusk.release();
    await settle();
    assert.equal(dusk.sent.length, sends, back);
    assert.equal(slots.sheet.open, false, back);
    t.mock.timers.reset();
  }
});

test("a typed .dusk name whose lookup fails while a withdrawal is confirmed stops it, saying the lookup failed", async (t) => {
  const evm = evmWallet(t);
  // alice.dusk points to OTHER; looked up again a minute on, that lookup fails, while the EVM wallet checks its chain.
  let fail = null;
  const names = {
    primaryName: async () => "",
    resolveName: () =>
      fail === null
        ? Promise.resolve({ account: OTHER, address: OTHER })
        : new Promise((_resolve, reject) => {
            fail = () => reject(new Error("offline"));
          }),
  };
  const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads: withdrawalReads(), names } });
  const recipient = async (value) => {
    for (const listener of root.listeners.input) listener({ target: { classList: { contains: () => false }, name: "recipient", value } });
    await settle();
  };
  await recipient("alice.dusk");
  t.mock.timers.tick(300);
  await settle();
  await typeAmount(root, "1");
  t.mock.timers.tick(61_000);
  await settle();
  fail = () => {};
  await recipient("alice.dusk");
  t.mock.timers.tick(500);
  await settle();
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, true);
  assert.match(slots.sheet.innerHTML, new RegExp(OTHER, "u"));
  t.mock.timers.tick(600);
  evm.hold("wallet_switchEthereumChain");
  await root.press({ action: "confirm" });
  fail();
  await settle();
  evm.release();
  await settle();
  assert.deepEqual(evm.sent, []);
  assert.equal(slots.sheet.open, false);
  assert.match(partsOf(slots.main.innerHTML, "message").map(textOf).join(" "), /\bCouldn't look up alice\.dusk\b/u);
});

test("Max worked out on one EVM account is worked out afresh for another, with its own balance", async (t) => {
  const evm = evmWallet(t);
  // 1 DUSK on the account Max was pressed on, 312 DUSK on the one switched to.
  const reads = withdrawalReads();
  const OTHER_EVM = "0x00000000000000000000000000000000000000e1";
  const evmReads = {
    withdrawalState: async (owner, gas) => ({ ...(await reads.withdrawalState(owner, gas)), balanceWei: owner.toLowerCase() === OTHER_EVM ? 312n * 10n ** 18n : 10n ** 18n }),
  };
  const { root, slots } = await openPage(t, "#/move/dusk-evm-to-dusk", [], { clock: true, network: { ...services, evmReads } });
  await settle();
  await root.press({ action: "max" });
  t.mock.timers.tick(500);
  await settle();
  evm.switchTo(OTHER_EVM);
  await settle();
  t.mock.timers.tick(500);
  await settle();
  await root.press({ action: "review" });
  assert.equal(slots.sheet.open, true);
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  await settle();
  // The most the account switched to can send, its whole fee kept aside.
  const fee = duskEvmFeeMax({ baseFeeWei: 10_000_000_000n, l1FeeMaxWei: 379n, limit: 166_127n, operatorFeeWei: 24_071_158_578_548_300n, tipWei: 1_000_000n });
  assert.deepEqual(
    evm.sent.map(({ value }) => value),
    [`0x${(((312n * 10n ** 18n - fee) / 10n ** 9n) * 10n ** 9n).toString(16)}`],
  );
});

test("an approval mined after its review closed leaves the card knowing it's approved: the review again asks for the migration alone", async (t) => {
  // Sepolia's RPC, as this page reads it: a call goes through, and the approval's receipt waits until the test lets it come.
  let mined = false;
  let receipt = () => {};
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    const answer = async ({ id, method, params }) => {
      if (method === "eth_getTransactionReceipt") {
        if (!mined) await new Promise((resolve) => (receipt = resolve));
        return { id, jsonrpc: "2.0", result: { blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", logs: [], status: "0x1", transactionHash: params[0], transactionIndex: "0x0" } };
      }
      const result = { eth_blockNumber: "0x10", eth_call: `0x${"1".padStart(64, "0")}`, eth_chainId: "0xaa36a7" }[method] ?? null;
      return { id, jsonrpc: "2.0", result };
    };
    const calls = JSON.parse(body);
    return Response.json(Array.isArray(calls) ? await Promise.all(calls.map(answer)) : await answer(calls));
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const evm = evmWallet(t, EVM, { chainId: "0xaa36a7" });
  const dusk = duskSender(ACCOUNT);
  // ERC20 DUSK on Sepolia, nothing approved until the approval is mined.
  const evmReads = {
    migrationGas: async () => ({ approve: 46_000n, migrate: 70_000n }),
    migrationState: async () => ({ allowanceWei: mined ? 10n ** 18n : 0n, balanceWei: 10n ** 21n, gasCoinWei: 10n ** 17n, gasPriceWei: 1_000_000_000n }),
  };
  const { root, slots } = await openPage(t, "#/move/ethereum-to-dusk", [], { clock: true, network: { ...services, evmReads }, wallet: dusk.wallet });
  await typeAmount(root, "1");
  t.mock.timers.tick(500);
  await settle();
  await root.press({ action: "review" });
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  // Sent, and waiting to be mined, as Dusk Wallet switches the profile it pays; the card reads again meanwhile.
  assert.equal(evm.sent.length, 1);
  dusk.switchTo(OTHER);
  await settle();
  mined = true;
  receipt();
  for (let turn = 0; turn < 5; turn += 1) {
    t.mock.timers.tick(4_000);
    await settle();
  }
  assert.equal(slots.sheet.open, false);
  // Reviewed again and confirmed: what goes to the wallet is the migration, not another approval.
  await root.press({ action: "review" });
  t.mock.timers.tick(600);
  await root.press({ action: "confirm" });
  await settle();
  assert.equal(evm.sent.length, 2);
  assert.notEqual(evm.sent[1].data.slice(0, 10), evm.sent[0].data.slice(0, 10));
});
