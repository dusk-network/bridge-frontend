import assert from "node:assert/strict";
import test from "node:test";

import { createMigrationFees } from "./migration-fees.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ROUTE = { from: { id: "bsc", kind: "evm" }, id: "bsc-to-dusk", mode: "migration", to: { id: "dusk", kind: "dusk" } };
const hash = (byte) => `0x${byte.repeat(32)}`;
const mined = (approval = hash("a7")) => ({ approval: { at: 1, block: 100, gasWei: 46_194_000_739_104n, hash: approval }, approvalState: "found", gasWei: 47_005_000_752_080n, state: "mined", totalWei: 93_199_001_491_184n });

/** The fees as a page has them: `answers` by hash, in turn; the receipt open is `open`; timers wait for `fire`. */
function setup(answers) {
  const reads = [];
  const timers = [];
  const changes = [];
  const page = { now: 1_000_000, open: null };
  const fees = createMigrationFees({
    isOpen: (on) => page.open === on,
    now: () => page.now,
    onChange: (on) => changes.push(on),
    read: async (entry) => {
      reads.push(entry.hash);
      const answer = answers[entry.hash]?.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { changes, fees, page, reads, timers };
}

test("a fee the chain couldn't read is read again while its receipt shows, also when that receipt was left and opened again before it was due", async () => {
  const migration = { hash: hash("0d"), id: "m", routeId: ROUTE.id, status: "completed" };
  const { changes, fees, page, reads, timers } = setup({ [migration.hash]: [new Error("bsc-rpc didn't answer"), mined()] });
  // Opened: read; left before the chain answered, which it didn't.
  page.open = migration.hash;
  assert.equal(fees.fact(migration, ROUTE), null);
  page.open = null;
  await settle();
  assert.deepEqual([reads.length, changes.length, timers.length], [1, 0, 0]);
  // Opened again 5 s on: not read at once, but once it's due, while it shows.
  page.now += 5_000;
  page.open = migration.hash;
  assert.equal(fees.fact(migration, ROUTE), null);
  fees.fact(migration, ROUTE);
  assert.deepEqual([reads.length, timers.map((timer) => timer.ms)], [1, [10_000]]);
  page.now += 10_000;
  timers.shift().fn();
  assert.deepEqual(changes, [migration.hash]);
  // The page draws it again: due, read, and the fee comes.
  fees.fact(migration, ROUTE);
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(fees.fact(migration, ROUTE).totalWei, 93_199_001_491_184n);
  // Settled, it isn't read again, nor waited for.
  page.now += 60_000;
  fees.fact(migration, ROUTE);
  assert.deepEqual([reads.length, timers.length], [2, 0]);

  // Left for good meanwhile: the wait ends quietly; opened later, it's read at once.
  const other = { hash: hash("0e"), id: "o", routeId: ROUTE.id, status: "completed" };
  const later = setup({ [other.hash]: [{ state: "error" }, mined()] });
  later.page.open = other.hash;
  later.fees.fact(other, ROUTE);
  await settle();
  later.fees.fact(other, ROUTE);
  later.page.open = null;
  later.timers.shift().fn();
  assert.deepEqual([later.reads.length, later.changes.length], [1, 1]);
  later.page.now += 20_000;
  later.page.open = other.hash;
  later.fees.fact(other, ROUTE);
  await settle();
  assert.equal(later.fees.fact(other, ROUTE).state, "mined");
});

test("a cancelled migration's approval is counted by the migration that spent it since, as its chain says", async () => {
  const APPROVAL = hash("a7");
  const SENDER = "0x90Fe863078ffD0371d62e648A601345aF8CF2CbE";
  const sent = Date.parse("2026-11-06T14:15:00Z");
  const cancelled = { approvalHash: APPROVAL, createdAt: new Date(sent).toISOString(), hash: hash("c0"), id: "c", replaced: "cancelled", routeId: ROUTE.id, sender: SENDER, status: "failed" };
  // Its Finish, a minute on, from the same address; one from another address; one from an hour and more before; one on another route.
  const finish = { hash: hash("f1"), id: "f", routeId: ROUTE.id, sender: SENDER.toLowerCase(), sourceAt: sent + 60_000, status: "completed" };
  const elsewhere = { hash: hash("e1"), id: "e", routeId: ROUTE.id, sender: "0x2276EcF15912B8306eA731028349F85E79F0136d", sourceAt: sent + 60_000, status: "completed" };
  const before = { hash: hash("b1"), id: "b", routeId: ROUTE.id, sender: SENDER, sourceAt: sent - 2 * 60 * 60_000, status: "completed" };
  const route = { hash: hash("d1"), id: "d", routeId: "ethereum-to-dusk", sender: SENDER, sourceAt: sent + 60_000, status: "completed" };
  const { fees, page, reads } = setup({ [finish.hash]: [mined(APPROVAL)] });
  page.open = cancelled.hash;
  const others = [cancelled, finish, elsewhere, before, route];
  // While the Finish is read: not known yet.
  assert.equal(fees.spentBy(cancelled, ROUTE, others), null);
  await settle();
  assert.equal(fees.spentBy(cancelled, ROUTE, others), finish.hash);
  // Only the one that could have spent it was read.
  assert.deepEqual(reads, [finish.hash]);

  // A Finish that spent a newer approval: the cancelled one's was never spent, and it keeps its fee.
  const newer = setup({ [finish.hash]: [mined(hash("a8"))] });
  newer.fees.spentBy(cancelled, ROUTE, others);
  await settle();
  assert.equal(newer.fees.spentBy(cancelled, ROUTE, others), false);
  // Nothing sent since, or no approval sent for it: nothing to read.
  const none = setup({});
  assert.equal(none.fees.spentBy(cancelled, ROUTE, [cancelled, before]), false);
  assert.equal(none.fees.spentBy({ ...cancelled, approvalHash: undefined }, ROUTE, others), false);
  assert.deepEqual(none.reads, []);
});
