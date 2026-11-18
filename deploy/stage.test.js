import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";

import { PAGE_POLICY, stage } from "./stage.js";

/** A page's own policy, as vite.config.js writes it in its head. */
const page = (connect) =>
  `<!doctype html><head><meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${connect}; script-src 'self' 'wasm-unsafe-eval'" /><title>Dusk Bridge</title>`;

/** @type {string[]} */
const made = [];

/** A folder of its own, with the files given. */
const folder = (files) => {
  const root = mkdtempSync(join(tmpdir(), "dusk-bridge-stage-"));

  made.push(root);

  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }

  return root;
};

const filesIn = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();

/** A build's own files. */
const build = (files = {}) =>
  folder({
    "assets/index-x.js": "start",
    "build-manifest.json": JSON.stringify({ settings: { VITE_BRIDGE_PROFILE: "testnet" } }),
    "drivers/portal.wasm": "driver",
    "index.html": page("https://testnet.nodes.dusk.network"),
    ...files,
  });

/** deploy/headers, as the stage takes it. */
const headers = (text = `# Cloudflare's: the policy in place of ${PAGE_POLICY}.\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: ${PAGE_POLICY}\n`) =>
  join(folder({ headers: text }), "headers");

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("the build takes the site's place, the one there gone, with the headers beside it", () => {
  const built = build();
  const site = folder({ "assets/index-old.js": "an older build's", "old.html": "gone" });

  assert.equal(stage(built, site, headers()), site);
  assert.deepEqual(filesIn(site), ["_headers", ...filesIn(built)].sort());
  assert.equal(readFileSync(join(site, "index.html"), "utf8"), page("https://testnet.nodes.dusk.network"));
});

test("the header is the policy the build's pages carry, every page's sources, with frame-ancestors, which a page's own can't say", () => {
  const site = folder({});

  stage(build({ "receipt/index.html": page("https://rpc.testnet.evm.dusk.network") }), site, headers());

  assert.equal(
    readFileSync(join(site, "_headers"), "utf8"),
    `# Cloudflare's: the policy in place of ${PAGE_POLICY}.\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: frame-ancestors 'none'; default-src 'self'; connect-src 'self' https://testnet.nodes.dusk.network https://rpc.testnet.evm.dusk.network; script-src 'self' 'wasm-unsafe-eval'\n`,
  );
});

test("a build whose page carries no policy, as one built without vite.config.js, is refused before anything is placed", () => {
  const site = folder({ "index.html": "kept" });

  assert.throws(() => stage(build({ "index.html": "<!doctype html><title>Dusk Bridge</title>" }), site, headers()), /index\.html carries no Content-Security-Policy/u);
  assert.throws(() => stage(build({ "index.html": "" }), site, headers()), /carries no Content-Security-Policy/u);
  assert.deepEqual(filesIn(site), ["index.html"]);
});

test("a build with no manifest, or with a file of Cloudflare's own that would set how the site is served, is refused", () => {
  const site = folder({ "index.html": "kept" });

  assert.throws(() => stage(folder({ "index.html": page("") }), site, headers()), /has no build-manifest\.json: run npm run build/u);

  for (const file of ["_headers", "_redirects", ".assetsignore"]) {
    assert.throws(() => stage(build({ [file]: "/* /elsewhere 301" }), site, headers()), new RegExp(`has ${file.replace(".", "\\.")}, which would set how Cloudflare serves the site`, "u"));
  }

  assert.deepEqual(filesIn(site), ["index.html"]);
});

test("a build with uncommitted changes, which no commit builds, is refused before anything is placed", () => {
  const site = folder({ "index.html": "kept" });
  const dirty = build({ "build-manifest.json": JSON.stringify({ settings: { VITE_BRIDGE_PROFILE: "testnet" }, uncommitted: ["M src/main.js", "?? public/extra.txt"] }) });

  assert.throws(() => stage(dirty, site, headers()), /was built with uncommitted changes, which no commit builds/u);
  assert.throws(() => stage(build({ "build-manifest.json": "not json" }), site, headers()), /has no build-manifest\.json/u);
  assert.deepEqual(filesIn(site), ["index.html"]);
});

test("headers with nowhere for the policy, but in what they say of it, are refused", () => {
  const site = folder({ "index.html": "kept" });

  assert.throws(() => stage(build(), site, headers(`# No ${PAGE_POLICY} here.\n/*\n  X-Frame-Options: DENY\n`)), /has no PAGE_POLICY to put the policy in/u);
  assert.deepEqual(filesIn(site), ["index.html"]);
});
