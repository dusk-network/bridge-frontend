import assert from "node:assert/strict";
import test from "node:test";

import { encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toHex, toRlp } from "viem";

import { WITHDRAWAL_GAS_REFUSAL, gasAtNodePrice, withdrawalGasLimit } from "./gas.js";
import {
  GAME_REGISTRY_DRIVER,
  NOT_A_DUSK_WITHDRAWAL,
  createWithdrawals,
  hashOutputRootProof,
  hashWithdrawal,
  parseGameSearchDepth,
  parseWithdrawalReceipt,
  proofRequiresReplacement,
  withdrawalDetails,
} from "./withdrawals.js";
import { contractFacade, createContractReader } from "./contract-reader.js";
import { DUSK_WALLET_BRIDGE_CONTRACTS, duskCallLines } from "./wallet-lines.js";
import { decodeBase58 } from "./base58.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const RELAY = parseAbi([
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message)",
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData)",
]);

// A DuskEVM withdrawal of 10 DUSK (web wallet fixture): relayMessage(...) to
// L1's bridge, finalizeBridgeETH(from, to, amount, Dusk recipient).
const messagePassedLog = {
  address: "0x4200000000000000000000000000000000000016",
  blockHash: "0x5510dbadb5bce778c1b7b331d37fcc0c86f2fe55f7b60f83b6d678b60f7726e0",
  blockNumber: "0x3564",
  data: "0x0000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000007ed760000000000000000000000000000000000000000000000000000000000000080e78b3f4d6f313300774677027a3a41540ab6eeaed0c3464d5865d53553fc27860000000000000000000000000000000000000000000000000000000000000284d764ad0b00010000000000000000000000000000000000000000000000000000000000070000000000000000000000004200000000000000000000000000000000000010000000000000000000000000f44f202151ffb9742ad4391849c62be3fb441e720000000000000000000000000000000000000000000000008ac7230489e800000000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001841635f5fd000000000000000000000000eb9ea22334e679cdbc669cf9ad2d713b559708b1000000000000000000000000eb9ea22334e679cdbc669cf9ad2d713b559708b10000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c200fafd19fa981abfac15b121a37fabbf45d8e5630d79da8d13fae7c3c5dd03afb611f1c468c1b5961b5ecdfff7bc85c319b53a1d9979c7c041926e5b7cbf5e4dfe5adc1369895d5e341a7651079b25663c58909f2cf400d4cb70651413c5cd06185747ff4aac9dfe2d947fb6fdbf470562e3ee884afbf66427e4171dc95bc41ba64f5d97e6859cb85b307108b51f15c801d14c78437c13edef03ad3d455193020a6a1c99858112912522dace4683191ae1274ddfea6e686a9724eed4012029e913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  logIndex: "0x2",
  removed: false,
  topics: [
    "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054",
    "0x0001000000000000000000000000000000000000000000000000000000000007",
    "0x0000000000000000000000004200000000000000000000000000000000000007",
    "0x00000000000000000000000004ffbc4c863235f94f99ccc849de181a1ab74759",
  ],
  transactionHash: "0x57ac2440f740f3cdd4c90c758dcf28be7b35ed496d8b580958693d2e37883a57",
  transactionIndex: "0x1",
};
const TX = messagePassedLog.transactionHash;
const SUBMITTER = `0x${"2c".repeat(20)}`;
// Testnet's contracts count Dusk block height × 10. The tip, as read on
// 28 Oct 2026, and wallet-both.dusk's 1 DUSK withdrawal, the worked
// example: proved at block 4,687,744, its game created at 4,687,605.
const TIP = Object.freeze({ height: 4_704_959n, timestamp: 1_793_156_989n });
const PROVEN_AT = 46_877_440n;
const GAME_CREATED = 46_876_050n;
/** A contract time on the wall clock, in seconds, counted from the tip. */
const wall = (seconds, tip = TIP) => tip.timestamp + seconds - 10n * tip.height;
/** A proof long matured, against a game resolved and final long ago: claimable now. */
const CLAIMABLE = Object.freeze({ createdAt: 45_250_000n, gameStatus: 2, provenAt: 45_252_320n, resolvedAt: 45_555_010n });
const HUB_ID = "d5".repeat(32);

