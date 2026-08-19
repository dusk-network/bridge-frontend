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

export const MAINNET_BSC_BRIDGE_ACCOUNT =
  "24jFms4JqYdWb19jFn3CUjNUQz1AeRozYnwsHuUkLbXAj2gRBq598aLAJmqmsaPcsCNJTgTaJTaUZCXpT3s9UeWBsHTmd5hQx95JymZSUsmtwoibiB8AMp4bZjAiLMjmAH3x";

export const config = Object.freeze({
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
    bscBridgeAccount: value(
      "VITE_BSC_BRIDGE_ACCOUNT",
      MAINNET_BSC_BRIDGE_ACCOUNT,
    ),
    bscBridgeFeeLux: 1_000_000_000n,
    migrations: Object.freeze({
      bsc: Object.freeze({
        chainId: 56,
        chainName: "BNB Smart Chain",
        currency: Object.freeze({ decimals: 18, name: "BNB", symbol: "BNB" }),
        explorerUrl: "https://bscscan.com",
        migrationContract: "0x32979f040feb67a5223acb0716fe4c7a5956488c",
        rpcUrl: value("VITE_BSC_RPC_URL", "https://bsc-dataseed.binance.org"),
        tokenContract: "0xb2bd0749dbe21f623d9baba856d3b0f0e1bfec9c",
      }),
      ethereum: Object.freeze({
        chainId: 1,
        chainName: "Ethereum",
        currency: Object.freeze({ decimals: 18, name: "Ether", symbol: "ETH" }),
        explorerUrl: "https://etherscan.io",
        migrationContract: "0x36b8e0b938c0172c20e14cc32e7f0e51dcf1084f",
        rpcUrl: value(
          "VITE_ETHEREUM_RPC_URL",
          "https://ethereum-rpc.publicnode.com",
        ),
        tokenContract: "0x940a2db1b7008b6c776d4faaca729d6d4a4aa551",
      }),
    }),
  }),
});

export const duskEvmDepositConfigured = () =>
  /^[0-9a-f]{64}$/u.test(config.duskEvm.l1StandardBridgeContractId);
