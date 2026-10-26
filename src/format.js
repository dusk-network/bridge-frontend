// Amounts, fees, dates and durations as the page writes them: grouped digits,
// DUSK as the unit, absolute dates with weekday and time zone, and durations
// in whole words.

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

/**
 * The most a Dusk fee can be, as Dusk Wallet writes it: DUSK to four
 * decimals, rounded up, trailing zeros trimmed ("0.051"). Every "up to" fee
 * on the page is written this way, so it reads as the wallet's window does.
 */
export function formatMaxFee(lux) {
  const value = BigInt(lux);
  if (value <= 0n) return "0";
  const units = (value + 99_999n) / 100_000n;
  const fraction = (units % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return `${formatUnitsGrouped(units / 10_000n, 0)}${fraction ? `.${fraction}` : ""}`;
}

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
 * "Sat 31 Oct, 13:38 CET", in the viewer's time zone unless one is given.
 * Records (`year`) add the year: "Sat 31 Oct 2026, 13:38 CET".
 */
export function formatDateTime(ms, { seconds = false, timeZone, year = false } = {}) {
  const p = parts(ms, {
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    ...(seconds ? { second: "2-digit" } : {}),
    timeZone,
    timeZoneName: "short",
    weekday: "short",
    ...(year ? { year: "numeric" } : {}),
  });
  const time = `${p.hour}:${p.minute}${seconds ? `:${p.second}` : ""}`;
  return `${p.weekday} ${p.day} ${p.month}${year ? ` ${p.year}` : ""}, ${time} ${p.timeZoneName}`;
}

/** "Sat 31 Oct", without the time. */
export function formatDay(ms, { timeZone } = {}) {
  const p = parts(ms, { day: "numeric", month: "short", timeZone, weekday: "short" });
  return `${p.weekday} ${p.day} ${p.month}`;
}

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
