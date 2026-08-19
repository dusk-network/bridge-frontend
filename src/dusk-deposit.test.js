import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "viem";

import { encodeDepositArgs } from "./dusk-deposit.js";

test("deposit arguments match the Rust rkyv bridge fixture", () => {
  const encoded = encodeDepositArgs({
    amountLux: 123n,
    minGasLimit: 150_000,
    to: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(
    bytesToHex(encoded),
    "0x7b000000000000001111111111111111111111111111111111111111f0490200e0ffffff00000000",
  );
});

test("deposit arguments reject values outside contract integer widths", () => {
  assert.throws(() =>
    encodeDepositArgs({
      amountLux: 2n ** 64n,
      minGasLimit: 1,
      to: "0x1111111111111111111111111111111111111111",
    }),
  );
  assert.throws(() =>
    encodeDepositArgs({
      amountLux: 1,
      minGasLimit: 2 ** 32,
      to: "0x1111111111111111111111111111111111111111",
    }),
  );
});
