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

import { networks } from "@dusk-network/networks";
import { encodeDepositArgs, evmAddressOf } from "@dusk-network/networks/duskevm";

// Two accounts the networks' files name: the BSC and the Sepolia bridge accounts.
const MAINNET_BSC_BRIDGE_ACCOUNT = networks.mainnet.routes.services[0].account;
const TESTNET_REGGIO_BRIDGE_ACCOUNT = networks.testnet.routes.services[0].account;
import { createScheduler, createTracking, orderAmongAlike, takenByAnother } from "./tracking.js";
import { NOT_A_DUSK_WITHDRAWAL } from "./withdrawals.js";

const SENDER = MAINNET_BSC_BRIDGE_ACCOUNT; // any valid Dusk account works here
const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
const DUSK_HASH = "ab".repeat(32);
const EVM_HASH = `0x${"cd".repeat(32)}`;

// Testnet's DuskEVM bridge on Dusk, which deposits go to.
const BRIDGE = networks.testnet.duskEvm.contracts.l1_standard_bridge.contractId;

const cfg = {
  profile: "testnet",
  dusk: {},
  duskEvm: {
    l1StandardBridgeContractId: BRIDGE,
    predeploys: { l2StandardBridge: "0x4200000000000000000000000000000000000010" },
    name: "DuskEVM Testnet",
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

const ROUTES = {
  deposit: { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-dusk-evm", mode: "duskevm-deposit", to: { id: "dusk-evm", kind: "evm" } },
  migration: { from: { id: "ethereum", kind: "evm" }, id: "ethereum-to-dusk", mode: "migration", to: { id: "dusk", kind: "dusk" } },
  service: { from: { id: "dusk", kind: "dusk" }, id: "dusk-to-ethereum", mode: "service-transfer", to: { id: "ethereum", kind: "evm" } },
  withdrawal: { from: { id: "dusk-evm", kind: "evm" }, id: "dusk-evm-to-dusk", mode: "duskevm-withdrawal", to: { id: "dusk", kind: "dusk" } },
};

/** JSON-RPC by network and method; blocks are numbered by their time. */
function fakeRpc(handlers) {
  const calls = [];
  const rpc = async (network, method, params) => {
    calls.push({ method, network, params });
    const handler = handlers[`${network}:${method}`] ?? handlers[method];
    if (handler) return handler(params);
    if (method === "eth_blockNumber") return toHex(2_000n);
    if (method === "eth_getBlockByNumber")
      return { timestamp: toHex(1_792_980_000n + BigInt(params[0])) };
    throw Object.assign(new Error(`unexpected ${network}:${method}`), { code: -32000 });
  };
  rpc.calls = calls;
  return rpc;
}

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
  transfersByMemo: async () => [],
  ...overrides,
});

/** The archive, answering `list` as the sender's history for any range, 50 a page; `queries` hears each request. */
const archive = (list = [], queries = []) => ({
  query: async (text) => {
    queries.push(text);
    const page = Number(/pageCount: (\d+)/u.exec(text)?.[1] ?? 1);
    return { out: { json: list.slice((page - 1) * 50, page * 50) } };
  },
});

test("a migration is pending until Messina pays it out on Dusk", async () => {
  const input = encodeFunctionData({
    abi: parseAbi(["function migrate(uint256 amount, string targetAddress)"]),
    args: [3_000_000_000_000_000_000n, SENDER],
    functionName: "migrate",
  });
  let receipt = null;
  let payouts = [];
  const tracking = createTracking({
    config: cfg,
    node: node({
      transaction: async () => duskTx({ blockTimestamp: 1_792_990_000n }),
      transfersByMemo: async (memo) => {
        assert.equal(memo, EVM_HASH);
        return payouts;
      },
    }),
    rpc: fakeRpc({
      eth_getTransactionByHash: () => ({ input }),
      eth_getTransactionReceipt: () => receipt,
    }),
  });
  const entry = { hash: EVM_HASH, routeId: ROUTES.migration.id };

  const waiting = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.note, "Waiting for Ethereum (Sepolia).");
  // Rebuilt from the hash alone: the amount and recipient come from the call.
  assert.equal(waiting.amountLux, "3000000000");
  assert.equal(waiting.destination, SENDER);

  receipt = { blockNumber: toHex(100n), status: "0x1" };
  const mined = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(mined.status, "pending");
  assert.equal(mined.note, "Waiting for the payout on Dusk.");

  payouts = [
    { events: [{ data: { receiver: "someone else", value: "3000000000" }, reverted: false, topic: "moonlight" }], origin: "00".repeat(32) },
    { events: [{ data: { receiver: SENDER, value: "3000000000" }, reverted: false, topic: "moonlight" }], origin: "ef".repeat(32) },
  ];
  const paid = await tracking.refresh(entry, ROUTES.migration);
  assert.equal(paid.status, "completed");
  assert.equal(paid.destinationHash, "ef".repeat(32));
  assert.equal(paid.destinationAt, 1_792_990_000_000);

  receipt = { blockNumber: toHex(100n), status: "0x0" };
  assert.equal((await tracking.refresh(entry, ROUTES.migration)).status, "failed");
});