function u256(value) {
  let remaining = BigInt(value);
  const out = Array(32).fill(0);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** A spy: records calls, answers from `impl`. */
function fn(impl) {
  const spy = async (...args) => {
    spy.calls.push(args);
    return impl(...args);
  };
  spy.calls = [];
  return spy;
}

function setup({
  logs = [messagePassedLog],
  finalized = false,
  preflight = async () => undefined,
  gameStatus = 0,
  createdAt = GAME_CREATED,
  resolvedAt = 0n,
  provenAt = PROVEN_AT,
  proofMaturity = 604_800,
  tip = TIP,
  gasUpper = 1_000_000_000n,
  submitterCount = 1,
  l2 = null,
  registry = { call: { isGameProper: fn(async () => true), isGameRespected: fn(async () => true), respectedGameTypeUpdatedAt: fn(async () => 0n) } },
} = {}) {
  const portal = {
    call: {
      checkWithdrawal: fn(preflight),
      disputeGameBlacklist: fn(async () => false),
      disputeGameFinalityDelaySeconds: fn(async () => u256(302_400)),
      finalizedWithdrawals: fn(async () => finalized),
      numProofSubmitters: fn(async () => u256(submitterCount)),
      proofMaturityDelaySeconds: fn(async () => u256(proofMaturity)),
      provenWithdrawals: fn(async () => [Array(20).fill(0x1e), provenAt]),
      respectedGameType: fn(async () => 8),
    },
  };
  // The factory names one hub, for the Portal's game type and for each game.
  const dgf = { call: { gameContractId: fn(async () => Array(32).fill(0xd5)), gameCount: fn(async () => u256(0)), virtualGameHubId: fn(async () => Array(32).fill(0xd5)) } };
  // The game's hub on Dusk: its times are the contracts' own.
  const hub = {
    call: {
      createdAtForGame: fn(async () => createdAt),
      maxClockDuration: fn(async () => 302_400n),
      resolvedAtForGame: fn(async () => resolvedAt),
      statusForGame: fn(async () => gameStatus),
    },
  };
  const hubIds = [];
  const sent = [];
  const withdrawals = createWithdrawals({
    dgf,
    gasPrice: async () => 2n,
    gasUpper,
    hub: (id) => {
      hubIds.push(id);
      return hub;
    },
    // Nothing is asked of the DuskEVM adapter's L1 view any more.
    l1Rpc: () => assert.fail("the game is read on Dusk, not through an L1 RPC"),
    l2Rpc: async (method, params) => {
      // DuskEVM's blocks and storage proofs, where a test gives them.
      if (l2 && method !== "eth_getTransactionReceipt") return l2(method, params);
      assert.equal(method, "eth_getTransactionReceipt");
      return {
        blockHash: messagePassedLog.blockHash,
        blockNumber: messagePassedLog.blockNumber,
        logs,
        status: "0x1",
        transactionHash: TX,
      };
    },
    latestBlock: async () => tip,
    portal,
    proofSubmitter: () => SUBMITTER,
    registry,
    sendPortalCall: async (fnName, args, gas) => {
      sent.push({ args, fnName, gas });
      return { hash: "finalize-hash" };
    },
  });
  return { dgf, hub, hubIds, portal, registry, sent, withdrawals };
}

const invalidGame = async () => {
  throw new Error("OptimismPortal2: invalid dispute game");
};

test("proofs and claims get a large gas limit, within the bound, at the node's price", async () => {
  assert.equal(withdrawalGasLimit(), 51_000_000n);
  assert.equal(withdrawalGasLimit(519_542n), 51_000_000n);
  assert.equal(withdrawalGasLimit(9_000_000n), 59_000_000n);
  assert.equal(withdrawalGasLimit(950_000_000n), 1_000_000_000n);
  assert.throws(() => withdrawalGasLimit(950_000_001n), { message: WITHDRAWAL_GAS_REFUSAL });
  assert.deepEqual(await gasAtNodePrice(5_000_000n, { gasPrice: async () => 3n }), {
    limit: "5000000",
    price: "3",
  });
});

test("the game search depth falls back to a positive value", () => {
  assert.equal(parseGameSearchDepth("128"), 128n);
  assert.equal(parseGameSearchDepth("0"), 64n);
  assert.equal(parseGameSearchDepth("not-a-number"), 64n);
});

test("blacklisted or challenger-won proofs need replacing", () => {
  assert.equal(proofRequiresReplacement({ gameStatus: 0, isGameBlacklisted: false }), false);
  assert.equal(proofRequiresReplacement({ gameStatus: 1, isGameBlacklisted: false }), true);
  assert.equal(proofRequiresReplacement({ gameStatus: 2, isGameBlacklisted: true }), true);
});

test("a withdrawal's amount and Dusk recipient come from its relayed call", async () => {
  const { withdrawals } = setup();
  const status = await withdrawals.loadWithdrawalStatus(TX);
  const details = withdrawalDetails(status.withdrawal);

  assert.equal(details.amountWei, 10_000_000_000_000_000_000n);
  assert.match(details.recipientSubmitter, /^0x[0-9a-f]{40}$/u);
  assert.equal(details.from.toLowerCase(), "0xeb9ea22334e679cdbc669cf9ad2d713b559708b1");
});

test("a proven withdrawal waits when the finalize preflight refuses", async () => {
  const { portal, withdrawals } = setup({ preflight: invalidGame });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  assert.match(status.statusMessage, /dispute game is still in progress/u);
  const [[[hash, submitter]]] = portal.call.checkWithdrawal.calls;
  assert.equal(hash.length, 32);
  assert.deepEqual(submitter, Array(20).fill(0x2c));
});

test("the claim date of wallet-both.dusk's withdrawal: the earliest its proof and game allow, as an estimate", async () => {
  // wallet-both.dusk's 1 DUSK withdrawal, its game in progress on 28 Oct.
  const { hub, hubIds, withdrawals } = setup({ preflight: invalidGame });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  // Mon 2 Nov, 03:20:39 UTC: the proof's maturity, if the game resolves on time.
  assert.equal(status.readyAt, 1_793_589_639n);
  assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:20:39.000Z");
  assert.equal(status.readyAtExact, false);
  assert.equal(status.claimOverdue, false);
  // The proof time is converted from block height × 10, not dropped: 26 Oct, 03:20:39 UTC.
  assert.equal(status.provenAt, wall(PROVEN_AT));
  assert.equal(new Date(Number(status.provenAt) * 1_000).toISOString(), "2026-10-26T03:20:39.000Z");
  assert.equal(status.proofRejected, false);
  // The game is read on Dusk, from the hub the factory names for the Portal's game type.
  assert.deepEqual(hubIds, [HUB_ID]);
  assert.equal(hub.call.createdAtForGame.calls.length, 1);
});

test("the claim date is exact once the proven game has resolved", async () => {
  // Resolved 161 blocks after its earliest time, the resolver's median.
  const { withdrawals } = setup({ gameStatus: 2, preflight: invalidGame, resolvedAt: 47_180_060n });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  // The game's finality comes after the proof's maturity: Mon 2 Nov, 03:24:19 UTC.
  assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:24:19.000Z");
  assert.equal(status.readyAtExact, true);
});

test("a proof whose game the challenger won is named as rejected", async () => {
  const { withdrawals } = setup({ gameStatus: 1, preflight: invalidGame, resolvedAt: 47_180_060n });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.proofRejected, true);
  assert.equal(status.readyAt, null);
  assert.equal(status.stage, "proven_waiting");
});

