/**
 * RFC 5545 (iCalendar) document builder.
 *
 * Pure module: no database, no settings, no Next.js. Every fiddly correctness
 * concern in the format lives here so it can be tested exhaustively in
 * isolation.
 *
 * Times are emitted as absolute UTC instants rather than zoned local times.
 * That deliberately avoids shipping a VTIMEZONE component, which is the most
 * error-prone part of hand-written iCalendar. Callers are responsible for
 * having already converted wall-clock clinic hours into instants.
 */

const CRLF = "\r\n";
const MAX_OCTETS = 75;

export type CalendarEvent = {
  /** Stable across regenerations so clients update in place instead of duplicating. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
};

export type CalendarOptions = {
  calendarName: string;
  /** Display hint only; the events themselves are absolute instants. */
  timeZone: string;
  /** Injected so output is deterministic and no clock is read during render. */
  now: Date;
};

/** An instant as an RFC 5545 UTC date-time, for example 20260208T130000Z. */
export function formatUtcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 TEXT escaping. Backslash goes first or later escapes get doubled. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Fold a content line to 75 octets, continuation lines prefixed with a space.
 * Folds on octet count rather than character count, and backs off to a
 * codepoint boundary so a multi-byte name is never split into mojibake.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= MAX_OCTETS) return line;

  const chunks: string[] = [];
  let start = 0;
  // The first line gets the full budget; continuations spend one octet on the
  // leading space that marks them as a continuation.
  let budget = MAX_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    // 0b10xxxxxx marks a UTF-8 continuation byte. Walk back off one.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    budget = MAX_OCTETS - 1;
  }

  return chunks.join(`${CRLF} `);
}

/** Render events as a complete iCalendar document. */
export function buildCalendar(events: CalendarEvent[], opts: CalendarOptions): string {
  const stamp = formatUtcStamp(opts.now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HAVEN Hub//Shift Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${opts.timeZone}`,
    // Honored by Apple Calendar, ignored by Google, free to emit.
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatUtcStamp(event.start)}`,
      `DTEND:${formatUtcStamp(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      // Google and Apple re-read the whole feed and diff by UID, so they don't
      // need these, but Outlook has historically relied on SEQUENCE to notice
      // that an existing UID's content changed. The feed has no per-event
      // revision counter (a shift edit is just a re-render of current state,
      // not a tracked history), so every event is always SEQUENCE 0; that is
      // enough for Outlook to treat LAST-MODIFIED, not SEQUENCE, as the
      // update signal here. LAST-MODIFIED uses the injected `now`, matching
      // DTSTAMP, never a clock read.
      "SEQUENCE:0",
      `LAST-MODIFIED:${stamp}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}
