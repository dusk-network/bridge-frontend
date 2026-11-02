import assert from "node:assert/strict";
import test from "node:test";

import {
  DUSK_ACCOUNT_CHANGED,
  buildContractCallRequest,
  buildTransferRequest,
  createDuskConnection,
  isRecoverableDuskSessionError,
  sendDuskTransfer,
  useDuskWallet,
} from "./dusk-wallet.js";
import { notSent } from "./review-session.js";

test("native bridge value is attached as a contract deposit, with the call's gas", () => {
  const request = buildContractCallRequest({
    contractId: "11".repeat(32),
    depositLux: 42n,
    display: { label: "Bridge" },
    fnArgs: new Uint8Array([1, 255]),
    fnName: "depositETHToWithValue",
    gas: { limit: 5_000_000n, price: 1n },
  });
  assert.equal(request.deposit, "42");
  assert.equal(request.fnArgs, "0x01ff");
  assert.equal(request.contractId, `0x${"11".repeat(32)}`);
  assert.deepEqual(request.gas, { limit: "5000000", price: "1" });
  assert.equal("amount" in request, false);
  assert.equal("chainId" in request, false);
});

test("a transfer is public and carries its memo", () => {
  assert.deepEqual(buildTransferRequest({ amountLux: 5n, memo: "0xabc", to: "acct" }), {
    amount: "5",
    memo: "0xabc",
    privacy: "public",
    to: "acct",
  });
});

test("only a refused locked-session request is safe to retry", () => {
  assert.equal(isRecoverableDuskSessionError({ code: 4100 }), true);
  assert.equal(isRecoverableDuskSessionError({ code: 4900 }), false);
  assert.equal(isRecoverableDuskSessionError({ code: 4001 }), false);
  assert.equal(isRecoverableDuskSessionError(new Error("failed")), false);
});

test("a locked session's retry goes only to the account the request was made for", async () => {
  const wallet = (afterReconnect, authorized = true) => {
    const sent = [];
    let locked = authorized;
    const fake = {
      state: { authorized, chainId: "dusk:2", selectedProfile: authorized ? { account: "A" } : null },
      refresh: async () => {},
      switchChain: async () => {},
      connect: async () => {
        fake.state = { ...fake.state, authorized: true, selectedProfile: { account: afterReconnect } };
      },
      sendTransfer: async (request) => {
        sent.push(fake.state.selectedProfile.account);
        if (locked) {
          locked = false;
          throw Object.assign(new Error("locked"), { code: 4100 });
        }
        return { hash: "h" };
      },
    };
    useDuskWallet(fake);
    return sent;
  };
  const request = { amountLux: 1n, memo: "m", to: "B" };
  const same = wallet("A");
  assert.deepEqual(await sendDuskTransfer(request), { hash: "h" });
  assert.deepEqual(same, ["A", "A"]);
  // The reconnect came back as another profile: nothing is sent as it.
  const switched = wallet("B");
  await assert.rejects(sendDuskTransfer(request), { code: "DUSK_ACCOUNT_CHANGED", message: DUSK_ACCOUNT_CHANGED });
  assert.deepEqual(switched, ["A"]);
  // Reviewed for A, but the wallet had lapsed and connects as B: not sent.
  const lapsed = wallet("B", false);
  await assert.rejects(sendDuskTransfer(request, { account: "A" }), { code: "DUSK_ACCOUNT_CHANGED" });
  assert.deepEqual(lapsed, []);
  const kept = wallet("A");
  assert.deepEqual(await sendDuskTransfer(request, { account: "A" }), { hash: "h" });
  assert.deepEqual(kept, ["A", "A"]);
});

// ---------------------------------------------------------------------------
// The page's Dusk Connect (the real package) with wallet extensions stood in
// for: each answers discovery on `window` and the requests the page makes.
// ---------------------------------------------------------------------------

const ALICE = "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr";
const BOB = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

/** A page load: a window the wallets announce themselves on, and storage that lasts across loads where given. */
function openPage({ storage = null } = {}) {
  globalThis.window = Object.assign(new EventTarget(), {
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  });
  if (storage) globalThis.localStorage = storage;
  else delete globalThis.localStorage;
  useDuskWallet(null);
}

function webStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, removeItem: (key) => items.delete(key), setItem: (key, value) => items.set(key, String(value)) };
}

/**
 * A wallet extension: `account` is its profile once the site is connected,
 * with `profileName` as its .dusk name. `during(method, wallet)` runs while a
 * request is answered; `stall` leaves its reads unanswered.
 */
