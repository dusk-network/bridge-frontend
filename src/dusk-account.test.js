import assert from "node:assert/strict";
import test from "node:test";

import { decode, exactly, textOf } from "./pages.fixtures.js";
import { duskSheet, header } from "./views.js";

const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
// Each button's action, as the page's handler reads it, beside what the button shows.
const buttonsOf = (fragment) => Object.fromEntries([...fragment.matchAll(/<button\b[^>]*\bdata-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/gu)].map(([, action, shown]) => [decode(action), textOf(shown)]));

test("the connected Dusk Wallet's pill opens what can be done with it: another profile, or disconnect, each button doing what it says", () => {
  // Connected, the pill opens the Dusk Wallet sheet; before that, it connects.
  assert.ok("open-dusk" in buttonsOf(header({ badge: "Testnet", dusk: { account: ACCOUNT, state: "connected" }, evm: { state: "connect" }, isTestnet: true })));
  assert.ok("connect-dusk" in buttonsOf(header({ badge: "Testnet", dusk: { state: "connect" }, evm: { state: "connect" }, isTestnet: true })));
  // The sheet names the account this page uses, by its .dusk name where it has one.
  const sheet = duskSheet({ account: ACCOUNT, name: "" });
  assert.match(textOf(sheet), exactly("21n5nc…fMMLNz"));
  assert.match(textOf(duskSheet({ account: ACCOUNT, name: "alice.dusk" })), exactly("alice.dusk"));
  // Disconnect disconnects, and the other button switches the profile, not the other way round.
  const buttons = buttonsOf(sheet);
  assert.match(buttons["dusk-disconnect"], /\bdisconnect\b/iu);
  assert.match(buttons["dusk-other-profile"], /\bprofile\b/iu);
  assert.doesNotMatch(buttons["dusk-other-profile"], /\bdisconnect\b/iu);
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
