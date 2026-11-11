import assert from "node:assert/strict";
import test from "node:test";

import { entryId, minedTransfer } from "./activity.js";
import { NOTICE_WORDS, createArrivalNotice, createEndWatch } from "./arrival-notice.js";

/** A browser: storage, a tab that's looked at or not, and notifications as `permission` and `answer` say. */
function browser({ answer = "granted", permission = "default" } = {}) {
  const stored = new Map();
  const shown = [];
  const asked = [];
  class Notification {
    static permission = permission;
    static async requestPermission() {
      asked.push(1);
      Notification.permission = answer;
      return answer;
    }
    constructor(title, options) {
      shown.push({ options, title });
      this.close = () => shown.push({ closed: title });
      Notification.last = this;
    }
  }
  const page = { hasFocus: () => page.focused, focused: true, title: "Dusk Bridge", visibilityState: "visible" };
  globalThis.document = page;
  globalThis.Notification = Notification;
  globalThis.focus = () => shown.push({ focused: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => stored.get(key) ?? null, removeItem: (key) => stored.delete(key), setItem: (key, value) => stored.set(key, value) } });
  return { Notification, asked, page, shown };
}

const ARRIVED = { href: "#/transfer/ab", id: "bsc-to-dusk:ab", title: "1 DUSK arrived on Dusk" };

test("nothing is asked of the browser until they press for it", () => {
  const { asked, shown } = browser();
  const notice = createArrivalNotice();
  assert.equal(notice.state(), "offer");
  notice.ended(ARRIVED);
  assert.deepEqual(asked, []);
  assert.deepEqual(shown, []);
});

test("once they chose it, a transfer that ends while they're away is a notification, and pressing it opens the receipt", async () => {
  const { Notification, asked, page, shown } = browser();
  const opened = [];
  const notice = createArrivalNotice({ onOpen: (href) => opened.push(href) });
  assert.equal(await notice.choose(), "on");
  assert.equal(asked.length, 1);
  page.focused = false;
  notice.ended(ARRIVED);
  assert.deepEqual(shown, [{ options: { icon: "/dusk-glyph.svg", tag: ARRIVED.id }, title: ARRIVED.title }]);
  Notification.last.onclick();
  assert.deepEqual(opened, [ARRIVED.href]);
  assert.deepEqual(shown.slice(1), [{ focused: true }, { closed: ARRIVED.title }]);
  // It stays chosen on this device, without asking again.
  assert.equal(createArrivalNotice().state(), "on");
});

test("whoever is looking at the page sees it there: no notification, and the title stays", async () => {
  const { page, shown } = browser();
  const notice = createArrivalNotice();
  await notice.choose();
  notice.ended(ARRIVED);
  assert.deepEqual(shown, []);
  assert.equal(page.title, "Dusk Bridge");
});

test("the tab's title says what ended while they're away, chosen or not, until they're back", () => {
  const { page, shown } = browser();
  const notice = createArrivalNotice();
  page.visibilityState = "hidden";
  page.focused = false;
  notice.ended(ARRIVED);
  assert.equal(page.title, "1 DUSK arrived on Dusk · Dusk Bridge");
  notice.ended({ ...ARRIVED, title: "2 DUSK arrived on Dusk" });
  assert.equal(page.title, "2 DUSK arrived on Dusk · Dusk Bridge");
  assert.deepEqual(shown, []);
  // Still away: it stays. Back: it's the tab's own again.
  notice.seen();
  assert.equal(page.title, "2 DUSK arrived on Dusk · Dusk Bridge");
  page.visibilityState = "visible";
  page.focused = true;
  notice.seen();
  assert.equal(page.title, "Dusk Bridge");
});

