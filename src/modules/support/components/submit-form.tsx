"use client";

/**
 * SubmitForm: new IT Support ticket intake.
 *
 * Every category, including "Epic access", collects only subject and
 * description (plus optional attachments). Epic operational details (request
 * kind, job title, mirror ID, etc.) are handled by managers on the backend
 * during promotion, not by the submitter. No priority field: priority is
 * manager-owned, set after triage.
 */

import type { TechRequestCategory } from "@prisma/client";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import { SUPPORT_UPLOAD_ACCEPT } from "@/modules/support/upload-constants";

const DEFAULT_CATEGORY: TechRequestCategory = "GENERAL_IT";

type SubmitFormProps = {
  action: (formData: FormData) => Promise<void>;
};

export function SubmitForm({ action }: SubmitFormProps) {
  return (
    <form action={action}>
      <Card className="space-y-6">
        <Field label="Category" required>
          <Select name="category" defaultValue={DEFAULT_CATEGORY}>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Subject" required>
          <Input name="subject" placeholder="Short summary of the issue" required maxLength={200} />
        </Field>

        <Field label="Description" required>
          <Textarea
            name="description"
            rows={5}
            placeholder="What's going on? Include any error messages or steps to reproduce."
            required
          />
        </Field>

        <Field label="Attachments" hint="Optional. Images, PDF, text, or Office documents.">
          {/* eslint-disable-next-line no-restricted-syntax -- native file input with file-button pseudo-element styling (file:* classes); no file primitive exists */}
          <input type="file" name="attachments" multiple accept={SUPPORT_UPLOAD_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
        </Field>

        <FormActions>
          <SubmitButton variant="primary" pendingLabel="Submitting…">
            Submit request
          </SubmitButton>
        </FormActions>
      </Card>
    </form>
  );
}
