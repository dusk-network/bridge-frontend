// The bridge card's model: which assets and networks pair into a route, what the flip
// does, which pair the card opens with, and what its one button says. Pure:
// the routes, the wallets and the quote come in. A paused route is listed,
// disabled with why, and never opened unless a link names it.

import { linkedRoute, routeUnits } from "./names.js";

const CARD_NETWORKS = ["ethereum", "bsc", "dusk", "dusk-evm"];

/**
 * What a route moves, as the card keeps it when its pair changes: DUSK for
 * Dusk's own routes, Hyperlane's tokens by their route family (Hyperlane's
 * DUSK on Sepolia isn't the ERC20 DUSK Sepolia's own routes move).
 */
export const tokenOf = (route) => route?.tokenKey ?? route?.token?.symbol ?? null;

/**
 * The route from one network to another, or null when there is none: of
 * those that run, the one that moves `token` (`tokenOf`), else the first;
 * only where none runs, a paused one, of the token where there is.
 */
export function routeBetween(routes, from, to, token = null) {
  const pair = routes.filter((route) => route.from.id === from && route.to.id === to);
  const running = pair.filter((route) => !route.paused);
  const moving = (list) => (token ? list.find((route) => tokenOf(route) === token) : null);
  return moving(running) ?? running[0] ?? moving(pair) ?? pair[0] ?? null;
}

/**
 * The route for a choice: the one between `from` and `to` when there is
 * one, else the first running route from `from`, which is its only one when
 * it has one; of those, one that moves `token` where one does. Null only
 * when no route starts there.
 */
export function choosePair(routes, { from, to, token = null }) {
  const leaving = routes.filter((route) => route.from.id === from);
  const direct = routeBetween(routes, from, to, token);
  const running = leaving.filter((route) => !route.paused);
  return (direct?.paused ? null : direct) ?? running.find((route) => tokenOf(route) === token) ?? running[0] ?? direct ?? leaving[0] ?? null;
}

/**
 * Each asset has a choice of networks. From keeps To when possible, while
 * To chooses only routes from the existing source. Representations of an
 * asset on the same network stay distinguishable by what the route moves.
 */
export function assetChoices(routes, current, side) {
  if (!current) return [];
  const from = side === "from";
  const isCurrent = (route) => route.id === current.id;
  const unit = (route) => routeUnits(route)[from ? "send" : "receive"];
  const otherUnit = (route) => routeUnits(route)[from ? "receive" : "send"];
  const reachable = routes.filter((route) => from || route.from.id === current.from.id);
  const symbols = new Set(reachable.filter((route) => !route.paused || isCurrent(route)).map((route) => route.token.symbol));
  return [...symbols].map((symbol) => {
    const asset = reachable.filter((route) => route.token.symbol === symbol);
    const networks = CARD_NETWORKS.flatMap((network) => {
      const onNetwork = asset.filter((route) => route[side].id === network);
      const units = new Set(onNetwork.map(unit));
      return [...units].flatMap((label) => {
        let pair = onNetwork.filter((route) => unit(route) === label);
        if (from) {
          const preferred = pair.find(isCurrent) ?? choosePair(pair, { from: network, to: current.to.id, token: tokenOf(current) });
          pair = pair.filter((route) => route.to.id === preferred.to.id);
        }
        const variants = new Set(pair.map(otherUnit));
        return [...variants].map((other) => {
          const matching = pair.filter((route) => otherUnit(route) === other);
          const route = matching.find(isCurrent) ?? matching.find((route) => !route.paused) ?? matching[0];
          const selected = isCurrent(route);
          const note = [label !== symbol || units.size > 1 ? label : "", variants.size > 1 ? `${from ? "Arrives as" : "Sends"} ${other}` : ""].filter(Boolean).join(" · ");
          return { disabled: route.paused && !selected, id: route.id, network, note, selected };
        });
      });
    });
    return { name: asset[0].token.name, networks, selected: current.token.symbol === symbol, symbol };
  });
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

/** The way back, when the bridge runs one, for the same token where there is: what the flip button swaps to. */
export function flipRoute(routes, route) {
  const back = route ? routeBetween(routes, route.to.id, route.from.id, tokenOf(route)) : null;
  return back && !back.paused ? back : null;
}

/**
 * The card's one button, as the state stands: what it says, whether it can
 * be pressed, and what it does then ("review", "connect-dusk", "connect-evm",
 * "switch-chain", "read-again", or "get-dusk", a link to Dusk Wallet). A
 * paused route sends nothing, and says so (`paused`). `switchTo` names the
 * chain a route sends from, where the wallet that signs it is on another,
 * and `switching` says the wallet was asked. `waiting` is a route's approval
 * not read yet ("reading") or that couldn't be read ("failed"): the steps
 * aren't known; or a withdrawal's fee not worked out yet for its call
 * ("fee"), or that couldn't be ("fee-failed"). Review names what's sent
 * (`amountText`, "1 DUSK"); a locked Dusk Wallet (`duskLocked`) is
 * unlocked, as the header says.
 */
export function primaryButton({
  amountLux = null,
  amountError = "",
  amountText = "",
  connectsRecipient = false,
  destination = "",
  destinationError = "",
  duskInstalled = false,
  duskLocked = false,
  insufficient = false,
  looking = "",
  paused = "Paused",
  phoneOnly = false,
  route,
  signerConnected = false,
  switchTo = "",
  switching = false,
  unit = "DUSK",
  waiting = "",
}) {
  if (route.paused) return { action: null, enabled: false, label: paused };
  if (!signerConnected) {
    if (route.signer !== "dusk") return { action: "connect-evm", enabled: true, label: "Connect EVM wallet" };
    if (duskInstalled) return { action: "connect-dusk", enabled: true, label: duskLocked ? "Unlock Dusk Wallet" : "Connect Dusk Wallet" };
    return phoneOnly
      ? { action: null, enabled: false, label: "Send from a computer" }
      : { action: "get-dusk", enabled: true, label: "Get Dusk Wallet" };
  }
  if (switchTo) return switching ? { action: null, enabled: false, label: `Switching to ${switchTo}…` } : { action: "switch-chain", enabled: true, label: `Switch to ${switchTo}` };
  if (amountLux === null) return { action: null, enabled: false, label: amountError ? "Enter a valid amount" : "Enter an amount" };
  if (insufficient) return { action: null, enabled: false, label: `Not enough ${unit}` };
  if (amountError) return { action: null, enabled: false, label: "Check the amount" };
  // A route's approval not read yet decides how many steps there are: nothing to review until it is.
  if (waiting === "reading") return { action: null, enabled: false, label: "Checking the approval…" };
  if (waiting === "failed") return { action: "read-again", enabled: true, label: "Couldn't read the approval. Try again" };
  if (looking) return { action: null, enabled: false, label: `Looking up ${looking}…` };
  if (destinationError) return { action: null, enabled: false, label: "Fix recipient" };
  if (!destination)
    return connectsRecipient
      ? { action: "connect-evm", enabled: true, label: "Connect EVM wallet" }
      : { action: null, enabled: false, label: "Add a recipient" };
  // A withdrawal's fee, worked out for its amount and recipient: nothing to review until it is.
  if (waiting === "fee") return { action: null, enabled: false, label: "Working out the network fee…" };
  if (waiting === "fee-failed") return { action: "read-again", enabled: true, label: "Couldn't work out the network fee. Try again" };
  return { action: "review", enabled: true, label: amountText ? `Review ${amountText}` : "Review" };
}
