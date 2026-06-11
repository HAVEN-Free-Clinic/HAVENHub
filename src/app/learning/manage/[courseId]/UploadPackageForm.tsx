"use client";
import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { uploadPackageAction, ingestUploadedPackageAction, type UploadState } from "../actions";

const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB
const HINT =
  "Export from eXeLearning as SCORM 1.2, then upload the .zip. Uploading replaces any existing package.";

type FormProps = { courseId: string; hasPackage: boolean };

/**
 * SCORM package upload. On Vercel (Blob configured) the browser uploads the .zip
 * DIRECTLY to Blob storage and then asks the server to ingest it -- this bypasses
 * the 4.5 MB Vercel function request-body limit that a plain Server Action upload
 * hits (FUNCTION_PAYLOAD_TOO_LARGE). In local dev (no Blob) it falls back to a
 * normal Server Action form, which has no such limit.
 */
export function UploadPackageForm({ courseId, hasPackage, usingBlob }: FormProps & { usingBlob: boolean }) {
  return usingBlob ? (
    <BlobUploadForm courseId={courseId} hasPackage={hasPackage} />
  ) : (
    <ServerActionUploadForm courseId={courseId} hasPackage={hasPackage} />
  );
}

/** Direct-to-Blob path (Vercel). */
function BlobUploadForm({ courseId, hasPackage }: FormProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file || file.size === 0) {
      setError("Choose a .zip SCORM package to upload.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That package is too large (max 75 MB).");
      return;
    }
    setBusy(true);
    try {
      setPhase("Uploading…");
      const result = await upload(`scorm-uploads/${courseId}/${file.name}`, file, {
        access: "public",
        contentType: "application/zip",
        multipart: true,
        handleUploadUrl: "/api/learning/blob-upload",
      });
      setPhase("Processing…");
      const res = await ingestUploadedPackageAction({ courseId, url: result.url });
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded border border-slate-200 p-3">
      <input ref={fileRef} type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
      <p className="text-xs text-slate-400">{HINT}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-50">
        {busy ? phase || "Working…" : hasPackage ? "Replace package" : "Upload package"}
      </button>
    </form>
  );
}

/** Local-dev path: plain Server Action form (no Vercel body-size limit locally). */
function ServerActionUploadForm({ courseId, hasPackage }: FormProps) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadPackageAction, null);

  return (
    <form action={action} encType="multipart/form-data" className="space-y-2 rounded border border-slate-200 p-3">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
      <p className="text-xs text-slate-400">{HINT}</p>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button type="submit" disabled={pending} className="rounded bg-slate-800 px-3 py-1.5 text-white disabled:opacity-50">
        {pending ? "Uploading…" : hasPackage ? "Replace package" : "Upload package"}
      </button>
    </form>
  );
}
