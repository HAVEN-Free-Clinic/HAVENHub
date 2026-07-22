"use client";
import { Select } from "@/platform/ui/select";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import type { FieldCondition, FieldConditionOp } from "@/modules/recruitment/engine/field-visibility";
import { newCondition, changeOp, changeValue } from "./condition-ops";

/**
 * Edits a block's `visibleWhen` condition. With no condition the block is
 * always shown; "Add condition" seeds one on the first available field.
 * `isAnyOf` is deliberately not offered as a new choice here: the schema
 * supports it (some application-form templates use it), but hand-authoring a
 * value list is a worse experience than two `is` conditions, so a fresh
 * condition can only be `is` / `isNot` / `isAnswered`. A condition that
 * already has `op: "isAnyOf"` (from a hand-edited or future template) still
 * needs to display and stay editable here, so its operator option is shown
 * conditionally and its value control handles the array shape; see
 * `changeValue`.
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
            {value.op === "isAnyOf" && <option value="isAnyOf">is any of</option>}
          </Select>
        </Field>
        {value.op !== "isAnswered" && (
          <Field label="Value" hint={value.op === "isAnyOf" ? "Comma-separated list" : undefined}>
            <Input
              value={Array.isArray(value.value) ? value.value.join(", ") : (value.value ?? "")}
              onChange={(e) => onChange(changeValue(value, e.target.value))}
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
