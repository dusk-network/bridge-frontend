import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMigrationBalance,
  parseMigrationAmount,
} from "./legacy-migration.js";

test("legacy migration accepts exact Lux and rejects fractions the contract rounds away", () => {
  assert.equal(parseMigrationAmount("1.000000001"), 1_000_000_001_000_000_000n);
  assert.equal(parseMigrationAmount("0.000000001"), 1_000_000_000n);
  assert.throws(() => parseMigrationAmount("0.0000000001"), /minimum/u);
  assert.throws(() => parseMigrationAmount("1.0000000001"), /9 decimal/u);
});

test("legacy migration rejects an amount above the wallet token balance", () => {
  assert.equal(
    assertMigrationBalance(5_000_000_000_000_000_000n, "5"),
    5_000_000_000_000_000_000n,
  );
  assert.throws(
    () => assertMigrationBalance(0n, "5"),
    /0 available, 5 required/u,
  );
});
