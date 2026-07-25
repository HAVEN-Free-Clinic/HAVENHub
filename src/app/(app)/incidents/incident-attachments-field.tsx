"use client";

import { useState } from "react";

/**
 * Attachments input for the incident report with a browser-side size guard.
 *
 * submitReport validates every file against the uploads.maxMb cap server-side and
 * throws IncidentValidationError, whose redirect re-renders the completely
 * uncontrolled 10-section form with no defaultValues -- so an oversized photo (phone
 * photos are routinely 3-8 MB) silently discarded every answer and every linked
 * subject. This mirrors that one server rule in the browser -- exactly as
 * ConcernTypesFieldset does for the empty-selection rule -- via setCustomValidity, so
 * the file never round-trips and the report is never lost (#17).
 */
export function IncidentAttachmentsField({ maxMb }: { maxMb: number }) {
  const [error, setError] = useState<string | null>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const cap = maxMb * 1024 * 1024;
    const tooBig = Array.from(input.files ?? []).find((f) => f.size > cap);
    const message = tooBig ? `"${tooBig.name}" is too large (max ${maxMb} MB).` : "";
    setError(message || null);
    // Native constraint validation blocks the form submit while this is non-empty,
    // so the oversized file cannot round-trip and trigger the report-discarding
    // validation redirect.
    input.setCustomValidity(message);
  }

  return (
    <>
      {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
      <input type="file" name="attachments" multiple onChange={onChange} aria-invalid={error ? true : undefined} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
      {error && (
        <p className="mt-1 text-xs text-critical" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
