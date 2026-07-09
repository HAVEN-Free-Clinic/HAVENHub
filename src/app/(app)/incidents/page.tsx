/**
 * "Report a concern" page for Incident Reports.
 *
 * Access: requirePersonSession() only -- open to any signed-in matched
 * person (gated further up by the module layout's requireModuleAccess, which
 * declares no accessPermission for this module). Renders the full 10-section
 * Professional Standards Incident Report and posts to submitReportAction.
 *
 * A director who manages one or more volunteers (issuablePeople returns a
 * non-empty `people` list) additionally sees a subject picker tied to a
 * "Request a strike" checkbox; submitReport enforces server-side that a
 * strike may only be requested against a volunteer in a department the actor
 * manages, so the UI gate here is a convenience, not the security boundary.
 *
 * On success, submitReportAction redirects to /incidents/mine?submitted=<n>.
 */

import { requirePersonSession } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Radio, RadioGroup } from "@/platform/ui/radio";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Button } from "@/platform/ui/button";
import { FormActions } from "@/platform/ui/form";
import { CONCERN_TYPES } from "@/modules/incidents/services/report";
import { issuablePeople } from "@/modules/incidents/services/disciplinary";
import { submitReportAction } from "./actions";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "subject-not-found": "The selected person could not be found.",
  "validation": "Please check your input and try again.",
};

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  searchParams: Promise<{
    error?: string;
    message?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ReportConcernPage({ searchParams }: PageProps) {
  const actor = await requirePersonSession();
  const sp = await searchParams;

  const errorCode = sp.error ?? null;
  // When error=validation the action encodes the raw message in ?message=.
  // All other unknown codes fall back to a generic string.
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : (ERROR_MESSAGES[errorCode] ?? "An unexpected error occurred.")
    : null;

  // Load the volunteers this actor manages (empty for central reviewers, who
  // issue strikes directly on the ledger rather than via a report request).
  const issuable = await issuablePeople(actor.personId);

  return (
    <div>
      <PageHeader
        title="Report a concern"
        description="File a Professional Standards Incident Report. Anyone signed in may report a concern about anyone."
      />

      {errorMessage && (
        <Alert tone="error" className="mt-4">
          {errorMessage}
        </Alert>
      )}

      <form action={submitReportAction} className="mt-8">
        <Card className="space-y-8">
          {/* Section 1: concern types */}
          <fieldset>
            <legend className="mb-2 text-sm font-medium">1. Type of concern (select all that apply)</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CONCERN_TYPES.map((t) => (
                <label key={t.value} className="flex items-start gap-2 text-sm">
                  <Checkbox name="concernTypes" value={t.value} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{t.label}</span> -{" "}
                    <span className="text-muted-foreground">{t.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Section 2: description */}
          <Field label="2. Describe what happened" required>
            <Textarea
              name="description"
              rows={5}
              required
              placeholder="Describe what happened, in as much detail as you can..."
            />
          </Field>

          {/* Section 3: date + setting */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="3. Date of the incident" hint="Leave blank if unknown">
              <Input type="date" name="occurredAt" />
            </Field>
            <Field label="Setting" hint="e.g. exam room, front desk, telehealth">
              <Input name="setting" placeholder="Optional" />
            </Field>
          </div>

          {/* Section 4: subject */}
          <Field label="4. Name, role, or department of the individual(s) of concern">
            <Textarea name="subjectDescription" rows={2} placeholder="If unknown, describe as observed" />
          </Field>
          {issuable.people.length > 0 && (
            <Field label="Or select a volunteer you manage (enables a strike request)">
              <Select name="subjectPersonId" defaultValue="">
                <option value="">Not a specific volunteer I manage</option>
                {issuable.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}
                    {p.departmentNames.length ? ` (${p.departmentNames.join(", ")})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* Section 5: patient impact */}
          <Field label="5. Was a patient directly impacted?">
            <Select name="patientImpact" defaultValue="">
              <option value="">Select...</option>
              <option value="YES">Yes</option>
              <option value="NO">No</option>
              <option value="UNSURE">Unsure</option>
            </Select>
          </Field>
          <Field label="If yes, briefly describe">
            <Textarea name="patientImpactDetail" rows={2} />
          </Field>

          {/* Section 6: immediate risk */}
          <fieldset>
            <legend className="mb-2 text-sm font-medium">6. Does this present an ongoing risk right now?</legend>
            <RadioGroup>
              <Radio name="immediateRisk" value="yes" label="Yes - needs urgent attention" />
              <Radio name="immediateRisk" value="no" defaultChecked label="No - resolved or not time-sensitive" />
            </RadioGroup>
          </fieldset>

          {/* Section 7: issue nature */}
          <Field label="7. Is this primarily a workflow/system failure rather than individual conduct?">
            <Select name="issueNature" defaultValue="">
              <option value="">Select...</option>
              <option value="SYSTEM">Yes - workflow or system gap</option>
              <option value="INDIVIDUAL">No - individual conduct</option>
              <option value="BOTH_UNSURE">Both / Unsure</option>
            </Select>
          </Field>

          {/* Section 8: prior occurrence */}
          <Field label="8. Has this type of incident occurred before, to your knowledge?">
            <Select name="priorOccurrence" defaultValue="">
              <option value="">Select...</option>
              <option value="YES">Yes - aware of prior similar incidents</option>
              <option value="NO">No - appears to be a first occurrence</option>
              <option value="UNSURE">Unsure</option>
            </Select>
          </Field>
          <Field label="Optional - any context on prior occurrences">
            <Textarea name="priorOccurrenceDetail" rows={2} />
          </Field>

          {/* Section 9: attachments */}
          <Field label="9. Attachments" hint="Optional. Photos, screenshots, or documents that support the report.">
            <input type="file" name="attachments" multiple className="text-sm" />
          </Field>

          {/* Section 10: name / anonymity / strike request */}
          <div className="space-y-3 border-t border-border pt-6">
            <h2 className="text-sm font-medium">10. Your information</h2>
            <Field label="Your name">
              <Input defaultValue={actor.name ?? ""} disabled />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="anonymous" /> I would prefer to remain anonymous (your name is not shared with the
              subject)
            </label>
            {issuable.people.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="requestStrike" /> Request a strike (only applies when you selected a volunteer you
                manage above; a reviewer approves)
              </label>
            )}
          </div>

          <FormActions>
            <Button type="submit">Submit report</Button>
          </FormActions>
        </Card>
      </form>
    </div>
  );
}
