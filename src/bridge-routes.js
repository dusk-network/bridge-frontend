const defineRoute = (route) => Object.freeze(route);

export const networks = Object.freeze({
  bsc: Object.freeze({ id: "bsc", kind: "evm", label: "BNB Smart Chain" }),
  dusk: Object.freeze({ id: "dusk", kind: "dusk", label: "Dusk Mainnet" }),
  duskEvm: Object.freeze({ id: "dusk-evm", kind: "evm", label: "DuskEVM" }),
  ethereum: Object.freeze({ id: "ethereum", kind: "evm", label: "Ethereum" }),
});

export const bridgeRoutes = Object.freeze([
  defineRoute({
    from: networks.ethereum,
    id: "ethereum-to-dusk",
    signer: "evm",
    to: networks.dusk,
  }),
  defineRoute({
    from: networks.bsc,
    id: "bsc-to-dusk",
    signer: "evm",
    to: networks.dusk,
  }),
  defineRoute({
    from: networks.dusk,
    id: "dusk-to-bsc",
    signer: "dusk",
    to: networks.bsc,
  }),
  defineRoute({
    from: networks.dusk,
    id: "dusk-to-dusk-evm",
    signer: "dusk",
    to: networks.duskEvm,
  }),
  defineRoute({
    from: networks.duskEvm,
    id: "dusk-evm-to-dusk",
    signer: "evm",
    to: networks.dusk,
  }),
]);

export const getBridgeRoute = (routeId) =>
  bridgeRoutes.find(({ id }) => id === routeId);

