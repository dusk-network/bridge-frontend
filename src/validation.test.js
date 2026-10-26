import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDuskAddress } from "./validation.js";

const DUSK_TESTNET_ACCOUNT =
  "24bfNr8MDUo5xJBecmeGzXDEraax4Cmbnhjyyt5GaL1Vbe6H48ZSYTpmjRDcFRDFzgzuePAPUNcdGMnBzBQBk4zAMgBCtPsY27tBJtKmB1st6qcmpzRR4Er5imxrzvMRnfWc";

test("Dusk migration recipients decode to the expected account size", () => {
  assert.equal(
    normalizeDuskAddress(`  ${DUSK_TESTNET_ACCOUNT}  `),
    DUSK_TESTNET_ACCOUNT,
  );
  assert.throws(() => normalizeDuskAddress("not-a-dusk-account"));
  assert.throws(() => normalizeDuskAddress("1"));
  // 96 bytes that aren't a BLS12-381 key, and an account with one letter changed.
  assert.throws(() => normalizeDuskAddress("1".repeat(96)), /valid Dusk account/u);
  assert.throws(() => normalizeDuskAddress(`${DUSK_TESTNET_ACCOUNT.slice(0, -1)}d`), /valid Dusk account/u);
});
