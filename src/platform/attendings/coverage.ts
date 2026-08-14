/**
 * Which attending covers which DEPARTMENT.
 *
 * The attending schedule is one clinic-wide grid with a column per role, but
 * almost every reader wants one team's slice of it: a primary care volunteer
 * needs the primary care columns, and reading the behavioral health attending's
 * name told them nothing they could act on.
 *
 * Lives in platform rather than the schedule module because both sides of that
 * boundary need it -- the member's shift card (module) and the weekly reminder
 * email (platform), and platform may not import from modules.
 */

import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";

/** An attending covering one department on one date. */
export type DepartmentAttending = {
  name: string;
  /** The schedule column they cover, e.g. "9am-12pm". */
  slotLabel: string;
  startTime: string;
  endTime: string;
};

/**
 * The schedule columns whose attending covers `departmentId`.
 *
 * Resolved in two steps, because the mapping is kept on the handful of clinical
 * parents rather than on all forty departments:
 *   1. columns naming this department outright (PCAR -> the primary care
 *      columns, SRHD -> "RHD Attending", BVHD -> "BHD Clinic");
 *   2. columns naming a department that MANAGES it, through exactly one hop of
 *      DepartmentDelegation -- which is how SCTP and JCTP read the PCAR columns,
 *      and JCTS, SCTS and CCRH read the reproductive health one.
 *
 * One hop only, matching manageableDepartmentIds: delegation is an oversight
 * edge, and following it transitively would hand a department an attending two
 * removes away who does not cover them.
 *
 * Empty when nothing maps, which reads as "your team has no attending column"
 * and renders as silence rather than as someone else's attending.
 */
export async function departmentSlotIds(departmentId: string): Promise<string[]> {
  const delegations = await prisma.departmentDelegation.findMany({
    where: { managedDepartmentId: departmentId },
    select: { managerDepartmentId: true },
  });
  const covering = new Set<string>([departmentId, ...delegations.map((d) => d.managerDepartmentId)]);

  const slots = await prisma.clinicSlot.findMany({
    where: { departmentId: { in: [...covering] } },
    select: { id: true },
    orderBy: { order: "asc" },
  });
  return slots.map((s) => s.id);
}

/**
 * Who is attending FOR `departmentId` on each of `dates`, keyed by date key.
 *
 * One query for the dates, and a date with nobody is simply ABSENT from the map
 * -- "not announced yet" rather than a gap the reader could act on. A closed
 * date, a deactivated attending, and a department that maps to no column all
 * collapse to that same silence.
 */
export async function departmentAttendingsForDates(
  termId: string,
  dates: Date[],
  departmentId: string,
): Promise<Map<string, DepartmentAttending[]>> {
  const out = new Map<string, DepartmentAttending[]>();
  if (dates.length === 0) return out;

  const slotIds = await departmentSlotIds(departmentId);
  if (slotIds.length === 0) return out;

  const days = await prisma.clinicDay.findMany({
    where: {
      termId,
      clinicDate: { in: [...new Set(dates.map((d) => d.getTime()))].map((t) => new Date(t)) },
      // A closed date staffs nobody; naming anyone would contradict the closure.
      isClosed: false,
    },
    select: {
      clinicDate: true,
      attendings: {
        where: { slotId: { in: slotIds } },
        orderBy: [{ slot: { order: "asc" } }, { order: "asc" }],
        select: {
          slot: { select: { label: true, startTime: true, endTime: true } },
          attending: { select: { scheduleName: true, isActive: true } },
        },
      },
    },
  });

  for (const d of days) {
    const rows = d.attendings
      // A deactivated attending is not covering; naming them would read as a
      // staffed slot, matching the schedule grid's own rule.
      .filter((a) => a.attending.isActive)
      .map((a) => ({
        name: a.attending.scheduleName,
        slotLabel: a.slot.label,
        startTime: a.slot.startTime,
        endTime: a.slot.endTime,
      }));
    if (rows.length > 0) out.set(isoDateKey(d.clinicDate), rows);
  }
  return out;
}