test("only the migrated amount counts as a payout, and only from the payout account when it's known", async () => {
  const input = encodeFunctionData({
    abi: parseAbi(["function migrate(uint256 amount, string targetAddress)"]),
    args: [3_000_000_000_000_000_000n, SENDER],
    functionName: "migrate",
  });
  const PAYER = TESTNET_REGGIO_BRIDGE_ACCOUNT; // any other valid account
  const payout = (origin, data) => ({ events: [{ data: { receiver: SENDER, ...data }, reverted: false, topic: "moonlight" }], origin });
  let payouts = [];
  const tracking = (config) =>
    createTracking({
      config,
      node: node({ transaction: async () => duskTx(), transfersByMemo: async () => payouts }),
      rpc: fakeRpc({
        eth_getTransactionByHash: () => ({ input }),
        eth_getTransactionReceipt: () => ({ blockNumber: toHex(100n), status: "0x1" }),
      }),
    });
  const entry = { hash: EVM_HASH, routeId: ROUTES.migration.id };

  // Anyone can send the recipient a transfer with the migration's hash as memo.
  payouts = [payout("01".repeat(32), { sender: SENDER, value: "1" })];
  assert.equal((await tracking(cfg).refresh(entry, ROUTES.migration)).status, "pending");

  payouts.push(payout("02".repeat(32), { sender: SENDER, value: "3000000000" }));
  const paid = await tracking(cfg).refresh(entry, ROUTES.migration);
  assert.equal(paid.status, "completed");
  assert.equal(paid.destinationHash, "02".repeat(32));

  // With the chain's payout account known, the same amount from anyone else doesn't count.
  const known = { ...cfg, evmNetworks: { ethereum: { ...cfg.evmNetworks.ethereum, payoutAccount: PAYER } } };
  assert.equal((await tracking(known).refresh(entry, ROUTES.migration)).status, "pending");
  payouts.push(payout("03".repeat(32), { sender: PAYER, value: "3000000000" }));
  assert.equal((await tracking(known).refresh(entry, ROUTES.migration)).destinationHash, "03".repeat(32));
});

