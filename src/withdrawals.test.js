import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WithdrawalError } from "@dusk-network/app-core/duskevm-withdrawals";
import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";
import { encodeAbiParameters, keccak256, toHex, toRlp } from "viem";

import { loadConfig } from "./config.js";
import { driverJson, loadDataDriver } from "./data-driver.js";
import { buildContractCallRequest } from "./dusk-wallet.js";
import { WITHDRAWAL_GAS_REFUSAL } from "./gas.js";
import { NOT_A_DUSK_WITHDRAWAL, PROVED_BY_ANOTHER_ACCOUNT, createPageWithdrawals, inWords } from "./withdrawals.js";
import { TIP, TX, messagePassedLog, receiptOf, u256, withdrawalInput } from "./withdrawals.fixtures.js";

globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const cfg = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;

const { anchor_state_registry: REGISTRY, dispute_game_factory: FACTORY, optimism_portal: PORTAL } = networks.testnet.duskEvm.contracts;
const HUB = "d5".repeat(32);
// Whom the fixture's withdrawal pays.
const PAID = "213qXNRaEAXrgJTFxXsPMeFasiEtPVJwZ3x2wKgZog2kXtXE7ovGRFfn1spfKBU4AUitAS91nM5T7HSvwRiyYCHLRaTTnJQbZn1TKnDySEiKZxX8vyodtWorbMuybDV5JJ9Y";
const ME = `0x${"2c".repeat(20)}`;
const GAME = Array(20).fill(0x6f);
const L2 = Number(BigInt(messagePassedLog.blockNumber)) + 100;
const BLOCK = { hash: keccak256(toHex("block")), stateRoot: keccak256(toHex("state")) };
const STORAGE = keccak256(toHex("message passer"));
const NODES = [toRlp(["0x20", "0x01"])];
const ZERO = `0x${"00".repeat(32)}`;
const ROOT = keccak256(encodeAbiParameters(Array(4).fill({ type: "bytes32" }), [ZERO, BLOCK.stateRoot, STORAGE, BLOCK.hash]));
const bytes = (hex) => Array.from(Buffer.from(hex.slice(2), "hex"));
const u64 = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

// The Portal's own driver for the calls a wallet signs; its reads, and the
// factory's, go in and out as JSON here, as the chain below answers them.
const portalDriver = await loadDataDriver(await readFile(new URL("../public/drivers/optimism_portal_dd_opt.wasm", import.meta.url)));
const SIGNED = new Set(["proveWithdrawalTransaction", "finalizeWithdrawalTransaction"]);
const json = (real = null) => ({
  decodeOutputFn: (_fn, out) => JSON.parse(new TextDecoder().decode(out)),
  encodeInputFn: (fn, input) => (real && SIGNED.has(fn) ? real.encodeInputFn(fn, input) : new TextEncoder().encode(input)),
});

/**
 * Testnet's 1,008 DUSK withdrawal, proved by `ME` (`provenAt`, in the
 * contracts' time) against a game resolved for the defender long ago, or not
 * proved (0n); one covering game to prove against. `asked` keeps whose
 * proof each check read.
 */
