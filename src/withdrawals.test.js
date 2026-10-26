import assert from "node:assert/strict";
import test from "node:test";

import { WITHDRAWAL_GAS_REFUSAL, gasAtNodePrice, withdrawalGasLimit } from "./gas.js";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi } from "viem";

import {
  NOT_A_DUSK_WITHDRAWAL,
  createWithdrawals,
  hashWithdrawal,
  parseGameSearchDepth,
  parseWithdrawalReceipt,
  proofRequiresReplacement,
  withdrawalDetails,
} from "./withdrawals.js";
import { contractFacade, createContractReader } from "./contract-reader.js";

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
  resolvedAt = 0n,
  provenAt = 100n,
  proofMaturity = 0,
  latest = 200n,
  gasUpper = 1_000_000_000n,
  submitterCount = 1,
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
  const dgf = { call: { gameCount: fn(async () => u256(0)) } };
  const sent = [];
  const withdrawals = createWithdrawals({
    dgf,
    gasPrice: async () => 2n,
    gasUpper,
    l1Rpc: async (_method, [{ data }]) => {
      // The dispute game's `resolvedAt()` and `status()`.
      const answer = data === "0x19effeb4" ? resolvedAt : BigInt(gameStatus);
      return `0x${answer.toString(16).padStart(64, "0")}`;
    },
    l2Rpc: async (method) => {
      assert.equal(method, "eth_getTransactionReceipt");
      return {
        blockHash: messagePassedLog.blockHash,
        blockNumber: messagePassedLog.blockNumber,
        logs,
        status: "0x1",
        transactionHash: TX,
      };
    },
    latestTimestamp: async () => latest,
    portal,
    proofSubmitter: () => SUBMITTER,
    sendPortalCall: async (fnName, args, gas) => {
      sent.push({ args, fnName, gas });
      return { hash: "finalize-hash" };
    },
  });
  return { dgf, portal, sent, withdrawals };
}

test("proofs and claims get a large gas limit, within the bound, at the node's price", async () => {
  assert.equal(withdrawalGasLimit(), 50_000_000n);
  assert.equal(withdrawalGasLimit(519_542n), 50_519_542n);
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
  const { portal, withdrawals } = setup({
    preflight: async () => {
      throw new Error("OptimismPortal2: invalid dispute game");
    },
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  assert.match(status.statusMessage, /dispute game is still in progress/u);
  const [[[hash, submitter]]] = portal.call.checkWithdrawal.calls;
  assert.equal(hash.length, 32);
  assert.deepEqual(submitter, Array(20).fill(0x2c));
});

test("the claim time is estimated from the proof while its game is in progress", async () => {
  const { portal, withdrawals } = setup({ proofMaturity: 604_800 });

  // Proven at 100, so the proof matures at 604_900.
  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  assert.equal(status.readyAt, 604_900n);
  assert.equal(status.readyAtExact, false);
  assert.equal(status.proofRejected, false);
  assert.equal(portal.call.checkWithdrawal.calls.length, 0);
});

test("the claim time is exact once the proven game has resolved", async () => {
  const { withdrawals } = setup({ gameStatus: 2, proofMaturity: 604_800, resolvedAt: 400_000n });

  // The game is final at 400_000 + 302_400, after the proof matures.
  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.readyAt, 702_400n);
  assert.equal(status.readyAtExact, true);
});

test("a proof whose game the challenger won is named as rejected", async () => {
  const { withdrawals } = setup({ gameStatus: 1, proofMaturity: 604_800, resolvedAt: 400_000n });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.proofRejected, true);
  assert.equal(status.readyAt, null);
  assert.equal(status.stage, "proven_waiting");
});

test("after the proof matures, the claim time follows the game's finality delay", async () => {
  const { withdrawals } = setup({
    preflight: async () => {
      throw new Error("OptimismPortal2: invalid dispute game");
    },
  });

  // The latest block is at 200; the game can't be final before 200 + 302_400.
  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.readyAt, 302_600n);
  assert.equal(status.readyAtExact, false);
});

test("a proof time off Dusk's clock gives no claim time", async () => {
  const { withdrawals } = setup({
    latest: 1_792_950_989n,
    preflight: async () => {
      throw new Error("OptimismPortal2: invalid dispute game");
    },
    proofMaturity: 604_800,
    provenAt: 45_252_320n,
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.readyAt, null);
  assert.equal(status.readyAtExact, false);
});

test("a rejected proof with no replacement output is named as rejected", async () => {
  const { withdrawals } = setup({
    gameStatus: 1,
    preflight: async () => {
      throw new Error("OptimismPortal2: invalid dispute game");
    },
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.proofRejected, true);
  assert.equal(status.stage, "proven_waiting");
});

test("the waiting period is read from the portal, or is unknown", async () => {
  const { portal, withdrawals } = setup({ proofMaturity: 604_800 });
  assert.equal(await withdrawals.loadWithdrawalWaitingPeriod(), 604_800n);

  portal.call.proofMaturityDelaySeconds = async () => {
    throw new Error("offline");
  };
  assert.equal(await withdrawals.loadWithdrawalWaitingPeriod(), null);
});

test("a finalized withdrawal isn't claimed again", async () => {
  const { sent, withdrawals } = setup({ finalized: true });

  await assert.rejects(withdrawals.finalizeWithdrawal(TX), /already finalized/u);
  assert.equal(sent.length, 0);
});

test("a claim that needs more gas than the bound isn't sent", async () => {
  const { sent, withdrawals } = setup({ gasUpper: 50_000_000n });

  await assert.rejects(withdrawals.finalizeWithdrawal(TX), { message: WITHDRAWAL_GAS_REFUSAL });
  assert.equal(sent.length, 0);
});

test("a claim sends the SDK-serialized withdrawal with its own gas on top", async () => {
  const { sent, withdrawals } = setup();

  assert.equal(await withdrawals.finalizeWithdrawal(TX), "finalize-hash");
  const [{ args, fnName, gas }] = sent;
  assert.equal(fnName, "finalizeWithdrawalTransaction");
  // 50M plus the 519,542 gas the withdrawal asks for, at the node's price.
  assert.deepEqual(gas, { limit: "50519542", price: "2" });
  assert.deepEqual(args.data.slice(0, 4), [0xd7, 0x64, 0xad, 0x0b]);
  assert.equal(args.gas_limit.length, 32);
  assert.equal(args.sender.length, 20);
  assert.equal(args.target.length, 20);
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
