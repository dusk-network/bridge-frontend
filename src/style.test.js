import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
// The dark tokens, then the light ones the system's preference picks.
const block = (from) => css.slice(css.indexOf(":root {", from), css.indexOf("}", css.indexOf(":root {", from)));
const read = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/giu)].map((match) => [match[1], match[2]]));
const dark = read(block(0));
const light = read(block(css.indexOf("prefers-color-scheme: light")));
let tokens = dark;

function luminance(hex) {
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrast = (a, b) => {
  const [light, dark] = [luminance(tokens[a]), luminance(tokens[b])].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test("text keeps at least 4.5:1 contrast on every surface it sits on, dark and light", () => {
  for (const theme of [dark, light]) {
  tokens = theme;
  const pairs = [
    ...["text", "text-2", "text-3"].flatMap((text) => ["bg", "surface", "sheet", "chip"].map((surface) => [text, surface])),
    ["text", "surface-2"],
    ["text-2", "surface-2"],
    ["text", "surface-3"],
    ["text-2", "surface-3"],
    ["amber", "bg"],
    ["amber", "surface"],
    ["amber", "chip"],
    ["red", "bg"],
    ["red", "surface"],
    ["red", "sheet"],
    ["test", "test-bg"],
    ["btn-text", "btn"],
  ];
  for (const [text, surface] of pairs)
    assert.ok(contrast(text, surface) >= 4.5, `${text} on ${surface}: ${contrast(text, surface).toFixed(2)}`);
  }
  assert.equal(Object.keys(light).length, Object.keys(dark).length);
});

test("the amount's error clears the swap button, on a phone and a computer", () => {
  // One declaration of a rule, in px.
  const px = (selector, property, index = 0) => {
    const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
    const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, "u").exec(rule)?.[1] ?? "0";
    return Number.parseFloat(value.trim().split(/\s+/u)[index]);
  };
  // The button sits on the row between From and To, half of it over the
  // From panel; the error is that panel's last line.
  const clearance = px(".panel", "padding", 2) + px(".panel > .field-error", "margin-bottom");
  // On a phone it's a thumb's size.
  const phone = Number.parseFloat(/\n {2}\.flip \{[^}]*height: ([\d.]+)px/u.exec(css.slice(css.indexOf("@media (max-width: 767px)")))?.[1]);
  for (const height of [px(".flip", "height"), phone]) {
    const overhang = height / 2 - px(".flip-row", "height") / 2;
    assert.ok(overhang > 0);
    assert.ok(clearance >= overhang, `${clearance}px under the error, ${overhang}px of button`);
  }
});

test("at phone width, everything a thumb presses is 44 px each way", () => {
  // The phone's rules, by each selector they name.
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"), css.indexOf("@media (prefers-reduced-motion"));
  const rules = [...phone.matchAll(/^ {2}([^{}@/]+?) \{([^}]*)\}/gmu)].flatMap(([, selectors, body]) => selectors.split(",").map((selector) => [selector.trim(), body]));
  const size = (selector, ...properties) =>
    Math.max(
      ...rules
        .filter(([named]) => named === selector)
        .flatMap(([, body]) => properties.map((property) => Number.parseFloat(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)px`, "u").exec(body)?.[1] ?? 0))),
      0,
    );
  const tall = [".hdr-r .net", ".hdr-r .wpill", ".tab", ".netbtn", ".tokbtn", ".btn.sm", ".btn.xs", ".panel-f .mini", ".bcard-top .icon-btn", ".icon-btn", ".icon-btn.round", ".flip", ".amt-row input", ".linkish", ".lnk", ".topbar .bk", ".foot a", ".about-links a", ".entry a", ".route > summary"];
  for (const selector of tall) assert.ok(size(selector, "height", "min-height") >= 44, `${selector} is ${size(selector, "height", "min-height")} px tall`);
  for (const selector of [".brand", ".panel-f .mini", ".bcard-top .icon-btn", ".icon-btn", ".icon-btn.round", ".flip"]) assert.ok(size(selector, "width", "min-width") >= 44, `${selector} is ${size(selector, "width", "min-width")} px wide`);
});

test("addresses render without ligatures or contextual alternates, so 0x stays 0x", () => {
  assert.match(css, /\.mono, code \{[^}]*font-variant-ligatures: none;[^}]*font-feature-settings: "liga" 0, "calt" 0;/u);
  assert.match(css, /\.mono-input \{[^}]*font-variant-ligatures: none;/u);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/u);
});

test("text is set in Söhne, addresses and hashes in Söhne Mono, from the page's own files", () => {
  for (const [family, weight, file] of [
    ["Soehne", 400, "soehne-buch"],
    ["Soehne", 500, "soehne-kraftig"],
    ['"Soehne Mono"', 400, "soehne-mono-buch"],
    ['"Soehne Mono"', 500, "soehne-mono-kraftig"],
  ]) {
    assert.match(css, new RegExp(`@font-face \\{ font-family: ${family}; [^}]*font-weight: ${weight}; src: url\\("/fonts/${file}\\.woff2"\\)`, "u"));
    assert.ok(readFileSync(new URL(`../public/fonts/${file}.woff2`, import.meta.url)).length > 10_000, file);
  }
  assert.equal(dark.sans, undefined);
  assert.match(css, /--sans: Soehne, "Helvetica Neue"/u);
  assert.match(css, /--mono: "Soehne Mono", ui-monospace/u);
});

test("in My transfers, a route's marks and DuskEVM's tag fit their cell, clear of the text, on a phone and a computer", () => {
  const computer = css.slice(0, css.indexOf("@media (max-width: 1023px)"));
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
  // A rule's `property` in `text`, top-level or inside a media query.
  const value = (text, selector, property) => {
    const at = [`\n${selector} {`, `\n  ${selector} {`].map((head) => text.indexOf(head)).find((index) => index >= 0);
    if (at === undefined) return null;
    const body = text.slice(text.indexOf("{", at) + 1, text.indexOf("}", at));
    return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, "u").exec(body)?.[1].trim() ?? null;
  };
  // As the cascade picks it: the most specific selector first, a phone's own rule before the computer's.
  const px = (where, selectors, property) => {
    for (const selector of selectors) {
      const found = (where === "phone" && value(phone, selector, property)) || value(computer, selector, property);
      if (found) return Number.parseFloat(found);
    }
    return Number.NaN;
  };
  for (const where of ["computer", "phone"]) {
    const cell = px(where, [".act .trs .tr"], "grid-template-columns");
    const mark = px(where, [".act .trs .pair .cm", ".tr .pair .cm", ".cm"], "width");
    const gap = px(where, [".act .trs .pair", ".pair"], "gap");
    const arrow = px(where, [".act .trs .pair svg.pa", ".pair svg.pa"], "width");
    const tag = Math.max(0, -px(where, [".act .trs .evm-tag", ".evm-tag"], "right"));
    const width = 2 * mark + 2 * gap + arrow + tag;
    assert.ok(width <= cell, `${where}: ${width}px in a ${cell}px cell`);
  }
});

test("a long .dusk name ends in an ellipsis in the top bar and wraps in text, on a computer and a phone", () => {
  // Outside any media query, so at every width.
  const top = css.slice(0, css.indexOf("@media (max-width: 1023px)"));
  const rule = (selector) => new RegExp(`\\n${selector.replace(/\./gu, "\\.")} \\{([^}]*)\\}`, "u").exec(top)?.[1] ?? "";
  for (const declaration of ["max-width: 18ch", "overflow: hidden", "text-overflow: ellipsis", "min-width: 0"]) assert.ok(rule(".wpill .nm").includes(declaration), declaration);
  // The pill keeps to one line, so the name is cut, not wrapped.
  assert.match(rule(".wpill"), /white-space: nowrap/u);
  // On a phone it's cut shorter, so the EVM wallet beside it still reads "0x7568…".
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
  const cap = Number.parseFloat(/\n {2}\.hdr-r \.wpill \.nm \{[^}]*max-width: ([\d.]+)ch/u.exec(phone)?.[1]);
  assert.ok(cap < 18, `${cap}ch on a phone`);
  // Elsewhere (the review, My transfers, a receipt) a name with no break in it wraps, so the page never scrolls sideways.
  assert.match(rule("#app"), /overflow-wrap: anywhere/u);
});
