"use client";

import { useEffect, useState } from "react";
import { Field } from "@/platform/ui/input";
import { UploadSizeField } from "@/platform/ui/upload-size-field";
import { downscalePhoto } from "./photo-downscale";

/** The types submitContract accepts (ACCEPTED_UPLOAD_TYPES in
 *  platform/photos/service.ts), repeated here because that module reaches
 *  Prisma and sharp and must never be bundled for the browser. */
const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * The required profile photo on the onboarding contract.
 *
 * It becomes the person's HAVEN Hub profile photo at roster build, so the copy
 * asks for what that photo is for: a clear picture of their face. The preview is
 * cropped the way the server will crop it (a centred square), so a photo that
 * would lose the face is visible before they submit.
 */
export function ProfilePhotoField({
  label,
  error,
  maxUploadMb,
}: {
  label: string;
  error?: string;
  maxUploadMb: number;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  // Release each object URL once it is replaced or the field unmounts.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">
        {label}
        <span className="text-critical-foreground" aria-hidden="true"> *</span>
      </p>
      <p className="text-sm text-foreground-soft">
        Upload a clear, recent photo of your face. It becomes your HAVEN Hub profile photo so your directors and
        the clinic team can recognize you. If you already have a photo in HAVEN Hub, this one replaces it.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-soft">
        <li>Look at the camera, with your whole face visible and filling most of the frame.</li>
        <li>Use good lighting, and make sure the photo is in focus.</li>
        <li>Just you: no group photos, sunglasses, hats, filters, or avatars.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-4">
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob preview of the chosen file, not a remote asset
          <img
            src={preview}
            alt="Your chosen photo, cropped the way it will appear"
            className="h-24 w-24 shrink-0 rounded-full border border-border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <Field
            label="Photo of your face"
            required
            hint="PNG, JPEG, or WebP. It is cropped to a square around the center."
            error={error}
          >
            <UploadSizeField
              name="photo"
              accept={PHOTO_ACCEPT}
              required
              maxMb={maxUploadMb}
              prepare={downscalePhoto}
              onFilesChange={(files) => setPreview(files[0] ? URL.createObjectURL(files[0]) : null)}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
