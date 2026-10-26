// An EVM address's withdrawals from DuskEVM, from the L2 bridge's own event:
// `ETHBridgeInitiated(from indexed, to indexed, amount, extraData)`, filtered
// by `from`. DuskEVM answers at most 100,000 blocks (about 2.3 days) per log
// query, so the scan goes from the newest block down a window at a time, a
// bounded number per run, and keeps the heights it covered: the next run
// carries on below them and reads only what is new above.

import { decodeAbiParameters, pad, toEventSelector, toHex } from "viem";

import { addCoverage, topGap } from "./dusk-history.js";
import { withdrawalRecipientAccount } from "./dusk-recipient.js";

export const L2_WINDOW = 100_000;
export const L2_RUN_REQUESTS = 8;

export const ETH_BRIDGE_INITIATED_TOPIC = toEventSelector(
  "ETHBridgeInitiated(address,address,uint256,bytes)",
);

/** An empty scan state. */
export const emptyScan = () => ({ covered: [], entries: {}, target: null, window: L2_WINDOW });

/** The withdrawal a bridge log records, or null. */
export function withdrawalFromLog(log) {
  try {
    const [amount, extraData] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], log.data);
    return {
      amountWei: amount.toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      destination: withdrawalRecipientAccount(extraData),
      hash: String(log.transactionHash).toLowerCase(),
    };
  } catch {
    return null;
  }
}

const tooWide = (error) => /range|limit|too many|exceed/iu.test(error?.message ?? "");

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
  let covered = (kept.covered ?? []).map((range) => [...range]);
  let window = Number(kept.window) || L2_WINDOW;
  const entries = { ...(kept.entries ?? {}) };
  const found = [];
  let requests = 1;
  const target = Number(BigInt(await rpc("eth_blockNumber", [])));
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
