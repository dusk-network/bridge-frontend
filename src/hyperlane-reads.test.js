import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { accountToRawKey } from "@dusk-network/networks/account";
import { encodeAbiParameters, encodeFunctionResult, pad, toEventSelector } from "viem";

import { loadConfig } from "./config.js";
import { createDriverLoader, fromHex, toHex } from "./data-driver.js";
import { createDuskNode } from "./dusk-node.js";
import { HYPERLANE_EVM_ABI, duskRecipientHash } from "./hyperlane.js";
import { MAILBOX_FULL, ROUTE_NOT_AS_BOOKED, createHyperlaneReads } from "./hyperlane-reads.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const T = Object.fromEntries(cfg.hyperlane.tokens.map((token) => [token.symbol, token]));
const NODE = cfg.dusk.nodeUrl;
const loadDriver = createDriverLoader({ fetch: async (url) => new Response(await readFile(new URL(`../public${url}`, import.meta.url))) });

const ACCOUNT = "xGX8tZ9zvamEVKM9vb8GeUQ3xihLd7fQP4w3RSZMD1R61YasXZsgRYRmjStAePvqd4ykZ3mGQhk76e4rvRQ35U2fdS1NGJEvxzKYjB8fD9zShiYphcMmgL6LowdnTzQjkw9";
const EVM = "0x8A51d0619286d937699D85c1a2c88D67A5a1B75d";
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
};
const padded = (address) => fromHex(address.slice(2).toLowerCase().padStart(64, "0"));

/**
 * The deployment's node, stood in for: each contract query answered from
 * `answers` by contract and function, with what was asked kept in `asked`.
 */
function fakeNode(answers, { events = [] } = {}) {
  const asked = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/on/graphql/query") return new Response(JSON.stringify({ contractEvents: { json: events } }));
    const [, id, fnName] = /^\/on\/contracts:([0-9a-f]{64})\/(\w+)$/u.exec(pathname);
    asked.push({ args: toHex(new Uint8Array(init.body)), fnName, headers: init.headers, id });
    const answer = answers[`${id}/${fnName}`];
    return answer === undefined ? new Response("no such query", { status: 500 }) : new Response(answer);
  };
  return { asked, node: createDuskNode({ fetch, url: NODE }) };
}

/** Testnet's routes as the chain has them. */
function bookedAnswers() {
  const answers = {};
  for (const token of Object.values(T)) {
    answers[`${token.dusk.route}/enrolled_router`] = padded(token.evm.token);
    answers[`${token.dusk.route}/quote_transfer_remote`] = u64(16_876_000_000n);
    // WarpNative reports 5, a collateral route 7: the contracts can't be upgraded.
    answers[`${token.dusk.route}/state_version`] = Uint8Array.of(token.native ? 5 : 7, 0, 0, 0);
    if (!token.native) answers[`${token.dusk.route}/wrapped_token`] = fromHex(token.dusk.token);
  }
  answers[`${cfg.hyperlane.dusk.mailbox}/fee_credit`] = u64(0);
  answers[`${cfg.hyperlane.dusk.mailbox}/memory_bytes`] = u64(393_216);
  return answers;
}

/**
 * Sepolia as the book has it: each token's router for Dusk is its Dusk
 * route, unless `override` names another, by symbol.
 */
const bookedRpc = (override = {}) => async (_network, method, params) => {
  if (method !== "eth_call") return null;
  const token = Object.values(T).find((each) => each.evm.token.toLowerCase() === params[0].to.toLowerCase());
  return encodeFunctionResult({ abi: HYPERLANE_EVM_ABI, functionName: "routers", result: override[token.symbol] ?? `0x${token.dusk.route}` });
};

