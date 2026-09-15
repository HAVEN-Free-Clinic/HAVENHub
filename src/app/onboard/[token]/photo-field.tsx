"use client";

import { useEffect, useState } from "react";
import { Field } from "@/platform/ui/input";
import { UploadSizeField } from "@/platform/ui/upload-size-field";
import { isHeic } from "@/platform/photos/shared";
import { downscalePhoto } from "./photo-downscale";

/** The types submitContract accepts (ACCEPTED_UPLOAD_TYPES in
 *  platform/photos/service.ts, repeated here because that module reaches Prisma
 *  and sharp), plus HEIC, which downscalePhoto converts to JPEG in the browser. */
const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";

/** A HEIC file is still HEIC after downscalePhoto only when this browser could not
 *  convert it, and the server cannot read HEIC, so stop the submit with a reason. */
function heicMessage(files: File[]): string {
  return files.some(isHeic)
    ? "This browser can't convert HEIC photos. Choose a JPEG or PNG instead, or open this form on your iPhone."
    : "";
}

/**
 * The profile photo on the onboarding contract.
 *
 * It becomes the person's HAVEN Hub profile photo at roster build, so the copy
 * asks for what that photo is for: a clear picture of their face. Required unless
 * they already have a photo on file, which is shown so they can judge whether to
 * replace it. The preview is cropped the way the server will crop it (a centred
 * square), so a photo that would lose the face is visible before they submit.
 */
export function ProfilePhotoField({
  label,
  error,
  maxUploadMb,
  currentPhoto = null,
  required: requiredIfMissing = true,
}: {
  label: string;
  error?: string;
  maxUploadMb: number;
  /** Their stored profile photo as a data URI, when they have one. */
  currentPhoto?: string | null;
  /** Whether the layout requires a photo. Even then, one on file is enough. */
  required?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const required = requiredIfMissing && !currentPhoto;
  const shown = preview ?? currentPhoto;
  // Release each object URL once it is replaced or the field unmounts.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-critical-foreground" aria-hidden="true"> *</span>}
      </p>
      {currentPhoto ? (
        <p className="text-sm text-foreground-soft">
          This is your current HAVEN Hub profile photo. If it is not a clear, recent photo of your face, upload a
          new one to replace it.
        </p>
      ) : (
        <p className="text-sm text-foreground-soft">
          Upload a clear, recent photo of your face. It becomes your HAVEN Hub profile photo so your directors and
          the clinic team can recognize you.
        </p>
      )}
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-soft">
        <li>Look at the camera, with your whole face visible and filling most of the frame.</li>
        <li>Use good lighting, and make sure the photo is in focus.</li>
        <li>Just you: no group photos, sunglasses, hats, filters, or avatars.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-4">
        {shown && (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob preview or an inline data URI, not a remote asset
          <img
            src={shown}
            alt={preview ? "Your chosen photo, cropped the way it will appear" : "Your current profile photo"}
            className="h-24 w-24 shrink-0 rounded-full border border-border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <Field
            label={currentPhoto ? "Upload a new photo (optional)" : "Photo of your face"}
            required={required}
            hint="PNG, JPEG, WebP, or an iPhone photo (HEIC). It is cropped to a square around the center."
            error={error}
          >
            <UploadSizeField
              name="photo"
              accept={PHOTO_ACCEPT}
              required={required}
              maxMb={maxUploadMb}
              prepare={downscalePhoto}
              validate={heicMessage}
              onFilesChange={(files) => setPreview(files[0] ? URL.createObjectURL(files[0]) : null)}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
