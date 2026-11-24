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
const { NO_FEE, submitDuskEvmWithdrawal } = await import("./duskevm-withdrawal.js");
// What a withdrawal's review asks the wallet for: DuskEVM testnet's limit and price caps for one.
const WITHDRAW_FEES = { gas: 166_127n, maxFeePerGas: 20_001_000_000n, maxPriorityFeePerGas: 1_000_000n };
const { connectEvmWallet, getEvmState, heldAccount, initializeEvmWallet } = await import("./evm-wallet.js");
const { APPROVAL_CANCELLED, NOT_REVOKED, REVOKE_CANCELLED, approveMigration, minedAs, revokeMigration, submitMigration } = await import("./legacy-migration.js");
const { sendToDusk } = await import("./hyperlane-evm.js");
const { HYPERLANE_EVM_ABI, duskRecipientHash } = await import("./hyperlane.js");
const { ROUTE_NOT_AS_BOOKED } = await import("./hyperlane-reads.js");
const { decodeFunctionData, pad, toFunctionSelector, toHex: hexOf } = await import("viem");

/**
 * Reads of Sepolia as the page makes them, stood in for: a token's delivery
 * fee for `quoteGasPayment`, and a call that goes through for anything else.
 */
const sepoliaReads = (fee) => async (method, params) => {
  if (method !== "eth_call") return null;
  return params[0].data.startsWith(toFunctionSelector("quoteGasPayment(uint32)")) ? pad(hexOf(fee)) : pad("0x01");
};

/**
 * The page's Hyperlane reads, stood in for: the routers as booked (or a
 * `route` refusal), the token's pause on Dusk, the whole charge the token
 * quotes (its ETH the delivery fee unless `charge` says otherwise), and
 * Sepolia read as `sepoliaReads` does.
 */
const sepoliaSide = (fee, { charge = null, paused = false, route = null } = {}) => ({
  checkRoute: async () => {
    if (route) throw new Error(route);
  },
  evm: sepoliaReads(fee),
  paused: async () => paused,
  transferCharge: async (_token, { amount }) => charge ?? { native: fee, token: amount },
});

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
        wallet.sent.push({ from: params[0].from, signer: signsFrom ? params[0].from : wallet.accounts[0], tx: params[0] });
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

// The source chain's RPC: every call succeeds, and a sent transaction is mined
// in block 16, which leaves nothing approved: as a revoke does.
globalThis.fetch = async (_url, { body }) => {
  const result = (method, params) =>
    ({
      eth_blockNumber: "0x10",
      eth_call: `0x${(params?.[0]?.data?.startsWith("0xdd62ed3e") && params[1] === "0x10" ? "0" : "1").padStart(64, "0")}`,
      eth_chainId: "0xaa36a7",
      eth_getTransactionReceipt: { blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x10", logs: [], status: "0x1", transactionHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0" },
    })[method];
  const calls = JSON.parse(body);
  const answer = ({ id, method, params }) => ({ id, jsonrpc: "2.0", result: result(method, params) });
  return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
};

const sends = {
  approve: (account, more) => approveMigration(config.evmNetworks.ethereum, "1", { account, ...more }),
  migrate: (account, more) => submitMigration(config.evmNetworks.ethereum, "1", DUSK, { account, ...more }),
  revoke: (account, more) => revokeMigration(config.evmNetworks.ethereum, { account, ...more }),
  withdraw: (account, more) => submitDuskEvmWithdrawal({ account, amount: "1", duskAccount: DUSK, fees: WITHDRAW_FEES, ...more }),
  "transfer back to Dusk": (account, more) => sendToDusk(config, { account, amount: 1n, reads: sepoliaSide(1n), recipient: DUSK, token: config.hyperlane.tokens[1], ...more }),
};

