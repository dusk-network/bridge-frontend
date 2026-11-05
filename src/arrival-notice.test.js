import assert from "node:assert/strict";
import test from "node:test";

import { NOTICE_WORDS, createArrivalNotice } from "./arrival-notice.js";

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

test.after(() => {
  delete globalThis.document;
  delete globalThis.Notification;
  delete globalThis.focus;
  delete globalThis.localStorage;
});
