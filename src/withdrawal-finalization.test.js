import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGameSearchDepth,
  proofRequiresReplacement,
} from "./withdrawal-finalization.js";

test("withdrawal proof search uses a bounded positive depth", () => {
  assert.equal(parseGameSearchDepth("128"), 128n);
  assert.equal(parseGameSearchDepth("0"), 64n);
  assert.equal(parseGameSearchDepth("not-a-number"), 64n);
});

test("blacklisted or challenger-winning proofs require replacement", () => {
  assert.equal(
    proofRequiresReplacement({ gameStatus: 0, isGameBlacklisted: false }),
    false,
  );
  assert.equal(
    proofRequiresReplacement({ gameStatus: 1, isGameBlacklisted: false }),
    true,
  );
  assert.equal(
    proofRequiresReplacement({ gameStatus: 2, isGameBlacklisted: true }),
    true,
  );
});
