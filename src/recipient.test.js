import assert from "node:assert/strict";
import test from "node:test";
import { validateName } from "@duskdomains/sdk";
import { getAddress } from "viem";

import {
  EVM_CHECKSUM_MISMATCH,
  NOT_DUSK_RECIPIENT,
  NOT_EVM_ADDRESS,
  checkDuskRecipient,
  checkEvmRecipient,
  duskNameProblem,
  nameToLookUp,
  settledEvmRecipient,
} from "./recipient.js";

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

test("a .dusk name Dusk Domains can't hold says why at once, and isn't looked up", () => {
  // Sam's: an underscore. Retrying wouldn't help, so it doesn't say "Try again".
  assert.deepEqual(checkDuskRecipient("bad_name.dusk"), { error: "bad_name.dusk isn't a valid .dusk name: names use a\u2060–\u2060z, 0\u2060–\u20609 and hyphens.", name: "bad_name.dusk" });
  assert.equal(checkDuskRecipient("Bad_Name.dusk", { "bad_name.dusk": { failed: true } }).error, "bad_name.dusk isn't a valid .dusk name: names use a\u2060–\u2060z, 0\u2060–\u20609 and hyphens.");
  assert.equal(checkDuskRecipient("-alice.dusk").error, "-alice.dusk isn't a valid .dusk name: names don't start or end with a hyphen.");
  assert.equal(checkDuskRecipient(`${"a".repeat(64)}.dusk`).error, `${"a".repeat(64)}.dusk isn't a valid .dusk name.`);
  assert.equal(nameToLookUp(" Alice.dusk "), "alice.dusk");
  for (const typed of ["bad_name.dusk", "-alice.dusk", "a.b.c.d.e.dusk", "21n5nc", ""]) assert.equal(nameToLookUp(typed), "", typed);
});

test("a name typed without .dusk is offered as the .dusk name it likely is, as the wallets offer it", () => {
  assert.deepEqual(checkDuskRecipient("alice"), { error: NOT_DUSK_RECIPIENT, suggest: "alice.dusk" });
  for (const [typed, name] of [[" Alice ", "alice.dusk"], ["alice.dusk.", "alice.dusk"], ["shop.alice", "shop.alice.dusk"]])
    assert.equal(checkDuskRecipient(typed).suggest, name, typed);
  // An account in the making, an EVM address, or anything else: no name, and nothing looked up.
  for (const typed of ["21n5ncyuJkRr9", "0x7568", "not an account", "bad_name"]) {
    assert.equal(checkDuskRecipient(typed).suggest, undefined, typed);
    assert.equal(nameToLookUp(typed), "", typed);
  }
  assert.equal(nameToLookUp("alice"), "");
});

test("the bridge's .dusk name rule gives the Dusk Domains SDK's answers", () => {
  const names = [
    "alice.dusk", "a.dusk", "0.dusk", "wallet-both.dusk", "al--ice.dusk", "sub.alice.dusk", "a.b.c.d.dusk", "a.b.c.d.e.dusk",
    `${"x".repeat(63)}.dusk`, `${"x".repeat(64)}.dusk`, "bad_name.dusk", "-alice.dusk", "alice-.dusk", "café.dusk", "alice.dusk.dusk",
    "dusk.dusk", "a_b.c.dusk", "sub.-x.dusk", "1-2-3.dusk", "alice.dus", "alice",
  ];
  for (const name of names) assert.equal(duskNameProblem(name) === "", validateName(name).ok && name.endsWith(".dusk"), name);
});

test("a typed EVM recipient takes its checksum's capitals once it's a whole address", () => {
  const right = getAddress(MIXED.toLowerCase());
  assert.equal(settledEvmRecipient(MIXED.toLowerCase()), right);
  assert.equal(settledEvmRecipient(right), right);
  // Not yet an address, or capitals that don't match: as typed, with the fix offered.
  assert.equal(settledEvmRecipient("0x5a3d8e"), "0x5a3d8e");
  assert.equal(settledEvmRecipient(MIXED), MIXED);
});