test("a game left unresolved an hour past its clock is overdue, and the claim is the earliest still possible", async () => {
  // 400 blocks past the game's earliest resolution, still in progress.
  const tip = { height: 4_718_245n, timestamp: 1_793_289_849n };
  const { withdrawals } = setup({ preflight: invalidGame, tip });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.claimOverdue, true);
  assert.equal(status.readyAtExact, false);
  // It could resolve now: final 3.5 days from now, after the proof's maturity.
  assert.equal(status.readyAt, wall(10n * tip.height + 302_400n, tip));
});

test("a proof on the height clock is converted from the tip, not dropped", async () => {
  // The 1,008 DUSK withdrawal another account proved at block 4,525,232,
  // its game resolved at 4,555,501: claimable for it since block 4,585,741.
  const { withdrawals } = setup({ createdAt: 45_250_000n, gameStatus: 2, provenAt: 45_252_320n, resolvedAt: 45_555_010n });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "ready_to_finalize");
  assert.equal(status.readyAt, wall(45_857_410n));
  assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-10-14T08:00:09.000Z");
  assert.equal(status.provenAt, wall(45_252_320n));
});

test("a rejected proof with no replacement output is named as rejected", async () => {
  const { withdrawals } = setup({
    gameStatus: 1,
    preflight: invalidGame,
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.proofRejected, true);
  assert.equal(status.stage, "proven_waiting");
});

test("a withdrawal's waits come from the Portal, and how often outputs come from the latest games", async () => {
  const { dgf, withdrawals } = setup({ proofMaturity: 604_800 });
  dgf.call.gameCount = fn(async () => u256(3_915));
  // As DuskEVM testnet's: an output every 170 Dusk blocks, one late by as much again.
  const stamps = [46_986_550, 46_984_850, 46_983_150, 46_979_750, 46_978_050, 46_976_350];
  dgf.call.findLatestGames = fn(async () => stamps.map((timestamp, index) => ({ index: u256(3_914 - index), timestamp })));
  assert.deepEqual(await withdrawals.loadTiming(), { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 });
  // The latest six games of the type the Portal takes.
  assert.deepEqual(dgf.call.findLatestGames.calls[0][0], [8, u256(3_914), u256(6)]);
  // No games yet: nothing says how often outputs come.
  dgf.call.gameCount = fn(async () => u256(0));
  assert.equal((await withdrawals.loadTiming()).outputSeconds, null);
});

test("a withdrawal's waits are two node queries through Multicall for Dusk", async () => {
  const queries = [];
  const node = {
    async contractCall(_id, fnName, bytes) {
      queries.push(fnName);
      const calls = JSON.parse(new TextDecoder().decode(bytes));
      return new TextEncoder().encode(JSON.stringify({ height: "1", results: calls.map((call) => ({ Ok: Buffer.from(call.fn_name).toString("hex") })) }));
    },
  };
  const answers = {
    disputeGameFinalityDelaySeconds: u256(302_400),
    findLatestGames: [{ timestamp: 3_400 }, { timestamp: 1_700 }],
    gameCount: u256(2),
    proofMaturityDelaySeconds: u256(604_800),
    respectedGameType: 8,
  };
  const driver = {
    decodeOutputFn: (name, out) => (name === "aggregate" ? JSON.parse(new TextDecoder().decode(out)) : answers[new TextDecoder().decode(out)]),
    encodeInputFn: (name, json) => new TextEncoder().encode(name === "aggregate" ? json : name),
  };
  const contract = (id) => ({ driver: async () => driver, id });
  const reader = createContractReader({ multicall: contract("93".repeat(32)), node });
  const timing = createWithdrawals({ dgf: contractFacade(reader, contract("3b".repeat(32))), portal: contractFacade(reader, contract("14".repeat(32))) });
  assert.deepEqual(await timing.loadTiming(), { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 });
  assert.deepEqual(queries, ["aggregate", "aggregate"]);
});

test("a finalized withdrawal isn't claimed again", async () => {
  const { sent, withdrawals } = setup({ finalized: true });

  await assert.rejects(withdrawals.finalizeWithdrawal(TX), /already finalized/u);
  assert.equal(sent.length, 0);
});

test("a claim that needs more gas than the bound isn't sent", async () => {
  const { sent, withdrawals } = setup({ ...CLAIMABLE, gasUpper: 50_000_000n });

  await assert.rejects(withdrawals.finalizeWithdrawal(TX), { message: WITHDRAWAL_GAS_REFUSAL });
  assert.equal(sent.length, 0);
});

test("a claim sends the SDK-serialized withdrawal with its own gas on top", async () => {
  const { sent, withdrawals } = setup(CLAIMABLE);

  assert.equal(await withdrawals.finalizeWithdrawal(TX), "finalize-hash");
  const [{ args, fnName, gas }] = sent;
  assert.equal(fnName, "finalizeWithdrawalTransaction");
  // 50M plus the 519,542 gas the withdrawal asks for, raised to the 1M bound
  // the proof uses too, at the node's price.
  assert.deepEqual(gas, { limit: "51000000", price: "2" });
  assert.deepEqual(args.data.slice(0, 4), [0xd7, 0x64, 0xad, 0x0b]);
  assert.equal(args.gas_limit.length, 32);
  assert.equal(args.sender.length, 20);
  assert.equal(args.target.length, 20);

  // The claim carries its withdrawal, so the review lists what Dusk Wallet
  // reads from the call. This one's extra data is in an older form that
  // names no Dusk account, so the window shows a plain contract call.
  const prepared = await withdrawals.prepareFinalize(TX);
  const claimLines = (withdrawal) => {
    const details = withdrawalDetails(withdrawal);
    return duskCallLines({
      chainId: "dusk:2",
      contractId: DUSK_WALLET_BRIDGE_CONTRACTS["dusk:2"].portal,
      fnArgs: [1],
      fnName: prepared.fnName,
      gas: prepared.gas,
      withdrawal: details && { ...details, value: withdrawal.value },
    });
  };
  assert.equal(withdrawalDetails(prepared.withdrawal).amountWei, 10n * 10n ** 18n);
  assert.equal((await claimLines(prepared.withdrawal))[0].title, "Contract call");

  // The same withdrawal paying a Dusk account as the bridge writes it now.
  const relay = decodeFunctionData({ abi: RELAY, data: prepared.withdrawal.data });
  const bridged = decodeFunctionData({ abi: RELAY, data: relay.args[5] });
  const extraData = encodeDuskExternalAssetRecipient(decodeBase58(ACCOUNT));
  const message = encodeFunctionData({ abi: RELAY, args: [...bridged.args.slice(0, 3), extraData], functionName: "finalizeBridgeETH" });
  const lines = await claimLines({ ...prepared.withdrawal, data: encodeFunctionData({ abi: RELAY, args: [...relay.args.slice(0, 5), message], functionName: "relayMessage" }) });
  // The window leads with what the claim costs, then the withdrawal it's for.
  assert.deepEqual(
    [lines[0].title, lines[0].lead, lines[0].amount, lines[0].prefix, lines[0].tag],
    ["Claim a DuskEVM withdrawal", "Costs up to", "0.102 DUSK", "for a 10 DUSK withdrawal that pays", "Known DuskEVM bridge call"],
  );
  assert.deepEqual(lines.slice(1, 4).map((line) => [line.label, line.address ?? line.value]), [
    ["Pays to", ACCOUNT],
    ["Amount", "10 DUSK"],
    ["Sent from DuskEVM", "0xEb9Ea22334e679cDbC669cF9AD2d713b559708B1"],
  ]);
});

test("a status check reads the Portal and game factory in one node query", async () => {
  const queries = [];
  const node = {
    async contractCall(id, fnName) {
      queries.push(fnName);
      // Each inner call answers with its function name; the test only counts.
      return new TextEncoder().encode(
        JSON.stringify({
          height: "1",
          results: Array.from({ length: 7 }, () => ({ Ok: "00" })),
        }),
      );
    },
  };
  const values = { finalizedWithdrawals: true, provenWithdrawals: [Array(20).fill(0), 0] };
  const driver = {
    decodeOutputFn: (name, bytes) =>
      name === "aggregate" ? JSON.parse(new TextDecoder().decode(bytes)) : (values[name] ?? 0),
    encodeInputFn: () => new Uint8Array(),
  };
  const contract = (id) => ({ driver: async () => driver, id });
  const reader = createContractReader({ multicall: contract("93".repeat(32)), node });
  const portal = contractFacade(reader, contract("14".repeat(32)));
  const dgf = contractFacade(reader, contract("3b".repeat(32)));
  const batched = createWithdrawals({
    dgf,
    gasPrice: async () => 1n,
    gasUpper: 1_000_000_000n,
    l1Rpc: null,
    l2Rpc: async () => ({
      blockHash: messagePassedLog.blockHash,
      blockNumber: messagePassedLog.blockNumber,
      logs: [messagePassedLog],
      status: "0x1",
      transactionHash: TX,
    }),
    latestTimestamp: async () => 0n,
    portal,
    proofSubmitter: () => SUBMITTER,
    sendPortalCall: async () => ({ hash: "" }),
  });

  const status = await batched.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "finalized");
  assert.deepEqual(queries, ["aggregate"]);
});

