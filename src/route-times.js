// How long a route takes on this network: the one answer every page shows.
// Each time comes from the most direct source there is, on this network
// only, and where none is known there is no time, never another network's:
// - a DuskEVM withdrawal: the Portal's proof maturity and dispute game
//   finality delays, and how often DuskEVM's outputs reach Dusk (chain);
// - a DuskEVM deposit: how far DuskEVM's view of Dusk trails Dusk (chain);
// - any route but a withdrawal, without that: what this browser's recent
//   transfers on the route took, or else the network's configured value.

/** Dusk makes a block every 10 seconds: a deposit waits for one. */
const DUSK_BLOCK_SECONDS = 10;
const RECENT_MS = 30 * 86_400_000;
const RECENT_COUNT = 5;

/**
 * What this browser's recent completed transfers on `route` took, sent to
 * arrived: the median of the last five of the past 30 days, or null with
 * fewer than two.
 */
export function measuredSeconds(route, transfers = [], now = Date.now()) {
  const took = transfers
    .filter(
      (entry) =>
        entry.routeId === route.id &&
        entry.status === "completed" &&
        entry.sourceAt &&
        entry.destinationAt > entry.sourceAt &&
        now - entry.sourceAt < RECENT_MS,
    )
    .sort((a, b) => b.sourceAt - a.sourceAt)
    .slice(0, RECENT_COUNT)
    .map((entry) => (entry.destinationAt - entry.sourceAt) / 1_000)
    .sort((a, b) => a - b);
  return took.length < 2 ? null : took[Math.floor(took.length / 2)];
}

const configured = (value) => (value ? { seconds: value, source: "config" } : null);

/**
 * How long `route` usually takes on this network, or null when nothing says.
 * A withdrawal also gives its parts: `prove`, about when it can be proved
 * (one output after it's sent), `report`, when it's late to be provable (two
 * outputs), `maturity`, the Portal's wait from a proof to its claim, and
 * `wait`, the longer of that and the game's finality. Before there are two
 * games to tell how often outputs come (just after launch, or a switch of
 * game type), it has the waits without `prove` and `report`.
 *
 * @param {object} route
 * @param {object} cfg the deployment config
 * @param {object} [timing]
 * @param {{ deposit?: { lagSeconds: number }, withdrawal?: { finalitySeconds: number, maturitySeconds: number, outputSeconds: number | null } } | null} [timing.chain]
 *   what the chains said, as `createChainTimes` keeps it
 * @param {object[]} [timing.transfers] the transfers this browser knows
 * @param {number} [timing.now]
 * @returns {{ seconds: number, source: string, maturity?: number, prove?: number, report?: number, wait?: number } | null}
 */
export function routeTime(route, cfg, { chain = null, now = Date.now(), transfers = [] } = {}) {
  if (route.mode === "duskevm-withdrawal") {
    const read = chain?.withdrawal;
    if (!read?.maturitySeconds) return null;
    const wait = Math.max(read.maturitySeconds, read.finalitySeconds ?? 0);
    if (!read.outputSeconds) return { maturity: read.maturitySeconds, seconds: wait, source: "chain", wait };
    // An output covers DuskEVM up to about when its batch reached Dusk, and
    // the batcher posts at least as often as outputs come: a withdrawal
    // waits at most about two outputs to be reported.
    const report = 2 * read.outputSeconds;
    return { maturity: read.maturitySeconds, prove: read.outputSeconds, report, seconds: report + wait, source: "chain", wait };
  }
  if (route.mode === "duskevm-deposit" && chain?.deposit)
    return { seconds: chain.deposit.lagSeconds + DUSK_BLOCK_SECONDS, source: "chain" };
  const measured = measuredSeconds(route, transfers, now);
  if (measured) return { seconds: measured, source: "measured" };
  if (route.mode === "duskevm-deposit") return configured(cfg.duskEvm?.depositSeconds);
  if (route.mode === "migration") return configured(cfg.evmNetworks?.[route.from.id]?.migrationSeconds);
  return configured(cfg.service?.delaySeconds);
}

/**
 * A time as an estimate, rounded up on a scale that reads at a glance:
 * "~1 min", "~15 min", "~1 hour", "~70 min", "~10 hours", "~7 days".
 */
export function aboutTime(seconds) {
  let minutes = Math.max(1, Math.ceil(Number(seconds) / 60));
  if (minutes > 10 && minutes < 60) minutes = Math.ceil(minutes / 5) * 5;
  else if (minutes > 60 && minutes <= 90) minutes = Math.ceil(minutes / 10) * 10;
  if (minutes < 60) return `~${minutes} min`;
  if (minutes === 60) return "~1 hour";
  if (minutes <= 90) return `~${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `~${hours} hours` : `~${Math.round(minutes / 1_440)} days`;
}

/** The same in words: "about 30 minutes", "about 1 hour", "about 7 days". */
export function aboutWords(seconds) {
  const text = aboutTime(seconds);
  const minutes = /^~(\d+) min$/u.exec(text);
  if (minutes) return `about ${minutes[1]} minute${minutes[1] === "1" ? "" : "s"}`;
  return text.replace(/^~/u, "about ");
}

/** The route's time as every page writes it, or "" when it isn't known. */
export const routeTimeText = (time) => (time ? aboutTime(time.seconds) : "");

/**
 * When a transfer counts as late: twice its usual time, and at least a
 * quarter of an hour past it. A withdrawal is late only until it can be
 * proved. Null without a usual time: there's nothing to be late against.
 */
export function lateAfterSeconds(route, time) {
  const usual = route.mode === "duskevm-withdrawal" ? time?.report : time?.seconds;
  return usual ? Math.max(2 * usual, usual + 900) : null;
}