function chain({ provenAt = 45_252_320n } = {}) {
  const asked = [];
  const answers = {
    [FACTORY.contractId]: {
      findLatestGames: () => [{ extra_data: u256(L2), index: u256(0), metadata: [...Array(12).fill(0), ...GAME], root_claim: bytes(ROOT), timestamp: 45_250_000 }],
      gameAtIndex: () => ({ gameProxy: GAME }),
      gameContractId: () => bytes(`0x${HUB}`),
      gameCount: () => u256(1),
      gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(L2), rootClaim: bytes(ROOT) }),
      virtualGameHubId: () => bytes(`0x${HUB}`),
    },
    [HUB]: { createdAtForGame: () => u64(45_250_000), maxClockDuration: () => u64(302_400), resolvedAtForGame: () => u64(45_555_010), statusForGame: () => Uint8Array.of(2) },
    [PORTAL.contractId]: {
      checkWithdrawal: () => null,
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(provenAt ? 1 : 0),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: ([, who]) => {
        asked.push(`0x${Buffer.from(who).toString("hex")}`);
        return { disputeGameProxy: provenAt ? GAME : Array(20).fill(0), timestamp: Number(provenAt) };
      },
      respectedGameType: () => 8,
    },
    [REGISTRY.contractId]: { isGameProper: () => Uint8Array.of(1), isGameRespected: () => Uint8Array.of(1), respectedGameTypeUpdatedAt: () => u64(0) },
  };
  const raw = new Set([HUB, REGISTRY.contractId]);
  const fetch = async (url, init) => {
    const [, id, fn] = /\/on\/contracts:([0-9a-f]{64})\/(\w+)$/u.exec(String(url));
    const input = raw.has(id) ? null : JSON.parse(new TextDecoder().decode(init.body));
    const out = answers[id][fn](input);
    return new Response(raw.has(id) ? out : JSON.stringify(out));
  };
  const rpc = async (_network, method) =>
    ({
      eth_getBlockByNumber: BLOCK,
      eth_getProof: { storageHash: STORAGE, storageProof: [{ proof: NODES }] },
      eth_getTransactionReceipt: receiptOf(messagePassedLog),
    })[method];
  const node = { gasPrice: async () => 2n, latestBlock: async () => TIP };
  const drivers = { disputeGameFactory: json(), optimismPortal: json(portalDriver) };
  return { asked, connected: () => null, drivers, fetch, maxBatch: 64, node, rpc };
}

test("a claim is the call the package checked, at the gas price the page quoted", async () => {
  const withdrawals = createPageWithdrawals(cfg, chain());

  const { claim, decoded, request } = await withdrawals.request("finalize", TX, { price: 1n, submitter: ME });

  // The withdrawal as the Portal's driver encodes it, as the page sent it before.
  assert.deepEqual(request.fnArgs, portalDriver.encodeInputFn("finalizeWithdrawalTransaction", driverJson(withdrawalInput(messagePassedLog))));
  assert.deepEqual(
    { ...request, fnArgs: undefined },
    {
      contractId: PORTAL.contractId,
      display: { label: "Claim a DuskEVM withdrawal" },
      fnArgs: undefined,
      fnName: "finalizeWithdrawalTransaction",
      gas: { limit: "51000000", price: "1" },
    },
  );
  assert.deepEqual([claim, decoded.amountWei, decoded.recipient.account], [null, 1_008n * 10n ** 18n, PAID]);
  // It sends no DUSK: Dusk Wallet gets no deposit at all.
  assert.equal("deposit" in buildContractCallRequest(request), false);
  // Without a quoted price, the node's.
  assert.equal((await withdrawals.request("finalize", TX, { submitter: ME })).request.gas.price, "2");
});

test("a proof says when it can be claimed, and is the package's checked call", async () => {
  const withdrawals = createPageWithdrawals(cfg, chain({ provenAt: 0n }));

  const { claim, decoded, request } = await withdrawals.request("prove", TX, { price: 1n, submitter: ME });

  const proof = { latest_blockhash: bytes(BLOCK.hash), message_passer_storage_root: bytes(STORAGE), state_root: bytes(BLOCK.stateRoot), version: bytes(ZERO) };
  assert.deepEqual(request.fnArgs, portalDriver.encodeInputFn("proveWithdrawalTransaction", driverJson([withdrawalInput(messagePassedLog), u256(0), proof, NODES.map(bytes)])));
  assert.deepEqual([request.fnName, request.display.label, request.gas], ["proveWithdrawalTransaction", "Prove a DuskEVM withdrawal", { limit: "51000000", price: "1" }]);
  assert.deepEqual([decoded.kind, decoded.disputeGameIndex, decoded.recipient.account], ["prove", 0n, PAID]);
  // Its game resolved long ago: claimable exactly the Portal's maturity after it's proved.
  assert.deepEqual(claim, { at: Number(TIP.timestamp + 604_800n) * 1_000, exact: true, overdue: false });
});

