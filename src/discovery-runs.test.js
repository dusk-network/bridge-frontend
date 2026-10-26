import assert from "node:assert/strict";
import test from "node:test";

import { createDiscoveryRuns } from "./discovery-runs.js";

function setup() {
  let connected = { dusk: "A", evm: null };
  let clock = 1_000;
  const reads = [];
  const runs = createDiscoveryRuns({
    accounts: () => connected,
    freshMs: 60_000,
    now: () => clock,
    read: (who) =>
      new Promise((resolve) => {
        reads.push({ resolve, who });
      }),
  });
  return {
    connect: (next) => (connected = next),
    reads,
    runs,
    tick: (ms) => (clock += ms),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an account changed while discovery runs is read right after it, and the old run isn't fresh", async () => {
  const { connect, reads, runs } = setup();
  const first = runs.run();
  await settle();
  assert.deepEqual(reads.map(({ who }) => who.dusk), ["A"]);

  // The account changes mid-run: the call for it waits for the running one.
  connect({ dusk: "B", evm: null });
  void runs.run();
  await settle();
  assert.equal(reads.length, 1);

  reads[0].resolve({ errors: [], sources: { dusk: { covered: [[1, 2]] } } });
  await settle();
  // B is read now; A's run left no time or coverage behind.
  assert.deepEqual(reads.map(({ who }) => who.dusk), ["A", "B"]);
  assert.equal(runs.state.running, true);
  assert.deepEqual(runs.state.sources, {});

  reads[1].resolve({ errors: [], sources: { dusk: { covered: [[3, 4]] } } });
  await first;
  assert.equal(runs.state.running, false);
  assert.equal(runs.state.at, 1_000);
  assert.deepEqual(runs.state.sources, { dusk: { covered: [[3, 4]] } });
});

test("a recent run isn't repeated for the same accounts, unless asked for more or expired", async () => {
  const { reads, runs, tick } = setup();
  const done = runs.run();
  await settle();
  reads[0].resolve({ errors: [], sources: {} });
  await done;

  tick(30_000);
  await runs.run();
  assert.equal(reads.length, 1);

  void runs.run({ more: true });
  await settle();
  assert.equal(reads.length, 2);
  reads[1].resolve({ errors: [new Error("down")] });
  await settle();
  assert.equal(runs.state.errors.length, 1);

  runs.expire();
  void runs.run();
  await settle();
  assert.equal(reads.length, 3);
});
