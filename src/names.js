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

/**
 * The old token's one name, as a token: "old DUSK (ERC20 on Ethereum)" or
 * "(BEP20 on BSC)", on testnet "(ERC20 on Sepolia)" or "(BEP20 on BSC
 * testnet)". It's also what a transfer to that chain pays out.
 */
export function oldTokenName(cfg, id) {
  const testnet = cfg.profile === "testnet";
  return id === "bsc"
    ? `old DUSK (BEP20 on ${testnet ? "BSC testnet" : "BSC"})`
    : `old DUSK (ERC20 on ${testnet ? "Sepolia" : "Ethereum"})`;
}

/** The same, starting a line or a label. */
export const OldTokenName = (cfg, id) => `O${oldTokenName(cfg, id).slice(1)}`;

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
      what: `You hold ${migrations.map((route) => oldTokenName(cfg, route.from.id)).join(" or ")}`,
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
      what: `Paid out as ${oldTokenName(cfg, service.to.id)}`,
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
