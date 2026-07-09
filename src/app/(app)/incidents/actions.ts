"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession, requirePermission } from "@/platform/auth/session";
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
 * additionally request a strike (submitReport enforces that guard).
 *
 * On success, redirects to /incidents/mine?submitted=<number>. On a typed
 * error, redirects back to /incidents with an ?error= code (and, for
 * validation errors, the raw message in ?message=).
 */
export async function submitReportAction(formData: FormData): Promise<void> {
  const actor = await requirePersonSession();

  const occurredAtStr = String(formData.get("occurredAt") ?? "");
  const occurredAt = occurredAtStr ? new Date(occurredAtStr) : null;

  let number: number;
  try {
    const report = await submitReport(actor.personId, {
      concernTypes: formData.getAll("concernTypes").map(String),
      description: String(formData.get("description") ?? "").trim(),
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
      setting: (String(formData.get("setting") ?? "").trim() || null),
      subjectPersonId: (String(formData.get("subjectPersonId") ?? "").trim() || null),
      subjectDescription: (String(formData.get("subjectDescription") ?? "").trim() || null),
      patientImpact: optEnum<PatientImpact>(formData.get("patientImpact"), ["YES", "NO", "UNSURE"]),
      patientImpactDetail: (String(formData.get("patientImpactDetail") ?? "").trim() || null),
      immediateRisk: formData.get("immediateRisk") === "yes",
      issueNature: optEnum<IssueNature>(formData.get("issueNature"), ["SYSTEM", "INDIVIDUAL", "BOTH_UNSURE"]),
      priorOccurrence: optEnum<PriorOccurrence>(formData.get("priorOccurrence"), ["YES", "NO", "UNSURE"]),
      priorOccurrenceDetail: (String(formData.get("priorOccurrenceDetail") ?? "").trim() || null),
      anonymous: formData.get("anonymous") === "on",
      requestStrike: formData.get("requestStrike") === "on",
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
  try {
    await reviewReport(actor.personId, id, {
      status: String(formData.get("status") ?? "UNDER_REVIEW") as IncidentReportStatus,
      reviewNotes: (String(formData.get("reviewNotes") ?? "").trim() || null),
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
  const id = String(formData.get("reportId"));
  try {
    await decideStrike(actor.personId, id, {
      approve: formData.get("approve") === "yes",
      category: (String(formData.get("category") ?? "").trim() || undefined),
      occurredAt: null,
      notes: (String(formData.get("notes") ?? "").trim() || null),
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
