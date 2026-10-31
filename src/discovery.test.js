import assert from "node:assert/strict";
import test from "node:test";

import { encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";
import { encodeAbiParameters, pad } from "viem";

import { createArchive } from "@dusk-network/app-core/history";
import { networks } from "@dusk-network/networks";
import { decodeBase58 } from "@dusk-network/networks/account";
import { encodeDepositArgs, evmAddressOf } from "@dusk-network/networks/duskevm";

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
  stateKey,
} from "./discovery.js";
import { ETH_BRIDGE_INITIATED_TOPIC, syncWithdrawals } from "./l2-withdrawals.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const OTHER = MAINNET_BSC_BRIDGE_ACCOUNT;
const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
const TRANSFER = `01${"0".repeat(62)}`;
const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
const hex = (text) => Buffer.from(text).toString("hex");
const h = (n) => n.toString(16).padStart(64, "0");

const cfg = {
  duskEvm: { enabled: true, l1StandardBridgeContractId: BRIDGE, predeploys: { l2StandardBridge: "0x4200000000000000000000000000000000000010" } },
  // Testnet, with OTHER paying Sepolia's migrations out, as a deployment can set it.
  network: {
    ...networks.testnet,
    routes: { ...networks.testnet.routes, migrations: networks.testnet.routes.migrations.map((route) => ({ ...route, payoutAccount: OTHER })) },
  },
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

test("a withdrawal that pays someone else is the user's to finish once the user proved it", () => {
  const routes = { w: { mode: "duskevm-withdrawal" } };
  const own = evmAddressOf(ACCOUNT).toLowerCase();
  const pays = (id, patch) => ({ destination: OTHER, id, routeId: "w", sourceAt: id.charCodeAt(0), status: "pending", ...patch });
  const groups = groupTransfers(
    [
      // Proved from here by the user, or as the check read for the user's own account says:
      // only the user can claim with that proof.
      pays("a", { proofAccount: ACCOUNT, proveHash: "ab".repeat(32), stage: "ready_to_finalize" }),
      pays("b", { stage: "ready_to_finalize", stageSubmitter: own }),
      // The user's proof on its way, or maturing: under way.
      pays("c", { pendingAction: "prove", pendingHash: "cd".repeat(32), proofAccount: ACCOUNT, stage: "prove_submitted" }),
      pays("d", { stage: "proven_waiting", stageSubmitter: own.toUpperCase().replace("0X", "0x") }),
      // Proved by another account, as a check read for another one says, or sent from here as another: someone else's.
      pays("e", { stage: "ready_to_finalize", stageSubmitter: evmAddressOf(OTHER).toLowerCase() }),
      pays("f", { proofAccount: OTHER, proveHash: "ef".repeat(32), stage: "ready_to_finalize" }),
      pays("g", { provenByOther: true, stage: "ready_to_prove" }),
    ],
    (id) => routes[id],
    ACCOUNT,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map((entry) => entry.id)])),
    { done: [], failed: [], needs: ["b", "a"], other: ["g", "f", "e"], progress: ["d", "c"] },
  );
});

// The details the archive gives a transaction sent at `seconds`, with its call.
const sent = (seconds, callData = null) => ({ blockTimestamp: seconds, err: null, gasSpent: 1, tx: { callData, gasLimit: 1, gasPrice: 1 } });
// The deposits' call, naming EVM as the DuskEVM address.
const DEPOSIT_CALL = {
  contractId: BRIDGE,
  data: Buffer.from(encodeDepositArgs({ amountLux: 100_000_000n, minGasLimit: 200_000, to: EVM })).toString("hex"),
  fnName: "depositETHToWithValue",
};

/** localStorage, in memory, holding `items`. */
function memoryStorage(items = new Map()) {
  items = new Map(items);
  return Object.assign(items, { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value)) });
}

/**
 * A Dusk archive node as @dusk-network/app-core/history asks it: the
 * account's `entries` up to the last finalized block, 50 a page, and each
 * transaction's `details`. `calls` keeps each request; `before` hears each
 * one first, and answers it instead when it gives a response.
 */