test("refused, or dismissed: it says the title will tell them, and no notification is tried", async () => {
  for (const answer of ["denied", "default"]) {
    const { page, shown } = browser({ answer });
    const notice = createArrivalNotice();
    assert.equal(await notice.choose(), "refused");
    assert.match(NOTICE_WORDS.refused, /tab's title will say/u);
    page.focused = false;
    notice.ended(ARRIVED);
    assert.deepEqual(shown, []);
    assert.equal(page.title, "1 DUSK arrived on Dusk · Dusk Bridge");
    // Nothing kept: a later visit offers it again.
    assert.equal(createArrivalNotice().state(), "offer");
  }
});

test("a permission taken back in the browser's settings is offered again, and turned off here it stays off", async () => {
  const { Notification, page, shown } = browser();
  const notice = createArrivalNotice();
  await notice.choose();
  Notification.permission = "denied";
  assert.equal(notice.state(), "offer");
  Notification.permission = "granted";
  assert.equal(notice.state(), "on");
  notice.stop();
  assert.equal(notice.state(), "offer");
  page.focused = false;
  notice.ended(ARRIVED);
  assert.deepEqual(shown, []);
});

test("where a page can't notify, the title alone says it, and nothing breaks", async () => {
  const { asked, page, shown } = browser();
  // A phone, or a browser without notifications.
  const phone = createArrivalNotice({ available: () => false });
  assert.equal(phone.state(), "unavailable");
  assert.equal(await phone.choose(), "unavailable");
  assert.deepEqual(asked, []);
  delete globalThis.Notification;
  assert.equal(createArrivalNotice().state(), "unavailable");
  page.focused = false;
  createArrivalNotice().ended(ARRIVED);
  assert.deepEqual(shown, []);
  assert.equal(page.title, "1 DUSK arrived on Dusk · Dusk Bridge");

  // A browser that says yes, then notifies only through a service worker, as Android's.
  const { Notification, page: android } = browser();
  const notice = createArrivalNotice();
  await notice.choose();
  globalThis.Notification = class extends Notification {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  };
  android.focused = false;
  notice.ended(ARRIVED);
  assert.equal(android.title, "1 DUSK arrived on Dusk · Dusk Bridge");
});

// Transfers as the page keeps them: on their way, or ended.
const transfer = (id, status = "pending") => ({ id, routeId: "dusk-to-bsc", status });
const ids = (list) => list.map((entry) => entry.id);

test("opening the page tells of no transfer that had ended before it: Nandini's old arrivals aren't read out", () => {
  // Discovery finds her old transfers and keeps them on their way until a check reads them, as the page did.
  const watch = createEndWatch();
  const found = [transfer("old-1"), transfer("old-2"), transfer("now")];
  assert.deepEqual(watch.ended([], found), []);
  // Their first checks: the two old ones had arrived long ago, one is still on its way.
  const first = [transfer("old-1", "completed"), transfer("old-2", "completed"), transfer("now")];
  assert.deepEqual(watch.ended(found, first), []);
  for (const entry of first) watch.checked(entry);
  // It arrives while the page is open: that one is told.
  const later = [...first.slice(0, 2), transfer("now", "completed")];
  assert.deepEqual(ids(watch.ended(first, later)), ["now"]);
});

test("a transfer sent from the page is told when it ends, even at its first check, and one that failed is told too", () => {
  const watch = createEndWatch();
  watch.sent("mine");
  assert.deepEqual(ids(watch.ended([transfer("mine")], [transfer("mine", "completed")])), ["mine"]);
  // Kept from another visit on its way, and still on its way when this one checked it: its failure is told.
  const kept = [transfer("kept")];
  watch.checked(kept[0]);
  assert.deepEqual(ids(watch.ended(kept, [transfer("kept", "failed")])), ["kept"]);
  // One that ended while the page was closed, read at this visit's first check, isn't.
  assert.deepEqual(watch.ended([transfer("closed")], [transfer("closed", "completed")]), []);
  // Nor is a check that couldn't read it news of its way: nothing was read.
  watch.checked(undefined);
  assert.deepEqual(watch.ended([transfer("unread")], [transfer("unread", "completed")]), []);
});

test("a migration sent from the page and sped up in the wallet, which goes by its mined hash since, is told when it ends", () => {
  const watch = createEndWatch();
  const hash = `0x${"aa".repeat(32)}`;
  const sentId = entryId("bsc-to-dusk", hash);
  watch.sent(sentId);
  const kept = [{ hash, id: sentId, routeId: "bsc-to-dusk", sentHere: true, status: "pending" }];
  // The wallet mined it repriced, as another transaction: the transfer now goes by that one.
  const next = minedTransfer(kept, { hash, mined: `0x${"bb".repeat(32)}`, replaced: "repriced", routeId: "bsc-to-dusk" });
  watch.moved(sentId, next.id);
  assert.deepEqual(watch.ended(kept, next.items), []);
  // Its first check finds it arrived: told.
  assert.deepEqual(ids(watch.ended(next.items, [{ ...next.items[0], status: "completed" }])), [next.id]);
  // Moved from what was never on its way, nothing is.
  watch.moved("unseen", "elsewhere");
  assert.deepEqual(watch.ended([transfer("elsewhere")], [transfer("elsewhere", "completed")]), []);
});

test.after(() => {
  delete globalThis.document;
  delete globalThis.Notification;
  delete globalThis.focus;
  delete globalThis.localStorage;
});
