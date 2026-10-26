// One name per chain per network. Dusk and DuskEVM keep their names on both
// networks, next to the network badge; the old-token chains name their
// testnet in brackets. Wallet chain names (config `chainName`) are separate:
// they're what a wallet lists, not what this page says.

export function networkNames(cfg) {
  const testnet = cfg.profile === "testnet";
  return Object.freeze({
    badge: testnet ? "Testnet" : "Mainnet",
    bsc: testnet ? "BNB Smart Chain (testnet)" : "BNB Smart Chain",
    dusk: "Dusk",
    "dusk-evm": "DuskEVM",
    ethereum: testnet ? "Ethereum (Sepolia)" : "Ethereum",
  });
}

/** The name of a network by id: "dusk", "dusk-evm", "ethereum" or "bsc". */
export const networkName = (cfg, id) => networkNames(cfg)[id] ?? String(id);

/** The coin that pays gas on an EVM chain. */
export const gasCoin = (cfg, id) =>
  id === "dusk-evm" ? "DUSK" : (cfg.evmNetworks[id]?.currency?.symbol ?? "ETH");

/**
 * A task on the start page: the routes it covers and what it's called. The
 * old-token migrations are one task with a chain to pick.
 */
export function bridgeTasks(cfg, routes) {
  const names = networkNames(cfg);
  const tasks = [];
  const migrations = routes.filter((route) => route.mode === "migration");
  if (migrations.length)
    tasks.push({
      id: "migrate",
      routes: migrations,
      title: "Move old DUSK to Dusk",
      what: `You hold DUSK as a token on ${migrations.map((route) => names[route.from.id]).join(" or ")}`,
    });
  const deposit = routes.find((route) => route.mode === "duskevm-deposit");
  if (deposit)
    tasks.push({
      id: "to-duskevm",
      routes: [deposit],
      title: "Move DUSK to DuskEVM",
      what: "For apps on DuskEVM that use an EVM wallet. Not needed for old DUSK.",
    });
  const withdrawal = routes.find((route) => route.mode === "duskevm-withdrawal");
  if (withdrawal)
    tasks.push({
      id: "from-duskevm",
      routes: [withdrawal],
      title: "Move DUSK from DuskEVM to Dusk",
      what: "Back from DuskEVM to your Dusk account",
    });
  const service = routes.find((route) => route.mode === "service-transfer");
  if (service)
    tasks.push({
      id: `to-${service.to.id}`,
      routes: [service],
      title: `Send DUSK to ${names[service.to.id]}`,
      what: `As DUSK tokens on ${names[service.to.id]}`,
    });
  return tasks;
}

/** "DuskEVM to Dusk": a route in a list row. */
export const routeTitle = (cfg, route) =>
  `${networkName(cfg, route.from.id)} to ${networkName(cfg, route.to.id)}`;

/** The task a route belongs to. */
export const taskIdFor = (route) =>
  route.mode === "migration"
    ? "migrate"
    : route.mode === "duskevm-deposit"
      ? "to-duskevm"
      : route.mode === "duskevm-withdrawal"
        ? "from-duskevm"
        : `to-${route.to.id}`;
