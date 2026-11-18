import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pagePolicy } from "../deploy/stage.js";
import { PAGE_POLICY_SETTING, REOWN, configFor, contentSecurityPolicy, cspDirectives, policyOf, withPolicy } from "./csp.js";
import { MAINNET_SITE, TESTNET_SITE } from "./verify-build.js";

const deployments = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url), "utf8"));
const TESTNET = deployments[TESTNET_SITE];
const MAINNET = deployments[MAINNET_SITE];

/** What WalletConnect and Reown are let do: only with a Reown project. */
const WALLETCONNECT = [
  "https://api.web3modal.org",
  "https://pulse.walletconnect.org",
  "https://rpc.walletconnect.org",
  "https://verify.walletconnect.org",
  "wss://relay.walletconnect.org",
];

test("the page runs its own scripts alone, with WebAssembly for the data drivers, nothing inline, evaluated, framed or in a worker", () => {
  for (const settings of [TESTNET, MAINNET, {}]) {
    const directives = cspDirectives(settings);

    assert.deepEqual(directives["script-src"], ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(directives["default-src"], ["'self'"]);
    assert.deepEqual(directives["object-src"], ["'none'"]);
    assert.deepEqual(directives["base-uri"], ["'self'"]);
    assert.deepEqual(directives["worker-src"], ["'none'"]);
    // Only the header can say it (deploy/stage.js adds it): a page's own policy can't.
    assert.equal(directives["frame-ancestors"], undefined);
    assert.ok(!Object.values(directives).flat().includes("'unsafe-eval'"));
    assert.ok(!directives["script-src"].includes("'unsafe-inline'"));
  }
});

test("testnet's page reads from testnet's node, Sepolia's RPC, DuskEVM's, Dusk Domains' testnet site and WalletConnect, and nothing else", () => {
  const directives = cspDirectives(TESTNET);

  assert.deepEqual(directives["connect-src"], [
    "'self'",
    "https://testnet.nodes.dusk.network",
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://rpc.testnet.evm.dusk.network",
    "https://testnet.dusk.domains",
    ...WALLETCONNECT,
  ]);
  assert.deepEqual(directives["frame-src"], ["https://verify.walletconnect.org"]);
  assert.deepEqual(directives["font-src"], ["'self'", "https://fonts.reown.com"]);
  assert.deepEqual(directives["img-src"], ["'self'", "data:", "blob:", "https://api.web3modal.org"]);
});

test("mainnet's page reads from mainnet's node, Ethereum's and BNB Smart Chain's RPCs, Dusk Domains and WalletConnect, and nothing of testnet's or DuskEVM's yet", () => {
  const connect = cspDirectives(MAINNET)["connect-src"];

  assert.deepEqual(connect, [
    "'self'",
    "https://nodes.dusk.network",
    "https://bsc-rpc.publicnode.com",
    "https://ethereum-rpc.publicnode.com",
    "https://dusk.domains",
    ...WALLETCONNECT,
  ]);
  assert.ok(!connect.some((source) => /testnet|sepolia|evm\.dusk/u.test(source)));
});

test("the page reads from the endpoints its settings name, over the network file's, and from no Reown without a project", () => {
  const own = cspDirectives({
    VITE_BRIDGE_PROFILE: "testnet",
    VITE_DUSKEVM_L1_BRIDGE_RPC_URL: "https://l1.example:8545/adapter",
    VITE_DUSKEVM_RPC_URL: "https://l2.example/",
    VITE_DUSK_NODE_URL: "https://node.example/",
    VITE_ETHEREUM_RPC_URL: "https://sepolia.example/v1/key",
  });

  assert.deepEqual(own["connect-src"], [
    "'self'",
    "https://node.example",
    "https://sepolia.example",
    "https://l2.example",
    "https://l1.example:8545",
    "https://testnet.dusk.domains",
  ]);
  assert.deepEqual(own["frame-src"], ["'none'"]);
  assert.deepEqual(own["font-src"], ["'self'"]);
  assert.deepEqual(own["img-src"], ["'self'", "data:", "blob:"]);

  // A data driver from elsewhere is read from there; the bundled ones are the page's own.
  const driver = cspDirectives({ ...TESTNET, VITE_DUSKEVM_OPTIMISM_PORTAL_DATA_DRIVER_URL: "https://drivers.example/portal.wasm" });

  assert.ok(driver["connect-src"].includes("https://drivers.example"));
  assert.equal(configFor(TESTNET).duskEvm.optimismPortalDriver.url, "/drivers/optimism_portal_dd_opt.wasm");

  // Nor from what the page never reads: DuskEVM where its routes don't run,
  // and a chain it can't use, as one whose token isn't an address.
  const unused = cspDirectives({
    ...MAINNET,
    VITE_BSC_RPC_URL: "https://bsc.example/",
    VITE_BSC_TOKEN_CONTRACT: "not an address",
    VITE_DUSKEVM_L1_BRIDGE_RPC_URL: "https://l1.example/",
    VITE_DUSKEVM_RPC_URL: "https://l2.example/",
  })["connect-src"];

  assert.equal(configFor({ ...MAINNET, VITE_BSC_TOKEN_CONTRACT: "not an address" }).evmNetworks.bsc.configured, false);
  assert.deepEqual(
    unused.filter((source) => source.endsWith(".example")),
    [],
  );
});

test("every EVM chain the page has an RPC for, as Hyperlane's routes reach theirs, and DuskEVM's where its routes run, are let in", () => {
  for (const settings of [TESTNET, MAINNET]) {
    const cfg = configFor(settings);
    const connect = cspDirectives(settings)["connect-src"];
    const chains = Object.values(cfg.evmNetworks).filter((network) => network.configured);

    assert.ok(chains.length > 0);
    for (const { rpcUrl } of chains) assert.ok(connect.includes(new URL(rpcUrl).origin), rpcUrl);
    assert.equal(connect.includes(new URL(cfg.dusk.nodeUrl).origin), true);
    if (cfg.duskEvm.enabled) for (const rpc of [cfg.duskEvm.rpcUrl, cfg.duskEvm.l1BridgeRpcUrl]) assert.ok(connect.includes(new URL(rpc).origin), rpc);
    // Each once.
    assert.equal(new Set(connect).size, connect.length);
  }

  // Settings over none of the page's: the global is as it was.
  assert.equal(Object.hasOwn(globalThis, "__DUSK_BRIDGE_CONFIG__"), false);
});

test("the policy goes in the page's head right after its charset, before anything it loads, and only once", () => {
  const html = '<!doctype html>\n<html><head>\n    <meta charset="UTF-8" />\n    <script type="module" src="/assets/index.js"></script></head></html>';
  const policy = policyOf({ "connect-src": ["'self'", "https://a.example"], "default-src": ["'self'"] });
  const placed = withPolicy(html, policy);

  assert.equal(
    placed,
    `<!doctype html>\n<html><head>\n    <meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="connect-src 'self' https://a.example; default-src 'self'" />\n    <script type="module" src="/assets/index.js"></script></head></html>`,
  );
  assert.throws(() => withPolicy(placed, policy), /carries a Content-Security-Policy already/u);
  assert.throws(() => withPolicy("<!doctype html><title>x</title>", policy), /no <meta charset>/u);
  assert.match(withPolicy(html, `a "quoted" & <tagged>`), /content="a &quot;quoted&quot; &amp; &lt;tagged&gt;"/u);
});

test("the build puts its settings' policy in the page, as Vite gives them to it, and Cloudflare's header is that policy with frame-ancestors", () => {
  const plugin = contentSecurityPolicy();
  const dir = mkdtempSync(join(tmpdir(), "dusk-bridge-csp-"));

  assert.equal(plugin.apply, "build");
  plugin.configResolved({ env: { BASE_URL: "/", MODE: "production", ...TESTNET } });

  try {
    writeFileSync(join(dir, "index.html"), plugin.transformIndexHtml.handler(readFileSync(new URL("../index.html", import.meta.url), "utf8")));

    assert.equal(pagePolicy(dir), `frame-ancestors 'none'; ${policyOf(cspDirectives(TESTNET))}`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("only a build whose settings opt in carries its policy in the page: one a host configures as it loads carries none, as a header can't loosen it", () => {
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const built = (settings) => {
    const plugin = contentSecurityPolicy();

    plugin.configResolved({ env: { BASE_URL: "/", MODE: "production", ...settings } });

    return plugin.transformIndexHtml.handler(page);
  };
  const { VITE_PAGE_POLICY, ...configuredAtRuntime } = TESTNET;

  assert.equal(VITE_PAGE_POLICY, "true");
  assert.equal(PAGE_POLICY_SETTING, "VITE_PAGE_POLICY");
  assert.equal(built({}), page);
  assert.equal(built(configuredAtRuntime), page);
  assert.equal(built({ ...configuredAtRuntime, VITE_PAGE_POLICY: "false" }), page);
  assert.equal(built(TESTNET), withPolicy(page, policyOf(cspDirectives(TESTNET))));
  assert.equal(MAINNET.VITE_PAGE_POLICY, "true");
});

test("Reown's sources are the ones AppKit and WalletConnect connect to, and only them", () => {
  assert.deepEqual(REOWN.connect, WALLETCONNECT);
  assert.ok(Object.isFrozen(REOWN) && Object.values(REOWN).every(Object.isFrozen));
});
