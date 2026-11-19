/**
 * Places the bridge's build where Cloudflare serves it (wrangler.jsonc):
 * dist/ as deploy/site/, in place of what was there, with deploy/headers as
 * deploy/site/_headers, which carries the policy the build's page carries as
 * its Content-Security-Policy. The Deploy workflow runs it after the build,
 * as does anyone serving the build with Wrangler:
 *
 *   npm run build && node deploy/stage.js
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** What deploy/headers says in place of the page's policy. */
export const PAGE_POLICY = "PAGE_POLICY";

/** A page's own policy, as vite.config.js writes it in its head. */
const META = /<meta http-equiv="content-security-policy" content="([^"]*)"\s*\/?>/iu;

/** Cloudflare's own files in a site, which it reads and doesn't serve. */
const CLOUDFLARE_FILES = ["_headers", "_redirects", ".assetsignore"];

/** @param {string} text What an attribute's value holds, escaped */
const unescaped = (text) =>
  text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * The policy a build's pages carry, as one header for all of them: each
 * directive with every page's sources, and frame-ancestors, which a page's
 * own policy can't say. Refuses a build with a page that carries none, as one
 * built without vite.config.js.
 *
 * @param {string} build
 * @returns {string}
 */
export function pagePolicy(build) {
  const pages = readdirSync(build, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  /** @type {Map<string, Set<string>>} */
  const directives = new Map([["frame-ancestors", new Set(["'none'"])]]);

  if (!pages.length) {
    throw new Error(`${build} has no page`);
  }

  for (const page of pages) {
    const policy = readFileSync(page, "utf8").match(META)?.[1];

    if (!policy) {
      throw new Error(`${relative(build, page)} carries no Content-Security-Policy: build it with vite.config.js`);
    }

    for (const directive of unescaped(policy).split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);

      if (name) {
        const kept = directives.get(name) ?? new Set();

        directives.set(name, kept);
        sources.forEach((source) => kept.add(source));
      }
    }
  }

  return [...directives].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/**
 * Copies a build to a site, once what was there is gone: the site serves that
 * build alone. Writes `headers` beside it as the site's _headers, with the
 * policy the build's page carries. Refuses a build with no manifest, one of
 * uncommitted changes, which no commit builds, one with a file of
 * Cloudflare's own, which would set how the site is served, and one whose
 * page carries no policy.
 *
 * @param {string} build
 * @param {string} site
 * @param {string} headers Cloudflare's headers, with PAGE_POLICY in them
 */
export const stage = (build, site, headers) => {
  let manifest;

  try {
    manifest = JSON.parse(readFileSync(join(build, "build-manifest.json"), "utf8"));
  } catch {
    throw new Error(`${build} has no build-manifest.json: run npm run build`);
  }

  if (manifest?.uncommitted) {
    throw new Error(`${build} was built with uncommitted changes, which no commit builds: commit them, or build a clean checkout`);
  }

  const own = CLOUDFLARE_FILES.filter((file) => existsSync(join(build, file)));

  if (own.length) {
    throw new Error(`${build} has ${own.join(" and ")}, which would set how Cloudflare serves the site: deploy/headers does`);
  }

  const policy = pagePolicy(build);
  // The policy in place of the mark, in the rules: not in what they say of it.
  const lines = readFileSync(headers, "utf8").split("\n");

  if (!lines.some((line) => !line.startsWith("#") && line.includes(PAGE_POLICY))) {
    throw new Error(`${headers} has no ${PAGE_POLICY} to put the policy in`);
  }

  const rules = lines.map((line) => (line.startsWith("#") ? line : line.replaceAll(PAGE_POLICY, policy))).join("\n");

  rmSync(site, { force: true, recursive: true });
  cpSync(build, site, { recursive: true });
  writeFileSync(join(site, "_headers"), rules);

  return site;
};

// Run, not imported by the tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const to = stage(
      fileURLToPath(new URL("../dist", import.meta.url)),
      fileURLToPath(new URL("site", import.meta.url)),
      fileURLToPath(new URL("headers", import.meta.url)),
    );

    console.log(`Placed dist/ at ${relative(process.cwd(), to)}/, with its policy in _headers`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
