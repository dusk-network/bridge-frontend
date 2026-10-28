// One deployment, one network. A profile names the Dusk network; every route
// in it stays on that network's counterparts. Values can come from Vite env
// at build time or from `window.__DUSK_BRIDGE_CONFIG__` at runtime.

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
 * it isn't known: empty keeps the profile's value, `none` clears it.
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

export const MAINNET_BSC_BRIDGE_ACCOUNT =
  "24jFms4JqYdWb19jFn3CUjNUQz1AeRozYnwsHuUkLbXAj2gRBq598aLAJmqmsaPcsCNJTgTaJTaUZCXpT3s9UeWBsHTmd5hQx95JymZSUsmtwoibiB8AMp4bZjAiLMjmAH3x";

/** The Dusk account that pays out Ethereum migrations on mainnet. */
export const MAINNET_ETHEREUM_PAYOUT_ACCOUNT =
  "2427XSRsdBpgBp3TtcYbFXc8NoGXX4pRZNurE1uRcSgsyGTo4yFJz3or2id85xZdGimEREB8ufEuW9UTPoX53r9ns4EsfSuLkzNMyqt4ha34A6T3DbjBKYNowih6YLGW1Zvi";

/** Who runs the bridge, and the terms and privacy notice it's offered under. */
export const OPERATOR = "Dusk";
export const DUSK_TERMS_URL = "https://dusk.network/terms-of-use";
export const DUSK_PRIVACY_URL = "https://dusk.network/privacy-policy";

export const TESTNET_REGGIO_BRIDGE_ACCOUNT =
  "25z9o6qCaVk1ReyHjmB4pyXcE3D1vRu4FVV1rR8ChYcosdTSktkANLDHq9GD6B4985Q1S2KrDZYBRrohWAjrNmACFUb3UMSRyYctJRzh3d28R1ZNC1ZyKm1HwXL4FF5Etftt";

/** Multicall for Dusk, at the same contract ID on mainnet and testnet. */
export const DUSK_MULTICALL_CONTRACT_ID =
  "93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4";

/** Reviewed data drivers bundled in `public/drivers`, pinned by SHA-256. */
export const BUNDLED_DRIVERS = Object.freeze({
  disputeGameFactory: Object.freeze({
    sha256: "dd07f5a584779940bf116fb2ea32f455f8afbe3399c8e1f125f99f98d499afca",
    url: "/drivers/dispute_game_factory_dd_opt.wasm",
  }),
  multicall: Object.freeze({
    sha256: "d2ed9e7b89d81f12b877f787a7830b90405357c82c9c28f75f0e048530e91462",
    url: "/drivers/dusk_multicall_driver.wasm",
  }),
  optimismPortal: Object.freeze({
    sha256: "9220bf0e96f8d1d20ae8c56459c75d402045bb0fa63851b9413c7db57749b360",
    url: "/drivers/optimism_portal_dd_opt.wasm",
  }),
});

const ETH = Object.freeze({ decimals: 18, name: "Ether", symbol: "ETH" });

/** A network's own coin when its profile has none: BSC pays in BNB, tBNB on its testnet (chain 97). */
const nativeCurrency = (id, chainId) =>
  id === "bsc" ? { decimals: 18, name: "BNB", symbol: chainId === 97 ? "tBNB" : "BNB" } : ETH;

const url = (name, fallback = "") => {
  const raw = value(name, fallback);
  return /^https?:\/\//iu.test(raw) ? raw : "";
};

/** A Dusk account where one is known; `none` clears the profile's. */
const account = (name, fallback = "") => {
  const raw = value(name, fallback);
  return raw.toLowerCase() === NONE ? "" : raw;
};

