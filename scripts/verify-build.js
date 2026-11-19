#!/usr/bin/env node
/**
 * Rebuilds the bridge a site serves from its source, and checks the site
 * against the rebuild and its build manifest: every file, and the page at
 * the addresses browsers open it by.
 *
 * Nothing the site says is trusted. A site is its address's root: the page's
 * routes are in its fragment, which is dropped, and any other path or a query
 * is refused. A manifest a build wouldn't write is refused, as is one of a
 * build with uncommitted changes. Its commit is built only where it comes from
 * where the site is deployed from, fetched from the repository's own address
 * on GitHub, whatever origin is: testnet's from its main, mainnet's the commit
 * of its release's tag. Any other site's must be in the history of a ref you
 * name with --trusted-ref. The site must be built with the settings
 * deployments.json lists for it at that commit, and is rebuilt with those; how
 * this checkout's differ is said as drift, which fails nothing. The commit is
 * built in a new worktree with `npm ci` and `npm run build`; --keep keeps it,
 * to look at.
 * --attested checks first, with GitHub's CLI (`gh attestation verify`), that
 * the repository's Deploy workflow attested the manifest as the site serves
 * it, built from the commit it names on GitHub's own runners, from the ref
 * the workflow deploys the site from: main for testnet, the release's tag
 * for mainnet. GitHub vouches for it, not the site. The workflow attests
 * builds only while the repository is public.
 *
 *   node scripts/verify-build.js https://bridge.dusk.network/ [--attested] [--keep]
 *   node scripts/verify-build.js <other site> --trusted-ref <branch, tag or commit> [--keep]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pkg from "../package.json" with { type: "json" };
import { MANIFEST, OUT_DIR, hashFiles } from "./build.js";

const MAX_MANIFEST = 2 ** 21;
const MAX_FILE = 2 ** 26;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

/** A path in a build: folders and a file, none of them "." or "..". */
const isBuildPath = (path) =>
  matches(path, /^[^/]{1,128}(\/[^/]{1,128}){0,15}$/) && path.split("/").every((part) => /^[\w~@+-][\w.~@+-]*$/.test(part));

