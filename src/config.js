// One deployment, one network. A profile names the Dusk network, and its file
// in @dusk-network/networks gives everything a route uses: endpoints, chains,
// contracts, accounts, fees, typical times and whether a route runs. Every
// route stays on that network's counterparts. Values can be overridden from
// Vite env at build time or from `window.__DUSK_BRIDGE_CONFIG__` at runtime.

import { networks, routes } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { hyperlaneConfig } from "./hyperlane.js";

const env = import.meta.env ?? {};

// An empty value means "use the default", so a copied .env.example is safe.
const value = (name, fallback = "") => {
  const runtime = globalThis.__DUSK_BRIDGE_CONFIG__?.[name];
  const raw = String(runtime ?? env[name] ?? "").trim();
  return raw === "" ? String(fallback ?? "").trim() : raw;
};

/** `none` turns an optional route off. */
const NONE = "none";

const positiveInteger = (name, fallback) => {
  const parsed = Number(value(name, fallback));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How long a route usually takes on this network, in seconds, or null where
 * it isn't known: empty keeps the network file's value, `none` clears it.
 */
const seconds = (name, fallback = null) => {
  const raw = value(name).toLowerCase();
  if (raw === NONE) return null;
  const parsed = Number(raw);
  return raw !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : (fallback ?? null);
};

const list = (name, fallback) =>
  value(name, fallback.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== NONE);

const contractId = (name, fallback = "") =>
  value(name, fallback).replace(/^0x/iu, "").toLowerCase();

const isContractId = (id) => /^[0-9a-f]{64}$/u.test(id);

/**
 * DuskEVM's OP-stack predeploys, as its network's file lists them: the same
 * addresses on every DuskEVM.
 */
export const DUSKEVM_PREDEPLOYS = networks.testnet.duskEvm.predeploys;

/** A DuskEVM contract's data driver, from `public/drivers`, as the network's file pins it. */
const bundledDriver = ({ file, sha256 }) => Object.freeze({ sha256, url: `/drivers/${file}` });

const url = (name, fallback = "") => {
  const raw = value(name, fallback);
  return /^https?:\/\//iu.test(raw) ? raw : "";
};

/** A Dusk account where one is known; `none` clears the network file's. */
const account = (name, fallback = "") => {
  const raw = value(name, fallback);
  return raw.toLowerCase() === NONE ? "" : raw;
};

/** The chains whose DUSK migrates to Dusk, in the order the card lists them. */
const CHAIN_ORDER = Object.freeze(["ethereum", "bsc"]);

const ENV_PREFIX = Object.freeze({ bsc: "BSC", ethereum: "ETHEREUM" });

/** An EVM chain a route reaches, from the network's file, with the deployment's overrides. */
function evmNetwork(net, id) {
  const prefix = ENV_PREFIX[id];
  const chain = net.routes.chains[id];
  const migration = net.routes.migrations.find((route) => route.chain === id);
  const network = {
    chainId: positiveInteger(`VITE_${prefix}_CHAIN_ID`, chain.chainId),
    // The chain's one name: what wallets list, and what the page says (names.js).
    chainName: value(`VITE_${prefix}_CHAIN_NAME`, chain.name),
    currency: chain.currency,
    explorerUrl: value(`VITE_${prefix}_EXPLORER_URL`, chain.explorerUrl),
    id,
    migrationContract: value(`VITE_${prefix}_MIGRATION_CONTRACT`, migration?.contract),
    migrationSeconds: seconds(`VITE_${prefix}_MIGRATION_SECONDS`, migration?.typicalSeconds),
    // The Dusk account this chain's migrations are paid from, where it's
    // known: only its transfers then count as payouts.
    payoutAccount: account(`VITE_${prefix}_PAYOUT_ACCOUNT`, value("VITE_MIGRATION_PAYOUT_ACCOUNT", migration?.payoutAccount)),
    rpcUrl: value(`VITE_${prefix}_RPC_URL`, chain.rpcUrl),
    tokenContract: value(`VITE_${prefix}_TOKEN_CONTRACT`, chain.token),
  };
  network.configured = Boolean(
    network.chainId && network.chainName && network.rpcUrl && /^0x[0-9a-f]{40}$/iu.test(network.tokenContract),
  );
  return Object.freeze(network);
}

function duskEvmConfig(net) {
  const evm = net.duskEvm;
  const contracts = evm?.contracts ?? {};
  const deposit = net.routes.duskEvm.find((route) => route.direction === "deposit");
  const rpcUrl = value("VITE_DUSKEVM_RPC_URL", evm?.rpcUrl);
  // Optional: without it, a proof goes against the newest game covering the
  // withdrawal, not one that has already resolved. `none` leaves it out.
  const registry = contractId("VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID", contracts.anchor_state_registry?.contractId);
  const driver = (name, key) =>
    Object.freeze({
      sha256: value(`VITE_DUSKEVM_${name}_DATA_DRIVER_SHA256`, evm?.drivers[key].sha256).toLowerCase(),
      url: value(`VITE_DUSKEVM_${name}_DATA_DRIVER_URL`, evm ? bundledDriver(evm.drivers[key]).url : ""),
    });
  const duskEvm = {
    anchorStateRegistryContractId: isContractId(registry) ? registry : "",
    bridgeGameSearchDepth: positiveInteger("VITE_DUSKEVM_BRIDGE_GAME_SEARCH_DEPTH", 64),
    chainId: positiveInteger("VITE_DUSKEVM_CHAIN_ID", evm?.chainId ?? 0),
    depositSeconds: seconds("VITE_DUSKEVM_DEPOSIT_SECONDS", deposit?.typicalSeconds),
    disputeGameFactoryContractId: contractId("VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID", contracts.dispute_game_factory?.contractId),
    disputeGameFactoryDriver: driver("DISPUTE_GAME_FACTORY", "disputeGameFactory"),
    explorerUrl: value("VITE_DUSKEVM_EXPLORER_URL", evm?.explorerUrl),
    // The DuskEVM adapter's view of Dusk, as the network's file names it.
    l1BridgeRpcUrl: value("VITE_DUSKEVM_L1_BRIDGE_RPC_URL", evm?.l1AdapterUrl),
    l1StandardBridgeContractId: contractId("VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID", contracts.l1_standard_bridge?.contractId),
    // The chain name wallets list; the page itself says "DuskEVM".
    name: value("VITE_DUSKEVM_NAME", evm?.name ?? "DuskEVM"),
    optimismPortalContractId: contractId("VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID", contracts.optimism_portal?.contractId),
    optimismPortalDriver: driver("OPTIMISM_PORTAL", "optimismPortal"),
    predeploys: evm?.predeploys ?? DUSKEVM_PREDEPLOYS,
    rpcUrl,
  };
  const missing = [
    ["VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID", isContractId(duskEvm.l1StandardBridgeContractId)],
    ["VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID", isContractId(duskEvm.optimismPortalContractId)],
    ["VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID", isContractId(duskEvm.disputeGameFactoryContractId)],
    ["VITE_DUSKEVM_CHAIN_ID", duskEvm.chainId > 0],
    ["VITE_DUSKEVM_RPC_URL", /^https?:\/\//iu.test(duskEvm.rpcUrl)],
    ["VITE_DUSKEVM_EXPLORER_URL", /^https?:\/\//iu.test(duskEvm.explorerUrl)],
    ["VITE_DUSKEVM_L1_BRIDGE_RPC_URL", /^https?:\/\//iu.test(duskEvm.l1BridgeRpcUrl)],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  duskEvm.missing = Object.freeze(missing);
  // Only where the network's file has DuskEVM's routes, and everything is set.
  duskEvm.enabled = net.routes.duskEvm.length > 0 && missing.length === 0;
  return Object.freeze(duskEvm);
}

/**
 * The network's file with this deployment's DuskEVM bridge, Portal, dispute
 * game factory and anchor state registry in place of its own where they
 * differ, so the bridge's calls and withdrawals are read on the contracts
 * this page sends them to. A registry left out (`none`) is left out here too.
 */
function withDuskEvmContracts(net, duskEvm) {
  const contracts = net.duskEvm?.contracts ?? {};
  const own = {
    anchor_state_registry: duskEvm.anchorStateRegistryContractId,
    dispute_game_factory: duskEvm.disputeGameFactoryContractId,
    l1_standard_bridge: duskEvm.l1StandardBridgeContractId,
    optimism_portal: duskEvm.optimismPortalContractId,
  };
  const set = Object.entries(own).filter(([name, id]) => isContractId(id) && id !== contracts[name]?.contractId);
  const dropRegistry = !duskEvm.anchorStateRegistryContractId && Object.hasOwn(contracts, "anchor_state_registry");
  if (!net.duskEvm || (!set.length && !dropRegistry)) return net;
  const { anchor_state_registry: _registry, ...kept } = contracts;
  const replaced = Object.fromEntries(set.map(([name, contractId]) => [name, { contractId, evmAddress: evmAddressOf(contractId) }]));
  return { ...net, duskEvm: { ...net.duskEvm, contracts: { ...(dropRegistry ? kept : contracts), ...replaced } } };
}

/**
 * The network's file with this deployment's bridge account, fee and time,
 * its chains' tokens, migration contracts and the accounts that pay
 * migrations out in place of its own where they differ, so a payout is
 * looked for where this page's transfers are paid from, and what a migration
 * paid is read on the contract it went to.
 */
function withDeploymentRoutes(net, { evmNetworks, service }) {
  const { chains, migrations, services } = net.routes;
  const routes = {
    ...net.routes,
    chains: Object.fromEntries(Object.entries(chains).map(([id, chain]) => [id, evmNetworks[id] ? { ...chain, token: evmNetworks[id].tokenContract } : chain])),
    migrations: migrations.map((route) =>
      evmNetworks[route.chain]
        ? { ...route, contract: evmNetworks[route.chain].migrationContract || route.contract, payoutAccount: evmNetworks[route.chain].payoutAccount || null }
        : route,
    ),
    services: services.map((route) =>
      route.chain === service?.network ? { ...route, account: service.account, feeLux: String(service.feeLux), typicalSeconds: service.delaySeconds } : route,
    ),
  };
  return JSON.stringify(routes) === JSON.stringify(net.routes) ? net : { ...net, routes };
}

export function loadConfig() {
  const requested = value("VITE_BRIDGE_PROFILE", "mainnet").toLowerCase();
  const profile = requested === "testnet" ? "testnet" : "mainnet";
  const net = networks[profile];

  const dusk = Object.freeze({
    chainId: value("VITE_DUSK_CHAIN_ID", `dusk:${net.chainId}`),
    explorerUrl: value("VITE_DUSK_EXPLORER_URL", net.apps.explorer),
    nodeUrl: value("VITE_DUSK_NODE_URL", net.urls.node),
  });

  // The chains this network's routes reach; a deployment can change their
  // endpoints and contracts, not add others.
  const evmNetworks = Object.freeze(
    Object.fromEntries(Object.keys(net.routes.chains).filter((id) => ENV_PREFIX[id]).map((id) => [id, evmNetwork(net, id)])),
  );
  const usable = (id) => Boolean(evmNetworks[id]?.configured);
  const migrating = net.routes.migrations.map((route) => route.chain);
  const migrations = Object.freeze(
    list("VITE_MIGRATION_NETWORKS", CHAIN_ORDER.filter((id) => migrating.includes(id))).filter(
      (id) => migrating.includes(id) && usable(id) && /^0x[0-9a-f]{40}$/iu.test(evmNetworks[id].migrationContract),
    ),
  );
  const offered = net.routes.services[0] ?? null;
  const serviceNetwork = value("VITE_SERVICE_NETWORK", offered?.chain).toLowerCase();
  const service =
    offered && serviceNetwork === offered.chain && usable(serviceNetwork)
      ? Object.freeze({
          account: value("VITE_SERVICE_BRIDGE_ACCOUNT", offered.account),
          delaySeconds: seconds("VITE_SERVICE_BRIDGE_DELAY_SECONDS", offered.typicalSeconds),
          feeLux: BigInt(positiveInteger("VITE_SERVICE_BRIDGE_FEE_LUX", Number(offered.feeLux))),
          network: serviceNetwork,
          // The address the route pays out from, where the network's file knows it.
          payoutAddress: offered.payoutAddress ?? "",
        })
      : null;

  const multicallId = contractId("VITE_DUSK_MULTICALL_CONTRACT_ID", net.contracts.multicall ?? "");
  const duskEvm = duskEvmConfig(net);
  // Hyperlane's routes, from this network's deployment record: the tokens
  // listed, by symbol, or all of them; `none` runs none.
  const hyperlaneTokens = value("VITE_HYPERLANE_TOKENS");
  const hyperlane = hyperlaneConfig(profile, { evmNetworks, wanted: hyperlaneTokens ? list("VITE_HYPERLANE_TOKENS", []) : null });
  // The Terms of use and Privacy policy the network's file links, as on the explorer.
  const { privacyUrl, termsUrl } = net.operator;

  return Object.freeze({
    // Shown only when set: nothing here is guessed.
    links: Object.freeze({
      // Guides written for this page only: the docs' bridge guides describe
      // the web wallet's own bridge.
      docs: Object.freeze({
        duskEvm: url("VITE_DOCS_DUSKEVM_URL"),
        migration: url("VITE_DOCS_MIGRATION_URL"),
        service: url("VITE_DOCS_SERVICE_URL"),
      }),
      // A deployment can link its own.
      privacy: url("VITE_PRIVACY_URL", privacyUrl),
      sites: Object.freeze({
        mainnet: url("VITE_MAINNET_BRIDGE_URL"),
        testnet: url("VITE_TESTNET_BRIDGE_URL"),
      }),
      status: url("VITE_STATUS_URL"),
      support: url("VITE_SUPPORT_URL"),
      supportLabel: value("VITE_SUPPORT_LABEL", "support"),
      terms: url("VITE_TERMS_URL", termsUrl),
    }),
    dusk,
    duskEvm,
    evmNetworks,
    gasLimitUpper: BigInt(positiveInteger("VITE_GAS_LIMIT_UPPER", 1_000_000_000)),
    hyperlane,
    migrations,
    multicall: Object.freeze({ contractId: isContractId(multicallId) ? multicallId : "" }),
    // The network's file, for its routes and labels, with this deployment's
    // DuskEVM contracts, bridge accounts and tokens.
    network: withDeploymentRoutes(withDuskEvmContracts(net, duskEvm), { evmNetworks, service }),
    // Routes shown but not running now, by route ID: those the network's
    // file says aren't running, unless set; `none` runs them all.
    pausedRoutes: Object.freeze(list("VITE_PAUSED_ROUTES", routes(net).filter((route) => !route.running).map((route) => route.id))),
    profile,
    reown: Object.freeze({ projectId: value("VITE_REOWN_PROJECT_ID") }),
    service,
  });
}

export const config = loadConfig();
