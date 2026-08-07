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
import { mySchedule, type MyTermSchedule } from "../services/schedule";
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
};

const ROLE_LABELS: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

function tagLabels(tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean }): string[] {
  const labels: string[] = [];
  if (tags.triage) labels.push("Triage");
  if (tags.walkin) labels.push("Walk-in");
  if (tags.cc) labels.push("Care coordinator");
  if (tags.remote) labels.push("Remote");
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

/** Flatten a member's terms into calendar events. Pure; all inputs are explicit. */
export function shiftsToEvents(terms: MyTermSchedule[], ctx: FeedContext): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const term of terms) {
    for (const shift of term.shifts) {
      const start = instantFor(shift.clinicDate, ctx.startTime, ctx.timeZone);
      const end = instantFor(shift.clinicDate, ctx.endTime, ctx.timeZone);
      // A malformed clinic-hours setting should drop the event, not throw and
      // take the whole feed down for every subscriber.
      if (!start || !end) continue;

      const dateKey = isoDateKey(shift.clinicDate);
      const detail = [ROLE_LABELS[shift.role], ...tagLabels(shift.tags)].join(" · ");

      events.push({
        // Stable for a given person, date, and department, so an edited shift
        // updates in place rather than duplicating in the client.
        uid: `shift-${dateKey}-${shift.department.id}@${ctx.host}`,
        start,
        end,
        summary: `${ctx.orgName}: ${shift.department.name}`,
        description: `${detail}\n${term.term.name}\n\n${ctx.baseUrl}/schedule`,
      });
    }
  }

  return events;
}

async function loadContext(): Promise<FeedContext> {
  const [orgName, startTime, endTime, timeZone, baseUrl] = await Promise.all([
    getSetting<string>("branding.orgName"),
    getSetting<string>("schedule.clinicStartTime"),
    getSetting<string>("schedule.clinicEndTime"),
    getDisplayTimeZone(),
    getSetting<string>("app.baseUrl"),
  ]);

  let host = "havenhub";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // A misconfigured base URL must not break the feed; UIDs just get a
    // constant namespace, which still keeps them stable per person.
  }

  return { orgName, startTime, endTime, timeZone, host, baseUrl };
}

/** The member's shifts as an iCalendar document. */
export async function renderFeedForPerson(personId: string, now: Date = new Date()): Promise<string> {
  const [ctx, schedule] = await Promise.all([loadContext(), mySchedule(personId)]);
  return buildCalendar(shiftsToEvents(schedule.terms, ctx), {
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
