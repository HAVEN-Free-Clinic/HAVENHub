"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { FormSection, linkifyUrls } from "@/platform/ui/form";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { visibleFields } from "@/modules/recruitment/engine/field-visibility";
import { visibleSections, applicantTypeLabel, type ApplicantType } from "@/modules/recruitment/engine/visibility";
import { departmentChoiceOptions, resolveSectionTitle, type DepartmentNameRow } from "@/modules/recruitment/templates/department-options";
import type { BuilderSection } from "./section-card";

/**
 * A read-only-but-interactive preview of the applicant form, rendered from the
 * builder's in-hand section/field data through the SAME FieldPreview renderer
 * and visibility engine (visibleSections / visibleFields) the live apply wizard
 * uses. Staff pick an applicant type + departments to see how those change which
 * sections appear, and can fill fields locally so conditional (visibleWhen)
 * questions reveal exactly as an applicant would experience them. Nothing is
 * saved; closing the modal discards everything.
 *
 * Department names and generated section titles are resolved through the same
 * departmentChoiceOptions / resolveSectionTitle functions apply/[slug]/page.tsx
 * uses for the live wizard (not a second, parallel mechanism), so this preview
 * cannot disagree with what an applicant actually sees on the two things this
 * matters for: the DEPARTMENT_CHOICE dropdown's labels and a supplement
 * section's generated title. Resolved only here, at render time -- `sections`
 * itself (and its stored `title`) is untouched, since SectionCard's own title
 * editor needs the raw stored value, not the resolved display name.
 */
export function ApplyPreview({
  open,
  onClose,
  sections,
  departments,
  departmentNames,
  subcommittees,
  acceptsRenewals,
  cycleTitle,
}: {
  open: boolean;
  onClose: () => void;
  sections: BuilderSection[];
  departments: string[];
  departmentNames: DepartmentNameRow[];
  subcommittees: { id: string; name: string }[];
  acceptsRenewals: boolean;
  cycleTitle: string;
}) {
  const [applicantType, setApplicantType] = useState<ApplicantType>("NEW");
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const shownSections = useMemo(
    () => visibleSections(sections, { applicantType, selectedDepartmentCodes: selectedDepartments }),
    [sections, applicantType, selectedDepartments],
  );

  const departmentOptions = useMemo(
    () => departmentChoiceOptions(departments, departmentNames),
    [departments, departmentNames],
  );

  function handleValueChange(key: string, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function toggleDepartment(code: string) {
    setSelectedDepartments((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  // A RENEWAL only differs from NEW when the cycle accepts returning applicants;
  // otherwise there is nothing to toggle. (TRANSFER is scoped to NEW for section
  // visibility, so it would render identically and is omitted to avoid confusion.)
  const types: ApplicantType[] = acceptsRenewals ? ["NEW", "RENEWAL"] : ["NEW"];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Form preview"
      size="large"
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Close preview
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        This is how applicants see <span className="font-medium text-foreground">{cycleTitle}</span>. Nothing here is
        saved. Fill fields to see conditional questions appear just as an applicant would.
      </p>

      <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/40 p-3">
        {types.length > 1 && (
          <div>
            <span className="text-xs font-medium text-foreground">Preview as</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {types.map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={applicantType === t ? "primary" : "outline"}
                  onClick={() => setApplicantType(t)}
                >
                  {applicantTypeLabel(t)} applicant
                </Button>
              ))}
            </div>
          </div>
        )}
        {departments.length > 0 && (
          <div>
            <span className="text-xs font-medium text-foreground">
              Selected departments <span className="font-normal text-subtle-foreground">(reveals department supplements)</span>
            </span>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {departments.map((code) => (
                <label key={code} className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox checked={selectedDepartments.includes(code)} onChange={() => toggleDepartment(code)} />
                  {code}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Submit is suppressed: the form only exists so group controls
          (MULTI_SELECT / SUBCOMMITTEE_RANK) can read their sibling values back
          for live visibleWhen evaluation. */}
      <form className="mt-4 space-y-4" onSubmit={(e) => e.preventDefault()}>
        {shownSections.length === 0 ? (
          <p className="text-sm text-subtle-foreground">No sections are shown for this applicant.</p>
        ) : (
          shownSections.map((section) => {
            const fields = visibleFields(section.fields, answers);
            return (
              <Card key={section.id} className="space-y-4">
                <FormSection title={resolveSectionTitle(section, departmentNames)} description={section.description ? linkifyUrls(section.description) : undefined}>
                  {fields.length === 0 ? (
                    <p className="text-sm text-subtle-foreground">No questions are shown here yet.</p>
                  ) : (
                    fields.map((f) => (
                      <FieldPreview
                        key={f.key}
                        f={f.type === "DEPARTMENT_CHOICE" ? { ...f, options: departmentOptions } : f}
                        departments={departments}
                        subcommittees={subcommittees}
                        onValueChange={handleValueChange}
                      />
                    ))
                  )}
                </FormSection>
              </Card>
            );
          })
        )}
      </form>
    </Modal>
  );
}
