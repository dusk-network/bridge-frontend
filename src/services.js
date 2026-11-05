import { bridgeStatus } from "@dusk-network/app-core/bridge";
import { createArchive } from "@dusk-network/app-core/history";
import { evmAddressOf } from "@dusk-network/networks/duskevm";
import { createMulticallFetch } from "@hdauven/dusk-multicall";
import { createPublicClient, http } from "viem";

import { config } from "./config.js";
import { createChainTimes, readDepositLag } from "./chain-times.js";
import { createDriverLoader } from "./data-driver.js";
import { createDiscovery } from "./discovery.js";
import { createDuskNames } from "./dusk-names.js";
import { createDuskNode } from "./dusk-node.js";
import { getDuskWallet } from "./dusk-wallet.js";
import { createEvmReads } from "./evm-reads.js";
import { pageStorage } from "./page-storage.js";
import { resolveTransfer } from "./resolve.js";
import { createTracking } from "./tracking.js";
import { createPageWithdrawals } from "./withdrawals.js";

// Multicall for Dusk takes at most 256 calls and 64 KiB in or out per query;
// bridge screens make far fewer reads, so a smaller batch leaves headroom.
export const MAX_BATCH = 64;

/** JSON-RPC over fetch, for the EVM chains and the DuskEVM adapter. */
export function createRpc(urls, fetch = globalThis.fetch) {
  return async function rpc(network, method, params = []) {
    const url = urls[network];
    if (!url) throw new Error(`No RPC is configured for ${network}.`);
    const response = await fetch(url, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.error)
      throw Object.assign(new Error(body.error.message ?? `${method} failed`), {
        code: body.error.code,
      });
    return body.result;
  };
}

/**
 * JSON-RPC batches: several calls in one request, each answered in order.
 * A call the node answered with an error, or not at all, is undefined, so
 * "not found" (null) and "couldn't ask" stay apart. At most 20 calls go in
 * one request.
 */
export function createRpcBatch(urls, fetch = globalThis.fetch) {
  return async function rpcBatch(network, calls) {
    const url = urls[network];
    if (!url) throw new Error(`No RPC is configured for ${network}.`);
    const results = [];
    for (let start = 0; start < calls.length; start += 20) {
      const chunk = calls.slice(start, start + 20);
      const response = await fetch(url, {
        body: JSON.stringify(chunk.map(({ method, params = [] }, index) => ({ id: index, jsonrpc: "2.0", method, params }))),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(`RPC batch failed with HTTP ${response.status}`);
      const body = await response.json();
      const byId = new Map((Array.isArray(body) ? body : [body]).map((item) => [item?.id, item]));
      for (let index = 0; index < chunk.length; index += 1) {
        const item = byId.get(index);
        results.push(item && !item.error ? item.result : undefined);
      }
    }
    return results;
  };
}

/** The address DuskEVM's Portal records for proofs sent from a Dusk account, in lower case. */
export function proofSubmitterFor(account) {
  return account ? evmAddressOf(account).toLowerCase() : null;
}

export function createServices(cfg = config, { fetchDriver } = {}) {
  // Contract reads made in one task go to the node as one Multicall for Dusk
  // query, where the network has it: this page's and the withdrawals'.
  const reads = createMulticallFetch({ maxBatch: MAX_BATCH, multicallId: cfg.multicall.contractId || null, nodeUrl: cfg.dusk.nodeUrl });
  const node = createDuskNode({ fetch: reads, url: cfg.dusk.nodeUrl });
  // The same node's archive, for account histories.
  const archive = createArchive({ url: cfg.dusk.nodeUrl });
  const loadDriver = createDriverLoader(fetchDriver ? { fetch: fetchDriver } : {});
  const urls = {
    "dusk-evm": cfg.duskEvm.rpcUrl,
    // The adapter's L1 view, asked only which DuskEVM deposit a Dusk
    // transaction made. Dispute games are read on Dusk itself.
    "dusk-evm-l1": cfg.duskEvm.l1BridgeRpcUrl,
    ...Object.fromEntries(
      Object.values(cfg.evmNetworks)
        .filter((network) => network.configured)
        .map((network) => [network.id, network.rpcUrl]),
    ),
  };
  const rpc = createRpc(urls);
  const rpcBatch = createRpcBatch(urls);

  // DuskEVM withdrawals, with the drivers the network's file pins.
  const driver = ({ sha256, url }) => () => loadDriver(url, sha256);
  const withdrawals = cfg.duskEvm.enabled
    ? createPageWithdrawals(cfg, {
        connected: () => {
          try {
            return proofSubmitterFor(getDuskWallet().state.selectedProfile?.account);
          } catch {
            return null;
          }
        },
        drivers: { disputeGameFactory: driver(cfg.duskEvm.disputeGameFactoryDriver), optimismPortal: driver(cfg.duskEvm.optimismPortalDriver) },
        fetch: reads,
        maxBatch: MAX_BATCH,
        node,
        rpc,
      })
    : null;

  const clients = new Map();
  const tracking = createTracking({
    archive,
    config: cfg,
    node,
    receiptClient: (network) => {
      if (!clients.has(network))
        clients.set(network, createPublicClient({ transport: http(urls[network]) }));
      return clients.get(network);
    },
    rpc,
    withdrawals,
  });

  const discovery = createDiscovery({ archive, cfg, rpc });
  const evmReads = createEvmReads({ cfg, rpc, rpcBatch });
  // How long DuskEVM's routes take, as its chains say, kept per network.
  const times = withdrawals
    ? createChainTimes({
        key: `dusk-bridge:times:v1:${cfg.profile}:${cfg.duskEvm.optimismPortalContractId}`,
        read: {
          deposit: () => readDepositLag({ l1Block: cfg.duskEvm.predeploys.l1Block, node, rpcBatch }),
          withdrawal: () => withdrawals.timing(),
        },
      })
    : null;

  // What a route's status read: kept past a reload, so a later read asks only for what's new.
  const statusKept = {
    get: (key) => pageStorage().getItem(`dusk-bridge:${key}`),
    set: (key, value) => {
      try {
        pageStorage().setItem(`dusk-bridge:${key}`, value);
      } catch {}
    },
  };

  return Object.freeze({
    discovery,
    evmReads,
    // The connected account's verified .dusk name, where Dusk Wallet sends none.
    names: createDuskNames({ chainId: cfg.dusk.chainId, nodeUrl: cfg.dusk.nodeUrl }),
    node,
    resolve: (hash) => resolveTransfer(hash, { cfg, node, rpc }),
    rpc,
    rpcBatch,
    /** How a route is doing before someone sends: from this deployment's own endpoints. */
    status: (route) =>
      bridgeStatus({
        archive,
        cache: statusKept,
        network: cfg.network,
        nodeUrl: cfg.dusk.nodeUrl,
        route: route.id,
        rpcUrl: urls[route.to.kind === "evm" ? route.to.id : route.from.id],
      }),
    times,
    tracking,
    withdrawals,
  });
}
