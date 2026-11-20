// How a page reads to the person checking it, for the tests: what each field
// shows under its label, what its Copy button puts on the clipboard, and the
// amounts it says, with their sign and any "less than" kept.

import assert from "node:assert/strict";

const ENTITIES = { "&#039;": "'", "&amp;": "&", "&gt;": ">", "&lt;": "<", "&quot;": '"' };
/** An attribute's value as the browser reads it. */
export const decode = (text) => String(text).replace(/&(?:#039|amp|gt|lt|quot);/gu, (entity) => ENTITIES[entity]);
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The text a fragment of a page shows: no tags, attributes, icons, or words only a screen reader gets. */
export const textOf = (fragment) =>
  decode(
    String(fragment ?? "")
      .replace(/<svg\b[\s\S]*?<\/svg>/gu, "")
      .replace(/<span class="sr-only">[\s\S]*?<\/span>/gu, "")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .trim();

/** What each Copy button in a fragment puts on the clipboard: its data-copy, as the page's click handler reads it. */
export const copiesOf = (fragment) => [...String(fragment ?? "").matchAll(/\bdata-copy="([^"]*)"/gu)].map((match) => decode(match[1]));

/**
 * A fragment's fields, label by label: a <dt> and its <dd>, a contract's row,
 * or a label over its value, as the review's lead and a countdown show them.
 */
export const fieldsOf = (fragment) =>
  [
    ...String(fragment ?? "").matchAll(
      /<dt\b[^>]*>([\s\S]*?)<\/dt><dd\b[^>]*>([\s\S]*?)<\/dd>|<div class="crow"><div class="k">([\s\S]*?)<\/div>([\s\S]*?)<\/div>|<div class="k">([\s\S]*?)<\/div><div class="v\b[^"]*">([\s\S]*?)<\/div>/gu,
    ),
  ].map(([, dt, dd, crowLabel, crowValue, label, value]) => {
    const shown = dd ?? crowValue ?? value;
    return { copies: copiesOf(shown), html: shown, label: textOf(dt ?? crowLabel ?? label), text: textOf(shown) };
  });

/** The one field a fragment shows under `label`. */
export function fieldOf(fragment, label) {
  const found = fieldsOf(fragment).filter((field) => field.label === label);
  assert.equal(found.length, 1, `one field labelled "${label}", not ${found.length}`);
  return found[0];
}

/** A wallet's lines, other than its head, by their labels. */
export const byLabel = (lines) => Object.fromEntries(lines.filter((line) => !line.kind).map((line) => [line.label, line]));

/** `field` shows `value` in full, as text and not only in a link or a title, and its Copy button copies exactly `value`. */
export function assertShownInFull(field, value) {
  assert.ok(field.text.split(" ").includes(value), `"${field.label}" shows ${value} in full, not "${field.text}"`);
  assert.deepEqual(field.copies, [value], `"${field.label}" copies ${value}`);
}

// An amount and its unit: no digit, letter, dot, comma or sign right before
// it, its own sign kept, and a "less than" before it said as "<".
const AMOUNT = /(?<![\w.,−-])(<\s*|[Ll]ess than\s+)?([−-])?(\d[\d,]*(?:\.\d+)?)\s((?:[A-Z]{2,5}\d+\s)?(?:DUSK|EURd|USDd|ETH|BNB))(?!\w)/gu;

/** The amounts a fragment says, in order: "−0.005 DUSK", "<0.000001 ETH", "1,008 DUSK". */
export const amountsIn = (fragment) =>
  [...textOf(fragment).matchAll(AMOUNT)].map(([, below, minus, number, unit]) => `${below ? "<" : ""}${minus ? "−" : ""}${number} ${unit}`);

/** A time a route takes, however it's worded around it. */
export const DURATION = /(?<![\w.,−-])\d+ (?:s|min|minutes?|hours?|days?)(?!\w)/u;

/** `text` standing alone: "7 days" isn't "17 days", "9 Nov" isn't "19 Nov", "0.5 DUSK" isn't "−0.5 DUSK". */
export const exactly = (text) => new RegExp(`(?<![\\w.,−-])${escape(text)}(?!\\w)`, "u");
