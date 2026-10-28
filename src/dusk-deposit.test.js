import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "viem";

import { decodeDepositArgs, encodeDepositArgs } from "./dusk-deposit.js";

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

test("a deposit is read back from its call data, as the node returns it", () => {
  // The 0.1 tDUSK testnet deposit of 26 Oct 2026 (Dusk tx ceb48ee5…).
  const args = decodeDepositArgs(
    "00e1f505000000003e5b8223e638cb414bef8cf95393460ca1c3a11d400d0300e0ffffff00000000",
  );
  assert.equal(args.amountLux, 100_000_000n);
  assert.equal(args.to, "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d");
  assert.equal(args.minGasLimit, 200_000);
  // The tuple sits after any extraData bytes, at the end of the archive.
  const withExtra = new Uint8Array(48);
  withExtra.set(encodeDepositArgs({ amountLux: 7n, minGasLimit: 1, to: args.to }), 8);
  assert.equal(decodeDepositArgs(withExtra).amountLux, 7n);
});
