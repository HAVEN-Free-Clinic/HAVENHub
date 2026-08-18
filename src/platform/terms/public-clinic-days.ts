/**
 * The upcoming open clinic days, shaped for the public website.
 *
 * havenfreeclinic.org has an "Upcoming Clinic Days" section that was wired to a
 * hand-maintained Airtable table, which meant the schedule a patient reads and
 * the schedule the Hub runs on were two sources of truth kept in step by
 * somebody remembering. This is the Hub side of collapsing them into one.
 *
 * WHAT COUNTS AS A CLINIC DAY. `Term.clinicDates` is the source of truth, not
 * the `ClinicDay` table. `createTerm` seeds `clinicDates` with every Saturday in
 * the term, and a `ClinicDay` row is only written once somebody says something
 * about that date -- closed, specialty clinic, on-call attending. So most normal
 * open Saturdays have NO `ClinicDay` row at all, and a naive
 * `clinicDay.findMany({ where: { isClosed: false } })` would publish only the
 * annotated minority and silently drop the rest. `resolveOpenClinicDate` in
 * platform/attendings makes the same point for the single-date case; this is the
 * list form of it.
 *
 * WHAT IS DELIBERATELY NOT PUBLISHED. No people, ever: not the on-call
 * attending, not the day's attendings, not the reproductive-health director, not
 * patient or volunteer counts. This endpoint is unauthenticated, so the response
 * shape is the access-control boundary -- a field added here is a field on the
 * open internet. Dates and the rotating specialty clinic name are the whole of
 * what a prospective patient needs, and are already public information.
 */

import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { getActiveTerm } from "./active-term";

/** One open clinic day, as the website consumes it. */
export interface PublicClinicDay {
  /** Calendar day as a UTC YYYY-MM-DD key, e.g. "2026-08-22". */
  date: string;
  /**
   * The rotating specialty clinic running that day ("Dermatology"), or null on
   * an ordinary primary-care Saturday.
   */
  specialty: string | null;
}

/** The subset of a ClinicDay row this feed reads. */
export interface ClinicDayAnnotation {
  clinicDate: Date;
  isClosed: boolean;
  specialty: { name: string; runsSpecialtyClinic: boolean } | null;
}

/**
 * Pure selection: given a term's clinic dates and whatever annotations exist,
 * return the next `limit` open days from `todayKey` onward.
 *
 * Split from the fetch so the calendar rules -- closed days drop out, unmarked
 * days stay in, specialties only surface when they are a real specialty clinic
 * -- are testable without a database.
 *
 * Today is included rather than skipped. The clinic runs Saturday mornings, so
 * on a Saturday the most useful answer to "when is the next clinic day" is
 * "today"; excluding it would blank out the section on the one morning it
 * matters most. `todayKey` comes from displayTodayKey(), which is the ET
 * calendar day, so the date stops being "today" late that evening rather than at
 * 8pm when the UTC day happens to roll over.
 */
export function selectPublicClinicDays({
  clinicDates,
  annotations,
  todayKey,
  limit,
}: {
  clinicDates: readonly Date[];
  annotations: readonly ClinicDayAnnotation[];
  todayKey: string;
  limit: number;
}): PublicClinicDay[] {
  const byDate = new Map<string, ClinicDayAnnotation>();
  for (const a of annotations) byDate.set(isoDateKey(a.clinicDate), a);

  return (
    clinicDates
      .map(isoDateKey)
      // ISO keys are zero-padded, so lexicographic order is chronological order
      // and a string compare is a date compare.
      .filter((key) => key >= todayKey)
      .sort()
      // A date the clinic has declared closed is not a clinic day. Absence of a
      // row means nobody has said otherwise, which is the normal state: open.
      .filter((key) => !byDate.get(key)?.isClosed)
      .slice(0, limit)
      .map((key) => {
        const specialty = byDate.get(key)?.specialty ?? null;
        return {
          date: key,
          // runsSpecialtyClinic is the flag that says a specialty is eligible to
          // be named as the day's rotating clinic. Honouring it keeps an
          // internal bookkeeping value (e.g. a reproductive-health day recorded
          // against the same column) from being published to patients as though
          // a specialty clinic were running.
          specialty: specialty?.runsSpecialtyClinic ? specialty.name : null,
        };
      })
  );
}

/**
 * The next `limit` open clinic days in the live term, or an empty list.
 *
 * Scoped to the ACTIVE term on purpose. A PLANNING term already has every
 * Saturday seeded into `clinicDates` but has not necessarily had its closures
 * marked yet, so publishing from it would advertise dates that are still being
 * decided. Running dry at the end of a term is the safer failure: the website
 * falls back to "call for the latest schedule", which is true, where a wrong
 * date sends somebody to a locked door.
 *
 * Database errors are left to propagate. An empty list here means "the live term
 * genuinely has no upcoming open dates", and the route turns that into a 200 with
 * an empty array; a Neon blip has to stay distinguishable from that so it can
 * become a 503 the caller retries and monitoring can see, rather than a
 * confident-looking "no clinic days" that is really an outage.
 */
export async function publicClinicDays(limit: number): Promise<PublicClinicDay[]> {
  const term = await getActiveTerm();
  if (!term) return [];

  const todayKey = await displayTodayKey();

  const annotations = await prisma.clinicDay.findMany({
    where: { termId: term.id },
    select: {
      clinicDate: true,
      isClosed: true,
      specialty: { select: { name: true, runsSpecialtyClinic: true } },
    },
  });

  return selectPublicClinicDays({
    clinicDates: term.clinicDates,
    annotations,
    todayKey,
    limit,
  });
}