/** An http(s) address, or a path from the site's root. */
const isAddress = (value) => {
  try {
    return value.startsWith("/") ? /^\/(?![/\\])[^\s\\]*$/.test(value) : ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * What's wrong with a setting, if anything: a setting is a VITE_ one, a line
 * of plain text, and a path or an address where one is expected.
 */
export const settingProblem = (key, value) =>
  (!matches(key, /^VITE_[A-Z0-9_]{1,64}$/) && "a setting not a VITE_ one") ||
  (!matches(value, /^[\x20-\x7e]{0,2048}$/) && `a ${key} not plain text`) ||
  (key.endsWith("_URL") && value && !isAddress(value) && `a ${key} not an address`) ||
  "";

/**
 * A site's build manifest, checked before anything is run: what a build
 * wouldn't write is refused.
 */
export const readManifest = (bytes) => {
  if (!bytes) {
    throw new Error(`serves no ${MANIFEST}: it wasn't built by npm run build, and can't be rebuilt to the same files`);
  }

  let manifest = null;

  try {
    manifest = bytes.length <= MAX_MANIFEST && JSON.parse(bytes.toString());
  } catch {
    // Not one.
  }

  if (!isObject(manifest)) {
    throw new Error(`serves a ${MANIFEST} a build doesn't write`);
  }

  if (manifest.uncommitted !== undefined) {
    throw new Error(`serves the ${MANIFEST} of a build with uncommitted changes, which its commit doesn't build`);
  }

  const { commit, files, mode = "production", node, npm, settings, version } = manifest;
  const problem = [
    !matches(commit, /^[0-9a-f]{40}$/) && "no commit",
    !matches(version, /^\d+\.\d+\.\d+([-+][\w.-]+)?$/) && "no version",
    !matches(mode, /^[\w-]{1,32}$/) && "an odd mode",
    node !== undefined && !matches(node, /^v\d+\.\d+\.\d+$/) && "an odd Node",
    npm !== undefined && !matches(npm, /^\d+\.\d+\.\d+$/) && "an odd npm",
    !isObject(settings) && "no settings",
    !isObject(files) && "no files",
    ...Object.entries(isObject(settings) ? settings : {}).map(([key, value]) => settingProblem(key, value)),
    ...Object.entries(isObject(files) ? files : {}).map(
      ([path, hash]) => !(isBuildPath(path) && matches(hash, /^[0-9a-f]{64}$/)) && "a file it names oddly",
    ),
  ].find(Boolean);

  if (problem) {
    throw new Error(`serves a ${MANIFEST} with ${problem}`);
  }

  return {
    commit,
    files: new Map(Object.entries(files)),
    mode,
    node,
    settings: new Map(Object.entries(settings)),
    version,
  };
};

/**
 * The settings deployments.json lists for a site and its manifest names
 * differently, by key.
 */
export const settingsDiffer = (listed, named) =>
  [...new Set([...Object.keys(listed), ...named.keys()])].sort().filter((key) => listed[key] !== named.get(key));

/**
 * Where the rebuild, the site's manifest and the site differ: at each file's
 * address, and each page's with and without its last slash, as browsers open
 * it (the site's own page has one address: its root's). A file the manifest
 * names that the rebuild hasn't differs as it is, and is never fetched: only
 * what the rebuild has is asked for, however much the manifest names. `get`
 * gives the SHA-256 of what the site serves at an address, or null; told, for
 * a page's index.html and its address without the slash, which a host may
 * send on, the one address they may go to: the page's.
 */
export const compareSite = async (site, rebuilt, listed, get) => {
  const addresses = [];
  const differences = [];
  const addressOf = (path) => new URL(path.split("/").map(encodeURIComponent).join("/"), site).href;

  for (const [path, inManifest] of listed) {
    if (!rebuilt.has(path)) differences.push({ address: addressOf(path), inManifest, rebuild: undefined, served: undefined });
  }

  for (const path of rebuilt.keys()) {
    const file = addressOf(path);

    if (/(^|\/)index\.html$/.test(path)) {
      const page = file.slice(0, -"index.html".length);
      const bare = page.slice(0, -1);

      addresses.push([file, path, page], [page, path]);

      if (new URL(bare).href !== page) {
        addresses.push([bare, path, page]);
      }
    } else {
      addresses.push([file, path]);
    }
  }

  for (let next = 0; next < addresses.length; next += 8) {
    await Promise.all(
      addresses.slice(next, next + 8).map(async ([address, path, to]) => {
        const served = await get(address, to);
        const rebuild = rebuilt.get(path);

        if (served !== rebuild || listed.get(path) !== rebuild) {
          differences.push({ address, inManifest: listed.get(path), rebuild, served });
        }
      }),
    );
  }

  differences.sort((a, b) => (a.address < b.address ? -1 : 1));

  return { checked: addresses.length, differences };
};

const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * What a site serves at an address: the SHA-256 of it, or with `limit`, up to
 * a byte over that of it. Null where it serves nothing. Nothing may redirect
 * but a page's address without its last slash, or its index.html, and only to
 * `to`, the page's own, as static hosts do: what a browser fetched from
 * anywhere else, the addresses it reads from there would be checked nowhere.
 */
export const fetchFrom = async (address, { limit, to, get = fetch } = {}) => {
  const ask = (at) => get(at, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  // Once more where it failed to connect: a connection kept open from before
  // the rebuild, which ran for long, can have been closed since.
  const fetchAt = (at) => ask(at).catch(() => ask(at));
  let response = await fetchAt(address);

  if (to && REDIRECTS.includes(response.status) && new URL(response.headers.get("location") ?? "", address).href === to) {
    await response.body?.cancel();
    response = await fetchAt(to);
  }

  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();

    if (!REDIRECTS.includes(response.status)) return null;
    if (limit) throw new Error(`redirects ${new URL(address).pathname}`);

    return "a redirect";
  }

  const hash = createHash("sha256");
  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;
    if (limit) chunks.push(chunk);
    else hash.update(chunk);
    if (size > (limit ?? MAX_FILE)) break;
  }

  if (limit) return Buffer.concat(chunks);

  return size > MAX_FILE ? "over 64 MiB" : hash.digest("hex");
};

/** The repository whose Deploy workflow attests each build's manifest. */
export const REPOSITORY = new URL(pkg.homepage).pathname.slice(1);

/** The sites the Deploy workflow deploys: testnet from main, mainnet from a release's tag. */
export const TESTNET_SITE = "https://bridge.testnet.dusk.network/";
export const MAINNET_SITE = "https://bridge.dusk.network/";

/** What a release's tag is called, before its version. */
export const TAG_PREFIX = "bridge-v";

/**
 * The ref the Deploy workflow builds a site from, which its attestation
 * names: main for testnet, the tag of the release its manifest says for
 * mainnet; null for a site it doesn't deploy.
 *
 * @param {string} site
 * @param {string} version The manifest's
 * @returns {string | null}
 */
export const sourceRefOf = (site, version) =>
  site === TESTNET_SITE ? "refs/heads/main" : site === MAINNET_SITE ? `refs/tags/${TAG_PREFIX}${version}` : null;

/**
 * GitHub's CLI's arguments that check the repository's Deploy workflow
 * attested a manifest, as the site served it (`file`), built from the commit
 * it names, from `ref`, on GitHub's own runners.
 *
 * @param {string} file
 * @param {string} commit
 * @param {string} ref
 * @param {string} [repository]
 */
export const attestationArgs = (file, commit, ref, repository = REPOSITORY) => [
  "attestation",
  "verify",
  file,
  "--repo",
  repository,
  "--signer-workflow",
  `${repository}/.github/workflows/deploy.yml`,
  "--source-digest",
  commit,
  "--source-ref",
  ref,
  "--deny-self-hosted-runners",
];

/** npm's own script beside this Node, where it's there. */
const npmBeside = () =>
  ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]
    .map((path) => join(dirname(process.execPath), path))
    .find((path) => existsSync(path));

