// Which bridge transfer a pasted or linked transaction hash is, so a receipt
// link and "Look up a transfer" need nothing but the hash. A few requests at
// most: the Dusk node for a Dusk hash, then DuskEVM, Hyperlane's chain and
// the migration chains for an EVM hash, in the order the hash's form
// suggests.

import { parseWithdrawalReceipt } from "@dusk-network/app-core/duskevm-withdrawals";
import { BRIDGE_FUNCTIONS } from "@dusk-network/networks/duskevm";

import { canonicalHash } from "./permalink.js";
import { networkName } from "./names.js";

/** What's said of something pasted that isn't a transaction ID, by its form. */
export const NOT_TRANSACTION_ID = "Not a transaction ID (64 hex characters, 0x on EVM)";

const lower = (value) => String(value ?? "").toLowerCase();
const EVM_TX_HASH = /^0x[0-9a-f]{64}$/iu;
/** `transferRemote(uint32,bytes32,uint256)`'s selector, the call a Hyperlane token sends to Dusk with. */
const TRANSFER_REMOTE = "0x81b4e8b4";

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
  if (!value) return { message: NOT_TRANSACTION_ID };
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
    // Hyperlane: a transfer on one of its routes, or a step that isn't the transfer.
    const contract = lower(call?.contractId).replace(/^0x/u, "");
    for (const token of cfg.hyperlane?.tokens ?? []) {
      if (contract === token.dusk.route && call.fnName === "transfer_remote") return { hash: bare, routeId: token.routes.out };
      if (contract === token.dusk.route) return { message: `That's a claim on Dusk. Open the transfer by its ${networkName(cfg, cfg.hyperlane.network)} transaction instead.` };
      if (contract === token.dusk.token && call.fnName === "approve")
        return { message: "That's the approval. The transfer starts with the step after it: look that one up instead." };
    }
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
            parseWithdrawalReceipt(cfg.network, receipt);
            return { hash, routeId: "dusk-evm-to-dusk" };
          } catch {
            return { message: `That ${networkName(cfg, "dusk-evm")} transaction isn't a withdrawal of DUSK.` };
          }
        }
      } catch {
        // Not reachable: the other chains may still know it.
      }
    }
    // Hyperlane's chain, before its paused migrations: its tokens' transfers to Dusk.
    if (cfg.hyperlane?.enabled && !migrationsOnly) {
      try {
        const tx = await rpc(cfg.hyperlane.network, "eth_getTransactionByHash", [hash]);
        const token = tx && cfg.hyperlane.tokens.find((each) => lower(each.evm.token) === lower(tx.to));
        if (token) {
          if (lower(tx.input).startsWith(TRANSFER_REMOTE)) return { hash, routeId: token.routes.in };
          return { message: `That ${networkName(cfg, cfg.hyperlane.network)} transaction isn't a transfer to Dusk.` };
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
