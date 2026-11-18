// One name per chain per network. Dusk and DuskEVM keep their names on both
// networks, next to the network badge. Ethereum and BNB Smart Chain go by what
// the network's file calls them on this network, as the web wallet, the
// extension and a wallet adding the chain do: "BSC test chain" and "Sepolia"
// on testnet.

import { networks } from "@dusk-network/networks";

export function networkNames(cfg) {
  return Object.freeze({
    badge: cfg.profile === "testnet" ? "Testnet" : "Mainnet",
    bsc: cfg.evmNetworks?.bsc?.chainName ?? "BNB Smart Chain",
    dusk: "Dusk",
    "dusk-evm": "DuskEVM",
    ethereum: cfg.evmNetworks?.ethereum?.chainName ?? "Ethereum",
  });
}

/**
 * DUSK on an EVM chain, by its token standard: "BEP20 DUSK" on BNB Smart
 * Chain, "ERC20 DUSK" on Ethereum. It's what a migration takes and what a
 * transfer to that chain pays out.
 */
export const tokenName = (id) => (id === "bsc" ? "BEP20 DUSK" : "ERC20 DUSK");

/** What a network holds of DUSK: ERC20 or BEP20 DUSK on Ethereum and BNB Smart Chain, DUSK on Dusk and DuskEVM. */
const unitOn = (side) => (side.kind === "evm" && side.id !== "dusk-evm" ? tokenName(side.id) : "DUSK");

/**
 * What a route takes and pays: "ERC20 DUSK" in, "DUSK" out, for a migration
 * from Ethereum. A Hyperlane route moves its token by its own symbol on both
 * sides: "EURd" in, "EURd" out.
 */
export const routeUnits = (route) =>
  route.mode === "hyperlane" ? { receive: route.token.symbol, send: route.token.symbol } : { receive: unitOn(route.to), send: unitOn(route.from) };

/** The name of a network by id: "dusk", "dusk-evm", "ethereum" or "bsc". */
export const networkName = (cfg, id) => networkNames(cfg)[id] ?? String(id);

/**
 * The chain an EVM wallet is on, by its chain ID: this network's own name for
 * it, or else what a Dusk network's file calls it, as "Ethereum" for chain 1
 * on testnet. A chain none of them has goes by its number.
 */
export function chainName(cfg, chainId) {
  if (!chainId) return "";
  if (cfg.duskEvm?.enabled && chainId === cfg.duskEvm.chainId) return networkName(cfg, "dusk-evm");
  const own = Object.values(cfg.evmNetworks ?? {}).find((network) => network.configured && network.chainId === chainId);
  if (own) return networkName(cfg, own.id);
  for (const net of Object.values(networks)) {
    const chain = Object.values(net.routes.chains).find((each) => each.chainId === chainId);
    if (chain) return chain.name;
    if (net.duskEvm?.chainId === chainId) return net.duskEvm.name;
  }
  return `chain ${chainId}`;
}

/** The coin that pays gas on an EVM chain. */
export const gasCoin = (cfg, id) =>
  id === "dusk-evm" ? "DUSK" : (cfg.evmNetworks[id]?.currency?.symbol ?? "ETH");

/** Why a paused route can't be used: "Not running on testnet right now". */
export const notRunning = (cfg) => `Not running on ${networkNames(cfg).badge.toLowerCase()} right now`;

/**
 * The bridge's three routes: BNB Smart Chain ↔ Dusk, one route
 * both ways; Ethereum → Dusk, one way, since the ERC20 contract can't mint;
 * and Dusk ↔ DuskEVM. Each lists its directions, the way into Dusk first
 * (or out to DuskEVM); a link to the route opens the first that runs. A
 * chain Hyperlane reaches has its routes there too: Sepolia ↔ Dusk on
 * testnet, each token both ways.
 */
export function bridgeTasks(cfg, routes) {
  const names = networkNames(cfg);
  const tasks = [];
  const chain = (id) => {
    const into = routes.filter((route) => (route.mode === "migration" || route.mode === "hyperlane") && route.from.id === id);
    const out = routes.filter((route) => (route.mode === "service-transfer" || route.mode === "hyperlane") && route.to.id === id);
    if (!into.length && !out.length) return;
    const both = into.length && out.length;
    tasks.push({
      id,
      routes: [...into, ...out],
      title: into.length ? `${names[id]} ${both ? "↔" : "→"} Dusk` : `Dusk → ${names[id]}`,
    });
  };
  chain("bsc");
  chain("ethereum");
  const duskEvm = ["duskevm-deposit", "duskevm-withdrawal"].flatMap((mode) => routes.filter((route) => route.mode === mode));
  if (duskEvm.length) tasks.push({ id: "duskevm", routes: duskEvm, title: `Dusk ↔ ${names["dusk-evm"]}` });
  return tasks;
}

/** Earlier links' names for a route: `#/move/migrate` and the like still open it. */
const LINK_NAMES = Object.freeze({
  "from-duskevm": (route) => route.mode === "duskevm-withdrawal",
  migrate: (route) => route.mode === "migration",
  "to-duskevm": (route) => route.mode === "duskevm-deposit",
});

/**
 * The route a link names (`#/move/<name>`): a route by its ID
 * ("bsc-to-dusk"), one of the three routes ("bsc", "ethereum", "duskevm"), or
 * an earlier name ("migrate", "to-duskevm", "from-duskevm", "to-bsc"). Null
 * when this network's bridge has none.
 */
export function linkedRoute(name, tasks, routes) {
  const byLink = LINK_NAMES[name];
  // One of several routes: the first that runs, else the first.
  const running = (list) => list.find((route) => !route.paused) ?? list[0] ?? null;
  const task = tasks.find((item) => item.id === name);
  return (
    routes.find((route) => route.id === name) ??
    (task ? running(task.routes) : null) ??
    (byLink ? running(routes.filter(byLink)) : null) ??
    routes.find((route) => route.mode === "service-transfer" && name === `to-${route.to.id}`) ??
    null
  );
}

/** "DuskEVM to Dusk": a route in a list row. */
export const routeTitle = (cfg, route) =>
  `${networkName(cfg, route.from.id)} to ${networkName(cfg, route.to.id)}`;
