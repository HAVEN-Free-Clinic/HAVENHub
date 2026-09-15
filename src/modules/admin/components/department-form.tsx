import type { Department, EpicRequirement } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { SubmitButton } from "@/platform/ui/submit-button";
// ./catalog, not the package root: the root imports prisma and notify, and this
// is a presentational form that must not drag the server graph into a bundle.
import { CLINIC_WIDE_INTERPRETER_MIN_SCORE } from "@/platform/languages/catalog";

type DepartmentFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  department?: Pick<
    Department,
    | "code"
    | "name"
    | "isActive"
    | "idealHeadcount"
    | "patientCapacityPerProvider"
    | "requiresEpicDirector"
    | "requiresEpicVolunteer"
    | "autoRouteApplicants"
    | "allowShiftDrop"
    | "hoursPerShift"
    | "minInterpreterScore"
    | "assessLanguageBeforeAcceptance"
    | "assessSpanishRegardlessOfClaim"
  >;
};

/** Ordered least → most access; the value is the stored EpicRequirement enum. */
const EPIC_OPTIONS: { value: EpicRequirement; label: string }[] = [
  { value: "NONE", label: "Not required" },
  { value: "ALL", label: "Required for all" },
];

/** Create/edit form for a Department. Code is editable on create, read-only on edit. */
export function DepartmentForm({ action, mode, department }: DepartmentFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Code"
            required={mode === "create"}
            hint={mode === "edit" ? "Code cannot be changed after creation." : "2-12 letters/digits, e.g. SCTS. Uppercased automatically."}
          >
            <Input
              name="code"
              defaultValue={department?.code ?? ""}
              required={mode === "create"}
              disabled={mode === "edit"}
              placeholder="SCTS"
            />
          </Field>

          <Field label="Name" required>
            <Input name="name" defaultValue={department?.name ?? ""} required placeholder="Surgical Care Team" />
          </Field>

          <Field label="Ideal headcount" hint="Optional.">
            <Input name="idealHeadcount" type="number" min="1" defaultValue={String(department?.idealHeadcount ?? "")} />
          </Field>

          <Field label="Patient capacity per provider" hint="Optional.">
            <Input
              name="patientCapacityPerProvider"
              type="number"
              min="1"
              defaultValue={String(department?.patientCapacityPerProvider ?? "")}
            />
          </Field>

          <Field
            label="Hours per shift"
            hint="Used for volunteer service records. Leave blank if unknown: blank reads as 'not recorded' rather than zero hours."
          >
            <Input
              name="hoursPerShift"
              type="number"
              min="0"
              step="0.25"
              defaultValue={department?.hoursPerShift != null ? String(department.hoursPerShift) : ""}
            />
          </Field>
          <Field
            label="Minimum interpreter score"
            hint={`Lowest INTP Spanish proficiency score (1-5) this department will staff as an interpreter. Leave blank for the clinic-wide bar of ${CLINIC_WIDE_INTERPRETER_MIN_SCORE}. Departments that accept conversational speakers set 3. Advisory: the schedule flags a shortfall, it does not refuse the assignment.`}
          >
            <Input
              name="minInterpreterScore"
              type="number"
              min="1"
              max="5"
              step="1"
              defaultValue={
                department?.minInterpreterScore != null
                  ? String(department.minInterpreterScore)
                  : ""
              }
            />
          </Field>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Epic access requirement</p>
            <p className="text-xs text-muted-foreground">
              Decides Epic for everyone accepted into this department; the onboarding contract never asks. Required
              for all shows the Epic section and requests access for anyone without an Epic ID on file. Not required
              hides the section and requests nothing.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Directors">
              <Select name="requiresEpicDirector" defaultValue={department?.requiresEpicDirector ?? "NONE"}>
                {EPIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Volunteers">
              <Select name="requiresEpicVolunteer" defaultValue={department?.requiresEpicVolunteer ?? "NONE"}>
                {EPIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="space-y-2">
          <Checkbox
            name="autoRouteApplicants"
            defaultChecked={department?.autoRouteApplicants ?? false}
            label="Skip committee scoring for applicants who rank this department first"
          />
          <p className="text-xs text-muted-foreground">
            For clinical teams where the department verifies credentials rather than the committee judging fit.
            New and transfer applicants whose FIRST choice is this department are routed straight here at submit,
            with no committee score. Returning members already skip scoring for their own department regardless of
            this setting.
          </p>
        </div>

        <div className="space-y-2">
          <Checkbox
            name="assessLanguageBeforeAcceptance"
            defaultChecked={department?.assessLanguageBeforeAcceptance ?? false}
            label="Assess applicants' languages before accepting them"
          />
          <p className="text-xs text-muted-foreground">
            For departments where speaking the language IS the job. Applicants to this department
            appear in the interpreting department&rsquo;s language review queue for the languages
            they listed as soon as they apply, rather than after they are promoted, so the
            assessment is on the table when the decision is made. Advisory only: it never blocks an
            acceptance. Anyone with an assessment already on file is skipped.
          </p>
        </div>

        <div className="space-y-2">
          <Checkbox
            name="assessSpanishRegardlessOfClaim"
            defaultChecked={department?.assessSpanishRegardlessOfClaim ?? false}
            label="Also assess every applicant on Spanish, even if they did not list it"
          />
          <p className="text-xs text-muted-foreground">
            Only applies when the setting above is on. For departments where speaking Spanish with
            patients is the job. Leave it off where applicants may work in another language, as in
            Interpreting: those applicants are assessed only on the languages they listed.
          </p>
        </div>

        <div className="space-y-2">
          <Checkbox
            name="allowShiftDrop"
            defaultChecked={department?.allowShiftDrop ?? true}
            label="Let members drop a shift without a swap partner"
          />
          <p className="text-xs text-muted-foreground">
            On by default. Turn it off for teams where an empty seat means an unstaffed patient: members then
            see only the swap form on their schedule, and a drop has to be arranged with the department&rsquo;s
            directors out of band. Swaps are unaffected either way.
          </p>
        </div>

        <Checkbox
          name="isActive"
          defaultChecked={department?.isActive ?? true}
          label="Active"
          hint="Clearing this is the soft remove: the department stops being offered, and its history stays."
        />

        <FormActions>
          <SubmitButton variant="primary">
            {mode === "create" ? "Create department" : "Save changes"}
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
