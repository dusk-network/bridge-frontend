import assert from "node:assert/strict";
import test from "node:test";

import { compressedDuskBlsPublicKeyToRaw, encodeDuskExternalAssetRecipient } from "@dusk/evm-sdk";

import { decodeBase58, encodeBase58 } from "./base58.js";
import { networks } from "@dusk-network/networks";

// Two accounts the networks' files name: the BSC and the Sepolia bridge accounts.
const MAINNET_BSC_BRIDGE_ACCOUNT = networks.mainnet.routes.services[0].account;
const TESTNET_REGGIO_BRIDGE_ACCOUNT = networks.testnet.routes.services[0].account;
import { rawKeyToDuskAccount, withdrawalRecipientAccount } from "./dusk-recipient.js";

const ACCOUNTS = [
  MAINNET_BSC_BRIDGE_ACCOUNT,
  TESTNET_REGGIO_BRIDGE_ACCOUNT,
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

test("base58 encoding is the inverse of decoding", () => {
  for (const account of ACCOUNTS) assert.equal(encodeBase58(decodeBase58(account)), account);
  assert.equal(encodeBase58([0, 0, 1]), "112");
});

test("a withdrawal's raw recipient key reads back as the Dusk account", () => {
  for (const account of ACCOUNTS) {
    assert.equal(rawKeyToDuskAccount(compressedDuskBlsPublicKeyToRaw(decodeBase58(account))), account);
    assert.equal(withdrawalRecipientAccount(encodeDuskExternalAssetRecipient(decodeBase58(account))), account);
  }
});

test("a contract credit names the Dusk contract it pays", () => {
  // The shape of testnet withdrawal 0x6ae8c4cb…: tag 32, version 1, the contract ID, a payload.
  assert.equal(withdrawalRecipientAccount(`0x2001${"21a5".repeat(16)}${"00".repeat(64)}`), "21a5".repeat(16));
});

test("other extra data has no Dusk recipient", () => {
  assert.equal(withdrawalRecipientAccount("0x"), null);
  assert.equal(withdrawalRecipientAccount(`0x020101${"11".repeat(32)}`), null);
  assert.equal(rawKeyToDuskAccount(new Uint8Array(193).fill(0xff)), null);
});