test("a check is for the account given, else Dusk Wallet's, else the withdrawal's recipient's", async () => {
  const setup = chain();
  const wallet = `0x${"3d".repeat(20)}`;
  let connected = null;
  const withdrawals = createPageWithdrawals(cfg, { ...setup, connected: () => connected });

  await withdrawals.status(TX);
  connected = wallet;
  await withdrawals.status(TX);
  await withdrawals.status(TX, { submitter: ME });
  // A proof or claim is the reviewed account's, whoever Dusk Wallet shows.
  await withdrawals.request("finalize", TX, { submitter: ME });

  assert.deepEqual(setup.asked, [evmAddressOf(PAID).toLowerCase(), wallet, ME, ME]);
});

test("a proof or claim the package refuses says why in the page's words", async () => {
  const words = (code, options) => inWords(new WithdrawalError(code, undefined, options)).message;
  const status = (stage, more = {}) => ({ stage, ...more });

  // Through the page: more gas than the bound allows, as transfer-view expects it.
  const bounded = createPageWithdrawals({ ...cfg, gasLimitUpper: 50_000_000n }, chain());
  await assert.rejects(bounded.request("finalize", TX, { submitter: ME }), { message: WITHDRAWAL_GAS_REFUSAL });

  assert.equal(words("claimed"), "This withdrawal is already claimed.");
  assert.equal(words("not-a-withdrawal"), NOT_A_DUSK_WITHDRAWAL);
  assert.equal(words("proven", { status: status("ready_to_finalize") }), "This account already proved this withdrawal. You can claim it now.");
  assert.equal(words("proven", { status: status("proven_waiting", { reason: "game-in-progress" }) }), "This account already proved this withdrawal. Claim it once the waiting period ends.");
  assert.equal(words("proven", { status: status("proven_waiting", { proofRejected: true, reason: "proof-rejected" }) }), "The existing proof was rejected, but no replacement output proposal is available yet.");
  assert.equal(words("no-proof", { reason: "no-games" }), "No dispute games have been proposed yet.");
  assert.equal(words("no-proof", { reason: "no-output" }), "No finalized output proposal covering this withdrawal is ready yet.");
  assert.equal(words("not-ready", { status: status("proven_waiting", { reason: "game-in-progress" }) }), "The proof is accepted. Its dispute game is still in progress.");
  assert.equal(words("not-ready", { status: status("proven_waiting", { reason: "portal-refuses" }) }), "The Portal doesn't take the claim yet.");
  assert.equal(words("not-ready", { status: status("ready_to_prove", { provenByOther: true }) }), PROVED_BY_ANOTHER_ACCOUNT);
  assert.equal(words("bad-call"), "The request didn't match this withdrawal, so it wasn't sent.");
  // Anything else is the error as it came.
  const other = new Error("The node is busy");
  assert.equal(inWords(other), other);
});

test("a check keeps the receipt it read, as it was: what a reverted withdrawal paid comes from the one that showed it", async () => {
  const reverted = { ...receiptOf(messagePassedLog), effectiveGasPrice: "0x2541b2640", gasUsed: "0x21cc7", status: "0x0" };
  const fake = chain();
  let reads = 0;
  const rpc = async (network, method, params) => {
    if (method !== "eth_getTransactionReceipt") return fake.rpc(network, method, params);
    reads += 1;
    return reverted;
  };
  const withdrawals = createPageWithdrawals(cfg, { ...fake, rpc });
  assert.equal(withdrawals.receiptOf(TX), null);
  await assert.rejects(withdrawals.status(TX), { code: "failed" });
  assert.equal(withdrawals.receiptOf(TX.toUpperCase().replace("0X", "0x")), reverted);
  assert.equal(reads, 1);
});
