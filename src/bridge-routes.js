import { routes as networkRoutes } from "@dusk-network/networks";

import { config } from "./config.js";
import { DUSK_TOKEN } from "./hyperlane.js";
import { networkName } from "./names.js";

/** What the bridge calls each kind of route in the networks' files. */
const MODES = Object.freeze({
  "duskevm-deposit": "duskevm-deposit",
  "duskevm-withdrawal": "duskevm-withdrawal",
  migration: "migration",
  service: "service-transfer",
});

/**
 * The routes one deployment offers: its network's own, from its file in
 * @dusk-network/networks, those the deployment runs: migrations of ERC20
 * and BEP20 DUSK into Dusk from the chains it migrates from (in the card's
 * order), the operated Dusk -> EVM transfer, DuskEVM once its contracts
 * and endpoints are set, and Hyperlane's routes where the network has a
 * deployment (testnet's, to Sepolia). A route that isn't running stays,
 * marked `paused`: it's shown as not running, and the transfers on it are
 * still followed.
 */
/**
 * The network as this deployment runs it: routes it pauses or starts, by
 * `pausedRoutes`, in place of what the network's file says.
 */
export function deployedNetwork(cfg) {
  const paused = new Set(cfg.pausedRoutes ?? []);
  const set = (list) => list?.map((route) => ({ ...route, running: !paused.has(route.id) }));
  const { routes } = cfg.network;
  return {
    ...cfg.network,
    routes: { ...routes, duskEvm: set(routes.duskEvm), migrations: set(routes.migrations), services: set(routes.services) },
  };
}

export function buildRoutes(cfg) {
  const paused = new Set(cfg.pausedRoutes ?? []);
  const all = networkRoutes(cfg.network);
  const side = (id) => Object.freeze({ id, kind: id === "dusk" ? "dusk" : "evm", label: networkName(cfg, id) });
  const chosen = [
    ...cfg.migrations.map((chain) => all.find((route) => route.kind === "migration" && route.from === chain)),
    all.find((route) => route.kind === "service" && route.to === cfg.service?.network),
    ...(cfg.duskEvm.enabled ? all.filter((route) => route.kind === "duskevm-deposit" || route.kind === "duskevm-withdrawal") : []),
  ].filter(Boolean);
  const own = chosen.map((route) =>
    Object.freeze({
      // Dusk holds whole Lux, so each of these moves DUSK to at most 9 decimals.
      amountDecimals: 9,
      from: side(route.from),
      id: route.id,
      mode: MODES[route.kind],
      paused: paused.has(route.id),
      signer: route.from === "dusk" ? "dusk" : "evm",
      to: side(route.to),
      token: DUSK_TOKEN,
      // What a card keeps when its pair changes: DUSK, as these routes move it.
      tokenKey: "dusk",
    }),
  );
  return Object.freeze([...own, ...hyperlaneRoutes(cfg, { paused, side })]);
}

/**
 * Hyperlane's routes, each token both ways between Dusk and the EVM chain of
 * this network's deployment, in its record's order: DUSK, then the tokens
 * issued on Dusk. Each moves its token's decimals, the same on both sides.
 */
function hyperlaneRoutes(cfg, { paused, side }) {
  const hyperlane = cfg.hyperlane;
  if (!hyperlane?.enabled) return [];
  const route = (id, from, to, token) =>
    Object.freeze({
      amountDecimals: token.decimals,
      from: side(from),
      // The token's contracts on each side, as its record names them.
      hyperlane: token,
      id,
      mode: "hyperlane",
      paused: paused.has(id),
      signer: from === "dusk" ? "dusk" : "evm",
      to: side(to),
      token: Object.freeze({ decimals: token.decimals, name: token.name, symbol: token.symbol }),
      // Hyperlane's own: its DUSK on Sepolia is another token than the ERC20 DUSK Sepolia's routes move.
      tokenKey: `hyperlane-${token.symbol.toLowerCase()}`,
    });
  return hyperlane.tokens.flatMap((token) => [
    route(token.routes.out, "dusk", hyperlane.network, token),
    route(token.routes.in, hyperlane.network, "dusk", token),
  ]);
}

export const bridgeRoutes = buildRoutes(config);

export const getBridgeRoute = (routeId) =>
  bridgeRoutes.find(({ id }) => id === routeId);
