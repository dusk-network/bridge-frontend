import assert from "node:assert/strict";
import test from "node:test";

import { friendlyWalletError } from "./app-controller.js";

test("wallet errors tell the user how to recover", () => {
  assert.match(
    friendlyWalletError({ code: 4100, message: "Wallet locked" }),
    /unlock.*reconnect/iu,
  );
  assert.match(
    friendlyWalletError({ code: 4900, message: "Disconnected" }),
    /disconnected.*reconnect/iu,
  );
  assert.equal(
    friendlyWalletError({ code: 4001, message: "Rejected" }),
    "The wallet request was cancelled.",
  );
});
