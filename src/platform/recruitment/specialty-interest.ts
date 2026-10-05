/**
 * The SCTP/JCTP "Are you interested in a specialty clinic (neurology,
 * nephrology, or dermatology)?" answer, read back off the application.
 *
 * The question is not in the code templates: FA26 added it per cycle through
 * the form builder, once in each section that needed it, so its field key is a
 * derived slug ("single_checkbox_2", "dropdown_one_2") that differs between the
 * copies and will differ again next cycle. A fixed key constant like
 * AVAILABILITY_FIELD_KEY would silently read nothing. Instead each cycle's
 * fields are matched on their LABEL, and the stored option value is mapped back
 * to that field's option label.
 *
 * Read live rather than hoisted onto Person: nothing writes it, and reading the
 * application means every answer already submitted shows up with no backfill.
 *
 * Lives in platform because the schedule builder (schedule module) and the
 * member profile (volunteers module) both need it, and a module may not import
 * another module.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { kindFor } from "@/platform/recruitment/incoming-roster";

/** Case-insensitive substring every copy of the question carries. */
const LABEL_MATCH = "specialty clinic";

export type SpecialtyInterest = {
  /** The option label the applicant chose, e.g. "Yes (BOTH primary care and specialty clinic)". */
  answer: string;
  /** Said yes in any form. A "No (only primary care)" answer is still returned, with this false. */
  interested: boolean;
  /** Wants ONLY specialty clinic, not primary care. */
  only: boolean;
};

type QuestionField = { key: string; options: { value: string; label: string }[] };

function parseOptions(raw: Prisma.JsonValue | null): QuestionField["options"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) =>
    o && typeof o === "object" && !Array.isArray(o) && typeof o.value === "string" && typeof o.label === "string"
      ? [{ value: o.value, label: o.label }]
      : [],
  );
}

/** Classify one chosen label. Exported for tests. */
export function classifySpecialtyAnswer(answer: string): SpecialtyInterest {
  const interested = !/^\s*no\b/i.test(answer);
  return { answer, interested, only: interested && /\bonly\b/i.test(answer) };
}

/** The question's fields per cycle, in form order. */
async function questionFieldsByCycle(cycleIds: string[]): Promise<Map<string, QuestionField[]>> {
  const out = new Map<string, QuestionField[]>();
  if (cycleIds.length === 0) return out;
  const fields = await prisma.formField.findMany({
    where: {
      cycleId: { in: [...new Set(cycleIds)] },
      label: { contains: LABEL_MATCH, mode: "insensitive" },
      type: { in: ["SINGLE_SELECT", "MULTI_SELECT"] },
    },
    select: { cycleId: true, key: true, options: true },
    orderBy: [{ section: { order: "asc" } }, { order: "asc" }],
  });
  for (const f of fields) {
    const list = out.get(f.cycleId) ?? [];
    list.push({ key: f.key, options: parseOptions(f.options) });
    out.set(f.cycleId, list);
  }
  return out;
}

/** The first copy of the question this application answered, or null. */
function interestOf(answers: Prisma.JsonValue, fields: QuestionField[]): SpecialtyInterest | null {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  for (const field of fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string" && v !== "");
    if (values.length === 0) continue;
    const label = values.map((v) => field.options.find((o) => o.value === v)?.label ?? v).join(", ");
    return classifySpecialtyAnswer(label);
  }
  return null;
}

/**
 * Specialty interest per application id, for the applications that answered.
 * An application whose cycle never asked, or that left it blank, is absent.
 */
export async function specialtyInterestByApplication(
  applicationIds: string[],
): Promise<Map<string, SpecialtyInterest>> {
  const out = new Map<string, SpecialtyInterest>();
  if (applicationIds.length === 0) return out;
  const apps = await prisma.application.findMany({
    where: { id: { in: [...new Set(applicationIds)] } },
    select: { id: true, cycleId: true, answers: true },
  });
  const fields = await questionFieldsByCycle(apps.map((a) => a.cycleId));
  for (const app of apps) {
    const interest = interestOf(app.answers, fields.get(app.cycleId) ?? []);
    if (interest) out.set(app.id, interest);
  }
  return out;
}

/**
 * Specialty interest for people already ON the roster of one (term,
 * department), keyed `${personId}:${kind}` like newcomersByMember, read back
 * through the promoted onboarding contract. Latest promotion wins.
 */
export async function specialtyInterestByMember(opts: {
  termId: string;
  departmentCode: string;
  personIds: string[];
}): Promise<Map<string, SpecialtyInterest>> {
  if (opts.personIds.length === 0) return new Map();
  const rows = await prisma.onboardingContract.findMany({
    where: {
      status: "PROMOTED",
      promotedPersonId: { in: opts.personIds },
      acceptance: {
        application: {
          cycle: { termId: opts.termId },
          acceptances: { some: { departmentCode: opts.departmentCode } },
        },
      },
    },
    select: {
      promotedPersonId: true,
      acceptance: { select: { application: { select: { id: true, cycle: { select: { track: true } } } } } },
    },
    orderBy: { promotedAt: "asc" },
  });
  const byApp = await specialtyInterestByApplication(rows.map((r) => r.acceptance.application.id));
  const out = new Map<string, SpecialtyInterest>();
  for (const row of rows) {
    if (!row.promotedPersonId) continue;
    const { application } = row.acceptance;
    const key = `${row.promotedPersonId}:${kindFor(application.cycle.track)}`;
    const interest = byApp.get(application.id);
    if (interest) out.set(key, interest);
    else out.delete(key);
  }
  return out;
}

/**
 * One person's answer on their application for `termId`, for the member
 * profile: the application roster build promoted them from, or, before roster
 * build, the one they submitted signed in. Most recently submitted wins.
 */
export async function specialtyInterestForPerson(opts: {
  personId: string;
  termId: string;
}): Promise<SpecialtyInterest | null> {
  const apps = await prisma.application.findMany({
    where: {
      status: "SUBMITTED",
      cycle: { termId: opts.termId },
      OR: [
        { applicant: { applicantPersonId: opts.personId } },
        { acceptances: { some: { contract: { promotedPersonId: opts.personId } } } },
      ],
    },
    select: { id: true },
    orderBy: { submittedAt: "desc" },
  });
  const byApp = await specialtyInterestByApplication(apps.map((a) => a.id));
  for (const app of apps) {
    const interest = byApp.get(app.id);
    if (interest) return interest;
  }
  return null;
}
