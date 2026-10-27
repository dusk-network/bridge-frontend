import assert from "node:assert/strict";
import test from "node:test";
import { toRlp } from "viem";

import { provenByOtherLine, transferView } from "./transfer-view.js";
import { PROVED_BY_ANOTHER_ACCOUNT, createWithdrawals, hashOutputRootProof } from "./withdrawals.js";

// The web wallet's 10 DUSK withdrawal fixture, sent at L2 block 0x3564.
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
const OWN = `0x${"2c".repeat(20)}`;
const OTHER = `0x${"3d".repeat(20)}`;
const OWN_GAME = `0x${"1e".repeat(20)}`;
const OTHER_GAME = `0x${"4f".repeat(20)}`;
// One proposed output, at L2 block 13,678, that covers the withdrawal.
const BLOCK = { hash: `0x${"a1".repeat(32)}`, stateRoot: `0x${"a2".repeat(32)}` };
const STORAGE_ROOT = `0x${"a3".repeat(32)}`;
const ROOT_CLAIM = hashOutputRootProof({
  latestBlockhash: BLOCK.hash,
  messagePasserStorageRoot: STORAGE_ROOT,
  stateRoot: BLOCK.stateRoot,
  version: `0x${"00".repeat(32)}`,
});

const bytes = (hex) => Array.from(Buffer.from(hex.replace(/^0x/u, ""), "hex"));
const u256 = (value) => {
  let rest = BigInt(value);
  const out = Array(32).fill(0);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const hexOf = (array) => `0x${Buffer.from(array).toString("hex")}`;

/**
 * Proofs by account: `own` and `others` are `{ game, timestamp }`; games
 * carry their status (0 in progress, 1 challenger won, 2 defender won) and
 * blacklisting.
 */
function setup({ own = null, others = [], games = {} }) {
  const submitters = [...(own ? [OWN] : []), ...others.map(({ address }) => address)];
  const proofs = new Map([
    ...(own ? [[OWN, own]] : []),
    ...others.map(({ address, ...proof }) => [address, proof]),
  ]);
  const calls = [];
  const spy = (name, impl) => async (args) => {
    calls.push(name);
    return impl(args);
  };
  const portal = {
    call: {
      // The Portal's readiness check for one account's proof.
      checkWithdrawal: spy("checkWithdrawal", async ([, submitter]) => {
        const check = proofs.get(hexOf(submitter))?.check;
        if (check === "ready") return;
        throw new Error(check ?? "OptimismPortal2: invalid dispute game");
      }),
      disputeGameBlacklist: spy("disputeGameBlacklist", async (game) =>
        Boolean(games[hexOf(game)]?.blacklisted),
      ),
      disputeGameFinalityDelaySeconds: spy("disputeGameFinalityDelaySeconds", async () => u256(302_400)),
      finalizedWithdrawals: spy("finalizedWithdrawals", async () => false),
      numProofSubmitters: spy("numProofSubmitters", async () => u256(submitters.length)),
      proofMaturityDelaySeconds: spy("proofMaturityDelaySeconds", async () => u256(604_800)),
      proofSubmitters: spy("proofSubmitters", async ([, index]) =>
        bytes(submitters[Number(BigInt(hexOf(index)))]),
      ),
      provenWithdrawals: spy("provenWithdrawals", async ([, submitter]) => {
        const proof = proofs.get(hexOf(submitter));
        return proof ? [bytes(proof.game), proof.timestamp] : [Array(20).fill(0), 0];
      }),
      respectedGameType: spy("respectedGameType", async () => 8),
    },
  };
  const dgf = {
    call: {
      findLatestGames: async () => [{ index: u256(5) }],
      gameAtIndex: async () => ({ gameProxy: bytes(OTHER_GAME) }),
      gameCount: async () => u256(6),
      gameMetadataAtIndex: async () => ({
        extraData: [],
        l2SequenceNumber: u256(13_678),
        rootClaim: bytes(ROOT_CLAIM),
      }),
    },
  };
  const sent = [];
  const withdrawals = createWithdrawals({
    dgf,
    gasPrice: async () => 1n,
    gasUpper: 1_000_000_000n,
    l1Rpc: async (_method, [{ data, to }]) => {
      // Older games answer nothing through the adapter's L1 view.
      if (games[to.toLowerCase()]?.unreadable) return "0x";
      // A game's `resolvedAt()` (0: unresolved) or `status()`.
      const answer = data === "0x19effeb4" ? 0n : BigInt(games[to.toLowerCase()]?.status ?? 0);
      return `0x${answer.toString(16).padStart(64, "0")}`;
    },
    l2Rpc: async (method) => {
      if (method === "eth_getTransactionReceipt")
        return {
          blockHash: messagePassedLog.blockHash,
          blockNumber: messagePassedLog.blockNumber,
          logs: [messagePassedLog],
          status: "0x1",
          transactionHash: TX,
        };
      if (method === "eth_getBlockByNumber") return BLOCK;
      if (method === "eth_getProof")
        return { storageHash: STORAGE_ROOT, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] };
      throw new Error(`unexpected ${method}`);
    },
    latestTimestamp: async () => 200n,
    portal,
    proofSubmitter: () => OWN,
    sendPortalCall: async (fnName, args, gas) => {
      sent.push({ args, fnName, gas });
      return { hash: "sent" };
    },
  });
  return { calls, sent, withdrawals };
}

