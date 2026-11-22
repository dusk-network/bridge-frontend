import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAppController } from "./app-controller.js";
import { buildRoutes } from "./bridge-routes.js";
import { loadConfig } from "./config.js";
import { useDuskWallet } from "./dusk-wallet.js";
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

/** Dusk Wallet, connected to `account` where one is given, that refuses to connect and doesn't let go when asked. */
function duskWallet(account) {
  return {
    connect: async () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
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

/** The page at `hash`, its transfers kept in this browser, Dusk Wallet connected to `account`; its timers stand still unless the test moves them. */
async function openPage(t, hash, activity, { account = ACCOUNT } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const items = new Map([[`dusk-bridge:activity:v2:${cfg.profile}`, JSON.stringify(activity)]]);
  globalThis.localStorage = { getItem: (key) => items.get(key) ?? null, removeItem: (key) => items.delete(key), setItem: (key, value) => items.set(key, String(value)) };
  globalThis.location = { hash, origin: "https://bridge.example", pathname: "/" };
  globalThis.document = { activeElement: null, addEventListener() {}, hasFocus: () => true, visibilityState: "visible" };
  t.after(() => {
    delete globalThis.localStorage;
    delete globalThis.location;
    delete globalThis.document;
  });
  useDuskWallet(duskWallet(account));
  const page = pageRoot();
  await createAppController(page.root, { cfg, routes, services }).start();
  return page;
}

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
