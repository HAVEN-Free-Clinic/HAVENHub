"use client";
import { useActionState } from "react";
import { uploadPackageAction, type UploadState } from "../actions";

/**
 * SCORM package upload form. Uses useActionState so validation messages from the
 * server action (bad zip, no manifest, too large) render inline -- thrown Server
 * Action errors are redacted in production, so the action returns them instead.
 */
export function UploadPackageForm({ courseId, hasPackage }: { courseId: string; hasPackage: boolean }) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadPackageAction, null);

  return (
    <form action={action} encType="multipart/form-data" className="space-y-2 rounded border border-slate-200 p-3">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
      <p className="text-xs text-slate-400">
        Export from eXeLearning as SCORM 1.2, then upload the .zip. Uploading replaces any existing package.
      </p>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-50"
      >
        {pending ? "Uploading…" : hasPackage ? "Replace package" : "Upload package"}
      </button>
    </form>
  );
}
