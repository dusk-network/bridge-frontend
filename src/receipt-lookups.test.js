import assert from "node:assert/strict";
import test from "node:test";

import { NOT_FOUND, createReceiptLookups } from "./receipt-lookups.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(answers) {
  const calls = [];
  const timers = [];
  const found = [];
  let open = true;
  const lookups = createReceiptLookups({
    isOpen: () => open,
    onChange: () => {},
    onFound: (result) => found.push(result.routeId),
    resolve: async (hash) => {
      calls.push(hash);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    setTimer: (fn) => timers.push(fn),
  });
  return { calls, close: () => (open = false), found, lookups, timers };
}

test("a receipt nothing knows yet is looked up again while it's open", async () => {
  const { calls, found, lookups, timers } = setup([null, new Error("503"), { hash: "h", routeId: "dusk-to-dusk-evm" }]);
  await lookups.open("h");
  assert.deepEqual(lookups.get("h"), { missing: NOT_FOUND });
  timers.shift()();
  await settle();
  assert.equal(calls.length, 2);
  timers.shift()();
  await settle();
  assert.deepEqual(found, ["dusk-to-dusk-evm"]);
  assert.equal(lookups.get("h"), null);
});

test("a receipt opened again looks again, and a closed one stops trying", async () => {
  const { calls, close, lookups, timers } = setup([{ message: "That Dusk transaction isn't a bridge transfer." }, null, null]);
  await lookups.open("h");
  // A network said what it is: no timer, but opening the page again asks again.
  assert.equal(timers.length, 0);
  assert.equal(lookups.get("h").missing, "That Dusk transaction isn't a bridge transfer.");
  await lookups.open("h");
  assert.equal(calls.length, 2);
  close();
  timers.shift()();
  await settle();
  assert.equal(calls.length, 2);
});

test("a lookup that answers after its receipt closed is dropped", async () => {
  const { close, found, lookups } = setup([{ hash: "h", routeId: "ethereum-to-dusk" }, { hash: "h", routeId: "ethereum-to-dusk" }]);
  const running = lookups.open("h");
  close();
  await running;
  assert.deepEqual(found, []);
  assert.equal(lookups.get("h"), null);
});