test("equal transfers to one address take one payout each, in the order they were sent", async () => {
  let logs = [];
  // Like a node: only the logs inside the asked range.
  const rpc = fakeRpc({
    eth_getLogs: ([filter]) =>
      logs.filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock)),
  });
  const sent = (hash, at) => duskTx({ blockTimestamp: BigInt(at) });
  const txs = { [DUSK_HASH]: sent(DUSK_HASH, 1_792_980_100), ["ef".repeat(32)]: sent("ef".repeat(32), 1_792_980_200) };
  const tracking = createTracking({ config: cfg, node: node({ transaction: async (hash) => txs[hash] }), rpc });
  const payoutLog = (hash, block) => ({ blockNumber: toHex(block), data: toHex(10n ** 18n, { size: 32 }), transactionHash: hash });
  const first = { amountLux: "2000000000", destination: RECIPIENT, hash: DUSK_HASH, id: "first", routeId: ROUTES.service.id, sourceAt: 1_792_980_100_000, status: "pending" };
  const second = { amountLux: "2000000000", destination: RECIPIENT, hash: "ef".repeat(32), id: "second", routeId: ROUTES.service.id, sourceAt: 1_792_980_200_000, status: "pending" };

  // One payout so far: it's the first transfer's, whichever is checked first.
  logs = [payoutLog("0x0a", 1_500n)];
  assert.equal((await tracking.refresh(second, ROUTES.service, { others: [first, second] })).status, "pending");
  const firstPaid = await tracking.refresh(first, ROUTES.service, { others: [first, second] });
  assert.equal(firstPaid.destinationHash, "0x0a");
  const settled = { ...first, ...firstPaid };

  // The payout the first one took isn't the second one's.
  assert.equal((await tracking.refresh(second, ROUTES.service, { others: [settled, second] })).status, "pending");
  logs = [payoutLog("0x0a", 1_500n), payoutLog("0x0b", 1_600n)];
  assert.equal((await tracking.refresh(second, ROUTES.service, { others: [settled, second] })).destinationHash, "0x0b");

  // A completion racing another check is refused if its payout was taken.
  assert.equal(takenByAnother(second, { destinationHash: "0x0A", status: "completed" }, [settled]), true);
  assert.equal(takenByAnother(second, { destinationHash: "0x0b", status: "completed" }, [settled]), false);
});

test("two equal deposits don't both arrive on one credit", async () => {
  const deposit = (at) =>
    duskTx({
      blockTimestamp: BigInt(at),
      callData: {
        contractId: BRIDGE,
        data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
        fnName: "depositETHToWithValue",
      },
      json: { sender: SENDER },
    });
  const txs = { [DUSK_HASH]: deposit(1_792_980_100), ["ef".repeat(32)]: deposit(1_792_980_200) };
  const credit = (hash) => ({
    blockNumber: toHex(1_900n),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 17n, "0x"]),
    topics: [toEventSelector("ETHBridgeFinalized(address,address,uint256,bytes)"), pad(evmAddressOf(SENDER).toLowerCase()), pad(RECIPIENT.toLowerCase())],
    transactionHash: hash,
  });
  const rpc = fakeRpc({
    "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    "dusk-evm:eth_getLogs": () => [credit("0x34")],
  });
  const tracking = createTracking({ archive: archive(), config: cfg, node: node({ transaction: async (hash) => txs[hash] }), rpc });
  const first = { hash: DUSK_HASH, id: "first", routeId: ROUTES.deposit.id };
  const second = { hash: "ef".repeat(32), id: "second", routeId: ROUTES.deposit.id };

  const firstDone = await tracking.refresh(first, ROUTES.deposit);
  assert.equal(firstDone.destinationHash, "0x34");
  const others = [{ ...first, ...firstDone }, second];
  assert.equal((await tracking.refresh(second, ROUTES.deposit, { others })).status, "pending");
});

test("equal transfers count in the order sent, each within the horizon of the next", () => {
  const alike = [
    { at: 0, hash: "AA" },
    { at: 200, hash: "bb" },
    { at: 250, hash: "dd" },
    { at: 900, hash: "ee" },
  ];
  // 250 and 200 are close enough to come first; 0 was paid long before; 900 comes after.
  assert.deepEqual(orderAmongAlike({ hash: "cc", sourceAt: 300 }, alike, { horizonMs: 150 }), { since: 200, skip: 2 });
  // One already seen arriving is left out by its payout, not counted.
  assert.deepEqual(orderAmongAlike({ hash: "cc", sourceAt: 300 }, alike, { horizonMs: 150, settled: new Set(["dd"]) }), { since: 200, skip: 1 });
  // A wider horizon reaches the first one too.
  assert.deepEqual(orderAmongAlike({ hash: "CC", sourceAt: 300 }, alike, { horizonMs: 200 }), { since: 0, skip: 3 });
  assert.deepEqual(orderAmongAlike({ hash: "aa", sourceAt: 0 }, alike, { horizonMs: 200 }), { since: 0, skip: 0 });
});