test("a route is checked against the book before anything is signed: where it sends, what it locks, and the Mailbox's room", async () => {
  const { asked, node } = fakeNode(bookedAnswers());
  const reads = createHyperlaneReads({ cfg, loadDriver, node, rpc: bookedRpc() });
  for (const token of Object.values(T)) {
    await reads.checkRoute(token);
    assert.equal(await reads.dispatchFee(token), 16_876_000_000n);
    await reads.checkMailbox(token, 16_876_000_000n);
  }
  // Every query is rkyv bytes: the node refuses them as text.
  assert.ok(asked.every((each) => each.headers["content-type"] === "application/octet-stream"));
  // The router is asked for Sepolia's domain, a little-endian u32.
  assert.equal(asked.find((each) => each.fnName === "enrolled_router").args, "a736aa00");

  // A router to another token, a route of another kind, or a full Mailbox: nothing is sent.
  const wrongRouter = { ...bookedAnswers(), [`${T.EURd.dusk.route}/enrolled_router`]: padded(T.USDd.evm.token) };
  await assert.rejects(createHyperlaneReads({ cfg, loadDriver, node: fakeNode(wrongRouter).node, rpc: bookedRpc() }).checkRoute(T.EURd), { message: ROUTE_NOT_AS_BOOKED });
  const wrongToken = { ...bookedAnswers(), [`${T.USDd.dusk.route}/wrapped_token`]: fromHex(T.EURd.dusk.token) };
  await assert.rejects(createHyperlaneReads({ cfg, loadDriver, node: fakeNode(wrongToken).node, rpc: bookedRpc() }).checkRoute(T.USDd), { message: ROUTE_NOT_AS_BOOKED });
  const notNative = { ...bookedAnswers(), [`${T.DUSK.dusk.route}/state_version`]: Uint8Array.of(7, 0, 0, 0) };
  await assert.rejects(createHyperlaneReads({ cfg, loadDriver, node: fakeNode(notNative).node, rpc: bookedRpc() }).checkRoute(T.DUSK), { message: ROUTE_NOT_AS_BOOKED });
  const full = { ...bookedAnswers(), [`${cfg.hyperlane.dusk.mailbox}/memory_bytes`]: u64(3n * 1024n ** 3n) };
  await assert.rejects(createHyperlaneReads({ cfg, loadDriver, node: fakeNode(full).node, rpc: bookedRpc() }).checkMailbox(T.DUSK, 1n), { message: MAILBOX_FULL });
  // A route of another kind than the book's: a WarpDrc20, say, for EURd's collateral route.
  const synthetic = { ...bookedAnswers(), [`${T.EURd.dusk.route}/state_version`]: Uint8Array.of(8, 0, 0, 0) };
  await assert.rejects(createHyperlaneReads({ cfg, loadDriver, node: fakeNode(synthetic).node, rpc: bookedRpc() }).checkRoute(T.EURd), { message: ROUTE_NOT_AS_BOOKED });
  // A route with standing credit is no new payer.
  const credited = { ...full, [`${cfg.hyperlane.dusk.mailbox}/fee_credit`]: u64(1) };
  await createHyperlaneReads({ cfg, loadDriver, node: fakeNode(credited).node, rpc: bookedRpc() }).checkMailbox(T.DUSK, 1n);
});

