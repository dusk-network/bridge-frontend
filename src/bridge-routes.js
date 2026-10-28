import { routes as networkRoutes } from "@dusk-network/networks";

import { config } from "./config.js";
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
 * order), the operated Dusk -> EVM transfer, and DuskEVM once its
 * contracts and endpoints are set. A route that isn't running stays,
 * marked `paused`: it's shown as not running, and the transfers on it are
 * still followed.
 */
export function buildRoutes(cfg) {
  const paused = new Set(cfg.pausedRoutes ?? []);
  const all = networkRoutes(cfg.network);
  const side = (id) => Object.freeze({ id, kind: id === "dusk" ? "dusk" : "evm", label: networkName(cfg, id) });
  const chosen = [
    ...cfg.migrations.map((chain) => all.find((route) => route.kind === "migration" && route.from === chain)),
    all.find((route) => route.kind === "service" && route.to === cfg.service?.network),
    ...(cfg.duskEvm.enabled ? all.filter((route) => route.kind === "duskevm-deposit" || route.kind === "duskevm-withdrawal") : []),
  ].filter(Boolean);
  return Object.freeze(
    chosen.map((route) =>
      Object.freeze({
        // Dusk holds whole Lux, so every route moves at most 9 decimals.
        amountDecimals: 9,
        from: side(route.from),
        id: route.id,
        mode: MODES[route.kind],
        paused: paused.has(route.id),
        signer: route.from === "dusk" ? "dusk" : "evm",
        to: side(route.to),
      }),
    ),
  );
}

export const bridgeRoutes = buildRoutes(config);

export const getBridgeRoute = (routeId) =>
  bridgeRoutes.find(({ id }) => id === routeId);
