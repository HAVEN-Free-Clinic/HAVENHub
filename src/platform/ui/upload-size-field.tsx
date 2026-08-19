"use client";

import { useState } from "react";

/**
 * File input that refuses an oversized file in the BROWSER, before the request
 * is sent.
 *
 * Every upload path in this app posts to a Server Action, which the hosting
 * platform hard-limits to ~4.5 MB. Over that, the edge answers the POST itself
 * with a non-RSC response and Next's `fetchServerAction` throws "An unexpected
 * response was received from the server." -- so the form appears to do nothing.
 * No redirect, no flash message, no server-side capture, because no app code
 * ever ran. `settings/registry.ts` documents this on `uploads.maxMb` and caps it
 * at 4 for the same reason, but that only stops the SETTING from over-promising;
 * nothing stopped the browser from posting the file anyway. A member on /my-info
 * retried three times in 75 seconds against exactly that silence.
 *
 * Mirroring the one server rule in the browser via `setCustomValidity` is the
 * same trick `IncidentAttachmentsField` used for the incident report: native
 * constraint validation blocks the submit while the message is non-empty, so the
 * oversized file never round-trips and the applicant gets a real reason.
 *
 * Lives in platform/ui because it IS the file-input primitive: the raw
 * `<input type="file">` this replaces needed a `no-restricted-syntax`
 * disable at every call site.
 */
/**
 * The validity message for a selection, or "" when every file fits.
 *
 * Split out from the component because the rule is the part worth pinning and
 * the component itself is only testable as static markup here (no DOM in the
 * suite). "" is not merely falsy: it is what `setCustomValidity` wants for
 * "valid", so the caller passes this straight through either way.
 *
 * Compares against MB as the setting means them (1024-based), matching the
 * server-side check, so a file is never rejected in the browser and accepted by
 * the server or the reverse.
 */
export function oversizeMessage(files: readonly { name: string; size: number }[], maxMb: number): string {
  const cap = maxMb * 1024 * 1024;
  const tooBig = files.find((f) => f.size > cap);
  return tooBig ? `"${tooBig.name}" is too large (max ${maxMb} MB).` : "";
}

export function UploadSizeField({
  name,
  maxMb,
  accept,
  required = false,
  multiple = false,
}: {
  name: string;
  /** Cap in megabytes, from the `uploads.maxMb` setting. */
  maxMb: number;
  accept?: string;
  required?: boolean;
  multiple?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const message = oversizeMessage(Array.from(input.files ?? []), maxMb);
    setError(message || null);
    // Non-empty custom validity blocks the native submit, which is what keeps the
    // file from reaching the edge and failing opaquely.
    input.setCustomValidity(message);
  }

  return (
    <>
      <input
        type="file"
        name={name}
        accept={accept}
        required={required}
        multiple={multiple}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong"
      />
      {error && (
        <p className="mt-1 text-xs text-critical" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
