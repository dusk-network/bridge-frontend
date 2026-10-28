import assert from "node:assert/strict";
import test from "node:test";

import { WEI_PER_LUX, withdrawalAmountWei } from "./duskevm-withdrawal.js";

test("withdrawals move whole Lux: at most 9 decimals", () => {
  assert.equal(withdrawalAmountWei("1.000000001"), 1_000_000_001n * WEI_PER_LUX);
  assert.equal(withdrawalAmountWei("0.1"), 100_000_000_000_000_000n);
  assert.throws(() => withdrawalAmountWei("1.0000000001"), /at most 9 decimal places/u);
  assert.throws(() => withdrawalAmountWei("0.000000000000000001"), /at most 9 decimal places/u);
});