test("a holder's balance and allowance are read as the canonical DRC20 names accounts: its raw key, and the route as a contract", async () => {
  const answers = {
    [`${T.EURd.dusk.token}/allowance`]: u64(999_233_154_034n),
    [`${T.EURd.dusk.token}/balance_of`]: u64(49_805_396_789n),
    [`${T.EURd.dusk.token}/paused`]: Uint8Array.of(0),
  };
  const { asked, node } = fakeNode(answers);
  const reads = createHyperlaneReads({ cfg, loadDriver, node, rpc: async () => null });
  assert.equal(await reads.tokenBalance(T.EURd, ACCOUNT), 49_805_396_789n);
  assert.equal(await reads.allowance(T.EURd, ACCOUNT), 999_233_154_034n);
  assert.equal(await reads.paused(T.EURd), false);
  const raw = toHex(accountToRawKey(ACCOUNT));
  assert.equal(asked[0].args, `00${raw}`);
  assert.equal(asked[1].args.slice(0, 2 + 386), `00${raw}`);
  assert.ok(asked[1].args.slice(388).startsWith(`02${T.EURd.dusk.route}`), asked[1].args);
  await assert.rejects(reads.tokenBalance(T.EURd, EVM), /isn't a Dusk account/u);
});

test("each route's escrow is read by the account's recipient hash", async () => {
  const hash = duskRecipientHash(ACCOUNT);
  const answers = {};
  for (const token of Object.values(T)) {
    answers[`${token.dusk.route}/is_registered`] = Uint8Array.of(token.symbol === "DUSK" ? 1 : 0);
    answers[`${token.dusk.route}/pending_balance`] = u64(token.symbol === "EURd" ? 10_000_000n : 0n);
  }
  const { asked, node } = fakeNode(answers);
  const read = await createHyperlaneReads({ cfg, loadDriver, node, rpc: async () => null }).escrow(hash);
  assert.deepEqual(
    read.map((each) => [each.token.symbol, each.registered, each.pending]),
    [
      ["DUSK", true, 0n],
      ["EURd", false, 10_000_000n],
      ["USDd", false, 0n],
    ],
  );
  assert.ok(asked.every((each) => each.args === hash.slice(2)));
});

test("a Dusk transfer's message ID is its own transaction's dispatch_id, from the Mailbox", async () => {
  const hash = "86123720ef95abd0bc11583123b1c8f633195188fca0f1df985d1084a99b383f";
  const id = "ed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b";
  const event = (patch) => ({ data: id, origin: hash, reverted: false, source: cfg.hyperlane.dusk.mailbox, topic: "dispatch_id", ...patch });
  const read = (events) => createHyperlaneReads({ cfg, loadDriver, node: fakeNode({}, { events }).node, rpc: async () => null }).dispatchedId(hash, 4_888_567n);
  // Another transaction's, another contract's, or one reverted is not this transfer's.
  assert.equal(await read([event({ origin: "11".repeat(32) }), event({ source: "22".repeat(32) }), event({ reverted: true })]), null);
  assert.equal(await read([event({ data: "33".repeat(32), origin: "11".repeat(32) }), event({})]), `0x${id}`);
  assert.equal(await read([]), null);
});

test("Sepolia is read through the EVM wallet while it's on Sepolia, and the deployment's RPC otherwise", async () => {
  const quote = encodeFunctionResult({ abi: HYPERLANE_EVM_ABI, functionName: "quoteGasPayment", result: 132_000_000_001n });
  const answer = (method) => ({ eth_blockNumber: "0x10", eth_call: quote, eth_gasPrice: "0x2", eth_getBalance: "0x5" })[method];
  const viaRpc = [];
  const viaWallet = [];
  const rpc = async (network, method) => {
    viaRpc.push([network, method]);
    return answer(method);
  };
  let wallet = { chainId: 11155111, provider: { request: async ({ method }) => (viaWallet.push(method), answer(method)) } };
  const reads = createHyperlaneReads({ cfg, loadDriver, node: fakeNode({}).node, rpc, wallet: () => wallet });
  assert.equal((await reads.evmState(T.DUSK, "0x75685f9D88749B583732B40d56fe007cD404b72D")).deliveryFeeWei, 132_000_000_001n);
  assert.deepEqual([viaWallet.sort(), viaRpc], [["eth_call", "eth_call", "eth_gasPrice", "eth_getBalance"], []]);
  // On another chain, the RPC of the chain's network, Sepolia's.
  wallet = { ...wallet, chainId: 1 };
  assert.equal(await reads.evmHead(), 16n);
  assert.deepEqual(viaRpc, [["ethereum", "eth_blockNumber"]]);
  // A wallet that can't answer a read: the RPC can.
  wallet = { chainId: 11155111, provider: { request: async () => Promise.reject(new Error("not supported")) } };
  assert.equal(await reads.evmHead(), 16n);
  assert.equal(viaRpc.length, 2);
});

test("a Sepolia transfer's receipt gives its message ID, what it sent and to whom, and what it paid", async () => {
  const token = T.EURd;
  const hash = duskRecipientHash(ACCOUNT);
  const id = "0x8bfceee4fc2bb2d10246a3b7c7ac8f75538cded9501f44382df39123c0f86db6";
  const receipt = {
    blockNumber: "0xb98c1c",
    effectiveGasPrice: "0x3b9aca00",
    from: EVM.toLowerCase(),
    gasUsed: "0x3e8",
    logs: [
      // Another contract's DispatchId-like log isn't the Mailbox's.
      { address: token.evm.token, data: "0x", topics: [toEventSelector("DispatchId(bytes32)"), pad("0x01")] },
      {
        address: token.evm.token,
        data: encodeAbiParameters([{ type: "uint256" }], [10_000_000n]),
        topics: [toEventSelector("SentTransferRemote(uint32,bytes32,uint256)"), pad("0x4455534c"), hash],
      },
      { address: cfg.hyperlane.evm.mailbox.toLowerCase(), data: "0x", topics: [toEventSelector("DispatchId(bytes32)"), id] },
    ],
    status: "0x1",
    to: token.evm.token.toLowerCase(),
  };
  const rpc = async (network, method) => ({ eth_getBlockByNumber: { timestamp: "0x6a2b5c90" }, eth_getTransactionReceipt: receipt })[method];
  const read = await createHyperlaneReads({ cfg, loadDriver, node: fakeNode({}).node, rpc }).evmTransfer("0xaa", token);
  assert.deepEqual(read, {
    at: 0x6a2b5c90 * 1_000,
    blockNumber: 0xb98c1cn,
    failed: false,
    feeWei: 1_000_000_000_000n,
    from: EVM,
    messageId: id,
    sent: { amount: 10_000_000n, destination: 1146442572, recipient: hash },
    to: token.evm.token.toLowerCase(),
  });
  // Not mined yet: nothing to say.
  assert.equal(await createHyperlaneReads({ cfg, loadDriver, node: fakeNode({}).node, rpc: async () => null }).evmTransfer("0xaa", token), null);
});

test("a route's router is read again for every transfer: one enrolled since the review is refused", async () => {
  const answers = bookedAnswers();
  const reads = createHyperlaneReads({ cfg, loadDriver, node: fakeNode(answers).node, rpc: bookedRpc() });
  await reads.checkRoute(T.DUSK);
  // The route's owner enrolls another router for Sepolia after the review opened.
  answers[`${T.DUSK.dusk.route}/enrolled_router`] = padded(T.EURd.evm.token);
  await assert.rejects(reads.checkRoute(T.DUSK), { message: ROUTE_NOT_AS_BOOKED });
});

test("both routers name each other before anything is locked or burned: Dusk's route enrolled to the Sepolia token, the token's router for Dusk the route", async () => {
  const reads = (override) => createHyperlaneReads({ cfg, loadDriver, node: fakeNode(bookedAnswers()).node, rpc: bookedRpc(override) });
  for (const token of Object.values(T)) await reads().checkRoute(token);
  // Sepolia's EURd token sending to another Dusk route: refused.
  await assert.rejects(reads({ EURd: `0x${T.USDd.dusk.route}` }).checkRoute(T.EURd), { message: ROUTE_NOT_AS_BOOKED });
  await assert.rejects(reads({ DUSK: pad("0x00") }).checkRoute(T.DUSK), { message: ROUTE_NOT_AS_BOOKED });
});

test("the whole charge of a transfer back to Dusk is read: its ETH, and the token it takes, refused where that's more than the amount", async () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const token = T.EURd;
  const reads = (quotes) =>
    createHyperlaneReads({
      cfg,
      loadDriver,
      node: fakeNode({}).node,
      rpc: async (_network, method) => (method === "eth_call" ? encodeFunctionResult({ abi: HYPERLANE_EVM_ABI, functionName: "quoteTransferRemote", result: quotes }) : null),
    });
  const args = { amount: 1_000_000n, recipient: duskRecipientHash(ACCOUNT) };
  // As HypERC20 12.3.0 answers it: the ETH for delivery, the amount, and a fee of nothing in the token.
  const charge = await reads([{ amount: 132_000_000_001n, token: zero }, { amount: 1_000_000n, token: token.evm.token }, { amount: 0n, token: token.evm.token }]).transferCharge(token, args);
  assert.deepEqual(charge, { native: 132_000_000_001n, token: 1_000_000n });
  await assert.rejects(reads([{ amount: 1n, token: zero }, { amount: 1_000_000n, token: token.evm.token }, { amount: 5_000n, token: token.evm.token }]).transferCharge(token, args), {
    message: "The bridge would also take 0.005 EURd as a fee, which this page can't show yet, so nothing was sent.",
  });
  await assert.rejects(reads([{ amount: 1n, token: zero }, { amount: 1_000_000n, token: token.evm.token }, { amount: 1n, token: T.USDd.evm.token }]).transferCharge(token, args), {
    message: "The bridge would also charge another token, which this page can't show, so nothing was sent.",
  });
});

