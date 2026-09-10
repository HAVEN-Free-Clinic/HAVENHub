"use client";
import { GripVertical } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { AgreementBlock, ConfirmKind } from "@/modules/recruitment/contract/layout";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import type { SortableHandleProps } from "../sortable-list";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";
import { ConditionEditor } from "./condition-editor";

/**
 * An agreement is a prose block the applicant signs by typing their name. Its
 * `id` is the answer key for the stored signature, so this card never edits the
 * id -- only the title, body, signature prompt, confirm kind, and visibility.
 */
export function AgreementCard({
  block,
  handle,
  fieldOptions,
  onUpdate,
  onRemove,
}: {
  block: AgreementBlock;
  handle: SortableHandleProps;
  fieldOptions: { value: string; label: string }[];
  onUpdate: (patch: BlockPatch) => void;
  onRemove: () => void;
}) {
  return (
    <Card size="compact" className="group">
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-5 cursor-grab px-1"
          aria-label="Drag to reorder agreement"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </Button>
        <div className="flex-1 space-y-3">
          <Field label="Agreement title">
            <Input
              defaultValue={block.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== block.title) onUpdate({ title: v });
              }}
            />
          </Field>
          <Field label="Agreement text" hint="Plain text. Use {{firstName}} and {{orgName}} for personalization.">
            <Textarea
              rows={5}
              defaultValue={block.body}
              onBlur={(e) => {
                if (e.target.value !== block.body) onUpdate({ body: e.target.value });
              }}
            />
          </Field>
          <Field label="Signature prompt" hint="Shown beside the signature box, e.g. type your full name.">
            <Input
              defaultValue={block.signatureLabel}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== block.signatureLabel) onUpdate({ signatureLabel: v });
              }}
            />
          </Field>
          <Field label="Confirmed by" hint="How the applicant confirms this agreement.">
            <Select
              value={block.confirmKind ?? "signature"}
              onChange={(e) => onUpdate({ confirmKind: e.target.value as ConfirmKind })}
            >
              <option value="signature">Signature</option>
              <option value="initials">Initials</option>
              <option value="checkbox">Checkbox</option>
            </Select>
          </Field>
          <ConditionEditor
            value={block.visibleWhen}
            onChange={(next) => onUpdate({ visibleWhen: next })}
            fieldOptions={fieldOptions}
          />
          <div className="flex justify-end">
            <form action={() => onRemove()}>
              <ConfirmButton label="Remove agreement" confirmLabel="Remove this agreement?" size="sm" />
            </form>
          </div>
        </div>
      </div>
    </Card>
  );
}
