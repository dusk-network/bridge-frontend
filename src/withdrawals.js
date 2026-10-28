// DuskEVM -> Dusk withdrawal status, proof discovery and Dusk-side actions.
// Ported from the Dusk web wallet's `src/lib/bridge/withdrawals.js` (main,
// 25 Oct 2026): claim times, rejected-proof naming and per-operation gas.
// Reads come from the deployment's own Dusk node (batched through Multicall
// for Dusk); the wallet only signs and sends.

import {
  L2_STANDARD_BRIDGE_ADDRESS,
  L2_TO_L1_MESSAGE_PASSER_ADDRESS,
  parseMessagePassedReceipt,
  hashWithdrawal as sdkHashWithdrawal,
  serializeOutputRootProofForDuskAbi,
  serializeWithdrawalForDuskAbi,
} from "@dusk/evm-sdk";
import {
  bytesToHex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  fromRlp,
  hexToBytes,
  keccak256,
  parseAbi,
  toHex,
  toRlp,
} from "viem";

import { withdrawalGasLimit } from "./gas.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// Every message from DuskEVM to Dusk passes the same contract. A withdrawal of
// DUSK is the L2 bridge's own `finalizeBridgeETH`, sent through the L2
// messenger (OP-stack predeploys).
const L2_CROSS_DOMAIN_MESSENGER = "0x4200000000000000000000000000000000000007";

/** Why a DuskEVM transaction isn't followed, proved or claimed as a withdrawal. */
export const NOT_A_DUSK_WITHDRAWAL = "That DuskEVM transaction isn't a DUSK withdrawal.";

/** Why a claim waits: the Portal lets only the account that proved claim with its proof. */
export const PROVED_BY_ANOTHER_ACCOUNT =
  "Another account proved this withdrawal. Your DUSK isn't affected, but only that account can claim with its proof: switch Dusk Wallet to it, or prove it again with this one.";
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const GAME_STATUS = Object.freeze({
  CHALLENGER_WINS: 1,
  DEFENDER_WINS: 2,
  IN_PROGRESS: 0,
});
const GAME_RESOLUTION_ABI = parseAbi([
  "function status() view returns (uint8)",
  "function resolvedAt() view returns (uint64)",
]);
const RELAY_ABI = parseAbi([
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message)",
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData)",
]);
/**
 * Proof and game times on Dusk's clock are within days of the latest block.
 * Older DuskEVM deployments count block height × 10 seconds instead, decades
 * behind it, so their times give no claim time.
 */
const DUSK_CLOCK_WINDOW_SECONDS = 31_536_000n;
const NO_CLAIM_TIME = Object.freeze({ readyAt: null, readyAtExact: false });

export const hashWithdrawal = sdkHashWithdrawal;

export function parseGameSearchDepth(value) {
  const parsed = Number(value ?? 64);
  return Number.isSafeInteger(parsed) && parsed > 0 ? BigInt(parsed) : 64n;
}

export function isWithdrawalTxHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function bytesLikeToArray(value) {
  if (typeof value === "string") {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(value))
      throw new TypeError("Expected 0x-prefixed byte hex");
    return Array.from(hexToBytes(value));
  }
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map((byte) => Number(byte));
  throw new TypeError("Expected byte array or hex string");
}

function fixedBytes(value, expectedLength) {
  const bytes = bytesLikeToArray(value);
  if (expectedLength !== undefined && bytes.length !== expectedLength)
    throw new RangeError(`Expected ${expectedLength} bytes, got ${bytes.length}`);
  return bytes;
}

const bytes32ToHex = (value) =>
  bytesToHex(Uint8Array.from(fixedBytes(value, 32)));
const evmAddressToHex = (value) =>
  bytesToHex(Uint8Array.from(fixedBytes(value, 20)));
const hexToArray = (value, expectedLength) => fixedBytes(value, expectedLength);

export function bigIntToU256(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new RangeError("U256 cannot be negative");
  const bytes = new Array(32).fill(0);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new RangeError("Value does not fit in U256");
  return bytes;
}

