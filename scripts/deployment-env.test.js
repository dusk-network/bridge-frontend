import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { networks } from "@dusk-network/networks";

import { configFor } from "./csp.js";
import { envLines } from "./deployment-env.js";
import { MAINNET_SITE, TESTNET_SITE, settingProblem } from "./verify-build.js";

const deployments = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));

/** JSON with comments and trailing commas, as wrangler.jsonc is written. */
function parseJsonc(text) {
  let json = "";

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];

    if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      json += text.slice(at, end + 1);
      at = end;
    } else if (text.startsWith("//", at)) {
      at = text.indexOf("\n", at) - 1;
      if (at < 0) break;
    } else if (text.startsWith("/*", at)) {
      at = text.indexOf("*/", at) + 1;
    } else if (char !== "," || !/^\s*(\/\/[^\n]*\s*)*[}\]]/u.test(text.slice(at + 1))) {
      json += char;
    }
  }

  return JSON.parse(json);
}

const wrangler = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("a site's settings in deployments.json come as lines of KEY=value, and nothing else", () => {
  const lines = envLines(deployments, TESTNET_SITE).split("\n");

  assert.equal(lines.pop(), "");
  assert.deepEqual(Object.fromEntries(lines.map((line) => line.split(/=(.*)/su, 2))), deployments[TESTNET_SITE]);
  assert.ok(lines.includes("VITE_BRIDGE_PROFILE=testnet"));
  assert.deepEqual(lines, lines.toSorted());
});