// A MessagePassed event as the L2 message passer writes it, hash included.
const MESSAGE_PASSED = parseAbi([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);
const BRIDGE_ABI = parseAbi([
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message)",
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData)",
  "function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes _extraData)",
]);
const MESSENGER = "0x4200000000000000000000000000000000000007";
const L2_BRIDGE = "0x4200000000000000000000000000000000000010";
const L1_SIDE = "0xf44f202151ffb9742ad4391849c62be3fb441e72";
const USER = "0xeb9ea22334e679cdbc669cf9ad2d713b559708b1";

function passedLog({ amount = 10n ** 19n, message, relaySender = L2_BRIDGE, relayValue = amount, sender = MESSENGER, value = amount }) {
  const data = encodeFunctionData({
    abi: BRIDGE_ABI,
    args: [7n, relaySender, L1_SIDE, relayValue, 200_000n, message ?? encodeFunctionData({ abi: BRIDGE_ABI, args: [USER, USER, amount, "0x00"], functionName: "finalizeBridgeETH" })],
    functionName: "relayMessage",
  });
  const withdrawal = { data, gasLimit: 519_542n, nonce: 7n, sender, target: L1_SIDE, value };
  return {
    address: "0x4200000000000000000000000000000000000016",
    blockNumber: "0x3564",
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }],
      [value, withdrawal.gasLimit, data, hashWithdrawal(withdrawal)],
    ),
    logIndex: "0x2",
    topics: encodeEventTopics({ abi: MESSAGE_PASSED, args: { nonce: 7n, sender, target: L1_SIDE }, eventName: "MessagePassed" }),
    transactionHash: TX,
  };
}