// A Dusk transfer as the archive's memo and history indexes list it.
const listed = (origin, event) => ({ block_height: 4_000, events: [{ reverted: false, ...event }], origin });

test("on a device that only knows the later of two equal transfers, the archive keeps their order", async () => {
  let logs = [];
  const rpc = fakeRpc({
    eth_getLogs: ([filter]) =>
      logs.filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock)),
  });
  const earlier = "ef".repeat(32);
  const longAgo = "aa".repeat(32);
  const txs = {
    [DUSK_HASH]: duskTx({ blockTimestamp: 1_792_980_200n }),
    [earlier]: duskTx({ blockTimestamp: 1_792_980_100n }),
    // Sent three days before: paid out long ago.
    [longAgo]: duskTx({ blockTimestamp: 1_792_980_200n - 3n * 86_400n }),
  };
  const toBridge = (value) => ({ data: { receiver: TESTNET_REGGIO_BRIDGE_ACCOUNT, value }, target: `01${"0".repeat(62)}`, topic: "moonlight" });
  const memos = [];
  const tracking = createTracking({
    config: cfg,
    node: node({
      transaction: async (hash) => txs[hash] ?? null,
      transfersByMemo: async (memo) => {
        memos.push(memo);
        return memo === RECIPIENT
          ? [listed(longAgo, toBridge("2000000000")), listed(earlier, toBridge("2000000000")), listed(DUSK_HASH, toBridge("2000000000")), listed("bb".repeat(32), toBridge("5000000000"))]
          : [];
      },
    }),
    rpc,
  });
  const payout = (hash, block) => ({ blockNumber: toHex(block), data: toHex(10n ** 18n, { size: 32 }), transactionHash: hash });
  // Only this transfer is known here, as when its receipt link opens elsewhere.
  const entry = { hash: DUSK_HASH, id: "this", routeId: ROUTES.service.id };

  // The one payout so far is the earlier transfer's.
  logs = [payout("0x0a", 1_500n)];
  const waiting = await tracking.refresh(entry, ROUTES.service, { others: [entry] });
  assert.equal(waiting.status, "pending");
  assert.deepEqual(memos.sort(), [RECIPIENT, RECIPIENT.toLowerCase()].sort());
  logs = [payout("0x0a", 1_500n), payout("0x0b", 1_600n)];
  assert.equal((await tracking.refresh({ ...entry, ...waiting }, ROUTES.service, { others: [entry] })).destinationHash, "0x0b");
});

