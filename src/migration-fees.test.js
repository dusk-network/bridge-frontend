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

test("an approval a read left unread is read again while its logs may still come, and not once they're gone", async () => {
  // The RPC left the logs out: the migration's own gas, its approval unread.
  const unread = (at) => ({ approval: null, approvalState: "unread", at, gasWei: 47_005_000_752_080n, state: "mined", totalWei: 47_005_000_752_080n });
  const migration = { hash: hash("0d"), id: "m", routeId: ROUTE.id, status: "completed" };
  const answers = { [migration.hash]: [] };
  const { fees, page, reads, timers } = setup(answers);
  page.now = Date.parse("2026-11-06T15:00:00Z");
  answers[migration.hash].push(unread(page.now - 60_000), mined());
  page.open = migration.hash;
  fees.fact(migration, ROUTE);
  await settle();
  // Drawn with the migration's gas alone; read again once it's due.
  assert.equal(fees.fact(migration, ROUTE).approvalState, "unread");
  assert.deepEqual(timers.map((timer) => timer.ms), [15_000]);
  page.now += 15_000;
  timers.shift().fn();
  fees.fact(migration, ROUTE);
  await settle();
  assert.deepEqual([reads.length, fees.fact(migration, ROUTE).totalWei], [2, 93_199_001_491_184n]);

  // Ten days on, the logs are gone for good: not read again.
  const old = { hash: hash("0e"), id: "o", routeId: ROUTE.id, status: "completed" };
  answers[old.hash] = [unread(page.now - 10 * 24 * 60 * 60_000)];
  page.open = old.hash;
  fees.fact(old, ROUTE);
  await settle();
  fees.fact(old, ROUTE);
  page.now += 60_000;
  fees.fact(old, ROUTE);
  assert.deepEqual([reads.length, timers.length], [3, 0]);
});

test("a read that lands, or comes due, draws again the receipt that needs it now, also a cancelled transfer's that depends on it", async () => {
  const APPROVAL = hash("a7");
  const SENDER = "0x90Fe863078ffD0371d62e648A601345aF8CF2CbE";
  const sent = Date.parse("2026-11-06T14:15:00Z");
  const finish = { hash: hash("f1"), id: "f", routeId: ROUTE.id, sender: SENDER, sourceAt: sent + 60_000, status: "completed" };
  const cancelled = { approvalHash: APPROVAL, createdAt: new Date(sent).toISOString(), hash: hash("c0"), id: "c", replaced: "cancelled", routeId: ROUTE.id, sender: SENDER, status: "failed" };
  const others = [cancelled, finish];
  const { changes, fees, page, timers } = setup({ [finish.hash]: [new Error("bsc-rpc didn't answer"), mined(APPROVAL)] });
  // The Finish's receipt: its read fails; drawn again, it waits to read again.
  page.open = finish.hash;
  fees.fact(finish, ROUTE);
  await settle();
  fees.fact(finish, ROUTE);
  assert.equal(timers.length, 1);
  // The cancelled transfer's receipt, opened meanwhile, depends on that read: when it's due, that one's drawn again.
  page.open = cancelled.hash;
  assert.equal(fees.spentBy(cancelled, ROUTE, others), null);
  assert.equal(timers.length, 1);
  page.now += 15_000;
  timers.shift().fn();
  assert.deepEqual(changes, [finish.hash, cancelled.hash]);
  // Drawn again: read, and as it lands, drawn again with the Finish counting the approval.
  assert.equal(fees.spentBy(cancelled, ROUTE, others), null);
  await settle();
  assert.deepEqual(changes, [finish.hash, cancelled.hash, cancelled.hash]);
  assert.equal(fees.spentBy(cancelled, ROUTE, others), finish.hash);

  // A read running for one receipt, needed by another opened before it lands: that one's drawn as it does.
  const running = setup({ [finish.hash]: [mined(APPROVAL)] });
  running.page.open = finish.hash;
  running.fees.fact(finish, ROUTE);
  running.page.open = cancelled.hash;
  running.fees.spentBy(cancelled, ROUTE, others);
  await settle();
  assert.deepEqual(running.changes, [cancelled.hash]);
  assert.equal(running.fees.spentBy(cancelled, ROUTE, others), finish.hash);
});
