import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const tokens = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/giu)].map((match) => [match[1], match[2]]));

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

test("text keeps at least 4.5:1 contrast on every surface it sits on", () => {
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
});

test("addresses render without ligatures or contextual alternates, so 0x stays 0x", () => {
  assert.match(css, /\.mono, code \{[^}]*font-variant-ligatures: none;[^}]*font-feature-settings: "liga" 0, "calt" 0;/u);
  assert.match(css, /\.mono-input \{[^}]*font-variant-ligatures: none;/u);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/u);
});