test("each send runs its last check after every wait on the way, right before the wallet is asked, and sends nothing where it throws", async () => {
  const stop = Object.assign(new Error("It would send something else now."), { code: "REVIEW_OUTDATED" });
  // An EVM wallet: after the chain switch and the account it's sent from.
  for (const [name, send] of Object.entries(sends)) {
    const asked = [];
    const wallet = await useEvmWallet({ onAccounts: () => asked.push("accounts"), onSwitch: () => asked.push("switch") });
    const check = () => {
      asked.push("check");
      throw stop;
    };
    await assert.rejects(send(REVIEWED, { beforeSend: check }), stop, name);
    assert.deepEqual(wallet.sent, [], name);
    assert.equal(asked.at(-1), "check", name);
    assert.ok(asked.indexOf("switch") >= 0 && asked.indexOf("switch") < asked.indexOf("check"), `${name}: ${asked}`);
  }
  delete globalThis.ethereum;
  // Dusk Wallet: after its session's check.
  for (const send of [sendDuskTransfer, sendDuskContractCall]) {
    const asked = [];
    const wallet = { ...fakeWallet(), refresh: async () => asked.push("refresh") };
    useDuskWallet(wallet);
    const request = send === sendDuskTransfer ? await serviceTransferRequest({ amountLux: 2_000_000_000n, destination: TYPED }) : await depositRequest({ amountLux: 2_000_000_000n, node, recipient: TYPED });
    const check = () => {
      asked.push("check");
      throw stop;
    };
    await assert.rejects(send(request, { account: wallet.state.selectedProfile.account, beforeSend: check }), stop, send.name);
    assert.deepEqual([wallet.sent, asked], [[], ["refresh", "check"]], send.name);
  }
});

