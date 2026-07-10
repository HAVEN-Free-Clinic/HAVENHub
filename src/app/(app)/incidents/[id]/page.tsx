/**
 * Incident report detail page (owner + reviewer view).
 *
 * Access: requirePersonSession() then getReport(personId, id), which allows
 * the reporter (owner) or a holder of incidents.manage and throws
 * IncidentForbiddenError/IncidentNotFoundError otherwise -- both caught here
 * and rendered as a 404 via notFound() so an unauthorized viewer cannot tell
 * a report exists from a missing one.
 *
 * The core fields are READ-ONLY for both audiences. When canManage (the
 * service already strips reviewNotes to null for non-managers, even the
 * owner), a "Reviewer controls" section renders: a status/reviewNotes form
 * bound to reviewReportAction, and, when strikeDecision is PENDING, an
 * approve/decline form pair bound to decideStrikeAction (Task 15). Attachments
 * link to the Task 16 download route, which does not exist yet; the anchor is
 * rendered ahead of that route landing.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  getReport,
  CONCERN_TYPES,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "@/modules/incidents/services/report";
import { DISCIPLINARY_CATEGORIES } from "@/modules/incidents/services/disciplinary";
import { reviewReportAction, decideStrikeAction } from "../actions";
import type {
  IncidentReportStatus,
  PatientImpact,
  IssueNature,
  PriorOccurrence,
  StrikeDecision,
} from "@prisma/client";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { FormActions } from "@/platform/ui/form";
import { Alert } from "@/platform/ui/alert";
import { fmtDate } from "@/platform/dates";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type BadgeTone = "default" | "success" | "warning" | "critical";

const STATUS_LABELS: Record<IncidentReportStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  RESOLVED: "Resolved",
  DISMISSED: "Dismissed",
};

const STATUS_TONES: Record<IncidentReportStatus, BadgeTone> = {
  SUBMITTED: "default",
  UNDER_REVIEW: "warning",
  RESOLVED: "success",
  DISMISSED: "default",
};

const STRIKE_LABELS: Record<StrikeDecision, string> = {
  PENDING: "Strike requested",
  APPROVED: "Strike issued",
  DECLINED: "Strike declined",
};

const STRIKE_TONES: Record<StrikeDecision, BadgeTone> = {
  PENDING: "warning",
  APPROVED: "success",
  DECLINED: "default",
};

const PATIENT_IMPACT_LABELS: Record<PatientImpact, string> = {
  YES: "Yes",
  NO: "No",
  UNSURE: "Unsure",
};

const ISSUE_NATURE_LABELS: Record<IssueNature, string> = {
  SYSTEM: "Workflow or system gap",
  INDIVIDUAL: "Individual conduct",
  BOTH_UNSURE: "Both / unsure",
};

const PRIOR_OCCURRENCE_LABELS: Record<PriorOccurrence, string> = {
  YES: "Yes",
  NO: "No",
  UNSURE: "Unsure",
};

const CONCERN_LABELS: Record<string, string> = Object.fromEntries(
  CONCERN_TYPES.map((t) => [t.value, t.label])
);

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for that action.",
  "not-found": "The incident report could not be found.",
  validation: "Please check your input and try again.",
};

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function IncidentReportDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await requirePersonSession();

  let result: Awaited<ReturnType<typeof getReport>>;
  try {
    result = await getReport(actor.personId, id);
  } catch (err) {
    if (err instanceof IncidentNotFoundError || err instanceof IncidentForbiddenError) {
      notFound();
    }
    throw err;
  }
  const { report, canManage } = result;

  const errorCode = sp.error ?? null;
  // When error=validation the action encodes the raw message in ?message=.
  // All other unknown codes fall back to a generic string (never expose raw
  // encoded content that could confuse users or leak internals).
  const errorMessage = errorCode
    ? errorCode === "validation" && sp.message
      ? decodeURIComponent(sp.message)
      : (ERROR_MESSAGES[errorCode] ?? "An unexpected error occurred.")
    : null;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={`Report #${report.number}`}
        action={<Badge tone={STATUS_TONES[report.status]}>{STATUS_LABELS[report.status]}</Badge>}
      />

      {errorMessage && <Alert tone="error">{errorMessage}</Alert>}

      <Card>
        <SectionHeader>Concern</SectionHeader>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs text-subtle-foreground">Type of concern</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.concernTypes.length > 0
                ? report.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ")
                : "(none)"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-subtle-foreground">Description</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{report.description}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Date of the incident</dt>
            <dd className="mt-0.5 text-sm text-foreground">{fmtDate(report.occurredAt, "Unknown")}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Setting</dt>
            <dd className="mt-0.5 text-sm text-foreground">{report.setting ?? "(none)"}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <SectionHeader>Individual(s) of concern</SectionHeader>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs text-subtle-foreground">Linked people</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.subjects.length > 0 ? (
                <ul className="space-y-1">
                  {report.subjects.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <span>{s.person.name}</span>
                      {s.strikeDecision && (
                        <Badge tone={STRIKE_TONES[s.strikeDecision]}>{STRIKE_LABELS[s.strikeDecision]}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                "(none linked)"
              )}
            </dd>
          </div>
          {report.subjectDescription && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-subtle-foreground">As described</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{report.subjectDescription}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card>
        <SectionHeader>Impact and risk</SectionHeader>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle-foreground">Patient directly impacted</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.patientImpact ? PATIENT_IMPACT_LABELS[report.patientImpact] : "Not answered"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Ongoing risk right now</dt>
            <dd className="mt-0.5 text-sm text-foreground">{report.immediateRisk ? "Yes" : "No"}</dd>
          </div>
          {report.patientImpactDetail && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-subtle-foreground">Patient impact detail</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{report.patientImpactDetail}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-subtle-foreground">Nature of the issue</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.issueNature ? ISSUE_NATURE_LABELS[report.issueNature] : "Not answered"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Occurred before</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.priorOccurrence ? PRIOR_OCCURRENCE_LABELS[report.priorOccurrence] : "Not answered"}
            </dd>
          </div>
          {report.priorOccurrenceDetail && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-subtle-foreground">Prior occurrence detail</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{report.priorOccurrenceDetail}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card>
        <SectionHeader>Reporting details</SectionHeader>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle-foreground">Reported by</dt>
            <dd className="mt-0.5 text-sm text-foreground">{report.reporter.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Anonymity</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.anonymous ? "Reporter asked to remain anonymous to the subject." : "Not anonymous."}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Submitted</dt>
            <dd className="mt-0.5 text-sm text-foreground">{fmtDate(report.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Strike requests</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {(() => {
                const pending = report.subjects.filter((s) => s.strikeDecision === "PENDING").length;
                const issued = report.subjects.filter((s) => s.strikeDecision === "APPROVED").length;
                const declined = report.subjects.filter((s) => s.strikeDecision === "DECLINED").length;
                const parts = [
                  pending ? `${pending} pending` : "",
                  issued ? `${issued} issued` : "",
                  declined ? `${declined} declined` : "",
                ].filter(Boolean);
                return parts.length ? parts.join(", ") : "No strike requested";
              })()}
            </dd>
          </div>
        </dl>
      </Card>

      {report.attachments.length > 0 && (
        <Card>
          <SectionHeader>Attachments</SectionHeader>
          <ul className="mt-3 space-y-1.5">
            {report.attachments.map((attachment) => (
              <li key={attachment.id}>
                <a
                  href={`/api/incidents/attachments/${attachment.id}`}
                  className="text-sm text-brand-fg hover:underline"
                >
                  {attachment.fileName}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canManage && (
        <Card>
          <SectionHeader>Reviewer controls</SectionHeader>

          <form action={reviewReportAction} className="mt-3 space-y-3">
            <input type="hidden" name="reportId" value={report.id} />
            <Field label="Status">
              <Select name="status" defaultValue={report.status}>
                {(Object.keys(STATUS_LABELS) as IncidentReportStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reviewer notes" hint="Internal notes. Not visible to the reporter or subject.">
              <Textarea name="reviewNotes" rows={3} defaultValue={report.reviewNotes ?? ""} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" size="sm">
                Save status
              </Button>
            </FormActions>
          </form>

          {report.subjects.filter((s) => s.strikeDecision === "PENDING").length > 0 && (
            <div className="mt-6 space-y-6 border-t border-border-subtle pt-6">
              <SectionHeader level="title">Strike requests</SectionHeader>
              {report.subjects
                .filter((s) => s.strikeDecision === "PENDING")
                .map((s) => (
                  <div key={s.id} className="rounded-lg border border-border-subtle p-4">
                    <p className="text-sm text-foreground-soft">
                      Pending strike request against <span className="font-medium">{s.person.name}</span>.
                    </p>
                    <div className="mt-4 grid gap-6 sm:grid-cols-2">
                      <form action={decideStrikeAction} className="space-y-3">
                        <input type="hidden" name="reportId" value={report.id} />
                        <input type="hidden" name="reportSubjectId" value={s.id} />
                        <input type="hidden" name="approve" value="yes" />
                        <Field label="Strike category" required>
                          <Select name="category" required defaultValue="">
                            <option value="">Select category...</option>
                            {DISCIPLINARY_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Notes">
                          <Textarea name="notes" rows={2} placeholder="Optional notes on this decision..." />
                        </Field>
                        <FormActions>
                          <Button type="submit" variant="primary" size="sm">
                            Approve strike
                          </Button>
                        </FormActions>
                      </form>

                      <form action={decideStrikeAction} className="space-y-3">
                        <input type="hidden" name="reportId" value={report.id} />
                        <input type="hidden" name="reportSubjectId" value={s.id} />
                        <input type="hidden" name="approve" value="no" />
                        <Field label="Notes">
                          <Textarea name="notes" rows={2} placeholder="Optional reason for declining..." />
                        </Field>
                        <FormActions>
                          <Button type="submit" variant="outline" size="sm">
                            Decline strike
                          </Button>
                        </FormActions>
                      </form>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {report.subjects.filter((s) => s.strikeDecision === "APPROVED").length > 0 && (
            <p className="mt-4 text-sm text-foreground-soft">
              {report.subjects.filter((s) => s.strikeDecision === "APPROVED").length} strike(s) issued from this report.
              View them on the{" "}
              <Link href="/incidents/strikes" className="text-brand-fg hover:underline">
                strikes ledger
              </Link>
              .
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