/**
 * How to run npm with the arguments given: from npm's own script, as this
 * Node, where it's beside it, since on Windows npm and npx are .cmd files,
 * which only a shell runs; npm on the PATH otherwise. With a version, that
 * npm, as npx gets it.
 */
export const npmCommand = (version, args, cli = npmBeside()) => {
  const own = version ? ["exec", "--yes", `--package=npm@${version}`, "--", "npm", ...args] : args;

  return cli ? [process.execPath, [cli, ...own]] : ["npm", own];
};

/**
 * A site, as the bridge is served: an http(s) address's root, with the
 * fragment, where the page's routes are (#/transfer/…), dropped. Any other
 * path is refused, as the page loads its files from the root, and so are a
 * query and a user.
 *
 * @param {string} address
 * @returns {string}
 */
export const siteOf = (address) => {
  const url = URL.parse(String(address ?? ""));

  if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error(`${address} isn't an http(s) address`);
  if (url.username || url.password) throw new Error(`${address} names a user: a site's address has none`);
  if (url.search) throw new Error(`${address} has a query: a site is checked at its root alone`);
  if (url.pathname !== "/") throw new Error(`${address} is ${url.pathname} of its site: the bridge is served from the root, where its files are`);

  return `${url.origin}/`;
};

/** The repository's own address on GitHub, where what's deployed comes from. */
export const UPSTREAM = `https://github.com/${REPOSITORY}.git`;

/**
 * Where a site's build may come from: testnet's from upstream main, mainnet's
 * the commit of upstream's tag for its release's version, any other site's
 * from the history of the ref its verifier trusts. Null where nothing is
 * trusted; refuses a trusted ref for a site the Deploy workflow deploys.
 *
 * @param {string} site
 * @param {string} version The manifest's
 * @param {string | null} [trustedRef]
 * @returns {{ fetch: string, exact: boolean } | { local: string, exact: false } | null}
 */
export const trustedSourceOf = (site, version, trustedRef = null) => {
  if ((site === TESTNET_SITE || site === MAINNET_SITE) && trustedRef) {
    throw new Error(`${site} is checked against ${UPSTREAM} alone: --trusted-ref is for other sites`);
  }

  if (site === TESTNET_SITE) return { exact: false, fetch: "refs/heads/main" };
  if (site === MAINNET_SITE) return { exact: true, fetch: `refs/tags/${TAG_PREFIX}${version}` };

  return trustedRef ? { exact: false, local: trustedRef } : null;
};

/**
 * Checks, with `git` run in this clone, that `commit` comes from where the
 * site is deployed from: upstream's ref, fetched from `upstream` itself and
 * never from origin, or the trusted local one. A tag's is its commit alone, a
 * branch's anything in its history. Throws why not.
 *
 * @param {(...args: string[]) => string} git
 * @param {string} commit
 * @param {{ fetch?: string, local?: string, exact: boolean }} source
 * @param {string} [upstream]
 */
