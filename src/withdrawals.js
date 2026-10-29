// DuskEVM -> Dusk withdrawal status, proof discovery and Dusk-side actions.
// Ported from the Dusk web wallet's `src/lib/bridge/withdrawals.js` (main,
// 25 Oct 2026): rejected-proof naming and per-operation gas. Reads come from
// the deployment's own Dusk node, batched through Multicall for Dusk: the
// Portal, the dispute game factory, and each game's hub for when it was
// created and resolved. The claim date comes from those, and what a
// withdrawal pays from its message, as every Dusk app reads them
// (@dusk-network/networks/duskevm). The wallet only signs and sends.

import {
  parseMessagePassedReceipt,
  hashWithdrawal as sdkHashWithdrawal,
  serializeOutputRootProofForDuskAbi,
  serializeWithdrawalForDuskAbi,
} from "@dusk/evm-sdk";
import {
  GAME_STATUS,
  claimFrom,
  claimReadiness,
  contractClock,
  contractNow,
  decodeWithdrawal,
  evmAddressOf,
  isCandidateGame,
  isEligibleGame,
  wallTime,
} from "@dusk-network/networks/duskevm";
import {
  bytesToHex,
  encodeAbiParameters,
  fromRlp,
  hexToBytes,
  keccak256,
  toHex,
  toRlp,
} from "viem";

import { DUSKEVM_PREDEPLOYS } from "./config.js";
import { MAX_BATCH } from "./contract-reader.js";
import { withdrawalGasLimit } from "./gas.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const { l2ToL1MessagePasser } = DUSKEVM_PREDEPLOYS;

/** Why a DuskEVM transaction isn't followed, proved or claimed as a withdrawal. */
export const NOT_A_DUSK_WITHDRAWAL = "That DuskEVM transaction isn't a DUSK withdrawal.";

/** Why a claim waits: the Portal lets only the account that proved claim with its proof. */
export const PROVED_BY_ANOTHER_ACCOUNT =
  "Another account proved this withdrawal. Your DUSK isn't affected, but only that account can claim with its proof: switch Dusk Wallet to it, or prove it again with this one.";
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
/** The latest games read for how often outputs come: five gaps. */
const OUTPUT_SAMPLE = 6n;
/** Games searched for one already resolved, a page at a time, at most three pages. */
const RESOLVED_PAGE = 32n;
const RESOLVED_PAGES = 3;
/** Three reads a game: as many games as one Multicall for Dusk query holds. */
const CHECKED_PER_QUERY = Math.floor(MAX_BATCH / 3);
/** How far past a game's earliest resolution its resolver is usually done: 205 blocks at p90. */
const RESOLVER_LAG_SECONDS = 3_600n;

export const hashWithdrawal = sdkHashWithdrawal;

const readU64Le = (bytes) => {
  const data = Uint8Array.from(bytes);
  if (data.length < 8) throw new RangeError("Expected an 8-byte u64.");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) + BigInt(data[index]);
  return value;
};

/**
 * A dispute game hub's views, read raw: no data driver is bundled for it. A
 * game's 20-byte address goes in (nothing for `maxClockDuration`); a u64,
 * little-endian, or the game's status byte comes out.
 */
export const GAME_HUB_DRIVER = Object.freeze({
  decodeOutputFn(fnName, bytes) {
    if (fnName !== "statusForGame") return readU64Le(bytes);
    if (!bytes?.length) throw new RangeError("Expected the game's status byte.");
    return Number(bytes[0]);
  },
  encodeInputFn: (fnName, json) => (fnName === "maxClockDuration" ? new Uint8Array(0) : Uint8Array.from(JSON.parse(json))),
});

/**
 * The anchor state registry the Portal asks whether a game is proper and
 * respected, read raw like the hubs: a game's 20-byte address in, yes or no
 * out. `respectedGameTypeUpdatedAt` takes nothing and gives a u64.
 */
export const GAME_REGISTRY_DRIVER = Object.freeze({
  decodeOutputFn(fnName, bytes) {
    if (fnName === "respectedGameTypeUpdatedAt") return readU64Le(bytes);
    if (bytes?.length !== 1 || bytes[0] > 1) throw new RangeError(`Expected ${fnName}'s yes or no.`);
    return bytes[0] === 1;
  },
  encodeInputFn: (fnName, json) => (fnName === "respectedGameTypeUpdatedAt" ? new Uint8Array(0) : Uint8Array.from(JSON.parse(json))),
});

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

