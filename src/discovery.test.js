import assert from "node:assert/strict";
import test from "node:test";

import { encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi } from "viem";

import { decodeBase58 } from "./base58.js";
import { networks } from "@dusk-network/networks";

// Two accounts the networks' files name: the BSC and the Sepolia bridge accounts.
const MAINNET_BSC_BRIDGE_ACCOUNT = networks.mainnet.routes.services[0].account;
const TESTNET_REGGIO_BRIDGE_ACCOUNT = networks.testnet.routes.services[0].account;
import {
  createDiscovery,
  entryFromHistory,
  followAfterDiscovery,
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
  duskEvm: { enabled: true, l1StandardBridgeContractId: BRIDGE, predeploys: { l2StandardBridge: "0x4200000000000000000000000000000000000010" } },
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
    payer: OTHER,
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

test("a block with more than a page of the account's entries is read to its last page, across runs", async () => {
  const tip = 4_687_950;
  const crowd = 4_687_000;
  // 120 deposits in one block, one above it: pages of 50, in order.
  const entries = [...Array.from({ length: 120 }, (_, n) => deposit(100 + n, crowd)), deposit(1, crowd + 300)];
  const calls = [];
  const query = async (selection) => {
    calls.push(selection);
    const data = {};
    if (selection.includes("lastBlockPair")) data.pair = { json: { last_finalized_block: [tip, "x"] } };
    for (const [alias, direction] of [["out", "sender"], ["in", "receiver"]]) {
      const match = new RegExp(`${alias}: moonlightHistory\\(${direction}: "[^"]+", fromBlock: (\\d+)(?:, toBlock: (\\d+))?, maxCount: 50(?:, pageCount: (\\d+))?`, "u").exec(selection);
      if (!match) continue;
      const [from, to, page] = [Number(match[1]), match[2] === undefined ? Infinity : Number(match[2]), Number(match[3] ?? 1)];
      const list = entries.filter((entry) => {
        const ours = entry.events.some((event) => event.data?.[direction] === ACCOUNT);
        return ours && entry.block_height >= from && entry.block_height <= to;
      });
      const pageOf = list.slice((page - 1) * 50, page * 50);
      data[alias] = pageOf.length ? { json: pageOf } : null;
    }
    return data;
  };

  let state;
  const found = new Set();
  for (let run = 0; run < 12 && !(state && topGap(state.covered, state.target) === null); run += 1) {
    ({ state } = await syncDuskHistory({ account: ACCOUNT, cfg, maxRequests: 2, query, state }).then((result) => {
      for (const entry of result.found) found.add(entry.hash);
      return result;
    }));
    // The block counts as read only once its last page is.
    const blockCovered = state.covered.some(([lo, hi]) => lo <= crowd && crowd <= hi);
    if (state.crowded) assert.equal(blockCovered, false);
    if (blockCovered) assert.equal(found.size, 121);
  }
  assert.equal(found.size, 121);
  assert.equal(state.crowded, null);
  assert.ok(calls.some((selection) => /fromBlock: 4687000, toBlock: 4687000, maxCount: 50, pageCount: 3\)/u.test(selection)));

  // A gap of that one block: its first page fills, then the rest, page by page.
  let lone = { covered: [[crowd + 1, tip - 10], [0, crowd - 1]], crowded: null, entries: {}, target: tip - 10, window: 1 };
  const loneFound = new Set();
  for (let run = 0; run < 6 && topGap(lone.covered, lone.target) !== null; run += 1) {
    const result = await syncDuskHistory({ account: ACCOUNT, cfg, maxRequests: 2, query, state: lone });
    for (const entry of result.found) loneFound.add(entry.hash);
    lone = result.state;
  }
  assert.equal(loneFound.size, 120);
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
    if (method === "eth_getBlockByNumber") return { number: `0x${head.toString(16)}` };
    const [{ fromBlock, toBlock, topics }] = params;
    const [from, to] = [Number(fromBlock), Number(toBlock)];
    if (to - from + 1 > 100_000) throw Object.assign(new Error("query exceeds max block range 100000"), { code: -32602 });
    assert.equal(topics[1], pad(EVM));
    return logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
  };
  const bridge = cfg.duskEvm.predeploys.l2StandardBridge;
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
      if (method === "eth_getBlockByNumber") return { number: `0x${head.toString(16)}` };
      const [{ fromBlock, toBlock }] = params;
      if (Number(toBlock) - Number(fromBlock) + 1 > 25_000) throw new Error("block range limit exceeded");
      return [];
    },
  });
  assert.equal(narrow.state.window, 25_000);
  assert.deepEqual(narrow.state.covered, [[head - 50_000 + 1, head]]);

  // Only final blocks are covered: a log above the finalized head waits, and
  // coverage an older run kept above it is read again.
  const latest = head + 600;
  let finalized = head;
  const final = async (method, params) => {
    if (method === "eth_getBlockByNumber") return { number: `0x${finalized.toString(16)}` };
    const [{ fromBlock, toBlock }] = params;
    return [withdrawalLog(4, head + 300)].filter((log) => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock));
  };
  const kept = { covered: [[head - 1_000, latest]], entries: {}, target: latest, window: 100_000 };
  const before = await syncWithdrawals({ address: EVM, bridge, maxRequests: 3, rpc: final, state: kept });
  assert.deepEqual(before.found, []);
  assert.equal(Math.max(...before.state.covered.map(([, hi]) => hi)), head);
  finalized = latest;
  const after = await syncWithdrawals({ address: EVM, bridge, maxRequests: 3, rpc: final, state: before.state });
  assert.deepEqual(after.found.map((entry) => entry.hash), [`0x${h(4)}`]);
  // A node that doesn't answer "finalized": the latest block, less about an hour.
  const older = await syncWithdrawals({
    address: EVM,
    bridge,
    maxRequests: 2,
    rpc: async (method) => {
      if (method === "eth_getBlockByNumber") throw new Error("invalid block tag");
      if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;
      return [];
    },
  });
  assert.equal(older.state.target, latest - 1_800);
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

