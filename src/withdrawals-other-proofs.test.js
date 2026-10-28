import assert from "node:assert/strict";
import test from "node:test";
import { toRlp } from "viem";

import { provenByOtherLine, transferView } from "./transfer-view.js";
import { PROVED_BY_ANOTHER_ACCOUNT, createWithdrawals, hashOutputRootProof } from "./withdrawals.js";
import { TIP, TX, messagePassedLog, u256 } from "./withdrawals.fixtures.js";

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
const hexOf = (array) => `0x${Buffer.from(array).toString("hex")}`;

/**
 * Proofs by account: `own` and `others` are `{ game, timestamp }`, in the
 * contracts' time; games carry their status (0 in progress, 1 challenger
 * won, 2 defender won) and blacklisting, and an unreadable one fails on its
 * hub.
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
      gameContractId: async () => Array(32).fill(0xd5),
      virtualGameHubId: async () => Array(32).fill(0xd5),
    },
  };
  // The games' hub on Dusk: created a little before the proofs, unresolved.
  const game = (address) => {
    const known = games[hexOf(address)];
    if (known?.unreadable) throw new Error("Panic: unknown game");
    return known ?? {};
  };
  const hub = {
    call: {
      createdAtForGame: async (address) => (game(address), 46_876_050n),
      maxClockDuration: async () => 302_400n,
      resolvedAtForGame: async (address) => (game(address), 0n),
      statusForGame: spy("statusForGame", async (address) => game(address).status ?? 0),
    },
  };
  const withdrawals = createWithdrawals({
    dgf,
    gasPrice: async () => 1n,
    gasUpper: 1_000_000_000n,
    hub: () => hub,
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
    latestBlock: async () => TIP,
    portal,
    proofSubmitter: () => OWN,
  });
  return { calls, withdrawals };
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
  const { withdrawals } = setup({
    games: { [OTHER_GAME]: { status: 0 } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
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
  // nothing is prepared to send, and the refusal says which account can.
  await assert.rejects(withdrawals.prepareFinalize(TX), { message: PROVED_BY_ANOTHER_ACCOUNT });
});

test("the user's own proof decides the stage when both have proven", async () => {
  const { calls, withdrawals } = setup({
    games: { [OTHER_GAME]: { status: 0 }, [OWN_GAME]: { status: 0 } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_000 }],
    own: { game: OWN_GAME, timestamp: 46_877_440 },
  });

  const status = await withdrawals.loadWithdrawalStatus(TX);

  assert.equal(status.stage, "proven_waiting");
  // The own proof's: matured Mon 2 Nov, 03:20:39 UTC, as an estimate.
  assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:20:39.000Z");
  assert.equal(status.provenByOther, undefined);
  assert.equal(calls.includes("proofSubmitters"), false);
});

test("another account's rejected or blacklisted proof leaves a plain ready to prove", async () => {
  for (const game of [{ status: 1 }, { blacklisted: true, status: 0 }]) {
    const { withdrawals } = setup({
      games: { [OTHER_GAME]: game },
      others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
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
      // A game its hub can't read.
      games: { [OTHER_GAME]: { unreadable: true } },
      others: [{ address: OTHER, check, game: OTHER_GAME, timestamp: 46_877_440 }],
    });

    const status = await withdrawals.loadWithdrawalStatus(TX);

    assert.equal(status.stage, "ready_to_prove");
    assert.equal(status.provenByOther, true);
  }
});

test("an unreadable game without the Portal's acceptance doesn't count", async () => {
  const { withdrawals } = setup({
    games: { [OTHER_GAME]: { unreadable: true } },
    others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
  });

  assert.equal((await withdrawals.loadWithdrawalStatus(TX)).provenByOther, false);
});