export function u256ToBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string")
    return BigInt(value);
  let out = 0n;
  for (const byte of fixedBytes(value, 32)) out = (out << 8n) + BigInt(byte);
  return out;
}

const isZeroU256 = (value) => u256ToBigInt(value) === 0n;

export function withdrawalToDriverInput(withdrawal) {
  const encoded = serializeWithdrawalForDuskAbi(withdrawal);
  return {
    data: hexToArray(encoded.data, undefined),
    ["gas_limit"]: hexToArray(encoded.gas_limit, 32),
    nonce: hexToArray(encoded.nonce, 32),
    sender: hexToArray(encoded.sender, 20),
    target: hexToArray(encoded.target, 20),
    value: hexToArray(encoded.value, 32),
  };
}

function outputRootProofToDriverInput(outputRootProof) {
  const encoded = serializeOutputRootProofForDuskAbi(outputRootProof);
  return {
    ["latest_blockhash"]: hexToArray(encoded.latest_blockhash, 32),
    ["message_passer_storage_root"]: hexToArray(
      encoded.message_passer_storage_root,
      32,
    ),
    ["state_root"]: hexToArray(encoded.state_root, 32),
    version: hexToArray(encoded.version, 32),
  };
}

export function parseWithdrawalReceipt(receipt) {
  if (!receipt) throw new Error("Withdrawal transaction was not found.");
  if (receipt.status === "0x0")
    throw new Error("Withdrawal transaction failed on DuskEVM.");
  try {
    const parsed = parseMessagePassedReceipt(receipt);
    if (parsed.blockNumber === undefined)
      throw new Error("Withdrawal receipt is missing its L2 block number.");
    if (
      String(parsed.withdrawal.sender).toLowerCase() !== L2_CROSS_DOMAIN_MESSENGER ||
      !withdrawalDetails(parsed.withdrawal)
    )
      throw new Error(NOT_A_DUSK_WITHDRAWAL);
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "No MessagePassed event found in receipt"
    )
      throw new Error("Withdrawal MessagePassed event was not found.", {
        cause: error,
      });
    throw error;
  }
}

/**
 * What a native withdrawal moves and to whom: the amount and the Dusk
 * recipient key relayed to Dusk's L1 bridge (`finalizeBridgeETH`), or null
 * when it isn't the L2 bridge's own message moving the value it carries.
 */
export function withdrawalDetails(withdrawal) {
  try {
    const relay = decodeFunctionData({ abi: RELAY_ABI, data: withdrawal.data });
    if (relay.functionName !== "relayMessage") return null;
    const [, sender, , relayValue, , message] = relay.args;
    if (String(sender).toLowerCase() !== L2_STANDARD_BRIDGE_ADDRESS.toLowerCase()) return null;
    const inner = decodeFunctionData({ abi: RELAY_ABI, data: message });
    if (inner.functionName !== "finalizeBridgeETH") return null;
    const [, , amountWei, extraData] = inner.args;
    if (amountWei !== relayValue) return null;
    if (withdrawal.value !== undefined && BigInt(withdrawal.value) !== amountWei) return null;
    const recipientKey = hexToBytes(extraData).slice(3);
    return Object.freeze({
      amountWei,
      // The Dusk account's EVM-shaped address, as the Portal sees its proofs.
      recipientSubmitter: recipientKey.length
        ? `0x${keccak256(recipientKey).slice(-40)}`
        : null,
    });
  } catch {
    return null;
  }
}

export function withdrawalStorageKey(withdrawalHash) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [withdrawalHash, 0n],
    ),
  );
}

export function hashOutputRootProof(outputRootProof) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        outputRootProof.version,
        outputRootProof.stateRoot,
        outputRootProof.messagePasserStorageRoot,
        outputRootProof.latestBlockhash,
      ],
    ),
  );
}

