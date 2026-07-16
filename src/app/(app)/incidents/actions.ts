"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession, requirePermission } from "@/platform/auth/session";
import { captureEvent } from "@/platform/posthog/capture";
import { activeTermGroup } from "@/platform/posthog/groups";
import {
  submitReport,
  reviewReport,
  decideStrike,
  IncidentValidationError,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "@/modules/incidents/services/report";
import type { PatientImpact, IssueNature, PriorOccurrence, IncidentReportStatus } from "@prisma/client";

function optEnum<T extends string>(v: FormDataEntryValue | null, allowed: readonly string[]): T | null {
  const s = typeof v === "string" ? v : "";
  return (s && allowed.includes(s) ? (s as T) : null);
}

/**
 * Submits a "Report a concern" form. Any signed-in matched person may file a
 * report about anyone; a director filing about a volunteer they manage may
 * additionally request a strike (submitReport enforces that guard). Any
 * non-empty files selected in the "attachments" file input are read into
 * memory and passed through to submitReport, which validates and persists
 * them as IncidentReportAttachment rows.
 *
 * On success, redirects to /incidents/mine?submitted=<number>. On a typed
 * error, redirects back to /incidents with an ?error= code (and, for
 * validation errors, the raw message in ?message=).
 */
export async function submitReportAction(formData: FormData): Promise<void> {
  const actor = await requirePersonSession();

  const occurredAtStr = String(formData.get("occurredAt") ?? "");
  const occurredAt = occurredAtStr ? new Date(occurredAtStr) : null;

  const files = formData
    .getAll("attachments")
    .filter((f): f is File => f instanceof File && f.size > 0);
  const fileInputs = await Promise.all(
    files.map(async (f) => ({
      fileName: f.name,
      mimeType: f.type,
      bytes: Buffer.from(await f.arrayBuffer()),
    }))
  );

  const strikeIds = new Set(formData.getAll("strikePersonIds").map(String));
  const subjects = formData
    .getAll("subjectPersonIds")
    .map(String)
    .filter(Boolean)
    .map((personId) => ({ personId, requestStrike: strikeIds.has(personId) }));

  let number: number;
  try {
    const report = await submitReport(actor.personId, {
      concernTypes: formData.getAll("concernTypes").map(String),
      description: String(formData.get("description") ?? "").trim(),
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
      setting: (String(formData.get("setting") ?? "").trim() || null),
      subjects,
      subjectDescription: (String(formData.get("subjectDescription") ?? "").trim() || null),
      patientImpact: optEnum<PatientImpact>(formData.get("patientImpact"), ["YES", "NO", "UNSURE"]),
      patientImpactDetail: (String(formData.get("patientImpactDetail") ?? "").trim() || null),
      immediateRisk: formData.get("immediateRisk") === "yes",
      issueNature: optEnum<IssueNature>(formData.get("issueNature"), ["SYSTEM", "INDIVIDUAL", "BOTH_UNSURE"]),
      priorOccurrence: optEnum<PriorOccurrence>(formData.get("priorOccurrence"), ["YES", "NO", "UNSURE"]),
      priorOccurrenceDetail: (String(formData.get("priorOccurrenceDetail") ?? "").trim() || null),
      anonymous: formData.get("anonymous") === "on",
      files: fileInputs,
    });
    number = report.number;
  } catch (err) {
    if (err instanceof IncidentValidationError) {
      redirect(`/incidents?error=validation&message=${encodeURIComponent(err.message)}`);
    }
    if (err instanceof IncidentNotFoundError) redirect("/incidents?error=subject-not-found");
    if (err instanceof IncidentForbiddenError) redirect("/incidents?error=forbidden");
    throw err;
  }
  // Success redirect lives OUTSIDE the try: redirect() throws NEXT_REDIRECT, which
  // must not be caught by the error handler above. This mirrors the disciplinary page.
  await captureEvent({
    distinctId: actor.personId,
    event: "incident_report_submitted",
    properties: { report_number: number, subject_count: subjects.length, has_attachments: fileInputs.length > 0, anonymous: formData.get("anonymous") === "on" },
    groups: await activeTermGroup(),
  });
  revalidatePath("/incidents/mine");
  redirect(`/incidents/mine?submitted=${number}`);
}

/**
 * Reviewer control: sets a report's status and reviewer notes. Requires
 * incidents.manage. On a typed error, redirects back to the report detail
 * with an ?error= code (validation errors also carry the raw message in
 * ?message=); a missing report bounces to the review queue instead, since
 * there is no detail page left to return to.
 */
export async function reviewReportAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("incidents.manage");
  const id = String(formData.get("reportId"));
  // Validate the status against the enum allowlist (same optEnum guard
  // submitReportAction uses) so a malformed value is rejected cleanly instead
  // of being written or surfacing as a raw Prisma error.
  const status = optEnum<IncidentReportStatus>(formData.get("status"), [
    "SUBMITTED",
    "UNDER_REVIEW",
    "RESOLVED",
    "DISMISSED",
  ]);
  if (!status) {
    redirect(`/incidents/${id}?error=validation&message=${encodeURIComponent("Select a valid status.")}`);
  }
  try {
    await reviewReport(actor.personId, id, {
      status,
      reviewNotes: (String(formData.get("reviewNotes") ?? "").trim() || null),
    });
    await captureEvent({
      distinctId: actor.personId,
      event: "incident_reviewed",
      properties: { report_id: id, status },
      groups: await activeTermGroup(),
    });
  } catch (err) {
    if (err instanceof IncidentValidationError) redirect(`/incidents/${id}?error=validation&message=${encodeURIComponent(err.message)}`);
    if (err instanceof IncidentForbiddenError) redirect(`/incidents/${id}?error=forbidden`);
    if (err instanceof IncidentNotFoundError) redirect(`/incidents/review?error=not-found`);
    throw err;
  }
  revalidatePath(`/incidents/${id}`);
  revalidatePath("/incidents/review");
  redirect(`/incidents/${id}`);
}

/**
 * Reviewer control: approves or declines a report's pending strike request.
 * Requires incidents.manage. approve is read from formData as the string
 * "yes" (any other value, including "no" or absent, declines). Same
 * error-redirect shape as reviewReportAction.
 */
export async function decideStrikeAction(formData: FormData): Promise<void> {
  const actor = await requirePermission("incidents.manage");
  const reportId = String(formData.get("reportId"));
  const reportSubjectId = String(formData.get("reportSubjectId"));
  try {
    await decideStrike(actor.personId, reportSubjectId, {
      approve: formData.get("approve") === "yes",
      category: (String(formData.get("category") ?? "").trim() || undefined),
      occurredAt: null,
      notes: (String(formData.get("notes") ?? "").trim() || null),
    });
  } catch (err) {
    if (err instanceof IncidentValidationError) redirect(`/incidents/${reportId}?error=validation&message=${encodeURIComponent(err.message)}`);
    if (err instanceof IncidentForbiddenError) redirect(`/incidents/${reportId}?error=forbidden`);
    if (err instanceof IncidentNotFoundError) redirect(`/incidents/review?error=not-found`);
    throw err;
  }
  revalidatePath(`/incidents/${reportId}`);
  revalidatePath("/incidents/review");
  redirect(`/incidents/${reportId}`);
}
