/**
 * "Is the clinic actually running that day?", answered once for everyone.
 *
 * A closed Saturday is stored as a FLAG, not by removing the date: the schema
 * comment on `ClinicDay.isClosed` says so explicitly, and `createTerm` seeds
 * `clinicDates` with EVERY Saturday between the term's start and end. So a
 * Thanksgiving or spring-break Saturday is in `Term.clinicDates` from day one
 * and is taken out of service by ticking "Clinic closed" in the attending Day
 * view, or by the workbook importer writing `isClosed` from a CLOSED cell.
 *
 * Only the ATTENDING-facing readers ever honoured that flag. `runAttendingReminders`
 * bails on it with the comment "a 'reminder' for a closed Saturday would be
 * wrong", and the coverage query filters `isClosed: false`. Every volunteer-facing
 * resolver read `Term.clinicDates` alone and never joined `ClinicDay`, so closing
 * a date removed the doctors and left the volunteers being emailed "You are
 * scheduled for clinic today", shown a live Check-in tab, and able to record
 * attendance for a clinic that nobody had declared open (audit 14, CLINIC-01 and
 * SCHED-4). The doctors were protected; the volunteers were not.
 *
 * Lives in platform rather than the schedule module because both the cron routes
 * and the module need it, and the eslint boundary forbids platform importing
 * module code.
 */

import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";

/**
 * The clinic date matching `dateKey` in this term, or null when that day is not
 * a clinic day AT ALL, or is a clinic day that has been closed.
 *
 * Returning null for a closed day is the point: every caller already handles
 * "not a clinic day", and a closed day should reach exactly that branch.
 */
export async function resolveOpenClinicDate(
  term: { id: string; clinicDates: Date[] },
  dateKey: string
): Promise<Date | null> {
  const match = term.clinicDates.find((d) => isoDateKey(d) === dateKey);
  if (!match) return null;

  const day = await prisma.clinicDay.findUnique({
    where: { termId_clinicDate: { termId: term.id, clinicDate: match } },
    select: { isClosed: true },
  });
  // No ClinicDay row means nobody has said anything about this date, which is
  // the normal state for most Saturdays: open.
  return day?.isClosed ? null : match;
}