test("a deposit on a device that only knows it leaves the earlier equal deposit's credit", async () => {
  const deposit = (at, height) =>
    duskTx({
      blockHeight: BigInt(height),
      blockTimestamp: BigInt(at),
      callData: {
        contractId: BRIDGE,
        data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
        fnName: "depositETHToWithValue",
      },
      json: { sender: SENDER },
    });
  const earlier = "ef".repeat(32);
  const txs = { [DUSK_HASH]: deposit(1_792_980_200, 5_000), [earlier]: deposit(1_792_980_100, 4_990) };
  const intoBridge = { data: { receiver: BRIDGE, sender: SENDER, value: 100_000_000 }, target: `01${"0".repeat(62)}`, topic: "deposit" };
  // The earlier one paid its unspent gas to another account: its sender paid more than the bridge took.
  const refund = { data: { receiver: null, refund_info: [TESTNET_REGGIO_BRIDGE_ACCOUNT, "500"], sender: SENDER, value: "0" }, reverted: false, target: `01${"0".repeat(62)}`, topic: "moonlight" };
  const paidMore = { ...listed(earlier, intoBridge), events: [...listed(earlier, intoBridge).events, refund] };
  // Two pages of the sender's history: the two deposits, and deposits of another amount.
  const another = { ...intoBridge, data: { ...intoBridge.data, value: 5 } };
  let history = [paidMore, listed(DUSK_HASH, intoBridge), ...Array.from({ length: 58 }, (_, index) => listed(index.toString(16).padStart(64, "f"), another))];
  const queries = [];
  const credit = (hash, block) => ({
    blockNumber: toHex(block),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 17n, "0x"]),
    topics: [toEventSelector("ETHBridgeFinalized(address,address,uint256,bytes)"), pad(evmAddressOf(SENDER).toLowerCase()), pad(RECIPIENT.toLowerCase())],
    transactionHash: hash,
  });
  let credits = [credit("0x34", 1_900n)];
  const rpc = fakeRpc({
    "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    // Like a node: only the logs inside the asked range.
    "dusk-evm:eth_getLogs": ([filter]) =>
      credits.filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock)),
  });
  const make = () =>
    createTracking({
      archive: archive(history, queries),
      config: cfg,
      node: node({ transaction: async (hash) => txs[hash] ?? null }),
      rpc,
    });
  const entry = { hash: DUSK_HASH, id: "this", routeId: ROUTES.deposit.id };

  // The sender's history, a few hours up to this deposit, says which came first.
  const tracking = make();
  assert.equal((await tracking.refresh(entry, ROUTES.deposit, { others: [entry] })).status, "pending");
  assert.match(queries[0], new RegExp(`moonlightHistory\\(sender: "${SENDER}", fromBlock: 2840, toBlock: 5000, maxCount: 50\\)`, "u"));
  credits = [credit("0x34", 1_900n), credit("0x35", 1_950n)];
  assert.equal((await tracking.refresh(entry, ROUTES.deposit, { others: [entry] })).destinationHash, "0x35");

  // A history too long to read to the end leaves the order unclear: it waits.
  history = Array.from({ length: 201 }, (_, index) => listed(index.toString(16).padStart(64, "0"), intoBridge));
  const unclear = await make().refresh(entry, ROUTES.deposit, { others: [entry] });
  assert.equal(unclear.status, "pending");
  assert.match(unclear.note, /can't be told apart/u);
});

