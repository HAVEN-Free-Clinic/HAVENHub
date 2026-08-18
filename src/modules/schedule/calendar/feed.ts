/**
 * Assembles a member's calendar feed.
 *
 * Deliberately routes through mySchedule() rather than querying
 * ShiftAssignment directly. Term selection and the publication gating that
 * hides an unpublished next-term schedule already live there and are already
 * tested. A second copy of that rule is a second place for it to drift, and
 * drift in that direction leaks an unpublished schedule.
 */

import type { ShiftRole } from "@prisma/client";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { parseZonedInput } from "@/platform/dates/format";
import { isoDateKey } from "@/platform/dates";
import { mySchedule, type MyTermSchedule, type ShiftTags } from "../services/schedule";
import { myAttendingSchedule, type MyAttendingSchedule } from "../services/attending-portal";
import { buildCalendar, type CalendarEvent } from "./ics";

export type FeedContext = {
  orgName: string;
  /** HH:MM wall clock in `timeZone`. */
  startTime: string;
  /** HH:MM wall clock in `timeZone`. */
  endTime: string;
  timeZone: string;
  /** Host used to namespace event UIDs. */
  host: string;
  baseUrl: string;
  /** Clinic street address. Empty string means emit no location at all. */
  clinicAddress: string;
};

const ROLE_LABELS: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

function tagLabels(tags: ShiftTags): string[] {
  const labels: string[] = [];
  if (tags.triage) labels.push("Triage");
  if (tags.walkin) labels.push("Walk-in");
  if (tags.cc) labels.push("Care coordinator");
  if (tags.remote) labels.push("Remote");
  if (tags.specialty) labels.push("Specialty clinic");
  return labels;
}

/**
 * Combine a noon-UTC anchored clinic date with an HH:MM wall clock in `zone`
 * and return the absolute instant. Converting per date, rather than caching one
 * offset, is what makes a February and a July clinic day land on different UTC
 * hours from the same configured window.
 */
function instantFor(clinicDate: Date, wallTime: string, zone: string): Date | null {
  return parseZonedInput(`${isoDateKey(clinicDate)}T${wallTime}`, zone);
}

/**
 * Flatten a member's terms into calendar events. Pure; all inputs are explicit.
 *
 * `personId` is needed for UID uniqueness only, not for querying: `terms`
 * already came from `mySchedule(personId)`.
 */
export function shiftsToEvents(terms: MyTermSchedule[], personId: string, ctx: FeedContext): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const term of terms) {
    for (const shift of term.shifts) {
      const start = instantFor(shift.clinicDate, ctx.startTime, ctx.timeZone);
      const end = instantFor(shift.clinicDate, ctx.endTime, ctx.timeZone);
      // A malformed clinic-hours setting, or one bypassed via resetSetting
      // (which skips the cross-field start<end validation setSetting runs),
      // should drop the event rather than ship an inverted DTEND before
      // DTSTART, which RFC 5545 forbids and stricter clients may reject
      // outright, or throw and take the whole feed down for every subscriber.
      if (!start || !end || end <= start) continue;

      const dateKey = isoDateKey(shift.clinicDate);
      const detail = [ROLE_LABELS[shift.role], ...tagLabels(shift.tags)].join(" · ");

      events.push({
        // Includes both termId and personId because ShiftAssignment is unique
        // on (termId, departmentId, clinicDate, personId): mySchedule can
        // return the live term AND a PLANNING next term together, and if they
        // share a clinic date and department (plausible right at a term
        // rollover) omitting either would collapse two distinct shifts onto
        // one UID and silently drop one from the calendar. This would ideally
        // be shift-<assignmentId>@<host> per the design doc, but MyShift does
        // not carry the ShiftAssignment id, so identity is reconstructed from
        // the fields that make up its unique constraint instead.
        uid: `shift-${term.term.id}-${personId}-${dateKey}-${shift.department.id}@${ctx.host}`,
        start,
        end,
        summary: `${ctx.orgName}: ${shift.department.name}`,
        description: `${detail}\n${term.term.name}\n\n${ctx.baseUrl}/schedule`,
        // Never on a remote shift: stamping the clinic address on one would
        // tell a member to travel across town for a shift they are doing from
        // home, and calendar clients turn the location into directions and a
        // travel-time estimate. The "Remote" tag is already in the description,
        // so nothing is lost by leaving this off.
        location: shift.tags.remote ? undefined : ctx.clinicAddress || undefined,
      });
    }
  }

  return events;
}

