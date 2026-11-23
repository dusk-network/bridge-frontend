import assert from "node:assert/strict";
import test from "node:test";

import { fitAmounts } from "./fit.js";

/**
 * A number in a box, as a browser lays them out, with each character 0.6 of
 * its font size wide: `text` at `size` px, in a box `width` px wide. Where it
 * may break at its groups, it's never wider than its box.
 */
function numberIn({ size, text, width }) {
  const box = { clientWidth: width, computed: () => ({ display: "block", fontSize: "13.5px", paddingLeft: "0px", paddingRight: "0px" }), parentElement: null };
  const classes = new Set(["nb"]);
  const attributes = new Map([["class", "nb"]]);
  const inline = new Map();
  let nodes = [{ text }];
  const el = {
    classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name), remove: (name) => classes.delete(name) },
    closest: (selector) => (selector === ".note" ? box : null),
    computed: () => ({ display: "inline", fontSize: inline.get("font-size") ?? `${size}px` }),
    dataset: { fit: ".note" },
    getAttribute: (name) => (name === "style" ? (attributes.has("style") ? [...inline].map(([key, value]) => `${key}: ${value};`).join(" ") : null) : attributes.get(name) ?? null),
    getBoundingClientRect: () => {
      const wide = el.textContent.length * 0.6 * Number.parseFloat(el.computed().fontSize);
      return { width: classes.has("groups") ? Math.min(wide, box.clientWidth) : wide };
    },
    get nodes() {
      return nodes;
    },
    ownerDocument: { createElement: (tag) => ({ tag }), createTextNode: (value) => ({ text: value }) },
    parentElement: box,
    removeAttribute: (name) => attributes.delete(name),
    replaceChildren: (...children) => {
      nodes = children;
    },
    style: {
      removeProperty: (key) => inline.delete(key),
      set fontSize(value) {
        inline.set("font-size", value);
        attributes.set("style", "");
      },
    },
    get textContent() {
      return nodes.map((node) => node.text ?? "").join("");
    },
    set textContent(value) {
      nodes = [{ text: value }];
    },
  };
  box.children = [el];
  return { box, classes, el };
}

/** Fits the number in its box, as the page does after drawing it. */
function fit(number) {
  globalThis.getComputedStyle = (node) => node.computed();
  try {
    fitAmounts({ querySelectorAll: (selector) => (selector === "[data-fit]" ? [number.el] : []) });
  } finally {
    delete globalThis.getComputedStyle;
  }
}

const size = (number) => Number.parseFloat(number.el.computed().fontSize);
/** Where its lines may end: after what, each. */
const breaks = (number) => number.el.nodes.flatMap((node, at, all) => (node.tag === "wbr" ? [all[at - 1].text.at(-1)] : []));

// An approval of 10^76 wei: 10^58 DUSK, 59 digits in 20 groups.
const APPROVAL = `10,${Array.from({ length: 19 }, () => "000").join(",")}`;

test("an amount that fits is drawn as it is; one a little too wide, smaller, on one line", () => {
  const fits = numberIn({ size: 13.5, text: "99,999,999.123456789", width: 250 });
  fit(fits);
  assert.equal(size(fits), 13.5);
  assert.equal(fits.classes.has("groups"), false);

  const wide = numberIn({ size: 13.5, text: "99,999,999,999,999,999,999.1234", width: 250 });
  fit(wide);
  assert.ok(size(wide) < 13.5 && size(wide) >= 12, String(size(wide)));
  assert.ok(wide.el.getBoundingClientRect().width <= 250);
  assert.deepEqual([wide.classes.has("groups"), breaks(wide)], [false, []]);
});

test("an amount is never drawn smaller than it can be read: past that, it breaks only after its group separators", () => {
  const approval = numberIn({ size: 13.5, text: APPROVAL, width: 250 });
  fit(approval);
  assert.equal(size(approval), 12);
  assert.equal(approval.classes.has("groups"), true);
  assert.deepEqual(breaks(approval), Array(19).fill(","));
  assert.equal(approval.el.textContent, APPROVAL);
  assert.ok(approval.el.getBoundingClientRect().width <= 250);

  // Its decimal point, and a French narrow space, are told apart from its groups.
  const french = numberIn({ size: 13.5, text: `${APPROVAL.replaceAll(",", "\u202f")},5`, width: 250 });
  fit(french);
  assert.deepEqual(breaks(french), Array(19).fill("\u202f"));

  // Drawn again with room for it: on one line at its own size, one text, and nothing of the last fit left on it.
  approval.box.clientWidth = 1000;
  fit(approval);
  assert.equal(size(approval), 13.5);
  assert.deepEqual([approval.classes.has("groups"), breaks(approval), approval.el.nodes.length], [false, [], 1]);
  assert.equal(approval.el.getAttribute("style"), null);

  // Already smaller than that: it isn't drawn larger, and breaks at its groups where it must.
  const small = numberIn({ size: 11, text: APPROVAL, width: 250 });
  fit(small);
  assert.deepEqual([size(small), small.classes.has("groups")], [11, true]);

  // With no groups to break at, it can't wrap: it's drawn as small as it needs instead.
  const bare = numberIn({ size: 13.5, text: "1".repeat(78), width: 250 });
  fit(bare);
  assert.ok(size(bare) < 12 && bare.el.getBoundingClientRect().width <= 250, String(size(bare)));
  assert.equal(bare.classes.has("groups"), false);
});
