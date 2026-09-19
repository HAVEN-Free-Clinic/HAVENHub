"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Field } from "@/platform/ui/input";
import { FormActions } from "@/platform/ui/form";
import { useToast } from "@/platform/ui/toast/toast";
import { MAX_CAPTIONS_BYTES, MAX_VIDEO_BYTES } from "@/modules/learning/engine/video-limits";
import { registerVideoAction, setCaptionsAction } from "./video-actions";

/**
 * PUT a file to an upload URL, reporting progress.
 *
 * XMLHttpRequest rather than fetch, for the same reason the SCORM upload uses
 * it: fetch exposes no upload-progress event, and a 2 GB recording needs a live
 * percentage or the form looks hung.
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
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}

/** Read a video file's duration in the browser, so sections can be timed
 *  against it without the server ever opening the file. Null if the browser
 *  cannot decode it. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

async function requestUploadUrl(
  courseId: string,
  kind: "video" | "captions",
  file: File
): Promise<{ url: string; key: string; contentType: string }> {
  const res = await fetch("/api/learning/video-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId, kind, filename: file.name, contentType: file.type, size: file.size }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not start the upload. Please try again.");
  }
  return (await res.json()) as { url: string; key: string; contentType: string };
}

/** Upload a course video: browser to storage, then register it with the server. */
export function VideoUploadForm({ courseId }: { courseId: string }) {
  const router = useRouter();
  // The sanctioned direct-useToast carve-out (see toast/flash.ts): this path
  // never touches the URL, so there is no flash param for the classifier.
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file || file.size === 0) {
      setError("Choose an MP4 video to upload.");
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setError("That video is too large (max 5 GB).");
      return;
    }
    setBusy(true);
    try {
      setPhase("Reading…");
      const durationSeconds = await readDuration(file);
      setPhase("Preparing…");
      const signed = await requestUploadUrl(courseId, "video", file);
      setPhase("Uploading… 0%");
      await putWithProgress(signed.url, file, signed.contentType, (p) => setPhase(`Uploading… ${Math.round(p)}%`));
      setPhase("Saving…");
      const res = await registerVideoAction({
        courseId,
        key: signed.key,
        fileName: file.name,
        contentType: signed.contentType,
        durationSeconds,
      });
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
      toast({ tone: "success", message: "Video uploaded." });
    } catch (err) {
      console.error("[learning] video upload failed:", err);
      setError(err instanceof Error ? err.message : "Upload failed. Please try again, or contact support.");
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        label="Video file (MP4)"
        hint="From Zoom, use the screen-share recording. One file can hold several sections: you set each section's start and end time below."
      >
        {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
        <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/quicktime" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <FormActions>
        <Button type="submit" disabled={busy}>
          {busy ? phase || "Working…" : "Upload video"}
        </Button>
      </FormActions>
    </form>
  );
}

/** Attach a WebVTT captions file (Zoom's transcript) to one video. */
export function CaptionsUploadForm({ courseId, videoId }: { courseId: string; videoId: string }) {
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file || file.size === 0) {
      setError("Choose a .vtt captions file.");
      return;
    }
    if (file.size > MAX_CAPTIONS_BYTES) {
      setError("That captions file is too large (max 5 MB).");
      return;
    }
    setBusy(true);
    try {
      const signed = await requestUploadUrl(courseId, "captions", file);
      await putWithProgress(signed.url, file, signed.contentType, () => undefined);
      const res = await setCaptionsAction({ videoId, key: signed.key, fileName: file.name });
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
      toast({ tone: "success", message: "Captions saved." });
    } catch (err) {
      console.error("[learning] captions upload failed:", err);
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3">
      <Field label="Captions (.vtt)" hint="Zoom's transcript file. Optional, and it can be replaced later.">
        {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
        <input ref={fileRef} type="file" accept=".vtt,text/vtt" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <FormActions>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? "Uploading…" : "Upload captions"}
        </Button>
      </FormActions>
    </form>
  );
}