test("a Dusk → Sepolia transfer completes when the bridge pays the memo address", async () => {
  let logs = [];
  const rpc = fakeRpc({
    eth_getLogs: ([filter]) => {
      assert.equal(filter.address, cfg.evmNetworks.ethereum.tokenContract);
      assert.deepEqual(filter.topics, [
        toEventSelector("Transfer(address,address,uint256)"),
        null,
        pad(RECIPIENT.toLowerCase()),
      ]);
      return logs;
    },
  });
  let tx = null;
  const tracking = createTracking({ config: cfg, node: node({ transaction: async () => tx }), rpc });
  const entry = { hash: DUSK_HASH, routeId: ROUTES.service.id };

  assert.equal((await tracking.refresh(entry, ROUTES.service)).status, "pending");

  tx = duskTx();
  const sent = await tracking.refresh(entry, ROUTES.service);
  assert.equal(sent.status, "pending");
  assert.equal(sent.destination, RECIPIENT);
  assert.equal(sent.amountLux, "2000000000");
  assert.ok(sent.scanFrom, "the next check starts where this one stopped");

  // 2 DUSK minus the 1 DUSK fee, in 18 decimals.
  logs = [
    { blockNumber: toHex(1_500n), data: toHex(2n * 10n ** 18n, { size: 32 }), transactionHash: "0x01" },
    { blockNumber: toHex(1_600n), data: toHex(10n ** 18n, { size: 32 }), transactionHash: "0x02" },
  ];
  const paid = await tracking.refresh(entry, ROUTES.service);
  assert.equal(paid.status, "completed");
  assert.equal(paid.destinationHash, "0x02");

  tx = duskTx({ json: { receiver: TESTNET_REGGIO_BRIDGE_ACCOUNT, value: 1_000_000_000 } });
  assert.match((await tracking.refresh(entry, ROUTES.service)).note, /didn't exceed the bridge fee/u);
  tx = duskTx({ error: "Panic" });
  assert.equal((await tracking.refresh(entry, ROUTES.service)).status, "failed");
});

test("a deposit is followed to its DuskEVM credit through the bridge event when the adapter can't map hashes", async () => {
  const depositTx = duskTx({
    callData: {
      contractId: BRIDGE,
      data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
      fnName: "depositETHToWithValue",
    },
    json: { sender: SENDER },
  });
  const finalized = toEventSelector("ETHBridgeFinalized(address,address,uint256,bytes)");
  let credited = false;
  const rpc = fakeRpc({
    "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    "dusk-evm:eth_getLogs": ([filter]) => {
      assert.equal(filter.address, cfg.duskEvm.predeploys.l2StandardBridge);
      assert.deepEqual(filter.topics, [
        finalized,
        pad(evmAddressOf(SENDER).toLowerCase()),
        pad(RECIPIENT.toLowerCase()),
      ]);
      return credited
        ? [
            {
              blockNumber: toHex(1_900n),
              data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 17n, "0x"]),
              topics: filter.topics,
              transactionHash: "0x34",
            },
          ]
        : [];
    },
  });
  const tracking = createTracking({ archive: archive(), config: cfg, node: node({ transaction: async () => depositTx }), rpc });
  const entry = { hash: DUSK_HASH, routeId: ROUTES.deposit.id };

  const waiting = await tracking.refresh(entry, ROUTES.deposit);
  assert.equal(waiting.status, "pending");
  assert.equal(waiting.destination, RECIPIENT);
  assert.equal(waiting.amountLux, "100000000");

  credited = true;
  const done = await tracking.refresh(entry, ROUTES.deposit);
  assert.equal(done.status, "completed");
  assert.equal(done.destinationHash, "0x34");
  assert.equal(done.destinationAt, (1_792_980_000 + 1_900) * 1_000);
  // The adapter is asked once; after that only the event is watched.
  assert.equal(rpc.calls.filter(({ method }) => method === "duskevm_getTransactionHashByDuskHash").length, 1);
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
      loadWithdrawalStatus: async () => ({ blockNumber: 50n, details: { amountWei: 10n ** 17n }, proofSubmitter: recipient, stage: "ready_to_finalize", withdrawal: { gasLimit: 519_542n } }),
    },
  });
  const checked = await tracking.refresh({ hash: EVM_HASH, routeId: ROUTES.withdrawal.id }, ROUTES.withdrawal);
  assert.deepEqual([checked.stage, checked.stageSubmitter], ["ready_to_finalize", recipient]);
});

test("a withdrawal follows its stages, and a sent proof waits for Dusk", async () => {
  let status = { blockNumber: 50n, details: { amountWei: 10n ** 17n }, stage: "ready_to_prove", withdrawal: { gasLimit: 519_542n } };
  let error = null;
  const asked = [];
  const withdrawals = {
    loadWithdrawalStatus: async (_hash, options) => {
      asked.push(options.proofSubmitter);
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
  assert.equal(ready.amountLux, "100000000");
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
  await tracking.refresh({ ...entry, proofSubmitter: "0xa" }, ROUTES.withdrawal);
  await tracking.refresh({ ...entry, proofSubmitter: "0xa", proveHash: "bb".repeat(32) }, ROUTES.withdrawal);
  assert.deepEqual(asked, [undefined, "0xa"]);

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
  const load = withdrawals.loadWithdrawalStatus;
  withdrawals.loadWithdrawalStatus = async (hash, options) => {
    games.push(options.proofGame);
    return load(hash, options);
  };
  await tracking.refresh({ ...entry, proofGame: late.proofGame }, ROUTES.withdrawal);
  withdrawals.loadWithdrawalStatus = load;
  assert.deepEqual(games, [`0x${"6f".repeat(20)}`]);

  status = { ...status, stage: "finalized" };
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).status, "completed");

  error = new Error("Withdrawal transaction was not found.");
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).status, "pending");
  error = new Error("Withdrawal transaction failed on DuskEVM.");
  assert.equal((await tracking.refresh(entry, ROUTES.withdrawal)).status, "failed");
  // Another message to Dusk isn't a withdrawal of DUSK: it ends here.
  error = new Error(NOT_A_DUSK_WITHDRAWAL);
  const other = await tracking.refresh(entry, ROUTES.withdrawal);
  assert.deepEqual([other.status, other.note], ["failed", NOT_A_DUSK_WITHDRAWAL]);
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

