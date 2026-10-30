// Follows each bridge transfer to its end on the other side. Everything is
// rebuilt from the route and the source transaction hash; stored fields only
// save work (where a search left off) or remember what this browser sent.

import { historyRange } from "@dusk-network/app-core/history";
import { BRIDGE_FUNCTIONS, decodeBridgeCall, evmAddressOf } from "@dusk-network/networks/duskevm";
import { observeDepositStatus } from "@dusk/evm-sdk";
import {
  decodeEventLog,
  decodeFunctionData,
  pad,
  parseAbi,
  toEventSelector,
  toHex,
} from "viem";

import { MIGRATION_ABI } from "./legacy-migration.js";
import { networkName } from "./names.js";
import { normalizeEvmAddress } from "./validation.js";
import { NOT_A_DUSK_WITHDRAWAL } from "./withdrawals.js";

export const STATUS_WORDS = Object.freeze({
  completed: "Completed",
  failed: "Failed",
  pending: "Pending",
});

const WEI_PER_LUX = 1_000_000_000n;
const LOG_WINDOW = 1_000n;
const MAX_WINDOWS_PER_CHECK = 40;
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const ETH_BRIDGE_FINALIZED = parseAbi([
  "event ETHBridgeFinalized(address indexed from, address indexed to, uint256 amount, bytes extraData)",
]);
const ETH_BRIDGE_FINALIZED_TOPIC = toEventSelector(ETH_BRIDGE_FINALIZED[0]);

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

// Equal transfers (same route, recipient and amount) are paid in the order
// sent. One sent less than this before the next can still be waiting for its
// payout when the next one's comes: the bridge account pays within the hour,
// DuskEVM credits a deposit within minutes.
const SERVICE_ORDER_HORIZON_MS = 12 * 3_600_000;
const DEPOSIT_ORDER_HORIZON_MS = 2 * 3_600_000;
// A deposit's equal deposits are read from its sender's history, three
// horizons back at about one Dusk block per 10 seconds, a page at a time.
const DUSK_BLOCK_MS = 10_000;
const HISTORY_PAGES = 4;
const DUSK_HASH = /^[0-9a-f]{64}$/u;

const lower = (value) => String(value ?? "").toLowerCase();

/**
 * Where the search for a transfer's payout starts (`since`, in ms) and how
 * many matches it leaves to equal transfers sent just before it (`skip`).
 * `alike` lists the equal transfers the source chain knows (`{ hash, at }`),
 * so the order is the same on any device. Those sent shortly before this one,
 * each within `horizonMs` of the next, are paid first; older ones were paid
 * before. One `settled` here is left out by its payout instead of counted.
 */
