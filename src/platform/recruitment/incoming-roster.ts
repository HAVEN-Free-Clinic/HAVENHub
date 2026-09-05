/**
 * The incoming roster: people accepted into a department for a term whose roster
 * build has not happened yet.
 *
 * It lives in platform because two modules need the same answer and a module may
 * not import another module. Recruitment owns the acceptance and turns it into a
 * TermMembership at roster build (promoteContracts); schedule needs to see the
 * same people BEFORE that, so a director can draft next term's schedule against
 * the returners who have already applied, been accepted, and given availability
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
 */

import { prisma } from "@/platform/db";
import { isoDateKey } from "@/platform/dates";

/**
 * The one application field whose options are owned by the term's clinic
 * calendar rather than by the form builder.
 *
 * Read by the form templates (to swap in the live calendar), by submission (to
 * normalize the answer), by promotion (to seed baselineAvailability), and by
 * {@link listIncomingMembers} below. It is one literal because those four must
 * agree about which answer holds availability.
 */
export const AVAILABILITY_FIELD_KEY = "availability";

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
   * roster build mints one, and nothing keyed on a person -- a ShiftAssignment
   * above all -- can reference them until then.
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

/**
 * Everyone accepted into `departmentCode` for `termId` who is not on the roster
 * yet, ordered by name.
 *
 * Excluded:
 *   - a PROMOTED contract, because roster build already gave them a real
 *     TermMembership and they arrive through the roster read instead;
 *   - a WITHDRAWN application. Withdrawal deliberately leaves the acceptance and
 *     contract intact (tearing them down would cascade away signatures, DOB, and
 *     the HIPAA cert), so the acceptance still looks live and nothing else here
 *     would catch it. promoteContracts skips these for the same reason.
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
      departmentCode: opts.departmentCode,
      application: {
        status: { not: "WITHDRAWN" },
        cycle: { termId: opts.termId },
      },
      OR: [{ contract: { is: null } }, { contract: { status: { not: "PROMOTED" } } }],
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
        // The Person name wins when there is one: it is the name the rest of the
        // roster shows this human by, and an application can be years old.
        name: person?.name ?? `${applicant.firstName} ${applicant.lastName}`.trim(),
        licensedRN: person?.licensedRN ?? false,
        kind: application.cycle.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER",
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
      departmentCode: opts.departmentCode,
      application: {
        status: { not: "WITHDRAWN" },
        cycle: { termId: opts.termId },
        applicant: { applicantPersonId: opts.personId },
      },
      OR: [{ contract: { is: null } }, { contract: { status: { not: "PROMOTED" } } }],
    },
    select: { id: true, application: { select: { cycle: { select: { track: true } } } } },
  });
  if (!row) return null;
  return {
    acceptanceId: row.id,
    kind: row.application.cycle.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER",
  };
}
