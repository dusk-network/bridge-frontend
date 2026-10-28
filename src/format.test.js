import assert from "node:assert/strict";
import test from "node:test";

import {
  aboutFee,
  clockChangeBetween,
  clockChangeNote,
  durationWords,
  formatDateTime,
  formatDusk,
  formatFee,
  formatLux,
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
  assert.equal(aboutFee(55_200_000_000_000n, 18, "ETH"), "about 0.000055 ETH");
  // Sepolia gas can cost next to nothing: no string of zeros.
  assert.equal(aboutFee(15_000_000n, 18, "ETH"), "less than 0.000001 ETH");
});

test("dates carry the weekday and the time zone", () => {
  const claim = Date.UTC(2026, 9, 31, 12, 38);
  assert.equal(formatDateTime(claim, { timeZone: AMS }), "Sat 31 Oct, 13:38 CET");
  assert.equal(formatDateTime(Date.UTC(2026, 9, 24, 12, 38), { timeZone: AMS }), "Sat 24 Oct, 14:38 CEST");
  assert.equal(formatDateTime(claim, { timeZone: "UTC", year: true }), "Sat 31 Oct 2026, 12:38 UTC");
  assert.equal(formatDateTime(claim, { seconds: true, timeZone: AMS }), "Sat 31 Oct, 13:38:00 CET");
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

test("durations are whole words", () => {
  assert.equal(durationWords(5 * 86_400 + 3 * 3_600 + 59), "5 days 3 hours");
  assert.equal(durationWords(86_400), "1 day");
  assert.equal(durationWords(3 * 3_600 + 12 * 60), "3 hours 12 minutes");
  assert.equal(durationWords(61), "1 minute");
  assert.equal(durationWords(20), "less than a minute");
});
