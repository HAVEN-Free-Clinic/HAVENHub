"use client";

/**
 * SubmitForm: new IT Support ticket intake.
 *
 * Category drives conditional fields: choosing "Epic access" reveals the Epic
 * intake block (subtype, job title, Epic ID to mirror, works-at-YNHHS,
 * government ID/NPI, NetID) that createTechRequest persists on the ticket for
 * later promotion into an EpicRequest. No priority field: priority is
 * manager-owned, set after triage.
 */

import { useState } from "react";
import type { TechRequestCategory, EpicRequestKind } from "@prisma/client";
import { Input, Textarea, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { FormActions } from "@/platform/ui/form";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import { SUPPORT_UPLOAD_ACCEPT } from "@/modules/support/services/attachments";

const EPIC_SUBTYPES: { value: EpicRequestKind; label: string }[] = [
  { value: "NEW", label: "New account" },
  { value: "MODIFY", label: "Modification" },
  { value: "RENEW", label: "Renewal" },
];

type SubmitFormProps = {
  action: (formData: FormData) => Promise<void>;
  error?: string;
};

export function SubmitForm({ action, error }: SubmitFormProps) {
  const [category, setCategory] = useState<TechRequestCategory>("GENERAL_IT");
  const isEpic = category === "EPIC";

  return (
    <form action={action}>
      <Card className="space-y-6">
        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Category" required>
          <Select
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value as TechRequestCategory)}
          >
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

        {isEpic && (
          <div className="space-y-4 rounded-xl border border-border bg-muted p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Epic access details
            </p>

            <Field label="Request type" required>
              <Select name="epicSubtype" defaultValue="NEW">
                {EPIC_SUBTYPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Job title">
                <Input name="epicJobTitle" placeholder="e.g. Medical Student" />
              </Field>

              <Field label="Epic ID to mirror" hint="Leave blank if this is a brand-new account.">
                <Input name="epicMirrorId" placeholder="Existing Epic ID to copy permissions from" />
              </Field>

              <Field label="Government ID / NPI">
                <Input name="govId" placeholder="Government-issued ID or NPI number" />
              </Field>

              <Field label="NetID">
                <Input name="netId" placeholder="Yale NetID" />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox name="worksAtYnhh" />
              Currently works at YNHHS
            </label>
          </div>
        )}

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
