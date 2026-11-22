import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbi,
  toEventSelector,
  toHex,
} from "viem";

import { WithdrawalError } from "@dusk-network/app-core/duskevm-withdrawals";
import { networks } from "@dusk-network/networks";
import { encodeDepositArgs, evmAddressOf } from "@dusk-network/networks/duskevm";

// Two accounts the networks' files name: the BSC and the Sepolia bridge accounts.
const MAINNET_BSC_BRIDGE_ACCOUNT = networks.mainnet.routes.services[0].account;
const TESTNET_REGGIO_BRIDGE_ACCOUNT = networks.testnet.routes.services[0].account;
import { createDuskNode } from "./dusk-node.js";
import { createScheduler, createTracking, takenByAnother } from "./tracking.js";
import { NOT_A_DUSK_WITHDRAWAL } from "./withdrawals.js";

const SENDER = MAINNET_BSC_BRIDGE_ACCOUNT; // any valid Dusk account works here
const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
const DUSK_HASH = "ab".repeat(32);
const EVM_HASH = `0x${"cd".repeat(32)}`;
/** An EVM transaction's hash, of one byte repeated. */
const evmTx = (byte) => `0x${byte.repeat(32)}`;
const hex = (text) => Buffer.from(text).toString("hex");
const TRANSFER_CONTRACT = `01${"0".repeat(62)}`;

// Testnet's DuskEVM bridge on Dusk, which deposits go to, and its L2 bridge.
const BRIDGE = networks.testnet.duskEvm.contracts.l1_standard_bridge.contractId;
const L2_BRIDGE = "0x4200000000000000000000000000000000000010";
const DUSKEVM_RPC = "https://rpc.duskevm.test";

const cfg = {
  profile: "testnet",
  dusk: {},
  duskEvm: {
    l1StandardBridgeContractId: BRIDGE,
    predeploys: { l2StandardBridge: L2_BRIDGE },
    name: "DuskEVM Testnet",
    rpcUrl: DUSKEVM_RPC,
  },
  evmNetworks: {
    ethereum: { chainName: "Sepolia", tokenContract: "0xAced3474eA24f5d77464A0F625dEEB6EaDeE25b8" },
  },
  service: {
    account: TESTNET_REGGIO_BRIDGE_ACCOUNT,
    delaySeconds: 3_600,
    feeLux: 1_000_000_000n,
    network: "ethereum",
    payoutAddress: "",
  },
  network: networks.testnet,
};

// Mainnet's Dusk → BNB Smart Chain route, which names the address it pays out from.
const BSC_SERVICE = networks.mainnet.routes.services[0];
const BSC_TOKEN = networks.mainnet.routes.chains.bsc.token;
const BSC_RPC = "https://rpc.bsc.test";
const bscCfg = {
  ...cfg,
  evmNetworks: { bsc: { chainName: "BNB Smart Chain", rpcUrl: BSC_RPC, tokenContract: BSC_TOKEN } },
  network: networks.mainnet,
  profile: "mainnet",
  service: { account: BSC_SERVICE.account, delaySeconds: 36_000, feeLux: 1_000_000_000n, network: "bsc", payoutAddress: BSC_SERVICE.payoutAddress },
};

// Testnet with the account that pays Sepolia's migrations out, as a deployment sets it.
const PAYER = TESTNET_REGGIO_BRIDGE_ACCOUNT;
const payingCfg = {
  ...cfg,
  network: {
    ...networks.testnet,
    routes: { ...networks.testnet.routes, migrations: networks.testnet.routes.migrations.map((route) => ({ ...route, payoutAccount: PAYER })) },
  },
};

const ROUTES = {
  deposit: { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-dusk-evm", mode: "duskevm-deposit", to: { id: "dusk-evm", kind: "evm" } },
  migration: { from: { id: "ethereum", kind: "evm" }, id: "ethereum-to-dusk", mode: "migration", to: { id: "dusk", kind: "dusk" } },
  service: { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-bsc", mode: "service-transfer", to: { id: "bsc", kind: "evm" } },
  withdrawal: { from: { id: "dusk-evm", kind: "evm" }, id: "dusk-evm-to-dusk", mode: "duskevm-withdrawal", to: { id: "dusk", kind: "dusk" } },
};

/** An EVM block, numbered by its time: block n is 1,792,980,000 + n seconds; the head is 2,000. */
const blockAt = (tag) => {
  const number = tag === "latest" ? 2_000n : BigInt(tag);
  return { number: toHex(number), timestamp: toHex(1_792_980_000n + number) };
};

/** JSON-RPC by network and method; blocks are numbered by their time. */
function fakeRpc(handlers) {
  const calls = [];
  const rpc = async (network, method, params) => {
    calls.push({ method, network, params });
    const handler = handlers[`${network}:${method}`] ?? handlers[method];
    if (handler) return handler(params);
    if (method === "eth_blockNumber") return toHex(2_000n);
    if (method === "eth_getBlockByNumber") return blockAt(params[0]);
    throw Object.assign(new Error(`unexpected ${network}:${method}`), { code: -32000 });
  };
  rpc.calls = calls;
  return rpc;
}

/**
 * An EVM chain's JSON-RPC over fetch, as the payout searches ask it: `logs`
 * answers eth_getLogs, like a node only within the blocks asked; blocks are
 * numbered by their time. `calls` hears each request.
 */
function fakeChain(logs = () => []) {
  const calls = [];
  const fetch = async (url, { body }) => {
    const { method, params } = JSON.parse(body);
    calls.push({ method, params, url });
    const [filter] = params;
    const result =
      method === "eth_getLogs"
        ? logs(filter).filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock))
        : method === "eth_blockNumber"
          ? toHex(2_000n)
          : blockAt(params[0]);
    return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result }));
  };
  fetch.calls = calls;
  return fetch;
}

/**
 * The Dusk archive, as the payout searches ask it: each account's history
 * (`history`, by account, as the archive lists it), each transaction
 * (`txs`, by hash) and the transfers by memo (`memos`).
 */
