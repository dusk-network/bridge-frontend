import assert from "node:assert/strict";
import test from "node:test";

import { buildContractCallRequest } from "./dusk-wallet.js";

test("native bridge value is attached as a contract deposit", () => {
  const request = buildContractCallRequest({
    chainId: "dusk:2",
    contractId: "11".repeat(32),
    depositLux: 42n,
    fnArgs: new Uint8Array(),
    fnName: "depositETHToWithValue",
  });
  assert.equal(request.deposit, "42");
  assert.equal("amount" in request, false);
  assert.equal("chainId" in request, false);
});
