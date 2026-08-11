/**
 * PhotoCard: the member's own photo, with upload and remove.
 *
 * Yale College photos are auto-sourced from Yalies without asking first, so the
 * remove control here is the opt-out that makes that real. It is rendered
 * unconditionally whenever the person has a photo on file (self-uploaded or
 * Yalies-sourced), as a plain always-visible button next to the upload form --
 * never behind a menu, a hover state, or a disclosure the member has to open
 * first (contrast HipaaPanel's "Replace this certificate" `<details>`, which is
 * deliberately NOT the pattern here).
 *
 * The server action receives the formData, reads the File, converts to Buffer,
 * and calls setPhotoFromUpload. PhotoError is redirected back with
 * ?photoError=..., success with ?photoSaved=1 or ?photoRemoved=1, which pop a
 * toast via the flash classifier -- the same mechanism HipaaPanel's upload
 * uses for ?certError=.../?certSaved=1, not a mechanism of this component's own.
 */
import { PersonPhoto } from "@/platform/ui/person-photo";
import { Card } from "@/platform/ui/card";
import { Field } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";

type PhotoCardProps = {
  person: { id: string; name: string | null; photoVersion: number; photoKey: string | null };
  maxMb: number;
  uploadAction: (formData: FormData) => Promise<void>;
  removeAction: () => Promise<void>;
};

export function PhotoCard({ person, maxMb, uploadAction, removeAction }: PhotoCardProps) {
  return (
    <Card className="flex flex-wrap items-center gap-6">
      <PersonPhoto person={person} size={96} />
      <div className="flex-1 space-y-3">
        <form action={uploadAction}>
          <Field
            label="Upload a new photo"
            hint={`PNG, JPEG, or WebP, up to ${maxMb} MB. Square images work best.`}
          >
            {/* eslint-disable-next-line no-restricted-syntax -- native file input with file-button pseudo-element styling (file:* classes); no file primitive exists, matches hipaa-panel.tsx */}
            <input type="file" name="photo" accept="image/png,image/jpeg,image/webp" required className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
          </Field>
          <FormActions>
            <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
              Save photo
            </SubmitButton>
          </FormActions>
        </form>

        {/* The opt-out. Rendered whenever a photo exists, self-uploaded or
            Yalies-sourced -- see the module doc comment above for why this must
            stay a plain, always-visible button. */}
        {person.photoKey ? (
          <form action={removeAction}>
            <FormActions>
              <SubmitButton variant="outline" size="sm" pendingLabel="Removing…">
                Remove photo
              </SubmitButton>
            </FormActions>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