/**
 * The attending half of the same feed. Pure; all inputs explicit.
 *
 * Uses the SLOT's own start and end times rather than the clinic-wide window the
 * volunteer events use. That is the whole reason this is a separate function: an
 * attending's commitment is a column ("9am-12pm", "11am-2pm"), and stamping every
 * one of them with the full clinic day would put a three-hour shift on their
 * calendar as an eight-hour one.
 *
 * A CLOSED Saturday emits nothing. The attending-facing readers have always
 * honoured that flag (see resolveOpenClinicDate), and putting a cancelled clinic
 * on a doctor's calendar is the one thing a calendar must not do.
 */
export function attendingShiftsToEvents(
  schedule: MyAttendingSchedule,
  personId: string,
  ctx: FeedContext,
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  if (!schedule.term) return events;

  for (const shift of schedule.shifts) {
    if (shift.isClosed) continue;
    const start = instantFor(shift.clinicDate, shift.slot.startTime, ctx.timeZone);
    const end = instantFor(shift.clinicDate, shift.slot.endTime, ctx.timeZone);
    // Same defence as the volunteer path: a malformed or inverted window drops
    // the event rather than shipping a DTEND before its DTSTART (RFC 5545
    // forbids it) or throwing and taking the whole feed down. ClinicSlot times
    // are free-text "HH:MM" maintained by Faculty Relations, so this is a real
    // possibility here rather than a theoretical one.
    if (!start || !end || end <= start) continue;

    const detail = [
      `Attending · ${shift.slot.label}`,
      ...(shift.alongside.length > 0 ? [`With ${shift.alongside.join(", ")}`] : []),
      ...(shift.onCall ? ["On call for the following week"] : []),
    ].join("\n");

    events.push({
      // ClinicDayAttending is unique on (day, slot, attending), so the day and
      // slot ids fully identify it -- no need to reconstruct identity from dates
      // the way the volunteer UID does. `attending-` namespaces it away from the
      // shift UIDs, so a person who is both never collides with themselves.
      uid: `attending-${shift.clinicDayId}-${shift.slot.id}-${personId}@${ctx.host}`,
      start,
      end,
      summary: `${ctx.orgName}: Attending (${shift.slot.label})`,
      description: `${detail}\n${schedule.term.name}\n\n${ctx.baseUrl}/schedule`,
      // Never conditional here: there is no remote attending slot, so unlike the
      // volunteer path there is no case where the address would mislead.
      location: ctx.clinicAddress || undefined,
    });
  }

  return events;
}

async function loadContext(): Promise<FeedContext> {
  const [orgName, startTime, endTime, timeZone, baseUrl, clinicAddress] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("schedule.clinicStartTime"),
    getSetting<string>("schedule.clinicEndTime"),
    getDisplayTimeZone(),
    getSetting<string>("app.baseUrl"),
    getSetting<string>("schedule.clinicAddress"),
  ]);

  let host = "havenhub";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // A misconfigured base URL must not break the feed; UIDs just get a
    // constant namespace, which still keeps them stable per person.
  }

  return { orgName, startTime, endTime, timeZone, host, baseUrl, clinicAddress };
}

/** The member's shifts as an iCalendar document. */
export async function renderFeedForPerson(personId: string, now: Date = new Date()): Promise<string> {
  // Both halves, unioned. A person who is only one of the two contributes only
  // that half; myAttendingSchedule returns null for the non-faculty majority, and
  // an attending with no TermMembership gets no volunteer terms back. Somebody
  // who is genuinely both gets one calendar with both, which is the point of a
  // single per-person feed.
  const [ctx, schedule, attending] = await Promise.all([
    loadContext(),
    mySchedule(personId),
    myAttendingSchedule(personId),
  ]);
  const events = [
    ...shiftsToEvents(schedule.terms, personId, ctx),
    ...(attending ? attendingShiftsToEvents(attending, personId, ctx) : []),
  ];
  return buildCalendar(events, {
    calendarName: `${ctx.orgName} Shifts`,
    timeZone: ctx.timeZone,
    now,
  });
}

/** A valid but empty calendar, served when the bound member is no longer active. */
export async function renderEmptyFeed(now: Date = new Date()): Promise<string> {
  const ctx = await loadContext();
  return buildCalendar([], {
    calendarName: `${ctx.orgName} Shifts`,
    timeZone: ctx.timeZone,
    now,
  });
}