test("only the bridge's own DUSK withdrawals are followed, proved or claimed", async () => {
  const receipt = (log) => ({ blockNumber: "0x3564", logs: [log], status: "0x1", transactionHash: TX });
  // The fixture and one built the same way are withdrawals of DUSK.
  assert.equal(parseWithdrawalReceipt(receipt(messagePassedLog)).withdrawal.value, 10n ** 19n);
  assert.equal(parseWithdrawalReceipt(receipt(passedLog({}))).withdrawal.value, 10n ** 19n);

  const others = {
    // A token withdrawal through the same bridge and messenger.
    token: passedLog({
      amount: 0n,
      message: encodeFunctionData({ abi: BRIDGE_ABI, args: [USER, USER, USER, USER, 5n, "0x"], functionName: "finalizeBridgeERC20" }),
    }),
    // A message sent to the passer directly, shaped like the bridge's.
    direct: passedLog({ sender: USER }),
    // The bridge's call, sent through the messenger by someone else.
    relayed: passedLog({ relaySender: USER }),
    // A message claiming more than it carries.
    inflated: passedLog({ value: 1n }),
  };
  for (const [name, log] of Object.entries(others)) {
    assert.throws(() => parseWithdrawalReceipt(receipt(log)), { message: NOT_A_DUSK_WITHDRAWAL }, name);
    const { sent, withdrawals } = setup({ logs: [log] });
    await assert.rejects(withdrawals.loadWithdrawalStatus(TX), { message: NOT_A_DUSK_WITHDRAWAL }, name);
    await assert.rejects(withdrawals.proveWithdrawal(TX), { message: NOT_A_DUSK_WITHDRAWAL }, name);
    await assert.rejects(withdrawals.finalizeWithdrawal(TX), { message: NOT_A_DUSK_WITHDRAWAL }, name);
    assert.equal(sent.length, 0, name);
  }
});

test("a proof this account already has isn't prepared again", async () => {
  // Proven by this account (the setup's submitter): ready to claim, still
  // waiting, rejected with no newer output to prove against, or claimed.
  const rejected = async () => {
    throw new Error("OptimismPortal2: invalid dispute game");
  };
  const cases = [
    [CLAIMABLE, "This account already proved this withdrawal. You can claim it now."],
    [{ preflight: rejected }, "This account already proved this withdrawal. Claim it once the waiting period ends."],
    [{ gameStatus: 1, preflight: rejected }, "The existing proof was rejected, but no replacement output proposal is available yet."],
    [{ finalized: true }, "This withdrawal is already claimed."],
  ];
  for (const [options, message] of cases) {
    const { sent, withdrawals } = setup(options);
    await assert.rejects(withdrawals.prepareProve(TX), { message });
    await assert.rejects(withdrawals.proveWithdrawal(TX), { message });
    assert.deepEqual(sent, []);
  }
  // Not proven yet: it goes on to look for the output to prove against.
  await assert.rejects(setup({ provenAt: 0n }).withdrawals.prepareProve(TX), /No dispute games have been proposed yet/u);
});

test("a withdrawal whose claim would need more gas than the bound isn't proved", async () => {
  // Not proven yet: the refusal comes before the proof is looked for.
  const { sent, withdrawals } = setup({ gasUpper: 50_000_000n, provenAt: 0n });
  await assert.rejects(withdrawals.prepareProve(TX), { message: WITHDRAWAL_GAS_REFUSAL });
  assert.deepEqual(sent, []);
});

test("a proof or claim is prepared for the account its review is for", async () => {
  const other = `0x${"3d".repeat(20)}`;
  const asked = (portal) => [...new Set(portal.call.provenWithdrawals.calls.map(([[, who]]) => `0x${Buffer.from(who).toString("hex")}`))];
  const claim = setup();
  await claim.withdrawals.prepareFinalize(TX, { proofSubmitter: other }).catch(() => {});
  assert.deepEqual(asked(claim.portal), [other]);
  const proof = setup({ provenAt: 0n });
  await proof.withdrawals.prepareProve(TX, { proofSubmitter: other }).catch(() => {});
  assert.deepEqual(asked(proof.portal), [other]);
});

// ---------------------------------------------------------------------------
// Proving against a game that has already resolved, and one query a check
// ---------------------------------------------------------------------------

const GAMES = 200;
const OUTPUT_GAP = 1_800n;
const NOW = 10n * TIP.height;
// Game i: created every 30 minutes up to 10 minutes ago, each covering 100 L2
// blocks more; resolved 15 minutes after its clock ran out, if that's passed.
const createdAtOf = (i) => NOW - 600n - BigInt(GAMES - 1 - i) * OUTPUT_GAP;
const proxyOf = (i) => [...Array(18).fill(0x9a), Math.floor(i / 256), i % 256];
const resolvedOf = (i) => (createdAtOf(i) + 302_400n + 900n <= NOW ? createdAtOf(i) + 302_400n + 900n : 0n);
const blockOf = (l2) => ({ hash: keccak256(toHex(`block ${l2}`)), stateRoot: keccak256(toHex(`state ${l2}`)) });
const STORAGE = keccak256(toHex("message passer"));
const rootOf = (l2) =>
  hashOutputRootProof({ latestBlockhash: blockOf(l2).hash, messagePasserStorageRoot: STORAGE, stateRoot: blockOf(l2).stateRoot, version: `0x${"00".repeat(32)}` });

