import assert from "node:assert/strict";
import test from "node:test";

import { calendarEvent, claimReminder, foldLine, icsText, icsTime } from "./calendar.js";
import { ESTIMATE, exactly } from "./pages.fixtures.js";

const CLAIM = Date.UTC(2026, 9, 31, 12, 38);
const NOW = Date.UTC(2026, 9, 26, 9, 38, 5);

test("the claim reminder is a valid one-event calendar at the claim time", () => {
  const ics = claimReminder({
    amount: "200 DUSK",
    claimAt: CLAIM,
    hash: `0x${"ab".repeat(32)}`,
    now: NOW,
    url: `https://bridge.example.org/#/transfer/0x${"ab".repeat(32)}`,
  });
  const lines = ics.replace(/\r\n /gu, "").split("\r\n");
  assert.ok(ics.endsWith("\r\n"));
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("DTSTART:20261031T123800Z"));
  assert.ok(lines.includes("DTEND:20261031T130800Z"));
  assert.ok(lines.includes("DTSTAMP:20261026T093805Z"));
  assert.ok(lines.some((line) => line.startsWith("SUMMARY:") && exactly("200 DUSK").test(line)));
  assert.ok(lines.includes(`UID:claim-0x${"ab".repeat(32)}@dusk-bridge`));
  assert.ok(lines.includes("TRIGGER:PT0M"));
  assert.ok(lines.some((line) => line.startsWith("DESCRIPTION:") && exactly("200 DUSK").test(line) && line.includes("\\nhttps://bridge.example.org/#/transfer/")));
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
  // Every physical line fits in 75 bytes.
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test("an estimated claim time is said apart from a sure one, at the same time", () => {
  const reminder = (exact) => claimReminder({ amount: "1 DUSK", claimAt: CLAIM, exact, hash: "0x01", now: NOW }).replace(/\r\n /gu, "").split("\r\n");
  const [sure, estimate] = [true, false].map(reminder);
  const line = (lines, key) => lines.find((each) => each.startsWith(`${key}:`));
  assert.equal(line(estimate, "DTSTART"), line(sure, "DTSTART"));
  assert.notEqual(line(estimate, "DESCRIPTION"), line(sure, "DESCRIPTION"));
  assert.match(line(estimate, "DESCRIPTION"), exactly("1 DUSK"));
  // The estimate says it's one; the sure time doesn't.
  assert.match(line(estimate, "DESCRIPTION"), ESTIMATE);
  assert.doesNotMatch(line(sure, "DESCRIPTION"), ESTIMATE);
});

test("text values are escaped and long lines folded", () => {
  assert.equal(icsText("a,b;c\\d\ne"), String.raw`a\,b\;c\\d\ne`);
  assert.equal(icsTime(0), "19700101T000000Z");
  const folded = foldLine(`DESCRIPTION:${"x".repeat(100)}`);
  assert.deepEqual(folded.split("\r\n ").map((part) => part.length), [75, 37]);
  assert.match(calendarEvent({ description: "d", now: NOW, start: CLAIM, title: "t", uid: "u" }), /DTEND:20261031T130800Z/u);
});
