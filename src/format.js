// Amounts, fees and dates as the page writes them: grouped digits, DUSK as
// the unit, and dates and Dusk fees as every Dusk app writes them
// (@dusk-network/app-core, @dusk-network/networks): English words on the viewer's clock, fees rounded
// up where they're the most a step can cost.

import {
  amountForField,
  amountLocale,
  decimalSeparator,
  formatAmount,
  formatDusk as formatShared,
  formatDuskPlain,
  groupDigits,
} from "@dusk-network/app-core/amounts";
import { formatTime } from "@dusk-network/networks/format";

const LUX_DECIMALS = 9;

/** Lux for an amount field, as the field reads it back. */
export const amountForInput = (lux) => amountForField(formatDuskPlain(lux));

/** Units of a token with `decimals` for an amount field, as the field reads them back: Lux for DUSK. */
export function amountForUnits(units, decimals = LUX_DECIMALS) {
  if (decimals === LUX_DECIMALS) return amountForInput(units);
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(units);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return amountForField(`${value / scale}${fraction ? `.${fraction}` : ""}`);
}

export { decimalSeparator, formatDuskPlain };

/** "1,483.92", or "1.483,92" on a Dutch browser: base units in decimal, trailing zeros dropped. */
export function formatUnitsGrouped(value, decimals, maxFraction = decimals) {
  const units = BigInt(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = groupDigits((absolute / scale).toString());
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/u, "");
  return `${negative ? "−" : ""}${whole}${fraction ? `${decimalSeparator()}${fraction}` : ""}`;
}

export const formatLux = (lux, maxFraction = LUX_DECIMALS) =>
  formatUnitsGrouped(lux, LUX_DECIMALS, maxFraction);

export const formatDusk = (lux, maxFraction = LUX_DECIMALS) =>
  `${formatLux(lux, maxFraction)} DUSK`;

/** An amount of a route's token, from its smallest unit: "95.085867 EURd", or DUSK to the Lux. */
export const formatToken = (units, token, maxFraction = token.decimals) =>
  `${formatUnitsGrouped(units, token.decimals, maxFraction)} ${token.symbol}`;

/**
 * A fee to two significant digits: rounded up for a maximum ("up to"), to
 * the nearest for an estimate ("about"), so a maximum is never understated.
 */
export function formatFee(value, decimals = LUX_DECIMALS, { round = "nearest" } = {}) {
  let units = BigInt(value);
  if (units <= 0n) return "0";
  const digits = units.toString().length;
  const drop = Math.max(0, digits - 2);
  if (drop > 0) {
    const step = 10n ** BigInt(drop);
    const rest = units % step;
    units -= rest;
    if (rest > 0n && (round === "up" || rest * 2n >= step)) units += step;
  }
  return formatUnitsGrouped(units, decimals);
}

/**
 * An amount in a list or a balance line, as most wallets write it, `text`: up
 * to 4 decimals, rounded down so it's never more than there is, and never 0 for
 * an amount that isn't. In full, `exact`, for whoever asks for it. A total
 * paid, as fees, is rounded to the nearest (`round`).
 */
export const formatShort = (units, decimals = LUX_DECIMALS, round = "down") => formatAmount(units, { decimals, locale: amountLocale(), round });

/** Tokens that stand for money: written to the cent where an amount is short, as every Dusk app writes EURd and USDd. */
const CENTS = new Set(["EURd", "USDd"]);

/**
 * An amount of `token` in a list or a balance line, as `formatShort` writes
 * it: to the cent for a token that stands for money ("265.88 EURd"), rounded
 * down, and never 0 for an amount that isn't; up to 4 decimals otherwise.
 * In full, `exact`, for whoever asks for it.
 */
export function formatTokenShort(units, token) {
  const full = formatShort(units, token.decimals);
  if (!CENTS.has(token.symbol) || token.decimals <= 2) return full;
  const cents = BigInt(units) / 10n ** BigInt(token.decimals - 2);
  return cents === 0n ? full : { exact: full.exact, text: formatAmount(cents, { decimals: 2, locale: amountLocale(), round: "down" }).text };
}

/** A Dusk fee in the apps' short form: 4 decimals, 2 significant digits under 0.01, the page's separators. */
const shortFee = (lux, round) => formatShared(lux, { locale: amountLocale(), round }).text;

/**
 * The most a Dusk fee can be, as Dusk Wallet writes it: rounded up, so it
 * never reads lower than it can be ("0.051"). Every "up to" fee on the page
 * is written this way, so it reads as the wallet's window does.
 */
export const formatMaxFee = (lux) => (BigInt(lux) > 0n ? shortFee(lux, "up") : "0");


/**
 * An estimated fee in a coin with `decimals`: "~0.00021 ETH", or
 * "<0.000001 ETH" when it rounds to nothing a person would read.
 */
export function aboutFee(value, decimals, unit) {
  const floor = 10n ** BigInt(Math.max(0, decimals - 6));
  return BigInt(value) < floor ? `<0.000001 ${unit}` : `~${formatFee(value, decimals)} ${unit}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function parts(ms, options) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", options)
      .formatToParts(ms)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/**
 * A date and time as every Dusk app writes one: English words on the
 * viewer's clock, and the zone. Records (`year`) give the day in full, "Sat
 * 31 Oct 2026, 13:38 CET"; otherwise "Today, 13:38 CET" or "31 Oct, 13:38
 * CET", as of `now`. The viewer's locale and time zone unless given.
 */
export const formatDateTime = (ms, { locale, now, seconds = false, timeZone, year = false } = {}) =>
  formatTime(ms, { date: year ? "full" : "auto", locale, now, seconds, timeZone });

/** "25 Oct". */
export function formatShortDay(ms, { timeZone } = {}) {
  const p = parts(ms, { day: "numeric", month: "short", timeZone });
  return `${p.day} ${p.month}`;
}

/** Minutes ahead of UTC at `ms` in `timeZone`. */
export function zoneOffsetMinutes(ms, timeZone) {
  const name = parts(ms, { timeZone, timeZoneName: "longOffset" }).timeZoneName ?? "GMT";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/u.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * The clock change between two times in `timeZone`, if there is one:
 * `{ at, direction }`, with `at` the first instant on the new offset.
 */
export function clockChangeBetween(start, end, timeZone) {
  const before = zoneOffsetMinutes(start, timeZone);
  const after = zoneOffsetMinutes(end, timeZone);
  if (before === after || !(end > start)) return null;
  let low = start;
  let high = end;
  while (high - low > 60_000) {
    const middle = Math.floor((low + high) / 2);
    if (zoneOffsetMinutes(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return { at: high, direction: after < before ? "back" : "forward" };
}

/** "clocks went back on 25 Oct", or "go" while it's still ahead. */
export function clockChangeNote(change, { now = Date.now(), timeZone } = {}) {
  if (!change) return "";
  const verb =
    change.at <= now
      ? change.direction === "back" ? "went back" : "went forward"
      : change.direction === "back" ? "go back" : "go forward";
  return `clocks ${verb} on ${formatShortDay(change.at, { timeZone })}`;
}