function installWallet({ account = ALICE, during, name = "Dusk Wallet", profileName, rdns = "network.dusk.wallet", stall = false } = {}) {
  const listeners = new Map();
  const wallet = {
    authorized: false,
    emit: (event, payload) => (listeners.get(event) ?? []).forEach((fn) => fn(payload)),
    sent: [],
  };
  const profiles = () => (wallet.authorized ? [{ account, profileId: "profile:0", ...(profileName ? { name: profileName } : {}) }] : []);
  const provider = {
    chainId: "dusk:2",
    isDusk: true,
    get isAuthorized() {
      return wallet.authorized;
    },
    off: (event, fn) => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== fn)),
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    async request({ method, params }) {
      if (stall && ["dusk_chainId", "dusk_getCapabilities", "dusk_profiles"].includes(method)) return new Promise(() => {});
      await during?.(method, wallet);
      if (method === "dusk_getCapabilities") return { chainId: "dusk:2", methods: [], nodeUrl: "https://testnet.nodes.dusk.network", provider: rdns };
      if (method === "dusk_chainId") return "dusk:2";
      if (method === "dusk_profiles") return profiles();
      if (method === "dusk_requestProfiles") {
        wallet.authorized = true;
        return profiles();
      }
      if (method === "dusk_switchNetwork") return null;
      if (method === "dusk_sendTransaction") {
        wallet.sent.push(params);
        return { hash: "ab".repeat(32) };
      }
      throw Object.assign(new Error(`Unsupported: ${method}`), { code: 4200 });
    },
  };
  const info = { icon: "", name, rdns, uuid: `${rdns}:${Math.random()}` };
  window.addEventListener("dusk:requestProvider", () => window.dispatchEvent(new CustomEvent("dusk:announceProvider", { detail: { info, provider } })));
  return wallet;
}

test("with two Dusk wallets installed, Connect asks which one, and the page keeps to it on the next visit", async () => {
  const storage = webStorage();
  openPage({ storage });
  installWallet();
  const pie = installWallet({ account: BOB, name: "Piewallet", rdns: "com.piewallet" });
  const dusk = await createDuskConnection();
  // Neither is taken on the page's behalf: both are offered, by name.
  assert.deepEqual(dusk.choices.map(({ name, rdns }) => [name, rdns]), [["Dusk Wallet", "network.dusk.wallet"], ["Piewallet", "com.piewallet"]]);
  assert.equal(dusk.state.selectedProfile, null);
  await dusk.connect(dusk.choices.find((choice) => choice.name === "Piewallet").id);
  assert.equal(dusk.state.selectedProfile.account, BOB);
  assert.equal(pie.authorized, true);
  assert.deepEqual(dusk.choices, []);

  // The next visit, with both still installed: the one chosen, without asking.
  openPage({ storage });
  installWallet();
  installWallet({ account: BOB, name: "Piewallet", rdns: "com.piewallet" }).authorized = true;
  const again = await createDuskConnection();
  assert.deepEqual(again.choices, []);
  assert.equal(again.state.selectedProfile.account, BOB);
});

test("a wallet chosen before that's gone isn't swapped for the one installed now: Connect asks", async () => {
  const storage = webStorage();
  openPage({ storage });
  installWallet();
  installWallet({ account: BOB, name: "Piewallet", rdns: "com.piewallet" });
  const before = await createDuskConnection();
  await before.connect(before.choices.find((choice) => choice.name === "Piewallet").id);

  // Piewallet was removed; Dusk Wallet alone is left.
  openPage({ storage });
  const left = installWallet();
  const dusk = await createDuskConnection();
  assert.deepEqual(dusk.choices.map((choice) => choice.name), ["Dusk Wallet"]);
  assert.equal(dusk.state.selectedProfile, null);
  await dusk.connect(dusk.choices[0].id);
  assert.equal(dusk.state.selectedProfile.account, ALICE);
  assert.equal(left.authorized, true);
});

test("the .dusk name Dusk Wallet sends reaches the page whole, however long; anything else isn't taken as a name", async () => {
  const long = `${"a".repeat(63)}.${"b".repeat(63)}.dusk`;
  openPage();
  installWallet({ profileName: long });
  const dusk = await createDuskConnection();
  await dusk.connect();
  assert.equal(dusk.state.selectedProfile.name, long);
  for (const sent of ["Alice.dusk", "alice.dusk<b>", "alice"]) {
    openPage();
    installWallet({ profileName: sent });
    const other = await createDuskConnection();
    await other.connect();
    assert.equal(other.state.selectedProfile.account, ALICE);
    assert.equal(other.state.selectedProfile.name, undefined, sent);
  }
});

test("a wallet that locks while the page connects it to send sends nothing, and the review must be opened again", async () => {
  openPage();
  const wallet = installWallet({
    // Asked to connect, it locks before it answers: the site's session ended.
    during: (method, self) => method === "dusk_requestProfiles" && self.emit("disconnect", { code: 4900 }),
  });
  const dusk = await createDuskConnection();
  assert.equal(dusk.state.selectedProfile, null);
  const review = { busy: true };
  const said = [];
  await assert.rejects(sendDuskTransfer({ amountLux: 1n, memo: "m", to: BOB }, { account: ALICE }), (error) => {
    notSent(review, error, { announce: (text) => said.push(text) });
    return true;
  });
  assert.deepEqual(wallet.sent, []);
  assert.equal(review.stale, true);
  assert.deepEqual(said, ["Dusk Wallet locked or changed accounts, so nothing was sent. Close it and review again."]);
});

test("a wallet slow to answer as the page opens shows as installed, not missing", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  openPage();
  installWallet({ stall: true });
  const opening = createDuskConnection();
  // Dusk Connect gives up on a read after 10 seconds.
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  const dusk = await opening;
  assert.equal(dusk.state.installed, true);
  assert.deepEqual(dusk.choices, []);
});
