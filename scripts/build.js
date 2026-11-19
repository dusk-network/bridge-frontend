/**
 * `npm run build`: Vite's build, with the arguments given, then
 * dist/build-manifest.json: the version, the commit built, the mode and the
 * public settings it was built with, Node's and npm's versions, and the
 * SHA-256 of every file in the build. It's served beside the app:
 * scripts/verify-build.js rebuilds a site from it and compares, and the
 * Deploy workflow has GitHub attest it. A build of a clone with uncommitted
 * changes says so in its manifest, as its commit doesn't build it: neither
 * deploy/stage.js nor scripts/verify-build.js takes it. Vite builds without
 * the NODE_ENV it's run with, which the manifest couldn't say.
 *
 *   npm run build [-- --mode <mode>]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = "build-manifest.json";

/** Where Vite puts the build. */
export const OUT_DIR = "dist";

/**
 * The mode `vite build` builds in, given its options: --mode alone, since the
 * others change the files in ways the manifest couldn't say.
 *
 * @param {string[]} args
 */
export const modeOf = (args) => {
  let mode = "production";

  for (let at = 0; at < args.length; at += 1) {
    const [option, joined] = args[at].split(/=(.*)/s);

    if (option !== "--mode" && option !== "-m") {
      throw new Error(`${args[at]}: only --mode can be given, since other options change the build in ways its manifest can't say`);
    }

    mode = joined ?? args[(at += 1)];
  }

  if (!/^[\w-]{1,32}$/.test(mode ?? "")) {
    throw new Error(`--mode ${mode ?? ""}: a mode is letters, digits, - and _`);
  }

  return mode;
};

/**
 * Every file in a folder but the manifest, by its path there with "/" between
 * folders, in order, to its SHA-256.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
export const hashFiles = (root) =>
  new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .filter((path) => path !== MANIFEST)
      .sort()
      .map((path) => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]),
  );

/**
 * The environment Vite builds in: this one but NODE_ENV, which changes the
 * files and which no manifest records. Without it, Vite builds for production
 * in any mode, as scripts/verify-build.js rebuilds, which runs it without.
 *
 * @param {Record<string, string | undefined>} env
 */
export const viteEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key !== "NODE_ENV"));

/**
 * What a clone has that its commit hasn't, as `git status --porcelain` lists
 * it: changed and untracked files, but those .gitignore keeps out, as the
 * build's own. At most 50 are named.
 *
 * @param {string} status
 */
export const uncommittedOf = (status) =>
  status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);

// Run, not imported by scripts/verify-build.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let mode;

  try {
    mode = modeOf(args);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let commit;
  let uncommitted;

  try {
    commit = git("rev-parse", "HEAD").trim();
    uncommitted = uncommittedOf(git("status", "--porcelain=v1", "--untracked-files=all"));
  } catch {
    console.error(`${MANIFEST} names the commit built: build in a clone of the repository`);
    process.exit(1);
  }

  if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") {
    console.warn(`Building without NODE_ENV=${process.env.NODE_ENV}, which the manifest couldn't say.`);
  }

  const vite = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
  const { status } = spawnSync(process.execPath, [vite, "build", ...args], { env: viteEnv(process.env), stdio: "inherit" });

  if (status !== 0) {
    process.exit(status ?? 1);
  }

  const { loadEnv } = await import("vite");
  const { homepage, version } = JSON.parse(readFileSync("package.json", "utf8"));

  // Vite puts every VITE_ setting in the code it builds: none is a secret.
  const settings = loadEnv(mode, process.cwd(), "VITE_");
  const manifest = {
    version,
    commit,
    ...(uncommitted.length ? { uncommitted } : {}),
    source: `${homepage}/tree/${commit}`,
    mode,
    node: process.version,
    npm: process.env.npm_config_user_agent?.match(/^npm\/(\S+)/)?.[1],
    settings: Object.fromEntries(Object.entries(settings).sort()),
    files: Object.fromEntries(hashFiles(OUT_DIR)),
  };

  writeFileSync(join(OUT_DIR, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  if (uncommitted.length) {
    console.warn(`Built with uncommitted changes (${uncommitted.slice(0, 3).join(", ")}${uncommitted.length > 3 ? ", …" : ""}): its manifest says so, and it can't be deployed or verified.`);
  }
}
