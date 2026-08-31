/**
 * "Is the clinic actually running that day?", answered once for everyone.
 *
 * A closed Saturday is stored as a FLAG, not by removing the date: the schema
 * comment on `ClinicDay.isClosed` says so explicitly, and `createTerm` seeds
 * `clinicDates` with EVERY Saturday between the term's start and end. So a
 * Thanksgiving or spring-break Saturday is in `Term.clinicDates` from day one
 * and is taken out of service when an admin declares it closed in Admin > Terms,
 * a decision owned by `admin.manage_terms` (the same grant that owns
 * `Term.clinicDates`) and written through `setClinicDayClosure`.
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
 * WHAT CLOSED DOES *NOT* MEAN: "nobody works". Ops confirmed the opposite --
 * departments still run triage and other coverage on a Saturday the clinic
 * proper is shut, so the builder never blocked assigning on a closed date and
 * must not start. That is the split the two exports here draw:
 *
 *   resolveOpenClinicDate  -- "is the CLINIC running?", the hard gate. Check-in,
 *                             attendance, the morning-of invite and every
 *                             attending-facing reader stay off, because those
 *                             are all about the clinic's front door being open.
 *   closedClinicDates      -- "which Saturdays are shut?", the label. The
 *                             builder, the member's shift card and the weekly
 *                             reminder still run on a closed date and say so,
 *                             so a director schedules with their eyes open and
 *                             nobody turns up expecting a normal clinic.
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

/**
 * Every closed date in a term, as a UTC day key -> its closure note.
 *
 * The bulk twin of {@link resolveOpenClinicDate}, for the surfaces that render a
 * whole term at once (the builder's date strip and grid, a member's shift list)
 * and would otherwise issue one query per Saturday. A key is present IFF that
 * date is closed; the value is the note explaining why, which is routinely null
 * because `isClosed` can be ticked without one.
 *
 * Only closed rows are fetched. Most Saturdays have no `ClinicDay` row at all --
 * one is written only when somebody says something about the date -- so absence
 * is the normal "open" answer and reading the open rows back would be work for
 * nothing.
 */
export async function closedClinicDates(termId: string): Promise<Map<string, string | null>> {
  const rows = await prisma.clinicDay.findMany({
    where: { termId, isClosed: true },
    select: { clinicDate: true, closedNote: true },
  });
  return new Map(rows.map((r) => [isoDateKey(r.clinicDate), r.closedNote]));
}

/**
 * A term's clinic dates with the closed ones dropped, in the order given.
 *
 * The list form of {@link resolveOpenClinicDate}: for the surfaces that OFFER a
 * whole term's calendar as choices rather than asking about one date. The
 * recruitment application's availability question is the case that motivated it
 * -- its options resolve live from `Term.clinicDates`, so an admin who closed a
 * Saturday still saw the Hub asking applicants to sign up for it, and the answer
 * carried through promotion into `TermMembership.baselineAvailability`.
 *
 * Note the difference from {@link closedClinicDates}, which is the LABEL: the
 * builder and the shift card keep rendering a closed date and say it is shut.
 * This one takes the date away entirely, which is right only where the date is
 * being offered as a choice.
 */
export async function openClinicDates(term: { id: string; clinicDates: Date[] }): Promise<Date[]> {
  const closed = await closedClinicDates(term.id);
  return term.clinicDates.filter((d) => !closed.has(isoDateKey(d)));
}
