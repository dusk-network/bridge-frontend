import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { getAddress } from "viem";

// Reown's AppKit, which the page loads once someone connects through it, stood
// in for: its `createAppKit` hands back `globalThis.reownAppKit`, with the
// options it keeps, all but enableBaseAccount as AppKit 1.8 does.
const standIn = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const standIns = {
  "@reown/appkit": standIn("export const createAppKit = ({ enableBaseAccount, ...options }) => Object.assign(globalThis.reownAppKit, { options });"),
  "@reown/appkit-adapter-wagmi": standIn("export class WagmiAdapter {}"),
};
register(standIn(`const standIns = ${JSON.stringify(standIns)};
export function resolve(specifier, context, next) {
  return Object.hasOwn(standIns, specifier) ? { shortCircuit: true, url: standIns[specifier] } : next(specifier, context);
}`));

// The testnet profile, with DuskEVM and Reown configured, before the modules read it.
globalThis.__DUSK_BRIDGE_CONFIG__ = {
  VITE_BRIDGE_PROFILE: "testnet",
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
  VITE_REOWN_PROJECT_ID: "stand-in",
};
const { config } = await import("./config.js");
const { networks } = await import("@dusk-network/networks");
const { sendDuskContractCall, sendDuskTransfer, useDuskWallet } = await import("./dusk-wallet.js");
const { serviceTransferRequest } = await import("./service-transfer.js");
const { decodeBridgeCall } = await import("@dusk-network/networks/duskevm");
const { depositRequest } = await import("./dusk-deposit.js");
const { submitDuskEvmWithdrawal } = await import("./duskevm-withdrawal.js");
const { connectEvmWallet, getEvmState, heldAccount, initializeEvmWallet } = await import("./evm-wallet.js");
const { approveMigration, submitMigration } = await import("./legacy-migration.js");

// What the review prepares and then sends, as the account it was reviewed for.
const submitServiceTransfer = async ({ account, ...options }) => sendDuskTransfer(await serviceTransferRequest(options), { account });
const submitDuskEvmDeposit = async ({ account, ...options }) => sendDuskContractCall(await depositRequest(options), { account });

/** A Dusk Connect wallet stand-in that records what the bridge sends. */
function fakeWallet() {
  const sent = [];
  return {
    async connect() {},
    async refresh() {},
    async sendContractCall(params) {
      sent.push({ kind: "contract_call", params });
      return { hash: "c".repeat(64) };
    },
    async sendTransfer(params) {
      sent.push({ kind: "transfer", params });
      return { hash: "d".repeat(64) };
    },
    sent,
    state: {
      authorized: true,
      chainId: "dusk:2",
      selectedProfile: { account: "21n5ncyu" },
    },
    async switchChain() {},
  };
}

const node = { gasPrice: async () => 1n };
// Typed in lower case; the wallet must get the same address, checksummed.
const TYPED = "0xf49ea944fd8a6bde7358a61ac1004fbaa9321aec";

test("a Dusk → Sepolia transfer memos the typed destination to the bridge account", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitServiceTransfer({
    amountLux: 2_000_000_000n,
    destination: `  ${TYPED} `,
  });

  assert.equal(wallet.sent.length, 1);
  const [{ kind, params }] = wallet.sent;
  assert.equal(kind, "transfer");
  assert.equal(params.memo, getAddress(TYPED));
  assert.equal(params.to, config.service.account);
  // The Sepolia bridge account, as the network's file names it.
  assert.equal(params.to, networks.testnet.routes.services[0].account);
  assert.equal(params.amount, "2000000000");
  assert.equal(params.privacy, "public");
});

test("a transfer at or under the bridge fee isn't sent", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await assert.rejects(
    submitServiceTransfer({ amountLux: 1_000_000_000n, destination: TYPED }),
    /must exceed the 1 DUSK bridge fee/u,
  );
  await assert.rejects(
    submitServiceTransfer({ amountLux: 2_000_000_000n, destination: "0x1234" }),
    /valid 20-byte EVM address/u,
  );
  assert.equal(wallet.sent.length, 0);
});

