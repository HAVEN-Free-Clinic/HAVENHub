import { z } from "zod";
import { mySchedule } from "@/modules/schedule/services/schedule";
import { CLINIC_DATE_LONG, formatCalendarDate, isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import type { ShiftRole } from "@prisma/client";
import type { McpTool } from "./index";
import { hubLink } from "./links";

/** Same labels the calendar feed and shift-reminder email use. */
const ROLE_LABEL: Record<ShiftRole, string> = {
  DIRECTOR: "Director",
  VOLUNTEER: "Volunteer",
  SHADOW: "Shadow",
};

type UpcomingShift = Awaited<ReturnType<typeof mySchedule>>["terms"][number]["shifts"][number];

/**
 * Every shift on or after today, soonest first, across every term the member
 * is on. Shared by my_next_shift and my_upcoming_shifts so the two can never
 * disagree about which shift counts as "next".
 */
async function upcomingShifts(personId: string): Promise<UpcomingShift[]> {
  const { terms } = await mySchedule(personId);

  // clinicDate is stored at UTC midnight, so comparing it against a raw
  // wall-clock `now` (Date >= Date) misreads a shift as already "past" from
  // roughly 8pm ET the evening before, straight through the entire day it
  // actually happens -- exactly the window when a member is most likely to
  // ask this. Compare by day key instead, anchored to the display-zone (ET)
  // calendar day, the same fix fullSchedule and displayTodayKey both carry.
  const todayKey = await displayTodayKey(new Date());

  // Every term mySchedule returns is a real candidate, not just the live
  // one: a member's next-term shifts are already visible once their
  // department publishes, ahead of the live/next flip (see mySchedule's own
  // doc comment). Restricting to the live term would wrongly report
  // "nothing upcoming" for someone whose live-term shifts are exhausted but
  // who already has a published next-term shift.
  return terms
    .flatMap((t) => t.shifts)
    .filter((s) => isoDateKey(s.clinicDate) >= todayKey)
    .sort((a, b) => a.clinicDate.getTime() - b.clinicDate.getTime());
}

/**
 * One shift as a clause: date, role, department, and the two facts that change
 * what the member should actually do that day -- a remote shift, and a date
 * the clinic itself is closed (departments do staff some closed Saturdays; see
 * MyShift.clinicClosed).
 *
 * formatCalendarDate, NOT formatDateOnly. clinicDate is a date-only value
 * stored at UTC midnight, and formatCalendarDate renders calendar days in UTC
 * for exactly that reason. Passing it through a zoned formatter with
 * America/New_York would render UTC midnight as 8pm the previous evening and
 * report the wrong day, which on a shift reminder is the whole answer being
 * wrong.
 */
function describeShift(shift: UpcomingShift): string {
  const role = ROLE_LABEL[shift.role] ?? "Clinic";
  const remote = shift.tags?.remote ? " (remote)" : "";
  const closed = shift.clinicClosed
    ? ` Note: the clinic itself is closed that day${shift.closedNote ? ` (${shift.closedNote})` : ""}, but this shift is still scheduled.`
    : "";
  return `${formatCalendarDate(shift.clinicDate, CLINIC_DATE_LONG)}: ${role} shift${remote} with ${shift.department.name}.${closed}`;
}

/** Bounds a shift list the same way every list-shaped tool here is bounded. */
const MAX_SHIFTS = 10;

/**
 * "When is my next shift?", the highest-volume and lowest-sensitivity support
 * question there is.
 *
 * Takes no input on purpose. The caller is already known from the verified
 * Intercom contact, and adding even a date filter would hand the model a lever
 * over what gets read. The answer is a sentence, not a row: tool output can be
 * rendered straight into the chat and shared with the member.
 */
export const myNextShiftTool: McpTool = {
  name: "my_next_shift",
  title: "My next shift",
  description:
    "The signed-in member's next upcoming clinic shift, with the date and department. Use for questions like 'when is my next shift?' or 'am I on this week?'.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const next = (await upcomingShifts(ctx.personId))[0];
    if (!next) {
      return `You have no upcoming shifts scheduled. Your schedule and availability are at ${await hubLink("/schedule")}.`;
    }
    return `Your next shift is on ${describeShift(next)}`;
  },
};

/**
 * "What are all my shifts?" -- the follow-up my_next_shift cannot answer,
 * because it deliberately returns one. Still takes no input, for the same
 * reason: the caller is the verified member and there is nothing to filter.
 */
export const myUpcomingShiftsTool: McpTool = {
  name: "my_upcoming_shifts",
  title: "My upcoming shifts",
  description:
    "Every upcoming clinic shift the signed-in member is scheduled for (up to 10), with date, role, and department. Use for questions like 'what are my shifts this term?', 'how many shifts do I have left?', or 'am I on any Saturdays in October?'. For just the next one, use my_next_shift.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const shifts = await upcomingShifts(ctx.personId);
    const link = await hubLink("/schedule");
    if (shifts.length === 0) {
      return `You have no upcoming shifts scheduled. Your schedule and availability are at ${link}.`;
    }

    const shown = shifts.slice(0, MAX_SHIFTS);
    const omitted = shifts.length - shown.length;
    const count = `You have ${shifts.length} upcoming shift${shifts.length === 1 ? "" : "s"}.`;
    const more = omitted > 0 ? ` (${omitted} more not shown.)` : "";
    return `${count} ${shown.map(describeShift).join(" ")}${more} Full schedule: ${link}.`;
  },
};