const archive = ({ history = {}, memos = {}, txs = {} } = {}) => ({
  query: async (text) => {
    const data = {};
    for (const [, alias, account, from, to, page = 1] of text.matchAll(
      /(\w+): moonlightHistory\(\w+: "(\w+)", fromBlock: (\d+), toBlock: (\d+), maxCount: 50(?:, pageCount: (\d+))?\)/gu,
    )) {
      const range = (history[account] ?? []).filter((item) => item.block_height >= Number(from) && item.block_height <= Number(to));
      data[alias] = { json: range.slice((page - 1) * 50, page * 50) };
    }
    for (const [, alias, hash] of text.matchAll(/(\w+): tx\(hash: "(\w+)"\)/gu)) data[alias] = txs[hash] ?? null;
    for (const [, alias, memo] of text.matchAll(/(\w+): transactionsByMemo\(memo: "(\w+)"\)/gu)) data[alias] = { json: memos[memo] ?? [] };
    return data;
  },
});

/** A deposit's details, sent at `at` seconds, as the archive gives them. */
const depositDetails = (at) => ({
  blockHash: "5c".repeat(32),
  blockTimestamp: at,
  err: null,
  gasSpent: 1,
  tx: {
    callData: {
      contractId: BRIDGE,
      data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
      fnName: "depositETHToWithValue",
    },
    gasLimit: 1,
    gasPrice: 1,
  },
});

/** A deposit of 0.1 DUSK by SENDER to the bridge, as the archive lists it in SENDER's history. */
const depositEntry = (hash, height = 10) => ({
  block_height: height,
  events: [{ data: { receiver: BRIDGE, sender: SENDER, value: "100000000" }, reverted: false, target: TRANSFER_CONTRACT, topic: "deposit" }],
  origin: hash,
});

/**
 * 2 DUSK to `account`, naming RECIPIENT, as the archive lists it in
 * `account`'s history: from another account, as SENDER is the BSC route's.
 */
const transferEntry = (hash, account, height = 4_000) => ({
  block_height: height,
  events: [
    {
      data: { gas_spent: "1000", memo: hex(RECIPIENT), receiver: account, refund_info: null, sender: TESTNET_REGGIO_BRIDGE_ACCOUNT, value: "2000000000" },
      reverted: false,
      target: TRANSFER_CONTRACT,
      topic: "moonlight",
    },
  ],
  origin: hash,
});

function duskTx(overrides = {}) {
  return {
    blockHeight: 10n,
    blockTimestamp: 1_792_980_999n,
    callData: null,
    error: null,
    json: { receiver: TESTNET_REGGIO_BRIDGE_ACCOUNT, sender: SENDER, value: 2_000_000_000 },
    memo: Buffer.from(RECIPIENT).toString("hex"),
    ...overrides,
  };
}

const node = (overrides = {}) => ({
  transaction: async () => null,
  ...overrides,
});

/** A deposit of 0.1 DUSK to RECIPIENT on DuskEVM, sent at `at` seconds. */
const depositTx = (at = 1_792_980_999) =>
  duskTx({
    blockTimestamp: BigInt(at),
    callData: {
      contractId: BRIDGE,
      data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
      fnName: "depositETHToWithValue",
    },
    json: { sender: SENDER },
  });

const FINALIZED = toEventSelector("ETHBridgeFinalized(address,address,uint256,bytes)");

/** DuskEVM's L2 bridge crediting RECIPIENT 0.1 DUSK from SENDER's DuskEVM address. */
const credit = (hash, block) => ({
  address: L2_BRIDGE,
  blockNumber: toHex(block),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 17n, "0x"]),
  topics: [FINALIZED, pad(evmAddressOf(SENDER).toLowerCase()), pad(RECIPIENT.toLowerCase())],
  transactionHash: hash,
});

// The DuskEVM adapter here can't map Dusk hashes: deposits are followed by the bridge event.
const NO_ADAPTER = {
  "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => {
    throw Object.assign(new Error("Method not found"), { code: -32601 });
  },
};

test("a migration is pending until Messina pays it out on Dusk", async () => {
  const input = encodeFunctionData({
    abi: parseAbi(["function migrate(uint256 amount, string targetAddress)"]),
    args: [3_000_000_000_000_000_000n, SENDER],
    functionName: "migrate",
  });
  let receipt = null;
  // Transfers with the migration's hash as the memo, as the archive's memo index lists them.
  const memos = {};
  const payout = (origin, data) => ({
    block_height: 4_000,
    events: [{ data: { memo: hex(EVM_HASH), receiver: SENDER, sender: PAYER, value: "3000000000", ...data }, reverted: false, target: TRANSFER_CONTRACT, topic: "moonlight" }],
    origin,
  });
  const tracking = createTracking({
    archive: archive({ memos, txs: { ["ef".repeat(32)]: { blockTimestamp: 1_792_990_000, err: null } } }),
    config: payingCfg,
    node: node(),
    rpc: fakeRpc({
      eth_getTransactionByHash: () => ({ input }),
      eth_getTransactionReceipt: () => receipt,
    }),
  });
  const entry = { hash: EVM_HASH, routeId: ROUTES.migration.id };

  const waiting = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.note, "Waiting for Sepolia.");
  // Rebuilt from the hash alone: the amount and recipient come from the call.
  assert.equal(waiting.amountLux, "3000000000");
  assert.equal(waiting.destination, SENDER);

  receipt = { blockNumber: toHex(100n), from: "0xd63b00000000000000000000000000000000df40", status: "0x1" };
  const mined = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(mined.status, "pending");
  assert.equal(mined.note, "Waiting for the payout on Dusk.");

  memos[EVM_HASH] = [payout("00".repeat(32), { receiver: TESTNET_REGGIO_BRIDGE_ACCOUNT }), payout("ef".repeat(32))];
  const paid = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(paid.status, "completed");
  assert.equal(paid.destinationHash, "ef".repeat(32));
  assert.equal(paid.destinationAt, 1_792_990_000_000);
  // What arrived, for its receipt.
  assert.equal(paid.receivedLux, "3000000000");

  // Found by its payout, with no sender yet: the migration's own transaction names it.
  const found = await tracking.refresh({ ...entry, amountLux: "3000000000", destination: SENDER }, ROUTES.migration);
  assert.deepEqual([found.status, found.sender], ["completed", receipt.from]);

  receipt = { blockNumber: toHex(100n), status: "0x0" };
  assert.equal((await tracking.refresh(entry, ROUTES.migration)).status, "failed");
});

