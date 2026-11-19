/**
 * The bridge's Content-Security-Policy, as a build's settings make it: its
 * own scripts alone, with WebAssembly for the contracts' data drivers, and
 * the addresses the page reads from, which its own config resolves from the
 * settings and the network's file as the page does (src/config.js): the Dusk
 * node, the EVM chains its routes reach, DuskEVM's RPCs where its routes run,
 * Dusk Domains' site, which serves the name reader's driver, and
 * WalletConnect where a Reown project is set. A build whose settings opt in
 * (VITE_PAGE_POLICY=true, as deployments.json's do) carries it in its page's
 * head (vite.config.js), and Cloudflare sends it as a header too
 * (deploy/stage.js), with frame-ancestors, which a page's own can't say. A
 * build that doesn't, as one a host configures as it loads, through
 * window.__DUSK_BRIDGE_CONFIG__, carries none: a policy made from its own
 * settings would refuse the addresses the host gives it, and a header can't
 * loosen a page's policy. Its host sends one for what it gives.
 */

import { releaseFor } from "@duskdomains/sdk/releases";

import { loadConfig } from "../src/config.js";

/** The setting with which a build opts in, as deployments.json's builds do. */
export const PAGE_POLICY_SETTING = "VITE_PAGE_POLICY";

/**
 * WalletConnect and Reown, as AppKit connects an EVM wallet: its config,
 * wallet list and their pictures, the RPC it reads chains through, the relay,
 * WalletConnect's events, and the frame and key of its Verify API. AppKit's
 * fonts come from there too.
 */
export const REOWN = Object.freeze({
  connect: Object.freeze([
    "https://api.web3modal.org",
    "https://pulse.walletconnect.org",
    "https://rpc.walletconnect.org",
    "https://verify.walletconnect.org",
    "wss://relay.walletconnect.org",
  ]),
  font: Object.freeze(["https://fonts.reown.com"]),
  frame: Object.freeze(["https://verify.walletconnect.org"]),
  img: Object.freeze(["https://api.web3modal.org"]),
});

/** An http(s) address's origin; none for anything else, as a path on this site. */
const originsOf = (address) => {
  const url = URL.parse(String(address ?? ""));

  return url && ["http:", "https:"].includes(url.protocol) ? [url.origin] : [];
};

/**
 * The config a page built with these settings loads (src/config.js): the
 * settings given, over the network's file, as `window.__DUSK_BRIDGE_CONFIG__`
 * gives them to it.
 *
 * @param {Record<string, unknown>} settings A build's VITE_ settings
 */
export function configFor(settings) {
  const had = Object.hasOwn(globalThis, "__DUSK_BRIDGE_CONFIG__");
  const was = globalThis.__DUSK_BRIDGE_CONFIG__;

  globalThis.__DUSK_BRIDGE_CONFIG__ = { ...settings };

  try {
    return loadConfig();
  } finally {
    if (had) globalThis.__DUSK_BRIDGE_CONFIG__ = was;
    else delete globalThis.__DUSK_BRIDGE_CONFIG__;
  }
}

/**
 * The origins a page with this config reads from, each once: its Dusk node
 * (queries, the archive and Multicall for Dusk), each EVM chain it has an RPC
 * for (src/services.js), DuskEVM's RPC and the adapter's where DuskEVM's
 * routes run, the data drivers' where one isn't this site's own, and the site
 * that serves the Dusk Domains release its chain runs (src/dusk-names.js).
 */
export function readsFrom(cfg) {
  return [
    ...new Set([
      ...originsOf(cfg.dusk.nodeUrl),
      ...Object.values(cfg.evmNetworks)
        .filter((network) => network.configured)
        .flatMap((network) => originsOf(network.rpcUrl)),
      ...(cfg.duskEvm.enabled ? [cfg.duskEvm.rpcUrl, cfg.duskEvm.l1BridgeRpcUrl].flatMap(originsOf) : []),
      // Hyperlane's too, where its routes run.
      ...[cfg.duskEvm.optimismPortalDriver?.url, cfg.duskEvm.disputeGameFactoryDriver?.url, cfg.hyperlane?.driver?.url].flatMap(originsOf),
      ...originsOf(releaseFor(cfg.dusk.chainId)?.artifactBaseUrl),
    ]),
  ];
}

/**
 * The policy's directives for a build's settings, keywords quoted:
 * frame-ancestors aside, which a page's own policy can't say.
 *
 * @param {Record<string, unknown>} settings A build's VITE_ settings
 * @returns {Record<string, string[]>}
 */
export function cspDirectives(settings) {
  const cfg = configFor(settings);
  const reown = cfg.reown.projectId ? REOWN : { connect: [], font: [], frame: [], img: [] };

  return {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "connect-src": ["'self'", ...readsFrom(cfg), ...reown.connect],
    "font-src": ["'self'", ...reown.font],
    "form-action": ["'self'"],
    "frame-src": reown.frame.length ? [...reown.frame] : ["'none'"],
    // AppKit shows wallets' pictures from blob: addresses it makes of them.
    "img-src": ["'self'", "data:", "blob:", ...reown.img],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    // The data drivers and the name reader's run as WebAssembly.
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    // AppKit's elements, and the fonts it adds to the page, set styles inline.
    "style-src": ["'self'", "'unsafe-inline'"],
    "worker-src": ["'none'"],
  };
}

/** Directives as a policy's text. */
export const policyOf = (directives) =>
  Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");

const attribute = (text) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The page with its policy in its head, right after its charset: before
 * anything it loads. Refuses a page with no charset to follow, and one that
 * carries a policy already.
 *
 * @param {string} html
 * @param {string} policy
 */
export function withPolicy(html, policy) {
  const charset = /<meta charset="[^"]*"\s*\/?>/iu;

  if (/<meta\s[^>]*http-equiv="content-security-policy"/iu.test(html)) {
    throw new Error("index.html carries a Content-Security-Policy already: the build sets it");
  }

  if (!charset.test(html)) {
    throw new Error("index.html has no <meta charset> for the policy to follow");
  }

  return html.replace(charset, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${attribute(policy)}" />`);
}

/**
 * Vite's plugin that puts the policy in the built page, from the settings Vite
 * gives the page: the mode's .env files under the VITE_ variables it runs
 * with, as deployments.json's in the Deploy workflow and
 * scripts/verify-build.js. Only in a build whose settings opt in
 * (VITE_PAGE_POLICY=true), and only in a build: the dev server's own client
 * connects where the policy wouldn't let it.
 */
export function contentSecurityPolicy() {
  let settings = {};

  return {
    apply: "build",
    configResolved(config) {
      settings = config.env;
    },
    name: "dusk-bridge:content-security-policy",
    transformIndexHtml: {
      handler: (html) => (settings[PAGE_POLICY_SETTING] === "true" ? withPolicy(html, policyOf(cspDirectives(settings))) : html),
      order: "post",
    },
  };
}