export const checkSource = (git, commit, source, upstream = UPSTREAM) => {
  const where = source.fetch ? `${upstream}'s ${source.fetch.replace(/^refs\/(heads|tags)\//u, "")}` : source.local;
  let tip;

  try {
    if (source.fetch) git("fetch", "--quiet", "--no-tags", upstream, source.fetch);
    tip = git("rev-parse", "--verify", "--quiet", `${source.fetch ? "FETCH_HEAD" : source.local}^{commit}`);
  } catch {
    throw new Error(`${where} can't be read: not building ${commit}`);
  }

  if (source.exact) {
    if (tip !== commit) throw new Error(`${where} is ${tip}, not ${commit}: not building it`);
    return;
  }

  try {
    git("merge-base", "--is-ancestor", commit, tip);
  } catch {
    throw new Error(`${commit} isn't in ${where}'s history: not building it`);
  }
};

/**
 * deployments.json as the commit has it, read with `git` in this clone; null
 * where it has none.
 *
 * @param {(...args: string[]) => string} git
 * @param {string} commit
 */
export const deploymentsAt = (git, commit) => {
  let text;

  try {
    text = git("show", `${commit}:deployments.json`);
  } catch {
    return null;
  }

  const deployments = JSON.parse(text);

  return isObject(deployments) ? deployments : null;
};

/**
 * How a site's settings stand, by key: where its manifest differs from what
 * deployments.json lists for it at its commit (`atCommit`), which fails it,
 * and where this checkout's deployments.json (`here`) differs from that,
 * which is drift alone: settings changed for a later deploy. `listed` is
 * null where its commit lists none.
 *
 * @param {string} site
 * @param {Map<string, string>} named The manifest's settings
 * @param {Record<string, Record<string, string>> | null} atCommit
 * @param {Record<string, Record<string, string>> | null} here
 */
export const settingsCheck = (site, named, atCommit, here) => {
  const listed = (isObject(atCommit) && Object.hasOwn(atCommit, site) && atCommit[site]) || null;
  const own = (isObject(here) && Object.hasOwn(here, site) && here[site]) || {};

  return {
    differ: listed ? settingsDiffer(listed, named) : [],
    drift: listed ? settingsDiffer(own, new Map(Object.entries(listed))) : [],
    listed,
  };
};

/**
 * The command's arguments: the site, --attested, --keep, and the ref trusted
 * for another site (--trusted-ref <ref>). A ref can't look like an option.
 *
 * @param {string[]} args
 */
export const parseArgs = (args) => {
  const options = { attested: false, keep: false, trustedRef: null };
  const sites = [];

  for (let at = 0; at < args.length; at += 1) {
    const [option, joined] = args[at].split(/=(.*)/su);

    if (args[at] === "--attested") options.attested = true;
    else if (args[at] === "--keep") options.keep = true;
    else if (option === "--trusted-ref") {
      options.trustedRef = joined ?? args[(at += 1)] ?? "";
      if (!/^[^-\s][^\s]*$/u.test(options.trustedRef)) throw new Error("--trusted-ref names a branch, tag or commit you trust");
    } else if (args[at].startsWith("-")) throw new Error(`${args[at]}: no such option`);
    else sites.push(args[at]);
  }

  if (sites.length !== 1) throw new Error("name one site");

  return { ...options, site: siteOf(sites[0]) };
};

