import assert from "node:assert/strict";
import test from "node:test";

import { readWatched, saveWatched, watchTarget } from "./watched-account.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

function memory() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, items, removeItem: (key) => items.delete(key), setItem: (key, value) => items.set(key, String(value)) };
}

test("a followed account is kept per network on this device, and forgotten on request", () => {
  const storage = memory();
  saveWatched("testnet", { account: ACCOUNT, name: "alice.dusk" }, storage);
  assert.deepEqual(readWatched("testnet", storage), { account: ACCOUNT, name: "alice.dusk" });
  assert.equal(readWatched("mainnet", storage), null);
  saveWatched("testnet", null, storage);
  assert.equal(readWatched("testnet", storage), null);
  // What isn't an account isn't followed; storage that refuses changes nothing.
  storage.setItem("dusk-bridge:watched:testnet", JSON.stringify({ account: "nope" }));
  assert.equal(readWatched("testnet", storage), null);
  const refusing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readWatched("testnet", refusing), null);
  assert.doesNotThrow(() => saveWatched("testnet", { account: ACCOUNT }, refusing));
});

test("an account or a .dusk name's public account can be followed", async () => {
  const names = { "alice.dusk": { account: ACCOUNT } };
  const resolveName = async (name) => names[name] ?? { status: "Expired" };
  assert.deepEqual(await watchTarget(` ${ACCOUNT.slice(0, 50)}\n${ACCOUNT.slice(50)} `, { resolveName }), { account: ACCOUNT, name: "" });
  assert.deepEqual(await watchTarget("Alice.dusk", { resolveName }), { account: ACCOUNT, name: "alice.dusk" });
  assert.deepEqual(await watchTarget("bob.dusk", { resolveName }), { error: "bob.dusk isn't an active .dusk name." });
  assert.match((await watchTarget("alice.dusk", { resolveName: async () => { throw new Error("offline"); } })).error, /^Couldn't look up alice\.dusk just now/u);
  assert.match((await watchTarget("", { resolveName })).error, /^Paste a Dusk account/u);
  assert.match((await watchTarget("0x1234", { resolveName })).error, /^That isn't a Dusk account or a \.dusk name/u);
});
