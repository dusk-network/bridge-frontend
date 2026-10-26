import assert from "node:assert/strict";
import test from "node:test";

import { encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";
import { encodeAbiParameters, pad } from "viem";

import { decodeBase58 } from "./base58.js";
import { MAINNET_BSC_BRIDGE_ACCOUNT, TESTNET_REGGIO_BRIDGE_ACCOUNT } from "./config.js";
import {
  createDiscovery,
  entryFromHistory,
  groupTransfers,
  mergeTransfer,
  mergeTransfers,
  shownFor,
  verifyPayouts,
} from "./discovery.js";
import { FIRST_WINDOW, addCoverage, bridgeEntry, syncDuskHistory, topGap } from "./dusk-history.js";
import { ETH_BRIDGE_INITIATED_TOPIC, syncWithdrawals } from "./l2-withdrawals.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const OTHER = MAINNET_BSC_BRIDGE_ACCOUNT;
const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
const TRANSFER = `01${"0".repeat(62)}`;
const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
const MIGRATOR = "0x7B1FF96D7edC07D8d83eC2A4da99EF8215a7366B";
const hex = (text) => Buffer.from(text).toString("hex");
const h = (n) => n.toString(16).padStart(64, "0");

const cfg = {
  duskEvm: { enabled: true, l1StandardBridgeContractId: BRIDGE, l2StandardBridgeAddress: "0x4200000000000000000000000000000000000010" },
  evmNetworks: { ethereum: { migrationContract: MIGRATOR } },
  migrations: ["ethereum"],
  profile: "testnet",
  service: { account: TESTNET_REGGIO_BRIDGE_ACCOUNT, feeLux: 1_000_000_000n, network: "ethereum" },
};

// Shaped like the archive's own answers (testnet, 26 Oct).
const deposit = (n, height) => ({
  block_height: height,
  events: [
    { data: { receiver: BRIDGE, sender: ACCOUNT, value: "100000000" }, reverted: false, target: TRANSFER, topic: "deposit" },
    { data: `${"0".repeat(48)}016345785d8a0000e0ffffff00000000975729af8e43f9d690d24da68d9e92d2e8273174${EVM.slice(2)}`, reverted: false, target: BRIDGE, topic: "eth_bridge_initiated" },
    { data: { gas_spent: "1986599", memo: "", receiver: null, sender: ACCOUNT, value: "0" }, reverted: false, target: TRANSFER, topic: "moonlight" },
  ],
  origin: h(n),
});
const service = (n, height) => ({
  block_height: height,
  events: [{ data: { memo: hex("0xeE1b68ED496712cda857ada41d326d357049E51C"), receiver: TESTNET_REGGIO_BRIDGE_ACCOUNT, sender: ACCOUNT, value: "50000000000" }, reverted: false, target: TRANSFER, topic: "moonlight" }],
  origin: h(n),
});
const payout = (n, height, memo) => ({
  block_height: height,
  events: [{ data: { memo: hex(memo), receiver: ACCOUNT, sender: OTHER, value: "1000000000000" }, reverted: false, target: TRANSFER, topic: "moonlight" }],
  origin: h(n),
});
const plain = (n, height) => ({
  block_height: height,
  events: [{ data: { memo: hex("rent"), receiver: OTHER, sender: ACCOUNT, value: "5" }, reverted: false, target: TRANSFER, topic: "moonlight" }],
  origin: h(n),
});

test("the archive's entries are read as the bridge transfers they are", () => {
  assert.deepEqual(bridgeEntry(ACCOUNT, deposit(1, 10), cfg), {
    amountLux: "100000000",
    blockHeight: 10,
    destination: EVM,
    hash: h(1),
    kind: "deposit",
  });
  assert.deepEqual(bridgeEntry(ACCOUNT, service(2, 11), cfg), {
    amountLux: "50000000000",
    blockHeight: 11,
    destination: "0xeE1b68ED496712cda857ada41d326d357049E51C",
    hash: h(2),
    kind: "service",
  });
  const memo = `0x${"ab".repeat(32)}`;
  assert.deepEqual(bridgeEntry(ACCOUNT, payout(3, 12, memo), cfg), {
    amountLux: "1000000000000",
    blockHeight: 12,
    hash: h(3),
    kind: "payout",
    sourceHash: memo,
  });
  assert.equal(bridgeEntry(ACCOUNT, plain(4, 13), cfg), null);
  // A reverted deposit moved nothing.
  const reverted = deposit(5, 14);
  reverted.events[0].reverted = true;
  assert.equal(bridgeEntry(ACCOUNT, reverted, cfg), null);
  // Without DuskEVM configured, a deposit is nobody's business here.
  assert.equal(bridgeEntry(ACCOUNT, deposit(1, 10), { ...cfg, duskEvm: { enabled: false } }), null);
});

function archive(entries, finalized) {
  const calls = [];
  const query = async (selection) => {
    calls.push(selection);
    const data = {};
    if (selection.includes("lastBlockPair")) data.pair = { json: { last_finalized_block: [finalized, "x"] } };
    for (const [alias, direction] of [["out", "sender"], ["in", "receiver"]]) {
      const match = new RegExp(`${alias}: moonlightHistory\\(${direction}: "[^"]+", fromBlock: (\\d+)(?:, toBlock: (\\d+))?`, "u").exec(selection);
      if (!match) continue;
      const [from, to] = [Number(match[1]), match[2] === undefined ? Infinity : Number(match[2])];
      const list = entries.filter((entry) => {
        const ours = entry.events.some((event) => event.data?.[direction === "sender" ? "sender" : "receiver"] === ACCOUNT);
        return ours && entry.block_height >= from && entry.block_height <= to;
      });
      data[alias] = list.length ? { json: list.slice(0, 50) } : null;
    }
    return data;
  };
  return { calls, query };
}

test("the history sync reads the newest blocks first, widens, and carries on later", async () => {
  const tip = 4_687_950;
  const entries = [deposit(1, tip - 100), service(2, tip - 20_000), plain(3, tip - 30_000), deposit(4, 1_000)];
  const node = archive(entries, tip);
  const first = await syncDuskHistory({ account: ACCOUNT, cfg, maxRequests: 3, query: node.query });
  assert.equal(first.requests, 3);
  // The head, then a day, then eight days: both recent transfers, not yet the old one.
  assert.deepEqual(first.found.map((entry) => entry.hash), [h(1), h(2)]);
  assert.deepEqual(first.state.covered, [[tip - 10 - FIRST_WINDOW * 9 + 1, tip - 10]]);
  assert.match(node.calls[1], /out: moonlightHistory\(sender: "[^"]+", fromBlock: \d+, toBlock: \d+, maxCount: 50\) \{ json \} in: moonlightHistory\(receiver:/u);

  // A later visit reads what's new above, then carries on down, finding each transfer once.
  entries.push(service(5, tip + 50));
  const node2 = archive(entries, tip + 100);
  const second = await syncDuskHistory({ account: ACCOUNT, cfg, maxRequests: 6, query: node2.query, state: first.state });
  assert.deepEqual(second.found.map((entry) => entry.hash).sort(), [h(4), h(5)]);
  assert.match(node2.calls[0], /lastBlockPair/u);
  assert.equal(topGap(second.state.covered, second.state.target), null);
  assert.equal(Object.keys(second.state.entries).length, 4);
});

test("coverage joins touching ranges and names the highest gap", () => {
  assert.deepEqual(addCoverage([[50, 60]], 61, 80), [[50, 80]]);
  assert.deepEqual(addCoverage([[50, 60]], 10, 20), [[50, 60], [10, 20]]);
  assert.deepEqual(topGap([[50, 100]], 120), [101, 120]);
  assert.deepEqual(topGap([[50, 100], [0, 20]], 100), [21, 49]);
  assert.equal(topGap([[0, 100]], 100), null);
});

const withdrawalLog = (n, block, recipient = ACCOUNT, amount = 2n * 10n ** 18n) => ({
  blockNumber: `0x${block.toString(16)}`,
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [amount, encodeDuskExternalAssetRecipient(decodeBase58(recipient))]),
  topics: [ETH_BRIDGE_INITIATED_TOPIC, pad(EVM), pad(EVM)],
  transactionHash: `0x${h(n)}`,
});

test("withdrawals are found by the EVM address, a window at a time, from the newest", async () => {
  const head = 3_905_000;
  const logs = [withdrawalLog(1, head - 50_000), withdrawalLog(2, head - 350_000, OTHER), withdrawalLog(3, 10)];
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    const [{ fromBlock, toBlock, topics }] = params;
    const [from, to] = [Number(fromBlock), Number(toBlock)];
    if (to - from + 1 > 100_000) throw Object.assign(new Error("query exceeds max block range 100000"), { code: -32602 });
    assert.equal(topics[1], pad(EVM));
    return logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
  };
  const bridge = cfg.duskEvm.l2StandardBridgeAddress;
  const first = await syncWithdrawals({ address: EVM, bridge, maxRequests: 5, rpc });
  assert.deepEqual(first.found.map((entry) => [entry.hash, entry.destination, entry.amountWei]), [
    [`0x${h(1)}`, ACCOUNT, "2000000000000000000"],
    [`0x${h(2)}`, OTHER, "2000000000000000000"],
  ]);
  assert.equal(calls.filter(([method]) => method === "eth_getLogs").length, 4);
  assert.deepEqual(first.state.covered, [[head - 400_000 + 1, head]]);

  // Too wide a window for another node: narrower, and nothing skipped.
  const narrow = await syncWithdrawals({
    address: EVM,
    bridge,
    maxRequests: 4,
    rpc: async (method, params) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      const [{ fromBlock, toBlock }] = params;
      if (Number(toBlock) - Number(fromBlock) + 1 > 25_000) throw new Error("block range limit exceeded");
      return [];
    },
  });
  assert.equal(narrow.state.window, 25_000);
  assert.deepEqual(narrow.state.covered, [[head - 50_000 + 1, head]]);
});

