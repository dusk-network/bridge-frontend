import { config } from "./config.js";
import { networkName } from "./names.js";

/**
 * The routes one deployment offers, all on its profile's network:
 * migrations of ERC20 and BEP20 DUSK into Dusk, the operated Dusk -> EVM
 * transfer, and DuskEVM only where its contracts are configured. A route the
 * deployment lists as paused stays, marked `paused`: it's shown as not
 * running, and the transfers on it are still followed.
 */
export function buildRoutes(cfg) {
  const paused = new Set(cfg.pausedRoutes ?? []);
  const dusk = Object.freeze({ id: "dusk", kind: "dusk", label: networkName(cfg, "dusk") });
  const evm = (id) => Object.freeze({ id, kind: "evm", label: networkName(cfg, id) });
  const routes = cfg.migrations.map((id) => ({
    amountDecimals: 9,
    from: evm(id),
    id: `${id}-to-dusk`,
    mode: "migration",
    signer: "evm",
    to: dusk,
  }));
  if (cfg.service)
    routes.push({
      amountDecimals: 9,
      from: dusk,
      id: `dusk-to-${cfg.service.network}`,
      mode: "service-transfer",
      signer: "dusk",
      to: evm(cfg.service.network),
    });
  if (cfg.duskEvm.enabled) {
    const duskEvm = Object.freeze({
      id: "dusk-evm",
      kind: "evm",
      label: networkName(cfg, "dusk-evm"),
    });
    routes.push(
      {
        amountDecimals: 9,
        from: dusk,
        id: "dusk-to-dusk-evm",
        mode: "duskevm-deposit",
        signer: "dusk",
        to: duskEvm,
      },
      {
        // Dusk holds whole Lux, so a withdrawal moves at most 9 decimals.
        amountDecimals: 9,
        from: duskEvm,
        id: "dusk-evm-to-dusk",
        mode: "duskevm-withdrawal",
        signer: "evm",
        to: dusk,
      },
    );
  }
  return Object.freeze(routes.map((route) => Object.freeze({ ...route, paused: paused.has(route.id) })));
}

export const bridgeRoutes = buildRoutes(config);

export const getBridgeRoute = (routeId) =>
  bridgeRoutes.find(({ id }) => id === routeId);
