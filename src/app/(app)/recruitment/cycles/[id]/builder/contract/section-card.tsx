"use client";
import { GripVertical } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { SectionBlock } from "@/modules/recruitment/contract/layout";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import type { SortableHandleProps } from "../sortable-list";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";
import { ConditionEditor } from "./condition-editor";

/**
 * A section is a prose divider with no stored answer of its own -- just a
 * heading and body shown between other blocks. Its `id` only matters for drag
 * ordering and the shared agreement/section id namespace, so this card never
 * edits it -- only the title, body, and visibility condition.
 */
export function SectionCard({
  block,
  handle,
  fieldOptions,
  onUpdate,
  onRemove,
}: {
  block: SectionBlock;
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
          aria-label="Drag to reorder section"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </Button>
        <div className="flex-1 space-y-3">
          <Field label="Section title">
            <Input
              defaultValue={block.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== block.title) onUpdate({ title: v });
              }}
            />
          </Field>
          <Field label="Section text" hint="Plain text shown as a divider between blocks.">
            <Textarea
              rows={3}
              defaultValue={block.body}
              onBlur={(e) => {
                if (e.target.value !== block.body) onUpdate({ body: e.target.value });
              }}
            />
          </Field>
          <ConditionEditor
            value={block.visibleWhen}
            onChange={(next) => onUpdate({ visibleWhen: next })}
            fieldOptions={fieldOptions}
          />
          <div className="flex justify-end">
            <form action={() => onRemove()}>
              <ConfirmButton label="Remove section" size="sm" />
            </form>
          </div>
        </div>
      </div>
    </Card>
  );
}
