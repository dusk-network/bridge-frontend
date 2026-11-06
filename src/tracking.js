// Follows each bridge transfer to its end on the other side. Everything is
// rebuilt from the route and the source transaction hash; stored fields only
// save work (where a search left off) or remember what this browser sent.
// Which payout or credit on the other side is a transfer's, each paying one
// transfer in the order they were sent, @dusk-network/app-core/bridge says.

import { CREDIT_WINDOW_MS, depositArrivals, migrationFacts, migrationPayouts, serviceArrivals } from "@dusk-network/app-core/bridge";
import { WithdrawalError } from "@dusk-network/app-core/duskevm-withdrawals";
import { isAccount } from "@dusk-network/networks/account";
import { BRIDGE_FUNCTIONS, decodeBridgeCall } from "@dusk-network/networks/duskevm";
import { observeDepositStatus } from "@dusk/evm-sdk";
import { decodeFunctionData, toHex } from "viem";

import { MIGRATION_ABI } from "./legacy-migration.js";
import { networkName } from "./names.js";
import { normalizeEvmAddress } from "./validation.js";
import { NOT_A_DUSK_WITHDRAWAL, waitWords } from "./withdrawals.js";

export const STATUS_WORDS = Object.freeze({
  completed: "Completed",
  failed: "Failed",
  pending: "Pending",
});

const WEI_PER_LUX = 1_000_000_000n;

/** Why a transfer to the bridge account pays nothing out. */
const NO_PAYOUT = Object.freeze({
  elsewhere: "This transfer didn't go to the bridge account.",
  failed: "The transfer failed on Dusk.",
  "no-address": "The memo isn't an EVM address, so the bridge can't pay it out.",
  "under-fee": "The amount didn't exceed the bridge fee, so nothing is paid out.",
});

/** Why a migration sent from here never happened: the wallet sent something else on its nonce. */
const REPLACED = Object.freeze({
  cancelled: "It was cancelled in the wallet, so nothing moved.",
  replaced: "The wallet sent another transaction in its place, so nothing moved.",
});

/** A transfer that went through and pays nothing out: it's a failure, though the DUSK moved. */
const PAID_NOTHING = Object.freeze({ receivedLux: "0" });

const UNSURE_DEPOSIT =
  "An equal deposit to the same address was sent just before this one, so its credit can't be told apart. Check the address on the DuskEVM explorer.";
// "late": its window closed without a credit, as when the sender's history can't be read.
const LATE_DEPOSIT = `No credit came within ${CREDIT_WINDOW_MS / 60_000} minutes of this deposit, and a later one can't be told apart from another transfer's. Check the address on the DuskEVM explorer.`;

/** What a Dusk transaction paid: the gas it spent at its price, in Lux. */
export function duskFeePaid(tx) {
  try {
    if (tx?.gasSpent === null || tx?.gasSpent === undefined) return undefined;
    return (BigInt(tx.gasSpent) * BigInt(tx.json?.fee?.gas_price ?? 1)).toString();
  } catch {
    return undefined;
  }
}

const pending = (note, extra = {}) => ({ ...extra, note, status: "pending" });
const failed = (note, extra = {}) => ({ ...extra, note, status: "failed" });
const completed = (extra = {}) => ({ ...extra, note: "", status: "completed" });

/**
 * A transfer's arrival as @dusk-network/app-core/bridge gives it, in this
 * page's words: completed, failed when it pays nothing out, or pending,
 * with where the search stopped. A read that failed throws, as any check's.
 */
function outcome(arrival, patch, waiting, unsure = waiting, late = unsure) {
  if (arrival.state === "arrived")
    return completed({ ...patch, destinationAt: arrival.at, destinationHash: arrival.hash, receivedLux: arrival.amount.toString() });
  if (arrival.reason === "error") throw new Error(arrival.error);
  if (arrival.reason === "no-payout") return failed(NO_PAYOUT[arrival.problem], { ...patch, ...PAID_NOTHING });
  return pending(arrival.reason === "unsure" ? unsure : arrival.reason === "late" ? late : waiting, { ...patch, scan: arrival.scan });
}

