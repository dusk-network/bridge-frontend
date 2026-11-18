import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MANIFEST, hashFiles, modeOf, uncommittedOf, viteEnv } from "./build.js";
import {
  MAINNET_SITE,
  REPOSITORY,
  TESTNET_SITE,
  UPSTREAM,
  attestationArgs,
  checkSource,
  compareSite,
  deploymentsAt,
  fetchFrom,
  npmCommand,
  parseArgs,
  readManifest,
  settingsCheck,
  settingsDiffer,
  siteOf,
  sourceRefOf,
  trustedSourceOf,
} from "./verify-build.js";

const SITE = new URL("https://bridge.example/");
const COMMIT = "a".repeat(40);
const hash = (digit) => digit.repeat(64);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

/** A manifest as a build writes it, with the changes given. */
const manifest = (changes = {}) =>
  Buffer.from(
    JSON.stringify({
      commit: COMMIT,
      files: {
        "assets/index-Dhqhba-u.js": hash("3"),
        "drivers/optimism_portal_dd_opt.wasm": hash("2"),
        "index.html": hash("1"),
      },
      mode: "production",
      node: "v24.13.0",
      npm: "11.18.0",
      settings: {
        VITE_BRIDGE_PROFILE: "testnet",
        VITE_DUSKEVM_OPTIMISM_PORTAL_DATA_DRIVER_URL: "/drivers/portal.wasm",
        VITE_DUSK_NODE_URL: "https://testnet.nodes.dusk.network",
      },
      version: "0.1.0",
      ...changes,
    }),
  );

/** A site's answers, by address: a response each time it's asked. */
const answering = (served) => async (address) => served[address]?.() ?? new Response(null, { status: 404 });
const redirect = (location, status = 301) => () => new Response(null, { headers: { location }, status });

