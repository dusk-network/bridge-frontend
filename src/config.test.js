import assert from "node:assert/strict";
import test from "node:test";

const DUSK_TESTNET_ACCOUNT =
  "24bfNr8MDUo5xJBecmeGzXDEraax4Cmbnhjyyt5GaL1Vbe6H48ZSYTpmjRDcFRDFzgzuePAPUNcdGMnBzBQBk4zAMgBCtPsY27tBJtKmB1st6qcmpzRR4Er5imxrzvMRnfWc";

test("the testnet profile selects the Messina and Reggio fixtures", async () => {
  globalThis.__DUSK_BRIDGE_CONFIG__ = {
    VITE_BRIDGE_PROFILE: "testnet",
    VITE_DEFAULT_DUSK_RECIPIENT: DUSK_TESTNET_ACCOUNT,
  };
  const { config, TESTNET_REGGIO_BRIDGE_ACCOUNT } = await import(
    "./config.js?profile=testnet"
  );
  delete globalThis.__DUSK_BRIDGE_CONFIG__;

  assert.equal(config.profile, "testnet");
  assert.equal(config.legacy.duskChainId, "dusk:2");
  assert.deepEqual(config.legacy.migrationKeys, ["ethereum"]);
  assert.equal(config.legacy.serviceNetworkId, "ethereum");
  assert.equal(
    config.legacy.serviceBridgeAccount,
    TESTNET_REGGIO_BRIDGE_ACCOUNT,
  );
  assert.equal(config.legacy.defaultDuskRecipient, DUSK_TESTNET_ACCOUNT);
  assert.equal(config.legacy.migrations.ethereum.chainId, 11_155_111);
  assert.equal(
    config.legacy.migrations.ethereum.migrationContract,
    "0x7B1FF96D7edC07D8d83eC2A4da99EF8215a7366B",
  );
});