test("a transfer found twice, or found and sent here, is one entry", () => {
  const sent = { hash: h(1), id: `dusk-to-dusk-evm:${h(1)}`, parties: [ACCOUNT], routeId: "dusk-to-dusk-evm", sentHere: true, status: "completed", destinationHash: "0x01", createdAt: "2026-10-26T09:00:00.000Z" };
  const found = entryFromHistory({ amountLux: "100000000", blockHeight: 10, destination: EVM, hash: h(1), kind: "deposit" }, ACCOUNT, cfg);
  const merged = mergeTransfers([sent], [found, { ...found }, entryFromHistory({ amountLux: "5", destination: EVM, hash: h(2), kind: "deposit" }, ACCOUNT, cfg)]);
  assert.equal(merged.length, 2);
  const one = merged.find((entry) => entry.hash === h(1));
  assert.equal(one.status, "completed");
  assert.equal(one.destinationHash, "0x01");
  assert.equal(one.sentHere, true);
  assert.deepEqual(one.parties, [ACCOUNT, EVM]);
  assert.equal(one.amountLux, "100000000");
  // A later read that knows less never undoes an end.
  assert.equal(mergeTransfer({ status: "failed", note: "x" }, { status: "pending", note: "" }).status, "failed");
  assert.equal(merged.find((entry) => entry.hash === h(2)).status, "pending");
});

