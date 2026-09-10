/**
 * The incoming roster: people accepted into a department for a term whose roster
 * build has not happened yet.
 *
 * It lives in platform because two modules need the same answer and a module may
 * not import another module. Recruitment owns the acceptance and turns it into a
 * TermMembership at roster build (promoteContracts); schedule needs to see the
 * same people BEFORE that, so a director can draft next term's schedule against
 * the people who have already applied, been accepted, and given availability
 * rather than waiting for the whole class to finish onboarding.
 *
 * The availability parser lives here for the same reason, and it matters more
 * than the query does. Promotion copies the applicant's availability answer into
 * TermMembership.baselineAvailability; this module reads that same answer to show
 * a not-yet-promoted person's availability in the builder. If the two ever parsed
 * it differently, a person's available dates would silently SHIFT the moment they
 * were promoted, invalidating a schedule already drafted around them. One parser,
 * used by both, is the only way that cannot happen. AVAILABILITY_FIELD_KEY moved
 * here for the same reason: it used to be a literal in the recruitment templates
 * carrying a comment that promotion.ts had to be kept "in step" with it by hand.
 *
 * Draft shifts for first-time applicants live here too. A returner has a Person,
 * so their draft is an ordinary ShiftAssignment. A first-time applicant has none
 * until roster build, so theirs is an IncomingShiftAssignment keyed on the
 * acceptance, which the schedule builder writes and promotion adopts. Both halves
 * go through this file so they agree on which acceptances are still live.
 */

import type { Prisma } from "@prisma/client";
import { prisma, type TransactionClient } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";
// Re-exported so the four server-side callers that have always imported it from
// here keep working. It is DEFINED in its own module because a client component
// needs it too, and must not reach platform/db.ts through this one.
import { AVAILABILITY_FIELD_KEY } from "./availability-key";

export { AVAILABILITY_FIELD_KEY };


/**
 * Parse an applicant's availability answer -- an array of YYYY-MM-DD clinic-date
 * values from the application's MULTI_SELECT -- into UTC-midnight Dates.
 *
 * The scheduler resolves availability tiers (director > self > baseline) and
 * compares every date by UTC day key, so these must be stored and compared as
 * UTC midnight to line up with the term's clinic dates.
 *
 * Tolerant of a scalar string (a single MULTI_SELECT checkbox serializes to one),
 * missing/empty answers, duplicates, and malformed values.
 */
