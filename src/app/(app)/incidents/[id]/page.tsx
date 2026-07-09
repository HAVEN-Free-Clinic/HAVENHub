/**
 * Incident report detail page (owner view).
 *
 * Access: requirePersonSession() then getReport(personId, id), which allows
 * the reporter (owner) or a holder of incidents.manage and throws
 * IncidentForbiddenError/IncidentNotFoundError otherwise -- both caught here
 * and rendered as a 404 via notFound() so an unauthorized viewer cannot tell
 * a report exists from a missing one.
 *
 * This page is READ-ONLY for both audiences. reviewNotes is never rendered
 * here even for a manager (the service already nulls it for non-managers,
 * and reviewer controls/notes are Task 15's job, added to /incidents/review).
 * Attachments link to the Task 16 download route, which does not exist yet;
 * the anchor is rendered ahead of that route landing.
 */

import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  getReport,
  CONCERN_TYPES,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "@/modules/incidents/services/report";
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

  let result: Awaited<ReturnType<typeof getReport>>;
  try {
    result = await getReport(actor.personId, id);
  } catch (err) {
    if (err instanceof IncidentNotFoundError || err instanceof IncidentForbiddenError) {
      notFound();
    }
    throw err;
  }
  const { report } = result;

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
            <dt className="text-xs text-subtle-foreground">Subject</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.subject?.name ?? report.subjectDescription ?? "(described in report)"}
            </dd>
          </div>
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
            <dt className="text-xs text-subtle-foreground">Strike request</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {report.strikeDecision ? STRIKE_LABELS[report.strikeDecision] : "No strike requested"}
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
    </div>
  );
}
