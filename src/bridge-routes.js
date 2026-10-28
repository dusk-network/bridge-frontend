const defineRoute = (route) => Object.freeze(route);

export const networks = Object.freeze({
  bsc: Object.freeze({ id: "bsc", kind: "evm", label: "BNB Smart Chain" }),
  duskL1: Object.freeze({ id: "dusk-l1", kind: "dusk", label: "Dusk L1" }),
  duskMainnet: Object.freeze({
    id: "dusk-mainnet",
    kind: "dusk",
    label: "Dusk Mainnet",
  }),
  duskEvm: Object.freeze({ id: "dusk-evm", kind: "evm", label: "DuskEVM" }),
  ethereum: Object.freeze({ id: "ethereum", kind: "evm", label: "Ethereum" }),
});

export const bridgeRoutes = Object.freeze([
  defineRoute({
    amountDecimals: 18,
    from: networks.ethereum,
    id: "ethereum-to-dusk",
    mode: "migration",
    signer: "evm",
    to: networks.duskMainnet,
  }),
  defineRoute({
    amountDecimals: 18,
    from: networks.bsc,
    id: "bsc-to-dusk",
    mode: "migration",
    signer: "evm",
    to: networks.duskMainnet,
  }),
  defineRoute({
    amountDecimals: 9,
    from: networks.duskMainnet,
    id: "dusk-to-bsc",
    mode: "service-transfer",
    signer: "dusk",
    to: networks.bsc,
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
