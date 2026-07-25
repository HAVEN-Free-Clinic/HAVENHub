/**
 * Browser-side Epic generation: POST the batch, download the PDF (and the
 * spreadsheet for bulk requests), and hand back the cover-email draft.
 *
 * Shared by the Generate tab and the Term batch tab so the two cannot drift on
 * request shape, date formatting, or subject lines. Browser-only (uses atob,
 * Blob, and document), so only "use client" modules may import it.
 */

import type { EpicRequestType } from "@/modules/support/epic-request-types";

export const EMAIL_SUBJECTS: Record<EpicRequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `[HAVEN] New Epic Account Request ${i} ${d}`,
  mod_individual: (i, d) => `[HAVEN] Modify Epic Access for One User ${d} ${i}`,
  renew_individual: (i, d) => `[HAVEN] Renew Epic Access for One User ${d} ${i}`,
  bulk_new: (i, d) => `[HAVEN] Multiple New Epic Account Request ${d} ${i}`,
  bulk_mod: (i, d) => `[HAVEN] Modify Epic Access for Multiple Users ${d} ${i}`,
  bulk_renew: (i, d) => `[HAVEN] Renew Epic Access for Multiple Users ${d} ${i}`,
  deactivate_individual: (i, d) => `[HAVEN] Deactivate Epic Access for One User ${d} ${i}`,
  bulk_deactivate: (i, d) => `[HAVEN] Deactivate Epic Access for Multiple Users ${d} ${i}`,
};

export type EpicGenerationResult = {
  subject: string;
  body: string;
  /** Set when the artifacts were produced but tracking was skipped. */
  trackingWarning: string | null;
};

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function runEpicGeneration(input: {
  requestType: EpicRequestType;
  authorizer: { id: string; initials: string };
  personIds: string[];
  /** ISO YYYY-MM-DD, straight off a date input. */
  endDate: string;
  /** Target term; omit to use the active term. */
  termId?: string;
}): Promise<EpicGenerationResult> {
  // The server and PDF expect MM/DD/YYYY. Convert by slicing rather than via Date
  // so the calendar day the admin picked survives regardless of timezone.
  const endDateFormatted = `${input.endDate.slice(5, 7)}/${input.endDate.slice(8, 10)}/${input.endDate.slice(0, 4)}`;

  const res = await fetch("/api/support/epic/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestType: input.requestType,
      authorizerId: input.authorizer.id,
      personIds: input.personIds,
      endDate: endDateFormatted,
      termId: input.termId,
    }),
  });

  if (!res.ok) {
    const { error: msg } = await res.json();
    throw new Error(msg ?? "Generation failed");
  }

  const data = await res.json();

  triggerDownload(base64ToBlob(data.pdfBase64, "application/pdf"), data.pdfFilename);
  if (data.xlsxBase64) {
    triggerDownload(
      base64ToBlob(
        data.xlsxBase64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
      data.xlsxFilename
    );
  }

  // The subject uses the server's ET-formatted date, so it agrees with the PDF
  // filename instead of the browser's local clock (which can be a day ahead late
  // in the evening Eastern).
  return {
    subject: EMAIL_SUBJECTS[input.requestType](input.authorizer.initials, data.date),
    body: data.emailBody,
    trackingWarning: data.trackingWarning ?? null,
  };
}