test("a migration cancelled or replaced in the wallet after it was sent fails, with nothing moved", async () => {
  // Its hash was dropped: the chain has no receipt for it, and never will.
  const tracking = createTracking({ archive: archive(), config: payingCfg, node: node(), rpc: fakeRpc({ eth_getTransactionByHash: () => null, eth_getTransactionReceipt: () => null }) });
  const sent = { amountLux: "3000000000", destination: SENDER, hash: EVM_HASH, routeId: ROUTES.migration.id };
  assert.equal((await tracking.refresh(sent, ROUTES.migration)).status, "pending");
  for (const [replaced, note] of [["cancelled", "It was cancelled in the wallet, so nothing moved."], ["replaced", "The wallet sent another transaction in its place, so nothing moved."]]) {
    const ended = await tracking.refresh({ ...sent, replaced }, ROUTES.migration);
    assert.deepEqual([ended.status, ended.note, ended.sourceFailed], ["failed", note, true]);
  }
  // Its approval went through before the migration was cancelled: what that paid is kept as it ends.
  const SENDER_EVM = "0xd63b00000000000000000000000000000000df40";
  const APPROVAL = `0x${"a7".repeat(32)}`;
  const approval = { blockNumber: toHex(99n), effectiveGasPrice: toHex(1_000_000_016n), from: SENDER_EVM, gasUsed: toHex(46_182n), status: "0x1" };
  const paid = createTracking({ archive: archive(), config: payingCfg, node: node(), rpc: fakeRpc({ eth_getTransactionReceipt: ([hash]) => (hash === APPROVAL ? approval : null) }) });
  const cancelled = await paid.refresh({ ...sent, approvalHash: APPROVAL, replaced: "cancelled", sender: SENDER_EVM }, ROUTES.migration);
  assert.deepEqual([cancelled.status, cancelled.approvalFeeWei], ["failed", "46182000738912"]);
  // Only from the migration's own sender.
  assert.equal((await paid.refresh({ ...sent, approvalHash: APPROVAL, replaced: "cancelled", sender: "0x5602300000000000000000000000000000005602" }, ROUTES.migration)).approvalFeeWei, undefined);
});

test("a migration is paid out by its own route's payout account, also where that account pays out both chains", async () => {
  const input = encodeFunctionData({
    abi: parseAbi(["function migrate(uint256 amount, string targetAddress)"]),
    args: [3_000_000_000_000_000_000n, SENDER],
    functionName: "migrate",
  });
  // Mainnet, with one account paying out both chains' migrations, as VITE_MIGRATION_PAYOUT_ACCOUNT sets it.
  const shared = {
    ...payingCfg,
    network: { ...networks.mainnet, routes: { ...networks.mainnet.routes, migrations: networks.mainnet.routes.migrations.map((route) => ({ ...route, payoutAccount: PAYER })) } },
  };
  const memos = {
    [EVM_HASH]: [
      {
        block_height: 4_000,
        events: [{ data: { memo: hex(EVM_HASH), receiver: SENDER, sender: PAYER, value: "3000000000" }, reverted: false, target: TRANSFER_CONTRACT, topic: "moonlight" }],
        origin: "ef".repeat(32),
      },
    ],
  };
  const tracking = createTracking({
    archive: archive({ memos, txs: { ["ef".repeat(32)]: { blockTimestamp: 1_792_990_000, err: null } } }),
    config: shared,
    node: node(),
    rpc: fakeRpc({
      eth_getTransactionByHash: () => ({ input }),
      eth_getTransactionReceipt: () => ({ blockNumber: toHex(100n), status: "0x1" }),
    }),
  });

  const paid = await tracking.refresh({ hash: EVM_HASH, routeId: ROUTES.migration.id }, ROUTES.migration);
  assert.deepEqual([paid.status, paid.destinationHash], ["completed", "ef".repeat(32)]);
});

test("two equal deposits don't both arrive on one credit", async () => {
  const txs = { [DUSK_HASH]: depositTx(1_792_980_100), ["ef".repeat(32)]: depositTx(1_792_980_200) };
  const tracking = createTracking({
    archive: archive({
      history: { [SENDER]: [depositEntry(DUSK_HASH), depositEntry("ef".repeat(32))] },
      txs: { [DUSK_HASH]: depositDetails(1_792_980_100), ["ef".repeat(32)]: depositDetails(1_792_980_200) },
    }),
    config: cfg,
    fetch: fakeChain(() => [credit(evmTx("34"), 1_900n)]),
    node: node({ transaction: async (hash) => txs[hash] }),
    rpc: fakeRpc(NO_ADAPTER),
  });
  const first = { hash: DUSK_HASH, id: "first", routeId: ROUTES.deposit.id };
  const second = { hash: "ef".repeat(32), id: "second", routeId: ROUTES.deposit.id };

  const firstDone = await tracking.refresh(first, ROUTES.deposit);
  assert.equal(firstDone.destinationHash, evmTx("34"));
  const others = [{ ...first, ...firstDone }, second];
  assert.equal((await tracking.refresh(second, ROUTES.deposit, { others })).status, "pending");

  // A completion racing another check is refused if its credit was taken.
  assert.equal(takenByAnother(second, { destinationHash: evmTx("34").toUpperCase(), status: "completed" }, others), true);
  assert.equal(takenByAnother(second, { destinationHash: evmTx("35"), status: "completed" }, others), false);
});

