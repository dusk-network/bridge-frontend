import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import {
  MAINNET_BSC_BRIDGE_ACCOUNT,
  TESTNET_REGGIO_BRIDGE_ACCOUNT,
  loadConfig,
} from "./config.js";

const TESTNET_DUSKEVM = Object.freeze({
  VITE_DUSKEVM_DISPUTE_GAME_FACTORY_CONTRACT_ID: "33".repeat(32),
  VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID: "11".repeat(32),
  VITE_DUSKEVM_OPTIMISM_PORTAL_CONTRACT_ID: "22".repeat(32),
});

function withConfig(values) {
  globalThis.__DUSK_BRIDGE_CONFIG__ = values;
  try {
    const cfg = loadConfig();
    return { cfg, routes: buildRoutes(cfg) };
  } finally {
    delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}

const TESTNET_HOSTS = /testnet|sepolia/iu;

test("the mainnet profile hides DuskEVM until its contracts are configured", () => {
  const { cfg, routes } = withConfig({ VITE_BRIDGE_PROFILE: "mainnet" });

  assert.equal(cfg.duskEvm.enabled, false);
  assert.ok(cfg.duskEvm.missing.includes("VITE_DUSKEVM_L1_STANDARD_BRIDGE_CONTRACT_ID"));
  assert.deepEqual(
    routes.map(({ id }) => id),
    ["ethereum-to-dusk", "bsc-to-dusk", "dusk-to-bsc"],
  );
});

test("nothing in the mainnet profile points at a testnet", () => {
  const { cfg, routes } = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    // Contract IDs alone don't enable DuskEVM on mainnet: there is no
    // default endpoint to fall back to, least of all a testnet one.
    ...TESTNET_DUSKEVM,
  });

  assert.equal(cfg.dusk.chainId, "dusk:1");
  assert.equal(cfg.duskEvm.enabled, false);
  assert.equal(cfg.duskEvm.rpcUrl, "");
  assert.doesNotMatch(cfg.dusk.nodeUrl, TESTNET_HOSTS);
  for (const route of routes) {
    for (const side of [route.from, route.to]) {
      assert.doesNotMatch(side.label, TESTNET_HOSTS);
      if (side.kind === "evm")
        assert.ok([1, 56].includes(cfg.evmNetworks[side.id].chainId));
    }
  }
  assert.equal(cfg.service.account, MAINNET_BSC_BRIDGE_ACCOUNT);
  // The default BSC RPC must answer eth_getLogs for payout tracking.
  assert.equal(cfg.evmNetworks.bsc.rpcUrl, "https://bsc-rpc.publicnode.com");
});

test("the testnet profile stays on Dusk testnet, Sepolia and DuskEVM testnet", () => {
  const { cfg, routes } = withConfig({
    VITE_BRIDGE_PROFILE: "testnet",
    ...TESTNET_DUSKEVM,
  });

  assert.equal(cfg.dusk.chainId, "dusk:2");
  assert.equal(cfg.duskEvm.enabled, true);
  assert.equal(cfg.duskEvm.chainId, 745);
  assert.equal(cfg.evmNetworks.ethereum.chainId, 11_155_111);
  assert.equal(
    cfg.evmNetworks.ethereum.migrationContract,
    "0x7B1FF96D7edC07D8d83eC2A4da99EF8215a7366B",
  );
  assert.equal(cfg.service.account, TESTNET_REGGIO_BRIDGE_ACCOUNT);
  assert.deepEqual(
    routes.map((route) => `${route.from.label} → ${route.to.label}`),
    [
      "Ethereum (Sepolia) → Dusk",
      "Dusk → Ethereum (Sepolia)",
      "Dusk → DuskEVM",
      "DuskEVM → Dusk",
    ],
  );
});

test("old-token routes follow the configured networks", () => {
  const none = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    VITE_MIGRATION_NETWORKS: "none",
    VITE_SERVICE_NETWORK: "none",
  });
  assert.deepEqual(none.routes, []);

  // An empty value is unset: a copied .env.example keeps the defaults.
  const blank = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    VITE_DUSK_NODE_URL: "",
    VITE_MIGRATION_NETWORKS: "",
    VITE_SERVICE_NETWORK: "",
  });
  assert.equal(blank.cfg.dusk.nodeUrl, "https://nodes.dusk.network");
  assert.equal(blank.routes.length, 3);

  const ethereumOnly = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    VITE_MIGRATION_NETWORKS: "ethereum",
  });
  assert.deepEqual(
    ethereumOnly.routes.map(({ id }) => id),
    ["ethereum-to-dusk", "dusk-to-bsc"],
  );

  // No BSC testnet exists, so listing it on testnet adds nothing.
  const testnet = withConfig({
    VITE_BRIDGE_PROFILE: "testnet",
    VITE_MIGRATION_NETWORKS: "ethereum,bsc",
  });
  assert.deepEqual(testnet.cfg.migrations, ["ethereum"]);

  // BSC's testnet added by its own settings pays in tBNB, not ETH.
  const bscTestnet = withConfig({
    VITE_BRIDGE_PROFILE: "testnet",
    VITE_BSC_CHAIN_ID: "97",
    VITE_BSC_CHAIN_NAME: "BSC Testnet",
    VITE_BSC_MIGRATION_CONTRACT: "0x3297000000000000000000000000000000000001",
    VITE_BSC_RPC_URL: "https://bsc-testnet.example",
    VITE_BSC_TOKEN_CONTRACT: "0x3297000000000000000000000000000000000002",
    VITE_MIGRATION_NETWORKS: "ethereum,bsc",
  });
  assert.equal(bscTestnet.cfg.evmNetworks.bsc.currency.symbol, "tBNB");
  assert.equal(bscTestnet.cfg.evmNetworks.ethereum.currency.symbol, "ETH");
  assert.equal(withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg.evmNetworks.bsc.currency.symbol, "BNB");
});

test("the gas bound, fee and multicall come from config", () => {
  const { cfg } = withConfig({
    VITE_BRIDGE_PROFILE: "testnet",
    VITE_DUSK_MULTICALL_CONTRACT_ID: "none",
    VITE_GAS_LIMIT_UPPER: "50000000",
    VITE_SERVICE_BRIDGE_FEE_LUX: "2000000000",
  });

  assert.equal(cfg.gasLimitUpper, 50_000_000n);
  assert.equal(cfg.service.feeLux, 2_000_000_000n);
  assert.equal(cfg.multicall.contractId, "");
  assert.equal(
    withConfig({ VITE_BRIDGE_PROFILE: "testnet" }).cfg.multicall.contractId,
    "93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4",
  );
});

test("links, operators and contacts appear only when configured", () => {
  const bare = withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg;
  assert.equal(bare.links.support, "");
  assert.equal(bare.links.sites.testnet, "");
  assert.deepEqual({ ...bare.operators }, { duskEvm: "", migration: "", service: "" });
  assert.match(bare.links.docs.migration, /^https:\/\/docs\.dusk\.network\//u);

  const set = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    VITE_SERVICE_OPERATOR: "Example Operator B.V.",
    VITE_SUPPORT_URL: "javascript:alert(1)",
    VITE_TESTNET_BRIDGE_URL: "https://bridge.example.org",
  }).cfg;
  assert.equal(set.operators.service, "Example Operator B.V.");
  assert.equal(set.links.sites.testnet, "https://bridge.example.org");
  // Only http(s) links are shown.
  assert.equal(set.links.support, "");
});
