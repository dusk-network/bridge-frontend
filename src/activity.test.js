import assert from "node:assert/strict";
import test from "node:test";

import { readActivity, recordActivity, updateActivity } from "./activity.js";

const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

test("activity is resumable, de-duplicated, and updateable", () => {
  const store = storage();
  recordActivity(
    { id: "0x1", routeId: "dusk-evm-to-dusk", status: "submitted" },
    store,
  );
  recordActivity(
    { id: "0x1", routeId: "dusk-evm-to-dusk", status: "waiting" },
    store,
  );
  assert.equal(readActivity(store).length, 1);
  assert.equal(
    updateActivity("0x1", { status: "ready_to_prove" }, store)[0].status,
    "ready_to_prove",
  );
});
