// How a page reads to the person checking it, for the tests: what each field
// shows under its label, what clicking its Copy button puts on the clipboard,
// where its links go, and the amounts it says, with their sign and bound kept.

import assert from "node:assert/strict";

const ENTITIES = { "&#039;": "'", "&amp;": "&", "&gt;": ">", "&lt;": "<", "&quot;": '"' };
/** An attribute's value as the browser reads it. */
export const decode = (text) => String(text).replace(/&(?:#039|amp|gt|lt|quot);/gu, (entity) => ENTITIES[entity]);
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * A fragment of a page as its elements: each one's tag, its attributes as the
 * browser reads them, its parent and children, and where it opens, where its
 * inside starts and ends, and where it closes in the fragment.
 */
function parse(fragment) {
  const source = String(fragment ?? "");
  const root = { attrs: {}, children: [], close: source.length, end: source.length, open: 0, parent: null, source, start: 0, tag: "#root" };
  let open = root;
  for (const match of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>/gu)) {
    const [whole, closing, name, rawAttrs, selfClosing] = match;
    const tag = name.toLowerCase();
    if (closing) {
      let node = open;
      while (node !== root && node.tag !== tag) node = node.parent;
      if (node === root) continue;
      for (let each = open; each !== node.parent; each = each.parent) Object.assign(each, { close: match.index + whole.length, end: match.index });
      open = node.parent;
      continue;
    }
    const attrs = Object.fromEntries([...rawAttrs.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/gu)].map(([, key, value]) => [key.toLowerCase(), decode(value ?? "")]));
    const start = match.index + whole.length;
    const node = { attrs, children: [], close: source.length, end: source.length, open: match.index, parent: open, source, start, tag };
    open.children.push(node);
    if (selfClosing || VOID.has(tag)) Object.assign(node, { close: start, end: start });
    else open = node;
  }
  return root;
}

const all = (node) => [node, ...node.children.flatMap(all)];
const inner = (node) => node.source.slice(node.start, node.end);
const classes = (node) => String(node.attrs.class ?? "").split(/\s+/u).filter(Boolean);
// Hidden from a reader by itself: hidden, only for a screen reader, or not displayed.
const hidden = (node) =>
  "hidden" in node.attrs || classes(node).some((name) => name === "sr-only" || name === "visually-hidden") || /\bdisplay\s*:\s*none\b/u.test(node.attrs.style ?? "");
// Whether `node` shows: nothing hides it or anything around it, and it isn't folded in a closed Details (its summary aside).
function shows(node) {
  for (let each = node, child = null; each; child = each, each = each.parent) {
    if (hidden(each)) return false;
    if (each.tag === "details" && !("open" in each.attrs) && child && child.tag !== "summary") return false;
  }
  return true;
}

// The text a node shows, piece by piece: no tags, icons, or anything hidden or folded away.
function visibleText(node, pieces) {
  let at = node.start;
  for (const child of node.children) {
    pieces.push(node.source.slice(at, child.open));
    at = child.close;
    if (child.tag === "svg" || hidden(child)) continue;
    if (child.tag === "details" && !("open" in child.attrs)) {
      const summary = child.children.find((each) => each.tag === "summary");
      if (summary) visibleText(summary, pieces);
      continue;
    }
    visibleText(child, pieces);
  }
  pieces.push(node.source.slice(at, node.end));
  return pieces;
}

/** The text a fragment of a page shows: no tags, attributes or icons, and nothing hidden, only for a screen reader, or folded away. */
export const textOf = (fragment) =>
  decode(visibleText(parse(fragment), []).join(" "))
    .replace(/\s+/gu, " ")
    .trim();

// What a click on `button` puts on the clipboard, as the page's click handler
// does it: the nearest element up from it with a data-copy, read through its dataset.
function clicked(button) {
  for (let each = button; each && each.tag !== "#root"; each = each.parent) if ("data-copy" in each.attrs) return each.attrs["data-copy"];
  return null;
}
const copiesIn = (nodes) =>
  nodes
    .flatMap(all)
    .filter((node) => node.tag === "button" && shows(node))
    .map(clicked)
    .filter((value) => value !== null);

/** What clicking each button a fragment shows puts on the clipboard, for those that copy anything. */
export const copiesOf = (fragment) => copiesIn([parse(fragment)]);

/** Where each link a fragment shows goes. */
export const linksOf = (fragment) =>
  all(parse(fragment))
    .filter((node) => node.tag === "a" && "href" in node.attrs && shows(node))
    .map((node) => node.attrs.href);

/** The inside of each element of class `name` a fragment shows. */
export const partsOf = (fragment, name) =>
  all(parse(fragment))
    .filter((node) => classes(node).includes(name) && shows(node))
    .map(inner);

/**
 * A fragment's fields, label by label: a <dt> and its <dd>, a contract's row,
 * or a label over its value, as the review's lead and a countdown show them;
 * each with whether it shows, and what clicking its Copy button copies.
 */
export function fieldsOf(fragment) {
  const fields = [];
  const add = (label, values, html) =>
    fields.push({ copies: copiesIn(values), html, label: textOf(inner(label)), shown: shows(label) && values.every(shows), text: textOf(html) });
  for (const node of all(parse(fragment))) {
    const siblings = node.parent?.children ?? [];
    const next = siblings[siblings.indexOf(node) + 1];
    if (node.tag === "dt" && next?.tag === "dd") add(node, [next], inner(next));
    else if (node.tag === "div" && classes(node).includes("crow") && classes(node.children[0] ?? { attrs: {} }).includes("k"))
      add(node.children[0], node.children.slice(1), node.source.slice(node.children[0].close, node.end));
    else if (node.tag === "div" && classes(node).includes("k") && next?.tag === "div" && classes(next).includes("v") && !classes(node.parent).includes("crow")) add(node, [next], inner(next));
  }
  return fields;
}

