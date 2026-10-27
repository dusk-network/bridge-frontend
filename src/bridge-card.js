// The bridge card's model: which networks pair into a route, what the flip
// does, which pair the card opens with, and what its one button says. Pure:
// the routes, the wallets and the quote come in.

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

/** Each network as a From choice: those no route starts on are disabled. */
export function fromChoices(routes, current, nameOf) {
  return cardNetworks(routes).map((id) =>
    routes.some((route) => route.from.id === id)
      ? { id, selected: id === current }
      : { disabled: `Nothing leaves ${nameOf(id)} through this bridge`, id },
  );
}

/** Each network as a To choice from `from`: those no route reaches are disabled, with why. */
export function toChoices(routes, from, current, nameOf) {
  return cardNetworks(routes).map((id) => {
    if (id === from) return { disabled: "It's where it comes from", id };
    const route = routeBetween(routes, from, id);
    return route ? { id, route, selected: id === current } : { disabled: `No route from ${nameOf(from)}`, id };
  });
}

/**
 * The route for a choice: the one between `from` and `to` when there is
 * one, else the first route from `from`, which is its only one when it has
 * one. Null only when no route starts there.
 */
export function choosePair(routes, { from, to }) {
  return routeBetween(routes, from, to) ?? routes.find((route) => route.from.id === from) ?? null;
}

/**
 * Where the card opens: Dusk to DuskEVM with Dusk Wallet connected (or no
 * wallet at all), Ethereum to Dusk with only an EVM wallet. A network
 * without DuskEVM opens on its route from Dusk.
 */
export function defaultPair(routes, { dusk = false, evm = false } = {}) {
  const fromDusk = routeBetween(routes, "dusk", "dusk-evm") ?? routes.find((route) => route.from.id === "dusk");
  if (evm && !dusk)
    return routeBetween(routes, "ethereum", "dusk") ?? routeBetween(routes, "bsc", "dusk") ?? fromDusk ?? routes[0] ?? null;
  return fromDusk ?? routes[0] ?? null;
}

/** The way back, when the bridge has one: what the flip button swaps to. */
export const flipRoute = (routes, route) => (route ? routeBetween(routes, route.to.id, route.from.id) : null);

/**
 * The card's one button, as the state stands: what it says, whether it can
 * be pressed, and what it does then ("review", "connect-dusk",
 * "connect-evm", or "get-dusk", a link to Dusk Wallet).
 */
export function primaryButton({
  amountLux = null,
  amountError = "",
  destination = "",
  destinationError = "",
  duskInstalled = false,
  insufficient = false,
  looking = "",
  phoneOnly = false,
  route,
  signerConnected = false,
  unit = "DUSK",
}) {
  if (!signerConnected) {
    if (route.signer !== "dusk") return { action: "connect-evm", enabled: true, label: "Connect EVM wallet" };
    if (duskInstalled) return { action: "connect-dusk", enabled: true, label: "Connect Dusk Wallet" };
    return phoneOnly
      ? { action: null, enabled: false, label: "Send from a computer" }
      : { action: "get-dusk", enabled: true, label: "Get Dusk Wallet" };
  }
  if (amountLux === null) return { action: null, enabled: false, label: amountError ? "Enter a valid amount" : "Enter an amount" };
  if (insufficient) return { action: null, enabled: false, label: `Not enough ${unit}` };
  if (amountError) return { action: null, enabled: false, label: "Check the amount" };
  if (looking) return { action: null, enabled: false, label: `Looking up ${looking}…` };
  if (destinationError) return { action: null, enabled: false, label: "Fix the recipient" };
  if (!destination) return { action: null, enabled: false, label: "Add a recipient" };
  return { action: "review", enabled: true, label: "Review bridge" };
}