test("an equal deposit sent just before keeps its credit, once the sender's history lists both", async () => {
  const txs = { [DUSK_HASH]: depositTx(1_792_980_100), ["ef".repeat(32)]: depositTx(1_792_980_200) };
  // The archive hasn't listed either deposit in the sender's history yet.
  const history = { [SENDER]: [] };
  const tracking = createTracking({
    archive: archive({ history }),
    config: cfg,
    fetch: fakeChain(() => [credit(evmTx("34"), 1_900n)]),
    node: node({ transaction: async (hash) => txs[hash] }),
    rpc: fakeRpc(NO_ADAPTER),
  });
  const kept = (hash, sourceAt) => ({ amountLux: "100000000", destination: RECIPIENT, hash, routeId: ROUTES.deposit.id, sender: SENDER, sourceAt, status: "pending" });
  const first = { ...kept(DUSK_HASH, 1_792_980_100_000), id: "first" };
  const second = { ...kept("ef".repeat(32), 1_792_980_200_000), id: "second" };

  // Neither is taken while the archive doesn't list them.
  assert.equal((await tracking.refresh(second, ROUTES.deposit, { others: [first, second] })).status, "pending");
  assert.equal((await tracking.refresh(first, ROUTES.deposit, { others: [first, second] })).status, "pending");

  // Listed: checked first, the later one waits; the one credit is the earlier one's.
  history[SENDER].push(depositEntry(DUSK_HASH), depositEntry("ef".repeat(32)));
  assert.equal((await tracking.refresh(second, ROUTES.deposit, { others: [first, second] })).status, "pending");
  // It takes it once the blocks before are read again, as the later one could have had it.
  let checked = first;
  for (let i = 0; i < 20 && checked.status !== "completed"; i += 1) checked = { ...checked, ...(await tracking.refresh(checked, ROUTES.deposit, { others: [checked, second] })) };
  assert.equal(checked.destinationHash, evmTx("34"));
});

test("a Dusk → BNB Smart Chain transfer completes when the bridge pays the memo address", async () => {
  const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
  const topics = [TRANSFER, pad(BSC_SERVICE.payoutAddress.toLowerCase()), pad(RECIPIENT.toLowerCase())];
  // The DUSK token's transfer from the route's payout address to the memo's.
  const payout = (hash, block, wei) => ({ address: BSC_TOKEN, blockNumber: toHex(block), data: toHex(wei, { size: 32 }), topics, transactionHash: hash });
  let logs = [];
  const chain = fakeChain((filter) => {
    assert.equal(filter.address, BSC_TOKEN.toLowerCase());
    assert.deepEqual(filter.topics, topics);
    return logs;
  });
  // 2 DUSK to the bridge account, naming RECIPIENT, as the archive has it.
  const sent = (memo) => ({
    blockHeight: 4_000,
    blockTimestamp: 1_792_980_999,
    err: null,
    tx: { json: JSON.stringify({ receiver: BSC_SERVICE.account, sender: SENDER, type: "moonlight", value: 2_000_000_000 }), memo: hex(memo) },
  });
  const txs = { [DUSK_HASH]: sent(RECIPIENT) };
  let tx = null;
  const tracking = createTracking({
    archive: archive({ history: { [BSC_SERVICE.account]: [transferEntry(DUSK_HASH, BSC_SERVICE.account)] }, txs }),
    config: bscCfg,
    fetch: chain,
    node: node({ transaction: async () => tx }),
    rpc: fakeRpc({}),
  });
  const entry = { hash: DUSK_HASH, routeId: ROUTES.service.id };

  assert.equal((await tracking.refresh(entry, ROUTES.service)).status, "pending");

  tx = duskTx({ json: { receiver: BSC_SERVICE.account, sender: SENDER, value: 2_000_000_000 } });
  const waiting = await tracking.refresh(entry, ROUTES.service);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.destination, RECIPIENT);
  assert.equal(waiting.amountLux, "2000000000");
  assert.ok(waiting.scan, "the next check starts where this one stopped");
  assert.ok(chain.calls.length && chain.calls.every(({ url }) => url === BSC_RPC));

  // 2 DUSK minus the 1 DUSK fee, in 18 decimals.
  logs = [payout(evmTx("01"), 1_500n, 2n * 10n ** 18n), payout(evmTx("02"), 1_600n, 10n ** 18n)];
  const paid = await tracking.refresh(entry, ROUTES.service);
  assert.equal(paid.status, "completed");
  assert.equal(paid.destinationHash, evmTx("02"));

  // The bridge reads the memo exactly: an address with a space before it pays nothing out.
  txs[DUSK_HASH] = sent(` ${RECIPIENT}`);
  tx = duskTx({ json: { receiver: BSC_SERVICE.account, sender: SENDER, value: 2_000_000_000 }, memo: hex(` ${RECIPIENT}`) });
  const spaced = await tracking.refresh(entry, ROUTES.service);
  assert.deepEqual([spaced.status, spaced.note], ["failed", "The memo isn't an EVM address, so the bridge can't pay it out."]);
  // The DUSK moved, and nothing comes of it: said as what was received.
  assert.equal(spaced.receivedLux, "0");
  tx = duskTx({ json: { receiver: BSC_SERVICE.account, value: 1_000_000_000 } });
  const underFee = await tracking.refresh(entry, ROUTES.service);
  assert.match(underFee.note, /didn't exceed the bridge fee/u);
  assert.equal(underFee.receivedLux, "0");
  tx = duskTx({ error: "Panic" });
  assert.equal((await tracking.refresh(entry, ROUTES.service)).status, "failed");
});