const PROFILES = Object.freeze({
  mainnet: {
    dusk: {
      chainId: "dusk:1",
      explorerUrl: "https://apps.dusk.network/explorer",
      nodeUrl: "https://nodes.dusk.network",
    },
    evm: {
      bsc: {
        chainId: 56,
        chainName: "BNB Smart Chain",
        currency: { decimals: 18, name: "BNB", symbol: "BNB" },
        explorerUrl: "https://bscscan.com",
        migrationContract: "0x32979f040feb67a5223acb0716fe4c7a5956488c",
        // "Around one hour" to the payout on Dusk, as the docs' migration
        // guide says. The three payouts of the 7 days to 28 Oct 2026 came 63
        // to 66.5 minutes after their migrations.
        migrationSeconds: 3_600,
        // The account Dusk -> BSC transfers go to pays out BSC migrations
        // too, with the migration's hash as the memo: 189 payouts in the 200
        // days to 27 Oct 2026.
        payoutAccount: MAINNET_BSC_BRIDGE_ACCOUNT,
        // bsc-dataseed refuses eth_getLogs over 1,000 blocks; payouts need it.
        rpcUrl: "https://bsc-rpc.publicnode.com",
        tokenContract: "0xb2bd0749dbe21f623d9baba856d3b0f0e1bfec9c",
      },
      ethereum: {
        chainId: 1,
        chainName: "Ethereum",
        currency: ETH,
        explorerUrl: "https://etherscan.io",
        migrationContract: "0x36b8e0b938c0172c20e14cc32e7f0e51dcf1084f",
        // 66 to 67 minutes from the migration's block to its payout on Dusk,
        // for each of the 15 migrations of 28 Sep to 24 Oct 2026.
        migrationSeconds: 4_000,
        payoutAccount: MAINNET_ETHEREUM_PAYOUT_ACCOUNT,
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        tokenContract: "0x940a2db1b7008b6c776d4faaca729d6d4a4aa551",
      },
    },
    migrations: ["ethereum", "bsc"],
    // The payout on BSC takes around 10 hours while a temporary security
    // measure lasts, one hour otherwise, as the docs' BEP20 bridge guide
    // says (Oct 2026).
    service: { account: MAINNET_BSC_BRIDGE_ACCOUNT, delaySeconds: 36_000, network: "bsc" },
    // DuskEVM mainnet isn't live: every endpoint and contract ID must be set.
    duskEvm: { name: "DuskEVM" },
  },
  testnet: {
    dusk: {
      chainId: "dusk:2",
      explorerUrl: "https://apps.testnet.dusk.network/explorer",
      nodeUrl: "https://testnet.nodes.dusk.network",
    },
    evm: {
      ethereum: {
        chainId: 11_155_111,
        chainName: "Sepolia",
        currency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
        explorerUrl: "https://sepolia.etherscan.io",
        migrationContract: "0x7B1FF96D7edC07D8d83eC2A4da99EF8215a7366B",
        // No time: the testnet worker that pays out doesn't always run (two
        // payouts after 16 minutes in Feb 2026, none since).
        migrationSeconds: null,
        rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
        tokenContract: "0xAced3474eA24f5d77464A0F625dEEB6EaDeE25b8",
      },
    },
    migrations: ["ethereum"],
    // No time: the testnet worker that pays out doesn't always run (no
    // transfers in the 60 days to 27 Oct 2026).
    service: { account: TESTNET_REGGIO_BRIDGE_ACCOUNT, delaySeconds: null, network: "ethereum" },
    // Shown, but not running: nothing has been paid out on the Sepolia
    // routes since 11 Feb 2026. `VITE_PAUSED_ROUTES=none` runs them again.
    paused: ["ethereum-to-dusk", "dusk-to-ethereum"],
    duskEvm: {
      // DuskEVM testnet's anchor state registry (its address book,
      // testnet/l1-addresses.json): the Portal asks it whether a game is
      // proper and respected.
      anchorStateRegistryContractId: "1735498c11978854e390894502850916f4ba619e3f4b88c10ef758c5026619cc",
      chainId: 745,
      // Until DuskEVM's own figure is read: its 40 deposits of 1 Sep to
      // 27 Oct 2026 took 25 to 39 s from their Dusk block (Dusk's own time)
      // to their DuskEVM block, plus up to a Dusk block to be included.
      depositSeconds: 60,
      explorerUrl: "https://explorer.testnet.evm.dusk.network",
      l1BridgeRpcUrl: "https://rpc.testnet.evm.dusk.network/l1",
      name: "DuskEVM Testnet",
      rpcUrl: "https://rpc.testnet.evm.dusk.network",
    },
  },
});

