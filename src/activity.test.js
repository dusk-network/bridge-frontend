import assert from "node:assert/strict";
import test from "node:test";

import { entryId, readActivity, recordActivity, saveActivity, updateActivity, useActivityNetwork } from "./activity.js";

const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

const HASH = `0x${"ab".repeat(32)}`;

test("an entry is its route and hash; recording it again merges", () => {
  const store = storage();
  recordActivity({ hash: HASH.toUpperCase().replace("0X", "0x"), routeId: "dusk-evm-to-dusk" }, store);
  recordActivity({ amountLux: "5", hash: HASH, routeId: "dusk-evm-to-dusk" }, store);

  const [entry] = readActivity(store);
  assert.equal(readActivity(store).length, 1);
  assert.equal(entry.id, entryId("dusk-evm-to-dusk", HASH));
  assert.equal(entry.status, "pending");
  assert.equal(entry.amountLux, "5");

  updateActivity(entry.id, { stage: "ready_to_prove" }, store);
  assert.equal(readActivity(store).find((item) => item.id === entry.id).stage, "ready_to_prove");
});

test("the same hash on two routes is two entries", () => {
  const store = storage();
  recordActivity({ hash: HASH, routeId: "a" }, store);
  recordActivity({ hash: HASH, routeId: "b" }, store);
  assert.equal(readActivity(store).length, 2);
});

test("entries from the first version are kept, to be rebuilt from their hash", () => {
  const store = storage({
    "dusk-bridge:activity:v1": JSON.stringify([
      { amount: "0.1", id: "ceb48ee5".padEnd(64, "0"), routeId: "dusk-to-dusk-evm", status: "submitted", transactionHash: "ceb48ee5".padEnd(64, "0") },
      { id: "broken", routeId: "x" },
    ]),
  });
  const [entry, ...rest] = readActivity(store);

  assert.equal(rest.length, 0);
  assert.equal(entry.hash, "ceb48ee5".padEnd(64, "0"));
  assert.equal(entry.status, "pending");
  assert.equal(entry.amount, "0.1");
});

test("an entry stays for this visit when the browser refuses to store it", () => {
  let refuse = true;
  const values = new Map();
  const full = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      if (refuse) throw new DOMException("QuotaExceededError");
      values.set(key, value);
    },
  };
  recordActivity({ hash: HASH, routeId: "dusk-to-dusk-evm" }, full);
  const id = entryId("dusk-to-dusk-evm", HASH);
  assert.deepEqual(readActivity(full).map((item) => item.id), [id]);
  updateActivity(id, { status: "completed" }, full);
  assert.equal(readActivity(full).find((item) => item.id === id).status, "completed");

  // Once the browser stores again, the list is stored with it.
  refuse = false;
  recordActivity({ hash: `0x${"cd".repeat(32)}`, routeId: "dusk-to-dusk-evm" }, full);
  assert.equal(JSON.parse(values.get("dusk-bridge:activity:v2")).length, 2);
});

test("a full list keeps the newest transfers, not the first ones it was given", () => {
  const store = storage();
  const old = Array.from({ length: 200 }, (_, index) => ({
    hash: index.toString(16).padStart(64, "0"),
    id: `dusk-to-dusk-evm:${index}`,
    routeId: "dusk-to-dusk-evm",
    sourceAt: 1_000_000 + index,
  }));
  saveActivity(old, store);
  // Discovery appends what it finds after what's kept.
  const found = { hash: "f".repeat(64), id: "dusk-to-dusk-evm:found", routeId: "dusk-to-dusk-evm", sourceAt: 9_000_000 };
  const kept = saveActivity([...readActivity(store), found], store);
  assert.equal(kept.length, 200);
  assert.equal(kept[0].id, "dusk-to-dusk-evm:found");
  assert.ok(!kept.some((item) => item.sourceAt === 1_000_000), "the oldest goes");
  assert.deepEqual(readActivity(store).map((item) => item.id), kept.map((item) => item.id));
});

test("each network keeps its own transfers, on a site that served the other too", () => {
  const store = storage();
  try {
    useActivityNetwork("mainnet");
    recordActivity({ hash: HASH, routeId: "ethereum-to-dusk" }, store);
    useActivityNetwork("testnet");
    assert.deepEqual(readActivity(store), []);
    recordActivity({ hash: `0x${"cd".repeat(32)}`, routeId: "ethereum-to-dusk" }, store);
    useActivityNetwork("mainnet");
    assert.deepEqual(readActivity(store).map((item) => item.hash), [HASH]);

    // The list from before goes to the first network that opens, and only to it.
    const before = storage({ "dusk-bridge:activity:v2": JSON.stringify([{ hash: HASH, id: entryId("ethereum-to-dusk", HASH), routeId: "ethereum-to-dusk" }]) });
    useActivityNetwork("testnet");
    assert.equal(readActivity(before).length, 1);
    useActivityNetwork("mainnet");
    assert.equal(readActivity(before).length, 0);
  } finally {
    useActivityNetwork("");
  }
});

test("the first version's list goes to the first network that opens, and only to it", () => {
  const legacy = [{ amount: "0.1", id: "ce".repeat(32), routeId: "ethereum-to-dusk", status: "submitted", transactionHash: "ce".repeat(32) }];
  try {
    const store = storage({ "dusk-bridge:activity:v1": JSON.stringify(legacy) });
    useActivityNetwork("testnet");
    assert.deepEqual(readActivity(store).map((item) => item.hash), ["ce".repeat(32)]);
    assert.equal(store.getItem("dusk-bridge:activity:v1"), null);
    useActivityNetwork("mainnet");
    assert.deepEqual(readActivity(store), []);
    useActivityNetwork("testnet");
    assert.equal(readActivity(store).length, 1);

    // A version-2 list with the first one still beside it: both go to the network that takes it.
    const both = storage({
      "dusk-bridge:activity:v1": JSON.stringify(legacy),
      "dusk-bridge:activity:v2": JSON.stringify([{ hash: HASH, id: entryId("ethereum-to-dusk", HASH), routeId: "ethereum-to-dusk" }]),
    });
    useActivityNetwork("mainnet");
    assert.deepEqual(readActivity(both).map((item) => item.hash), [HASH]);
    useActivityNetwork("testnet");
    assert.deepEqual(readActivity(both), []);
  } finally {
    useActivityNetwork("");
  }
});
