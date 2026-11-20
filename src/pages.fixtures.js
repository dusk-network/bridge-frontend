// How a page reads to the person checking it, for the tests: what each field
// shows under its label, what its Copy button puts on the clipboard, where its
// links go, and the amounts it says, with their sign and bound kept.

import assert from "node:assert/strict";

const ENTITIES = { "&#039;": "'", "&amp;": "&", "&gt;": ">", "&lt;": "<", "&quot;": '"' };
/** An attribute's value as the browser reads it. */
export const decode = (text) => String(text).replace(/&(?:#039|amp|gt|lt|quot);/gu, (entity) => ENTITIES[entity]);
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// What a reader doesn't see: an element that's hidden, or only for a screen reader.
const HIDDEN = /<(\w+)\b(?=[^>]*(?:\shidden(?=[\s=>/])|\sclass="[^"]*\b(?:sr-only|visually-hidden)\b[^"]*"|\sstyle="[^"]*\bdisplay:\s*none))[^>]*>[\s\S]*?<\/\1>/gu;

/** The text a fragment of a page shows: no tags, attributes, icons, or what's hidden or only for a screen reader. */
export const textOf = (fragment) =>
  decode(
    String(fragment ?? "")
      .replace(/<svg\b[\s\S]*?<\/svg>/gu, "")
      .replace(HIDDEN, "")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .trim();

/** What each Copy button in a fragment puts on the clipboard: its data-copy, as the page's click handler reads it. */
export const copiesOf = (fragment) => [...String(fragment ?? "").matchAll(/\bdata-copy="([^"]*)"/gu)].map((match) => decode(match[1]));

/** Where each link in a fragment goes. */
export const linksOf = (fragment) => [...String(fragment ?? "").matchAll(/<a\b[^>]*?\shref="([^"]*)"/gu)].map((match) => decode(match[1]));

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

/**
 * `field` shows `value` in full as text a reader sees, not only in a link, a
 * title or a hidden element, and nothing cut short beside it; its Copy button
 * copies exactly `value`; and, where `link` is given, its one link goes there.
 */
export function assertShownInFull(field, value, link) {
  assert.ok(field.text.split(" ").includes(value), `"${field.label}" shows ${value} in full, not "${field.text}"`);
  assert.ok(!field.text.includes("…"), `"${field.label}" shows nothing cut short: "${field.text}"`);
  assert.deepEqual(field.copies, [value], `"${field.label}" copies ${value}`);
  if (link !== undefined) assert.deepEqual(linksOf(field.html), [link], `"${field.label}" links ${link}`);
}

// An amount and its unit, standing alone: no digit, letter, dot, comma or sign
// right before it. Its own sign is kept, and a bound before it is said as a
// sign of its own: "up to" ≤, "at least" ≥, "less than" <, "more than" >. Its
// unit ends it: "0.005 ETH/s" is no amount in ETH.
const BOUNDS = { "<": "<", ">": ">", "at least": "≥", "at most": "≤", "less than": "<", "more than": ">", "up to": "≤", "≤": "≤", "≥": "≥" };
const AMOUNT =
  /(?<![\w.,−+-])(?:(<|>|≤|≥|[Uu]p to|[Aa]t least|[Aa]t most|[Ll]ess than|[Mm]ore than)\s*)?([−+-])?(\d[\d,]*(?:\.\d+)?)\s((?:[A-Z]{2,5}\d+\s)?(?:DUSK|EURd|USDd|ETH|BNB))(?=$|[\s.,;:!?)])/gu;

/** The amounts a fragment says, in order: "−0.005 DUSK", "≤0.105 DUSK", "<0.000001 ETH", "1,008 DUSK". */
export const amountsIn = (fragment) =>
  [...textOf(fragment).matchAll(AMOUNT)].map(([, bound, sign, number, unit]) => `${bound ? BOUNDS[bound.toLowerCase()] : ""}${sign ? (sign === "+" ? "+" : "−") : ""}${number} ${unit}`);

/** A receipt's steps as they show: each one's state, as its class draws it, and its text. */
export const stepsOf = (page) => [...String(page ?? "").matchAll(/<li class="step (\w+)">([\s\S]*?)<\/li>/gu)].map(([, state, inner]) => [state, textOf(inner)]);

// Safety messages whose meaning is the point, by a short phrase: that nothing
// went out, and that a time is only an estimate.
export const NOT_SENT = /\bnothing (?:was )?sent\b|\b(?:not|wasn't|was not) sent\b/iu;
export const ESTIMATE = /\b(?:about|around|estimated?|soonest)\b/iu;

/** A time a route takes, however it's worded around it. */
export const DURATION = /(?<![\w.,−-])\d+ (?:s|min|minutes?|hours?|days?)(?!\w)/u;

/**
 * `text` standing alone, and all of it: "7 days" isn't "17 days" or "7 days 1
 * hour", "9 Nov" isn't "19 Nov", "200 DUSK" isn't "<200 DUSK" or "−200 DUSK".
 */
export const exactly = (text) => new RegExp(`(?<![\\w.,−+<>~≤≥-])${escape(text)}(?!\\w)(?!\\s+(?:and\\s+)?\\d)`, "u");
