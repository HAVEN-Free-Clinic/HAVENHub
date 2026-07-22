"use client";
import { Select } from "@/platform/ui/select";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import type { FieldCondition, FieldConditionOp } from "@/modules/recruitment/engine/field-visibility";
import { newCondition, changeOp } from "./condition-ops";

/**
 * Edits a block's `visibleWhen` condition. With no condition the block is
 * always shown; "Add condition" seeds one on the first available field.
 * `isAnyOf` is deliberately not offered here: the schema and the default
 * layouts use it, but hand-authoring a value list is a worse experience than
 * two `is` conditions, so this control stays to `is` / `isNot` / `isAnswered`.
 */
export function ConditionEditor({
  value,
  onChange,
  fieldOptions,
}: {
  value: FieldCondition | undefined;
  onChange: (next: FieldCondition | undefined) => void;
  fieldOptions: { value: string; label: string }[];
}) {
  if (!value) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>Always shown</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(newCondition(fieldOptions))}>
          Add condition
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="When">
          <Select value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
            {fieldOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Is">
          <Select
            value={value.op}
            onChange={(e) => onChange(changeOp(value, e.target.value as FieldConditionOp))}
          >
            <option value="is">equals</option>
            <option value="isNot">does not equal</option>
            <option value="isAnswered">is answered</option>
          </Select>
        </Field>
        {value.op !== "isAnswered" && (
          <Field label="Value">
            <Input
              value={typeof value.value === "string" ? value.value : ""}
              onChange={(e) => onChange({ ...value, value: e.target.value })}
            />
          </Field>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
        Remove condition
      </Button>
    </div>
  );
}
