import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase58 } from "./base58.js";

test("base58 decoding preserves leading zero bytes", () => {
  assert.deepEqual([...decodeBase58("1112")], [0, 0, 0, 1]);
});

test("base58 decoding rejects ambiguous and non-alphabet characters", () => {
  for (const value of ["0", "O", "I", "l", " "])
    assert.throws(() => decodeBase58(value));
});
