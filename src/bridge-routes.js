import { config } from "./config.js";

const defineRoute = (route) => Object.freeze(route);

export const networks = Object.freeze({
  bsc: Object.freeze({
    id: "bsc",
    kind: "evm",
    label: config.legacy.migrations.bsc.chainName,
  }),
  duskL1: Object.freeze({ id: "dusk-l1", kind: "dusk", label: "Dusk L1" }),
  duskMainnet: Object.freeze({
    id: "dusk-mainnet",
    kind: "dusk",
    label: config.legacy.duskLabel,
  }),
  duskEvm: Object.freeze({ id: "dusk-evm", kind: "evm", label: "DuskEVM" }),
  ethereum: Object.freeze({
    id: "ethereum",
    kind: "evm",
    label: config.legacy.migrations.ethereum.chainName,
  }),
});

const migrationRoutes = config.legacy.migrationKeys.map((networkId) =>
  defineRoute({
    amountDecimals: 18,
    from: networks[networkId],
    id: `${networkId}-to-dusk`,
    mode: "migration",
    signer: "evm",
    to: networks.duskMainnet,
  }),
);

export const bridgeRoutes = Object.freeze([
  ...migrationRoutes,
  defineRoute({
    amountDecimals: 9,
    from: networks.duskMainnet,
    id: `dusk-to-${config.legacy.serviceNetworkId}`,
    mode: "service-transfer",
    signer: "dusk",
    to: networks[config.legacy.serviceNetworkId],
  }),
  defineRoute({
    amountDecimals: 9,
    from: networks.duskL1,
    id: "dusk-to-dusk-evm",
    mode: "duskevm-deposit",
    signer: "dusk",
    to: networks.duskEvm,
  }),
  defineRoute({
    amountDecimals: 18,
    from: networks.duskEvm,
    id: "dusk-evm-to-dusk",
    mode: "duskevm-withdrawal",
    signer: "evm",
    to: networks.duskL1,
  }),
]);

export const getBridgeRoute = (routeId) =>
  bridgeRoutes.find(({ id }) => id === routeId);