test("transfers group into Needs you, In progress, Sent to someone else, Completed and Failed", () => {
  const routes = { w: { mode: "duskevm-withdrawal" }, d: { mode: "duskevm-deposit" } };
  const entries = [
    { id: "a", routeId: "w", stage: "ready_to_finalize", status: "pending", sourceAt: 3 },
    { id: "b", routeId: "w", stage: "ready_to_prove", pendingAction: "prove", status: "pending", sourceAt: 4 },
    { id: "c", routeId: "w", stage: "proven_waiting", status: "pending", sourceAt: 1 },
    { id: "d", routeId: "d", status: "completed", sourceAt: 2 },
    { id: "e", routeId: "d", status: "failed", sourceAt: 5 },
    { destination: ACCOUNT, id: "f", routeId: "w", stage: "ready_to_prove", status: "pending", sourceAt: 9 },
    // Withdrawals that pay another Dusk account: apart while they're under way.
    { destination: OTHER, id: "g", routeId: "w", stage: "ready_to_prove", status: "pending", sourceAt: 8 },
    { destination: OTHER, id: "h", routeId: "w", stage: "proven_waiting", status: "pending", sourceAt: 7 },
    { destination: OTHER, id: "i", routeId: "w", stage: "finalized", status: "completed", sourceAt: 6 },
    // A deposit to another DuskEVM address stays where it is.
    { destination: EVM, id: "j", routeId: "d", status: "pending", sourceAt: 10 },
  ];
  const ids = (groups) => Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map((entry) => entry.id)]));
  assert.deepEqual(ids(groupTransfers(entries, (id) => routes[id], ACCOUNT)), {
    done: ["i", "d"],
    failed: ["e"],
    needs: ["f", "a"],
    other: ["g", "h"],
    progress: ["j", "b", "c"],
  });
  // With no Dusk account to tell, every withdrawal is the user's.
  assert.deepEqual(ids(groupTransfers(entries, (id) => routes[id])).needs, ["f", "g", "a"]);
});

const migrateInput = (amountLux, account) =>
  encodeFunctionData({
    abi: parseAbi(["function migrate(uint256 amount, string mainnetDuskAddress)"]),
    args: [BigInt(amountLux) * 1_000_000_000n, account],
    functionName: "migrate",
  });