test("My transfers shows the connected accounts' transfers and what this device followed", () => {
  const mine = { parties: [ACCOUNT, EVM] };
  assert.ok(shownFor(mine, [EVM.toUpperCase().replace("0X", "0x")]));
  assert.ok(shownFor(mine, [ACCOUNT]));
  assert.ok(!shownFor(mine, [OTHER]));
  assert.ok(shownFor({ followed: true, parties: [] }, []));
  // Dusk accounts are base58: case matters there.
  assert.ok(!shownFor({ parties: [ACCOUNT.toLowerCase()] }, [ACCOUNT]));
});

test("transfers group into Needs you, In progress, Completed and Failed", () => {
  const routes = { w: { mode: "duskevm-withdrawal" }, d: { mode: "duskevm-deposit" } };
  const groups = groupTransfers(
    [
      { id: "a", routeId: "w", stage: "ready_to_finalize", status: "pending", sourceAt: 3 },
      { id: "b", routeId: "w", stage: "ready_to_prove", pendingAction: "prove", status: "pending", sourceAt: 4 },
      { id: "c", routeId: "w", stage: "proven_waiting", status: "pending", sourceAt: 1 },
      { id: "d", routeId: "d", status: "completed", sourceAt: 2 },
      { id: "e", routeId: "d", status: "failed", sourceAt: 5 },
      { id: "f", routeId: "w", stage: "ready_to_prove", status: "pending", sourceAt: 9 },
    ],
    (id) => routes[id],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map((entry) => entry.id)])),
    { done: ["d"], failed: ["e"], needs: ["f", "a"], progress: ["b", "c"] },
  );
});