/** The one field a fragment shows under `label`. */
export function fieldOf(fragment, label) {
  const found = fieldsOf(fragment).filter((field) => field.label === label);
  assert.equal(found.length, 1, `one field labelled "${label}", not ${found.length}`);
  return found[0];
}

/** Whom a receipt says it paid, in the line under its title, as a field: what it shows and what its Copy button copies. */
export function paidOf(page) {
  const parts = partsOf(page, "paid");
  assert.equal(parts.length, 1, `one account paid, not ${parts.length}`);
  return { copies: copiesOf(parts[0]), html: parts[0], label: "Paid", shown: true, text: textOf(parts[0]) };
}

/** Each of a receipt's steps, as shown: what it says, what its Copy button copies, and where its link goes. */
export const stepPartsOf = (page) => partsOf(page, "step").map((part) => ({ copies: copiesOf(part), links: linksOf(part), text: textOf(part) }));

/** A wallet's lines, other than its head, by their labels. */
export const byLabel = (lines) => Object.fromEntries(lines.filter((line) => !line.kind).map((line) => [line.label, line]));

/**
 * `field` shows, with `value` in full as text a reader sees, not only in a
 * link, a title or a hidden element, and nothing cut short beside it; clicking
 * its Copy button copies exactly `value`; and, where `link` is given, its one
 * link goes there.
 */
export function assertShownInFull(field, value, link) {
  assert.ok(field.shown, `"${field.label}" shows`);
  assert.ok(field.text.split(" ").includes(value), `"${field.label}" shows ${value} in full, not "${field.text}"`);
  assert.ok(!field.text.includes("…"), `"${field.label}" shows nothing cut short: "${field.text}"`);
  assert.deepEqual(field.copies, [value], `clicking Copy in "${field.label}" copies ${value}`);
  if (link !== undefined) assert.deepEqual(linksOf(field.html), [link], `"${field.label}" links ${link}`);
}

// An amount and its unit, standing alone: no digit, letter, dot, comma or sign
// right before it. Its own sign is kept, a "−" or "+" also with a space after
// it, and a bound before it is said as a sign of its own: "up to" or "max" ≤,
// "at least" ≥, "less than" <, "more than" >. Its unit ends it: "0.005 ETH/s"
// and "0.005 ETH / s" are no amounts in ETH.
const BOUNDS = { "<": "<", ">": ">", "at least": "≥", "at most": "≤", "less than": "<", max: "≤", maximum: "≤", minimum: "≥", "more than": ">", "up to": "≤", "≤": "≤", "≥": "≥" };
const AMOUNT =
  /(?<![\w.,−+-])(?:(?<bound><|>|≤|≥|[Uu]p to|[Aa]t least|[Aa]t most|[Ll]ess than|[Mm]ore than|[Mm]ax(?:imum)?|[Mm]inimum)\s*)?(?:(?<sign>[−+])\s*|(?<minus>-))?(?<number>\d[\d,]*(?:\.\d+)?)\s(?<unit>(?:[A-Z]{2,5}\d+\s)?(?:DUSK|EURd|USDd|ETH|BNB))(?=$|[\s.,;:!?)])(?!\s*\/)(?!\s+per\b)/gu;

/** The amounts a fragment says, in order: "−0.005 DUSK", "≤0.105 DUSK", "<0.000001 ETH", "1,008 DUSK". */
export const amountsIn = (fragment) =>
  [...textOf(fragment).matchAll(AMOUNT)].map(
    ({ groups: { bound, minus, number, sign, unit } }) => `${bound ? BOUNDS[bound.toLowerCase()] : ""}${sign === "+" ? "+" : sign || minus ? "−" : ""}${number} ${unit}`,
  );

/** A receipt's steps as they show: each one's state, as its class draws it, and its text. */
export const stepsOf = (page) =>
  all(parse(page))
    .filter((node) => node.tag === "li" && classes(node).includes("step") && shows(node))
    .map((node) => [classes(node).find((name) => name !== "step"), textOf(inner(node))]);

// Safety messages whose meaning is the point, by a short phrase: that nothing
// went out, and that a time is only an estimate.
export const NOT_SENT = /\bnothing (?:was )?sent\b|\b(?:not|wasn't|was not) sent\b/iu;
export const ESTIMATE = /\b(?:about|around|estimated?|soonest)\b/iu;

/** A time a route takes, however it's worded around it. */
export const DURATION = /(?<![\w.,−-])\d+ (?:s|min|minutes?|hours?|days?)(?!\w)/u;

/**
 * `text` standing alone, and all of it: "7 days" isn't "17 days", "7 days 1
 * hour" or "7 days, 1 hour"; "9 Nov" isn't "19 Nov"; "200 DUSK" isn't "<200
 * DUSK", "< 200 DUSK" or "−200 DUSK".
 */
export const exactly = (text) => new RegExp(`(?<![\\w.,−+<>~≤≥-])(?<![−+<>~≤≥]\\s+)${escape(text)}(?!\\w)(?![\\s,]+(?:and\\s+)?\\d+(?:[.,]\\d+)?\\s+[a-zA-Z])`, "u");