function archiveNode(entries, { details = {}, finalized }) {
  const node = { before: null, calls: [], details, entries, finalized, genesis: "aa".repeat(32) };
  const fetch = async (_url, { body }) => {
    node.calls.push(body);
    const instead = node.before?.(body);
    if (instead) return instead;
    const data = {};
    if (body.includes("lastBlockPair")) data.pair = { json: { last_finalized_block: [node.finalized, "x"] } };
    if (body.includes("genesis:")) data.genesis = { header: { hash: node.genesis } };
    const fields = /(\w+): moonlightHistory\((sender|receiver): "[^"]+", fromBlock: (\d+)(?:, toBlock: (\d+))?, maxCount: 50(?:, pageCount: (\d+))?\)/gu;
    for (const [, alias, direction, from, to, page = 1] of body.matchAll(fields)) {
      const list = node.entries.filter(
        (entry) =>
          entry.block_height >= Number(from) &&
          entry.block_height <= Math.min(Number(to ?? Infinity), node.finalized) &&
          entry.events.some((event) => event.data?.[direction] === ACCOUNT),
      );
      data[alias] = { json: list.slice((Number(page) - 1) * 50, Number(page) * 50) };
    }
    for (const [, alias, hash] of body.matchAll(/(t\d+): tx\(hash: "(\w+)"\)/gu)) data[alias] = node.details[hash] ?? null;
    return new Response(JSON.stringify({ data }));
  };
  node.archive = createArchive({ fetch, url: "https://node.test" });
  return node;
}

test("a Dusk account's transfers are its deposits, its transfers to the bridge account and its migrations' payouts", async () => {
  const tip = 1_000_000;
  const memo = `0x${"ab".repeat(32)}`;
  // A deposit that paid its unspent gas to another account: the account paid more than the bridge took.
  const refunded = deposit(1, tip - 100);
  refunded.events[2].data.refund_info = [OTHER, "500"];
  // A reverted deposit moved nothing.
  const reverted = deposit(5, tip - 60);
  reverted.events[0].reverted = true;
  const node = archiveNode([refunded, service(2, tip - 90), payout(3, tip - 80, memo), plain(4, tip - 70), reverted], {
    details: { [h(1)]: sent(1_792_980_000, DEPOSIT_CALL), [h(2)]: sent(1_792_980_100), [h(3)]: sent(1_792_980_200) },
    finalized: tip,
  });
  const storage = memoryStorage();
  const found = await createDiscovery({ archive: node.archive, cfg, storage }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  const route = (id) => found.entries.find((entry) => entry.routeId === id);
  assert.equal(found.entries.length, 3);
  // A deposit's DuskEVM address is the one its call names.
  const toDuskEvm = route("dusk-to-dusk-evm");
  assert.deepEqual([toDuskEvm.hash, toDuskEvm.amountLux, toDuskEvm.destination.toLowerCase(), toDuskEvm.sourceAt], [h(1), "100000000", EVM, 1_792_980_000_000]);
  const toBridge = route("dusk-to-ethereum");
  assert.deepEqual([toBridge.hash, toBridge.amountLux, toBridge.destination, toBridge.sourceAt], [h(2), "50000000000", "0xeE1b68ED496712cda857ada41d326d357049E51C", 1_792_980_100_000]);
  const migrated = route("ethereum-to-dusk");
  assert.deepEqual([migrated.hash, migrated.destinationHash, migrated.destinationAt, migrated.status], [memo, h(3), 1_792_980_200_000, "completed"]);
  // Of the account's history, only the bridge's transfers are kept.
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(stateKey(cfg, "dusk", ACCOUNT))).entries).sort(), [h(1), h(2), h(3)]);
  const hashes = (list) => list.map((entry) => entry.hash).sort();
  // The next visit lists them again.
  const next = await createDiscovery({ archive: node.archive, cfg, storage }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual(hashes(next.entries), hashes(found.entries));
  // Storage that refuses them: the visit still lists them.
  const full = Object.assign(memoryStorage(), { setItem: () => assert.fail("QuotaExceededError") });
  const unkept = await createDiscovery({ archive: archiveNode(node.entries, { details: node.details, finalized: tip }).archive, cfg, storage: full }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual(hashes(unkept.entries), hashes(found.entries));

  // Without DuskEVM configured, a deposit is nobody's business here.
  const without = archiveNode(node.entries, { details: node.details, finalized: tip });
  const off = await createDiscovery({ archive: without.archive, cfg: { ...cfg, duskEvm: { ...cfg.duskEvm, enabled: false } }, storage: memoryStorage() }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual(off.entries.map((entry) => entry.routeId).sort(), ["dusk-to-ethereum", "ethereum-to-dusk"]);
});

test("discovery keeps each account's progress per network and asks again only for what's new", async () => {
  const tip = 1_000_000;
  const node = archiveNode([deposit(1, tip - 50)], { details: { [h(1)]: sent(1_761_471_064, DEPOSIT_CALL) }, finalized: tip });
  const storage = memoryStorage();
  const discovery = createDiscovery({ archive: node.archive, cfg, rpc: async () => assert.fail("no EVM address given"), storage });
  const busy = (what) => (body) => (body.includes(what) ? new Response("busy", { status: 500 }) : null);
  // The second window's request fails: the visit says so, and keeps what it read before.
  let windows = 0;
  node.before = (body) => (body.includes("moonlightHistory") && ++windows === 2 ? busy("moonlightHistory")(body) : null);
  assert.equal((await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 })).errors.length, 1);
  const kept = JSON.parse(storage.getItem(stateKey(cfg, "dusk", ACCOUNT)));
  assert.deepEqual([Object.keys(kept.entries), kept.covered.length], [[h(1)], 1]);
  assert.ok([...storage.keys()].every((key) => key.startsWith("dusk-bridge:discovery:v1:testnet:dusk:")));

  // Details the node can't give now are left for the tracker, and read on the next visit.
  node.before = busy("tx(hash:");
  node.finalized = tip + 100;
  const asked = node.calls.length;
  const later = await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 });
  assert.deepEqual([later.entries.map((entry) => [entry.routeId, entry.hash, entry.sourceAt]), later.errors], [[["dusk-to-dusk-evm", h(1), undefined]], []]);
  // No height is read twice: what's new above, then on down from where the first visit stopped.
  const [[lo, hi]] = kept.covered;
  for (const call of node.calls.slice(asked).filter((body) => body.includes("moonlightHistory"))) {
    const [, from, to = Infinity] = /fromBlock: (\d+)(?:, toBlock: (\d+))?/u.exec(call);
    assert.ok(Number(from) > hi || Number(to) < lo, call);
  }

  node.before = null;
  assert.deepEqual((await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 })).entries.map((entry) => entry.sourceAt), [1_761_471_064_000]);
  // Its time was kept: the next visit asks no details.
  const read = node.calls.length;
  await discovery.discover({ dusk: ACCOUNT, duskRequests: 3 });
  assert.ok(!node.calls.slice(read).some((body) => body.includes("tx(hash:")));
});

