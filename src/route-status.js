// How a route is doing before someone sends, as far as the chains say
// (@dusk-network/app-core/bridge): read as its card opens, and said in a line
// under the route where it could make someone wait. It's only ever said:
// nothing waits for it, and nothing it says stops anyone from sending.

import { STATUS_MAX_AGE_MS } from "@dusk-network/app-core/bridge";
import { durationWords } from "@dusk-network/networks/format";

import { formatShort } from "./format.js";

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

/**
 * A route's status in a line, for under its route, only where it could make
 * someone wait: payouts running late, or a balance that can't pay what's
 * being sent (`amountLux`) now. `text`, with `warn`. Null otherwise: nothing
 * read yet, a route that pays as usual or whose payouts can't be read, or one
 * that isn't running, which its card says itself.
 */
export function statusLine(status, { amountLux = null, now = Date.now() } = {}) {
  if (!status || status.paying === "stopped") return null;
  const late = status.paying === "late";
  const pays = status.limit === "balance" && status.canPay !== null && status.canPay !== undefined ? formatShort(status.canPay).text : "";
  const short = Boolean(pays) && amountLux !== null && amountLux > status.canPay;
  if (!late && !short) return null;
  const lines = [];
  if (late) lines.push(status.lastPayout?.at ? `Payouts late: last ${durationWords(Math.max(0, now - status.lastPayout.at) / 1_000)} ago` : "Payouts late");
  if (short) lines.push(`Can pay ${pays} DUSK now: yours may wait`);
  return { text: lines.join(" · "), warn: true };
}