test("a transfer waiting for its payout asks Dusk for its transaction until its block is final, then no more", async () => {
  // 2 DUSK to the bridge account in block 4,000, naming RECIPIENT, as Rusk's GraphQL gives it.
  const sent = {
    blockHeight: 4_000,
    blockTimestamp: 1_792_980_999,
    err: null,
    gasSpent: 1_000,
    id: DUSK_HASH,
    tx: { json: JSON.stringify({ fee: { gas_price: "1" }, receiver: BSC_SERVICE.account, sender: SENDER, type: "moonlight", value: 2_000_000_000 }), memo: hex(RECIPIENT) },
  };
  let included = null;
  let finalized = 3_999;
  let asked = 0;
  // Dusk's node: the transaction once it's in a block, and the last finalized block when asked.
  const rusk = async (url, { body }) => {
    const data = {};
    for (const [, alias, hash] of String(body).matchAll(/(\w+): tx\(hash: "(\w+)"\)/gu)) {
      asked += hash === DUSK_HASH ? 1 : 0;
      data[alias] = hash === DUSK_HASH ? included : null;
    }
    if (String(body).includes("lastBlockPair")) data.pair = { json: { last_block: [finalized + 2, "aa".repeat(32)], last_finalized_block: [finalized, "bb".repeat(32)] } };
    return new Response(JSON.stringify(data));
  };
  const tracking = createTracking({
    archive: archive({ history: { [BSC_SERVICE.account]: [transferEntry(DUSK_HASH, BSC_SERVICE.account)] }, txs: { [DUSK_HASH]: sent } }),
    config: bscCfg,
    fetch: fakeChain(() => []),
    node: createDuskNode({ fetch: rusk, url: "https://node.test" }),
    rpc: fakeRpc({}),
  });
  let entry = { hash: DUSK_HASH, routeId: ROUTES.service.id };
  // What My transfers shows of it.
  const shown = ({ amountLux, destination, feeLux, note, sender, sourceAt, status }) => ({ amountLux, destination, feeLux, note, sender, sourceAt, status });
  const check = async () => {
    entry = { ...entry, ...(await tracking.refresh(entry, ROUTES.service)) };
    return shown(entry);
  };

  // Not in a block yet: asked again on the next check.
  assert.deepEqual([(await check()).note, asked], ["Waiting for Dusk.", 1]);
  included = sent;

  const waiting = await check();
  assert.deepEqual(waiting, {
    amountLux: "2000000000",
    destination: RECIPIENT,
    feeLux: "1000",
    note: "Waiting for the payout on BNB Smart Chain.",
    sender: SENDER,
    sourceAt: 1_792_980_999_000,
    status: "pending",
  });
  // Its block isn't final yet: the next check asks again.
  assert.deepEqual(await check(), waiting);
  assert.equal(asked, 3);

  finalized = 4_001;
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await check(), waiting);
  assert.equal(asked, 4);
});

test("a deposit waiting for its credit asks for an equal one's call before it until that one's block is final, then no more", async () => {
  // The sender's history: an equal deposit sent from another device in block 8, then this one in block 10.
  const earlier = "ef".repeat(32);
  let finalized = 7;
  let asked = 0;
  const listed = archive({
    history: { [SENDER]: [depositEntry(earlier, 8), depositEntry(DUSK_HASH, 10)] },
    txs: { [earlier]: { ...depositDetails(1_792_980_100), blockHeight: 8 } },
  });
  const tracking = createTracking({
    // The archive, with the last finalized block when asked.
    archive: {
      query: async (text) => {
        asked += [...text.matchAll(/tx\(hash: "(\w+)"\)/gu)].filter(([, hash]) => hash === earlier).length;
        const data = await listed.query(text);
        if (text.includes("lastBlockPair")) data.pair = { json: { last_block: [finalized + 2, "aa".repeat(32)], last_finalized_block: [finalized, "bb".repeat(32)] } };
        return data;
      },
    },
    config: cfg,
    // DuskEVM hasn't credited either yet.
    fetch: fakeChain(() => []),
    node: node({ transaction: async () => depositTx(1_792_980_200) }),
    rpc: fakeRpc(NO_ADAPTER),
  });
  let entry = { hash: DUSK_HASH, routeId: ROUTES.deposit.id };
  // What My transfers shows of it.
  const shown = ({ amountLux, destination, note, sender, sourceAt, status }) => ({ amountLux, destination, note, sender, sourceAt, status });
  const check = async () => {
    entry = { ...entry, ...(await tracking.refresh(entry, ROUTES.deposit)) };
    return shown(entry);
  };

  const waiting = await check();
  assert.deepEqual(waiting, {
    amountLux: "100000000",
    destination: RECIPIENT,
    note: "Waiting for DuskEVM.",
    sender: SENDER,
    sourceAt: 1_792_980_200_000,
    status: "pending",
  });
  // The earlier one's block isn't final yet: the next check asks again.
  assert.deepEqual(await check(), waiting);
  assert.equal(asked, 2);

  finalized = 11;
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await check(), waiting);
  assert.equal(asked, 3);
});

test("a deposit followed without its sender's history says why its credit can't be told: none came in time, or another could be its", async () => {
  // The sender's history can't be read: a credit counts only within 2 minutes of the deposit, in block 999.
  const unread = { query: async () => Promise.reject(new Error("unreachable")) };
  const noteWith = async (credits) => {
    const tracking = createTracking({ archive: unread, config: cfg, fetch: fakeChain(() => credits), node: node({ transaction: async () => depositTx() }), rpc: fakeRpc(NO_ADAPTER) });
    return (await tracking.refresh({ hash: DUSK_HASH, routeId: ROUTES.deposit.id }, ROUTES.deposit)).note;
  };

  // None within them, and one 15 minutes on.
  assert.equal(
    await noteWith([credit(evmTx("34"), 1_900n)]),
    "No credit came within 2 minutes of this deposit, and a later one can't be told apart from another transfer's. Check the address on the DuskEVM explorer.",
  );
  // Two within them: either could be another transfer's.
  assert.equal(
    await noteWith([credit(evmTx("34"), 1_020n), credit(evmTx("35"), 1_040n)]),
    "An equal deposit to the same address was sent just before this one, so its credit can't be told apart. Check the address on the DuskEVM explorer.",
  );
});

