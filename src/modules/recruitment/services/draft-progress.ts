/**
 * How far through the form an unsubmitted application actually is.
 *
 * The draft-reminder stream needs to say something true and specific -- "you
 * have your resume and your availability left" reads as a nudge; "your
 * application is incomplete" reads as spam -- so this measures a draft against
 * the same rules the wizard applies, rather than against a hardcoded list of
 * steps.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not test for the PRESENCE of an answer key. The onboarding contract
 *     fields are pre-seeded as empty strings on every draft, so `key in answers`
 *     is true for a form nobody has touched. Presence is judged by
 *     isValuePresent, which treats a blank string as unanswered.
 *
 *   - It does not read the cycle's stored options for the availability question.
 *     resolveAvailabilityOptions REMOVES that question when the term's clinic
 *     calendar is empty, so a progress measure that skipped it would tell an
 *     applicant to go fill in a step their form does not render.
 *
 * The computation is pure (progressFor); loadDraftProgress is the thin database
 * half, so the interesting logic is testable without a database.
 */

import { prisma } from "@/platform/db";
import { openClinicDates } from "@/platform/attendings/open-clinic-date";
import { isSectionVisible, type ApplicantType } from "../engine/visibility";
import { missingRequiredKeys, type RequirableField } from "../engine/required-fields";
import { resolveAvailabilityOptions } from "../templates/clinic-dates";
import { resolveSectionTitle } from "../templates/department-options";

export type ProgressSection = {
  id: string;
  title: string;
  appliesTo: "NEW" | "RENEWAL" | "BOTH";
  departmentCode: string | null;
  fields: RequirableField[];
};

export type ProgressStep = {
  id: string;
  title: string;
  /** No required question in this step is still unanswered. */
  complete: boolean;
  /** How many required questions in this step are still unanswered. */
  missingCount: number;
};

/**
 * How far along a draft is, in the terms the reminder email speaks in.
 *
 *   ready       -- every required question is answered. Nothing stands between
 *                  this applicant and a submission except pressing the button,
 *                  and the email says exactly that.
 *   almost_done -- one or two steps left.
 *   in_progress -- some steps done, three or more left.
 *   just_started-- nothing finished yet. The form was opened and abandoned.
 *
 * The tiers exist because one message cannot serve all four. Telling someone who
 * has finished everything to "continue your application" wastes the only send
 * that was ever going to convert them, and telling someone who has filled in
 * their name that they are "almost there" is a lie they can check.
 */
export type ProgressTier = "ready" | "almost_done" | "in_progress" | "just_started";

export type DraftProgress = {
  steps: ProgressStep[];
  /** Incomplete steps, in wizard order. */
  remaining: ProgressStep[];
  completedCount: number;
  totalCount: number;
  tier: ProgressTier;
};

function tierFor(steps: ProgressStep[], remaining: ProgressStep[]): ProgressTier {
  if (remaining.length === 0) return "ready";
  // Measured on completed steps rather than on remaining ones, so a short form
  // and a long one both call "nothing finished" just_started.
  if (remaining.length === steps.length) return "just_started";
  return remaining.length <= 2 ? "almost_done" : "in_progress";
}

/**
 * Pure progress computation. `sections` must already be the resolved list (the
 * availability question dropped when the calendar is empty); loadDraftProgress
 * does that resolution.
 */
export function progressFor(input: {
  sections: ProgressSection[];
  answers: Record<string, unknown>;
  applicantType: ApplicantType;
  selectedDepartmentCodes: string[];
}): DraftProgress {
  const steps: ProgressStep[] = [];
  for (const section of input.sections) {
    const visible = isSectionVisible(
      { id: section.id, appliesTo: section.appliesTo, departmentCode: section.departmentCode },
      { applicantType: input.applicantType, selectedDepartmentCodes: input.selectedDepartmentCodes },
    );
    if (!visible) continue;
    const missing = missingRequiredKeys(section.fields, input.answers);
    // A section of purely optional questions is always complete. It is still a
    // step the applicant walks through, so it stays in `steps` and counts toward
    // the total -- it just never appears in `remaining`.
    steps.push({ id: section.id, title: section.title, complete: missing.length === 0, missingCount: missing.length });
  }

  const remaining = steps.filter((s) => !s.complete);
  return {
    steps,
    remaining,
    completedCount: steps.length - remaining.length,
    totalCount: steps.length,
    tier: tierFor(steps, remaining),
  };
}

/**
 * The department codes this draft has chosen, which decide whether a department
 * supplement section is part of their form at all.
 *
 * Read from the live answers rather than from Application.departmentChoices: that
 * column is only hoisted out of the answers AT SUBMIT, so on a draft -- the only
 * kind of row this module ever looks at -- it is still the empty array it was
 * created with. Reading it would hide every department supplement from the count
 * and report a half-finished application as nearly done.
 */
export function selectedDepartmentsFrom(
  answers: Record<string, unknown>,
  fields: RequirableField[],
): string[] {
  const key = fields.find((f) => f.type === "DEPARTMENT_CHOICE")?.key;
  if (!key) return [];
  const value = answers[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return typeof value === "string" && value.trim() !== "" ? [value] : [];
}

/** Load a draft application's form and measure its progress. Returns null when
 *  the application is gone or is not a draft. */
export async function loadDraftProgress(applicationId: string): Promise<DraftProgress | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      status: true,
      answers: true,
      applicantType: true,
      cycle: {
        select: {
          termId: true,
          departments: true,
          term: { select: { clinicDates: true } },
          sections: {
            where: { purpose: "APPLICATION" },
            orderBy: { order: "asc" },
            select: {
              id: true,
              title: true,
              appliesTo: true,
              departmentCode: true,
              fields: {
                orderBy: { order: "asc" },
                select: { key: true, required: true, type: true, visibleWhen: true, validation: true },
              },
            },
          },
        },
      },
    },
  });
  if (!app || app.status !== "DRAFT") return null;

  const sections = resolveAvailabilityOptions(
    // resolveAvailabilityOptions matches on the availability field's key and
    // needs an `options` property to rewrite; these rows are selected without
    // one, so give it the shape it expects.
    app.cycle.sections.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, options: null })) })),
    await openClinicDates({ id: app.cycle.termId, clinicDates: app.cycle.term.clinicDates }),
  );

  // Department supplement titles carry the department CODE, baked in at cycle
  // creation; the page swaps in the real name at render time. The email lists
  // these titles verbatim, so it has to do the same swap or it tells an applicant
  // to finish "SRHD department questions".
  const departmentRows = app.cycle.departments.length
    ? await prisma.department.findMany({
        where: { code: { in: app.cycle.departments } },
        select: { code: true, name: true },
      })
    : [];

  const answers = (app.answers as Record<string, unknown>) ?? {};
  const allFields = sections.flatMap((s) => s.fields);
  return progressFor({
    sections: sections.map((s) => ({
      id: s.id,
      title: resolveSectionTitle(s, departmentRows),
      appliesTo: s.appliesTo,
      departmentCode: s.departmentCode,
      fields: s.fields,
    })),
    answers,
    applicantType: app.applicantType,
    selectedDepartmentCodes: selectedDepartmentsFrom(answers, allFields),
  });
}
