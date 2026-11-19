import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as module from "./worker.js";
import worker, { HEADERS } from "./worker.js";

/** The Worker's answer at a path of bridge.testnet.dusk.network. */
const ask = (path, init) => worker.fetch(new Request(`https://bridge.testnet.dusk.network${path}`, init));

const assertOwnAnswer = (response) => {
  for (const [name, value] of Object.entries(HEADERS)) assert.equal(response.headers.get(name), value, name);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
};

/** deploy/headers' rules, by path: each header a rule gives, by name. */
const rules = () =>
  Object.fromEntries(
    readFileSync(new URL("headers", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .join("\n")
      .split(/^(?=\/)/mu)
      .map((rule) => {
        const [path, ...lines] = rule.trim().split("\n");
        return [path, Object.fromEntries(lines.map((line) => line.trim().split(/: (.*)/su, 2)))];
      }),
  );

test("the Worker exports only what Cloudflare runs a Worker by: handlers and objects, no other value", () => {
  for (const [name, value] of Object.entries(module)) assert.match(typeof value, /^(function|object)$/u, name);
});

test("what no file answers is missing, with the headers every file has and nothing cached: the page's routes are in its fragment, which no request carries", async () => {
  for (const path of ["/", "/transfer/0xabc", "/move/bsc", "/assets/gone.js", "/assets/", "/drivers/gone.wasm", "/index.htm", "/%2e%2e/etc"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await ask(path, { method });

      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(await response.text(), "");
      assertOwnAnswer(response);
    }
  }
});

test("nothing but GET and HEAD is answered", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await ask("/", { method });

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
    assertOwnAnswer(response);
  }
});

test("its own answers carry the headers deploy/headers gives every file, with a policy that lets nothing in, as they're no pages", () => {
  const every = rules()["/*"];

  assert.equal(every["Content-Security-Policy"], "PAGE_POLICY");
  assert.deepEqual({ ...every, "Content-Security-Policy": HEADERS["Content-Security-Policy"] }, HEADERS);
  assert.equal(HEADERS["Content-Security-Policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("the build's hashed files are cached for good, and nothing else is", () => {
  assert.deepEqual(Object.keys(rules()), ["/*", "/assets/*"]);
  assert.deepEqual(rules()["/assets/*"], { "Cache-Control": "public, max-age=31536000, immutable" });
});