test("an equal transfer out sent just before keeps its payout, once the bridge account's history lists both", async () => {
  const payout = {
    address: BSC_TOKEN,
    blockNumber: toHex(1_600n),
    data: toHex(10n ** 18n, { size: 32 }),
    topics: [toEventSelector("Transfer(address,address,uint256)"), pad(BSC_SERVICE.payoutAddress.toLowerCase()), pad(RECIPIENT.toLowerCase())],
    transactionHash: evmTx("02"),
  };
  // 2 DUSK each to the bridge account, naming RECIPIENT, as the archive has them.
  const sent = (seconds) => ({
    blockHeight: 4_000,
    blockTimestamp: seconds,
    err: null,
    tx: { json: JSON.stringify({ receiver: BSC_SERVICE.account, sender: SENDER, type: "moonlight", value: 2_000_000_000 }), memo: hex(RECIPIENT) },
  });
  const later = "ef".repeat(32);
  const txs = { [DUSK_HASH]: sent(1_792_980_100), [later]: sent(1_792_980_200) };
  // The archive hasn't listed either transfer in the bridge account's history yet.
  const history = { [BSC_SERVICE.account]: [] };
  const tracking = createTracking({
    archive: archive({ history, txs }),
    config: bscCfg,
    fetch: fakeChain(() => [payout]),
    node: node({ transaction: async (hash) => duskTx({ blockTimestamp: BigInt(txs[hash].blockTimestamp), json: { receiver: BSC_SERVICE.account, sender: SENDER, value: 2_000_000_000 } }) }),
    rpc: fakeRpc({}),
  });
  const kept = (hash, sourceAt) => ({ amountLux: "2000000000", destination: RECIPIENT, hash, routeId: ROUTES.service.id, sender: SENDER, sourceAt, status: "pending" });
  const first = { ...kept(DUSK_HASH, 1_792_980_100_000), id: "first" };
  const second = { ...kept(later, 1_792_980_200_000), id: "second" };

  // Neither is taken while the archive doesn't list them.
  assert.equal((await tracking.refresh(second, ROUTES.service, { others: [first, second] })).status, "pending");
  assert.equal((await tracking.refresh(first, ROUTES.service, { others: [first, second] })).status, "pending");

  // Listed: checked first, the later one waits; the one payout is the earlier one's.
  history[BSC_SERVICE.account].push(transferEntry(DUSK_HASH, BSC_SERVICE.account), transferEntry(later, BSC_SERVICE.account));
  assert.equal((await tracking.refresh(second, ROUTES.service, { others: [first, second] })).status, "pending");
  // It takes it once the blocks before are read again, as the later one could have had it.
  let checked = first;
  for (let i = 0; i < 20 && checked.status !== "completed"; i += 1) checked = { ...checked, ...(await tracking.refresh(checked, ROUTES.service, { others: [checked, second] })) };
  assert.equal(checked.destinationHash, evmTx("02"));
});

test("a deposit is followed to its DuskEVM credit through the bridge event when the adapter can't map hashes", async () => {
  let credited = false;
  const chain = fakeChain((filter) => {
    assert.equal(filter.address, L2_BRIDGE);
    assert.deepEqual(filter.topics, [FINALIZED, pad(evmAddressOf(SENDER).toLowerCase()), pad(RECIPIENT.toLowerCase())]);
    return credited ? [credit(evmTx("34"), 1_900n)] : [];
  });
  const rpc = fakeRpc(NO_ADAPTER);
  // Looked at a year after it was sent, as a deposit found in the account's history can be.
  const now = () => (1_792_980_999 + 365 * 86_400) * 1_000;
  const listed = archive({ history: { [SENDER]: [depositEntry(DUSK_HASH)] } });
  const tracking = createTracking({ archive: listed, config: cfg, fetch: chain, node: node({ transaction: async () => depositTx() }), now, rpc });
  const entry = { hash: DUSK_HASH, routeId: ROUTES.deposit.id };

  const waiting = await tracking.refresh(entry, ROUTES.deposit);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.destination, RECIPIENT);
  assert.equal(waiting.amountLux, "100000000");

  credited = true;
  const done = await tracking.refresh(entry, ROUTES.deposit);
  assert.equal(done.status, "completed");
  assert.equal(done.destinationHash, evmTx("34"));
  assert.equal(done.destinationAt, (1_792_980_000 + 1_900) * 1_000);
  // On DuskEVM's RPC. The adapter is asked once; after that only the event is watched.
  assert.ok(chain.calls.every(({ url }) => url === DUSKEVM_RPC));
  assert.equal(rpc.calls.filter(({ method }) => method === "duskevm_getTransactionHashByDuskHash").length, 1);

  // An RPC that can't answer: the check fails, as any read does.
  const down = createTracking({ archive: listed, config: cfg, fetch: async () => new Response("busy", { status: 503 }), node: node({ transaction: async () => depositTx() }), rpc });
  await assert.rejects(down.refresh(entry, ROUTES.deposit), /HTTP 503/u);
});