/**
 * A not yet proven withdrawal at L2 block 13,668, with games whose L2 blocks
 * start at `firstL2`. Game i sits at factory index i × `stride`: other game
 * types take the indexes between. The registry the Portal asks calls the
 * `blacklisted` and `retired` games improper, and the `unrespected` ones not
 * respected; the respected game type last changed at `updatedAt`. Without
 * the registry (`registry: false`), none is checked.
 */
function provingSetup({ blacklisted = [], firstL2, registry = true, retired = [], stride = 1, unrespected = [], updatedAt = 0n }) {
  const l2Of = (i) => firstL2 + i * 100;
  const searched = (i) => ({
    extra_data: u256(l2Of(i)),
    index: u256(i * stride),
    metadata: [0, 0, 0, 8, ...u256(createdAtOf(i)).slice(24), ...proxyOf(i)],
    root_claim: Array.from(Buffer.from(rootOf(l2Of(i)).slice(2), "hex")),
    timestamp: Number(createdAtOf(i)),
  });
  const indexOf = (address) => address[18] * 256 + address[19];
  const gameAt = (index) => Math.floor(index / stride);
  // DuskEVM: each block, and the withdrawal's storage proof at it.
  const proofsAt = [];
  const l2 = async (method, params) => {
    if (method === "eth_getBlockByNumber") return blockOf(Number(BigInt(params[0])));
    proofsAt.push(Number(BigInt(params[2])));
    return { storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] };
  };
  const proved = setup({
    l2,
    provenAt: 0n,
    registry: registry
      ? {
          call: {
            isGameProper: fn(async (address) => ![...blacklisted, ...retired].includes(indexOf(address))),
            isGameRespected: fn(async (address) => !unrespected.includes(indexOf(address))),
            respectedGameTypeUpdatedAt: fn(async () => updatedAt),
          },
        }
      : null,
  });
  const { dgf, hub, portal, withdrawals } = proved;
  dgf.call.gameCount = fn(async () => u256((GAMES - 1) * stride + 1));
  // The games of the Portal's type at or below a factory index, newest first.
  dgf.call.findLatestGames = fn(async ([, start, n]) => {
    const from = gameAt(Number(BigInt(`0x${Buffer.from(start).toString("hex")}`)));
    const count = Number(BigInt(`0x${Buffer.from(n).toString("hex")}`));
    return Array.from({ length: Math.max(0, Math.min(count, from + 1)) }, (_, k) => searched(from - k));
  });
  dgf.call.gameMetadataAtIndex = fn(async (index) => {
    const i = gameAt(Number(BigInt(`0x${Buffer.from(index).toString("hex")}`)));
    return { extraData: [], l2SequenceNumber: u256(l2Of(i)), rootClaim: searched(i).root_claim };
  });
  dgf.call.gameAtIndex = fn(async (index) => ({ gameProxy: proxyOf(gameAt(Number(BigInt(`0x${Buffer.from(index).toString("hex")}`)))) }));
  portal.call.disputeGameBlacklist = fn(async (address) => blacklisted.includes(indexOf(address)));
  hub.call.createdAtForGame = fn(async (address) => createdAtOf(indexOf(address)));
  hub.call.resolvedAtForGame = fn(async (address) => resolvedOf(indexOf(address)));
  hub.call.statusForGame = fn(async (address) => (resolvedOf(indexOf(address)) ? 2 : 0));
  portal.call.provenWithdrawals = fn(async () => [Array(20).fill(0), 0n]);
  portal.call.numProofSubmitters = fn(async () => u256(0));
  return { ...proved, l2Of, proofsAt, withdrawals };
}

test("a proof goes against a covering game that has already resolved, so its claim date is exact", async () => {
  // An older withdrawal: games from 7 on cover it, and those up to 29 have resolved.
  const { proofsAt, withdrawals } = provingSetup({ firstL2: 13_000 });

  const prepared = await withdrawals.prepareProve(TX);

  assert.deepEqual(prepared.args[1], u256(29));
  assert.deepEqual(proofsAt, [13_000 + 29 * 100]);
  // Exactly the proof's maturity from now: Wed 4 Nov, 03:09:49 UTC.
  assert.deepEqual(prepared.claim, { at: Number(TIP.timestamp + 604_800n) * 1_000, exact: true, overdue: false });
});

test("without a resolved covering game, a proof goes against the newest, and its date is an estimate", async () => {
  // A fresh withdrawal: only the newest games cover it, none resolved yet.
  const { proofsAt, withdrawals } = provingSetup({ firstL2: 1_000 });

  const prepared = await withdrawals.prepareProve(TX);

  assert.deepEqual(prepared.args[1], u256(GAMES - 1));
  assert.equal(proofsAt.at(-1), 1_000 + (GAMES - 1) * 100);
  // The newest game, created 10 minutes ago, can be final before the proof
  // matures 7 days from now: that date, as an estimate until it resolves.
  assert.deepEqual(prepared.claim, { at: Number(TIP.timestamp + 604_800n) * 1_000, exact: false, overdue: false });
});