test("a wallet that reverts a read is believed; only a wallet that can't answer it hands it to the RPC", async () => {
  const viaRpc = [];
  const rpc = async (_network, method) => (viaRpc.push(method), "0x10");
  let failure;
  const wallet = { chainId: 11155111, provider: { request: async () => Promise.reject(failure) } };
  const reads = createHyperlaneReads({ cfg, loadDriver, node: fakeNode({}).node, rpc, wallet: () => wallet });
  const call = () => reads.evm("eth_call", [{ data: "0x", to: T.EURd.evm.token }, "latest"]);
  // A revert, however it's wrapped, and a call its node found the account can't pay for.
  for (const revert of [
    Object.assign(new Error("execution reverted"), { code: 3, data: "0x" }),
    Object.assign(new Error("Internal JSON-RPC error."), { code: -32603, data: { code: 3, message: "execution reverted" } }),
    Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 }),
  ]) {
    failure = revert;
    await assert.rejects(call(), { message: revert.message });
  }
  assert.deepEqual(viaRpc, []);
  // A method it doesn't have, or a connection that dropped: the RPC answers.
  for (const unanswered of [
    Object.assign(new Error("Method not found"), { code: -32601 }),
    Object.assign(new Error("Invalid params"), { code: -32602 }),
    Object.assign(new Error("Unsupported method"), { code: 4200 }),
    Object.assign(new Error("Disconnected"), { code: 4900 }),
    new TypeError("Failed to fetch"),
  ]) {
    failure = unanswered;
    assert.equal(await call(), "0x10");
  }
  assert.equal(viaRpc.length, 5);
});