const ENV_PREFIX = Object.freeze({ bsc: "BSC", ethereum: "ETHEREUM" });

function evmNetwork(id, defaults = {}) {
  const prefix = ENV_PREFIX[id];
  const chainId = positiveInteger(`VITE_${prefix}_CHAIN_ID`, defaults.chainId ?? 0);
  const network = {
    chainId,
    chainName: value(`VITE_${prefix}_CHAIN_NAME`, defaults.chainName),
    currency: Object.freeze(defaults.currency ?? nativeCurrency(id, chainId)),
    explorerUrl: value(`VITE_${prefix}_EXPLORER_URL`, defaults.explorerUrl),
    id,
    migrationContract: value(
      `VITE_${prefix}_MIGRATION_CONTRACT`,
      defaults.migrationContract,
    ),
    migrationSeconds: seconds(`VITE_${prefix}_MIGRATION_SECONDS`, defaults.migrationSeconds),
    // The Dusk account this chain's migrations are paid from, where it's
    // known: only its transfers then count as payouts.
    payoutAccount: account(
      `VITE_${prefix}_PAYOUT_ACCOUNT`,
      value("VITE_MIGRATION_PAYOUT_ACCOUNT", defaults.payoutAccount),
    ),
    rpcUrl: value(`VITE_${prefix}_RPC_URL`, defaults.rpcUrl),
    tokenContract: value(`VITE_${prefix}_TOKEN_CONTRACT`, defaults.tokenContract),
  };
  network.configured = Boolean(
    network.chainId &&
      network.chainName &&
      network.rpcUrl &&
      /^0x[0-9a-f]{40}$/iu.test(network.tokenContract),
  );
  return Object.freeze(network);
}

