import assert from "node:assert/strict";
import test from "node:test";

import { showCopied } from "./copied.js";
import { icon } from "./icons.js";
import { activityPanel, copyButton, copyFaces, receiptPage, reviewSheet } from "./views.js";

// A button as the page has it: its attributes, nothing more.
function button(attrs = {}) {
  const map = new Map(Object.entries(attrs));
  return {
    getAttribute: (name) => map.get(name) ?? null,
    hasAttribute: (name) => map.has(name),
    removeAttribute: (name) => map.delete(name),
    setAttribute: (name, value) => map.set(name, String(value)),
  };
}

// Timers the test runs by hand.
function clock() {
  const due = new Map();
  let next = 0;
  return {
    setTimer: (fn, ms) => (due.set(++next, { fn, ms }), next),
    clearTimer: (id) => due.delete(id),
    pending: () => [...due.values()].map((timer) => timer.ms),
    run: () => {
      const timers = [...due.values()];
      due.clear();
      for (const timer of timers) timer.fn();
    },
  };
}

test("Copy says Copied on its own button for 1.5 s, heard once, then says Copy again", () => {
  const timers = clock();
  const said = [];
  const copy = button({ "aria-label": "Copy the receipt link" });
  const press = () => showCopied(copy, { announce: (text) => said.push(text), ...timers });

  press();
  assert.deepEqual([copy.hasAttribute("data-copied"), copy.getAttribute("aria-label"), said], [true, "Copied", ["Copied"]]);
  assert.deepEqual(timers.pending(), [1_500]);

  // Pressed again meanwhile: the 1.5 s start over, and its own name comes back after.
  press();
  assert.deepEqual(timers.pending(), [1_500]);
  timers.run();
  assert.deepEqual([copy.hasAttribute("data-copied"), copy.getAttribute("aria-label")], [false, "Copy the receipt link"]);
});

test("a Copy button shows its icon or its words, and a check or Copied once it copied", () => {
  const faces = (markup) => [...markup.matchAll(/<span class="copy-swap__(from|to)">(.*?)<\/span>(?=<span class="copy-swap__to">|<\/span>)/gu)].map((m) => m[2]);
  const iconButton = copyButton("0xabc", "the receipt link");
  assert.match(iconButton, /^<button type="button" class="icon-btn" data-copy="0xabc" aria-label="Copy the receipt link" title="Copy"><span class="copy-swap" aria-hidden="true">/u);
  assert.deepEqual(faces(iconButton), [icon("copy"), icon("check")]);
  assert.deepEqual(faces(copyFaces("Copy link", "Copied")), ["Copy link", "Copied"]);
});

test("a wait shows a turning ring beside its words from the first draw", () => {
  const ring = /<span class="waiting"><span class="spin" aria-hidden="true"><\/span><span>(.*?)<\/span><\/span>/u;
  // A receipt being found.
  assert.equal(ring.exec(receiptPage({ loading: "Looking up this transfer…" }))?.[1], "Looking up this transfer…");
  // A wallet request being prepared, before Confirm.
  const sheet = reviewSheet({
    canConfirm: false, checks: [], confirmLabel: "Send 2 DUSK", feeRows: [], privacy: "x",
    receive: { amount: "2", chain: "dusk-evm", unit: "DUSK", where: "DuskEVM" }, send: { amount: "2", chain: "dusk", unit: "DUSK", where: "Dusk" },
    steps: [{ current: true, ready: false, title: "Send from Dusk", wait: "Preparing…", walletName: "Dusk Wallet" }], sub: "",
  });
  assert.equal(ring.exec(sheet)?.[1], "Preparing…");
  // Activity reading the networks; its words alone once it's done.
  const activity = (syncing, syncText) => activityPanel({ empty: "Looking for transfers…", groups: {}, lede: "x", more: false, syncing, syncText });
  assert.equal(ring.exec(activity(true, "Reading the networks…"))?.[1], "Reading the networks…");
  assert.doesNotMatch(activity(false, "Some networks didn't answer. It tries again on your next visit."), /class="spin"/u);
});
