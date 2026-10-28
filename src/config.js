const env = import.meta.env ?? {};

const value = (name, fallback = "") => {
  const runtime = globalThis.__DUSK_BRIDGE_CONFIG__?.[name];
  return String(runtime ?? env[name] ?? fallback).trim();
};

const positiveInteger = (name, fallback) => {
  const parsed = Number(value(name, fallback));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const contract = (name) => value(name).replace(/^0x/u, "").toLowerCase();

const requestedProfile = value("VITE_BRIDGE_PROFILE", "mainnet").toLowerCase();
const profile = requestedProfile === "testnet" ? "testnet" : "mainnet";
const testnet = profile === "testnet";
const legacyDuskChainId = value(
  testnet ? "VITE_DUSK_TESTNET_CHAIN_ID" : "VITE_DUSK_MAINNET_CHAIN_ID",
  testnet ? "dusk:2" : "dusk:1",
);

const evmNetwork = (prefix, defaults) =>
  Object.freeze({
    chainId: positiveInteger(`VITE_${prefix}_CHAIN_ID`, defaults.chainId),
    chainName: value(`VITE_${prefix}_CHAIN_NAME`, defaults.chainName),
    currency: Object.freeze(defaults.currency),
    explorerUrl: value(
      `VITE_${prefix}_EXPLORER_URL`,
      defaults.explorerUrl,
    ),
    migrationContract: value(
      `VITE_${prefix}_MIGRATION_CONTRACT`,
      defaults.migrationContract,
    ),
    rpcUrl: value(`VITE_${prefix}_RPC_URL`, defaults.rpcUrl),
    tokenContract: value(
      `VITE_${prefix}_TOKEN_CONTRACT`,
      defaults.tokenContract,
    ),
  });

export const MAINNET_BSC_BRIDGE_ACCOUNT =
  "24jFms4JqYdWb19jFn3CUjNUQz1AeRozYnwsHuUkLbXAj2gRBq598aLAJmqmsaPcsCNJTgTaJTaUZCXpT3s9UeWBsHTmd5hQx95JymZSUsmtwoibiB8AMp4bZjAiLMjmAH3x";

export const TESTNET_REGGIO_BRIDGE_ACCOUNT =
  "25z9o6qCaVk1ReyHjmB4pyXcE3D1vRu4FVV1rR8ChYcosdTSktkANLDHq9GD6B4985Q1S2KrDZYBRrohWAjrNmACFUb3UMSRyYctJRzh3d28R1ZNC1ZyKm1HwXL4FF5Etftt";

const ethereum = evmNetwork(
  "ETHEREUM",
  testnet
    ? {
        chainId: 11_155_111,
        chainName: "Sepolia",
        currency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
        explorerUrl: "https://sepolia.etherscan.io",
        migrationContract: "0x7B1FF96D7edC07D8d83eC2A4da99EF8215a7366B",
        rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
        tokenContract: "0xAced3474eA24f5d77464A0F625dEEB6EaDeE25b8",
      }
    : {
        chainId: 1,
        chainName: "Ethereum",
        currency: { decimals: 18, name: "Ether", symbol: "ETH" },
        explorerUrl: "https://etherscan.io",
        migrationContract: "0x36b8e0b938c0172c20e14cc32e7f0e51dcf1084f",
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        tokenContract: "0x940a2db1b7008b6c776d4faaca729d6d4a4aa551",
      },
);

const bsc = evmNetwork("BSC", {
  chainId: 56,
  chainName: "BNB Smart Chain",
  currency: { decimals: 18, name: "BNB", symbol: "BNB" },
  explorerUrl: "https://bscscan.com",
  migrationContract: "0x32979f040feb67a5223acb0716fe4c7a5956488c",
  rpcUrl: "https://bsc-dataseed.binance.org",
  tokenContract: "0xb2bd0749dbe21f623d9baba856d3b0f0e1bfec9c",
});

export const config = Object.freeze({
  profile,
  reown: Object.freeze({
    projectId: value("VITE_REOWN_PROJECT_ID"),
  }),
  dusk: Object.freeze({
    mainnet: Object.freeze({
      chainId: value("VITE_DUSK_MAINNET_CHAIN_ID", "dusk:1"),
      explorerUrl: value(
        "VITE_DUSK_MAINNET_EXPLORER_URL",
        "https://apps.dusk.network/explorer",
      ),
      nodeUrl: value(
        "VITE_DUSK_MAINNET_NODE_URL",
        "https://nodes.dusk.network",
      ),
    }),
    testnet: Object.freeze({
      chainId: value("VITE_DUSK_TESTNET_CHAIN_ID", "dusk:2"),
      explorerUrl: value(
        "VITE_DUSK_TESTNET_EXPLORER_URL",
        "https://apps.testnet.dusk.network/explorer",
      ),
      nodeUrl: value(
        "VITE_DUSK_TESTNET_NODE_URL",
        "https://testnet.nodes.dusk.network",
      ),
    }),
  }),
  duskEvm: Object.freeze({
    chainId: positiveInteger("VITE_DUSKEVM_CHAIN_ID", 745),
    explorerUrl: value(
      "VITE_DUSKEVM_EXPLORER_URL",
      "https://explorer.testnet.evm.dusk.network",
    ),
    l1ChainId: value("VITE_DUSKEVM_L1_CHAIN_ID", "dusk:2"),
    l1NodeUrl: value(
      "VITE_DUSKEVM_L1_NODE_URL",
      "https://testnet.nodes.dusk.network",
    ),
    l1BridgeRpcUrl: value("VITE_DUSKEVM_L1_BRIDGE_RPC_URL"),
    bridgeGameSearchDepth: positiveInteger(
      "VITE_DUSKEVM_BRIDGE_GAME_SEARCH_DEPTH",
      64,
    ),
    disputeGameFactoryContractId: contract(
      "VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID",
    ),
    disputeGameFactoryDriverUrl: value(
      "VITE_DUSKEVM_DISPUTE_GAME_FACTORY_DATA_DRIVER_URL",
      "/drivers/dispute_game_factory_dd_opt.wasm",
    ),
    l1StandardBridgeContractId: contract(
      "VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID",
    ),
    l2StandardBridgeAddress: value(
      "VITE_DUSKEVM_L2_STANDARD_BRIDGE_ADDRESS",
      "0x4200000000000000000000000000000000000010",
    ),
    name: value("VITE_DUSKEVM_NAME", "DuskEVM Testnet"),
    optimismPortalContractId: contract(
      "VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID",
    ),
    optimismPortalDriverUrl: value(
      "VITE_DUSKEVM_OPTIMISM_PORTAL_DATA_DRIVER_URL",
      "/drivers/optimism_portal_dd_opt.wasm",
    ),
    rpcUrl: value(
      "VITE_DUSKEVM_RPC_URL",
      "https://rpc.testnet.evm.dusk.network",
    ),
  }),
  legacy: Object.freeze({
    defaultDuskRecipient: value("VITE_DEFAULT_DUSK_RECIPIENT"),
    duskChainId: legacyDuskChainId,
    duskLabel: testnet ? "Dusk Testnet" : "Dusk Mainnet",
    migrationKeys: Object.freeze(testnet ? ["ethereum"] : ["ethereum", "bsc"]),
    serviceBridgeAccount: value(
      "VITE_SERVICE_BRIDGE_ACCOUNT",
      testnet ? TESTNET_REGGIO_BRIDGE_ACCOUNT : MAINNET_BSC_BRIDGE_ACCOUNT,
    ),
    serviceBridgeFeeLux: 1_000_000_000n,
    serviceNetworkId: testnet ? "ethereum" : "bsc",
    migrations: Object.freeze({
      bsc,
      ethereum,
    }),
  }),
});

export const duskEvmDepositConfigured = () =>
  /^[0-9a-f]{64}$/u.test(config.duskEvm.l1StandardBridgeContractId);