test("a payout counts as a migration only when its memo names a migration of that amount to this account", async () => {
  const hashOf = (byte) => `0x${byte.repeat(32)}`;
  const records = [
    { amountLux: "1000000000000", hash: h(7), kind: "payout", payer: OTHER, sourceHash: hashOf("aa") },
    { amountLux: "1000000000000", hash: h(8), kind: "payout", payer: OTHER, sourceHash: hashOf("bb") },
    // Spoofs: someone else's migration, and the right migration with a token amount.
    { amountLux: "1000000000000", hash: h(9), kind: "payout", payer: OTHER, sourceHash: hashOf("cc") },
    { amountLux: "1", hash: h(10), kind: "payout", payer: OTHER, sourceHash: hashOf("aa") },
  ];
  const txs = {
    [hashOf("aa")]: { from: "0xD63B00000000000000000000000000000000DF40", input: migrateInput("1000000000000", ACCOUNT), to: MIGRATOR.toLowerCase() },
    [hashOf("bb")]: { input: "0x", to: "0x0000000000000000000000000000000000000001" },
    [hashOf("cc")]: { input: migrateInput("1000000000000", OTHER), to: MIGRATOR.toLowerCase() },
  };
  const batches = [];
  await verifyPayouts(records, {
    account: ACCOUNT,
    cfg,
    rpcBatch: async (network, calls) => {
      batches.push([network, calls.length]);
      return calls.map(({ params }) => txs[params[0]]);
    },
  });
  assert.deepEqual(batches, [["ethereum", 4]]);
  assert.equal(records[0].routeId, "ethereum-to-dusk");
  assert.deepEqual(records.slice(1).map((record) => record.rejected), [true, true, true]);
  const entry = entryFromHistory(records[0], ACCOUNT, cfg);
  assert.deepEqual(
    { hash: entry.hash, routeId: entry.routeId, status: entry.status, destinationHash: entry.destinationHash },
    { destinationHash: h(7), hash: hashOf("aa"), routeId: "ethereum-to-dusk", status: "completed" },
  );
  assert.equal(entryFromHistory(records[1], ACCOUNT, cfg), null);
  // Settled payouts aren't asked about again.
  await verifyPayouts(records, { account: ACCOUNT, cfg, rpcBatch: async () => assert.fail("asked twice") });

  // With the chain's payout account known, the same transfer from anyone else doesn't count.
  const fromOther = [{ amountLux: "1000000000000", hash: h(11), kind: "payout", payer: ACCOUNT, sourceHash: hashOf("aa") }];
  await verifyPayouts(fromOther, { account: ACCOUNT, cfg: { ...cfg, evmNetworks: { ethereum: { ...cfg.evmNetworks.ethereum, payoutAccount: OTHER } } }, rpcBatch: async (network, calls) => calls.map(({ params }) => txs[params[0]]) });
  assert.equal(fromOther[0].rejected, true);
});

test("a payout a chain couldn't be asked about stays open for the next visit", async () => {
  const records = [
    { amountLux: "5", hash: h(12), kind: "payout", sourceHash: `0x${"dd".repeat(32)}` },
    { amountLux: "5", hash: h(13), kind: "payout", sourceHash: `0x${"ee".repeat(32)}` },
  ];
  await verifyPayouts(records, {
    account: ACCOUNT,
    cfg,
    rpcBatch: async () => {
      throw new Error("RPC batch failed with HTTP 503");
    },
  });
  assert.deepEqual(records.map((record) => [record.rejected, record.routeId]), [[undefined, undefined], [undefined, undefined]]);

  // One call unanswered, one a plain "not found": only the second is settled.
  await verifyPayouts(records, { account: ACCOUNT, cfg, rpcBatch: async () => [undefined, null] });
  assert.deepEqual(records.map((record) => record.rejected), [undefined, true]);
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

test("a migration first found by its payout is checked once a visit, until its start is filled in", () => {
  const known = new Set(["old", "seen"]);
  const tracked = new Set(["old"]);
  const follow = (entry) => followAfterDiscovery(entry, { known, tracked });
  assert.equal(follow({ id: "new", status: "completed" }), true);
  assert.equal(follow({ id: "new", sourceAt: 1, status: "completed" }), false);
  assert.equal(follow({ id: "old", status: "completed" }), false);
  assert.equal(follow({ id: "new", status: "pending" }), true);
  assert.equal(follow({ id: "old", status: "pending" }), false);
  assert.equal(follow({ id: "new", status: "failed" }), false);
  // Found on an earlier visit whose check never ran or failed: checked again on this one.
  assert.equal(follow({ id: "seen", status: "completed" }), true);
  assert.equal(follow({ id: "seen", sourceAt: 1, status: "completed" }), false);
});