test("a deposit waits while the adapter hasn't seen it, and fails with its Dusk transaction", async () => {
  const call = {
    contractId: BRIDGE,
    data: Buffer.from(encodeDepositArgs({ amountLux: 1n, minGasLimit: 1, to: RECIPIENT })).toString("hex"),
    fnName: "depositETHToWithValue",
  };
  let tx = duskTx({ callData: call });
  const rpc = fakeRpc({ "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => null });
  const tracking = createTracking({ config: cfg, node: node({ transaction: async () => tx }), rpc });
  const entry = { hash: DUSK_HASH, routeId: ROUTES.deposit.id };

  assert.equal((await tracking.refresh(entry, ROUTES.deposit)).status, "pending");
  // This adapter maps Dusk hashes: it's asked again on the next check.
  assert.equal((await tracking.refresh(entry, ROUTES.deposit)).status, "pending");
  assert.equal(rpc.calls.filter(({ method }) => method === "duskevm_getTransactionHashByDuskHash").length, 2);

  tx = duskTx({ callData: call, error: "Panic: out of gas" });
  assert.equal((await tracking.refresh(entry, ROUTES.deposit)).status, "failed");

  tx = duskTx({ callData: { ...call, contractId: "99".repeat(32) } });
  assert.match((await tracking.refresh(entry, ROUTES.deposit)).note, /isn't a DuskEVM deposit/u);
});

test("a withdrawal's check keeps whose proof its stage is: the account it was read for", async () => {
  // Read for the withdrawal's recipient, with no wallet connected: its proof, not the user's.
  const recipient = `0x${"3d".repeat(20)}`;
  const tracking = createTracking({
    config: cfg,
    node: node(),
    now: () => 1_793_100_000_000,
    rpc: fakeRpc({}),
    withdrawals: {
      status: async () => ({ blockNumber: 50n, facts: { amountWei: 10n ** 17n }, proofSubmitter: recipient, stage: "ready_to_finalize", withdrawal: { gasLimit: 519_542n } }),
    },
  });
  const checked = await tracking.refresh({ hash: EVM_HASH, routeId: ROUTES.withdrawal.id }, ROUTES.withdrawal);
  assert.deepEqual([checked.stage, checked.stageSubmitter], ["ready_to_finalize", recipient]);
});

test("a withdrawal follows its stages, and a sent proof waits for Dusk", async () => {
  // What it pays and to whom, and who sent it: the package's facts.
  const facts = { amountWei: 10n ** 17n, from: RECIPIENT, recipient: { account: SENDER, kind: "account" } };
  let status = { blockNumber: 50n, facts, stage: "ready_to_prove", withdrawal: { gasLimit: 519_542n } };
  let error = null;
  const asked = [];
  const withdrawals = {
    status: async (_hash, options) => {
      asked.push(options.submitter);
      if (error) throw error;
      return status;
    },
  };
  let proofTx = null;
  const tracking = createTracking({
    config: cfg,
    node: node({ transaction: async () => proofTx }),
    now: () => 1_793_100_000_000,
    rpc: fakeRpc({}),
    withdrawals,
  });
  const entry = { hash: EVM_HASH, routeId: ROUTES.withdrawal.id };

  const ready = await tracking.refresh(entry, ROUTES.withdrawal);
  assert.equal(ready.status, "pending");
  assert.equal(ready.stage, "ready_to_prove");
  assert.deepEqual([ready.amountLux, ready.destination, ready.sender], ["100000000", SENDER, RECIPIENT]);
  status = { ...status, facts: { ...facts, recipient: { contractId: BRIDGE, kind: "contract" } } };
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).destination, BRIDGE);
  status = { ...status, facts };
  assert.equal(ready.sourceAt, (1_792_980_000 + 50) * 1_000);
  // The withdrawal's own gas, which claiming adds to its limit.
  assert.equal(ready.withdrawalGas, "519542");

  const proving = { ...entry, pendingAction: "prove", pendingHash: "aa".repeat(32) };
  assert.equal((await tracking.refresh(proving, ROUTES.withdrawal)).stage, "prove_submitted");

  proofTx = duskTx({ error: "Panic: invalid proof" });
  const rejected = await tracking.refresh(proving, ROUTES.withdrawal);
  assert.match(rejected.actionError, /^Proof transaction failed/u);
  assert.equal(rejected.pendingAction, null);

  // The proof is in, but the Portal read before it doesn't show it yet: the
  // proof stays pending, so Prove isn't offered again meanwhile.
  proofTx = duskTx({ blockTimestamp: 1_793_000_000n });
  const included = await tracking.refresh(proving, ROUTES.withdrawal);
  assert.deepEqual([included.stage, included.pendingAction, included.proveHash], ["prove_submitted", undefined, "aa".repeat(32)]);

  // A prover is known only once a proof or claim was sent from here.
  asked.length = 0;
  const prover = `0x${"0a".repeat(20)}`;
  await tracking.refresh({ ...entry, proofSubmitter: prover }, ROUTES.withdrawal);
  await tracking.refresh({ ...entry, proofSubmitter: prover, proveHash: "bb".repeat(32) }, ROUTES.withdrawal);
  assert.deepEqual(asked, [null, prover]);

  proofTx = duskTx({ blockTimestamp: 1_793_000_000n });
  status = { ...status, provenAt: 1_793_000_000n, readyAt: 1_793_604_800n, stage: "proven_waiting" };
  const proven = await tracking.refresh(proving, ROUTES.withdrawal);
  assert.equal(proven.proveHash, "aa".repeat(32));
  assert.equal(proven.provenAt, 1_793_000_000_000);
  assert.equal(proven.readyAt, 1_793_604_800);

  // A late game's resolution, and the proof's game, which the next check reads with the Portal's values.
  status = { ...status, claimOverdue: true, disputeGameProxy: `0x${"6f".repeat(20)}` };
  const late = await tracking.refresh(entry, ROUTES.withdrawal);
  assert.deepEqual([late.claimOverdue, late.proofGame], [true, `0x${"6f".repeat(20)}`]);
  // A check that couldn't read the proof's game says no date: the one known so far stands.
  const dated = await tracking.refresh(entry, ROUTES.withdrawal);
  const { readyAt: _readyAt, readyAtExact: _exact, claimOverdue: _late, ...undated } = status;
  status = undated;
  const kept = await tracking.refresh({ ...entry, claimOverdue: true, readyAt: dated.readyAt, readyAtExact: true }, ROUTES.withdrawal);
  assert.deepEqual([kept.readyAt, kept.readyAtExact, kept.claimOverdue], [dated.readyAt, true, true]);
  status = { ...status, claimOverdue: true, readyAt: 1_793_604_800n };
  const games = [];
  const load = withdrawals.status;
  withdrawals.status = async (hash, options) => {
    games.push(options.proofGame);
    return load(hash, options);
  };
  await tracking.refresh({ ...entry, proofGame: late.proofGame }, ROUTES.withdrawal);
  withdrawals.status = load;
  assert.deepEqual(games, [`0x${"6f".repeat(20)}`]);

  status = { ...status, stage: "finalized" };
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).status, "completed");

  error = new WithdrawalError("not-found");
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).status, "pending");
  // Reverted on DuskEVM: it ends there, and nothing left the account.
  error = new WithdrawalError("failed");
  const reverted = await tracking.refresh(entry, ROUTES.withdrawal);
  assert.deepEqual([reverted.status, reverted.sourceFailed], ["failed", true]);
  // Another message to Dusk isn't a withdrawal of DUSK: it ends here.
  error = new WithdrawalError("not-a-withdrawal");
  const other = await tracking.refresh(entry, ROUTES.withdrawal);
  assert.deepEqual([other.status, other.note, other.sourceFailed], ["failed", NOT_A_DUSK_WITHDRAWAL, undefined]);
  // A read that failed is no answer: the next check asks again.
  error = new Error("not-found");
  await assert.rejects(tracking.refresh(entry, ROUTES.withdrawal), { message: "not-found" });
});

