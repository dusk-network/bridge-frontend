import assert from "node:assert/strict";
import test from "node:test";

import { friendlyWalletError, sourceHashFor } from "./app-controller.js";

test("wallet errors tell the user how to recover", () => {
  assert.match(friendlyWalletError({ code: 4100, message: "Wallet locked" }), /unlock.*reconnect/iu);
  assert.match(friendlyWalletError({ code: 4900, message: "Disconnected" }), /disconnected.*reconnect/iu);
  assert.equal(friendlyWalletError({ code: 4001, message: "Rejected" }), "The wallet request was cancelled.");
});

test("a looked-up hash takes its source chain's form", () => {
  const hash = "Ab".repeat(32);
  assert.equal(sourceHashFor({ signer: "evm" }, hash), `0x${"ab".repeat(32)}`);
  assert.equal(sourceHashFor({ signer: "dusk" }, `0x${hash}`), "ab".repeat(32));
  assert.equal(sourceHashFor({ signer: "dusk" }, "nope"), null);
});