function embeddedProofNode(item) {
  if (Array.isArray(item)) return { node: item, rlp: toRlp(item) };
  if (typeof item !== "string" || !item.startsWith("0x") || item === "0x")
    return null;
  try {
    const decoded = fromRlp(item);
    return Array.isArray(decoded) ? { node: decoded, rlp: item } : null;
  } catch {
    return null;
  }
}

function proofNodePathSuffix(node) {
  const path = node[0];
  return typeof path === "string" ? path.slice(3) : null;
}

/**
 * OP Stack clients append embedded terminal nodes when the storage proof ends
 * in a branch node. Dusk's portal proof verifier follows the same MPT shape.
 */
export function maybeAddProofNode(key, proof) {
  const lastProof = fromRlp(proof[proof.length - 1]);
  if (!Array.isArray(lastProof) || lastProof.length !== 17) return proof;
  const modifiedProof = [...proof];
  for (const item of lastProof) {
    const embedded = embeddedProofNode(item);
    if (embedded === null) continue;
    const suffix = proofNodePathSuffix(embedded.node);
    if (suffix === null || !key.endsWith(suffix)) continue;
    modifiedProof.push(embedded.rlp);
  }
  return modifiedProof;
}

const tupleValue = (value, key, index) => value?.[key] ?? value?.[index];

function l2SequenceFromExtraData(extraData) {
  const bytes = bytesLikeToArray(extraData);
  return bytes.length < 32 ? 0n : u256ToBigInt(bytes.slice(0, 32));
}

function gameL2BlockNumber(metadata) {
  const extraData = tupleValue(metadata, "extraData", 3);
  const explicitL2Sequence = tupleValue(metadata, "l2SequenceNumber", 2);
  return isZeroU256(explicitL2Sequence)
    ? l2SequenceFromExtraData(extraData)
    : u256ToBigInt(explicitL2Sequence);
}

export function proofRequiresReplacement(disposition) {
  return (
    disposition.isGameBlacklisted ||
    disposition.gameStatus === GAME_STATUS.CHALLENGER_WINS
  );
}

/** Whether a proof or game time is on Dusk's clock, near the latest block. */
function onDuskClock(time, latestTimestamp) {
  const distance =
    time > latestTimestamp ? time - latestTimestamp : latestTimestamp - time;
  return distance < DUSK_CLOCK_WINDOW_SECONDS;
}

function finalizationNotReadyMessage(status) {
  if (status.statusMessage) return status.statusMessage;
  switch (status.stage) {
    case "waiting_for_output":
      return "The withdrawal is waiting for an output proposal.";
    case "ready_to_prove":
      return status.provenByOther
        ? PROVED_BY_ANOTHER_ACCOUNT
        : "The withdrawal must be proven before it can be finalized.";
    case "prove_submitted":
      return "The withdrawal proof transaction is still pending.";
    case "proven_waiting":
      return "The withdrawal is proven but not ready to finalize yet.";
    case "finalize_submitted":
      return "The finalization transaction is already pending.";
    case "finalized":
      return "The withdrawal is already finalized.";
    default:
      return "The withdrawal is not ready to finalize yet.";
  }
}

/**
 * @param {object} deps
 * @param {{ call: Record<string, Function> }} deps.portal OptimismPortal reads
 * @param {{ call: Record<string, Function> }} deps.dgf DisputeGameFactory reads
 * @param {(method: string, params: unknown[]) => Promise<any>} deps.l2Rpc DuskEVM JSON-RPC
 * @param {((method: string, params: unknown[]) => Promise<any>) | null} deps.l1Rpc the adapter's L1 RPC
 * @param {() => Promise<bigint>} deps.latestTimestamp latest Dusk block time
 * @param {() => string | null} deps.proofSubmitter the connected account's Portal address
 * @param {() => Promise<bigint>} deps.gasPrice the node's gas price
 * @param {bigint} deps.gasUpper the bridge's gas limit bound
 * @param {bigint} [deps.gameSearchDepth]
 * @param {(fnName: string, args: unknown, gas: object) => Promise<{ hash: string }>} deps.sendPortalCall
 */