export function orderAmongAlike(entry, alike, { horizonMs, settled = new Set() }) {
  const own = lower(entry.hash);
  const byHash = new Map();
  for (const item of alike)
    if (Number.isFinite(item?.at)) byHash.set(lower(item.hash), { at: item.at, hash: lower(item.hash) });
  byHash.set(own, { at: entry.sourceAt, hash: own });
  const list = [...byHash.values()].sort((a, b) => a.at - b.at || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  let index = list.findIndex((item) => item.hash === own);
  let skip = 0;
  while (index > 0 && list[index].at - list[index - 1].at <= horizonMs) {
    index -= 1;
    if (!settled.has(list[index].hash)) skip += 1;
  }
  return { since: list[index].at, skip };
}

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
 * @param {object} [deps.withdrawals] the withdrawal service
 * @param {(network: string) => object} [deps.receiptClient] viem client, for the adapter path
 * @param {() => number} [deps.now]
 */
export function createTracking(deps) {
  const { archive, config, node, rpc } = deps;
  const now = deps.now ?? Date.now;
  const name = (id) => networkName(config, id);
  let adapterLookup = "unknown";
  // A transfer's equal transfers, once the archive lists the transfer itself:
  // earlier ones don't change after that.
  const alikeRead = new Map();

  /** Equal transfers this browser follows, in case the archive hasn't listed them. */
  const localAlike = (entry, others, isAlike) =>
    others
      .filter((other) => other.id !== entry.id && other.status !== "failed" && other.sourceAt && isAlike(other))
      .map((other) => ({ at: other.sourceAt, hash: other.hash }));
  const settledHashes = (others) =>
    new Set(others.filter((other) => other.status === "completed" && other.destinationHash).map((other) => lower(other.hash)));
  /** A Dusk call's deposit to DuskEVM, read from its arguments, or null for any other call. */
  const depositOf = (call) => {
    const read = call ? decodeBridgeCall(config.network, { args: call.data, contractId: call.contractId, fnName: call.fnName }) : null;
    return read?.kind === "deposit" ? read : null;
  };

  /** When each Dusk transaction was sent, leaving out failed ones; one query for all. */
  async function sentTimes(hashes) {
    const txs = await Promise.all(hashes.map((hash) => node.transaction(hash).catch(() => null)));
    return txs.flatMap((tx, index) =>
      tx?.blockTimestamp && !tx.error ? [{ at: Number(tx.blockTimestamp) * 1_000, hash: hashes[index], tx }] : [],
    );
  }

  /** Transfers to the bridge account paying `to` the same value, from the archive's memo index. */
  async function serviceAlike(entry, to, value) {
    const key = `service:${lower(entry.hash)}`;
    if (alikeRead.has(key)) return alikeRead.get(key);
    const lists = await Promise.all([...new Set([to, to.toLowerCase()])].map((memo) => node.transfersByMemo(memo)));
    const hashes = new Set();
    let listed = false;
    for (const item of lists.flat()) {
      const hash = lower(item?.origin);
      if (hash === lower(entry.hash)) listed = true;
      const paid = (item?.events ?? []).some(
        (event) =>
          event?.topic === "moonlight" &&
          !event.reverted &&
          event.data?.receiver === config.service.account &&
          String(event.data?.value ?? "") === value.toString(),
      );
      if (paid && DUSK_HASH.test(hash) && hash !== lower(entry.hash)) hashes.add(hash);
    }
    const alike = await sentTimes([...hashes]);
    if (listed) alikeRead.set(key, alike);
    return alike;
  }

  /**
   * The sender's deposits of the same amount to the same address, in the
   * hours up to this one, from the archive: `reach` blocks below it, or all
   * of them from the chain's start. `complete` is false when a page limit cut
   * the history short.
   */
  async function depositAlike(entry, { amountLux, height, recipient, sender }) {
    const key = `deposit:${lower(entry.hash)}`;
    if (alikeRead.has(key)) return alikeRead.get(key);
    const top = Number(height);
    const bottom = Math.max(0, top - Math.ceil((3 * DEPOSIT_ORDER_HORIZON_MS) / DUSK_BLOCK_MS));
    const { complete, entries } = await historyRange(archive, { account: sender, direction: "out", from: bottom, pages: HISTORY_PAGES, to: top });
    // The sender's deposits: what each paid the bridge is its call's, read below.
    const bridge = lower(config.duskEvm.l1StandardBridgeContractId);
    const candidates = entries.filter((item) => item.counterparty === bridge && item.hash !== lower(entry.hash)).map((item) => item.hash);
    const alike = (await sentTimes(candidates)).filter(({ tx }) => {
      const deposit = depositOf(tx.callData);
      return Boolean(deposit) && sameAddress(deposit.recipient, recipient) && deposit.amountLux === BigInt(amountLux);
    });
    const result = { alike, complete, reach: bottom === 0 ? Infinity : top - bottom };
    if (complete && entries.some((item) => item.hash === lower(entry.hash))) alikeRead.set(key, result);
    return result;
  }

  async function blockTime(network, number) {
    const block = await rpc(network, "eth_getBlockByNumber", [toHex(BigInt(number)), false]);
    return block ? Number(BigInt(block.timestamp)) * 1_000 : null;
  }

  /** A block a little before `seconds`, from the chain's recent block rate. */
  async function blockBefore(network, seconds) {
    const head = BigInt(await rpc(network, "eth_blockNumber", []));
    const sample = head > 20_000n ? head - 20_000n : 0n;
    const [headBlock, sampleBlock] = await Promise.all([
      rpc(network, "eth_getBlockByNumber", [toHex(head), false]),
      rpc(network, "eth_getBlockByNumber", [toHex(sample), false]),
    ]);
    const span = Number(BigInt(headBlock.timestamp) - BigInt(sampleBlock.timestamp)) || 1;
    const rate = Number(head - sample) / span;
    const behind = Math.max(0, Number(BigInt(headBlock.timestamp)) - seconds);
    const back = BigInt(Math.ceil(behind * rate * 1.2)) + 50n;
    return head > back ? head - back : 0n;
  }

  /**
   * Logs matching `filter` from `from` on, a window at a time. Returns the
   * first match `accept` keeps that no other transfer took (`taken`), after
   * leaving `skip` such matches to transfers sent earlier, and where the next
   * search should start: the window of the first such match, so it's seen
   * again until it's settled who it belongs to.
   */
  async function searchLogs(network, filter, from, accept, { skip = 0, taken = new Set() } = {}) {
    const head = BigInt(await rpc(network, "eth_blockNumber", []));
    let start = from;
    let window = LOG_WINDOW;
    let firstSeen = null;
    let left = skip;
    for (let round = 0; round < MAX_WINDOWS_PER_CHECK && start <= head; round += 1) {
      const end = start + window - 1n > head ? head : start + window - 1n;
      let logs;
      try {
        logs = await rpc(network, "eth_getLogs", [
          { ...filter, fromBlock: toHex(start), toBlock: toHex(end) },
        ]);
      } catch (error) {
        if (window > 50n && /limit|range|too many|exceed/iu.test(error?.message ?? "")) {
          window /= 4n;
          continue;
        }
        throw error;
      }
      for (const log of logs ?? []) {
        if (!accept(log) || taken.has(String(log.transactionHash).toLowerCase())) continue;
        firstSeen ??= start;
        if (left > 0) {
          left -= 1;
          continue;
        }
        return { match: log, next: firstSeen };
      }
      start = end + 1n;
    }
    return { match: null, next: firstSeen ?? start };
  }

  async function refreshMigration(entry, route, others) {
    const network = route.from.id;
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
    if (receipt.gasUsed && receipt.effectiveGasPrice)
      patch.feeWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString();
    if (receipt.status === "0x0")
      return failed(`The migration failed on ${name(network)}.`, patch);
    const recipient = patch.destination ?? entry.destination;
    const amountLux = patch.amountLux ?? entry.amountLux;
    // The bridge pays out the migrated amount with the migration's
    // transaction hash as the memo. Anyone can send a transfer with that
    // memo, so only the exact amount counts, from the chain's payout account
    // where one is known.
    const payer = config.evmNetworks[network]?.payoutAccount || null;
    const taken = takenDestinations(entry, others);
    const payouts = amountLux === undefined ? [] : await node.transfersByMemo(entry.hash.toLowerCase());
    const payout = payouts.find(
      (item) =>
        !taken.has(String(item.origin).toLowerCase()) &&
        (item.events ?? []).some(
          (event) =>
            event.topic === "moonlight" &&
            !event.reverted &&
            event.data?.receiver === recipient &&
            String(event.data?.value ?? "") === String(amountLux) &&
            (!payer || event.data?.sender === payer),
        ),
    );
    if (!payout) return pending(`Waiting for the payout on ${name("dusk")}.`, patch);
    const paid = await node.transaction(payout.origin);
    return completed({
      ...patch,
      destinationAt: paid?.blockTimestamp ? Number(paid.blockTimestamp) * 1_000 : null,
      destinationHash: payout.origin,
    });
  }

  async function refreshServiceTransfer(entry, route, others) {
    const service = config.service;
    const network = route.to.id;
    const chain = config.evmNetworks[network];
    const tx = await node.transaction(entry.hash);
    if (!tx) return pending(`Waiting for ${name("dusk")}.`);
    const sourceAt = tx.blockTimestamp ? Number(tx.blockTimestamp) * 1_000 : null;
    if (tx.error) return failed("The transfer failed on Dusk.", { sourceAt });
    const value = BigInt(tx.json?.value ?? 0);
    const recipient = memoText(tx.memo);
    const patch = {
      amountLux: value.toString(),
      destination: recipient,
      feeLux: duskFeePaid(tx),
      sender: tx.json?.sender,
      sourceAt,
    };
    if (tx.json?.receiver !== service.account)
      return failed("This transfer didn't go to the bridge account.", patch);
    if (value <= service.feeLux)
      return failed("The amount didn't exceed the bridge fee, so nothing is paid out.", patch);
    let to;
    try {
      to = normalizeEvmAddress(recipient);
    } catch {
      return failed("The memo isn't an EVM address, so the bridge can't pay it out.", patch);
    }
    const expected = (value - service.feeLux) * WEI_PER_LUX;
    const isAlike = (other) =>
      other.routeId === entry.routeId &&
      sameAddress(other.destination, to) &&
      String(other.amountLux) === value.toString();
    const order = orderAmongAlike(
      { hash: entry.hash, sourceAt: sourceAt ?? now() },
      [...(await serviceAlike(entry, to, value)), ...localAlike(entry, others, isAlike)],
      { horizonMs: Math.max(SERVICE_ORDER_HORIZON_MS, 4 * (service.delaySeconds ?? 0) * 1_000), settled: settledHashes(others) },
    );
    // Where an earlier check stopped, if it started from the same transfer.
    const scanBasis = String(order.since);
    // A transfer sent here kept the head read before it was sent: with no
    // earlier equal transfer paid first, its payout can't come before that.
    const sentHere = entry.scanFrom && entry.scanBasis === undefined && order.skip === 0 && order.since === (sourceAt ?? order.since);
    const from =
      entry.scanFrom && (entry.scanBasis === scanBasis || sentHere)
        ? BigInt(entry.scanFrom)
        : await blockBefore(network, Math.floor(order.since / 1_000));
    const filter = {
      address: chain.tokenContract,
      topics: [
        TRANSFER_TOPIC,
        service.payoutAddress ? pad(service.payoutAddress.toLowerCase()) : null,
        pad(to.toLowerCase()),
      ],
    };
    const { match, next } = await searchLogs(
      network,
      filter,
      from,
      (log) => BigInt(log.data) === expected,
      { skip: order.skip, taken: takenDestinations(entry, others) },
    );
    if (!match)
      return pending(`Waiting for the payout on ${name(network)}.`, { ...patch, scanBasis, scanFrom: next.toString() });
    return completed({
      ...patch,
      destinationAt: await blockTime(network, match.blockNumber),
      destinationHash: match.transactionHash,
    });
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

  async function eventCredit(entry, { amountLux, height, recipient, sender, sentAt }, others) {
    const isAlike = (other) =>
      other.routeId === entry.routeId &&
      sameAddress(other.destination, recipient) &&
      String(other.amountLux) === String(amountLux) &&
      (!sender || !other.sender || other.sender === sender);
    const sent = sentAt ?? now();
    const history = sender
      ? await depositAlike(entry, { amountLux, height, recipient, sender })
      : { alike: [], complete: true, reach: Infinity };
    const order = orderAmongAlike(
      { hash: entry.hash, sourceAt: sent },
      [...history.alike, ...localAlike(entry, others, isAlike)],
      { horizonMs: DEPOSIT_ORDER_HORIZON_MS, settled: settledHashes(others) },
    );
    // An equal deposit just below the history read could come first: the
    // credits' order can't be told.
    if (!history.complete || order.since - (sent - history.reach * DUSK_BLOCK_MS) < DEPOSIT_ORDER_HORIZON_MS)
      return { ambiguous: true };
    const scanBasis = String(order.since);
    // As for a payout: a deposit sent here keeps the head read before it.
    const sentHere = entry.scanFrom && entry.scanBasis === undefined && order.skip === 0 && order.since === sent;
    const from =
      entry.scanFrom && (entry.scanBasis === scanBasis || sentHere)
        ? BigInt(entry.scanFrom)
        : await blockBefore("dusk-evm", Math.floor(order.since / 1_000));
    const { match, next } = await searchLogs(
      "dusk-evm",
      {
        address: config.duskEvm.predeploys.l2StandardBridge,
        topics: [
          ETH_BRIDGE_FINALIZED_TOPIC,
          sender ? pad(evmAddressOf(sender).toLowerCase()) : null,
          pad(recipient.toLowerCase()),
        ],
      },
      from,
      (log) => {
        try {
          const { args } = decodeEventLog({ abi: ETH_BRIDGE_FINALIZED, data: log.data, topics: log.topics });
          return args.amount === BigInt(amountLux) * WEI_PER_LUX;
        } catch {
          return false;
        }
      },
      { skip: order.skip, taken: takenDestinations(entry, others) },
    );
    if (!match) return { next, scanBasis };
    return {
      at: await blockTime("dusk-evm", match.blockNumber),
      hash: match.transactionHash,
      next,
      scanBasis,
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
      return failed("The Dusk transaction failed, so the deposit didn't enter the bridge.", patch);
    const viaAdapter = await adapterCredit(entry.hash);
    if (viaAdapter?.failed) return failed(viaAdapter.failed, patch);
    if (viaAdapter?.hash)
      return completed({ ...patch, destinationAt: viaAdapter.at, destinationHash: viaAdapter.hash });
    if (viaAdapter === null) return pending(`Waiting for ${name("dusk-evm")}.`, patch);
    const credit = await eventCredit(
      entry,
      { amountLux: args.amountLux, height: tx.blockHeight, recipient: args.recipient, sender: tx.json?.sender, sentAt: sourceAt },
      others,
    );
    if (credit.ambiguous)
      return pending(
        "An equal deposit to the same address was sent just before this one, so its credit can't be told apart. Check the address on the DuskEVM explorer.",
        patch,
      );
    if (!credit.hash)
      return pending(`Waiting for ${name("dusk-evm")}.`, {
        ...patch,
        scanBasis: credit.scanBasis,
        scanFrom: credit.next.toString(),
      });
    return completed({ ...patch, destinationAt: credit.at, destinationHash: credit.hash });
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
      status = await deps.withdrawals.loadWithdrawalStatus(entry.hash, {
        // The proof's game, as the last check found it: read in the same query.
        proofGame: entry.proofGame ?? null,
        // The account that proved, once this browser sent a proof or a claim;
        // before that, the connected account's proof, or any other found.
        proofSubmitter: entry.proveHash || entry.claimHash || entry.pendingHash ? entry.proofSubmitter ?? undefined : undefined,
      });
    } catch (error) {
      if (error?.message === "Withdrawal transaction was not found.")
        return pending(`Waiting for ${name("dusk-evm")}.`, { stage: "submitted" });
      if (error?.message === "Withdrawal transaction failed on DuskEVM.")
        return failed("The withdrawal failed on DuskEVM. Your DUSK is still there.", {
          stage: "failed",
        });
      // Another message to Dusk, or no message at all: nothing to prove or claim.
      if (error?.message === NOT_A_DUSK_WITHDRAWAL || error?.message === "Withdrawal MessagePassed event was not found.")
        return failed(NOT_A_DUSK_WITHDRAWAL, { stage: "failed" });
      throw error;
    }
    const settled = await settlePendingAction(entry, status);
    const current = settled.status;
    // A proof whose game couldn't be read this time says no date: the one known so far stands.
    const dated = "readyAt" in current || !["proven_waiting", "ready_to_finalize"].includes(current.stage);
    const patch = {
      ...(settled.patch ?? {}),
      amountLux: current.details?.amountWei
        ? (current.details.amountWei / WEI_PER_LUX).toString()
        : entry.amountLux,
      destination: current.details?.recipient ?? entry.destination,
      sender: current.details?.from ?? entry.sender,
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
      statusMessage: current.statusMessage ?? "",
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

  return Object.freeze({ refresh });
}

/**
 * Re-checks pending entries until they end: often while an action waits,
 * less when the page is hidden.
 */
export function createScheduler({ check, intervals = {} }) {
  const delays = { action: 5_000, active: 15_000, hidden: 60_000, ...intervals };
  const timers = new Map();
  // Entries being checked now. Tracking one again then asks for one more
  // check right after it, so each entry has one loop and its patches land in
  // order.
  const checking = new Map();
  let stopped = false;

  function delayFor(entry) {
    if (entry?.pendingAction) return delays.action;
    return globalThis.document?.visibilityState === "hidden"
      ? delays.hidden
      : delays.active;
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
