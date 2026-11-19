import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("zod builds and checks AppKit's schemas without making a function from text, which the page's policy refuses and the browser would report", async () => {
  const made = [];
  const RealFunction = globalThis.Function;

  globalThis.__zod_globalConfig = { kept: true };
  // As the policy has it: a function made from text is refused.
  globalThis.Function = new Proxy(RealFunction, {
    construct(_target, args) {
      made.push(args);
      throw new EvalError("Refused to evaluate a string as JavaScript: 'unsafe-eval' is not allowed");
    },
  });

  try {
    await import("./no-eval.js");
    const { z } = await import("zod");
    const message = z.object({ id: z.string(), payload: z.optional(z.object({ themeMode: z.enum(["light", "dark"]) })), type: z.literal("@w3m-app/SYNC_THEME") });

    assert.deepEqual(message.parse({ id: "1", payload: { themeMode: "dark" }, type: "@w3m-app/SYNC_THEME" }), {
      id: "1",
      payload: { themeMode: "dark" },
      type: "@w3m-app/SYNC_THEME",
    });
    assert.equal(message.safeParse({ id: 1, type: "@w3m-app/SYNC_THEME" }).success, false);
    assert.deepEqual(made, []);
    // What else zod was told is kept.
    assert.equal(globalThis.__zod_globalConfig.jitless, true);
    assert.equal(globalThis.__zod_globalConfig.kept, true);
  } finally {
    globalThis.Function = RealFunction;
  }
});

test("the page tells zod before anything it loads can load zod", () => {
  const imports = readFileSync(new URL("./main.js", import.meta.url), "utf8").match(/^import\b[^;]*;/gmu);

  assert.equal(imports[0], 'import "./no-eval.js";');
});
