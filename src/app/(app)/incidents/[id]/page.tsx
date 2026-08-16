/**
 * Incident report detail page (owner + reviewer view).
 *
 * Access: requirePersonSession() then getReport(personId, id), which allows
 * the reporter (owner) or a holder of incidents.manage and throws
 * IncidentForbiddenError/IncidentNotFoundError otherwise -- both caught here
 * and rendered as a 404 via notFound() so an unauthorized viewer cannot tell
 * a report exists from a missing one.
 *
 * The core fields are READ-ONLY for both audiences. The "Individual(s) of
 * concern" section lists each linked person (report.subjects) with a
 * per-person strike badge, plus the free-text subjectDescription. When
 * canManage (the service already strips reviewNotes to null for
 * non-managers, even the owner), a "Reviewer controls" section renders: a
 * status/reviewNotes form bound to reviewReportAction, and one Approve/
 * Decline form pair per subject whose strike request is still PENDING, each
 * bound to decideStrikeAction with that subject's reportSubjectId.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { loadClearedSet } from "@/platform/clearance";
import {
  getReport,
  CONCERN_TYPES,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "@/modules/incidents/services/report";
import { DISCIPLINARY_CATEGORIES } from "@/modules/incidents/services/disciplinary";
import { listReportForwards, recentForwardEmails } from "@/modules/incidents/services/forward";
import { reviewReportAction, decideStrikeAction, forwardReportAction } from "../actions";
import { detailReviewerDisclosure } from "../disclosure";
import { ForwardForm } from "../forward-form";
import type {
  IncidentReportStatus,
  PatientImpact,
  IssueNature,
  PriorOccurrence,
  StrikeDecision,
} from "@prisma/client";
import { PageHeader } from "@/platform/ui/page-header";
import { PersonName } from "@/platform/ui/person-name";
import { Badge } from "@/platform/ui/badge";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { FormActions } from "@/platform/ui/form";
import { CalendarDate, DateOnly } from "@/platform/dates/display";

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
// Page props
// ---------------------------------------------------------------------------

type PageProps = {
  params: Promise<{ id: string }>;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function IncidentReportDetailPage({ params }: PageProps) {
  const { id } = await params;
  const actor = await requirePersonSession();

  // getReport and the reviewer count are independent reads (the count doesn't
  // depend on the report, and getReport's own permission check doesn't depend
  // on it either), so they run in parallel. Both settle inside the same try:
  // an unrelated failure from either one still falls through to the same
  // rethrow below, and getReport's own NotFound/Forbidden still resolve to
  // notFound() exactly as before.
  let result: Awaited<ReturnType<typeof getReport>>;
  try {
    // incidentAudience() used to run alongside this purely to produce the
    // headcount the disclosure quoted. The disclosure quotes no number now, so
    // the permission-holder query is gone from every render of this page.
    result = await getReport(actor.personId, id);
  } catch (err) {
    if (err instanceof IncidentNotFoundError || err instanceof IncidentForbiddenError) {
      notFound();
    }
    throw err;
  }
  const { report, canManage } = result;

  // Forwarding is a reviewer-only surface, so neither read runs for the
  // reporter viewing their own report: they cannot forward, and the trail of who
  // received it outside the clinic is not theirs to see.
  const [suggestions, forwards] = canManage
    ? await Promise.all([recentForwardEmails(), listReportForwards(report.id)])
    : [[] as string[], [] as Awaited<ReturnType<typeof listReportForwards>>];

  // Verified badges on the linked subjects. Gated on volunteers.view, so the
  // reporter viewing their own report never sees the clearance of the person
  // they reported -- that would hand a reporter a compliance detail about their
  // subject as a side effect of filing.
  const canSeeClearance = await can(actor.personId, "volunteers.view");
  const clearedIds = await loadClearedSet(
    canSeeClearance ? report.subjects.map((s) => s.person.id) : []
  );

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={`Report #${report.number}`}
        action={<Badge tone={STATUS_TONES[report.status]}>{STATUS_LABELS[report.status]}</Badge>}
      />

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
            <dd className="mt-0.5 text-sm text-foreground">
              <CalendarDate value={report.occurredAt} fallback="Unknown" />
            </dd>
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
                      <PersonName name={s.person.name} cleared={clearedIds.has(s.person.id)} />
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
              {/* The reporter's own words on why. Only ever set alongside an
                  anonymity request (submitReport clears it otherwise), and this
                  page is reachable only by the reporter and by reviewers who are
                  not linked as subjects, so it never reaches the person the
                  report is about. */}
              {report.anonymous && report.anonymousReason && (
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-soft">
                  &ldquo;{report.anonymousReason}&rdquo;
                </p>
              )}
              <p className="mt-1 text-xs text-subtle-foreground">{detailReviewerDisclosure()}</p>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle-foreground">Submitted</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              <DateOnly value={report.createdAt} />
            </dd>
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
              <SectionHeader level="title" as="h3">Strike requests</SectionHeader>
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
                          <ConfirmButton label="Approve strike" confirmLabel="Confirm strike?" size="sm" />
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
                          <SubmitButton variant="outline" size="sm" pendingLabel="Declining…">
                            Decline strike
                          </SubmitButton>
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

      {/* Forwarding sits in its own card, deliberately apart from the reviewer
          controls above. Those change the report's state inside the clinic and
          are reversible; this sends it OUTSIDE the organization and is not. The
          trail of past forwards renders directly above the form so a reviewer
          sees who already received it before choosing to send it again. */}
      {canManage && (
        <Card>
          <SectionHeader>Forward outside the clinic</SectionHeader>
          {forwards.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-foreground-soft">
              {forwards.map((f) => (
                <li key={f.id}>
                  Sent to <span className="text-foreground">{f.toEmail}</span> by{" "}
                  {f.forwardedBy.name} on <DateOnly value={f.createdAt} />
                  {f.note && <span className="block text-xs">&ldquo;{f.note}&rdquo;</span>}
                </li>
              ))}
            </ul>
          )}
          <ForwardForm
            action={forwardReportAction}
            targetIdName="reportId"
            targetId={report.id}
            suggestions={suggestions}
          />
        </Card>
      )}
    </div>
  );
}