test("a manifest a build wouldn't write is refused before anything runs, as is a site without one", () => {
  assert.equal(readManifest(manifest()).commit, COMMIT);
  assert.equal(readManifest(manifest()).mode, "production");
  assert.throws(() => readManifest(null), /wasn't built by npm run build/u);

  for (const changes of [
    { settings: { NODE_OPTIONS: "--import=data:text/javascript,x" } },
    { settings: { npm_config_registry: "https://registry.example/" } },
    { settings: { VITE_DUSK_NODE_URL: "https://nodes.dusk.network/\nX=1" } },
    { settings: { VITE_DUSK_NODE_URL: "javascript:alert(1)" } },
    { settings: { VITE_DUSK_NODE_URL: "//elsewhere.example/" } },
    { settings: { VITE_BRIDGE_PROFILE: 1 } },
    { commit: "--upload-pack=touch x" },
    { files: { "../../.bashrc": hash("1") } },
    { files: { "a/./b.js": hash("1") } },
    { files: { "//elsewhere.example/x.js": hash("1") } },
    { files: { "x.js": "not a hash" } },
    { mode: "../production" },
    { node: "v24.13.0\u001b[2K" },
    { version: "latest" },
  ]) {
    assert.throws(() => readManifest(manifest(changes)), /serves a build-manifest\.json with/u, JSON.stringify(changes));
  }
});

test("the page is checked at its address and at its index.html, and every file at its own", async () => {
  const { files } = readManifest(manifest());
  const served = new Map([...files].map(([path, sha]) => [new URL(path, SITE).href, sha]));
  const get = async (address) => served.get(address) ?? null;

  served.set(SITE.href, hash("1"));

  assert.deepEqual(await compareSite(SITE, files, files, get), { checked: 4, differences: [] });

  for (const address of [SITE.href, `${SITE.href}index.html`, `${SITE.href}drivers/optimism_portal_dd_opt.wasm`]) {
    const kept = served.get(address);

    served.set(address, hash("9"));
    assert.deepEqual(
      (await compareSite(SITE, files, files, get)).differences.map(({ address: at, served: there }) => [at, there]),
      [[address, hash("9")]],
    );
    served.set(address, kept);
  }

  // A file the manifest names that the rebuild has not, and one the rebuild has that it doesn't name.
  const more = new Map([...files, ["assets/extra.js", hash("4")]]);

  assert.deepEqual(
    (await compareSite(SITE, files, more, get)).differences.map(({ address }) => address),
    [`${SITE.href}assets/extra.js`],
  );
  assert.deepEqual(
    (await compareSite(SITE, more, files, get)).differences.map(({ address }) => address),
    [`${SITE.href}assets/extra.js`],
  );
});

test("a listed deployment is held to its settings in deployments.json, every one of them", () => {
  assert.deepEqual(
    settingsDiffer(
      { VITE_A: "1", VITE_B: "2" },
      new Map([
        ["VITE_A", "1"],
        ["VITE_B", "3"],
        ["VITE_C", "4"],
      ]),
    ),
    ["VITE_B", "VITE_C"],
  );
  assert.deepEqual(settingsDiffer({ VITE_A: "1" }, new Map([["VITE_A", "1"]])), []);
});

test("the build is in the mode Vite is given, and options a manifest can't say are refused", () => {
  assert.equal(modeOf([]), "production");
  assert.equal(modeOf(["--mode", "staging"]), "staging");
  assert.equal(modeOf(["--mode=staging"]), "staging");
  assert.equal(modeOf(["-m", "staging"]), "staging");
  assert.throws(() => modeOf(["--minify", "false"]), /only --mode/u);
  assert.throws(() => modeOf(["-m", "staging", "--sourcemap"]), /only --mode/u);
  assert.throws(() => modeOf(["--mode", "../staging"]), /a mode is/u);
  assert.throws(() => modeOf(["--mode"]), /a mode is/u);
});

test("the manifest names every file of the build but itself, by its path there, with its SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-bridge-hash-"));

  try {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "assets", "index.js"), "start");
    writeFileSync(join(dir, MANIFEST), "{}");

    assert.deepEqual(
      [...hashFiles(dir)],
      [
        ["assets/index.js", digest("start")],
        ["index.html", digest("<!doctype html>")],
      ],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("one redirect alone is taken: from the page's index.html to the page", async () => {
  const page = "<!doctype html>";
  const get = answering({
    "https://bridge.example/": () => new Response(page),
    "https://bridge.example/assets/x.js": redirect("/elsewhere/x.js"),
    "https://bridge.example/away/index.html": redirect("https://elsewhere.example/"),
    "https://bridge.example/build-manifest.json": redirect("/elsewhere.json"),
    "https://bridge.example/cached/index.html": redirect("/cached/", 304),
    "https://bridge.example/elsewhere/x.js": () => new Response("x"),
    "https://bridge.example/index.html": redirect("/", 307),
    "https://bridge.example/twice/index.html": redirect("/twice/", 308),
    "https://bridge.example/twice/": redirect("/"),
  });
  const at = (path, to = "") => fetchFrom(`https://bridge.example/${path}`, { get, to: to && `https://bridge.example/${to}` });

  assert.equal(await at("index.html", ""), "a redirect");
  assert.equal(await at("index.html", "/"), "a redirect");
  assert.equal(await fetchFrom("https://bridge.example/index.html", { get, to: "https://bridge.example/" }), digest(page));
  assert.equal(await at("assets/x.js"), "a redirect");
  assert.equal(await at("away/index.html", "away/"), "a redirect");
  assert.equal(await at("twice/index.html", "twice/"), "a redirect");
  assert.equal(await at("cached/index.html", "cached/"), null);
  assert.equal(await at("gone.js"), null);
  await assert.rejects(fetchFrom("https://bridge.example/build-manifest.json", { get, limit: 2 ** 21 }), /redirects \/build-manifest\.json/u);
});

test("where the connection failed, it's asked once more, as one kept open while the rebuild ran can have been closed", async () => {
  const page = "<!doctype html>";
  let failures = 1;
  let calls = 0;
  const get = async () => {
    calls += 1;
    if (failures-- > 0) throw new TypeError("fetch failed");
    return new Response(page);
  };

  assert.equal(await fetchFrom("https://bridge.example/", { get }), digest(page));
  assert.equal(calls, 2);

  failures = 2;
  calls = 0;
  await assert.rejects(fetchFrom("https://bridge.example/", { get }), /fetch failed/u);
  assert.equal(calls, 2);
});

test("a site on Cloudflare, which sends the page's index.html on to the page, matches; a script that redirects doesn't, as a browser would fetch its imports from where it lands", async () => {
  const bodies = { "assets/index-x.js": 'import"./chunk.js";', "index.html": "<!doctype html>" };
  const files = new Map(Object.entries(bodies).map(([path, body]) => [path, digest(body)]));
  const served = {
    "https://bridge.example/": () => new Response(bodies["index.html"]),
    "https://bridge.example/assets/index-x.js": () => new Response(bodies["assets/index-x.js"]),
    "https://bridge.example/index.html": redirect("/", 307),
  };
  const compare = () => compareSite(SITE, files, files, (at, to) => fetchFrom(at, { get: answering(served), to }));

  assert.deepEqual(await compare(), { checked: 3, differences: [] });

  served["https://bridge.example/assets/index-x.js"] = redirect("/elsewhere/index-x.js", 302);
  served["https://bridge.example/elsewhere/index-x.js"] = () => new Response(bodies["assets/index-x.js"]);

  assert.deepEqual(
    (await compare()).differences.map(({ address, served: there }) => [address, there]),
    [["https://bridge.example/assets/index-x.js", "a redirect"]],
  );
});

test("npm runs from its own script, as this Node, where it's beside it, and from the PATH otherwise", () => {
  const ci = ["exec", "--yes", "--package=npm@11.18.0", "--", "npm", "ci"];
  const beside = "/node/lib/node_modules/npm/bin/npm-cli.js";

  assert.deepEqual(npmCommand("11.18.0", ["ci"], beside), [process.execPath, [beside, ...ci]]);
  assert.deepEqual(npmCommand("11.18.0", ["ci"], null), ["npm", ci]);
  assert.deepEqual(npmCommand(undefined, ["run", "build"], null), ["npm", ["run", "build"]]);
});

test("every file is checked out as it was committed, whatever the machine's line endings: builds come out the same", () => {
  const committed = execFileSync("git", ["cat-file", "blob", "HEAD:index.html"]);
  const checkedOut = execFileSync("git", ["-c", "core.autocrlf=true", "cat-file", "--filters", "HEAD:index.html"]);

  assert.ok(checkedOut.equals(committed));
  assert.match(readFileSync(new URL("../.gitattributes", import.meta.url), "utf8"), /^\* text=auto eol=lf$/mu);
});

test("GitHub is asked whether the Deploy workflow attested a site's manifest, as served, built from the commit it names on GitHub's own runners, from the ref it deploys the site from", () => {
  assert.equal(REPOSITORY, "dusk-network/dusk-bridge");
  assert.deepEqual(attestationArgs("/tmp/build-manifest.json", COMMIT, "refs/heads/main"), [
    "attestation",
    "verify",
    "/tmp/build-manifest.json",
    "--repo",
    "dusk-network/dusk-bridge",
    "--signer-workflow",
    "dusk-network/dusk-bridge/.github/workflows/deploy.yml",
    "--source-digest",
    COMMIT,
    "--source-ref",
    "refs/heads/main",
    "--deny-self-hosted-runners",
  ]);

  // Testnet from main, mainnet from its release's tag, nothing else.
  assert.equal(sourceRefOf(TESTNET_SITE, "0.1.0"), "refs/heads/main");
  assert.equal(sourceRefOf(MAINNET_SITE, "0.1.0"), "refs/tags/bridge-v0.1.0");
  assert.equal(sourceRefOf(SITE.href, "0.1.0"), null);
  assert.equal(sourceRefOf("https://testnet.bridge.dusk.network/", "0.1.0"), null);

  // As the workflow deploys them, and as deployments.json lists them.
  const listed = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));

  assert.ok(workflow.includes(`SITE: \${{ github.ref_type == 'tag' && '${MAINNET_SITE}' || '${TESTNET_SITE}' }}`));
  assert.ok(workflow.includes("NETWORK: ${{ github.ref_type == 'tag' && 'mainnet' || 'testnet' }}"));
  assert.match(workflow, /branches: \["main"\]\n {4}tags: \["bridge-v\*"\]/u);
  assert.deepEqual(Object.keys(listed).sort(), [MAINNET_SITE, TESTNET_SITE]);
});

