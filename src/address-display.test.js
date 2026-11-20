import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Addresses, hashes and contract IDs are checked character by character: a
// font's ligatures or contextual alternates could draw "0x" as "0×".
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
// The declarations of every rule that names `selector` among its selectors.
const declarations = (selector) =>
  [...css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) => selectors.split(",").map((each) => each.trim()).includes(selector))
    .map(([, , body]) => body)
    .join(";");

test("addresses, hashes and IDs render without ligatures or contextual alternates, so 0x stays 0x", () => {
  for (const selector of [".mono", "code"]) {
    assert.match(declarations(selector), /font-variant-ligatures:\s*none\b/u, selector);
    assert.match(declarations(selector), /font-feature-settings:\s*"liga" 0,\s*"calt" 0\b/u, selector);
  }
  // The recipient field, as an address is typed or pasted in.
  assert.match(declarations(".mono-input"), /font-variant-ligatures:\s*none\b/u);
});
