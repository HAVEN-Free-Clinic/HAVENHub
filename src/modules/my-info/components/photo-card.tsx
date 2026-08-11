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
 * Discoverability of the control is only half of consent: a member who does
 * not know the photo was pulled from Yale's directory cannot meaningfully
 * decide to opt out of it. So when photoSource is "yalies", a one-line notice
 * renders right beside the photo, above the upload form and the remove
 * control, so it is read before either. A self-uploaded photo (photoSource
 * "upload") gets no such notice: the member already knows where that one
 * came from.
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
  /** "yalies" | "upload" | null. Drives the Yale's-directory notice below; only "yalies" shows it. */
  photoSource: string | null;
  maxMb: number;
  uploadAction: (formData: FormData) => Promise<void>;
  removeAction: () => Promise<void>;
};

export function PhotoCard({ person, photoSource, maxMb, uploadAction, removeAction }: PhotoCardProps) {
  return (
    <Card className="flex flex-wrap items-center gap-6">
      <PersonPhoto person={person} size={96} />
      <div className="flex-1 space-y-3">
        {/* The consent-legibility half of the opt-out (see module doc comment):
            without this, a member has a remove button but no reason to press
            it. Shown only for a Yalies-sourced photo; a self-uploaded one
            needs no explanation of where it came from. */}
        {photoSource === "yalies" && (
          <p className="text-sm text-muted-foreground">
            This photo is from Yale&apos;s directory. Remove it if you would rather show your initials instead.
          </p>
        )}
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
