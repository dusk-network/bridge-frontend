import assert from "node:assert/strict";
import test from "node:test";

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
