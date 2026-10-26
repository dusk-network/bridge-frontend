import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BUNDLED_DRIVERS } from "./config.js";
import { createDriverLoader, driverJson, toHex } from "./data-driver.js";

const read = (url) => readFile(new URL(`../public${url}`, import.meta.url));

test("bundled data drivers match their reviewed artifacts", async () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BUNDLED_DRIVERS).map(([name, { sha256 }]) => [name, sha256])),
    {
      disputeGameFactory: "dd07f5a584779940bf116fb2ea32f455f8afbe3399c8e1f125f99f98d499afca",
      // Multicall for Dusk v0.1.0 release asset.
      multicall: "d2ed9e7b89d81f12b877f787a7830b90405357c82c9c28f75f0e048530e91462",
      optimismPortal: "9220bf0e96f8d1d20ae8c56459c75d402045bb0fa63851b9413c7db57749b360",
    },
  );
  for (const { sha256, url } of Object.values(BUNDLED_DRIVERS))
    assert.equal(createHash("sha256").update(await read(url)).digest("hex"), sha256);
});

test("a driver is only run when it matches its pinned hash", async () => {
  const fetch = async (url) => new Response(await read(url));
  const load = createDriverLoader({ fetch });
  const portal = BUNDLED_DRIVERS.optimismPortal;

  const driver = await load(portal.url, portal.sha256);
  assert.equal(toHex(driver.encodeInputFn("finalizedWithdrawals", driverJson(Array(32).fill(7)))), "07".repeat(32));
  await assert.rejects(load(portal.url, "00".repeat(32)), /doesn't match its pinned hash/u);
});
