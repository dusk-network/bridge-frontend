import assert from "node:assert/strict";
import test from "node:test";

import { aboutFee, formatDusk, formatFee, formatLux, formatMaxFee } from "./format.js";
import { amountsIn } from "./pages.fixtures.js";

test("amounts group their digits and keep every Lux", () => {
  assert.equal(formatLux(1_483_920_000_000n), "1,483.92");
  assert.equal(formatDusk(1n), "0.000000001 DUSK");
  assert.equal(formatDusk(-1_000_000_000_000n), "−1,000 DUSK");
});

test("fees keep two significant digits and never understate a maximum", () => {
  assert.equal(formatFee(5_000_000n, 9, { round: "up" }), "0.005");
  assert.equal(formatFee(50_200_000n, 9, { round: "up" }), "0.051");
  assert.equal(formatFee(1_850_000n), "0.0019");
  assert.equal(formatFee(2_209_505n), "0.0022");
  assert.equal(formatFee(2_209_505n, 9, { round: "up" }), "0.0023");
  assert.equal(formatFee(55_200_000_000_000n, 18), "0.000055");
  assert.deepEqual(amountsIn(aboutFee(55_200_000_000_000n, 18, "ETH")), ["0.000055 ETH"]);
  // Sepolia gas can cost next to nothing: less than its smallest step, never a string of zeros.
  assert.deepEqual(amountsIn(aboutFee(15_000_000n, 18, "ETH")), ["<0.000001 ETH"]);
});

test("a Dusk fee before it's paid is the most it can be, rounded up", () => {
  assert.deepEqual([0n, 2_500_000n, 5_000_000n, 50_519_542n, 105_000_001n].map(formatMaxFee), ["0", "0.0025", "0.005", "0.0506", "0.1051"]);
  // Under 0.01 DUSK, two significant digits.
  assert.equal(formatMaxFee(49_999n), "0.00005");
});
