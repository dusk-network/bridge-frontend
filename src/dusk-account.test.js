import assert from "node:assert/strict";
import test from "node:test";

import { duskSheet, header } from "./views.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

test("the connected Dusk Wallet's pill opens what can be done with it: use another profile, or disconnect", () => {
  const top = header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { state: "connect" }, isTestnet: true });
  assert.match(top, new RegExp(`<button type="button" class="wpill" data-action="open-dusk" aria-haspopup="dialog" aria-label="Dusk Wallet, account ${ACCOUNT}">`, "u"));
  // Not connected yet: it connects, as before.
  assert.match(header({ badge: "Testnet", dusk: { state: "connect" }, evm: { state: "connect" }, isTestnet: true }), /data-action="connect-dusk">Connect Dusk Wallet</u);
  const sheet = duskSheet({ account: ACCOUNT, name: "" });
  assert.match(sheet, /<h2 id="sheet-title">Dusk Wallet<\/h2>/u);
  assert.match(sheet, /21n5nc…fMMLNz/u);
  assert.match(sheet, /<button type="button" class="btn sec sm" data-action="dusk-other-profile">Use another profile<\/button>/u);
  assert.match(sheet, /<button type="button" class="btn sec sm" data-action="dusk-disconnect">Disconnect<\/button>/u);
  // By its .dusk name where it has one.
  assert.match(duskSheet({ account: ACCOUNT, name: "alice.dusk" }), /alice\.dusk/u);
});

test("a disconnect Dusk Wallet refuses or doesn't answer says so: nothing is announced as let go, and no other profile is asked for", async () => {
  const { disconnectDusk } = await import("./dusk-wallet.js");
  assert.equal(await disconnectDusk({ disconnect: async () => true }), "");
  assert.equal(
    await disconnectDusk({ disconnect: async () => Promise.reject(new Error("timed out")) }),
    "Dusk Wallet didn't disconnect this page. Try again, or disconnect it in Dusk Wallet.",
  );
  assert.equal(await disconnectDusk(null), "Dusk Wallet didn't disconnect this page. Try again, or disconnect it in Dusk Wallet.");
  // The wallet answering that it didn't.
  assert.equal(await disconnectDusk({ disconnect: async () => false }), "Dusk Wallet didn't disconnect this page. Try again, or disconnect it in Dusk Wallet.");
});
