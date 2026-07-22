"use client";
import { GripVertical, Lock } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import type { BlockPatch } from "@/modules/recruitment/contract/block-ops";
import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import type { SortableHandleProps } from "../sortable-list";
import { Field, Input } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { ConditionEditor } from "./condition-editor";

/**
 * A system field is a built-in question backed by a Person column. Its
 * `systemKey` is immutable (it names the column), so this card never edits or
 * deletes the key. CORE fields (name/email/epic/hipaa) are structurally
 * required by `assertTwoTier`, so they render locked: no toggle, no delete,
 * and (deliberately, see below) no visibility condition either. Optional
 * fields expose an enable/disable checkbox and a full ConditionEditor.
 *
 * CORE fields also skip the ConditionEditor because a `visibleWhen` that
 * evaluates false at submit time would hide the field's only input on the
 * onboarding page while `submitContract` still requires it unconditionally:
 * `firstName`/`lastName`/`email`/`hipaaCompletedAt`/`hipaaFile` are validated
 * regardless of block visibility (unlike agreements and custom questions,
 * which are validated only when `visibleContractBlocks` shows them), so a
 * hidden CORE field would be an unrecoverable dead end for the applicant, not
 * a skippable question. `assertTwoTier` does not catch this at save time --
 * it only checks the block exists and is enabled -- so this is a builder-UI
 * guard, not a relaxation of any schema or submit-time validation.
 */
export function SystemFieldCard({
  block,
  handle,
  fieldOptions,
  onUpdate,
  onToggle,
}: {
  block: SystemFieldBlock;
  handle: SortableHandleProps;
  fieldOptions: { value: string; label: string }[];
  onUpdate: (patch: BlockPatch) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const spec = SYSTEM_FIELDS[block.systemKey];
  const core = spec.core;
  const enabled = block.enabled !== false;
  const currentLabel = block.label ?? "";

  return (
    <Card size="compact" className="group">
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-5 cursor-grab px-1"
          aria-label="Drag to reorder field"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </Button>
        <div className="flex-1 space-y-3">
          <Field label="Field label" hint={`System field. Defaults to "${spec.defaultLabel}".`}>
            <Input
              defaultValue={currentLabel}
              placeholder={spec.defaultLabel}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== currentLabel) onUpdate({ label: v || undefined });
              }}
            />
          </Field>
          {!core && (
            <ConditionEditor
              value={block.visibleWhen}
              onChange={(next) => onUpdate({ visibleWhen: next })}
              fieldOptions={fieldOptions}
            />
          )}
        </div>
        <div className="mt-5 flex items-center">
          {core ? (
            <Badge tone="default" title="Required field. It cannot be removed or disabled.">
              <Lock className="h-3 w-3" aria-hidden /> Locked
            </Badge>
          ) : (
            <label className="flex items-center gap-2 text-sm text-foreground-soft">
              <Checkbox checked={enabled} onChange={(e) => onToggle(e.target.checked)} /> Shown
            </label>
          )}
        </div>
      </div>
    </Card>
  );
}