test("a waiting withdrawal's check is one Multicall query once its game is known", async () => {
  const queries = [];
  const answers = {
    checkWithdrawal: { Err: { Panic: "OptimismPortal2: invalid dispute game" } },
    createdAtForGame: 46_876_050,
    disputeGameBlacklist: false,
    disputeGameFinalityDelaySeconds: u256(302_400),
    finalizedWithdrawals: false,
    gameCount: u256(3_948),
    maxClockDuration: 302_400,
    numProofSubmitters: u256(1),
    proofMaturityDelaySeconds: u256(604_800),
    provenWithdrawals: [Array(20).fill(0x6f), 46_877_440],
    resolvedAtForGame: 0,
    respectedGameType: 8,
    statusForGame: 0,
    gameContractId: Array(32).fill(0xd5),
    virtualGameHubId: Array(32).fill(0xd5),
  };
  const node = {
    async contractCall(_id, fnName, bytes) {
      const calls = JSON.parse(new TextDecoder().decode(bytes));
      queries.push(calls.map((call) => Buffer.from(call.fn_args, "hex").toString()));
      return new TextEncoder().encode(
        JSON.stringify({
          height: "4704959",
          results: calls.map((call) => {
            const answer = answers[Buffer.from(call.fn_args, "hex").toString()];
            return answer?.Err ? answer : { Ok: Buffer.from(call.fn_args, "hex").toString("hex") };
          }),
        }),
      );
    },
  };
  const driver = {
    decodeOutputFn: (name, out) => (name === "aggregate" ? JSON.parse(new TextDecoder().decode(out)) : answers[new TextDecoder().decode(out)]),
    encodeInputFn: (name, json) => new TextEncoder().encode(name === "aggregate" ? json : name),
  };
  const contract = (id) => ({ driver: async () => driver, id });
  const reader = createContractReader({ multicall: contract("93".repeat(32)), node });
  let tips = 0;
  const withdrawals = createWithdrawals({
    dgf: contractFacade(reader, contract("3b".repeat(32))),
    gasPrice: async () => 1n,
    gasUpper: 1_000_000_000n,
    hub: (id) => contractFacade(reader, contract(id)),
    l2Rpc: async () => ({ blockHash: messagePassedLog.blockHash, blockNumber: messagePassedLog.blockNumber, logs: [messagePassedLog], status: "0x1", transactionHash: TX }),
    latestBlock: async () => {
      tips += 1;
      return TIP;
    },
    portal: contractFacade(reader, contract("14".repeat(32))),
    proofSubmitter: () => SUBMITTER,
    sendPortalCall: async () => ({ hash: "" }),
  });

  // The first check: the Portal's values; the game's hub (once a session) with the Portal's check; then the game.
  const first = await withdrawals.loadWithdrawalStatus(TX);
  assert.equal(first.stage, "proven_waiting");
  assert.equal(new Date(Number(first.readyAt) * 1_000).toISOString(), "2026-11-02T03:20:39.000Z");
  assert.deepEqual(queries.map((names) => names.length), [7, 3, 4]);
  assert.deepEqual(queries[1].sort(), ["checkWithdrawal", "disputeGameBlacklist", "gameContractId"]);
  assert.deepEqual(queries[2].sort(), ["createdAtForGame", "maxClockDuration", "resolvedAtForGame", "statusForGame"]);

  // Every check after: the Portal's values, the game and the Portal's check in one query.
  queries.length = 0;
  const again = await withdrawals.loadWithdrawalStatus(TX, { proofGame: first.disputeGameProxy });
  assert.equal(again.readyAt, first.readyAt);
  assert.deepEqual(queries.map((names) => names.length), [12]);
  assert.ok(["createdAtForGame", "resolvedAtForGame", "statusForGame", "provenWithdrawals", "proofMaturityDelaySeconds"].every((name) => queries[0].includes(name)));
  assert.equal(tips, 2);
});

test("a blacklisted resolved game is passed over for the next resolved one", async () => {
  const { withdrawals } = provingSetup({ blacklisted: [29], firstL2: 13_000 });
  const prepared = await withdrawals.prepareProve(TX);
  assert.deepEqual(prepared.args[1], u256(28));
  assert.equal(prepared.claim.exact, true);
});

test("the search for a resolved game counts the factory's index, which other game types share", async () => {
  // Three games of other types between each of the Portal's type.
  const { withdrawals } = provingSetup({ firstL2: 13_000, stride: 4 });
  const prepared = await withdrawals.prepareProve(TX);
  assert.deepEqual(prepared.args[1], u256(29 * 4));
  assert.equal(prepared.claim.exact, true);
});