test("the scheduler checks an entry until it ends", async () => {
  const seen = [];
  let resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });
  const scheduler = createScheduler({
    check: async (id) => {
      seen.push(id);
      const status = seen.length < 3 ? "pending" : "completed";
      if (status === "completed") resolve();
      return { id, status };
    },
    intervals: { active: 1, hidden: 1 },
  });

  scheduler.track("a");
  await finished;
  await new Promise((r) => setTimeout(r, 20));
  scheduler.stop();
  assert.deepEqual(seen, ["a", "a", "a"]);
});

test("a transfer looked out for now is checked every 5 seconds, any other every 15", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const checks = { due: 0, other: 0 };
  const scheduler = createScheduler({
    check: async (id) => {
      checks[id] += 1;
      return { id, status: "pending" };
    },
    // As a receipt on screen waits for its transfer, around when it usually arrives.
    due: (entry) => entry.id === "due",
  });
  // Each check's answer, and the next check it sets, before time moves on.
  const answered = () => new Promise((resolve) => setImmediate(resolve));
  scheduler.track("due");
  scheduler.track("other");
  t.mock.timers.tick(0);
  await answered();
  assert.deepEqual(checks, { due: 1, other: 1 });
  // Fifteen seconds on, 5 at a time.
  for (let step = 0; step < 3; step += 1) {
    t.mock.timers.tick(5_000);
    await answered();
  }
  assert.deepEqual(checks, { due: 4, other: 2 });
  scheduler.stop();
});

test("tracking an entry again while it's being checked keeps one loop", async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const calls = [];
  const answers = [];
  const scheduler = createScheduler({
    check: (id) =>
      new Promise((resolve) => {
        calls.push(id);
        answers.push(resolve);
      }),
    intervals: { action: 1, active: 1, hidden: 1 },
  });
  scheduler.track("a");
  await wait(5);
  // Tracked again mid-check, as a reopened receipt or a new account does.
  scheduler.track("a");
  scheduler.track("a");
  await wait(5);
  assert.equal(calls.length, 1);
  answers.shift()({ id: "a", status: "pending" });
  await wait(5);
  assert.equal(calls.length, 2);
  answers.shift()({ id: "a", status: "completed" });
  await wait(10);
  assert.equal(calls.length, 2);
  scheduler.stop();
});

test("a credit from before the deposit was sent here isn't taken as its credit", async () => {
  // Sent here: the DuskEVM head read before sending (block 1,700) bounds the search.
  const chain = fakeChain(() => [credit(evmTx("01"), 1_500n), credit(evmTx("02"), 1_800n)]);
  const tracking = createTracking({
    archive: archive({ history: { [SENDER]: [depositEntry(DUSK_HASH)] } }),
    config: cfg,
    fetch: chain,
    node: node({ transaction: async () => depositTx() }),
    rpc: fakeRpc(NO_ADAPTER),
  });
  const entry = { hash: DUSK_HASH, id: "sent", routeId: ROUTES.deposit.id, scanFrom: "1700" };
  assert.equal((await tracking.refresh(entry, ROUTES.deposit, { others: [entry] })).destinationHash, evmTx("02"));
});

test("a failed deposit whose call data doesn't read as a deposit ends as failed", async () => {
  const depositTx = duskTx({
    callData: { contractId: BRIDGE, data: "ab", fnName: "depositETHToWithValue" },
    error: "Panic: invalid arguments",
    json: { sender: SENDER },
  });
  const tracking = createTracking({ config: cfg, node: node({ transaction: async () => depositTx }), rpc: fakeRpc({}) });
  const result = await tracking.refresh({ hash: DUSK_HASH, routeId: ROUTES.deposit.id }, ROUTES.deposit);
  assert.deepEqual([result.status, result.note], ["failed", "The Dusk transaction failed, so the deposit didn't enter the bridge."]);
});

test("a sent proof the Portal took and then rejected leaves the withdrawal ready to prove again", async () => {
  const included = 1_793_000_000n;
  let status = { blockNumber: 50n, facts: { amountWei: 10n ** 17n }, provenAt: included, stage: "ready_to_prove", withdrawal: { gasLimit: 519_542n } };
  const tracking = createTracking({
    config: cfg,
    node: node({ transaction: async () => duskTx({ blockTimestamp: included }) }),
    now: () => 1_793_100_000_000,
    rpc: fakeRpc({}),
    withdrawals: { status: async () => status },
  });
  const proving = { hash: EVM_HASH, pendingAction: "prove", pendingHash: "aa".repeat(32), routeId: ROUTES.withdrawal.id };
  const settled = await tracking.refresh(proving, ROUTES.withdrawal);
  assert.deepEqual([settled.stage, settled.pendingAction, settled.proveHash], ["ready_to_prove", null, "aa".repeat(32)]);
  // An older proof the Portal still shows, from before this one, keeps it pending.
  status = { ...status, provenAt: included - 3_600n };
  assert.equal((await tracking.refresh(proving, ROUTES.withdrawal)).stage, "prove_submitted");
});

test("the scheduler keeps checking an entry that ended where the page still looks for something of it", { timeout: 2_000 }, async () => {
  const seen = [];
  let resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });
  // Ended on the first check, without the transaction it's given on the third.
  const scheduler = createScheduler({
    check: async (id) => {
      seen.push(id);
      if (seen.length === 3) resolve();
      return { id, linked: seen.length >= 3, status: "completed" };
    },
    intervals: { active: 1, hidden: 1 },
    more: (entry) => !entry.linked,
  });
  scheduler.track("a");
  await finished;
  await new Promise((r) => setTimeout(r, 20));
  scheduler.stop();
  assert.deepEqual(seen, ["a", "a", "a"]);
});
