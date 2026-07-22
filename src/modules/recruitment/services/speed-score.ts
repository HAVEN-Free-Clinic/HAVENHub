import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getApplication } from "./submissions";
import { reviewScope, canViewApplication } from "./review";
import { visibleSections, applicantTypeLabel } from "../engine/visibility";
import { isFieldVisible } from "../engine/field-visibility";
import { isInlinePreviewable } from "./file-preview";

export type ReviewFieldView = {
  key: string;
  label: string;
  kind: "scalar" | "essay" | "file";
  displayValue: string; // resolved option label(s); "" when unanswered
  file: { key: string; fileName: string; inlineHref: string; inlinePreviewable: boolean } | null;
};
export type ReviewSectionView = { title: string; fields: ReviewFieldView[] };
export type ReviewApplicationView = {
  applicationId: string;
  name: string;
  email: string;
  typeLabel: string; // New | Renewal | Transfer
  departmentChoices: string[]; // codes; shown as header chips only
  sections: ReviewSectionView[];
};

type OptionList = { value: string; label: string }[];
function parseOptions(raw: unknown): OptionList {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is { value: string; label: string } =>
      !!o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string" && typeof (o as { label?: unknown }).label === "string",
  );
}
function labelFor(options: OptionList, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Build the condensed, reviewer-facing view of one application: option labels
 *  resolved, `visibleWhen`-hidden fields dropped, each field tagged with a
 *  layout `kind`. Re-checks view access (defense in depth). */
export async function loadReviewApplication(
  applicationId: string,
  viewerId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }> {
  const app = await getApplication(applicationId);
  if (!app) return { error: "Application not found." };

  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  if (!canViewApplication(app, { scope, managesCycles, canScore })) {
    return { error: "You can't view this application." };
  }

  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const condAnswers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === "string") condAnswers[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) condAnswers[k] = v as string[];
  }

  const shown = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });

  // The ranking lives in its own column, hoisted by submissions.ts from the FIRST
  // SUBCOMMITTEE_RANK field only. Mirror that here: a form carrying several rank
  // fields otherwise rendered the one hoisted ranking once per field, as N
  // identical "Subcommittee ranking" rows.
  const rankFieldId =
    app.cycle.sections.flatMap((s) => s.fields).find((f) => f.type === "SUBCOMMITTEE_RANK")?.id ?? null;
  const needsSubNames = rankFieldId != null && shown.some((s) => s.fields.some((f) => f.id === rankFieldId));
  const subNames = new Map<string, string>();
  if (needsSubNames && app.subcommitteeRanking.length > 0) {
    const rows = await prisma.subcommittee.findMany({
      where: { id: { in: app.subcommitteeRanking } },
      select: { id: true, name: true },
    });
    for (const r of rows) subNames.set(r.id, r.name);
  }

  const sections: ReviewSectionView[] = [];
  for (const section of shown) {
    const fields: ReviewFieldView[] = [];
    for (const f of section.fields) {
      if (f.type === "DEPARTMENT_CHOICE") continue; // shown as header chips
      if (!isFieldVisible(f.visibleWhen, condAnswers)) continue;

      if (f.type === "FILE") {
        const raw = answers[f.key];
        const ref = raw && typeof raw === "object" ? (raw as { storedName?: string; fileName?: string; mimeType?: string }) : null;
        if (!ref?.storedName) continue;
        fields.push({
          key: f.key,
          label: f.label,
          kind: "file",
          displayValue: ref.fileName ?? "(file)",
          file: {
            key: f.key,
            fileName: ref.fileName ?? "(file)",
            inlineHref: `/api/recruitment/applications/${app.id}/files/${encodeURIComponent(f.key)}?inline=1`,
            inlinePreviewable: isInlinePreviewable(ref.mimeType),
          },
        });
        continue;
      }

      if (f.type === "SIGNATURE") {
        // A SIGNATURE answer is a stored-blob ref object; without this it fell
        // through to String(val) and rendered as the literal "[object Object]".
        const raw = answers[f.key];
        if (!(raw && typeof raw === "object" && "storedName" in (raw as object))) continue;
        fields.push({ key: f.key, label: f.label, kind: "scalar", displayValue: "Signed", file: null });
        continue;
      }

      let displayValue = "";
      if (f.type === "SUBCOMMITTEE_RANK") {
        if (f.id !== rankFieldId) continue; // nothing was hoisted for the extra rank fields
        displayValue = app.subcommitteeRanking.map((id, i) => `${i + 1}. ${subNames.get(id) ?? "(removed)"}`).join("  ·  ");
      } else {
        const val = answers[f.key];
        const options = parseOptions(f.options);
        if (f.type === "SINGLE_SELECT" && typeof val === "string") displayValue = labelFor(options, val);
        else if (f.type === "MULTI_SELECT" && Array.isArray(val)) displayValue = val.map((v) => labelFor(options, String(v))).join(", ");
        else if (Array.isArray(val)) displayValue = val.join(", ");
        else if (val === undefined || val === null || val === "") displayValue = "";
        else displayValue = String(val);
      }
      if (displayValue === "") continue; // condensed: skip empties

      fields.push({
        key: f.key,
        label: f.label,
        kind: f.type === "LONG_TEXT" ? "essay" : "scalar",
        displayValue,
        file: null,
      });
    }
    if (fields.length > 0) sections.push({ title: section.title, fields });
  }

  return {
    view: {
      applicationId: app.id,
      name: `${app.applicant.firstName} ${app.applicant.lastName}`,
      email: app.applicant.email,
      typeLabel: applicantTypeLabel(app.applicantType),
      departmentChoices: app.departmentChoices,
      sections,
    },
  };
}