// Run, not imported by the tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}.`);
    console.error("Usage: node scripts/verify-build.js <site> [--attested] [--keep] [--trusted-ref <ref>]");
    process.exit(2);
  }

  const { attested, keep, site, trustedRef } = options;
  const official = site === TESTNET_SITE || site === MAINNET_SITE;
  let manifest;
  let served;

  try {
    served = await fetchFrom(new URL(MANIFEST, site).href, { limit: MAX_MANIFEST });
    manifest = readManifest(served);
  } catch (error) {
    console.error(`${site} ${error.message}.`);
    process.exit(2);
  }

  // The manifest as it was served, which GitHub attests by its SHA-256, from
  // the ref the Deploy workflow deploys the site from.
  if (attested) {
    const ref = sourceRefOf(site, manifest.version);

    if (!ref) {
      console.error(`${REPOSITORY}'s Deploy workflow doesn't deploy ${site}: no attestation of it can be checked.`);
      process.exit(2);
    }

    const file = join(mkdtempSync(join(tmpdir(), "dusk-bridge-attested-")), MANIFEST);

    writeFileSync(file, served);

    try {
      execFileSync("gh", attestationArgs(file, manifest.commit, ref), { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      process.stderr.write(error.stderr ?? `${error.message}\n`);
      console.error(`${site}${MANIFEST} has no attestation of ${REPOSITORY}'s Deploy workflow for ${manifest.commit} from ${ref}.`);
      process.exit(1);
    }

    console.log(`GitHub attests ${REPOSITORY}'s Deploy workflow built ${site}${MANIFEST} from ${manifest.commit}, on ${ref}.`);
  }

  const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: "pipe" }).trim();

  // Only a commit from where the site is deployed from is built, never one by
  // its hash alone: GitHub gives a fork's commit by its hash too, and building
  // it runs its code.
  try {
    const source = trustedSourceOf(site, manifest.version, trustedRef);

    if (!source) {
      throw new Error(`${REPOSITORY}'s Deploy workflow doesn't deploy ${site}: name a ref you trust its build is from, with --trusted-ref`);
    }

    checkSource(git, manifest.commit, source);
  } catch (error) {
    console.error(`${error.message}.`);
    process.exit(2);
  }

  // The settings the site is built with, as its commit lists them; how this
  // checkout's differ is drift, which is said and fails nothing.
  const here = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));
  const { differ, drift, listed } = settingsCheck(site, manifest.settings, deploymentsAt(git, manifest.commit), here);

  for (const key of differ) {
    console.log(`  ${key}: ${manifest.settings.get(key) ?? "none"} on the site, ${listed[key] ?? "none"} listed`);
  }

  if (differ.length) {
    console.log(`${site} isn't built with its settings in deployments.json at ${manifest.commit}.`);
    process.exit(1);
  }

  if (!listed && official) {
    console.error(`deployments.json at ${manifest.commit} lists no settings for ${site}: it isn't the Deploy workflow's build.`);
    process.exit(1);
  }

  if (!listed) {
    console.warn(`deployments.json at ${manifest.commit} doesn't list ${site}: its settings are its own.`);
    for (const [key, value] of manifest.settings) console.warn(`  ${key}=${value}`);
  }

  if (drift.length) {
    console.warn(`Drift: this checkout's deployments.json gives ${site} other settings than ${manifest.commit} built it with, for a later deploy:`);
    for (const key of drift) console.warn(`  ${key}: ${listed[key] ?? "none"} built, ${here?.[site]?.[key] ?? "none"} here`);
  }

  if (manifest.node && manifest.node !== process.version) {
    console.warn(`The site was built with Node ${manifest.node}, not ${process.version}.`);
  }

  const dir = mkdtempSync(join(tmpdir(), "dusk-bridge-verify-"));
  let result;

  try {
    git("-c", "core.autocrlf=false", "worktree", "add", "--quiet", "--detach", dir, manifest.commit);

    // At least the npm the commit asks for, which Node's own may not be.
    const { engines } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const floor = engines?.npm?.match(/^>=\s*(\d+\.\d+\.\d+)$/)?.[1];
    // The site's settings, and none of this shell's own.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITE_|NODE_ENV$|NODE_OPTIONS$)/.test(key)));
    const npm = (...npmArgs) => {
      try {
        execFileSync(...npmCommand(floor, npmArgs), {
          cwd: dir,
          env: { ...env, ...(listed ?? Object.fromEntries(manifest.settings)) },
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        // What npm or the build said, only when it fails.
        process.stderr.write(error.stderr ?? "");
        throw error;
      }
    };

    console.log(`Building ${manifest.commit} (${manifest.version}) in ${dir}`);
    npm("ci", "--ignore-scripts", "--no-audit", "--no-fund");
    npm("run", "build", "--", "--mode", manifest.mode);

    result = await compareSite(site, hashFiles(join(dir, OUT_DIR)), manifest.files, (at, to) => fetchFrom(at, { to }).catch(() => null));

    const short = (hash) => (/^[0-9a-f]{64}$/.test(hash ?? "") ? hash.slice(0, 12) : (hash ?? "none"));

    for (const { address, inManifest, rebuild, served: there } of result.differences) {
      console.log(`  ${new URL(address).pathname}: rebuild ${short(rebuild)}, manifest ${short(inManifest)}, site ${rebuild ? short(there) : "not fetched"}`);
    }

    console.log(
      result.differences.length
        ? `${result.differences.length} addresses differ, of ${result.checked} fetched.`
        : `All ${result.checked} addresses match: ${site} serves what ${manifest.commit} builds${listed ? " with its settings in deployments.json" : ""}, as its manifest says.`,
    );
  } finally {
    if (keep) {
      console.log(`The rebuild is kept in ${dir}`);
    } else {
      git("worktree", "remove", "--force", dir);
    }
  }

  process.exit(result.differences.length ? 1 : 0);
}