test("a DuskEVM deposit carries the typed recipient, its own gas and a label", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitDuskEvmDeposit({ amountLux: 100_000_000n, node, recipient: TYPED });

  const [{ kind, params }] = wallet.sent;
  assert.equal(kind, "contract_call");
  assert.equal(params.contractId, `0x${"11".repeat(32)}`);
  assert.equal(params.fnName, "depositETHToWithValue");
  assert.equal(params.deposit, "100000000");
  assert.equal(params.privacy, "public");
  // 5M gas at the node's price, not the wallet's 500M contract-call default.
  assert.deepEqual(params.gas, { limit: "5000000", price: "1" });
  // Read as a deposit to the deployment's bridge: it forwards DuskEVM's SDK
  // default, 200,000 gas, to its call there.
  const args = decodeBridgeCall(config.network, { args: params.fnArgs, contractId: params.contractId, fnName: params.fnName });
  assert.deepEqual([args.kind, args.recipient, args.amountLux, args.minGasLimit], ["deposit", getAddress(TYPED), 100_000_000n, 200_000]);
  assert.deepEqual(params.display, {
    label: "Bridge 0.1 DUSK to DuskEVM",
    recipient: getAddress(TYPED),
  });
});

test("with the node, a Dusk → Sepolia transfer carries the gas the quote shows", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);

  await submitServiceTransfer({ amountLux: 2_000_000_000n, destination: TYPED, node });

  const [{ params }] = wallet.sent;
  assert.deepEqual(params.gas, { limit: "2500000", price: "1" });
  assert.equal(params.memo, getAddress(TYPED));
});

test("a deposit or transfer is priced at the gas price its page quoted, not at one read again", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);
  const moved = { gasPrice: async () => 2n };

  await submitDuskEvmDeposit({ amountLux: 100_000_000n, gasPrice: 1n, node: moved, recipient: TYPED });
  await submitServiceTransfer({ amountLux: 2_000_000_000n, destination: TYPED, gasPrice: 1n, node: moved });

  assert.deepEqual(wallet.sent.map(({ params }) => params.gas), [
    { limit: "5000000", price: "1" },
    { limit: "2500000", price: "1" },
  ]);
});

test("a deposit or transfer reviewed for one Dusk account isn't sent as another", async () => {
  const wallet = fakeWallet();
  useDuskWallet(wallet);
  const other = { account: "21n5ncOther" };
  await assert.rejects(submitDuskEvmDeposit({ ...other, amountLux: 100_000_000n, node, recipient: TYPED }), { code: "DUSK_ACCOUNT_CHANGED" });
  await assert.rejects(submitServiceTransfer({ ...other, amountLux: 2_000_000_000n, destination: TYPED, node }), { code: "DUSK_ACCOUNT_CHANGED" });
  assert.equal(wallet.sent.length, 0);
  await submitServiceTransfer({ account: "21n5ncyu", amountLux: 2_000_000_000n, destination: TYPED, node });
  assert.equal(wallet.sent.length, 1);
});

// The EVM account a review shows, checksummed, and another the wallet holds.
const REVIEWED = "0x75685f9D88749B583732B40d56fe007cD404b72D";
const OTHER = "0xf49ea944fd8a6bde7358a61ac1004fbaa9321aec";
const DUSK = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

/**
 * An EIP-1193 wallet stand-in on the reviewed account, in lower case as
 * wallets give it. It signs as the account it has selected, whatever the
 * request's `from` says, or, as a WalletConnect session, as `from`; and
 * `onSwitch` runs while its chain-switch dialog is open. `onAccounts` runs as
 * it's asked for its accounts, as it is right before a request goes out.
 */