const route = {
  from: { id: "dusk-evm", kind: "evm", label: "DuskEVM" },
  id: "dusk-evm-to-dusk",
  mode: "duskevm-withdrawal",
  to: { id: "dusk", kind: "dusk", label: "Dusk" },
};
const cfg = { dusk: { explorerUrl: "https://x" }, duskEvm: { explorerUrl: "https://y" }, evmNetworks: {}, profile: "testnet" };
const proveStep = (view) => view.steps.find((step) => step.key === "prove");

test("a withdrawal proven only by another account still needs the user's own proof", async () => {
  const { sent, withdrawals } = setup({
    games: { [OTHER_GAME]: { status: 0 } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 100 }],
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);
  assert.equal(status.stage, "ready_to_prove");
  assert.equal(status.provenByOther, true);

  // The entry says so, reassuring first, and keeps Prove: the other proof
  // can't be claimed with.
  assert.match(PROVED_BY_ANOTHER_ACCOUNT, /^Another account proved this withdrawal\. Your DUSK isn't affected,/u);
  const view = transferView({ hash: TX, provenByOther: true, stage: "ready_to_prove", status: "pending" }, { cfg, route });
  assert.equal(proveStep(view).detail, provenByOtherLine({}));
  assert.equal(proveStep(view).detail, "Another account proved it. Prove it yourself to claim it.");
  assert.equal(proveStep(view).state, "turn");
  assert.equal(view.action.kind, "prove");

  // Claiming as this account isn't possible on another account's proof:
  // nothing is sent, and the refusal says which account can.
  await assert.rejects(withdrawals.finalizeWithdrawal(TX), { message: PROVED_BY_ANOTHER_ACCOUNT });
  assert.deepEqual(sent, []);
});

test("the user's own proof decides the stage when both have proven", async () => {
  const { calls, withdrawals } = setup({
    games: { [OTHER_GAME]: { status: 0 }, [OWN_GAME]: { status: 0 } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 50 }],
    own: { game: OWN_GAME, timestamp: 100 },
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  assert.equal(status.readyAt, 604_900n);
  assert.equal(status.provenByOther, undefined);
  assert.equal(calls.includes("proofSubmitters"), false);
});

test("another account's rejected or blacklisted proof leaves a plain ready to prove", async () => {
  for (const game of [{ status: 1 }, { blacklisted: true, status: 0 }]) {
    const { withdrawals } = setup({
      games: { [OTHER_GAME]: game },
      others: [{ address: OTHER, game: OTHER_GAME, timestamp: 100 }],
    });

    const status = await withdrawals.loadWithdrawalStatus(TX);

    assert.equal(status.stage, "ready_to_prove");
    assert.equal(status.provenByOther, false);
    const view = transferView({ hash: TX, provenByOther: false, stage: "ready_to_prove", status: "pending" }, { cfg, route });
    assert.doesNotMatch(proveStep(view).detail, /Another account proved it/u);
  }
});

test("another account's proof the Portal accepts counts, even when its game can't be read", async () => {
  for (const check of ["ready", "OptimismPortal2: proof maturity delay not met"]) {
    const { withdrawals } = setup({
      // As on testnet: an older game the adapter's L1 view can't read.
      games: { [OTHER_GAME]: { unreadable: true } },
      others: [{ address: OTHER, check, game: OTHER_GAME, timestamp: 100 }],
    });

    const status = await withdrawals.loadWithdrawalStatus(TX);

    assert.equal(status.stage, "ready_to_prove");
    assert.equal(status.provenByOther, true);
  }
});

test("an unreadable game without the Portal's acceptance doesn't count", async () => {
  const { withdrawals } = setup({
    games: { [OTHER_GAME]: { unreadable: true } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 100 }],
  });

  assert.equal((await withdrawals.loadWithdrawalStatus(TX)).provenByOther, false);
});