test("the Deploy workflow deploys main to testnet, and a release's tag to mainnet only once DEPLOY_MAINNET is \"true\", with the cloudflare environment's token", () => {
  assert.ok(
    workflow.includes(
      "if: >-\n      (github.ref_type == 'branch' && github.ref_name == 'main') ||\n      (github.ref_type == 'tag' &&\n      startsWith(github.ref_name, 'bridge-v') &&\n      vars.DEPLOY_MAINNET == 'true')\n",
    ),
  );
  assert.match(workflow, /\n {4}environment: cloudflare\n/u);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
  assert.match(workflow, /run: deploy\/node_modules\/\.bin\/wrangler deploy --env "\$NETWORK"\n/u);
  // A release's tag names the version its manifest says, which the attestation's ref is found by.
  assert.ok(workflow.includes(`if [ "$GITHUB_REF_NAME" != "bridge-v$version" ]; then`));
});

test("the Deploy workflow attests the manifest it builds, with GitHub's identity for it, before anything is deployed, while the repository is public, and says it doesn't while it's private", () => {
  const at = (text) => workflow.indexOf(text);
  const attest = workflow.slice(at("- name: Attesting the build's manifest"), at("- name: Not attesting"));
  const notice = workflow.slice(at("- name: Not attesting"), at("- name: Placing the build"));

  assert.match(attest, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/u);
  assert.match(attest, /subject-path: dist\/build-manifest\.json\n/u);
  assert.match(attest, /\n {8}if: github\.event\.repository\.private == false\n/u);
  assert.match(notice, /\n {8}if: github\.event\.repository\.private != false\n/u);
  assert.match(notice, /run: echo "::notice title=Not attested::\$GITHUB_REPOSITORY is private, so this build's manifest isn't attested/u);
  assert.match(workflow, /\n {6}attestations: write\n/u);
  assert.match(workflow, /\n {6}id-token: write\n/u);
  assert.ok(at("run: npm run build") < at("actions/attest-build-provenance"));
  assert.ok(at("actions/attest-build-provenance") < at("run: node deploy/stage.js"));
  assert.ok(at("run: node deploy/stage.js") < at("wrangler deploy"));
  // Both lockfiles' packages are old enough and signed, before anything is built.
  assert.ok(workflow.includes("node scripts/verify-package-release-ages.js --days 0.5 --lockfile deploy/package-lock.json"));
  assert.ok(workflow.includes("cd deploy && npm audit signatures"));
  assert.ok(at("npm audit signatures") < at("run: npm run build"));
});

test("a site is its address's root: a transfer's link is the same site, and another path, a query or a user is refused", () => {
  for (const [address, site] of [
    ["https://bridge.dusk.network/#/transfer/0xabc", MAINNET_SITE],
    ["https://bridge.dusk.network/#/move/bsc-to-dusk?to=dusk.dusk", MAINNET_SITE],
    ["https://bridge.testnet.dusk.network", TESTNET_SITE],
    ["https://bridge.testnet.dusk.network/", TESTNET_SITE],
    ["HTTPS://Bridge.Dusk.Network/#/", MAINNET_SITE],
  ]) {
    assert.equal(siteOf(address), site, address);
  }

  for (const [address, why] of [
    ["https://bridge.dusk.network/?x=1", /has a query/u],
    ["https://bridge.dusk.network/?#/transfer/0xabc&x", null],
    ["https://bridge.dusk.network/index.html", /is \/index\.html of its site/u],
    ["https://bridge.dusk.network/wallet/", /is \/wallet\/ of its site/u],
    ["https://user@bridge.dusk.network/", /names a user/u],
    ["ftp://bridge.dusk.network/", /isn't an http\(s\) address/u],
    ["bridge.dusk.network", /isn't an http\(s\) address/u],
  ]) {
    if (why) assert.throws(() => siteOf(address), why, address);
    else assert.equal(siteOf(address), MAINNET_SITE, address);
  }

  assert.deepEqual(parseArgs(["https://bridge.dusk.network/#/transfer/0xabc", "--attested"]), {
    attested: true,
    keep: false,
    site: MAINNET_SITE,
    trustedRef: null,
  });
  assert.equal(parseArgs(["--trusted-ref", "origin/staging", "https://staging.example/"]).trustedRef, "origin/staging");
  assert.equal(parseArgs(["--trusted-ref=v1", "https://staging.example/", "--keep"]).keep, true);
  assert.throws(() => parseArgs(["https://staging.example/", "--trusted-ref", "--upload-pack=touch x"]), /--trusted-ref names a branch/u);
  assert.throws(() => parseArgs(["https://staging.example/", "--trusted-ref"]), /--trusted-ref names a branch/u);
  assert.throws(() => parseArgs(["https://staging.example/", "--force"]), /--force: no such option/u);
  assert.throws(() => parseArgs([MAINNET_SITE, TESTNET_SITE]), /name one site/u);
});

test("a commit is built only from where its site is deployed from, as upstream has it, whatever origin is: testnet's main, mainnet's release tag, another site's trusted ref", () => {
  const root = mkdtempSync(join(tmpdir(), "dusk-bridge-sources-"));
  const run = (cwd) => (...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const upstream = join(root, "upstream");
  const fork = join(root, "fork");
  const clone = join(root, "clone");
  const commit = (git, message) => (git("commit", "--quiet", "--allow-empty", "-m", message), git("rev-parse", "HEAD"));

  try {
    mkdirSync(upstream);
    const up = run(upstream);
    up("init", "--quiet", "-b", "main");
    const released = commit(up, "released");
    up("tag", "-a", "bridge-v0.1.0", "-m", "Release 0.1.0", released);
    const later = commit(up, "later");
    up("checkout", "--quiet", "-b", "feature");
    const feature = commit(up, "a branch of upstream's, not main");
    up("checkout", "--quiet", "main");

    execFileSync("git", ["clone", "--quiet", upstream, fork]);
    const forked = commit(run(fork), "a fork's own main");

    // A clone whose origin is the fork, with a branch of its own besides.
    execFileSync("git", ["clone", "--quiet", fork, clone]);
    const git = run(clone);
    git("checkout", "--quiet", "-b", "pr", later);
    const local = commit(git, "a pull request's, only here");

    const check = (sha, site, version = "0.1.0", trustedRef = null) => {
      try {
        checkSource(git, sha, trustedSourceOf(site, version, trustedRef), upstream);
        return "built";
      } catch (error) {
        return error.message;
      }
    };

    assert.equal(check(later, TESTNET_SITE), "built");
    assert.equal(check(released, TESTNET_SITE), "built");
    assert.match(check(feature, TESTNET_SITE), /isn't in .*'s main's history: not building it/u);
    assert.match(check(local, TESTNET_SITE), /isn't in .*'s main's history/u);
    // Origin's main has it, as `branch --all --contains` would have taken.
    assert.match(git("branch", "--all", "--contains", forked), /origin\/main/u);
    assert.match(check(forked, TESTNET_SITE), /isn't in .*'s main's history/u);

    assert.equal(check(released, MAINNET_SITE), "built");
    assert.match(check(later, MAINNET_SITE), new RegExp(`'s bridge-v0\\.1\\.0 is ${released}, not ${later}: not building it`, "u"));
    assert.match(check(released, MAINNET_SITE, "0.2.0"), /bridge-v0\.2\.0 can't be read/u);

    assert.equal(trustedSourceOf("https://staging.example/", "0.1.0"), null);
    assert.equal(check(local, "https://staging.example/", "0.1.0", "pr"), "built");
    assert.match(check(feature, "https://staging.example/", "0.1.0", "pr"), /isn't in pr's history/u);
    assert.match(check(local, "https://staging.example/", "0.1.0", "no-such-ref"), /no-such-ref can't be read/u);
    assert.throws(() => trustedSourceOf(TESTNET_SITE, "0.1.0", "pr"), /checked against .* alone: --trusted-ref is for other sites/u);
    assert.equal(UPSTREAM, "https://github.com/dusk-network/dusk-bridge.git");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a site is held to the settings deployments.json lists at its commit, and where the checkout's differ, that's drift, which fails nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "dusk-bridge-settings-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const released = { [MAINNET_SITE]: { VITE_BRIDGE_PROFILE: "mainnet", VITE_ETHEREUM_RPC_URL: "https://old.example" } };
  const named = new Map(Object.entries(released[MAINNET_SITE]));

  try {
    git("init", "--quiet", "-b", "main");
    git("commit", "--quiet", "--allow-empty", "-m", "before deployments.json");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(root, "deployments.json"), JSON.stringify(released));
    git("add", "deployments.json");
    git("commit", "--quiet", "-m", "released");
    const commit = git("rev-parse", "HEAD");

    assert.deepEqual(deploymentsAt(git, commit), released);
    assert.equal(deploymentsAt(git, before), null);

    // main has moved mainnet's RPC on, for the next release.
    const here = { [MAINNET_SITE]: { ...released[MAINNET_SITE], VITE_ETHEREUM_RPC_URL: "https://new.example" } };

    assert.deepEqual(settingsCheck(MAINNET_SITE, named, deploymentsAt(git, commit), here), {
      differ: [],
      drift: ["VITE_ETHEREUM_RPC_URL"],
      listed: released[MAINNET_SITE],
    });
    // A site built with other settings than its commit lists fails.
    assert.deepEqual(settingsCheck(MAINNET_SITE, new Map([...named, ["VITE_ETHEREUM_RPC_URL", "https://new.example"]]), released, here).differ, [
      "VITE_ETHEREUM_RPC_URL",
    ]);
    assert.deepEqual(settingsCheck(TESTNET_SITE, named, released, here), { differ: [], drift: [], listed: null });
    assert.equal(settingsCheck("constructor", named, released, here).listed, null);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("what the manifest names that the rebuild hasn't differs without being fetched, however much it names", async () => {
  const { files } = readManifest(manifest());
  const asked = [];
  const listed = new Map([...files, ...Array.from({ length: 1000 }, (_, at) => [`assets/extra-${at}.js`, hash("5")])]);
  const get = async (address) => {
    asked.push(address);
    return address === SITE.href ? hash("1") : (files.get(new URL(address).pathname.slice(1)) ?? null);
  };
  const { checked, differences } = await compareSite(SITE, files, listed, get);

  assert.equal(checked, 4);
  assert.equal(asked.length, 4);
  assert.ok(asked.every((address) => !address.includes("extra-")));
  assert.equal(differences.length, 1000);
  assert.ok(differences.every(({ rebuild, served }) => rebuild === undefined && served === undefined));
});

test("a build with uncommitted changes says so, and no site serving it is verified; NODE_ENV, which no manifest says, never reaches Vite", () => {
  assert.deepEqual(uncommittedOf(" M src/main.js\n?? public/extra.txt\n\n"), ["M src/main.js", "?? public/extra.txt"]);
  assert.deepEqual(uncommittedOf(""), []);
  assert.equal(uncommittedOf(Array.from({ length: 80 }, (_, at) => `?? f${at}`).join("\n")).length, 50);
  assert.throws(() => readManifest(manifest({ uncommitted: ["M src/main.js"] })), /of a build with uncommitted changes, which its commit doesn't build/u);
  assert.deepEqual(viteEnv({ NODE_ENV: "development", PATH: "/bin", VITE_BRIDGE_PROFILE: "testnet" }), { PATH: "/bin", VITE_BRIDGE_PROFILE: "testnet" });
});

test("the Deploy workflow runs the commit's own tests and production audit before anything is attested or deployed, for main and a tag alike", () => {
  const at = (text) => workflow.indexOf(text);
  const step = workflow.slice(at("- name: Checking the commit"), at("- name: Taking the site's settings"));

  assert.equal(step, "- name: Checking the commit\n        run: npm run check\n\n      ");
  assert.ok(at("npm ci --ignore-scripts\n") < at("run: npm run check"));
  assert.ok(at("run: npm run check") < at("run: npm run build"));
  assert.ok(at("run: npm run check") < at("actions/attest-build-provenance"));
  assert.ok(at("run: npm run check") < at("wrangler deploy"));
  assert.match(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.check, /npm test && npm run build && npm run audit:prod/u);
});

test("each lockfile's release ages are checked against its own emergency exceptions, as an unused one fails the check", () => {
  const own = "node scripts/verify-package-release-ages.js --days 0.5 --lockfile deploy/package-lock.json --exceptions deploy/.npm-release-age-exceptions.json\n";

  assert.ok(workflow.includes(`          node scripts/verify-package-release-ages.js --days 0.5\n          ${own}`));

  for (const path of ["../.npm-release-age-exceptions.json", "../deploy/.npm-release-age-exceptions.json"]) {
    assert.deepEqual(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).exceptions, [], path);
  }
});