function fakeEvmWallet({ onAccounts = () => {}, onSwitch = () => {}, signsFrom = false } = {}) {
  const listeners = new Map();
  const wallet = {
    accounts: [REVIEWED.toLowerCase()],
    chainId: 1,
    emit: (event, value) => (listeners.get(event) ?? []).forEach((listener) => listener(value)),
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter((other) => other !== listener)),
    async request({ method, params }) {
      if (method === "eth_accounts") {
        await onAccounts(wallet);
        return wallet.accounts;
      }
      if (method === "eth_chainId") return `0x${wallet.chainId.toString(16)}`;
      if (method === "wallet_switchEthereumChain") {
        wallet.chainId = Number.parseInt(params[0].chainId, 16);
        await onSwitch(wallet);
        return null;
      }
      if (method === "eth_sendTransaction") {
        wallet.sent.push({ from: params[0].from, signer: signsFrom ? params[0].from : wallet.accounts[0] });
        return `0x${"ab".repeat(32)}`;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    sent: [],
  };
  return wallet;
}

/** A browser wallet the page found itself, as it does without Reown's modal. */
async function useEvmWallet(options) {
  const wallet = fakeEvmWallet(options);
  globalThis.ethereum = wallet;
  await initializeEvmWallet();
  return wallet;
}

// The source chain's RPC: every call succeeds, and a sent transaction is mined.
globalThis.fetch = async (_url, { body }) => {
  const result = (method) =>
    ({
      eth_blockNumber: "0x10",
      eth_call: `0x${"1".padStart(64, "0")}`,
      eth_chainId: "0xaa36a7",
      eth_getTransactionReceipt: { blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", logs: [], status: "0x1", transactionHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0" },
    })[method];
  const calls = JSON.parse(body);
  const answer = ({ id, method }) => ({ id, jsonrpc: "2.0", result: result(method) });
  return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
};

const sends = {
  approve: (account) => approveMigration(config.evmNetworks.ethereum, "1", { account }),
  migrate: (account) => submitMigration(config.evmNetworks.ethereum, "1", DUSK, { account }),
  withdraw: (account) => submitDuskEvmWithdrawal({ account, amount: "1", duskAccount: DUSK }),
};

test("an EVM withdrawal, approval or migration goes out from the account it was reviewed for, or not at all", async () => {
  const switches = {
    // The wallet switches account while its chain-switch dialog is open.
    during: (wallet) => {
      wallet.accounts = [OTHER];
      wallet.emit("accountsChanged", [OTHER]);
    },
    // Or it says so only once the switch is done.
    after: (wallet) => {
      wallet.accounts = [OTHER];
      setTimeout(() => wallet.emit("accountsChanged", [OTHER]));
    },
  };
  for (const [name, send] of Object.entries(sends)) {
    for (const [when, onSwitch] of Object.entries(switches)) {
      const wallet = await useEvmWallet({ onSwitch });
      await assert.rejects(send(REVIEWED), { code: "EVM_ACCOUNT_CHANGED" }, `${name}, switched ${when}`);
      assert.deepEqual(wallet.sent, [], `${name}, switched ${when}`);
    }
    const steady = await useEvmWallet();
    await send(REVIEWED);
    assert.deepEqual(steady.sent.map(({ from, signer }) => [from.toLowerCase(), signer]), [[REVIEWED.toLowerCase(), REVIEWED.toLowerCase()]], name);
    // A wallet that selected another account, still listing the reviewed
    // one after it, and hasn't said so: nothing is sent.
    const second = await useEvmWallet();
    second.accounts = [OTHER, REVIEWED.toLowerCase()];
    await assert.rejects(send(REVIEWED), { code: "EVM_ACCOUNT_CHANGED" }, `${name}, listed second`);
    assert.deepEqual(second.sent, [], `${name}, listed second`);
  }
  delete globalThis.ethereum;
});

test("an EVM withdrawal, approval or migration isn't sent on another chain than its own", async () => {
  for (const [name, send] of Object.entries(sends)) {
    // The wallet says yes to the switch, and stays where it is.
    const stays = await useEvmWallet({
      onSwitch: (wallet) => {
        wallet.chainId = 1;
      },
    });
    await assert.rejects(send(REVIEWED), /still on another chain/u, `${name}, stays`);
    assert.deepEqual(stays.sent, [], `${name}, stays`);
    // It switches as asked, then moves away again before the request goes out.
    let asked = false;
    const moves = await useEvmWallet({
      onAccounts: (wallet) => {
        if (asked) wallet.chainId = 1;
      },
      onSwitch: () => {
        asked = true;
      },
    });
    await assert.rejects(send(REVIEWED), /chain/u, `${name}, moves`);
    assert.deepEqual(moves.sent, [], `${name}, moves`);
  }
  delete globalThis.ethereum;
});

test("where Reown picks the EVM account, the reviewed one may be any the wallet lists; otherwise it's the wallet's first", () => {
  const listed = [OTHER, REVIEWED.toLowerCase()];
  assert.equal(heldAccount(listed, REVIEWED, { reownPicks: true }), REVIEWED.toLowerCase());
  assert.equal(heldAccount(listed, REVIEWED), undefined);
  assert.equal(heldAccount([REVIEWED.toLowerCase(), OTHER], REVIEWED), REVIEWED.toLowerCase());
  assert.equal(heldAccount([OTHER], REVIEWED, { reownPicks: true }), undefined);
  assert.equal(heldAccount([], REVIEWED, { reownPicks: true }), undefined);
});

/** Reown's AppKit stand-in, connected to the reviewed account through `wallet`, by a connector of `type`. */
function fakeAppKit() {
  const subscribers = { account: [], network: [], providers: [] };
  const appKit = {
    // AppKit's own idea of the network: it can be one it saved, whatever the wallet is on.
    network(chainId) {
      appKit.getChainId = () => chainId;
      subscribers.network.forEach((listener) => listener({ chainId }));
    },
    connect(wallet, type) {
      appKit.connection = { type, wallet };
      subscribers.providers.forEach((listener) => listener({ eip155: wallet }));
      subscribers.account.forEach((listener) => listener({ address: REVIEWED, isConnected: true }));
    },
    connection: null,
    getAccount: () => ({ address: REVIEWED, isConnected: Boolean(appKit.connection) }),
    getChainId: () => 1,
    getWalletInfo: () => undefined,
    getWalletProvider: () => appKit.connection?.wallet ?? null,
    getWalletProviderType: () => appKit.connection?.type,
    open: async () => {},
    subscribeAccount: (listener) => subscribers.account.push(listener),
    subscribeNetwork: (listener) => subscribers.network.push(listener),
    subscribeProviders: (listener) => subscribers.providers.push(listener),
    updateOptions: (options) => Object.assign(appKit.options, options),
  };
  return appKit;
}

test("through Reown's modal, a browser wallet that selected another account and lists the reviewed one second is sent nothing", async () => {
  // Astra's case: the wallet switches to another account during the chain
  // switch, lists the reviewed one after it, and says so only later.
  const switchesLate = (wallet) => {
    const listed = [OTHER, REVIEWED.toLowerCase()];
    wallet.accounts = listed;
    setTimeout(() => wallet.emit("accountsChanged", listed));
  };
  globalThis.reownAppKit = fakeAppKit();
  // A browser wallet, an EIP-6963 one, and one whose connector AppKit doesn't name.
  for (const type of ["INJECTED", "ANNOUNCED", undefined]) {
    for (const [name, send] of Object.entries(sends)) {
      const wallet = fakeEvmWallet({ onSwitch: switchesLate });
      if (globalThis.reownAppKit.connection) globalThis.reownAppKit.connect(wallet, type);
      else {
        globalThis.reownAppKit.connection = { type, wallet };
        await connectEvmWallet();
      }
      await assert.rejects(send(REVIEWED), { code: "EVM_ACCOUNT_CHANGED" }, `${name}, ${type}`);
      assert.deepEqual(wallet.sent, [], `${name}, ${type}`);
    }
  }
  // Neither Coinbase Wallet nor Base Account: their SDKs call Coinbase as they load.
  assert.equal(globalThis.reownAppKit.options.enableCoinbase, false);
  assert.equal(globalThis.reownAppKit.options.enableBaseAccount, false);
});

test("through Reown, the page's chain is the one the wallet says, whatever AppKit saved or guessed", async () => {
  const kit = globalThis.reownAppKit;
  // AppKit's own sheet for a chain it doesn't know can't be closed: the card offers the switch.
  assert.equal(kit.options.allowUnsupportedChain, true);
  const answered = () => new Promise(setImmediate);

  // The wallet's on Ethereum; AppKit starts with the test chain it saved.
  const wallet = fakeEvmWallet();
  wallet.chainId = 1;
  kit.connect(wallet, "INJECTED");
  kit.network(745_745);
  await answered();
  assert.equal(getEvmState().chainId, 1);

  // The other way round: the wallet's where it should be, and AppKit still has the chain it saved.
  wallet.chainId = 745_745;
  wallet.emit("chainChanged", "0xb6111");
  kit.network(1);
  await answered();
  assert.equal(getEvmState().chainId, 745_745);

  // A slow answer doesn't overwrite what the wallet said since.
  let answer;
  const slow = fakeEvmWallet();
  slow.chainId = 1;
  kit.connect(slow, "INJECTED");
  await answered();
  const request = slow.request;
  slow.request = (ask) => (ask.method === "eth_chainId" ? new Promise((settle) => (answer = () => settle("0x1"))) : request(ask));
  kit.network(1);
  slow.emit("chainChanged", "0xb6111");
  answer();
  await answered();
  assert.equal(getEvmState().chainId, 745_745);
});

test("through Reown, a WalletConnect session sends from the reviewed account wherever the wallet lists it", async () => {
  for (const [name, send] of Object.entries(sends)) {
    const session = fakeEvmWallet({ signsFrom: true });
    session.accounts = [OTHER, REVIEWED.toLowerCase()];
    globalThis.reownAppKit.connect(session, "WALLET_CONNECT");
    await send(REVIEWED);
    assert.deepEqual(session.sent.map(({ from, signer }) => [from.toLowerCase(), signer.toLowerCase()]), [[REVIEWED.toLowerCase(), REVIEWED.toLowerCase()]], name);
  }
  delete globalThis.reownAppKit;
});
