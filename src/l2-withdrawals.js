// An EVM address's withdrawals from DuskEVM, from the L2 bridge's own event:
// `ETHBridgeInitiated(from indexed, to indexed, amount, extraData)`, filtered
// by `from`. DuskEVM answers at most 100,000 blocks (about 2.3 days) per log
// query, so the scan goes from the newest block down a window at a time, a
// bounded number per run, and keeps the heights it covered: the next run
// carries on below them and reads only what is new above. Only finalized
// blocks count as covered: a block above can still be reorged away, with
// the withdrawals in it, so those are read once final (within minutes).

import { addCoverage, topGap } from "@dusk-network/app-core/history";
import { duskRecipientOf } from "@dusk-network/networks/duskevm";
import { decodeAbiParameters, pad, toEventSelector, toHex } from "viem";

export const L2_WINDOW = 100_000;
export const L2_RUN_REQUESTS = 8;

export const ETH_BRIDGE_INITIATED_TOPIC = toEventSelector(
  "ETHBridgeInitiated(address,address,uint256,bytes)",
);

/** An empty scan state. */
export const emptyScan = () => ({ covered: [], entries: {}, target: null, window: L2_WINDOW });

/** The withdrawal a bridge log records, with the Dusk account or contract it pays, or null. */
export function withdrawalFromLog(log) {
  try {
    const [amount, extraData] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], log.data);
    const recipient = duskRecipientOf(extraData);
    return {
      amountWei: amount.toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      destination: recipient?.account ?? recipient?.contractId ?? null,
      hash: String(log.transactionHash).toLowerCase(),
    };
  } catch {
    return null;
  }
}

const tooWide = (error) => /range|limit|too many|exceed/iu.test(error?.message ?? "");

/** Blocks under the head counted as final where a node doesn't answer "finalized": about an hour. */
export const UNFINALIZED_MARGIN = 1_800;

/** The highest block that can't be reorged away. */
async function finalHead(rpc) {
  try {
    const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
    if (block?.number) return Number(BigInt(block.number));
  } catch {
    // An older node: the latest block, less a margin.
  }
  return Math.max(0, Number(BigInt(await rpc("eth_blockNumber", []))) - UNFINALIZED_MARGIN);
}

/**
 * One run over `address`'s withdrawals.
 *
 * @param {object} options
 * @param {(method: string, params: unknown[]) => Promise<any>} options.rpc DuskEVM JSON-RPC
 * @param {string} options.address the EVM address
 * @param {string} options.bridge the L2 standard bridge
 * @param {object} [options.state] the kept state
 * @param {number} [options.maxRequests]
 */
export async function syncWithdrawals({ address, bridge, maxRequests = L2_RUN_REQUESTS, rpc, state }) {
  const kept = state ?? emptyScan();
  const target = await finalHead(rpc);
  // Coverage kept above the final head (older runs read the latest) is read again.
  let covered = (kept.covered ?? []).map(([lo, hi]) => [lo, Math.min(hi, target)]).filter(([lo, hi]) => hi >= lo);
  let window = Number(kept.window) || L2_WINDOW;
  const entries = { ...(kept.entries ?? {}) };
  const found = [];
  let requests = 1;
  const topics = [ETH_BRIDGE_INITIATED_TOPIC, pad(String(address).toLowerCase())];

  while (requests < maxRequests) {
    const gap = topGap(covered, target);
    if (!gap) break;
    const [a, b] = gap;
    const lo = Math.max(a, b - window + 1);
    requests += 1;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: bridge, fromBlock: toHex(lo), toBlock: toHex(b), topics }]);
    } catch (error) {
      if (window > 1_000 && tooWide(error)) {
        window = Math.floor(window / 4);
        continue;
      }
      throw error;
    }
    for (const log of logs ?? []) {
      const entry = withdrawalFromLog(log);
      if (!entry || entries[entry.hash]) continue;
      entries[entry.hash] = entry;
      found.push(entry);
    }
    covered = addCoverage(covered, lo, b);
  }
  return { found, requests, state: { covered, entries, target, updatedAt: Date.now(), window } };
}
