import assert from "node:assert/strict";
import test from "node:test";

import {
  aboutFee,
  clockChangeBetween,
  clockChangeNote,
  formatDateTime,
  formatDusk,
  formatFee,
  formatLux,
  formatMaxFee,
  zoneOffsetMinutes,
} from "./format.js";

const AMS = "Europe/Amsterdam";

test("amounts group their digits and keep every Lux", () => {
  assert.equal(formatLux(1_483_920_000_000n), "1,483.92");
  assert.equal(formatDusk(1n), "0.000000001 DUSK");
  assert.equal(formatDusk(-1_000_000_000_000n), "−1,000 DUSK");
});

test("fees keep two significant digits and never understate a maximum", () => {
  assert.equal(formatFee(5_000_000n, 9, { round: "up" }), "0.005");
  assert.equal(formatFee(50_200_000n, 9, { round: "up" }), "0.051");
  assert.equal(formatFee(1_850_000n), "0.0019");
  assert.equal(formatFee(2_209_505n), "0.0022");
  assert.equal(formatFee(2_209_505n, 9, { round: "up" }), "0.0023");
  assert.equal(formatFee(55_200_000_000_000n, 18), "0.000055");
  assert.equal(aboutFee(55_200_000_000_000n, 18, "ETH"), "~0.000055 ETH");
  // Sepolia gas can cost next to nothing: no string of zeros.
  assert.equal(aboutFee(15_000_000n, 18, "ETH"), "<0.000001 ETH");
});

test("dates read as in every Dusk app: English words on the viewer's clock, with the zone", () => {
  const claim = Date.UTC(2026, 9, 31, 12, 38);
  const now = Date.UTC(2026, 9, 28, 9);
  const gb = { locale: "en-GB", now, timeZone: AMS };
  // A list: today, yesterday, or the day; a record: the day in full, with the year.
  assert.equal(formatDateTime(claim, gb), "31 Oct, 13:38 CET");
  assert.equal(formatDateTime(Date.UTC(2026, 9, 24, 12, 38), gb), "24 Oct, 14:38 CEST");
  assert.equal(formatDateTime(now, gb), "Today, 10:00 CET");
  assert.equal(formatDateTime(now - 86_400_000, gb), "Yesterday, 10:00 CET");
  assert.equal(formatDateTime(claim, { ...gb, timeZone: "UTC", year: true }), "Sat 31 Oct 2026, 12:38 UTC");
  assert.equal(formatDateTime(claim, { ...gb, seconds: true }), "31 Oct, 13:38:00 CET");
  // The viewer's clock; the words stay English: a Dutch viewer sees no "za 31 okt".
  assert.equal(formatDateTime(claim, { ...gb, locale: "en-US", year: true }), "Sat 31 Oct 2026, 1:38 PM CET");
  assert.equal(formatDateTime(claim, { ...gb, locale: "nl-NL", year: true }), "Sat 31 Oct 2026, 13:38 CET");
});

test("Dusk fees are rounded up where they're the most a step costs, and exact once paid", () => {
  assert.deepEqual([0n, 2_500_000n, 5_000_000n, 50_519_542n, 105_000_001n].map(formatMaxFee), ["0", "0.0025", "0.005", "0.0506", "0.1051"]);
  // Under 0.01 DUSK, two significant digits.
  assert.equal(formatMaxFee(49_999n), "0.00005");
});

test("seven days across the October clock change say so", () => {
  const proven = Date.UTC(2026, 9, 24, 12, 38);
  const claim = proven + 7 * 86_400_000;
  assert.equal(zoneOffsetMinutes(proven, AMS), 120);
  assert.equal(zoneOffsetMinutes(claim, AMS), 60);
  const change = clockChangeBetween(proven, claim, AMS);
  assert.equal(change.direction, "back");
  assert.equal(new Date(change.at).toISOString().slice(0, 13), "2026-10-25T01");
  assert.equal(clockChangeNote(change, { now: Date.UTC(2026, 9, 26), timeZone: AMS }), "clocks went back on 25 Oct");
  assert.equal(clockChangeNote(change, { now: Date.UTC(2026, 9, 24), timeZone: AMS }), "clocks go back on 25 Oct");
  assert.equal(clockChangeBetween(proven, claim, "UTC"), null);
  assert.equal(clockChangeBetween(Date.UTC(2026, 2, 25), Date.UTC(2026, 3, 1), AMS).direction, "forward");
});
