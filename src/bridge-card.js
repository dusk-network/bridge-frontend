// The bridge card's model: which networks pair into a route, what the flip
// does, which pair the card opens with, and what its one button says. Pure:
// the routes, the wallets and the quote come in. A paused route is listed,
// disabled with why, and never opened unless a link names it.

import { linkedRoute } from "./names.js";

/** The card's networks, in the order its lists show them. */
export const CARD_NETWORKS = ["ethereum", "bsc", "dusk", "dusk-evm"];

/** The networks some route starts or ends on, in the card's order. */
export function cardNetworks(routes) {
  const present = new Set(routes.flatMap((route) => [route.from.id, route.to.id]));
  return CARD_NETWORKS.filter((id) => present.has(id));
}

/** The route from one network to another, or null when there is none. */
export const routeBetween = (routes, from, to) =>
  routes.find((route) => route.from.id === from && route.to.id === to) ?? null;

/**
 * Each network as a From choice: those no route starts on are disabled, and
 * those whose routes are all paused say why (`paused`).
 */
export function fromChoices(routes, current, nameOf, paused = "Not running right now") {
  return cardNetworks(routes).map((id) => {
    const leaving = routes.filter((route) => route.from.id === id);
    if (!leaving.length) return { disabled: `Nothing leaves ${nameOf(id)} through this bridge`, id };
    if (leaving.every((route) => route.paused) && id !== current) return { disabled: paused, id };
    return { id, selected: id === current };
  });
}

/** Each network as a To choice from `from`: those no running route reaches are disabled, with why. */
export function toChoices(routes, from, current, nameOf, paused = "Not running right now") {
  return cardNetworks(routes).map((id) => {
    if (id === from) return { disabled: "It's where it comes from", id };
    const route = routeBetween(routes, from, id);
    if (!route) return { disabled: `No route from ${nameOf(from)}`, id };
    if (route.paused && id !== current) return { disabled: paused, id };
    return { id, route, selected: id === current };
  });
}

/**
 * The route for a choice: the one between `from` and `to` when there is
 * one, else the first running route from `from`, which is its only one when
 * it has one. Null only when no route starts there.
 */
export function choosePair(routes, { from, to }) {
  const leaving = routes.filter((route) => route.from.id === from);
  const direct = routeBetween(routes, from, to);
  return (direct?.paused ? null : direct) ?? leaving.find((route) => !route.paused) ?? direct ?? leaving[0] ?? null;
}

/**
 * Where the card opens: Dusk to DuskEVM with Dusk Wallet connected (or no
 * wallet at all), Ethereum to Dusk with only an EVM wallet. A network
 * without DuskEVM opens on its route from Dusk. Paused routes are passed
 * over while another runs.
 */
export function defaultPair(routes, { dusk = false, evm = false } = {}) {
  const running = routes.filter((route) => !route.paused);
  const pick = (list) => {
    const fromDusk = routeBetween(list, "dusk", "dusk-evm") ?? list.find((route) => route.from.id === "dusk");
    if (evm && !dusk) return routeBetween(list, "ethereum", "dusk") ?? routeBetween(list, "bsc", "dusk") ?? fromDusk ?? list[0] ?? null;
    return fromDusk ?? list[0] ?? null;
  };
  return pick(running) ?? pick(routes);
}

/**
 * The route a page opens the card on: a link's own route (`linkedRoute`),
 * paused or not, or the pair the wallets suggest. A link to a route this
 * network's bridge doesn't have opens none (null), so it says so rather than
 * offering another transfer.
 */
export function cardRoute(page, tasks, routes, wallets = {}) {
  if (page?.page === "move") return linkedRoute(page.task, tasks, routes);
  return defaultPair(routes, wallets);
}

/**
 * Whether the card still follows the wallets as they connect: only while
 * nothing was picked or typed, neither a pair, an amount nor a recipient.
 */
export const followsWallets = (form) => Boolean(form) && !form.pairChosen && !form.amount && !form.recipientInput;

/**
 * The routes into Dusk from Ethereum and BNB Smart Chain, offered under the
 * card for whoever holds DUSK there and doesn't know to pick it as From: the
 * running ones, while the card is on another route.
 */
export const entryRoutes = (routes, current) =>
  current?.mode === "migration" ? [] : routes.filter((route) => route.mode === "migration" && !route.paused);

/**
 * The Dusk recipient a link hands over (`#/move/<route>?to=<account>`), as
 * the web wallet's Migrate can link here with its own account: only for a
 * route that pays a Dusk account, else none.
 */
export const handedOverRecipient = (page, route) =>
  page?.page === "move" && page.to && route?.to.kind === "dusk" ? page.to : "";

/** The way back, when the bridge runs one: what the flip button swaps to. */
export function flipRoute(routes, route) {
  const back = route ? routeBetween(routes, route.to.id, route.from.id) : null;
  return back && !back.paused ? back : null;
}

/**
 * The card's one button, as the state stands: what it says, whether it can
 * be pressed, and what it does then ("review", "connect-dusk", "connect-evm",
 * "switch-chain", or "get-dusk", a link to Dusk Wallet). A paused route sends
 * nothing. `switchTo` names the chain a route sends from, where the wallet
 * that signs it is on another, and `switching` says the wallet was asked.
 */
export function primaryButton({
  amountLux = null,
  amountError = "",
  connectsRecipient = false,
  destination = "",
  destinationError = "",
  duskInstalled = false,
  insufficient = false,
  looking = "",
  phoneOnly = false,
  route,
  signerConnected = false,
  switchTo = "",
  switching = false,
  unit = "DUSK",
}) {
  if (route.paused) return { action: null, enabled: false, label: "Not running right now" };
  if (!signerConnected) {
    if (route.signer !== "dusk") return { action: "connect-evm", enabled: true, label: "Connect EVM wallet" };
    if (duskInstalled) return { action: "connect-dusk", enabled: true, label: "Connect Dusk Wallet" };
    return phoneOnly
      ? { action: null, enabled: false, label: "Send from a computer" }
      : { action: "get-dusk", enabled: true, label: "Get Dusk Wallet" };
  }
  if (switchTo) return switching ? { action: null, enabled: false, label: `Switching to ${switchTo}…` } : { action: "switch-chain", enabled: true, label: `Switch to ${switchTo}` };
  if (amountLux === null) return { action: null, enabled: false, label: amountError ? "Enter a valid amount" : "Enter an amount" };
  if (insufficient) return { action: null, enabled: false, label: `Not enough ${unit}` };
  if (amountError) return { action: null, enabled: false, label: "Check the amount" };
  if (looking) return { action: null, enabled: false, label: `Looking up ${looking}…` };
  if (destinationError) return { action: null, enabled: false, label: "Fix the recipient" };
  if (!destination)
    return connectsRecipient
      ? { action: "connect-evm", enabled: true, label: "Connect EVM wallet" }
      : { action: null, enabled: false, label: "Add a recipient" };
  return { action: "review", enabled: true, label: "Review bridge" };
}