test("a payout from before the transfer was sent here isn't taken as its payout", async () => {
  // Sent here: the head read before sending (block 1,700) bounds the first scan.
  const logs = [
    { blockNumber: toHex(1_500n), data: toHex(10n ** 18n, { size: 32 }), transactionHash: "0x01" },
    { blockNumber: toHex(1_800n), data: toHex(10n ** 18n, { size: 32 }), transactionHash: "0x02" },
  ];
  const rpc = fakeRpc({
    eth_getLogs: ([filter]) =>
      logs.filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock)),
  });
  const tracking = createTracking({ config: cfg, node: node({ transaction: async () => duskTx() }), rpc });
  const entry = { hash: DUSK_HASH, id: "sent", routeId: ROUTES.service.id, scanFrom: "1700" };
  assert.equal((await tracking.refresh(entry, ROUTES.service, { others: [entry] })).destinationHash, "0x02");
});

test("a credit from before the deposit was sent here isn't taken as its credit", async () => {
  // As for a payout: the DuskEVM head read before sending (block 1,700) bounds the first scan.
  const depositTx = duskTx({
    callData: {
      contractId: BRIDGE,
      data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: RECIPIENT })).toString("hex"),
      fnName: "depositETHToWithValue",
    },
    json: { sender: SENDER },
  });
  const credit = (block, transactionHash) => ({
    blockNumber: toHex(block),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 17n, "0x"]),
    transactionHash,
  });
  const logs = [credit(1_500n, "0x01"), credit(1_800n, "0x02")];
  const rpc = fakeRpc({
    "dusk-evm-l1:duskevm_getTransactionHashByDuskHash": () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    },
    "dusk-evm:eth_getLogs": ([filter]) =>
      logs
        .filter((log) => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock))
        .map((log) => ({ ...log, topics: filter.topics })),
  });
  const tracking = createTracking({ archive: archive(), config: cfg, node: node({ transaction: async () => depositTx }), rpc });
  const entry = { hash: DUSK_HASH, id: "sent", routeId: ROUTES.deposit.id, scanFrom: "1700" };
  assert.equal((await tracking.refresh(entry, ROUTES.deposit, { others: [entry] })).destinationHash, "0x02");
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
  let status = { blockNumber: 50n, details: { amountWei: 10n ** 17n }, provenAt: included, stage: "ready_to_prove", withdrawal: { gasLimit: 519_542n } };
  const tracking = createTracking({
    config: cfg,
    node: node({ transaction: async () => duskTx({ blockTimestamp: included }) }),
    now: () => 1_793_100_000_000,
    rpc: fakeRpc({}),
    withdrawals: { loadWithdrawalStatus: async () => status },
  });
  const proving = { hash: EVM_HASH, pendingAction: "prove", pendingHash: "aa".repeat(32), routeId: ROUTES.withdrawal.id };
  const settled = await tracking.refresh(proving, ROUTES.withdrawal);
  assert.deepEqual([settled.stage, settled.pendingAction, settled.proveHash], ["ready_to_prove", null, "aa".repeat(32)]);
  // An older proof the Portal still shows, from before this one, keeps it pending.
  status = { ...status, provenAt: included - 3_600n };
  assert.equal((await tracking.refresh(proving, ROUTES.withdrawal)).stage, "prove_submitted");
});
