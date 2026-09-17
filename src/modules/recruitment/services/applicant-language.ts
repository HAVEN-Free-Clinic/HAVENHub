import { prisma } from "@/platform/db";
import { languagesToAssessBeforeAcceptance, priorLanguageVerdicts } from "@/platform/languages";
import type { RosterLanguageStatus } from "../engine/applicant-language";

/**
 * The language verdicts behind the applicant roster's Language column.
 *
 * One query for the whole roster rather than one per row, the same shape
 * serviceGapsForCycle already uses on this page: priorLanguageVerdicts reads
 * three sources (member profile, other applications, imported history) and
 * resolving that per row would be dozens of round trips on a long cycle.
 *
 * Scoped to the lane on purpose. Only departments carrying
 * assessLanguageBeforeAcceptance assess before deciding, so on every other
 * cycle there is no column to draw and `inLane` comes back false -- rather than
 * a column of dashes on every roster in the app.
 */

/** The fields the lane test and the owed-languages rule read. ReviewApplication
 *  satisfies this structurally, which keeps this signature free of Prisma types. */
export type LanguageRosterApplication = {
  id: string;
  applicantId: string;
  departmentChoices: string[];
  dualRoleDepartments: string[];
  routedDepartmentCode: string | null;
  renewalDepartment: string | null;
  languagesClaimed: string[];
};

export type RosterLanguage = {
  /**
   * Whether any row on this roster is in the lane at all. The page draws the
   * column, the filter and the sort header only when this is true.
   */
  inLane: boolean;
  byApplicationId: Map<string, RosterLanguageStatus>;
};

/** The lane departments this application touches, by the same union
 *  languagesToAssessBeforeAcceptance measures its own Spanish rule against. */
function touchesLane(app: LanguageRosterApplication, laneCodes: readonly string[]): boolean {
  return [
    ...app.departmentChoices,
    ...app.dualRoleDepartments,
    ...(app.routedDepartmentCode ? [app.routedDepartmentCode] : []),
    ...(app.renewalDepartment ? [app.renewalDepartment] : []),
  ].some((code) => laneCodes.includes(code));
}

export async function rosterLanguageStatus(
  apps: readonly LanguageRosterApplication[],
): Promise<RosterLanguage> {
  const byApplicationId = new Map<string, RosterLanguageStatus>();
  if (apps.length === 0) return { inLane: false, byApplicationId };

  const laneDepartments = await prisma.department.findMany({
    where: { assessLanguageBeforeAcceptance: true },
    select: { code: true, assessSpanishRegardlessOfClaim: true },
  });
  const laneCodes = laneDepartments.map((d) => d.code);
  if (laneCodes.length === 0) return { inLane: false, byApplicationId };
  const spanishRegardlessCodes = laneDepartments
    .filter((d) => d.assessSpanishRegardlessOfClaim)
    .map((d) => d.code);

  // languagesToAssessBeforeAcceptance returns an applicant's claimed languages
  // whatever department they applied to, so the lane test has to happen here.
  // Without it every applicant on every cycle would be queued for a verdict no
  // department ever intends to record.
  const inLaneApps = apps.filter((a) => touchesLane(a, laneCodes));
  if (inLaneApps.length === 0) return { inLane: false, byApplicationId };

  const onFileByApplicant = await priorLanguageVerdicts(inLaneApps.map((a) => a.applicantId));

  for (const app of inLaneApps) {
    const onFile = onFileByApplicant.get(app.applicantId) ?? new Map();
    // Owed first, then any language that already has a verdict, matching the
    // detail page's assessableLanguages: a verdict on file is worth showing
    // even for a language this application is not itself assessed on, and it
    // can never add outstanding work because it is never null.
    const languages = [
      ...new Set([...languagesToAssessBeforeAcceptance(app, spanishRegardlessCodes), ...onFile.keys()]),
    ];
    byApplicationId.set(app.id, {
      entries: languages.map((language) => {
        const verdict = onFile.get(language);
        return {
          language,
          verdict: verdict
            ? { language, verified: verdict.verified, score: verdict.score }
            : null,
        };
      }),
    });
  }
  return { inLane: true, byApplicationId };
}
