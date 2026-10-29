// Which bridge transfer a pasted or linked transaction hash is, so a receipt
// link and "Look up a transfer" need nothing but the hash. A few requests at
// most: the Dusk node for a Dusk hash, then DuskEVM and the migration chains
// for an EVM hash, in the order the hash's form suggests.

import { BRIDGE_FUNCTIONS } from "@dusk-network/networks/duskevm";

import { canonicalHash } from "./permalink.js";
import { networkName } from "./names.js";
import { parseWithdrawalReceipt } from "./withdrawals.js";

const lower = (value) => String(value ?? "").toLowerCase();
const EVM_TX_HASH = /^0x[0-9a-f]{64}$/iu;

function memoText(hex) {
  try {
    const value = String(hex ?? "");
    if (!value || value.length % 2) return "";
    return new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16)))
      .trim();
  } catch {
    return "";
  }
}

/**
 * `{ routeId, hash }` for a bridge transfer, `{ message }` for a transaction
 * that isn't one (or isn't the one to open), or null when nothing knows it.
 */
export async function resolveTransfer(input, { cfg, node, rpc }) {
  const value = canonicalHash(input);
  if (!value) return { message: "That isn't a transaction hash. It has 64 hex characters, after 0x on EVM chains." };
  const bare = value.replace(/^0x/u, "");
  const evm = `0x${bare}`;

  async function onDusk() {
    let tx;
    try {
      tx = await node.transaction(bare);
    } catch {
      return null;
    }
    if (!tx) return null;
    const call = tx.callData;
    if (call && cfg.duskEvm.enabled) {
      const contract = lower(call.contractId).replace(/^0x/u, "");
      if (contract === cfg.duskEvm.l1StandardBridgeContractId && call.fnName === BRIDGE_FUNCTIONS.deposit)
        return { hash: bare, routeId: "dusk-to-dusk-evm" };
      if (contract === cfg.duskEvm.optimismPortalContractId)
        return {
          message: `That's a proof or a claim on Dusk. Open the withdrawal by its ${networkName(cfg, "dusk-evm")} transaction instead.`,
        };
    }
    if (cfg.service && tx.json?.receiver === cfg.service.account)
      return { hash: bare, routeId: `dusk-to-${cfg.service.network}` };
    // A migration's payout names the migration in its memo.
    const memo = memoText(tx.memo);
    if (EVM_TX_HASH.test(memo)) {
      const migration = await onEvm(memo.toLowerCase(), { migrationsOnly: true });
      if (migration?.routeId) return migration;
    }
    return { message: "That Dusk transaction isn't a bridge transfer." };
  }

  async function onEvm(hash, { migrationsOnly = false } = {}) {
    if (cfg.duskEvm.enabled && !migrationsOnly) {
      try {
        const receipt = await rpc("dusk-evm", "eth_getTransactionReceipt", [hash]);
        if (receipt) {
          // Every message to Dusk passes the same contract: only the bridge's
          // own DUSK withdrawals are opened as one.
          try {
            parseWithdrawalReceipt(receipt, cfg.network);
            return { hash, routeId: "dusk-evm-to-dusk" };
          } catch {
            return { message: `That ${networkName(cfg, "dusk-evm")} transaction isn't a withdrawal of DUSK.` };
          }
        }
      } catch {
        // Not reachable: the other chains may still know it.
      }
    }
    for (const network of cfg.migrations) {
      const chain = cfg.evmNetworks[network];
      let tx;
      try {
        tx = await rpc(network, "eth_getTransactionByHash", [hash]);
      } catch {
        continue;
      }
      if (!tx) continue;
      if (lower(tx.to) === lower(chain.migrationContract)) return { hash, routeId: `${network}-to-dusk` };
      if (lower(tx.to) === lower(chain.tokenContract))
        return {
          message: "That's the approval. The transfer starts with the migration after it: look that one up instead.",
        };
      return { message: `That ${networkName(cfg, network)} transaction isn't a migration.` };
    }
    return null;
  }

  const first = value.startsWith("0x") ? () => onEvm(evm) : onDusk;
  const second = value.startsWith("0x") ? onDusk : () => onEvm(evm);
  const found = await first();
  if (found?.routeId) return found;
  const other = await second();
  if (other?.routeId) return other;
  return found ?? other ?? null;
}