test("a site deployments.json doesn't list, and a setting that isn't one line of a VITE_ one, are refused", () => {
  assert.throws(() => envLines(deployments, TESTNET_SITE.slice(0, -1)), /deployments\.json doesn't list/u);
  assert.throws(() => envLines(deployments, "constructor"), /deployments\.json doesn't list/u);

  for (const settings of [
    { NODE_OPTIONS: "--import=data:text/javascript,x" },
    { VITE_DUSK_NODE_URL: "https://nodes.dusk.network/\nNODE_OPTIONS=x" },
    { "VITE_A=B": "1" },
    { VITE_DUSK_NODE_URL: "javascript:alert(1)" },
  ]) {
    assert.throws(() => envLines({ [TESTNET_SITE]: settings }, TESTNET_SITE), new RegExp(`deployments\\.json gives ${TESTNET_SITE} a`, "u"));
  }

  for (const settings of Object.values(deployments)) {
    for (const [key, value] of Object.entries(settings)) assert.equal(settingProblem(key, value), "", key);
  }
});

test("each network deploys to its own address, as a Worker of its own serving the build, at that address alone", () => {
  assert.equal(wrangler.main, "deploy/worker.js");
  assert.deepEqual(wrangler.assets, { directory: "./deploy/site" });
  assert.equal(wrangler.workers_dev, false);
  assert.equal(wrangler.preview_urls, false);
  assert.deepEqual(Object.keys(wrangler.env).sort(), ["mainnet", "testnet"]);

  const names = [wrangler.name, ...Object.values(wrangler.env).map(({ name }) => name)];
  const sites = Object.fromEntries(
    Object.entries(wrangler.env).map(([network, { routes }]) => {
      assert.deepEqual(routes, [{ custom_domain: true, pattern: routes[0]?.pattern }]);
      return [network, `https://${routes[0].pattern}/`];
    }),
  );

  // None deploys over another, the one without an environment included.
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(sites, { mainnet: MAINNET_SITE, testnet: TESTNET_SITE });
});

test("each network's site is at the address its network's file gives the bridge, where the web wallet and the explorer link to it", () => {
  for (const [network, site] of [
    ["mainnet", MAINNET_SITE],
    ["testnet", TESTNET_SITE],
  ]) {
    const bridge = networks[network].apps.bridge;

    assert.equal(site, `${bridge}/`, network);
    assert.deepEqual(wrangler.env[network].routes, [{ custom_domain: true, pattern: new URL(bridge).host }]);
    assert.equal(deployments[site]?.VITE_BRIDGE_PROFILE, network);
    assert.equal(deployments[site][`VITE_${network.toUpperCase()}_BRIDGE_URL`], bridge);
  }
});

test("each site is built for its own network, and says its own address as the official one", () => {
  for (const [network, site] of [
    ["mainnet", MAINNET_SITE],
    ["testnet", TESTNET_SITE],
  ]) {
    const settings = deployments[site];
    const cfg = configFor(settings);

    assert.equal(settings.VITE_BRIDGE_PROFILE, network);
    assert.equal(cfg.profile, network);
    // The footer's "Official site", and the other network's link to it.
    assert.equal(`${cfg.links.sites[network]}/`, site);
    for (const [other, url] of Object.entries(cfg.links.sites)) if (url) assert.equal(`${url}/`, other === "mainnet" ? MAINNET_SITE : TESTNET_SITE);
    assert.match(cfg.reown.projectId, /^[0-9a-f]{32}$/u);
    // Its page carries the policy for these settings (scripts/csp.js).
    assert.equal(settings.VITE_PAGE_POLICY, "true");
  }
});

test("each site lists every endpoint its page reads and links to, and they're its network file's: a bump that moves one moves the site's with it", () => {
  for (const site of [MAINNET_SITE, TESTNET_SITE]) {
    const settings = deployments[site];
    const cfg = configFor(settings);
    const file = configFor({ VITE_BRIDGE_PROFILE: settings.VITE_BRIDGE_PROFILE });
    const chains = Object.values(cfg.evmNetworks).filter((network) => network.configured);
    const listed = {
      VITE_DUSK_EXPLORER_URL: [cfg.dusk.explorerUrl, file.dusk.explorerUrl],
      VITE_DUSK_NODE_URL: [cfg.dusk.nodeUrl, file.dusk.nodeUrl],
      ...Object.fromEntries(
        chains.flatMap(({ id }) => {
          const prefix = `VITE_${id.toUpperCase()}`;
          return [
            [`${prefix}_EXPLORER_URL`, [cfg.evmNetworks[id].explorerUrl, file.evmNetworks[id].explorerUrl]],
            [`${prefix}_RPC_URL`, [cfg.evmNetworks[id].rpcUrl, file.evmNetworks[id].rpcUrl]],
          ];
        }),
      ),
      ...(cfg.duskEvm.enabled
        ? {
            VITE_DUSKEVM_EXPLORER_URL: [cfg.duskEvm.explorerUrl, file.duskEvm.explorerUrl],
            VITE_DUSKEVM_L1_BRIDGE_RPC_URL: [cfg.duskEvm.l1BridgeRpcUrl, file.duskEvm.l1BridgeRpcUrl],
            VITE_DUSKEVM_RPC_URL: [cfg.duskEvm.rpcUrl, file.duskEvm.rpcUrl],
          }
        : {}),
    };

    assert.ok(chains.length > 0, site);
    for (const [key, [used, files]] of Object.entries(listed)) {
      assert.equal(settings[key], used, `${site} ${key}`);
      assert.equal(used, files, `${site} ${key}: the network file's is ${files}`);
    }
  }
});

test("the README's preview of testnet's site builds it with testnet's settings, in a mode no other build reads, before Wrangler serves it", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const preview = readme.match(/```sh\n([^`]*wrangler dev --env testnet[^`]*)```/u)?.[1] ?? "";

  assert.deepEqual(preview.trim().split("\n"), [
    "npm ci --ignore-scripts --prefix deploy",
    `node scripts/deployment-env.js ${TESTNET_SITE} > .env.testnet.local`,
    "npm run build -- --mode testnet && NETWORK=testnet node deploy/stage.js",
    "deploy/node_modules/.bin/wrangler dev --env testnet",
  ]);
});