/** The withdrawal a DuskEVM receipt records, on `net`'s bridge route only. */
export function parseWithdrawalReceipt(receipt, net) {
  if (!receipt) throw new Error("Withdrawal transaction was not found.");
  if (receipt.status === "0x0")
    throw new Error("Withdrawal transaction failed on DuskEVM.");
  try {
    const parsed = parseMessagePassedReceipt(receipt);
    if (parsed.blockNumber === undefined)
      throw new Error("Withdrawal receipt is missing its L2 block number.");
    if (!withdrawalDetails(parsed.withdrawal, net)) throw new Error(NOT_A_DUSK_WITHDRAWAL);
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
 * What a native withdrawal moves and to whom, on `net`'s bridge route, as
 * Dusk's L1 bridge pays it out (`decodeWithdrawal`): the amount, who sent it
 * on DuskEVM, the Dusk account or contract it pays, and that account's
 * address as the Portal keeps its proofs. Null for any other message.
 */
export function withdrawalDetails(withdrawal, net) {
  const facts = decodeWithdrawal(net, withdrawal);
  if (!facts) return null;
  const { account, contractId } = facts.recipient;
  return Object.freeze({
    amountWei: facts.amountWei,
    from: facts.from,
    recipient: account ?? contractId,
    recipientSubmitter: account ? evmAddressOf(account).toLowerCase() : null,
  });
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

/** Why this account's proof isn't sent again. */
function provenAlreadyMessage(status) {
  switch (status.stage) {
    case "finalized":
      return "This withdrawal is already claimed.";
    case "ready_to_finalize":
      return "This account already proved this withdrawal. You can claim it now.";
    default:
      return status.proofRejected
        ? status.statusMessage
        : "This account already proved this withdrawal. Claim it once the waiting period ends.";
  }
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
 * @param {(contractId: string) => { call: Record<string, Function> }} deps.hub a dispute game hub's reads, by its contract ID
 * @param {{ call: Record<string, Function> } | null} [deps.registry] the anchor state registry's reads, where it's known
 * @param {(method: string, params: unknown[]) => Promise<any>} deps.l2Rpc DuskEVM JSON-RPC
 * @param {() => Promise<{ height: bigint, timestamp: bigint }>} deps.latestBlock Dusk's latest block
 * @param {() => string | null} deps.proofSubmitter the connected account's Portal address
 * @param {() => Promise<bigint>} deps.gasPrice the node's gas price
 * @param {bigint} deps.gasUpper the bridge's gas limit bound
 * @param {object} deps.network the deployment's network, whose bridge route a withdrawal must take
 * @param {bigint} [deps.gameSearchDepth]
 */
export function createWithdrawals(deps) {
  const searchDepth = deps.gameSearchDepth ?? 64n;
  const { portal, dgf, registry = null } = deps;

  async function fetchL2Receipt(txHash) {
    return deps.l2Rpc("eth_getTransactionReceipt", [txHash]);
  }

  // Dispute game hubs, each with its clock limit, read once. A game type's
  // hub holds the games a search finds; a proven game's own hub is the one
  // the Portal reads, which the factory names for it. Both are fixed for a
  // deployment, so they're read once a session.
  const hubsById = new Map();
  const hubInfo = (bytes) => {
    const id = bytesToHex(Uint8Array.from(fixedBytes(bytes, 32))).slice(2);
    if (!hubsById.has(id)) {
      const hub = deps.hub(id);
      let limit = null;
      const maxClock = () => {
        limit ??= hub.call.maxClockDuration().catch((error) => {
          limit = null;
          throw error;
        });
        return limit;
      };
      hubsById.set(id, { hub, maxClock });
    }
    return hubsById.get(id);
  };
  const once = (cache, key, read) => {
    if (!cache.has(key)) {
      const pending = read();
      pending.catch(() => cache.delete(key));
      cache.set(key, pending);
    }
    return cache.get(key);
  };
  const typeHubs = new Map();
  const gameHub = (gameType) => once(typeHubs, Number(gameType), () => dgf.call.virtualGameHubId(Number(gameType)).then(hubInfo));
  // A proven game's hub, and those already read: a check that knows the
  // proof's game reads it with the Portal's values.
  const gameHubs = new Map();
  const knownGameHubs = new Map();
  const hubOfGame = (proxy) =>
    once(gameHubs, proxy.toLowerCase(), () =>
      dgf.call.gameContractId(hexToArray(proxy, 20)).then((id) => {
        const info = hubInfo(id);
        knownGameHubs.set(proxy.toLowerCase(), info);
        return info;
      }),
    );

  const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error: asError(error) }));

  /**
   * What a proven withdrawal's stage and claim date need beyond the Portal's
   * record: its game on the game's hub, whether the game is blacklisted, and
   * the Portal's own check. Started together, so they go in one query.
   */
  const provenReads = (hub, hash, game, submitter) =>
    [
      ...gameReads(hub, game),
      portal.call.disputeGameBlacklist(hexToArray(game, 20)),
      portal.call.checkWithdrawal([hash, hexToArray(submitter, 20)]),
    ].map(settle);

  /** A game's reads on its hub, started together so they go in one query. */
  const gameReads = ({ hub, maxClock }, proxy) => {
    const address = hexToArray(proxy, 20);
    return [hub.call.createdAtForGame(address), hub.call.resolvedAtForGame(address), hub.call.statusForGame(address), maxClock()];
  };
  const asGame = ([createdAt, resolvedAt, status, maxClockDuration]) => ({
    createdAt: BigInt(createdAt),
    maxClockDuration: BigInt(maxClockDuration),
    resolvedAt: BigInt(resolvedAt),
    status: Number(status),
  });

  /** The Portal's two delays, as `claimFrom` takes them. */
  const portalDelays = (snapshot) => ({
    disputeGameFinalityDelaySeconds: u256ToBigInt(snapshot.disputeGameFinalityDelaySeconds),
    proofMaturityDelaySeconds: u256ToBigInt(snapshot.proofMaturityDelaySeconds),
  });

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
      l2ToL1MessagePasser,
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

  /** A game as a search lists it: its index, creation time, address, root claim and L2 block. */
  function searchedGame(result) {
    const metadata = fixedBytes(tupleValue(result, "metadata", 1), 32);
    return {
      createdAt: BigInt(tupleValue(result, "timestamp", 2)),
      index: u256ToBigInt(tupleValue(result, "index", 0)),
      l2BlockNumber: l2SequenceFromExtraData(tupleValue(result, "extra_data", 4)),
      // A game ID packs its type, its creation time, then its address.
      proxy: evmAddressToHex(metadata.slice(12)),
      rootClaim: bytes32ToHex(tupleValue(result, "root_claim", 3)),
    };
  }

  /**
   * A game covering the withdrawal that has already resolved for its
   * proposal, and that the Portal would take a proof against: one the
   * registry calls proper (registered, not blacklisted, not retired) and
   * respected, created after the respected game type last changed, as the
   * web wallet takes it. A proof against it can be claimed exactly its
   * maturity delay later. Games come at a steady pace, so the search starts
   * about where games are old enough to have resolved, and goes back a few
   * pages. Null when none covers the withdrawal yet, none of them has
   * resolved and passes, or the registry isn't known.
   */
  async function findResolvedProof({ gameCount, gameType, tip, withdrawalBlockNumber, withdrawalHash }) {
    if (!registry) return null;
    const page = async (from) =>
      (await dgf.call.findLatestGames([gameType, bigIntToU256(from), bigIntToU256(RESOLVED_PAGE)])).map(searchedGame);
    // In one query: the type's hub, the newest games, and when the respected
    // game type last changed. Games created then or before are retired.
    const [known, newest, updatedAt] = await Promise.all([
      gameHub(gameType),
      page(gameCount - 1n),
      registry.call.respectedGameTypeUpdatedAt().then(BigInt),
    ]);
    if (newest.length < 2) return null;
    const clock = contractClock(newest[0].createdAt, tip);
    // Its clock ran out, and its resolver's usual lag has passed.
    const cutoff = contractNow(clock, tip) - BigInt(await known.maxClock()) - RESOLVER_LAG_SECONDS;
    // Seconds per factory index: other game types share the index.
    const pace = (newest[0].createdAt - newest.at(-1).createdAt) / (newest[0].index - newest.at(-1).index || 1n) || 1n;
    let from = newest[0].index - (newest[0].createdAt > cutoff ? (newest[0].createdAt - cutoff + pace - 1n) / pace : 0n);
    if (from < 0n) from = 0n;
    for (let pages = 0; pages < RESOLVED_PAGES; pages += 1) {
      const games = await page(from);
      const old = games.filter((game) => game.createdAt <= cutoff);
      // The newest of them doesn't cover the withdrawal: none does.
      if (old.length && old[0].l2BlockNumber < withdrawalBlockNumber) return null;
      const rules = { respectedGameTypeUpdatedAt: updatedAt, withdrawalBlockNumber };
      const covering = old.filter((game) => isCandidateGame(game, rules));
      // Each one's status, and whether the Portal would take it, as the
      // registry it asks says: a query at a time, newest first, until one
      // passes.
      for (let start = 0; start < covering.length; start += CHECKED_PER_QUERY) {
        const batch = covering.slice(start, start + CHECKED_PER_QUERY);
        const checks = await Promise.all(
          batch.flatMap((game) => {
            const address = hexToArray(game.proxy, 20);
            return [
              known.hub.call.statusForGame(address).then(Number, () => null),
              registry.call.isGameProper(address).then(Boolean, () => null),
              registry.call.isGameRespected(address).then(Boolean, () => null),
            ];
          }),
        );
        for (const [position, game] of batch.entries()) {
          const [status, proper, respected] = checks.slice(position * 3, position * 3 + 3);
          if (!isEligibleGame({ ...game, proper, respected, status }, rules)) continue;
          try {
            const proof = await buildWithdrawalOutputProof(withdrawalHash, game.l2BlockNumber);
            if (proof.outputRoot.toLowerCase() === game.rootClaim.toLowerCase())
              return { ...proof, disputeGameIndex: game.index, disputeGameProxy: game.proxy, l2BlockNumber: game.l2BlockNumber };
          } catch {
            // DuskEVM no longer gives that block's proof: an older game won't either.
            return null;
          }
        }
      }
      if (!games.length || games.at(-1).index === 0n) break;
      from = games.at(-1).index - 1n;
    }
    return null;
  }

  /**
   * The game to prove against, with its proof: by default the newest game
   * covering the withdrawal. With `preferResolved` (`{ tip }`), one that has
   * already resolved, where there is one, so the claim date is exact when the
   * proof is made.
   */
  async function lookupWithdrawalProof({ preferResolved = null, snapshot, withdrawalBlockNumber, withdrawalHash }) {
    const gameCount = u256ToBigInt(snapshot.gameCount);
    if (gameCount === 0n)
      return {
        lastError: new Error("No dispute games have been proposed yet."),
        proof: null,
      };
    if (preferResolved) {
      const resolved = await findResolvedProof({
        gameCount,
        gameType: Number(snapshot.respectedGameType),
        tip: preferResolved.tip,
        withdrawalBlockNumber,
        withdrawalHash,
      }).catch(() => null);
      if (resolved) return { lastError: null, proof: resolved };
    }
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

  /** A proof the Portal won't take: proved again against a newer game where there is one. */
  async function replacementStatus(event, snapshot, provenWithdrawal) {
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

  /**
   * A proven withdrawal's stage and claim date. The proof's game is read on
   * its own hub, as the Portal reads it, with whether it's blacklisted and
   * the Portal's own check; the latest block gives the contracts' time. A
   * proof time on the height clock is converted, not dropped. A game that
   * can't be read now leaves the date known so far (no `readyAt`); a date
   * that has passed while the Portal still refuses the claim isn't shown. A
   * claim is ready from its date only: a Portal whose check takes just the
   * proof and its game says yes before it, and refuses the claim itself.
   */
  async function provenWithdrawalGameStatus(event, snapshot, provenWithdrawal, proofSubmitter) {
    const proxy = provenWithdrawal.disputeGameProxy;
    const hash = hexToArray(event.withdrawalHash, 32);
    let reads;
    if (snapshot.ahead?.game === proxy.toLowerCase()) reads = snapshot.ahead.reads;
    else {
      // The Portal's check and the blacklist don't wait for the game's hub.
      const portalReads = [portal.call.disputeGameBlacklist(hexToArray(proxy, 20)), portal.call.checkWithdrawal([hash, hexToArray(proofSubmitter, 20)])].map(settle);
      const gameRead = hubOfGame(proxy).then(
        (hub) => Promise.all(gameReads(hub, proxy).map(settle)),
        (error) => Array.from({ length: 4 }, () => ({ error: asError(error) })),
      );
      reads = Promise.all([gameRead, Promise.all(portalReads)]).then(([game, portalRead]) => [...game, ...portalRead]);
    }
    const [tip, read] = await Promise.all([snapshot.tip ?? deps.latestBlock(), reads]);
    const clock = contractClock(provenWithdrawal.timestamp, tip);
    const provenAt = BigInt(wallTime(provenWithdrawal.timestamp, clock, tip) / 1_000);
    const [check, blacklisted] = [read[5], read[4]];
    const gameRead = read.slice(0, 4);
    const game = gameRead.every((item) => !item.error) ? asGame(gameRead.map((item) => item.value)) : null;
    if (check.error && proofRequiresReplacement({ gameStatus: game?.status, isGameBlacklisted: blacklisted.value === true }))
      return { ...(await replacementStatus(event, snapshot, provenWithdrawal)), claimOverdue: false, provenAt, readyAt: null, readyAtExact: false };
    if (!game)
      return check.error
        ? { provenAt, stage: "proven_waiting", statusMessage: "The proof is accepted, but its dispute game can't be read right now." }
        : { provenAt, stage: "ready_to_finalize", statusMessage: "" };
    const claim = claimFrom({ clock, game, portal: portalDelays(snapshot), provenAt: provenWithdrawal.timestamp, tip });
    const { claimOverdue, ready, readyAt, readyAtExact, refused } = claimReadiness({ claim, portalAccepts: !check.error, tip });
    if (ready) return { claimOverdue, provenAt, readyAt, readyAtExact, stage: "ready_to_finalize", statusMessage: "" };
    return {
      claimOverdue,
      provenAt,
      readyAt,
      readyAtExact,
      stage: "proven_waiting",
      // Past its date and still refused: the date says nothing more.
      statusMessage: refused
        ? "The Portal doesn't take the claim yet."
        : game.status === GAME_STATUS.IN_PROGRESS
          ? "The proof is accepted. Its dispute game is still in progress."
          : "The proof is accepted. Wait for its dispute game to become final.",
    };
  }

  /**
   * Whether another account holds a proof that still stands. The Portal's own
   * readiness check decides first: it passes, or fails only on maturity, for
   * a proof that stands. A blacklisted game never stands; otherwise a game
   * the challenger hasn't won stands, and an unreadable one doesn't count.
   * Dusk's Portal only lets the account that proved claim with that proof, so
   * the user still needs a proof of their own.
   */
  async function provenByOtherAccount(withdrawalHash, ownSubmitter, count, gameType) {
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
    const [known, proofs] = await Promise.all([
      gameHub(gameType).catch(() => null),
      Promise.all(
        submitters.map((address) =>
          portal.call.provenWithdrawals([hash, hexToArray(address, 20)]),
        ),
      ),
    ]);
    const standing = proofs
      .map((proof, index) => ({
        address: submitters[index],
        proxy: evmAddressToHex(tupleValue(proof, "disputeGameProxy", 0)),
        timestamp: BigInt(tupleValue(proof, "timestamp", 1)),
      }))
      .filter(({ proxy, timestamp }) => timestamp !== 0n && proxy !== ZERO_ADDRESS);
    // Read together, so a multicall carries each check's own refusal.
    const checks = await Promise.all(
      standing.flatMap(({ address, proxy }) => [
        portal.call
          .checkWithdrawal([hash, hexToArray(address, 20)])
          .then(() => "ready", (error) => errorMessage(error)),
        portal.call
          .disputeGameBlacklist(hexToArray(proxy, 20))
          .then(Boolean, () => null),
        known ? known.hub.call.statusForGame(hexToArray(proxy, 20)).then(Number, () => null) : null,
      ]),
    );
    for (const index of standing.keys()) {
      const [check, blacklisted, status] = checks.slice(index * 3, index * 3 + 3);
      if (blacklisted === true) continue;
      if (check === "ready" || /maturity delay not met/iu.test(check)) return true;
      if (status !== null && status !== GAME_STATUS.CHALLENGER_WINS) return true;
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
          snapshot.respectedGameType,
        ),
        stage: "ready_to_prove",
      };
    }
    const gameStatus = await provenWithdrawalGameStatus(event, snapshot, proven, proofSubmitter);
    return {
      ...event,
      ...("claimOverdue" in gameStatus ? { claimOverdue: gameStatus.claimOverdue } : {}),
      disputeGameProxy: proven.disputeGameProxy,
      proofRejected: gameStatus.proofRejected ?? false,
      proofSubmitter,
      // Wall-clock seconds, from the contracts' own clock. No `readyAt`: the
      // game couldn't be read, and the date known so far stands.
      provenAt: gameStatus.provenAt,
      ...("readyAt" in gameStatus ? { readyAt: gameStatus.readyAt, readyAtExact: gameStatus.readyAtExact } : {}),
      stage: gameStatus.stage,
      statusMessage: gameStatus.statusMessage,
    };
  }

  /**
   * The Portal and game-factory values a status check needs, read at once:
   * through Multicall for Dusk they are one node query.
   */
  async function readSnapshot(withdrawalHash, proofSubmitter, { game = null } = {}) {
    const hash = hexToArray(withdrawalHash, 32);
    // The game this account proved against before, where it's known and its
    // hub was read: read in the same query, a waiting withdrawal is one
    // query a check.
    const hub = game && proofSubmitter ? knownGameHubs.get(game.toLowerCase()) : null;
    const ahead = hub ? { game: game.toLowerCase(), reads: Promise.all(provenReads(hub, hash, game, proofSubmitter)) } : null;
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
      ahead,
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
  async function loadWithdrawalStatus(txHash, { proofGame = null, proofSubmitter } = {}) {
    if (!isWithdrawalTxHash(txHash))
      throw new Error("Enter a valid DuskEVM withdrawal transaction hash.");
    const event = parseWithdrawalReceipt(await fetchL2Receipt(txHash), deps.network);
    const details = withdrawalDetails(event.withdrawal, deps.network);
    const submitter =
      proofSubmitter ?? deps.proofSubmitter() ?? details?.recipientSubmitter ?? null;
    // With the proof's game known from the last check, the latest block is
    // read alongside: the proof's claim date needs it.
    const tip = proofGame ? deps.latestBlock() : null;
    tip?.catch(() => {});
    const snapshot = { ...(await readSnapshot(event.withdrawalHash, submitter, { game: proofGame })), tip };
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
              snapshot.respectedGameType,
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

  /**
   * How long a withdrawal takes on this network, as Dusk says: the Portal's
   * proof maturity and dispute game finality delays, and how often outputs
   * come, the middle gap between the latest games of the type the Portal
   * takes. Two node queries through Multicall for Dusk: the delays with the
   * game count, then the games.
   */
  async function loadTiming() {
    const [maturity, finality, gameType, count] = await Promise.all([
      portal.call.proofMaturityDelaySeconds(),
      portal.call.disputeGameFinalityDelaySeconds(),
      portal.call.respectedGameType(),
      dgf.call.gameCount(),
    ]);
    const total = u256ToBigInt(count);
    const games =
      total > 1n
        ? await dgf.call.findLatestGames([
            Number(gameType),
            bigIntToU256(total - 1n),
            bigIntToU256(total < OUTPUT_SAMPLE ? total : OUTPUT_SAMPLE),
          ])
        : [];
    const times = games.map((game) => Number(tupleValue(game, "timestamp", 2))).sort((a, b) => b - a);
    const gaps = times
      .slice(1)
      .map((time, index) => times[index] - time)
      .filter((gap) => gap > 0)
      .sort((a, b) => a - b);
    return {
      finalitySeconds: Number(u256ToBigInt(finality)),
      maturitySeconds: Number(u256ToBigInt(maturity)),
      outputSeconds: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    };
  }

  /**
   * The gas to prove or claim with: the withdrawal limit plus the gas the
   * withdrawal asks for, at `price`, the node's as the page quoted it, or
   * else the node's now. Refused above the bound.
   */
  async function withdrawalGas(withdrawalGas = 0n, price = null) {
    const limit = withdrawalGasLimit(withdrawalGas, deps.gasUpper);
    return { limit: limit.toString(), price: (price ?? (await deps.gasPrice())).toString() };
  }

  /**
   * When a proof made now against `proof`'s game can be claimed: exact when
   * the game has resolved, the earliest otherwise. Null when it can't be read.
   */
  async function claimIfProvedNow(snapshot, proof, tip) {
    try {
      const hub = await hubOfGame(proof.disputeGameProxy);
      const game = asGame(await Promise.all(gameReads(hub, proof.disputeGameProxy)));
      const claim = claimFrom({ game, portal: portalDelays(snapshot), tip });
      return claim.at === null ? null : claim;
    } catch {
      return null;
    }
  }

  /**
   * The proof call for a withdrawal, ready to review and send, with the
   * withdrawal it carries and when it can be claimed if proved now.
   * `proofSubmitter` is the account the review is for, read once when it
   * opens; Dusk Wallet's current one otherwise. `gasPrice` is the price its
   * page quoted the step at. The proof is against a game that has already
   * resolved where one covers the withdrawal, so its claim date is exact;
   * otherwise against the newest that covers it.
   */
  async function prepareProve(txHash, { gasPrice = null, proofSubmitter } = {}) {
    const event = parseWithdrawalReceipt(await fetchL2Receipt(txHash), deps.network);
    // A withdrawal whose claim couldn't be sent isn't proved either.
    withdrawalGasLimit(event.withdrawal.gasLimit, deps.gasUpper);
    const submitter = proofSubmitter ?? deps.proofSubmitter();
    const tipRead = deps.latestBlock();
    tipRead.catch(() => {});
    const snapshot = { ...(await readSnapshot(event.withdrawalHash, submitter)), tip: tipRead };
    // A proof this account already has, or one a claimed withdrawal no longer
    // needs, isn't sent again: it would cost its fee for nothing. Only a
    // proof the Portal rejected is replaced.
    const proven = snapshot.provenWithdrawal;
    const status = snapshot.finalized
      ? { stage: "finalized" }
      : proven.timestamp !== 0n && proven.disputeGameProxy !== ZERO_ADDRESS
        ? await proofStatus(event, snapshot, submitter)
        : null;
    if (status && status.stage !== "ready_to_prove") throw new Error(provenAlreadyMessage(status));
    const tip = await tipRead;
    const proof = await findWithdrawalProof({
      preferResolved: { tip },
      snapshot,
      withdrawalBlockNumber: event.blockNumber,
      withdrawalHash: event.withdrawalHash,
    });
    return {
      args: [
        withdrawalToDriverInput(event.withdrawal),
        bigIntToU256(proof.disputeGameIndex),
        outputRootProofToDriverInput(proof.outputRootProof),
        proof.withdrawalProof.map((node) => hexToArray(node, undefined)),
      ],
      claim: await claimIfProvedNow(snapshot, proof, tip),
      fnName: "proveWithdrawalTransaction",
      // The claim's limit too: one "up to" fee for both steps.
      gas: await withdrawalGas(event.withdrawal.gasLimit, gasPrice),
      withdrawal: event.withdrawal,
    };
  }

  /**
   * The claim call for a withdrawal that is ready, to review and send, with
   * the withdrawal it carries, at the gas price its page quoted (`gasPrice`).
   */
  async function prepareFinalize(txHash, { gasPrice = null, proofSubmitter } = {}) {
    const status = await loadWithdrawalStatus(txHash, {
      proofSubmitter: proofSubmitter ?? deps.proofSubmitter(),
    });
    if (status.stage !== "ready_to_finalize")
      throw new Error(finalizationNotReadyMessage(status));
    return {
      args: withdrawalToDriverInput(status.withdrawal),
      fnName: "finalizeWithdrawalTransaction",
      gas: await withdrawalGas(status.withdrawal.gasLimit, gasPrice),
      withdrawal: status.withdrawal,
    };
  }

  return Object.freeze({
    loadTiming,
    loadWithdrawalStatus,
    prepareFinalize,
    prepareProve,
  });
}
