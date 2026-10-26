import { createPublicClient, http } from "viem";

import { config } from "./config.js";
import { createContractReader, contractFacade } from "./contract-reader.js";
import { createDriverLoader, driverJson } from "./data-driver.js";
import { createDuskNode } from "./dusk-node.js";
import { getDuskWallet, sendDuskContractCall } from "./dusk-wallet.js";
import { createTracking, duskAccountEvmAddress } from "./tracking.js";
import { createWithdrawals, parseGameSearchDepth } from "./withdrawals.js";

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

/** The address DuskEVM's Portal records for proofs sent from a Dusk account. */
export function proofSubmitterFor(account) {
  return account ? duskAccountEvmAddress(account) : null;
}

export function createServices(cfg = config, { fetchDriver } = {}) {
  const node = createDuskNode({ url: cfg.dusk.nodeUrl });
  const loadDriver = createDriverLoader(fetchDriver ? { fetch: fetchDriver } : {});
  const contract = (id, driver) => ({
    driver: () => loadDriver(driver.url, driver.sha256),
    id,
  });
  const reader = createContractReader({
    multicall: cfg.multicall.contractId
      ? contract(cfg.multicall.contractId, cfg.multicall.driver)
      : null,
    node,
  });
  const urls = {
    "dusk-evm": cfg.duskEvm.rpcUrl,
    "dusk-evm-l1": cfg.duskEvm.l1BridgeRpcUrl,
    ...Object.fromEntries(
      Object.values(cfg.evmNetworks)
        .filter((network) => network.configured)
        .map((network) => [network.id, network.rpcUrl]),
    ),
  };
  const rpc = createRpc(urls);

  let withdrawals = null;
  if (cfg.duskEvm.enabled) {
    const portal = contract(cfg.duskEvm.optimismPortalContractId, cfg.duskEvm.optimismPortalDriver);
    const dgf = contract(cfg.duskEvm.disputeGameFactoryContractId, cfg.duskEvm.disputeGameFactoryDriver);
    withdrawals = createWithdrawals({
      dgf: contractFacade(reader, dgf),
      gameSearchDepth: parseGameSearchDepth(cfg.duskEvm.bridgeGameSearchDepth),
      gasPrice: () => node.gasPrice(),
      gasUpper: cfg.gasLimitUpper,
      l1Rpc: (method, params) => rpc("dusk-evm-l1", method, params),
      l2Rpc: (method, params) => rpc("dusk-evm", method, params),
      latestTimestamp: () => node.latestBlockTimestamp(),
      portal: contractFacade(reader, portal),
      proofSubmitter: () => {
        try {
          return proofSubmitterFor(getDuskWallet().state.selectedProfile?.account);
        } catch {
          return null;
        }
      },
      sendPortalCall: async (fnName, args, gas) => {
        const driver = await portal.driver();
        return sendDuskContractCall({
          contractId: portal.id,
          display: {
            label:
              fnName === "proveWithdrawalTransaction"
                ? "Prove a DuskEVM withdrawal"
                : "Claim a DuskEVM withdrawal",
          },
          fnArgs: driver.encodeInputFn(fnName, driverJson(args)),
          fnName,
          gas,
        });
      },
    });
  }

  const clients = new Map();
  const tracking = createTracking({
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

  return Object.freeze({ node, reader, rpc, tracking, withdrawals });
}