test("a payout counts as a migration only when its memo names one", async () => {
  const records = [
    { hash: h(7), kind: "payout", sourceHash: `0x${"aa".repeat(32)}` },
    { hash: h(8), kind: "payout", sourceHash: `0x${"bb".repeat(32)}` },
  ];
  const batches = [];
  await verifyPayouts(records, {
    cfg,
    rpcBatch: async (network, calls) => {
      batches.push([network, calls.length]);
      return calls.map(({ params }) =>
        params[0] === `0x${"aa".repeat(32)}` ? { from: "0xD63B00000000000000000000000000000000DF40", to: MIGRATOR.toLowerCase() } : { to: "0x0000000000000000000000000000000000000001" },
      );
    },
  });
  assert.deepEqual(batches, [["ethereum", 2]]);
  assert.equal(records[0].routeId, "ethereum-to-dusk");
  assert.equal(records[1].rejected, true);
  const entry = entryFromHistory({ ...records[0], amountLux: "1000000000000" }, ACCOUNT, cfg);
  assert.deepEqual(
    { hash: entry.hash, routeId: entry.routeId, status: entry.status, destinationHash: entry.destinationHash },
    { destinationHash: h(7), hash: `0x${"aa".repeat(32)}`, routeId: "ethereum-to-dusk", status: "completed" },
  );
  assert.equal(entryFromHistory(records[1], ACCOUNT, cfg), null);
  // Settled payouts aren't asked about again.
  await verifyPayouts(records, { cfg, rpcBatch: async () => assert.fail("asked twice") });
});

test("discovery keeps each account's progress per network and asks again only for what's new", async () => {
  const storage = new Map();
  const store = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const tip = 1_000_000;
  const node = archive([deposit(1, tip - 50)], tip);
  let details = 0;
  const discovery = createDiscovery({
    cfg,
    node: {
      query: node.query,
      transaction: async () => {
        details += 1;
        return { blockTimestamp: 1_761_471_064n, callData: null };
      },
    },
    rpc: async () => assert.fail("no EVM address given"),
    rpcBatch: async () => [],
    storage: store,
  });
  const first = await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 });
  assert.deepEqual(first.entries.map((entry) => [entry.routeId, entry.hash, entry.sourceAt]), [["dusk-to-dusk-evm", h(1), 1_761_471_064_000]]);
  assert.ok([...storage.keys()].every((key) => key.startsWith("dusk-bridge:discovery:v1:testnet:dusk:")));
  const again = await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 });
  assert.equal(again.entries.length, 1);
  // Its time was kept: one details lookup in all.
  assert.equal(details, 1);
});
