// "Add to calendar": an .ics file made here, in the browser, for the time a
// withdrawal can be claimed. Nothing is sent anywhere.

const pad = (value) => String(value).padStart(2, "0");

/** 20261031T123800Z */
export function icsTime(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** Text as an .ics value: backslash, semicolon, comma and line breaks escaped. */
export const icsText = (value) =>
  String(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r?\n/gu, "\\n");

/** Lines longer than 75 bytes continue on the next line after a space. */
export function foldLine(line) {
  const encoder = new TextEncoder();
  const out = [];
  let current = "";
  for (const character of line) {
    const limit = out.length ? 74 : 75;
    if (encoder.encode(current + character).length > limit) {
      out.push(current);
      current = character;
    } else current += character;
  }
  out.push(current);
  return out.join("\r\n ");
}

/**
 * An event at `start` for `minutes`, with a reminder when it starts.
 *
 * @param {object} event
 * @param {number} event.start milliseconds
 * @param {string} event.title
 * @param {string} event.description
 * @param {string} [event.url] the receipt link
 * @param {string} event.uid unique per transfer, so a second download updates the first
 * @param {number} [event.now] milliseconds, for DTSTAMP
 */
export function calendarEvent({ description, minutes = 30, now = Date.now(), start, title, uid, url }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dusk Bridge//Claim reminder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(uid)}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(start + minutes * 60_000)}`,
    `SUMMARY:${icsText(title)}`,
    `DESCRIPTION:${icsText(url ? `${description}\n${url}` : description)}`,
    ...(url ? [`URL:${url}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(title)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** The claim reminder for a withdrawal; an estimated time says so. */
export function claimReminder({ amount, claimAt, exact = true, hash, now, url }) {
  return calendarEvent({
    description: exact
      ? `Your ${amount} from DuskEVM can be claimed on Dusk from now. Open the transfer to claim it.`
      : `Your ${amount} from DuskEVM should be ready to claim on Dusk around now. The time is an estimate: open the transfer to check and claim it.`,
    now,
    start: claimAt,
    title: `Claim ${amount} on Dusk`,
    uid: `claim-${hash}@dusk-bridge`,
    url,
  });
}
