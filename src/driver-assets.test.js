import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtures = [
  [
    "dispute_game_factory_dd_opt.wasm",
    "dd07f5a584779940bf116fb2ea32f455f8afbe3399c8e1f125f99f98d499afca",
  ],
  [
    "optimism_portal_dd_opt.wasm",
    "9220bf0e96f8d1d20ae8c56459c75d402045bb0fa63851b9413c7db57749b360",
  ],
];

test("bundled withdrawal data drivers match their reviewed artifacts", async () => {
  for (const [name, expected] of fixtures) {
    const bytes = await readFile(
      new URL(`../public/drivers/${name}`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  }
});
