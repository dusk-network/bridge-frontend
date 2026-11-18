import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { networks } from "@dusk-network/networks";

import { loadConfig } from "./config.js";
import { createDriverLoader, driverJson, toHex } from "./data-driver.js";

const read = (url) => readFile(new URL(`../public${url}`, import.meta.url));

// The drivers testnet's DuskEVM contracts use, as its network's file pins them.
globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
const { duskEvm } = loadConfig();
delete globalThis.__DUSK_BRIDGE_CONFIG__;
const BUNDLED = { disputeGameFactory: duskEvm.disputeGameFactoryDriver, optimismPortal: duskEvm.optimismPortalDriver };

test("bundled data drivers match their reviewed artifacts", async () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BUNDLED).map(([name, { sha256 }]) => [name, sha256])),
    {
      disputeGameFactory: "dd07f5a584779940bf116fb2ea32f455f8afbe3399c8e1f125f99f98d499afca",
      optimismPortal: "9220bf0e96f8d1d20ae8c56459c75d402045bb0fa63851b9413c7db57749b360",
    },
  );
  // Each file in public/drivers is the one the network's file pins.
  assert.deepEqual(duskEvm.optimismPortalDriver.sha256, networks.testnet.duskEvm.drivers.optimismPortal.sha256);
  for (const { sha256, url } of Object.values(BUNDLED))
    assert.equal(createHash("sha256").update(await read(url)).digest("hex"), sha256);
});

test("the Hyperlane driver is the one built from hyperlane-dusk at ef912e9, and reads what the routes emit", async () => {
  globalThis.__DUSK_BRIDGE_CONFIG__ = { VITE_BRIDGE_PROFILE: "testnet" };
  const { hyperlane } = loadConfig();
  delete globalThis.__DUSK_BRIDGE_CONFIG__;
  assert.deepEqual(hyperlane.driver, {
    sha256: "bd4f3025efaf38135b1d72297d73f23e83c3ca7ebfdf29ea454d9f83c4c37eef",
    url: "/drivers/hyperlane_dusk_data_driver.wasm",
  });
  const fetch = async (url) => new Response(await read(url));
  const driver = await createDriverLoader({ fetch })(hyperlane.driver.url, hyperlane.driver.sha256);
  // Live transaction 86123720…'s `dispatch_id` event, from the Mailbox: its message ID.
  const id = "ed2cb1330bb4746d16af2e23b0d68272a74c890459bd4702352de0b294d1213b";
  assert.equal(toHex(Uint8Array.from(driver.decodeEvent("dispatch_id", Uint8Array.from(Buffer.from(id, "hex"))).message_id)), id);
  assert.equal(driver.decodeOutputFn("quote_transfer_remote", Uint8Array.from([0x00, 0x53, 0xe3, 0xed, 0x03, 0, 0, 0])), "16876000000");
});

test("a driver is only run when it matches its pinned hash", async () => {
  const fetch = async (url) => new Response(await read(url));
  const load = createDriverLoader({ fetch });
  const portal = BUNDLED.optimismPortal;

  const driver = await load(portal.url, portal.sha256);
  assert.equal(toHex(driver.encodeInputFn("finalizedWithdrawals", driverJson(Array(32).fill(7)))), "07".repeat(32));
  await assert.rejects(load(portal.url, "00".repeat(32)), /doesn't match its pinned hash/u);
});
