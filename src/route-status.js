// How a route is doing before someone sends, as far as the chains say
// (@dusk-network/app-core/bridge): read as its card opens, and said in a line
// under the route. It's only ever said: nothing waits for it, and nothing it
// says stops anyone from sending.

import { STATUS_MAX_AGE_MS } from "@dusk-network/app-core/bridge";
import { durationWords } from "@dusk-network/networks/format";

import { formatShort, formatShortDay } from "./format.js";

/** A read that failed outright: it says it doesn't know, like a part that couldn't be read. */
const UNKNOWN = Object.freeze({ canPay: null, lastPayout: null, limit: "mints", paying: "unknown", readSince: null });

/**
 * @param {object} deps
 * @param {(route: object) => Promise<object>} deps.read what `bridgeStatus` says of a route
 * @param {() => void} [deps.onChange] a route's status came in
 * @param {() => number} [deps.now]
 */
export function createRouteStatus({ read, onChange = () => {}, now = Date.now }) {
  const known = new Map();
  const asked = new Map();
  return Object.freeze({
    /** What's known of `route` so far, or null. */
    get: (route) => known.get(route?.id) ?? null,
    /** Reads `route`, once as its card opens and again once what was read is old. A paused route says so itself. */
    open(route) {
      if (!route || route.paused || now() - (asked.get(route.id) ?? -STATUS_MAX_AGE_MS) < STATUS_MAX_AGE_MS) return;
      asked.set(route.id, now());
      read(route)
        .catch(() => UNKNOWN)
        .then((status) => {
          known.set(route.id, status);
          onChange();
        });
    },
  });
}

/** "Last payout 12 minutes ago.", where the chains gave its time. */
const lastPayoutWords = ({ lastPayout }, now) => (lastPayout?.at ? `Last payout ${durationWords(Math.max(0, now - lastPayout.at) / 1_000)} ago.` : "");

/**
 * A route's status in a line, for under its route: `text`, and `warn` where it
 * could make someone wait. Null with nothing to say: nothing read yet, or a
 * route that isn't running, which its card says itself. "unknown" says it
 * doesn't know, not that anything is wrong. `amountLux` is what's being sent.
 */
export function statusLine(status, { amountLux = null, now = Date.now() } = {}) {
  if (!status || status.paying === "stopped") return null;
  const last = lastPayoutWords(status, now);
  const words = {
    late: `Payouts are running late. ${last}`,
    "on-claim": "It pays when you claim it.",
    quiet: last || (status.readSince ? `No payouts since ${formatShortDay(status.readSince)}.` : "No recent payouts."),
    unknown: "Last payout not known right now.",
    yes: `Paying out. ${last}`,
  }[status.paying];
  if (words === undefined) return null;
  const pays = status.limit === "balance" && status.canPay !== null && status.canPay !== undefined ? formatShort(status.canPay).text : "";
  const short = Boolean(pays) && amountLux !== null && amountLux > status.canPay;
  const room = !pays ? "" : short ? `It can pay up to ${pays} DUSK now, less than you're sending, so yours may wait.` : `It can pay up to ${pays} DUSK.`;
  return { text: `${words} ${room}`.trim(), warn: status.paying === "late" || short };
}