export function parseAvailabilityDates(answer: unknown): Date[] {
  const raw = Array.isArray(answer) ? answer : answer == null || answer === "" ? [] : [answer];
  const out: Date[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || seen.has(key)) continue;
    const d = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * An application's availability answer, parsed and narrowed to the term's clinic
 * calendar.
 *
 * Applications submitted before availability options were sourced from the clinic
 * calendar can carry dates that are not clinic days at all. Filter by UTC day key:
 * parsed dates are UTC midnight and clinic dates are noon UTC, so only the day key
 * lines up.
 */
export function applicationAvailabilityDates(
  answers: unknown,
  clinicDates: Date[],
): Date[] {
  const clinicDateKeys = new Set(clinicDates.map(isoDateKey));
  const parsed = parseAvailabilityDates(
    (answers as Record<string, unknown> | null | undefined)?.[AVAILABILITY_FIELD_KEY],
  );
  return parsed.filter((d) => clinicDateKeys.has(isoDateKey(d)));
}

/** How far along the onboarding pipeline an incoming member is. */
export type IncomingStage = "ACCEPTED" | "ONBOARDING" | "SUBMITTED";

export type IncomingMember = {
  acceptanceId: string;
  applicationId: string;
  /**
   * The applicant's Person row, or null when they do not have one yet.
   *
   * Only an applicant who was SIGNED IN when they applied carries a link
   * (Applicant.applicantPersonId), which in practice means returning members
   * renewing or transferring. A first-time applicant has no Hub account until
   * roster build mints one, so their draft shifts are kept against the
   * acceptance instead (see {@link listIncomingShiftDrafts}).
   */
  personId: string | null;
  name: string;
  licensedRN: boolean;
  /** Membership kind they are inbound to, from the cycle's track. */
  kind: "DIRECTOR" | "VOLUNTEER";
  stage: IncomingStage;
  /** Their application availability, narrowed to the term's clinic calendar. */
  availabilityDates: Date[];
};

/** ContractStatus -> the stage label the builder shows. */
function stageFor(contractStatus: "PENDING" | "SUBMITTED" | "PROMOTED" | undefined): IncomingStage {
  if (contractStatus === "SUBMITTED") return "SUBMITTED";
  if (contractStatus === "PENDING") return "ONBOARDING";
  return "ACCEPTED";
}

/** The membership kind roster build will give an acceptance off this cycle track. */
function kindFor(track: string): "DIRECTOR" | "VOLUNTEER" {
  return track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER";
}

/**
 * The name an incoming member goes by. The Person name wins when there is one: it
 * is the name the rest of the roster shows this human by, and an application can
 * be years old. Shared by the member list and the draft read so a draft always
 * renders under the same name as the row it sits in.
 */
function incomingName(applicant: {
  firstName: string;
  lastName: string;
  applicantPerson: { name: string } | null;
}): string {
  return applicant.applicantPerson?.name ?? `${applicant.firstName} ${applicant.lastName}`.trim();
}

/**
 * Whether an acceptance still puts someone on an incoming roster. ONE predicate
 * for the list, both write-side lookups, and the draft read, so the builder can
 * never offer a cell the write then refuses, or show a draft for someone the
 * list has dropped.
 *
 * Excluded:
 *   - a PROMOTED contract, because roster build already gave them a real
 *     TermMembership and they arrive through the roster read instead;
 *   - a WITHDRAWN application. Withdrawal deliberately leaves the acceptance and
 *     contract intact (tearing them down would cascade away signatures, DOB, and
 *     the HIPAA cert), so the acceptance still looks live and nothing else here
 *     would catch it. promoteContracts skips these for the same reason.
 */
function liveAcceptanceWhere(): Prisma.AcceptanceWhereInput {
  return {
    application: { status: { not: "WITHDRAWN" } },
    OR: [{ contract: { is: null } }, { contract: { status: { not: "PROMOTED" } } }],
  };
}

/**
 * Everyone accepted into `departmentCode` for `termId` who is not on the roster
 * yet, ordered by name. See {@link liveAcceptanceWhere} for who is excluded.
 *
 * NOT excluded: an application accepted by more than one department. Both
 * directors see the person, which is the honest picture while SRR has yet to
 * resolve it, and a draft assignment on each side surfaces through the builder's
 * existing same-day cross-department conflict map rather than needing its own
 * rule here.
 */
export async function listIncomingMembers(opts: {
  termId: string;
  departmentCode: string;
  clinicDates: Date[];
}): Promise<IncomingMember[]> {
  const rows = await prisma.acceptance.findMany({
    where: {
      AND: [
        liveAcceptanceWhere(),
        { departmentCode: opts.departmentCode, application: { cycle: { termId: opts.termId } } },
      ],
    },
    select: {
      id: true,
      contract: { select: { status: true } },
      application: {
        select: {
          id: true,
          answers: true,
          cycle: { select: { track: true } },
          applicant: {
            select: {
              firstName: true,
              lastName: true,
              applicantPersonId: true,
              applicantPerson: { select: { id: true, name: true, licensedRN: true } },
            },
          },
        },
      },
    },
  });

  return rows
    .map((row): IncomingMember => {
      const { application } = row;
      const { applicant } = application;
      const person = applicant.applicantPerson;
      return {
        acceptanceId: row.id,
        applicationId: application.id,
        personId: person?.id ?? null,
        name: incomingName(applicant),
        licensedRN: person?.licensedRN ?? false,
        kind: kindFor(application.cycle.track),
        stage: stageFor(row.contract?.status),
        availabilityDates: applicationAvailabilityDates(application.answers, opts.clinicDates),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The incoming-roster entry for one person in one department, or null.
 *
 * The write-side counterpart of {@link listIncomingMembers}: the schedule builder
 * calls this to decide whether someone with no ACTIVE membership may still be
 * given a draft shift. Deliberately the same predicate as the list, so the
 * builder can never offer a cell that the write then refuses.
 */
export async function findIncomingMember(opts: {
  personId: string;
  termId: string;
  departmentCode: string;
}): Promise<{ acceptanceId: string; kind: "DIRECTOR" | "VOLUNTEER" } | null> {
  const row = await prisma.acceptance.findFirst({
    where: {
      AND: [
        liveAcceptanceWhere(),
        {
          departmentCode: opts.departmentCode,
          application: {
            cycle: { termId: opts.termId },
            applicant: { applicantPersonId: opts.personId },
          },
        },
      ],
    },
    select: { id: true, application: { select: { cycle: { select: { track: true } } } } },
  });
  if (!row) return null;
  return { acceptanceId: row.id, kind: kindFor(row.application.cycle.track) };
}

/**
 * The same question as {@link findIncomingMember}, asked by acceptance rather
 * than by person: is this acceptance still live for this department and term?
 *
 * What the builder asks before writing a draft for a first-time applicant, whose
 * row carries the acceptance because there is no person to carry.
 */
export async function findIncomingAcceptance(opts: {
  acceptanceId: string;
  termId: string;
  departmentCode: string;
}): Promise<{ acceptanceId: string; kind: "DIRECTOR" | "VOLUNTEER" } | null> {
  const row = await prisma.acceptance.findFirst({
    where: {
      AND: [
        liveAcceptanceWhere(),
        {
          id: opts.acceptanceId,
          departmentCode: opts.departmentCode,
          application: { cycle: { termId: opts.termId } },
        },
      ],
    },
    select: { id: true, application: { select: { cycle: { select: { track: true } } } } },
  });
  if (!row) return null;
  return { acceptanceId: row.id, kind: kindFor(row.application.cycle.track) };
}

/** One first-time applicant's draft shift, as the schedule builder renders it. */
export type IncomingShiftDraft = {
  acceptanceId: string;
  clinicDate: Date;
  role: "DIRECTOR" | "VOLUNTEER" | "SHADOW";
  triage: boolean;
  walkin: boolean;
  cc: boolean;
  remote: boolean;
  specialty: boolean;
  /** Same name the applicant's member row shows, via {@link incomingName}. */
  name: string;
  licensedRN: boolean;
};

/**
 * Every draft shift on a live acceptance in one (term, department).
 *
 * A draft on a WITHDRAWN applicant is left in place (withdrawal never tears down
 * the acceptance) but dropped here, so it disappears from the board along with
 * the person's row and stops counting toward the day. Promotion skips a withdrawn
 * applicant too, so it never becomes a real shift.
 */
export async function listIncomingShiftDrafts(opts: {
  termId: string;
  departmentId: string;
}): Promise<IncomingShiftDraft[]> {
  const rows = await prisma.incomingShiftAssignment.findMany({
    where: {
      termId: opts.termId,
      departmentId: opts.departmentId,
      acceptance: liveAcceptanceWhere(),
    },
    select: {
      acceptanceId: true,
      clinicDate: true,
      role: true,
      triage: true,
      walkin: true,
      cc: true,
      remote: true,
      specialty: true,
      acceptance: {
        select: {
          application: {
            select: {
              applicant: {
                select: {
                  firstName: true,
                  lastName: true,
                  applicantPerson: { select: { name: true, licensedRN: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  return rows.map(({ acceptance, ...draft }) => {
    const { applicant } = acceptance.application;
    return {
      ...draft,
      name: incomingName(applicant),
      licensedRN: applicant.applicantPerson?.licensedRN ?? false,
    };
  });
}

/**
 * Move an acceptance's draft shifts onto the real schedule for the person roster
 * build just resolved. Returns how many became ShiftAssignments.
 *
 * Runs inside promoteContracts' transaction, beside the membership write, so a
 * promotion that rolls back leaves the drafts exactly where they were.
 *
 * skipDuplicates is ON CONFLICT DO NOTHING, not a caught error: a unique
 * violation inside a Postgres transaction aborts it whatever a try/catch says,
 * and would roll back the whole promotion. A conflict means the person already
 * holds a shift that Saturday in that department (an alum matched by email who
 * was scheduled another way), and the shift they already have wins.
 */
export async function adoptIncomingShiftsTx(
  tx: TransactionClient,
  opts: { acceptanceId: string; personId: string },
): Promise<number> {
  const drafts = await tx.incomingShiftAssignment.findMany({
    where: { acceptanceId: opts.acceptanceId },
  });
  if (drafts.length === 0) return 0;
  const { count } = await tx.shiftAssignment.createMany({
    data: drafts.map((d) => ({
      termId: d.termId,
      departmentId: d.departmentId,
      personId: opts.personId,
      clinicDate: d.clinicDate,
      role: d.role,
      triage: d.triage,
      walkin: d.walkin,
      cc: d.cc,
      remote: d.remote,
      specialty: d.specialty,
    })),
    skipDuplicates: true,
  });
  await tx.incomingShiftAssignment.deleteMany({ where: { acceptanceId: opts.acceptanceId } });
  return count;
}
