"use client";
import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field } from "@/platform/ui/input";
import { FormActions } from "@/platform/ui/form";
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
      <Checkbox
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
 * PUT a file to a presigned R2 URL, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch exposes no upload-progress event, and
 * a 75 MB SCORM package needs a live percentage or the form looks hung.
 */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // Must match the content type the URL was signed with, or R2 rejects the
    // upload with SignatureDoesNotMatch.
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}

/**
 * SCORM package upload. On Vercel (R2 configured) the browser uploads the .zip
 * DIRECTLY to R2 via a presigned URL and then asks the server to ingest it --
 * this bypasses the 4.5 MB Vercel function request-body limit that a plain
 * Server Action upload hits (FUNCTION_PAYLOAD_TOO_LARGE). In local dev (no R2)
 * it falls back to a normal Server Action form, which has no such limit.
 */
export function UploadPackageForm({
  courseId,
  hasPackage,
  usingRemoteStorage,
}: FormProps & { usingRemoteStorage: boolean }) {
  return usingRemoteStorage ? (
    <DirectUploadForm courseId={courseId} hasPackage={hasPackage} />
  ) : (
    <ServerActionUploadForm courseId={courseId} hasPackage={hasPackage} />
  );
}

/** Direct-to-R2 path (Vercel). */
function DirectUploadForm({ courseId, hasPackage }: FormProps) {
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
      const contentType = "application/zip";
      setPhase("Preparing…");
      const signed = await fetch("/api/learning/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          filename: file.name,
          contentType,
          size: file.size,
        }),
      });
      if (!signed.ok) {
        const body = (await signed.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not start the upload. Please try again.");
        return;
      }
      const { url, key } = (await signed.json()) as { url: string; key: string };
      setPhase("Uploading… 0%");
      await putWithProgress(url, file, contentType, (percent) =>
        setPhase(`Uploading… ${Math.round(percent)}%`)
      );
      setPhase("Processing…");
      const res = await ingestUploadedPackageAction({ courseId, key, resetProgress });
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    } catch (err) {
      console.error("[learning] SCORM upload failed:", err);
      setError(err instanceof Error ? err.message : "Upload failed. Please check the file and try again, or contact support.");
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  return (
    <Card pad={false} className="space-y-4 p-4">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="SCORM package (.zip)" hint={HINT}>
          {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
          <input ref={fileRef} type="file" name="package" accept=".zip,application/zip" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
        </Field>
        {hasPackage && <ResetProgressField checked={resetProgress} onChange={setResetProgress} />}
        {error && <Alert tone="error">{error}</Alert>}
        <FormActions>
          <Button type="submit" disabled={busy}>
            {busy ? phase || "Working…" : hasPackage ? "Replace package" : "Upload package"}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

/** Local-dev path: plain Server Action form (no Vercel body-size limit locally). */
function ServerActionUploadForm({ courseId, hasPackage }: FormProps) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadPackageAction, null);

  return (
    <Card pad={false} className="space-y-4 p-4">
      <form action={action} encType="multipart/form-data" className="space-y-4">
        <input type="hidden" name="courseId" value={courseId} />
        <Field label="SCORM package (.zip)" hint={HINT}>
          {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
          <input type="file" name="package" accept=".zip,application/zip" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
        </Field>
        {hasPackage && <ResetProgressField />}
        {state?.error && <Alert tone="error">{state.error}</Alert>}
        <FormActions>
          <Button type="submit" disabled={pending}>
            {pending ? "Uploading…" : hasPackage ? "Replace package" : "Upload package"}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}
