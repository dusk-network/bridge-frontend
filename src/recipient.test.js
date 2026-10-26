import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";

import { EVM_CHECKSUM_MISMATCH, NOT_DUSK_RECIPIENT, NOT_EVM_ADDRESS, checkDuskRecipient, checkEvmRecipient } from "./recipient.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
// Sam's typed address: 0x and 40 hex characters, with capitals off its checksum.
const MIXED = "0x5a3D8e1B7c2f4A6b9E0d1C3f5a7B9c2D4e6F8a01";

test("an EVM recipient is used checksummed, and wrong capitals are named as such", () => {
  const right = getAddress(MIXED.toLowerCase());
  assert.deepEqual(checkEvmRecipient(MIXED.toLowerCase()), { address: right });
  assert.deepEqual(checkEvmRecipient(` ${right} `), { address: right });
  assert.deepEqual(checkEvmRecipient(MIXED), { error: EVM_CHECKSUM_MISMATCH, fix: right });
  assert.deepEqual(checkEvmRecipient("0x1234"), { error: NOT_EVM_ADDRESS });
});

test("a .dusk name is a Dusk recipient once its lookup finds a public account", () => {
  assert.deepEqual(checkDuskRecipient(ACCOUNT), { address: ACCOUNT });
  assert.deepEqual(checkDuskRecipient("Alice.dusk"), { name: "alice.dusk", pending: true });
  assert.deepEqual(checkDuskRecipient("alice.dusk", { "alice.dusk": { account: ACCOUNT } }), { address: ACCOUNT, name: "alice.dusk" });
  const said = (found) => checkDuskRecipient("alice.dusk", { "alice.dusk": found }).error;
  assert.equal(said({ status: "Expired" }), "alice.dusk isn't an active .dusk name.");
  assert.equal(said({ status: "Active" }), "alice.dusk doesn't point to a public Dusk account.");
  assert.equal(said({ account: "not a key" }), "alice.dusk doesn't point to a public Dusk account.");
  assert.match(said({ failed: true }), /^Couldn't look up alice\.dusk just now/u);
  assert.deepEqual(checkDuskRecipient("not an account"), { error: NOT_DUSK_RECIPIENT });
});
