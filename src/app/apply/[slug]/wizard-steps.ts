import { isSectionVisible, type ApplicantType } from "@/modules/recruitment/engine/visibility";

export type WizardField = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
  visibleWhen?: unknown;
};

export type WizardSection = {
  id: string;
  title: string;
  description: string | null;
  appliesTo: "NEW" | "RENEWAL" | "BOTH";
  departmentCode: string | null;
  fields: WizardField[];
};

export type WizardStep =
  | { kind: "intro"; id: "intro"; title: string }
  | { kind: "section"; id: string; title: string; section: WizardSection }
  | { kind: "review"; id: "review"; title: string };

export function deriveSteps(input: {
  sections: WizardSection[];
  acceptsRenewals: boolean;
  applicantType: ApplicantType;
  selectedDepartmentCodes: string[];
}): WizardStep[] {
  const steps: WizardStep[] = [];
  if (input.acceptsRenewals) steps.push({ kind: "intro", id: "intro", title: "Getting started" });
  for (const s of input.sections) {
    const visible = isSectionVisible(
      { id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode },
      { applicantType: input.applicantType, selectedDepartmentCodes: input.selectedDepartmentCodes },
    );
    if (visible) steps.push({ kind: "section", id: s.id, title: s.title, section: s });
  }
  steps.push({ kind: "review", id: "review", title: "Review & submit" });
  return steps;
}

export function stepIndexForKeys(steps: WizardStep[], keys: string[]): number | null {
  if (keys.length === 0) return null;
  const set = new Set(keys);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.kind === "section" && st.section.fields.some((f) => set.has(f.key))) return i;
  }
  return null;
}