test("an EVM withdrawal, approval, revoke or migration goes out from the account it was reviewed for, or not at all", async () => {
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

test("an EVM withdrawal, approval, revoke or migration isn't sent on another chain than its own", async () => {
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

test("a transfer back to Dusk is the token's transferRemote to the account's hash, its value the fee read as it's sent", async () => {
  const [, eurd] = config.hyperlane.tokens;
  const wallet = await useEvmWallet();
  const hash = await sendToDusk(config, { account: REVIEWED, amount: 10_000_000n, reads: sepoliaSide(132_000_000_001n), recipient: DUSK, reviewedFee: 132_000_000_001n, token: eurd });
  assert.equal(hash, `0x${"ab".repeat(32)}`);
  const [{ tx }] = wallet.sent;
  assert.deepEqual([tx.to.toLowerCase(), BigInt(tx.value)], [eurd.evm.token.toLowerCase(), 132_000_000_001n]);
  assert.deepEqual(decodeFunctionData({ abi: HYPERLANE_EVM_ABI, data: tx.data }), { args: [1146442572, duskRecipientHash(DUSK), 10_000_000n], functionName: "transferRemote" });
  // A fee that moved since the review sends nothing; nor does a recipient that isn't a Dusk account.
  const moved = await useEvmWallet();
  await assert.rejects(sendToDusk(config, { account: REVIEWED, amount: 1n, reads: sepoliaSide(2n), recipient: DUSK, reviewedFee: 1n, token: eurd }), { code: "FEE_CHANGED", fee: 2n });
  await assert.rejects(sendToDusk(config, { account: REVIEWED, amount: 1n, reads: sepoliaSide(1n), recipient: REVIEWED, token: eurd }), /isn't a Dusk account/u);
  await assert.rejects(sendToDusk(config, { account: REVIEWED, amount: 0n, reads: sepoliaSide(1n), recipient: DUSK, token: eurd }), /above 0/u);
  assert.deepEqual(moved.sent, []);
  delete globalThis.ethereum;
});

test("a transfer back to Dusk's review reads what its send checks: both routers, the token's pause on Dusk and the whole charge", async () => {
  const { inboundCharge } = await import("./hyperlane-evm.js");
  const [, eurd] = config.hyperlane.tokens;
  const read = (side) => inboundCharge(side, eurd, { amount: 10_000_000n, recipientHash: duskRecipientHash(DUSK) });
  assert.deepEqual(await read(sepoliaSide(132_000_000_001n)), { native: 132_000_000_001n, token: 10_000_000n });
  await assert.rejects(read(sepoliaSide(132_000_000_001n, { route: ROUTE_NOT_AS_BOOKED })), { message: ROUTE_NOT_AS_BOOKED });
  await assert.rejects(read(sepoliaSide(132_000_000_001n, { paused: true })), { message: "EURd is paused on Dusk, so it couldn't be paid out there. Nothing was sent." });
});

test("a transfer back to Dusk checks both routers, the token's pause on Dusk and the whole charge before the wallet is asked", async () => {
  const [, eurd] = config.hyperlane.tokens;
  const wallet = await useEvmWallet();
  const send = (side) => sendToDusk(config, { account: REVIEWED, amount: 10_000_000n, reads: side, recipient: DUSK, reviewedFee: 132_000_000_001n, token: eurd });
  await assert.rejects(send(sepoliaSide(132_000_000_001n, { route: ROUTE_NOT_AS_BOOKED })), { message: ROUTE_NOT_AS_BOOKED });
  // Dusk's EURd paused: the route couldn't pay it out, so nothing is burned.
  await assert.rejects(send(sepoliaSide(132_000_000_001n, { paused: true })), { message: "EURd is paused on Dusk, so it couldn't be paid out there. Nothing was sent." });
  // The token's own quote of the whole charge: its ETH must be what the review showed.
  await assert.rejects(send(sepoliaSide(132_000_000_001n, { charge: { native: 150_000_000_000n, token: 10_000_000n } })), { code: "FEE_CHANGED", fee: 150_000_000_000n });
  const fee = "The bridge would also take 0.005 EURd as a fee, which this page can't show yet, so nothing was sent.";
  await assert.rejects(
    send({
      ...sepoliaSide(132_000_000_001n),
      transferCharge: async () => {
        throw new Error(fee);
      },
    }),
    { message: fee },
  );
  assert.deepEqual(wallet.sent, []);
  delete globalThis.ethereum;
});

test("a transfer back to Dusk is simulated as the page read the chain, through the wallet, not as a public RPC a block behind sees it", async () => {
  const [, eurd] = config.hyperlane.tokens;
  const wallet = await useEvmWallet();
  // The public RPC doesn't see the tokens yet: the call reverts there.
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    const calls = JSON.parse(body);
    const answer = ({ id, method }) =>
      method === "eth_call" ? { error: { code: 3, message: "execution reverted" }, id, jsonrpc: "2.0" } : { id, jsonrpc: "2.0", result: method === "eth_chainId" ? "0xaa36a7" : "0x10" };
    return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
  };
  try {
    await sendToDusk(config, { account: REVIEWED, amount: 1n, reads: sepoliaSide(132_000_000_001n), recipient: DUSK, token: eurd });
    assert.equal(wallet.sent.length, 1);
  } finally {
    globalThis.fetch = fetch;
    delete globalThis.ethereum;
  }
});

test("a revoke is an approval of 0, and asks the wallet nothing once the chain says nothing's approved", async () => {
  const wallet = await useEvmWallet();
  const sent = [];
  const fetch = globalThis.fetch;
  // What the migration contract may still take, as the token's allowance says it now; the revoke's block leaves none.
  let approved = 1n;
  globalThis.fetch = async (url, init) => {
    const call = JSON.parse(init.body);
    if (!Array.isArray(call) && call.method === "eth_call" && call.params[0].data.startsWith("0xdd62ed3e") && call.params[1] === "latest")
      return Response.json({ id: call.id, jsonrpc: "2.0", result: `0x${approved.toString(16).padStart(64, "0")}` });
    if (!Array.isArray(call) && call.method === "eth_call" && !call.params[0].data.startsWith("0xdd62ed3e")) sent.push(call.params[0].data);
    return fetch(url, init);
  };
  try {
    assert.equal(await sends.revoke(REVIEWED), `0x${"ab".repeat(32)}`);
    // approve(migration contract, 0), as the wallet is asked to sign it.
    const network = config.evmNetworks.ethereum;
    assert.deepEqual(sent, [`0x095ea7b3${network.migrationContract.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`]);
    assert.equal(wallet.sent.length, 1);
    approved = 0n;
    assert.equal(await sends.revoke(REVIEWED), null);
    assert.equal(wallet.sent.length, 1);
  } finally {
    globalThis.fetch = fetch;
    delete globalThis.ethereum;
  }
});

/** What the wallet mines in place of what it sent, and the block it's in. */
const MINED = `0x${"cd".repeat(32)}`;
const MINED_IN = `0x${"ef".repeat(32)}`;

/**
 * The source chain, where what the wallet sent (0xabab…, from the reviewed
 * account at nonce 5) is never mined: another transaction is, at its nonce,
 * as when the wallet speeds it up ("repriced", the same call at another
 * price), cancels it ("cancelled", nothing to itself) or sends something
 * else ("replaced"). `approved` is the token's allowance: before, and as of
 * the block that mined the other.
 */
function replacedOn(reason, approved) {
  const from = REVIEWED.toLowerCase();
  const sent = { blockHash: null, blockNumber: null, from, gas: "0x5208", gasPrice: "0x1", hash: `0x${"ab".repeat(32)}`, input: "0x095ea7b3", nonce: "0x5", to: config.evmNetworks.ethereum.tokenContract.toLowerCase(), transactionIndex: null, type: "0x0", value: "0x0" };
  const instead = { ...sent, blockHash: MINED_IN, blockNumber: "0x10", gasPrice: "0x2", hash: MINED, transactionIndex: "0x0", ...{ cancelled: { input: "0x", to: from }, replaced: { input: "0xa9059cbb" }, repriced: {} }[reason] };
  const receipt = { blockHash: MINED_IN, blockNumber: "0x10", contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x2", from, gasUsed: "0x5208", logs: [], logsBloom: `0x${"0".repeat(512)}`, status: "0x1", to: instead.to, transactionHash: MINED, transactionIndex: "0x0", type: "0x0" };
  const word = (value) => `0x${value.toString(16).padStart(64, "0")}`;
  const result = ({ method, params }) =>
    ({
      eth_blockNumber: () => "0x10",
      eth_call: () => (params[0].data.startsWith("0xdd62ed3e") ? word(params[1] === "0x10" ? approved.after : approved.before) : word(1n)),
      eth_chainId: () => "0xaa36a7",
      eth_getBlockByNumber: () => ({ hash: MINED_IN, number: "0x10", parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", transactions: [instead] }),
      eth_getTransactionByHash: () => (params[0] === MINED ? instead : sent),
      eth_getTransactionReceipt: () => (params[0] === MINED ? receipt : null),
    })[method]?.();
  return async (_url, { body }) => {
    const calls = JSON.parse(body);
    const answer = (call) => ({ id: call.id, jsonrpc: "2.0", result: result(call) ?? null });
    return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
  };
}

test("a revoke is said to be done only once the chain says so, whatever the wallet sent in its place", async (t) => {
  // The chain's block watch waits between its polls: not here.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = globalThis.fetch;
  try {
    // Cancelled in the wallet after it was sent: nothing was revoked, and that's said.
    globalThis.fetch = replacedOn("cancelled", { after: 1n, before: 1n });
    await useEvmWallet();
    await assert.rejects(sends.revoke(REVIEWED), { message: REVOKE_CANCELLED });
    // Replaced by another transaction: not revoked either.
    globalThis.fetch = replacedOn("replaced", { after: 1n, before: 1n });
    await useEvmWallet();
    await assert.rejects(sends.revoke(REVIEWED), { message: NOT_REVOKED });
    // Sped up: revoked, as the chain says, by the transaction mined in its place.
    globalThis.fetch = replacedOn("repriced", { after: 0n, before: 1n });
    await useEvmWallet();
    assert.equal(await sends.revoke(REVIEWED), MINED);
  } finally {
    globalThis.fetch = fetch;
    delete globalThis.ethereum;
  }
});

test("an approval or a migration the wallet sped up goes by the transaction mined in its place", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = globalThis.fetch;
  try {
    // The approval's hash, kept with its transfer for its fee, is the one mined.
    globalThis.fetch = replacedOn("repriced", { after: 1n, before: 0n });
    await useEvmWallet();
    assert.equal(await sends.approve(REVIEWED), MINED);
    // Cancelled in the wallet once sent: nothing was approved, so no migration is offered on it.
    globalThis.fetch = replacedOn("cancelled", { after: 0n, before: 0n });
    await useEvmWallet();
    await assert.rejects(sends.approve(REVIEWED), { message: APPROVAL_CANCELLED });
    // A migration goes out as the wallet sent it, and is followed to what was mined.
    globalThis.fetch = replacedOn("repriced", { after: 1n, before: 1n });
    await useEvmWallet();
    const sent = await sends.migrate(REVIEWED);
    assert.deepEqual(await minedAs(config.evmNetworks.ethereum, sent), { hash: MINED, replaced: "repriced" });
  } finally {
    globalThis.fetch = fetch;
    delete globalThis.ethereum;
  }
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

test("a withdrawal asks the wallet for the gas limit and price caps its fee was quoted at, and sends nothing without them", async () => {
  const wallet = await useEvmWallet();
  await submitDuskEvmWithdrawal({ account: REVIEWED, amount: "1", duskAccount: DUSK, fees: WITHDRAW_FEES });
  assert.deepEqual(
    wallet.sent.map(({ tx }) => [tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas]),
    [["0x288ef", "0x4a8270a40", "0xf4240"]],
  );
  for (const fees of [undefined, { ...WITHDRAW_FEES, gas: null }, { ...WITHDRAW_FEES, maxFeePerGas: undefined }])
    await assert.rejects(submitDuskEvmWithdrawal({ account: REVIEWED, amount: "1", duskAccount: DUSK, fees }), { message: NO_FEE });
  assert.equal(wallet.sent.length, 1);
  delete globalThis.ethereum;
});