test("the Portal's own check decides even when the game's hub can't be read", async () => {
  const unreadable = setup();
  unreadable.dgf.call.gameContractId = fn(async () => {
    throw new Error("Contract call failed.");
  });
  // Claimable: the Portal says so; the date known so far stands (none given).
  const ready = await unreadable.withdrawals.loadWithdrawalStatus(TX);
  assert.equal(ready.stage, "ready_to_finalize");
  assert.equal("readyAt" in ready, false);
  // Not yet: still proven, waiting, with no date given.
  const waiting = setup({ preflight: invalidGame });
  waiting.dgf.call.gameContractId = unreadable.dgf.call.gameContractId;
  const status = await waiting.withdrawals.loadWithdrawalStatus(TX);
  assert.deepEqual([status.stage, "readyAt" in status], ["proven_waiting", false]);
  assert.match(status.statusMessage, /can't be read right now/u);
});

test("a date that has passed while the Portal still refuses the claim isn't shown", async () => {
  // Resolved long ago, matured, and refused for another reason than the game.
  const { withdrawals } = setup({
    createdAt: 45_250_000n,
    gameStatus: 2,
    preflight: async () => {
      throw new Error("OptimismPortal2: paused");
    },
    provenAt: 45_252_320n,
    resolvedAt: 45_555_010n,
  });
  const status = await withdrawals.loadWithdrawalStatus(TX);
  assert.deepEqual([status.stage, status.readyAt, status.readyAtExact], ["proven_waiting", null, false]);
  assert.equal(status.statusMessage, "The Portal doesn't take the claim yet.");
});

test("a resolved game the Portal wouldn't take is passed over, and with none it takes, the proof goes against the newest", async () => {
  // The registry the Portal asks answers yes or no, in one byte.
  assert.equal(GAME_REGISTRY_DRIVER.decodeOutputFn("isGameProper", Uint8Array.of(1)), true);
  assert.equal(GAME_REGISTRY_DRIVER.decodeOutputFn("isGameRespected", Uint8Array.of(0)), false);
  assert.throws(() => GAME_REGISTRY_DRIVER.decodeOutputFn("isGameProper", Uint8Array.of()), RangeError);
  assert.deepEqual(GAME_REGISTRY_DRIVER.encodeInputFn("isGameProper", JSON.stringify(Array(20).fill(0x6f))), Uint8Array.from(Array(20).fill(0x6f)));
  // Game 29 retired after it resolved, and 28 of a type no longer respected: the next resolved one.
  const passedOver = provingSetup({ firstL2: 13_000, retired: [29], unrespected: [28] });
  const prepared = await passedOver.withdrawals.prepareProve(TX);
  assert.deepEqual(prepared.args[1], u256(27));
  assert.equal(prepared.claim.exact, true);
  const asked = (spy) => spy.calls.map(([address]) => address[18] * 256 + address[19]);
  assert.ok(asked(passedOver.registry.call.isGameProper).includes(29));
  assert.ok(asked(passedOver.registry.call.isGameRespected).includes(28));
  // Three reads a candidate, as many as one Multicall query holds (64): 21 of the 23 covering games.
  assert.deepEqual(asked(passedOver.registry.call.isGameProper), Array.from({ length: 21 }, (_, k) => 29 - k));
  // Every resolved covering game retired: the newest covering game, as before.
  const allRetired = provingSetup({ firstL2: 13_000, retired: Array.from({ length: 30 }, (_, i) => i) });
  const newest = await allRetired.withdrawals.prepareProve(TX);
  assert.deepEqual(newest.args[1], u256(GAMES - 1));
  assert.equal(newest.claim.exact, false);
  // Without the registry, nothing says the Portal would take a resolved game: the newest too.
  const unknown = await provingSetup({ firstL2: 13_000, registry: false }).withdrawals.prepareProve(TX);
  assert.deepEqual(unknown.args[1], u256(GAMES - 1));
});

test("a claim isn't ready before its date, even when the Portal's check says yes", async () => {
  // A Portal whose check takes just the proof and its game says yes on
  // 28 Oct, for a proof that matures, and a game final, on 2 Nov.
  const early = setup({ gameStatus: 2, resolvedAt: 47_180_060n });
  const status = await early.withdrawals.loadWithdrawalStatus(TX);
  assert.deepEqual([status.stage, status.readyAtExact, status.claimOverdue], ["proven_waiting", true, false]);
  assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:24:19.000Z");
  // Claim stays off: nothing is prepared or sent.
  await assert.rejects(early.withdrawals.prepareFinalize(TX), /Wait for its dispute game to become final/u);
  await assert.rejects(early.withdrawals.finalizeWithdrawal(TX));
  assert.deepEqual(early.sent, []);
  // From its date, the Portal's yes counts.
  assert.equal((await setup(CLAIMABLE).withdrawals.loadWithdrawalStatus(TX)).stage, "ready_to_finalize");
});

test("a game created at or before the respected game type last changed is passed over, as the web wallet does", async () => {
  // The registry's time of the change: no input, a u64 back, as the hubs' are read.
  assert.deepEqual(GAME_REGISTRY_DRIVER.encodeInputFn("respectedGameTypeUpdatedAt", "null"), new Uint8Array(0));
  assert.equal(GAME_REGISTRY_DRIVER.decodeOutputFn("respectedGameTypeUpdatedAt", Uint8Array.of(0x10, 0x27, 0, 0, 0, 0, 0, 0)), 10_000n);
  // Changed just after game 28 was created: 29, the newest resolved, is the one.
  const after28 = provingSetup({ firstL2: 13_000, updatedAt: createdAtOf(28) });
  const proved = await after28.withdrawals.prepareProve(TX);
  assert.deepEqual(proved.args[1], u256(29));
  assert.equal(proved.claim.exact, true);
  // Read once, with the hub and the newest games.
  assert.equal(after28.registry.call.respectedGameTypeUpdatedAt.calls.length, 1);
  // Changed when game 29 was created: every resolved game is retired, so the newest covering game, as with none.
  const at29 = provingSetup({ firstL2: 13_000, updatedAt: createdAtOf(29) });
  const newest = await at29.withdrawals.prepareProve(TX);
  assert.deepEqual(newest.args[1], u256(GAMES - 1));
  assert.equal(newest.claim.exact, false);
  // None of the retired games was asked about.
  assert.deepEqual(at29.registry.call.isGameProper.calls, []);
});
