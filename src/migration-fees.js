// What each migration paid on its own chain, with the approval it spent
// (tracking.js's migrationEvm, app-core's migrationFacts), for the receipts
// that show it: read as a receipt shows it, and again as its transfer moves
// on. Where the chain couldn't say, it's read again once 15 seconds have
// passed, while a receipt that needs it shows, however that receipt was left
// and opened again meanwhile, and whichever receipt needs it: its own, or a
// cancelled transfer's whose approval it may have spent. One read at a time
// per migration.

/** Read again after a read the chain didn't settle, while a receipt needs it. */
export const AGAIN_MS = 15_000;

/** A migration older than a cancelled one by this much, on the clocks of the chain and the browser, can't have spent its approval. */
const CLOCKS_MS = 60 * 60_000;

/**
 * How long the public RPCs give a block's logs, about: BSC's some four days.
 * An approval a migration's read left unread (its logs left out) may come
 * with a read again until then; after, it won't.
 */
const LOGS_MS = 4 * 24 * 60 * 60_000;

/** Whether the approval a migration spent was left unread while its logs may still be given, at `at`. */
const unreadYet = (fact, at) => fact.approvalState === "unread" && !(fact.at && at - fact.at > LOGS_MS);

/**
 * What the chain didn't settle at `at`: nothing read, not mined yet,
 * unreadable, its approval left unread while its logs may still be given, or
 * the approval's receipt unread.
 */
export const unsettled = (fact, at = Date.now()) =>
  !fact || fact.state === "error" || fact.state === "pending" || unreadYet(fact, at) || (fact.approvalState === "found" && typeof fact.approval?.gasWei !== "bigint");

/**
 * @param {object} options
 * @param {(entry: object, route: object) => Promise<object|null>} options.read what a migration paid on its chain (tracking.js's migrationEvm)
 * @param {(hash: string) => boolean} options.isOpen whether the receipt of `hash` is on screen
 * @param {(hash: string) => void} options.onChange what the receipt of `hash` shows changed
 * @param {number} [options.againMs]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 */
export function createMigrationFees({ isOpen, onChange, read, againMs = AGAIN_MS, now = Date.now, setTimer = setTimeout }) {
  const facts = new Map();
  // By migration, the receipts its read, running or due, is for: each of
  // them that's open is drawn again as it lands, or once it's due.
  const waiting = new Map();
  const timers = new Set();

  const waitFor = (key, on) => waiting.set(key, new Set([...(waiting.get(key) ?? []), on]));
  function tell(key) {
    const receipts = waiting.get(key) ?? new Set();
    waiting.delete(key);
    for (const on of receipts) if (isOpen(on)) onChange(on);
  }

  /**
   * What `entry`, a migration, paid on its chain, as read so far (null
   * before), for the receipt of `on`: read where it's due, and, where the
   * chain didn't settle it, again once that's due while that receipt shows.
   */
  function fact(entry, route, on = entry.hash) {
    if (route?.mode !== "migration" || entry.replaced || !entry.hash) return null;
    const key = String(entry.hash).toLowerCase();
    const asked = [key, entry.status ?? "", entry.sourceAt ?? ""].join(":");
    const known = facts.get(key);
    if (known?.reading) {
      waitFor(key, on);
      return known.fact;
    }
    const wait = known && unsettled(known.fact, now()) ? known.at + againMs - now() : Infinity;
    if (!known || known.asked !== asked || wait <= 0) {
      waitFor(key, on);
      facts.set(key, { asked, at: now(), fact: known?.fact ?? null, reading: true });
      void Promise.resolve()
        .then(() => read(entry, route))
        .catch(() => null)
        .then((answer) => {
          facts.set(key, { asked, at: now(), fact: answer ?? known?.fact ?? null, reading: false });
          tell(key);
        });
    } else if (wait !== Infinity) {
      // Read moments ago, for this receipt or another: asked again once it's due, for each receipt that needs it then.
      waitFor(key, on);
      if (!timers.has(key)) {
        timers.add(key);
        setTimer(() => {
          timers.delete(key);
          tell(key);
        }, wait);
      }
    }
    return known?.fact ?? null;
  }

  /**
   * Of a migration the wallet cancelled or replaced, for which this browser
   * sent an approval: the migration among `others` that spent that approval,
   * as its chain says, whose fee counts it; false where none of them did;
   * null while one that could have isn't read yet. Only the same sender's
   * migrations on the route, none older than the cancelled one, could have.
   */
  function spentBy(entry, route, others, on = entry.hash) {
    const approval = String(entry.approvalHash ?? "").toLowerCase();
    if (!entry.replaced || !approval) return false;
    const sender = String(entry.sender ?? "").toLowerCase();
    const sent = Date.parse(entry.createdAt ?? "") || 0;
    let unknown = false;
    for (const other of others) {
      if (other.id === entry.id || other.routeId !== entry.routeId || other.replaced) continue;
      if (sender && other.sender && String(other.sender).toLowerCase() !== sender) continue;
      if (sent && other.sourceAt && other.sourceAt < sent - CLOCKS_MS) continue;
      const read = fact(other, route, on);
      if (read?.approval?.hash === approval) return other.hash;
      // Which approval it spent is known once it's mined and read, its approval too while its logs may come.
      if (!read || read.state === "error" || read.state === "pending" || unreadYet(read, now())) unknown = true;
    }
    return unknown ? null : false;
  }

  return Object.freeze({ fact, spentBy });
}
