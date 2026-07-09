"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import {
  submitReport,
  IncidentValidationError,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "@/modules/incidents/services/report";
import type { PatientImpact, IssueNature, PriorOccurrence } from "@prisma/client";

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