test("what an earlier version kept carries on, and a testnet reset starts it over", async () => {
  const tip = 1_000_000;
  const memo = `0x${"ab".repeat(32)}`;
  const key = stateKey(cfg, "dusk", ACCOUNT);
  const storage = memoryStorage();
  // As the bridge kept it before: no genesis, a deposit with its time, a verified
  // payout above the heights covered, which the archive gives again, and two it
  // checked on the migration's chain: one it couldn't ask yet, one it rejected.
  const unverified = `0x${"cd".repeat(32)}`;
  storage.setItem(
    key,
    JSON.stringify({
      covered: [[0, tip - 10]],
      crowded: null,
      entries: {
        [h(1)]: { amountLux: "100000000", blockHeight: tip - 50, destination: EVM, hash: h(1), kind: "deposit", sourceAt: 1_761_471_064_000 },
        [h(3)]: { amountLux: "1000000000000", blockHeight: tip - 5, hash: h(3), kind: "payout", payer: OTHER, payoutAt: 1_761_471_000_000, routeId: "ethereum-to-dusk", sender: "0xabc", sourceHash: memo },
        [h(6)]: { amountLux: "5", blockHeight: tip - 40, hash: h(6), kind: "payout", payer: OTHER, sourceHash: unverified },
        [h(7)]: { amountLux: "5", blockHeight: tip - 30, hash: h(7), kind: "payout", payer: OTHER, rejected: true, sourceHash: `0x${"ef".repeat(32)}` },
      },
      target: tip - 10,
      updatedAt: 1,
      window: 8_640,
    }),
  );
  const node = archiveNode([payout(3, tip - 5, memo), service(2, tip + 50)], { details: { [h(2)]: sent(1_792_980_100) }, finalized: tip + 100 });
  const discovery = createDiscovery({ archive: node.archive, cfg, storage });
  const kept = await discovery.discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual(kept.entries.map((entry) => entry.hash).sort(), [h(1), h(2), memo, unverified].sort());
  // The payout account vouches for the one not verified yet.
  assert.equal(kept.entries.find((entry) => entry.hash === unverified).routeId, "ethereum-to-dusk");
  // Above what was kept, with the head, then the new transfer's details.
  const asked = (calls) => calls.map((body) => /fromBlock: (\d+)/u.exec(body)?.[1] ?? (body.includes("tx(hash:") ? "details" : "head"));
  assert.deepEqual(asked(node.calls), [String(tip - 9), "details"]);
  assert.equal(JSON.parse(storage.getItem(key)).genesis, node.genesis);

  // Another chain under the same node: what was kept of the old one goes.
  node.genesis = "bb".repeat(32);
  node.entries = [];
  const reset = await discovery.discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual([reset.entries, reset.errors], [[], []]);
  assert.equal(JSON.parse(storage.getItem(key)).genesis, "bb".repeat(32));

  // A run whose history another tab cleared meanwhile keeps nothing more, and says nothing.
  storage.delete(key);
  node.entries = [service(2, tip + 50)];
  node.before = (body) => void (body.includes("moonlightHistory") && storage.setItem(key, "null"));
  const overtaken = await discovery.discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual([overtaken.entries, overtaken.errors, storage.getItem(key)], [[], [], "null"]);

  // A reset where storage still has the old chain's history but refuses writes: the visit carries on in memory.
  node.before = null;
  await discovery.discover({ dusk: ACCOUNT, duskRequests: 6 });
  const refusing = Object.assign(memoryStorage([[key, storage.getItem(key)]]), { setItem: () => assert.fail("QuotaExceededError") });
  node.genesis = "cc".repeat(32);
  const inMemory = await createDiscovery({ archive: node.archive, cfg, storage: refusing }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual([inMemory.entries.map((entry) => entry.hash), inMemory.errors], [[h(2)], []]);
});

// Mainnet, with one account paying out both chains' migrations, as a deployment can set it.
const sharedPayer = {
  ...cfg,
  network: { ...networks.mainnet, routes: { ...networks.mainnet.routes, migrations: networks.mainnet.routes.migrations.map((route) => ({ ...route, payoutAccount: OTHER })) } },
};

test("a migration found by its payout is of what the payout paid, and on the route its payer pays out", async () => {
  const tip = 1_000_000;
  const memo = `0x${"ab".repeat(32)}`;
  // The payout refunded its unspent gas to the account too.
  const refunded = payout(3, tip - 80, memo);
  refunded.events[0].data.refund_info = [ACCOUNT, "500"];
  const node = archiveNode([refunded], { details: { [h(3)]: sent(1_792_980_200) }, finalized: tip });
  const found = await createDiscovery({ archive: node.archive, cfg, storage: memoryStorage() }).discover({ dusk: ACCOUNT, duskRequests: 6 });

  assert.deepEqual(found.entries.map((entry) => [entry.routeId, entry.amountLux, entry.status]), [["ethereum-to-dusk", "1000000000000", "completed"]]);

  // Paid by an account that pays out both chains' migrations: which one, its transfer doesn't say.
  const storage = memoryStorage();
  const shared = await createDiscovery({ archive: archiveNode([refunded], { details: node.details, finalized: tip }).archive, cfg: sharedPayer, storage }).discover({ dusk: ACCOUNT, duskRequests: 6 });
  assert.deepEqual([shared.entries, JSON.parse(storage.getItem(stateKey(sharedPayer, "dusk", ACCOUNT))).entries], [[], {}]);
  // Nor, unverified, as an earlier version kept it.
  const kept = { amountLux: "5", blockHeight: 1, hash: h(6), kind: "payout", payer: OTHER, sourceHash: memo };
  assert.equal(entryFromHistory(kept, ACCOUNT, cfg).routeId, "ethereum-to-dusk");
  assert.equal(entryFromHistory(kept, ACCOUNT, sharedPayer), null);
});

test("an amount already known stays when another read gives another, as a payout's gas refund would", () => {
  const memo = `0x${"ab".repeat(32)}`;
  const tracked = { amountLux: "1000000000000", hash: memo, id: `ethereum-to-dusk:${memo}`, routeId: "ethereum-to-dusk", status: "completed" };
  const merged = mergeTransfer(tracked, { amountLux: "1000000000500", destinationHash: h(3), hash: memo, id: tracked.id, routeId: "ethereum-to-dusk", status: "completed" });

  assert.deepEqual([merged.amountLux, merged.destinationHash], ["1000000000000", h(3)]);
  // Until one is known, a read gives it.
  assert.equal(mergeTransfer({ ...tracked, amountLux: undefined }, { amountLux: "7", id: tracked.id }).amountLux, "7");
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
