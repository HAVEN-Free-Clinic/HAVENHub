/**
 * "Report a concern" page for Incident Reports.
 *
 * Access: requirePersonSession() only -- open to any signed-in matched
 * person (gated further up by the module layout's requireModuleAccess, which
 * declares no accessPermission for this module). Renders the full 10-section
 * Professional Standards Incident Report and posts to submitReportAction.
 *
 * Section 4 links the subject via a searchable person picker over everyone in
 * the system (SubjectPicker). A director who manages one or more volunteers can
 * additionally request a strike once they pick one of those volunteers;
 * submitReport enforces server-side that a strike may only be requested against
 * a volunteer in a department the actor manages, so the UI gate is a
 * convenience, not the security boundary.
 *
 * On success, submitReportAction redirects to /incidents/mine?submitted=<n>.
 */

import { requirePersonSession } from "@/platform/auth/session";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatForDateInput } from "@/platform/dates/format";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input, ReadonlyField, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Radio, RadioGroup } from "@/platform/ui/radio";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";
import { CONCERN_TYPES, listSubjectOptions } from "@/modules/incidents/services/report";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { ConcernTypesFieldset } from "./concern-types-fieldset";
import { IncidentAttachmentsField } from "./incident-attachments-field";
import { SubjectPicker } from "./subject-picker";
import { submitReportAction } from "./actions";
import { formReviewerDisclosure } from "./disclosure";

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
      ? sp.message
      : (ERROR_MESSAGES[errorCode] ?? "An unexpected error occurred.")
    : null;

  // People that can be linked as the subject (everyone), plus the volunteers the
  // actor manages (strike-eligible). Central reviewers get an empty eligible set
  // and issue strikes directly on the ledger rather than via a report request.
  const subject = await listSubjectOptions(actor.personId);

  // Server-stamped mirrors of two submitReport rules that had no client counterpart,
  // so an oversized attachment or a future date no longer discards the whole report on
  // a validation redirect (#17): today (in the display zone) as the date `max`, and the
  // uploads.maxMb cap for the attachments field's browser-side size guard.
  const zone = await getDisplayTimeZone();
  const todayIso = formatForDateInput(new Date(), zone);
  const maxUploadMb = await getSetting<number>("uploads.maxMb");

  // Same query notifyReviewersOfSubmission runs at submission time (report.ts),
  // so the count shown here matches the audience that actually gets notified,
  // not an approximation. Not filtered to exclude the actor: report.ts only
  // excludes a report's linked subjects from the reviewer set, never the
  // reporter, so a reporter who holds incidents.manage is themselves part of
  // this count -- excluding them here would understate the real audience.
  const reviewers = await peopleWithAnyPermission(["incidents.manage"]);

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
          {/* Section 1: concern types (client fieldset enforces at least one, so a
              validation miss never round-trips and discards the whole form) */}
          <ConcernTypesFieldset options={CONCERN_TYPES} />

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
              <Input type="date" name="occurredAt" max={todayIso} />
            </Field>
            <Field label="Setting" hint="e.g. exam room, front desk, telehealth">
              <Input name="setting" placeholder="Optional" />
            </Field>
          </div>

          {/* Section 4: subjects */}
          <Field label="4. Name, role, or department of the individual(s) of concern">
            <Textarea name="subjectDescription" rows={2} placeholder="If unknown, describe as observed" />
          </Field>
          <SubjectPicker people={subject.people} strikeEligibleIds={subject.strikeEligibleIds} />

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

          {/* Section 6: immediate risk. Neither option is pre-checked: this flag
              chooses between "flagged as an immediate risk" and plain "submitted"
              in the reviewer email and Teams card (report.ts), so a reporter who
              never reaches this below-the-fold question must answer it rather
              than silently submitting the de-escalating default. `required` on
              the radios (native HTML: any radio in a named group carrying it
              makes the whole group required) blocks the submit and moves focus
              here in-browser, so a report with several paragraphs already
              written is never discarded by a validation round-trip. */}
          <fieldset>
            <legend className="mb-2 text-sm font-medium">6. Does this present an ongoing risk right now?</legend>
            <RadioGroup>
              <Radio name="immediateRisk" value="yes" label="Yes - needs urgent attention" required />
              <Radio name="immediateRisk" value="no" label="No - resolved or not time-sensitive" required />
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
            <IncidentAttachmentsField maxMb={maxUploadMb} />
          </Field>

          {/* Section 10: name / anonymity / strike request */}
          <div className="space-y-3 border-t border-border pt-6">
            <h2 className="text-sm font-medium">10. Your information</h2>
            <ReadonlyField label="Your name" value={actor.name ?? ""} />
            <p className="text-xs text-subtle-foreground">{formReviewerDisclosure(reviewers.length)}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="anonymous" /> Do not share my name with the person I am reporting.
            </label>
          </div>

          <FormActions>
            <SubmitButton pendingLabel="Submitting…">Submit report</SubmitButton>
          </FormActions>
        </Card>
      </form>
    </div>
  );
}
