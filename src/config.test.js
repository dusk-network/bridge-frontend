import assert from "node:assert/strict";
import test from "node:test";

import { buildRoutes } from "./bridge-routes.js";
import { decodeBase58 } from "./base58.js";
import {
  MAINNET_BSC_BRIDGE_ACCOUNT,
  MAINNET_ETHEREUM_PAYOUT_ACCOUNT,
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

test("DuskEVM testnet's anchor state registry is known, and a deployment can set or leave it out", () => {
  const registry = (extra = {}) => withConfig({ VITE_BRIDGE_PROFILE: "testnet", ...TESTNET_DUSKEVM, ...extra }).cfg.duskEvm;
  assert.equal(registry().anchorStateRegistryContractId, "1735498c11978854e390894502850916f4ba619e3f4b88c10ef758c5026619cc");
  assert.equal(registry({ VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID: `0x${"44".repeat(32)}` }).anchorStateRegistryContractId, "44".repeat(32));
  // Optional: DuskEVM runs without it.
  assert.deepEqual(
    [registry({ VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID: "none" }).anchorStateRegistryContractId, registry({ VITE_DUSKEVM_ANCHOR_STATE_REGISTRY_CONTRACT_ID: "none" }).enabled],
    ["", true],
  );
  assert.equal(withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg.duskEvm.anchorStateRegistryContractId, "");
});

test("the Ethereum and BSC routes follow the configured networks", () => {
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

test("Dusk runs every route, under its own terms and privacy policy, with no support contact unless one is set", () => {
  const bare = withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg;
  assert.equal(bare.links.support, "");
  assert.equal(bare.links.sites.testnet, "");
  assert.deepEqual({ ...bare.operators }, { duskEvm: "Dusk", migration: "Dusk", service: "Dusk" });
  // The same as the explorer's footer.
  assert.equal(bare.links.terms, "https://dusk.network/terms-of-use");
  assert.equal(bare.links.privacy, "https://dusk.network/privacy-policy");
  // The docs' bridge guides describe the web wallet's bridge: none is linked unless set.
  assert.deepEqual({ ...bare.links.docs }, { duskEvm: "", migration: "", service: "" });

  const set = withConfig({
    VITE_BRIDGE_PROFILE: "mainnet",
    VITE_SERVICE_OPERATOR: "Example Operator B.V.",
    VITE_SUPPORT_URL: "javascript:alert(1)",
    VITE_TESTNET_BRIDGE_URL: "https://bridge.example.org",
  }).cfg;
  assert.equal(set.operators.service, "Example Operator B.V.");
  assert.equal(withConfig({ VITE_BRIDGE_PROFILE: "mainnet", VITE_DOCS_MIGRATION_URL: "https://guide.example.org" }).cfg.links.docs.migration, "https://guide.example.org");
  assert.equal(set.links.sites.testnet, "https://bridge.example.org");
  // Only http(s) links are shown.
  assert.equal(set.links.support, "");
});

test("no deployment prefills where a migration pays out", async () => {
  // A payout account set for everyone would sit in front of every user; the
  // default is the connected Dusk account, or the one typed.
  const cfg = withConfig({ VITE_BRIDGE_PROFILE: "mainnet", VITE_DEFAULT_DUSK_RECIPIENT: "21n5nc" }).cfg;
  assert.equal("defaultDuskRecipient" in cfg, false);
  const { readFile } = await import("node:fs/promises");
  assert.doesNotMatch(await readFile(new URL("../.env.example", import.meta.url), "utf8"), /VITE_DEFAULT_DUSK_RECIPIENT/u);
});

test("each chain's migrations count only payouts from its own known account", () => {
  const mainnet = withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg;
  assert.equal(mainnet.evmNetworks.ethereum.payoutAccount, MAINNET_ETHEREUM_PAYOUT_ACCOUNT);
  // BSC's migrations are paid by the account Dusk to BSC transfers go to.
  assert.equal(mainnet.evmNetworks.bsc.payoutAccount, MAINNET_BSC_BRIDGE_ACCOUNT);
  for (const account of [MAINNET_ETHEREUM_PAYOUT_ACCOUNT, MAINNET_BSC_BRIDGE_ACCOUNT]) assert.equal(decodeBase58(account).length, 96);
  // None is known on testnet: any sender's payout of the exact amount counts there.
  assert.equal(withConfig({ VITE_BRIDGE_PROFILE: "testnet" }).cfg.evmNetworks.ethereum.payoutAccount, "");
  // One for all chains, one per chain, or none.
  const one = withConfig({ VITE_BRIDGE_PROFILE: "mainnet", VITE_MIGRATION_PAYOUT_ACCOUNT: TESTNET_REGGIO_BRIDGE_ACCOUNT }).cfg;
  assert.deepEqual([one.evmNetworks.ethereum.payoutAccount, one.evmNetworks.bsc.payoutAccount], [TESTNET_REGGIO_BRIDGE_ACCOUNT, TESTNET_REGGIO_BRIDGE_ACCOUNT]);
  const each = withConfig({ VITE_BRIDGE_PROFILE: "mainnet", VITE_BSC_PAYOUT_ACCOUNT: "none" }).cfg;
  assert.deepEqual([each.evmNetworks.ethereum.payoutAccount, each.evmNetworks.bsc.payoutAccount], [MAINNET_ETHEREUM_PAYOUT_ACCOUNT, ""]);
});

test("routes can be shown as not running, by one switch", () => {
  assert.deepEqual([...withConfig({ VITE_BRIDGE_PROFILE: "testnet" }).cfg.pausedRoutes], ["ethereum-to-dusk", "dusk-to-ethereum"]);
  assert.deepEqual([...withConfig({ VITE_BRIDGE_PROFILE: "testnet", VITE_PAUSED_ROUTES: "none" }).cfg.pausedRoutes], []);
  assert.deepEqual([...withConfig({ VITE_BRIDGE_PROFILE: "mainnet" }).cfg.pausedRoutes], []);
  assert.deepEqual([...withConfig({ VITE_BRIDGE_PROFILE: "mainnet", VITE_PAUSED_ROUTES: "dusk-to-bsc" }).cfg.pausedRoutes], ["dusk-to-bsc"]);
  // Paused routes stay: their transfers are still followed.
  assert.equal(withConfig({ VITE_BRIDGE_PROFILE: "testnet" }).routes.filter((route) => route.paused).length, 2);
});
