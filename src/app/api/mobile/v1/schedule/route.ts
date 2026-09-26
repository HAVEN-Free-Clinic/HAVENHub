import { forbidden, mayUseModule, mobileHandler } from "@/platform/mobile/api";
import { isoDateKey } from "@/platform/dates";
import { mySchedule } from "@/modules/schedule/services/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The member's own shifts, by term: the read side of /schedule.
 *
 * Dates go out as YYYY-MM-DD clinic-date keys, never instants. A clinic date is
 * a calendar day, and sending midnight UTC would let a phone in another zone
 * render it as the day before. Requests, swaps and availability stay on the
 * website for now; `scheduleUrl` is where the app sends people for them.
 */
export const GET = mobileHandler(async (_request, { personId, origin }) => {
  if (!(await mayUseModule(personId, "schedule"))) return forbidden("The schedule is not available for this account.");
  const { terms } = await mySchedule(personId);
  return Response.json({
    scheduleUrl: `${origin}/schedule`,
    terms: terms.map((t) => ({
      id: t.term.id,
      code: t.term.code,
      name: t.term.name,
      isLive: t.isLive,
      shifts: t.shifts.map((s) => ({
        date: isoDateKey(s.clinicDate),
        departmentCode: s.department.code,
        departmentName: s.department.name,
        role: s.role,
        clinicClosed: s.clinicClosed,
        closedNote: s.closedNote,
        attendings: s.attendings.map((a) => ({ name: a.name, slotLabel: a.slotLabel })),
      })),
    })),
  });
});
