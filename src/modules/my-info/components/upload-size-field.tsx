"use client";

import { useState } from "react";

/**
 * File input for /my-info with a browser-side size guard.
 *
 * Both /my-info uploads (the photo and the HIPAA certificate) post to a Server
 * Action, which the platform hard-limits to ~4.5 MB. A file over that cap dies
 * at the platform edge before any app code runs, so the action never redirects
 * with ?photoError=/?certError= and the form goes silent -- the member gets no
 * feedback and retries. This mirrors the uploads.maxMb cap in the browser via
 * setCustomValidity, exactly as IncidentAttachmentsField does, so an oversized
 * file never round-trips (#75).
 */
export function UploadSizeField({
  name,
  accept,
  required,
  maxMb,
}: {
  name: string;
  accept: string;
  required?: boolean;
  maxMb: number;
}) {
  const [error, setError] = useState<string | null>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const cap = maxMb * 1024 * 1024;
    const tooBig = Array.from(input.files ?? []).find((f) => f.size > cap);
    const message = tooBig ? `"${tooBig.name}" is too large (max ${maxMb} MB).` : "";
    setError(message || null);
    // Native constraint validation blocks the submit while this is non-empty,
    // so the oversized file cannot round-trip and fail opaquely at the edge.
    input.setCustomValidity(message);
  }

  return (
    <>
      {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
      <input type="file" name={name} accept={accept} required={required} onChange={onChange} aria-invalid={error ? true : undefined} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
      {error && (
        <p className="mt-1 text-xs text-critical" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
