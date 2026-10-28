// Amounts, fees, dates and durations as the page writes them: grouped digits,
// DUSK as the unit, durations in whole words, and dates and Dusk fees as
// every Dusk app writes them (@dusk-network/networks): English words on the
// viewer's clock, fees rounded up where they're the most a step can cost.

import { formatDusk as formatShared, formatTime } from "@dusk-network/networks/format";

const LUX_DECIMALS = 9;

const groupDigits = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

/** "1,483.92": base units in decimal, trailing zeros dropped. */
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
  return `${negative ? "−" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const formatLux = (lux, maxFraction = LUX_DECIMALS) =>
  formatUnitsGrouped(lux, LUX_DECIMALS, maxFraction);

export const formatDusk = (lux, maxFraction = LUX_DECIMALS) =>
  `${formatLux(lux, maxFraction)} DUSK`;

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

/** A Dusk fee in the apps' short form: 4 decimals, 2 significant digits under 0.01, the page's separators. */
const shortFee = (lux, round) => formatShared(lux, { locale: "en-US", round }).text;

/**
 * The most a Dusk fee can be, as Dusk Wallet writes it: rounded up, so it
 * never reads lower than it can be ("0.051"). Every "up to" fee on the page
 * is written this way, so it reads as the wallet's window does.
 */
export const formatMaxFee = (lux) => (BigInt(lux) > 0n ? shortFee(lux, "up") : "0");

/** What a Dusk fee usually comes to, to the nearest: "0.002". */
export const formatTypicalFee = (lux) => shortFee(lux, "nearest");

/** A Dusk fee paid, exact, as a record keeps it: "0.001986599". */
export const formatExactFee = (lux) => formatShared(lux, { locale: "en-US", mode: "exact" }).text;

/**
 * An estimated fee in a coin with `decimals`: "about 0.00021 ETH", or "less
 * than 0.000001 ETH" when it rounds to nothing a person would read.
 */
export function aboutFee(value, decimals, unit) {
  const floor = 10n ** BigInt(Math.max(0, decimals - 6));
  return BigInt(value) < floor ? `less than 0.000001 ${unit}` : `about ${formatFee(value, decimals)} ${unit}`;
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

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const unit = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "5 days 3 hours", "3 hours 12 minutes", "12 minutes": no abbreviations. */
export function durationWords(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) / 60));
  if (total < 1) return "less than a minute";
  const days = Math.floor(total / 1_440);
  const hours = Math.floor((total % 1_440) / 60);
  const minutes = total % 60;
  if (days) return hours ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours) return minutes ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  return unit(minutes, "minute");
}
