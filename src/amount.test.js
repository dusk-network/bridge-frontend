import assert from "node:assert/strict";
import test from "node:test";

import { duskToLux, duskToWei, parseUnitsExact } from "./amount.js";

test("Dusk amounts preserve exact L1 and EVM precision", () => {
  assert.equal(duskToLux("1.000000001"), 1_000_000_001n);
  assert.equal(duskToWei("1.000000000000000001"), 1_000_000_000_000_000_001n);
});

test("amount parsing rejects rounding, signs, exponents, and zero", () => {
  for (const value of ["0", "-1", "+1", "1e2", "1.0000000001", "  "]) {
    assert.throws(() => parseUnitsExact(value, 9));
  }
});