export function createWithdrawals(deps) {
  const searchDepth = deps.gameSearchDepth ?? 64n;
  const { portal, dgf } = deps;

  async function fetchL2Receipt(txHash) {
    return deps.l2Rpc("eth_getTransactionReceipt", [txHash]);
  }

  async function callL1Contract(to, data) {
    if (!deps.l1Rpc) throw new Error("DuskEVM L1 bridge RPC is not configured.");
    return deps.l1Rpc("eth_call", [{ data, to }, "latest"]);
  }

  async function getL2Block(blockNumber) {
    const block = await deps.l2Rpc("eth_getBlockByNumber", [
      toHex(blockNumber),
      false,
    ]);
    if (!block) throw new Error(`L2 block ${blockNumber} is not available.`);
    return block;
  }

  async function getWithdrawalProof(withdrawalHash, blockNumber) {
    const key = withdrawalStorageKey(withdrawalHash);
    const proof = await deps.l2Rpc("eth_getProof", [
      L2_TO_L1_MESSAGE_PASSER_ADDRESS,
      [key],
      toHex(blockNumber),
    ]);
    const nodes = proof?.storageProof?.[0]?.proof;
    if (!proof?.storageHash || !Array.isArray(nodes))
      throw new Error("Withdrawal storage proof is not available.");
    return {
      nodes: maybeAddProofNode(keccak256(key), nodes),
      storageRoot: proof.storageHash,
    };
  }

  async function buildWithdrawalOutputProof(withdrawalHash, l2BlockNumber) {
    const [block, withdrawalProof] = await Promise.all([
      getL2Block(l2BlockNumber),
      getWithdrawalProof(withdrawalHash, l2BlockNumber),
    ]);
    const outputRootProof = {
      latestBlockhash: block.hash,
      messagePasserStorageRoot: withdrawalProof.storageRoot,
      stateRoot: block.stateRoot,
      version: ZERO_HASH,
    };
    return {
      outputRoot: hashOutputRootProof(outputRootProof),
      outputRootProof,
      withdrawalProof: withdrawalProof.nodes,
    };
  }

  /**
   * One page of candidate games: their metadata is read in one batch, then
   * each candidate covering the withdrawal block is checked in order.
   */
  async function findProofInGames({ games, withdrawalBlockNumber, withdrawalHash }) {
    let lastError = null;
    const indexes = games.map((game) => u256ToBigInt(tupleValue(game, "index", 0)));
    const metadata = await Promise.all(
      indexes.map((index) =>
        dgf.call.gameMetadataAtIndex(bigIntToU256(index)).then(
          (value) => ({ value }),
          (error) => ({ error: asError(error) }),
        ),
      ),
    );
    for (const [position, index] of indexes.entries()) {
      try {
        if (metadata[position].error) throw metadata[position].error;
        const rootClaim = bytes32ToHex(
          tupleValue(metadata[position].value, "rootClaim", 0),
        );
        const l2BlockNumber = gameL2BlockNumber(metadata[position].value);
        if (l2BlockNumber < withdrawalBlockNumber) continue;
        const proof = await buildWithdrawalOutputProof(withdrawalHash, l2BlockNumber);
        if (proof.outputRoot.toLowerCase() !== rootClaim.toLowerCase()) continue;
        const gameAtIndex = await dgf.call.gameAtIndex(bigIntToU256(index));
        return {
          lastError,
          proof: {
            ...proof,
            disputeGameIndex: index,
            disputeGameProxy: evmAddressToHex(tupleValue(gameAtIndex, "gameProxy", 2)),
            l2BlockNumber,
          },
        };
      } catch (error) {
        lastError = asError(error);
      }
    }
    return { lastError, proof: null };
  }

  async function scanGamePages(options) {
    let { remaining, start } = options;
    let lastError = null;
    while (remaining > 0n) {
      const games = await dgf.call.findLatestGames([
        options.gameType,
        bigIntToU256(start),
        bigIntToU256(remaining > 32n ? 32n : remaining),
      ]);
      if (!games.length) break;
      const result = await findProofInGames({ ...options, games });
      if (result.proof) return result;
      lastError = result.lastError ?? lastError;
      const oldestIndex = u256ToBigInt(tupleValue(games[games.length - 1], "index", 0));
      if (oldestIndex === 0n) break;
      start = oldestIndex - 1n;
      remaining -= BigInt(games.length);
    }
    return { lastError, proof: null };
  }

  async function lookupWithdrawalProof({ snapshot, withdrawalBlockNumber, withdrawalHash }) {
    const gameCount = u256ToBigInt(snapshot.gameCount);
    if (gameCount === 0n)
      return {
        lastError: new Error("No dispute games have been proposed yet."),
        proof: null,
      };
    const result = await scanGamePages({
      gameType: Number(snapshot.respectedGameType),
      remaining: searchDepth,
      start: gameCount - 1n,
      withdrawalBlockNumber,
      withdrawalHash,
    });
    if (result.proof) return result;
    return {
      lastError:
        result.lastError ??
        new Error("No finalized output proposal covering this withdrawal is ready yet."),
      proof: null,
    };
  }

  async function findWithdrawalProof(options) {
    const result = await lookupWithdrawalProof(options);
    if (result.proof) return result.proof;
    throw result.lastError;
  }

  /** The dispute game's status, or when it resolved (0 while in progress). */
  async function readGameResolution(disputeGameProxy, functionName) {
    const data = await callL1Contract(
      disputeGameProxy,
      encodeFunctionData({ abi: GAME_RESOLUTION_ABI, functionName }),
    );
    return BigInt(decodeFunctionResult({ abi: GAME_RESOLUTION_ABI, data, functionName }));
  }

  /**
   * When a proven withdrawal can be claimed: once its proof has matured and
   * its dispute game has resolved for the proposal and become final. The
   * time is exact once the game has resolved. Until then the game needs at
   * least its finality delay, which makes an estimate. A proof time off
   * Dusk's clock gives no claim time, and a game time off it is left out.
   */
  async function claimTime(snapshot, provenWithdrawal, latestTimestamp) {
    if (!onDuskClock(provenWithdrawal.timestamp, latestTimestamp))
      return NO_CLAIM_TIME;
    const proofMaturityDelay = u256ToBigInt(snapshot.proofMaturityDelaySeconds);
    const maturedAt = provenWithdrawal.timestamp + proofMaturityDelay;
    let claimAt = maturedAt;
    let exact = false;
    try {
      const [status, resolvedAt] = await Promise.all([
        readGameResolution(provenWithdrawal.disputeGameProxy, "status"),
        readGameResolution(provenWithdrawal.disputeGameProxy, "resolvedAt"),
      ]);
      const finalityDelay = u256ToBigInt(snapshot.disputeGameFinalityDelaySeconds);
      const resolved = Number(status) === GAME_STATUS.DEFENDER_WINS;
      const finalAt = (resolved ? resolvedAt : latestTimestamp) + finalityDelay;
      if (Number(status) === GAME_STATUS.CHALLENGER_WINS)
        return { ...NO_CLAIM_TIME, proofRejected: true };
      if (!resolved || onDuskClock(resolvedAt, latestTimestamp)) {
        exact = resolved;
        claimAt = finalAt > maturedAt ? finalAt : maturedAt;
      }
    } catch {
      // The proof's maturity alone still gives an estimate.
    }
    return claimAt > latestTimestamp
      ? { readyAt: claimAt, readyAtExact: exact }
      : NO_CLAIM_TIME;
  }

  async function readProvenGameDisposition(disputeGameProxy) {
    const [gameStatus, isGameBlacklisted] = await Promise.all([
      readGameResolution(disputeGameProxy, "status"),
      portal.call.disputeGameBlacklist(hexToArray(disputeGameProxy, 20)),
    ]);
    return {
      gameStatus: Number(gameStatus),
      isGameBlacklisted: Boolean(isGameBlacklisted),
    };
  }

  async function classifyRejectedProofStatus(event, snapshot, provenWithdrawal, claim) {
    try {
      const disposition = await readProvenGameDisposition(provenWithdrawal.disputeGameProxy);
      if (!proofRequiresReplacement(disposition))
        return {
          ...(await claim()),
          stage: "proven_waiting",
          statusMessage:
            disposition.gameStatus === GAME_STATUS.IN_PROGRESS
              ? "The proof is accepted. Its dispute game is still in progress."
              : "The proof is accepted. Wait for its dispute game to become final.",
        };
    } catch {
      return {
        stage: "proven_waiting",
        statusMessage: "The proof is accepted, but its dispute game is not final yet.",
      };
    }
    const proofAvailability = await lookupWithdrawalProof({
      snapshot,
      withdrawalBlockNumber: event.blockNumber,
      withdrawalHash: event.withdrawalHash,
    });
    if (
      proofAvailability.proof &&
      proofAvailability.proof.disputeGameProxy.toLowerCase() !==
        provenWithdrawal.disputeGameProxy.toLowerCase()
    )
      return {
        stage: "ready_to_prove",
        statusMessage:
          "The existing proof is not accepted by the portal, and a newer output proposal is available. Prove the withdrawal again.",
      };
    return {
      proofRejected: true,
      stage: "proven_waiting",
      statusMessage:
        "The existing proof was rejected, but no replacement output proposal is available yet.",
    };
  }

  async function provenWithdrawalGameStatus(event, snapshot, provenWithdrawal, proofSubmitter) {
    const latestTimestamp = await deps.latestTimestamp();
    const readyAt =
      provenWithdrawal.timestamp + u256ToBigInt(snapshot.proofMaturityDelaySeconds);
    const claim = () => claimTime(snapshot, provenWithdrawal, latestTimestamp);
    if (latestTimestamp < readyAt)
      return {
        ...(await claim()),
        stage: "proven_waiting",
        statusMessage: "The proof maturity delay has not elapsed yet.",
      };
    try {
      await portal.call.checkWithdrawal([
        hexToArray(event.withdrawalHash, 32),
        hexToArray(proofSubmitter, 20),
      ]);
    } catch {
      return classifyRejectedProofStatus(event, snapshot, provenWithdrawal, claim);
    }
    return { stage: "ready_to_finalize", statusMessage: "" };
  }

  /**
   * Whether another account holds a proof that still stands. The Portal's own
   * readiness check decides first: it passes, or fails only on maturity, for
   * a proof that stands. A blacklisted game never stands; otherwise a game
   * the challenger hasn't won stands, and an unreadable one doesn't count.
   * Dusk's Portal only lets the account that proved claim with that proof, so
   * the user still needs a proof of their own.
   */
  async function provenByOtherAccount(withdrawalHash, ownSubmitter, count) {
    const n = Number(count > 8n ? 8n : count);
    if (n === 0) return false;
    const hash = hexToArray(withdrawalHash, 32);
    const submitters = (
      await Promise.all(
        Array.from({ length: n }, (_, index) =>
          portal.call.proofSubmitters([hash, bigIntToU256(index)]),
        ),
      )
    )
      .map((address) => evmAddressToHex(address))
      .filter((address) => address.toLowerCase() !== ownSubmitter?.toLowerCase());
    if (!submitters.length) return false;
    const proofs = (
      await Promise.all(
        submitters.map((address) =>
          portal.call.provenWithdrawals([hash, hexToArray(address, 20)]),
        ),
      )
    )
      .map((proof, index) => ({
        address: submitters[index],
        proxy: evmAddressToHex(tupleValue(proof, "disputeGameProxy", 0)),
        timestamp: BigInt(tupleValue(proof, "timestamp", 1)),
      }))
      .filter(({ proxy, timestamp }) => timestamp !== 0n && proxy !== ZERO_ADDRESS);
    // Read together, so a multicall carries each check's own refusal.
    const checks = await Promise.all(
      proofs.flatMap(({ address, proxy }) => [
        portal.call
          .checkWithdrawal([hash, hexToArray(address, 20)])
          .then(() => "ready", (error) => errorMessage(error)),
        portal.call
          .disputeGameBlacklist(hexToArray(proxy, 20))
          .then(Boolean, () => null),
      ]),
    );
    for (const [index, { proxy }] of proofs.entries()) {
      const [check, blacklisted] = checks.slice(index * 2, index * 2 + 2);
      if (blacklisted === true) continue;
      if (check === "ready" || /maturity delay not met/iu.test(check)) return true;
      const status = await readGameResolution(proxy, "status").catch(() => null);
      if (status !== null && Number(status) !== GAME_STATUS.CHALLENGER_WINS) return true;
    }
    return false;
  }

  async function proofStatus(event, snapshot, proofSubmitter) {
    const proven = snapshot.provenWithdrawal;
    if (proven.timestamp === 0n || proven.disputeGameProxy === ZERO_ADDRESS) {
      const proofAvailability = await lookupWithdrawalProof({
        snapshot,
        withdrawalBlockNumber: event.blockNumber,
        withdrawalHash: event.withdrawalHash,
      });
      if (!proofAvailability.proof)
        return {
          ...event,
          proofSubmitter,
          provenAt: proven.timestamp,
          stage: "waiting_for_output",
          statusMessage: errorMessage(proofAvailability.lastError),
        };
      return {
        ...event,
        disputeGameIndex: proofAvailability.proof.disputeGameIndex,
        proofL2BlockNumber: proofAvailability.proof.l2BlockNumber,
        proofSubmitter,
        provenAt: proven.timestamp,
        provenByOther: await provenByOtherAccount(
          event.withdrawalHash,
          proofSubmitter,
          snapshot.proofSubmitterCount,
        ),
        stage: "ready_to_prove",
      };
    }
    const gameStatus = await provenWithdrawalGameStatus(event, snapshot, proven, proofSubmitter);
    return {
      ...event,
      disputeGameProxy: proven.disputeGameProxy,
      proofRejected: gameStatus.proofRejected ?? false,
      proofSubmitter,
      provenAt: proven.timestamp,
      readyAt: gameStatus.readyAt ?? null,
      readyAtExact: gameStatus.readyAtExact ?? false,
      stage: gameStatus.stage,
      statusMessage: gameStatus.statusMessage,
    };
  }

  /**
   * The Portal and game-factory values a status check needs, read at once:
   * through Multicall for Dusk they are one node query.
   */
  async function readSnapshot(withdrawalHash, proofSubmitter) {
    const hash = hexToArray(withdrawalHash, 32);
    const [
      finalized,
      proofSubmitterCount,
      proven,
      proofMaturityDelaySeconds,
      disputeGameFinalityDelaySeconds,
      respectedGameType,
      gameCount,
    ] = await Promise.all([
      portal.call.finalizedWithdrawals(hash),
      portal.call.numProofSubmitters(hash),
      proofSubmitter
        ? portal.call.provenWithdrawals([hash, hexToArray(proofSubmitter, 20)])
        : null,
      portal.call.proofMaturityDelaySeconds(),
      portal.call.disputeGameFinalityDelaySeconds(),
      portal.call.respectedGameType(),
      dgf.call.gameCount(),
    ]);
    return {
      disputeGameFinalityDelaySeconds,
      finalized: Boolean(finalized),
      gameCount,
      proofMaturityDelaySeconds,
      proofSubmitterCount: u256ToBigInt(proofSubmitterCount),
      provenWithdrawal: proven
        ? {
            disputeGameProxy: evmAddressToHex(tupleValue(proven, "disputeGameProxy", 0)),
            timestamp: BigInt(tupleValue(proven, "timestamp", 1)),
          }
        : { disputeGameProxy: ZERO_ADDRESS, timestamp: 0n },
      respectedGameType,
    };
  }

  /**
   * The withdrawal's stage, rebuilt from its DuskEVM transaction hash.
   * `proofSubmitter` is the Dusk account whose proof counts: the connected
   * one when known, else the one recorded or encoded in the withdrawal.
   */
  async function loadWithdrawalStatus(txHash, { proofSubmitter } = {}) {
    if (!isWithdrawalTxHash(txHash))
      throw new Error("Enter a valid DuskEVM withdrawal transaction hash.");
    const event = parseWithdrawalReceipt(await fetchL2Receipt(txHash));
    const details = withdrawalDetails(event.withdrawal);
    const submitter =
      proofSubmitter ?? deps.proofSubmitter() ?? details?.recipientSubmitter ?? null;
    const snapshot = await readSnapshot(event.withdrawalHash, submitter);
    const base = { ...event, details, proofSubmitterCount: snapshot.proofSubmitterCount };
    if (snapshot.finalized) return { ...base, stage: "finalized" };
    if (snapshot.proofSubmitterCount === 0n || !submitter) {
      const availability = await lookupWithdrawalProof({
        snapshot,
        withdrawalBlockNumber: event.blockNumber,
        withdrawalHash: event.withdrawalHash,
      });
      return availability.proof
        ? {
            ...base,
            disputeGameIndex: availability.proof.disputeGameIndex,
            proofL2BlockNumber: availability.proof.l2BlockNumber,
            proofSubmitter: submitter,
            provenByOther: await provenByOtherAccount(
              event.withdrawalHash,
              submitter,
              snapshot.proofSubmitterCount,
            ),
            stage: "ready_to_prove",
          }
        : {
            ...base,
            proofSubmitter: submitter,
            stage: "waiting_for_output",
            statusMessage: errorMessage(availability.lastError),
          };
    }
    return { ...(await proofStatus(base, snapshot, submitter)), details };
  }

  /** Dusk's proof maturity delay, or `null` when it can't be read. */
  async function loadWithdrawalWaitingPeriod() {
    try {
      return u256ToBigInt(await portal.call.proofMaturityDelaySeconds());
    } catch {
      return null;
    }
  }

  /**
   * The gas to prove or claim with: the withdrawal limit plus the gas the
   * withdrawal asks for, at the node's price. Refused above the bound.
   */
  async function withdrawalGas(withdrawalGas = 0n) {
    const limit = withdrawalGasLimit(withdrawalGas, deps.gasUpper);
    return { limit: limit.toString(), price: (await deps.gasPrice()).toString() };
  }

  async function proveWithdrawal(txHash) {
    const event = parseWithdrawalReceipt(await fetchL2Receipt(txHash));
    const submitter = deps.proofSubmitter();
    const snapshot = await readSnapshot(event.withdrawalHash, submitter);
    const proof = await findWithdrawalProof({
      snapshot,
      withdrawalBlockNumber: event.blockNumber,
      withdrawalHash: event.withdrawalHash,
    });
    const gas = await withdrawalGas();
    const response = await deps.sendPortalCall(
      "proveWithdrawalTransaction",
      [
        withdrawalToDriverInput(event.withdrawal),
        bigIntToU256(proof.disputeGameIndex),
        outputRootProofToDriverInput(proof.outputRootProof),
        proof.withdrawalProof.map((node) => hexToArray(node, undefined)),
      ],
      gas,
    );
    return response.hash;
  }

  async function finalizeWithdrawal(txHash) {
    const status = await loadWithdrawalStatus(txHash, {
      proofSubmitter: deps.proofSubmitter(),
    });
    if (status.stage !== "ready_to_finalize")
      throw new Error(finalizationNotReadyMessage(status));
    const gas = await withdrawalGas(status.withdrawal.gasLimit);
    const response = await deps.sendPortalCall(
      "finalizeWithdrawalTransaction",
      withdrawalToDriverInput(status.withdrawal),
      gas,
    );
    return response.hash;
  }

  return Object.freeze({
    finalizeWithdrawal,
    loadWithdrawalStatus,
    loadWithdrawalWaitingPeriod,
    proveWithdrawal,
    withdrawalGas,
  });
}