function duskEvmConfig(defaults) {
  // Optional: without it, a proof goes against the newest game covering the
  // withdrawal, not one that has already resolved. `none` leaves it out.
  const registry = contractId("VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID", defaults.anchorStateRegistryContractId);
  const duskEvm = {
    anchorStateRegistryContractId: isContractId(registry) ? registry : "",
    bridgeGameSearchDepth: positiveInteger("VITE_DUSKEVM_BRIDGE_GAME_SEARCH_DEPTH", 64),
    chainId: positiveInteger("VITE_DUSKEVM_CHAIN_ID", defaults.chainId ?? 0),
    depositSeconds: seconds("VITE_DUSKEVM_DEPOSIT_SECONDS", defaults.depositSeconds),
    disputeGameFactoryContractId: contractId(
      "VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID",
    ),
    disputeGameFactoryDriver: Object.freeze({
      sha256: value(
        "VITE_DUSKEVM_DISPUTE_GAME_FACTORY_DATA_DRIVER_SHA256",
        BUNDLED_DRIVERS.disputeGameFactory.sha256,
      ).toLowerCase(),
      url: value(
        "VITE_DUSKEVM_DISPUTE_GAME_FACTORY_DATA_DRIVER_URL",
        BUNDLED_DRIVERS.disputeGameFactory.url,
      ),
    }),
    explorerUrl: value("VITE_DUSKEVM_EXPLORER_URL", defaults.explorerUrl),
    l1BridgeRpcUrl: value("VITE_DUSKEVM_L1_BRIDGE_RPC_URL", defaults.l1BridgeRpcUrl),
    l1StandardBridgeContractId: contractId(
      "VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID",
    ),
    l2StandardBridgeAddress: value(
      "VITE_DUSKEVM_L2_STANDARD_BRIDGE_ADDRESS",
      "0x4200000000000000000000000000000000000010",
    ),
    // The chain name wallets list; the page itself says "DuskEVM".
    name: value("VITE_DUSKEVM_NAME", defaults.name ?? "DuskEVM"),
    optimismPortalContractId: contractId(
      "VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID",
    ),
    optimismPortalDriver: Object.freeze({
      sha256: value(
        "VITE_DUSKEVM_OPTIMISM_PORTAL_DATA_DRIVER_SHA256",
        BUNDLED_DRIVERS.optimismPortal.sha256,
      ).toLowerCase(),
      url: value(
        "VITE_DUSKEVM_OPTIMISM_PORTAL_DATA_DRIVER_URL",
        BUNDLED_DRIVERS.optimismPortal.url,
      ),
    }),
    rpcUrl: value("VITE_DUSKEVM_RPC_URL", defaults.rpcUrl),
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
  duskEvm.enabled = missing.length === 0;
  return Object.freeze(duskEvm);
}

export function loadConfig() {
  const requested = value("VITE_BRIDGE_PROFILE", "mainnet").toLowerCase();
  const profile = requested === "testnet" ? "testnet" : "mainnet";
  const defaults = PROFILES[profile];

  const dusk = Object.freeze({
    chainId: value("VITE_DUSK_CHAIN_ID", defaults.dusk.chainId),
    explorerUrl: value("VITE_DUSK_EXPLORER_URL", defaults.dusk.explorerUrl),
    nodeUrl: value("VITE_DUSK_NODE_URL", defaults.dusk.nodeUrl),
  });

  const evmNetworks = Object.freeze(
    Object.fromEntries(
      Object.keys(ENV_PREFIX).map((id) => [id, evmNetwork(id, defaults.evm[id])]),
    ),
  );
  const usable = (id) => Boolean(evmNetworks[id]?.configured);
  const migrations = Object.freeze(
    list("VITE_MIGRATION_NETWORKS", defaults.migrations).filter(
      (id) => usable(id) && /^0x[0-9a-f]{40}$/iu.test(evmNetworks[id].migrationContract),
    ),
  );
  const serviceNetwork = value("VITE_SERVICE_NETWORK", defaults.service.network).toLowerCase();
  const service = usable(serviceNetwork)
    ? Object.freeze({
        account: value("VITE_SERVICE_BRIDGE_ACCOUNT", defaults.service.account),
        delaySeconds: seconds("VITE_SERVICE_BRIDGE_DELAY_SECONDS", defaults.service.delaySeconds),
        feeLux: BigInt(positiveInteger("VITE_SERVICE_BRIDGE_FEE_LUX", 1_000_000_000)),
        network: serviceNetwork,
        payoutAddress: value("VITE_SERVICE_BRIDGE_PAYOUT_ADDRESS"),
      })
    : null;

  const multicallId = contractId("VITE_DUSK_MULTICALL_CONTRACT_ID", DUSK_MULTICALL_CONTRACT_ID);

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
      // Dusk's own, as on the explorer; a deployment can name its own.
      privacy: url("VITE_PRIVACY_URL", DUSK_PRIVACY_URL),
      sites: Object.freeze({
        mainnet: url("VITE_MAINNET_BRIDGE_URL"),
        testnet: url("VITE_TESTNET_BRIDGE_URL"),
      }),
      status: url("VITE_STATUS_URL"),
      support: url("VITE_SUPPORT_URL"),
      supportLabel: value("VITE_SUPPORT_LABEL", "support"),
      terms: url("VITE_TERMS_URL", DUSK_TERMS_URL),
    }),
    // Dusk runs every route, unless a deployment names another for one.
    operators: Object.freeze({
      duskEvm: value("VITE_DUSKEVM_OPERATOR", OPERATOR),
      migration: value("VITE_MIGRATION_OPERATOR", OPERATOR),
      service: value("VITE_SERVICE_OPERATOR", OPERATOR),
    }),
    dusk,
    duskEvm: duskEvmConfig(defaults.duskEvm),
    evmNetworks,
    gasLimitUpper: BigInt(positiveInteger("VITE_GAS_LIMIT_UPPER", 1_000_000_000)),
    migrations,
    multicall: Object.freeze({
      contractId: isContractId(multicallId) ? multicallId : "",
      driver: BUNDLED_DRIVERS.multicall,
    }),
    // Routes shown but not running now, by route ID; `none` runs them all.
    pausedRoutes: Object.freeze(list("VITE_PAUSED_ROUTES", defaults.paused ?? [])),
    profile,
    reown: Object.freeze({ projectId: value("VITE_REOWN_PROJECT_ID") }),
    service,
  });
}

export const config = loadConfig();

export const duskEvmDepositConfigured = () => config.duskEvm.enabled;
