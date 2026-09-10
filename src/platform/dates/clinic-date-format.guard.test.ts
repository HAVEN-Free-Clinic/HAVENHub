import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Guards the clinic date's vocabulary: CLINIC_DATE_LONG or CLINIC_DATE_SHORT,
 * and nothing else.
 *
 * One Saturday used to be written eight ways. Six of them were an inline
 * options object a few lines from another inline options object, and the other
 * two were the CalendarDate default (a bare `<CalendarDate value={clinicDate}/>`
 * renders "Feb 7, 2026") and a hand-rolled ordinal in the schedule engine.
 * An options-only guard would have been blind to the CalendarDate half, which
 * is exactly the pair the finding names: two shift cards stacked on /schedule
 * reading "Feb 7" and "Feb 7, 2026".
 *
 * Scope is every file that renders a clinic date, which is the schedule module,
 * the schedule routes, the dashboard, and the named email/cron files. Dates
 * that merely look alike (a board meeting, a strike, a date of birth, a HIPAA
 * expiry, a term range) are different objects and are deliberately out.
 */

/** Files in the guarded dirs that hold a date which is NOT a clinic date. */
const EXEMPT: Record<string, string> = {
  // Groups the date strip by MONTH ("August 2026") to head a run of Saturdays.
  // It is not rendering a day, so neither constant fits.
  "src/modules/schedule/components/clinic-date-order.ts":
    "groups by month, not a day",
  // "06-13-26" is a Teams channel identifier that Graph matches on, not prose.
  "src/platform/teams/channel-link.ts": "channel identifier, not prose",
  // The applicant availability picker keeps the weekday CLINIC_DATE_SHORT
  // drops. Its own test ("labels a non-Saturday clinic date with its real
  // weekday") is the reason: an applicant ticks dates off a list, and a
  // clinic date is not always a Saturday. In a builder grid column the
  // weekday is noise; in a checkbox list it is the distinguishing part.
  "src/modules/recruitment/templates/clinic-dates.ts":
    "applicant-facing picker, weekday is load-bearing there",
};

/**
 * Per-call escape hatch, for a file that renders a clinic date AND some other
 * date: put this marker on the call or the line above it. A whole-file
 * exemption would stop guarding the clinic date in the same file, which on the
 * dashboard is the one date that matters here.
 */
const ALLOW_MARKER = "not a clinic date";

const GUARDED = [
  "src/modules/schedule/",
  "src/app/(app)/schedule/",
  "src/app/(app)/page.tsx",
  "src/platform/email/shift-reminders.ts",
  "src/platform/email/attending-reminders.ts",
  "src/platform/email/checkin-invites.ts",
  "src/app/api/cron/schedule-reminders/route.ts",
  "src/modules/admin/components/clinic-dates-editor.tsx",
  "src/modules/recruitment/templates/clinic-dates.ts",
];

describe("the clinic date has exactly two renderings", () => {
  it("has no inline options object and no bare CalendarDate on a clinic date", () => {
    const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => GUARDED.some((g) => f.startsWith(g)))
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => !EXEMPT[f]);

    const offenders: string[] = [];
    for (const f of files) {
      // git ls-files reads the index, so a staged-but-deleted file is listed.
      if (!existsSync(f)) continue;
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      // An options object literal handed to formatCalendarDate, rather than one
      // of the two constants.
      for (const m of src.matchAll(/formatCalendarDate\([^;]{0,150}?\{\s*(weekday|month|day|year)\s*:/g)) {
        const lineNo = src.slice(0, m.index).split("\n").length;
        const here = lines[lineNo - 1] ?? "";
        const above = lines[lineNo - 2] ?? "";
        if (here.includes(ALLOW_MARKER) || above.includes(ALLOW_MARKER)) continue;
        offenders.push(`${f}:${lineNo}: inline formatCalendarDate options`);
      }
      // <CalendarDate value={...clinicDate...} /> with no opts falls through to
      // the DATE_ONLY default, which is a third rendering nobody chose.
      for (const m of src.matchAll(/<CalendarDate\b[^>]*\/>/gs)) {
        const tag = m[0];
        if (!/clinicDate/i.test(tag)) continue;
        if (!/\bopts=/.test(tag)) offenders.push(`${f}: <CalendarDate> on a clinic date with no opts`);
      }
      // The retired ordinal form.
      if (/\$\{SUFFIX\(|MONTH_NAMES\[/.test(src)) offenders.push(`${f}: hand-rolled ordinal date`);
    }
    expect(offenders).toEqual([]);
  });
});
