"use client";
import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { uploadPackageAction, ingestUploadedPackageAction, type UploadState } from "../actions";

const MAX_UPLOAD_BYTES = 75 * 1024 * 1024; // 75 MB
const HINT =
  "Export from eXeLearning as SCORM 1.2, then upload the .zip. Uploading replaces any existing package.";
const RESET_LABEL =
  "Reset everyone's progress for this course. Learners who already completed it will need to retake the new content. Leave unchecked to keep their existing completion.";

type FormProps = { courseId: string; hasPackage: boolean };

/** Checkbox shown only when replacing a package: choose whether to clear progress. */
function ResetProgressField({ checked, onChange }: { checked?: boolean; onChange?: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm text-subtle-foreground">
      <input
        type="checkbox"
        name="resetProgress"
        className="mt-0.5"
        checked={onChange ? checked : undefined}
        defaultChecked={onChange ? undefined : false}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
      />
      <span>{RESET_LABEL}</span>
    </label>
  );
}

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
  const [resetProgress, setResetProgress] = useState(false);

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
      setPhase("Uploading… 0%");
      const result = await upload(`scorm-uploads/${courseId}/${file.name}`, file, {
        access: "private",
        contentType: "application/zip",
        handleUploadUrl: "/api/learning/blob-upload",
        onUploadProgress: (p) => setPhase(`Uploading… ${Math.round(p.percentage)}%`),
      });
      setPhase("Processing…");
      const res = await ingestUploadedPackageAction({ courseId, pathname: result.pathname, resetProgress });
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch (err) {
      console.error("[learning] SCORM upload failed:", err);
      setError(err instanceof Error ? err.message : "Upload failed. See the browser console for details.");
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  return (
    <Card pad={false} className="p-3">
      <form onSubmit={onSubmit} className="space-y-2">
        <input ref={fileRef} type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
        <p className="text-xs text-subtle-foreground">{HINT}</p>
        {hasPackage && <ResetProgressField checked={resetProgress} onChange={setResetProgress} />}
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy}>
          {busy ? phase || "Working…" : hasPackage ? "Replace package" : "Upload package"}
        </Button>
      </form>
    </Card>
  );
}

/** Local-dev path: plain Server Action form (no Vercel body-size limit locally). */
function ServerActionUploadForm({ courseId, hasPackage }: FormProps) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadPackageAction, null);

  return (
    <Card pad={false} className="p-3">
      <form action={action} encType="multipart/form-data" className="space-y-2">
        <input type="hidden" name="courseId" value={courseId} />
        <input type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
        <p className="text-xs text-subtle-foreground">{HINT}</p>
        {hasPackage && <ResetProgressField />}
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        <Button type="submit" disabled={pending}>
          {pending ? "Uploading…" : hasPackage ? "Replace package" : "Upload package"}
        </Button>
      </form>
    </Card>
  );
}
