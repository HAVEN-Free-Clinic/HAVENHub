"use client";
import { GripVertical } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { CustomQuestionBlock } from "@/modules/recruitment/contract/layout";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import { FIELD_TYPE_META } from "@/modules/recruitment/engine/field-types";
import type { Choice } from "@/modules/recruitment/engine/options";
import type { SortableHandleProps } from "../sortable-list";
import { OptionsEditor } from "../options-editor";
import { Field, Input } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";

/**
 * A custom question is an admin-authored field stored under its own `key`. The
 * key is the answer key, so it is immutable here (swap via remove + add). The
 * field type is fixed at add time; only label, required, and (for select types)
 * the choices are editable.
 */
export function CustomQuestionCard({
  block,
  handle,
  onUpdate,
  onRemove,
}: {
  block: CustomQuestionBlock;
  handle: SortableHandleProps;
  onUpdate: (patch: BlockPatch) => void;
  onRemove: () => void;
}) {
  const meta = FIELD_TYPE_META[block.type];
  const hasOptions = meta.hasOptions;

  return (
    <Card size="compact" className="group">
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-5 cursor-grab px-1"
          aria-label="Drag to reorder question"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </Button>
        <div className="flex-1 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <Field label="Question label">
              <Input
                defaultValue={block.label}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== block.label) onUpdate({ label: v });
                }}
              />
            </Field>
            <Badge tone="default" className="mt-5 shrink-0">{meta.label}</Badge>
          </div>
          {hasOptions && (
            <Field label="Choices">
              <OptionsEditor
                options={(block.options ?? []) as Choice[]}
                onChange={(next) => onUpdate({ options: next })}
              />
            </Field>
          )}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox checked={block.required} onChange={(e) => onUpdate({ required: e.target.checked })} /> Required
            </label>
            <form action={() => onRemove()}>
              <ConfirmButton label="Remove question" size="sm" />
            </form>
          </div>
        </div>
      </div>
    </Card>
  );
}