function memoText(hex) {
  if (!hex) return "";
  try {
    const value = String(hex).replace(/^0x/iu, "");
    const bytes = Uint8Array.from(value.match(/../gu) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * Destination transactions other transfers already arrived with: each payout
 * or credit belongs to one transfer only.
 */
export function takenDestinations(entry, others = []) {
  return new Set(
    others
      .filter((other) => other.id !== entry.id && other.destinationHash)
      .map((other) => String(other.destinationHash).toLowerCase()),
  );
}

/** Whether `patch` completes `entry` with a destination another transfer has. */
export const takenByAnother = (entry, patch, others = []) =>
  patch?.status === "completed" &&
  Boolean(patch.destinationHash) &&
  takenDestinations(entry, others).has(String(patch.destinationHash).toLowerCase());

const sameAddress = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

const isMethodMissing = (error) =>
  error?.code === -32601 || /method not found|does not exist/iu.test(error?.message ?? "");

/**
 * @param {object} deps
 * @param {object} deps.archive the Dusk node's archive (@dusk-network/app-core/history)
 * @param {object} deps.config the deployment config
 * @param {object} deps.node the Dusk node client
 * @param {(network: string, method: string, params: unknown[]) => Promise<any>} deps.rpc
 *   JSON-RPC by network: "ethereum", "bsc", "dusk-evm" or "dusk-evm-l1"
 * @param {object} [deps.withdrawals] the page's withdrawals (withdrawals.js)
 * @param {(network: string) => object} [deps.receiptClient] viem client, for the adapter path
 * @param {() => number} [deps.now]
 * @param {typeof fetch} [deps.fetch] what the payout searches, and the reads of what a migration paid, send their requests with
 * @param {{ get: (key: string) => string | null | undefined, set: (key: string, value: string) => void }} [deps.cache] where what a migration paid is kept once it's final
 */
export function createTracking(deps) {
  const { archive, config, node, rpc } = deps;
  const now = deps.now ?? Date.now;
  const name = (id) => networkName(config, id);
  let adapterLookup = "unknown";
  // Each chain's block times, as the payout searches read them, and the
  // calls of the deposits a sender's history lists, once their blocks are
  // final: neither changes.
  const blockTimes = new Map();
  const depositCalls = new Map();
  /** A payout search on `network`'s RPC, however long ago the transfer was sent. */
  const searchOn = (network, rpcUrl) => {
    if (!blockTimes.has(network)) blockTimes.set(network, new Map());
    return { blockTimes: blockTimes.get(network), fetch: deps.fetch, network: config.network, now: now(), rpcUrl, waitMs: Infinity };
  };
  // The head this browser read before sending a transfer: its payout can't
  // come before it. An older check kept where its search stopped there instead.
  const sentFrom = (entry) => (entry.scanBasis === undefined ? entry.scanFrom : null);
  // Equal transfers this browser follows that haven't ended: the archive may
  // not list them yet, and the earlier ones are paid first.
  const waitingAlike = (entry, others, alike) =>
    others.filter((other) => other.id !== entry.id && other.routeId === entry.routeId && other.status === "pending" && other.sourceAt && alike(other));
  /** A Dusk call's deposit to DuskEVM, read from its arguments, or null for any other call. */
  const depositOf = (call) => {
    const read = call ? decodeBridgeCall(config.network, { args: call.data, contractId: call.contractId, fnName: call.fnName }) : null;
    return read?.kind === "deposit" ? read : null;
  };

  async function blockTime(network, number) {
    const block = await rpc(network, "eth_getBlockByNumber", [toHex(BigInt(number)), false]);
    return block ? Number(BigInt(block.timestamp)) * 1_000 : null;
  }

  /**
   * What the approval this browser sent with a migration the wallet then
   * cancelled or replaced paid, read once from its receipt, where `sender`
   * sent it: no migration was mined, and that's what the transfer cost.
   */
  async function approvalFee(entry, network, sender) {
    if (!entry.approvalHash || entry.approvalFeeWei !== undefined) return {};
    const approval = await rpc(network, "eth_getTransactionReceipt", [entry.approvalHash]);
    return approval?.gasUsed && approval.effectiveGasPrice && sameAddress(approval.from, sender)
      ? { approvalFeeWei: (BigInt(approval.gasUsed) * BigInt(approval.effectiveGasPrice)).toString() }
      : {};
  }

  /**
   * What a migration paid on its own chain, with the approval it spent there,
   * whichever app signed that and whenever (`migrationFacts`): the one this
   * browser sent with it is named, so its receipt is read at any age. What's
   * final is kept in `deps.cache`. Null for one the wallet cancelled or
   * replaced, which was never mined.
   */
  async function migrationEvm(entry, route) {
    if (route.mode !== "migration" || entry.replaced || !entry.hash) return null;
    const read = await migrationFacts({
      cache: deps.cache,
      fetch: deps.fetch,
      migrations: [{ approval: entry.approvalHash ?? null, hash: entry.hash, route: route.id }],
      network: config.network,
      rpcUrl: config.evmNetworks[route.from.id]?.rpcUrl,
    });
    return read.get(String(entry.hash).toLowerCase()) ?? null;
  }

  async function refreshMigration(entry, route, others) {
    const network = route.from.id;
    // Cancelled or replaced in the wallet after it was sent: there's no
    // migration, though its approval was paid for.
    if (entry.replaced)
      return failed(REPLACED[entry.replaced] ?? REPLACED.replaced, { ...(await approvalFee(entry, network, entry.sender)), sourceFailed: true });
    const patch = {};
    if (!entry.destination || !entry.amountLux) {
      const tx = await rpc(network, "eth_getTransactionByHash", [entry.hash]);
      if (tx?.input) {
        try {
          const { args } = decodeFunctionData({ abi: MIGRATION_ABI, data: tx.input });
          patch.amountLux = (args[0] / WEI_PER_LUX).toString();
          patch.destination = args[1];
          patch.sender = tx.from;
        } catch {
          return failed("This transaction isn't a migration.");
        }
      }
    }
    const receipt = await rpc(network, "eth_getTransactionReceipt", [entry.hash]);
    if (!receipt) return pending(`Waiting for ${name(network)}.`, patch);
    patch.sourceAt = entry.sourceAt ?? (await blockTime(network, receipt.blockNumber));
    // A migration found by its payout has no sender yet.
    patch.sender ??= entry.sender ?? receipt.from;
    // What it paid, with its approval, is read for its receipt (`migrationEvm`).
    if (receipt.status === "0x0")
      return failed(`The migration failed on ${name(network)}.`, { ...patch, sourceFailed: true });
    const recipient = patch.destination ?? entry.destination;
    const amountLux = patch.amountLux ?? entry.amountLux;
    const waiting = `Waiting for the payout on ${name("dusk")}.`;
    // Paid out to the Dusk account the migration names, as a transfer from
    // the route's payout account with the migration's hash as the memo.
    if (amountLux === undefined || !isAccount(recipient)) return pending(waiting, patch);
    const { payouts } = await migrationPayouts({
      account: recipient,
      archive,
      migrations: [{ amount: amountLux, hash: entry.hash, route: route.id }],
      network: config.network,
      now: now(),
      taken: takenDestinations(entry, others),
    });
    const [payout] = payouts.values();
    return outcome(payout, patch, waiting);
  }

  async function refreshServiceTransfer(entry, route, others) {
    const service = config.service;
    const network = route.to.id;
    const tx = await node.transaction(entry.hash);
    if (!tx) return pending(`Waiting for ${name("dusk")}.`);
    const sourceAt = tx.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
    if (tx.error) return failed(NO_PAYOUT.failed, { sourceAt, sourceFailed: true });
    const value = BigInt(tx.json?.value ?? 0);
    const recipient = memoText(tx.memo);
    const patch = {
      amountLux: value.toString(),
      destination: recipient,
      feeLux: duskFeePaid(tx),
      sender: tx.json?.sender,
      sourceAt,
    };
    if (tx.json?.receiver !== service.account) return failed(NO_PAYOUT.elsewhere, { ...patch, ...PAID_NOTHING });
    if (value <= service.feeLux) return failed(NO_PAYOUT["under-fee"], { ...patch, ...PAID_NOTHING });
    try {
      normalizeEvmAddress(recipient);
    } catch {
      return failed(NO_PAYOUT["no-address"], { ...patch, ...PAID_NOTHING });
    }
    // The DUSK token's transfer from the route's payout address to the memo's.
    const peers = waitingAlike(entry, others, (other) => sameAddress(other.destination, recipient) && String(other.amountLux) === patch.amountLux);
    const { arrivals } = await serviceArrivals({
      ...searchOn(network, config.evmNetworks[network].rpcUrl),
      archive,
      taken: takenDestinations(entry, others),
      transfers: [entry, ...peers].map((item) => ({ fee: service.feeLux, hash: item.hash, notBefore: sentFrom(item), route: route.id, scan: item.scan })),
    });
    const [arrival] = arrivals.values();
    return outcome(arrival, patch, `Waiting for the payout on ${name(network)}.`);
  }

  async function adapterCredit(hash) {
    if (adapterLookup === "missing") return undefined;
    let l1Hash;
    try {
      l1Hash = await rpc("dusk-evm-l1", "duskevm_getTransactionHashByDuskHash", [hash]);
    } catch (error) {
      if (!isMethodMissing(error)) throw error;
      // This adapter can't map Dusk hashes; watch the bridge event instead.
      adapterLookup = "missing";
      return undefined;
    }
    adapterLookup = "available";
    if (!l1Hash) return null;
    const status = await observeDepositStatus({
      l1Client: deps.receiptClient("dusk-evm-l1"),
      l1TransactionHash: l1Hash,
      l2Client: deps.receiptClient("dusk-evm"),
    });
    const stage = status.metadata?.stage;
    if (stage === "failed") return { failed: status.message ?? "The deposit failed on DuskEVM." };
    if (stage !== "completed") return null;
    const l2Hash = status.metadata.l2TransactionHash;
    const receipt = await rpc("dusk-evm", "eth_getTransactionReceipt", [l2Hash]);
    return {
      at: receipt ? await blockTime("dusk-evm", receipt.blockNumber) : null,
      hash: l2Hash,
    };
  }

  async function refreshDeposit(entry, others) {
    const tx = await node.transaction(entry.hash);
    if (!tx) return pending(`Waiting for ${name("dusk")}.`);
    const sourceAt = tx.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
    const call = tx.callData;
    if (
      call?.fnName !== BRIDGE_FUNCTIONS.deposit ||
      String(call.contractId).toLowerCase() !== config.duskEvm.l1StandardBridgeContractId
    )
      return failed("This transaction isn't a DuskEVM deposit.", { sourceAt });
    const args = depositOf(call);
    // Arguments that don't read as a deposit's never put DUSK in the bridge.
    if (!args)
      return failed(
        tx.error ? "The Dusk transaction failed, so the deposit didn't enter the bridge." : "This transaction isn't a DuskEVM deposit.",
        { feeLux: duskFeePaid(tx), sender: tx.json?.sender, sourceAt },
      );
    const patch = {
      amountLux: args.amountLux.toString(),
      destination: args.recipient,
      feeLux: duskFeePaid(tx),
      sender: tx.json?.sender,
      sourceAt,
    };
    if (tx.error)
      return failed("The Dusk transaction failed, so the deposit didn't enter the bridge.", { ...patch, sourceFailed: true });
    const viaAdapter = await adapterCredit(entry.hash);
    if (viaAdapter?.failed) return failed(viaAdapter.failed, patch);
    if (viaAdapter?.hash)
      return completed({ ...patch, destinationAt: viaAdapter.at, destinationHash: viaAdapter.hash });
    if (viaAdapter === null) return pending(`Waiting for ${name("dusk-evm")}.`, patch);
    // The L2 bridge's credit from the sender's DuskEVM address, with the
    // sender's equal deposits just before this one paid first: those its
    // history lists, and those this browser follows, at their own blocks.
    const peers = waitingAlike(entry, others, (other) => sameAddress(other.destination, args.recipient) && String(other.amountLux) === patch.amountLux && other.sender === patch.sender);
    const peerTxs = await Promise.all(peers.map((other) => node.transaction(other.hash).catch(() => null)));
    const deposit = (item, itemTx) => ({
      amount: args.amountLux,
      at: itemTx.blockTimestamp ? Number(itemTx.blockTimestamp) * 1_000 : null,
      hash: item.hash,
      height: Number(itemTx.blockHeight),
      notBefore: sentFrom(item),
      scan: item.scan,
      sender: patch.sender ?? null,
      to: args.recipient,
    });
    const { arrivals } = await depositArrivals({
      ...searchOn("dusk-evm", config.duskEvm.rpcUrl),
      archive,
      cache: depositCalls,
      deposits: [deposit(entry, tx), ...peers.flatMap((other, i) => (peerTxs[i] && !peerTxs[i].error ? [deposit(other, peerTxs[i])] : []))],
      taken: takenDestinations(entry, others),
      via: "rpc",
    });
    const [arrival] = arrivals.values();
    return outcome(arrival, patch, `Waiting for ${name("dusk-evm")}.`, UNSURE_DEPOSIT, LATE_DEPOSIT);
  }

  async function settlePendingAction(entry, status) {
    if (!entry.pendingAction || !entry.pendingHash) return { status };
    let tx = null;
    try {
      tx = await node.transaction(entry.pendingHash);
    } catch {
      tx = null;
    }
    const at = tx?.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
    // A proof the Portal took, from this transaction's time or later, and
    // then rejected with a newer output to prove against: the withdrawal is
    // ready to prove again, and this proof is settled.
    const replaceable =
      entry.pendingAction === "prove" &&
      status.stage === "ready_to_prove" &&
      at !== null &&
      !tx?.error &&
      Number(status.provenAt ?? 0) * 1_000 >= at;
    const done =
      entry.pendingAction === "finalize"
        ? status.stage === "finalized"
        : replaceable || !["ready_to_prove", "submitted", "waiting_for_output"].includes(status.stage);
    const sent = entry.pendingAction === "prove"
      ? { proveAt: at, proveFeeLux: duskFeePaid(tx), proveHash: entry.pendingHash }
      : { claimAt: at, claimFeeLux: duskFeePaid(tx), claimHash: entry.pendingHash };
    if (done) return { patch: { ...sent, pendingAction: null, pendingHash: null }, status };
    if (tx?.error)
      return {
        patch: {
          actionError: `${entry.pendingAction === "prove" ? "Proof" : "Claim"} transaction failed: ${tx.error}`,
          pendingAction: null,
          pendingHash: null,
        },
        status,
      };
    // Included, but the Portal doesn't show it yet: the action stays pending
    // until it does, so it isn't offered again meanwhile.
    if (tx)
      return {
        patch: sent,
        status: { ...status, stage: entry.pendingAction === "prove" ? "prove_submitted" : "finalize_submitted" },
      };
    return {
      patch: {},
      status: {
        ...status,
        stage: entry.pendingAction === "prove" ? "prove_submitted" : "finalize_submitted",
      },
    };
  }

  async function refreshWithdrawal(entry) {
    let status;
    try {
      status = await deps.withdrawals.status(entry.hash, {
        // The proof's game, as the last check found it: read in the same query.
        proofGame: entry.proofGame ?? null,
        // The account that proved, once this browser sent a proof or a claim;
        // before that, the connected account's proof, or the recipient's.
        submitter: entry.proveHash || entry.claimHash || entry.pendingHash ? entry.proofSubmitter ?? null : null,
      });
    } catch (error) {
      const refused = error instanceof WithdrawalError ? error.code : null;
      if (refused === "not-found") return pending(`Waiting for ${name("dusk-evm")}.`, { stage: "submitted" });
      if (refused === "failed")
        return failed("The withdrawal failed on DuskEVM. Your DUSK is still there.", {
          stage: "failed",
        });
      // Another message to Dusk, or no message at all: nothing to prove or claim.
      if (refused === "not-a-withdrawal") return failed(NOT_A_DUSK_WITHDRAWAL, { stage: "failed" });
      throw error;
    }
    const settled = await settlePendingAction(entry, status);
    const current = settled.status;
    // A proof whose game couldn't be read this time says no date: the one known so far stands.
    const dated = "readyAt" in current || !["proven_waiting", "ready_to_finalize"].includes(current.stage);
    // What it pays and to whom, as Dusk's L1 bridge pays it out.
    const { amountWei, from, recipient } = current.facts ?? {};
    const patch = {
      ...(settled.patch ?? {}),
      amountLux: amountWei ? (amountWei / WEI_PER_LUX).toString() : entry.amountLux,
      destination: recipient ? (recipient.account ?? recipient.contractId) : entry.destination,
      sender: from ?? entry.sender,
      // Claiming adds this to its gas limit: the quote's maximum uses it.
      withdrawalGas: current.withdrawal?.gasLimit === undefined ? entry.withdrawalGas : String(current.withdrawal.gasLimit),
      proofRejected: current.proofRejected ?? false,
      provenByOther: current.provenByOther ?? false,
      // Whose proof the stage is: the account that proved here, Dusk
      // Wallet's, or else the withdrawal's recipient's.
      stageSubmitter: current.proofSubmitter ?? null,
      // The Portal's proof time, on the wall clock, its game, and when it can be claimed.
      proofGame: current.disputeGameProxy ?? null,
      provenAt: current.provenAt ? Number(current.provenAt) * 1_000 : null,
      claimOverdue: dated ? (current.claimOverdue ?? false) : (entry.claimOverdue ?? false),
      readyAt: dated ? (current.readyAt ? Number(current.readyAt) : null) : (entry.readyAt ?? null),
      readyAtExact: dated ? (current.readyAtExact ?? false) : (entry.readyAtExact ?? false),
      sourceAt:
        entry.sourceAt ??
        (current.blockNumber === undefined ? null : await blockTime("dusk-evm", current.blockNumber)),
      stage: current.stage,
      statusMessage: waitWords(status),
      withdrawalHash: current.withdrawalHash,
    };
    if (current.stage === "finalized") return completed(patch);
    // The stage's own wording is shown; `statusMessage` stays for details.
    return pending("", patch);
  }

  /**
   * The entry's state, from the chain. `others` are the other transfers this
   * browser follows: a payout or credit one of them took isn't this one's.
   */
  async function refresh(entry, route, { others = [] } = {}) {
    switch (route.mode) {
      case "migration":
        return refreshMigration(entry, route, others);
      case "service-transfer":
        return refreshServiceTransfer(entry, route, others);
      case "duskevm-deposit":
        return refreshDeposit(entry, others);
      case "duskevm-withdrawal":
        return refreshWithdrawal(entry, route);
      default:
        throw new Error(`Unknown route ${route.id}.`);
    }
  }

  return Object.freeze({ migrationEvm, refresh });
}

/**
 * Re-checks pending entries until they end: often while an action waits, or
 * while `due` says an entry's arrival is looked out for now, less when the
 * page is hidden.
 */
export function createScheduler({ check, due = () => false, intervals = {} }) {
  const delays = { action: 5_000, active: 15_000, due: 5_000, hidden: 60_000, ...intervals };
  const timers = new Map();
  // Entries being checked now. Tracking one again then asks for one more
  // check right after it, so each entry has one loop and its patches land in
  // order.
  const checking = new Map();
  let stopped = false;

  function delayFor(entry) {
    if (entry?.pendingAction) return delays.action;
    if (globalThis.document?.visibilityState === "hidden") return delays.hidden;
    return entry && due(entry) ? delays.due : delays.active;
  }

  async function run(id) {
    timers.delete(id);
    if (stopped) return;
    const state = { again: false };
    checking.set(id, state);
    let entry;
    try {
      entry = await check(id);
    } finally {
      checking.delete(id);
    }
    if (stopped) return;
    if (state.again) timers.set(id, setTimeout(() => void run(id), 0));
    else if (entry && entry.status === "pending") timers.set(id, setTimeout(() => void run(id), delayFor(entry)));
  }

  return Object.freeze({
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    /** Starts following `id`, or checks it now if it's already followed. */
    track(id) {
      const running = checking.get(id);
      if (running) {
        running.again = true;
        return;
      }
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => void run(id), 0));
    },
  });
}
