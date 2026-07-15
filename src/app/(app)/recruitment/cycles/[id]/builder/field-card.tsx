"use client";
import { useState, useTransition, type HTMLAttributes } from "react";
import { Copy, GripVertical, Pencil, Check, AlertCircle } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { FieldPreview, type PreviewFieldDef } from "@/modules/recruitment/components/field-preview";
import { FIELD_TYPE_META, fieldTypesByGroup } from "@/modules/recruitment/engine/field-types";
import { parseFieldCondition, type FieldCondition, type FieldConditionOp } from "@/modules/recruitment/engine/field-visibility";
import { updateFieldAction, deleteFieldAction, duplicateFieldAction } from "./actions";
import { OptionsEditor } from "./options-editor";
import type { Choice } from "@/modules/recruitment/engine/options";
import type { SortableHandleProps } from "./sortable-list";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Card } from "@/platform/ui/card";

export type BuilderField = PreviewFieldDef & { id: string; correctValue: string | null; visibleWhen: unknown };

const FILE_TYPE_CHOICES: { label: string; value: string }[] = [
  { label: "PDF", value: "application/pdf" },
  { label: "Word", value: "application/msword" },
  { label: "Images", value: "image/*" },
];

/** The value-side options for a controlling field's "Show only when" condition:
 *  a dropdown of its choices for a select-like field, a synthetic single
 *  "Checked" choice for a checkbox, the cycle's departments for the
 *  department picker, or null (free-text input) for anything else. */
function conditionValueOptions(
  controllingField: BuilderField | undefined,
  departments: string[],
): { value: string; label: string }[] | null {
  if (!controllingField) return null;
  if (controllingField.type === "CHECKBOX") return [{ value: "on", label: "Checked" }];
  if (controllingField.type === "DEPARTMENT_CHOICE") return departments.map((d) => ({ value: d, label: d }));
  return controllingField.options && controllingField.options.length > 0 ? controllingField.options : null;
}

function VisibleWhenEditor({
  visibleWhen, siblingFields, departments, disabled, onChange,
}: {
  visibleWhen: unknown;
  siblingFields: BuilderField[];
  departments: string[];
  disabled: boolean;
  onChange: (cond: FieldCondition | null) => void;
}) {
  const parsed = parseFieldCondition(visibleWhen);
  const controllingKey = parsed?.field ?? "";
  const controllingField = siblingFields.find((f) => f.key === controllingKey);
  const op: FieldConditionOp = parsed?.op ?? "is";
  const opts = conditionValueOptions(controllingField, departments);
  const selectedValues = op === "isAnyOf" ? (Array.isArray(parsed?.value) ? parsed.value : []) : [];
  const singleValue = op !== "isAnyOf" && typeof parsed?.value === "string" ? parsed.value : "";

  function handleFieldChange(key: string) {
    if (!key) { onChange(null); return; }
    onChange(parseFieldCondition({ field: key, op: "isAnswered" }));
  }
  function handleOpChange(nextOp: FieldConditionOp) {
    if (!controllingKey) return;
    if (nextOp === "isAnswered") { onChange(parseFieldCondition({ field: controllingKey, op: nextOp })); return; }
    if (nextOp === "isAnyOf") { onChange(parseFieldCondition({ field: controllingKey, op: nextOp, value: [] })); return; }
    onChange(parseFieldCondition({ field: controllingKey, op: nextOp, value: "" }));
  }
  function handleSingleValueChange(v: string) {
    if (!controllingKey) return;
    onChange(parseFieldCondition({ field: controllingKey, op, value: v }));
  }
  function handleMultiValueChange(values: string[]) {
    if (!controllingKey) return;
    onChange(parseFieldCondition({ field: controllingKey, op, value: values }));
  }

  return (
    <Field label="Show only when" hint="Hide this question unless another answer matches. Leave as (always show) for no condition.">
      <div className="flex flex-wrap items-center gap-2">
        <Select disabled={disabled} value={controllingKey} onChange={(e) => handleFieldChange(e.target.value)}>
          <option value="">(always show)</option>
          {controllingKey && !controllingField && <option value={controllingKey} disabled>{controllingKey} (deleted field)</option>}
          {siblingFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </Select>
        {controllingKey && (
          <>
            <Select disabled={disabled} value={op} onChange={(e) => handleOpChange(e.target.value as FieldConditionOp)}>
              <option value="is">is</option>
              <option value="isNot">is not</option>
              <option value="isAnswered">is answered</option>
              <option value="isAnyOf">is any of</option>
            </Select>
            {op !== "isAnswered" && op !== "isAnyOf" && (
              opts ? (
                <Select disabled={disabled} value={singleValue} onChange={(e) => handleSingleValueChange(e.target.value)}>
                  <option value="" disabled>Select…</option>
                  {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : (
                <Input disabled={disabled} defaultValue={singleValue}
                  onBlur={(e) => handleSingleValueChange(e.target.value.trim())} />
              )
            )}
            {op === "isAnyOf" && (
              opts ? (
                <Select disabled={disabled} multiple value={selectedValues}
                  onChange={(e) => handleMultiValueChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                  {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : (
                <Input disabled={disabled} defaultValue={selectedValues.join(", ")}
                  placeholder="comma-separated values"
                  onBlur={(e) => handleMultiValueChange(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} />
              )
            )}
          </>
        )}
      </div>
    </Field>
  );
}

export function FieldCard({
  cycleId, field, siblingFields, departments, subcommittees, editable, handle, onChanged,
}: {
  cycleId: string;
  field: BuilderField;
  siblingFields: BuilderField[];
  departments: string[];
  subcommittees: { id: string; name: string }[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = FIELD_TYPE_META[field.type as FieldType];
  const Icon = meta.icon;
  const accepted = Array.isArray(field.validation?.acceptedTypes) ? (field.validation!.acceptedTypes as string[]) : [];
  const otherFields = siblingFields.filter((f) => f.key !== field.key);

  function save(patch: Parameters<typeof updateFieldAction>[2]) {
    setError(null);
    startTransition(async () => {
      const res = await updateFieldAction(cycleId, field.id, patch);
      if (res.ok) { setSaved(true); onChanged(); setTimeout(() => setSaved(false), 1500); }
      else setError(res.error);
    });
  }

  return (
    <Card size="compact" className="group">
      <div className="flex items-start gap-2">
        {/* eslint-disable-next-line no-restricted-syntax -- DnD drag-handle button, needs raw attribute/listener spread for dnd-kit */}
        <button type="button" className="mt-1 cursor-grab text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 disabled:cursor-not-allowed" disabled={!editable} aria-label="Drag to reorder field" {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)} {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}>
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex-1">
          <FieldPreview f={field} departments={departments} subcommittees={subcommittees} disabled />
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <span title={meta.label} className="px-1 text-subtle-foreground"><Icon className="h-4 w-4" aria-hidden /></span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-label="Edit field"><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button type="button" variant="ghost" size="sm" disabled={!editable || pending}
            onClick={() => { setError(null); startTransition(async () => { const r = await duplicateFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }); }}
            aria-label="Duplicate field"><Copy className="h-4 w-4" aria-hidden /></Button>
          <form action={async () => { setError(null); const r = await deleteFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }}>
            <ConfirmButton label="Remove" size="sm" disabled={!editable} />
          </form>
        </div>
      </div>

      {(saved || error) && (
        <p className={`mt-1 flex items-center gap-1 text-xs ${error ? "text-critical" : "text-subtle-foreground"}`}>
          {error ? <><AlertCircle className="h-3 w-3" aria-hidden /> {error}</> : <><Check className="h-3 w-3" aria-hidden /> Saved</>}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          <Field label="Label">
            <Input defaultValue={field.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== field.label) save({ label: v }); }} />
          </Field>
          <Field label="Help text" hint="Shown under the field.">
            <Input defaultValue={field.helpText ?? ""} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (field.helpText ?? "")) save({ helpText: v }); }} />
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Type">
              <Select defaultValue={field.type} disabled={!editable} onChange={(e) => save({ type: e.target.value as FieldType })}>
                {fieldTypesByGroup().map(({ group, types }) => (
                  <optgroup key={group} label={group}>
                    {types.map((t) => <option key={t} value={t}>{FIELD_TYPE_META[t].label}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 py-2 text-sm text-foreground-soft">
              <Checkbox defaultChecked={field.required} disabled={!editable && !field.required}
                onChange={(e) => save({ required: e.target.checked })} /> Required
            </label>
          </div>

          {meta.hasOptions && (
            <Field label="Choices">
              <OptionsEditor options={(field.options ?? []) as Choice[]} disabled={!editable}
                onChange={(next) => save({ options: next })} />
            </Field>
          )}

          {meta.isFile && (
            <Field label="Accepted file types">
              <div className="flex flex-wrap gap-3">
                {FILE_TYPE_CHOICES.map((c) => (
                  <label key={c.value} className="flex items-center gap-2 text-sm">
                    <Checkbox defaultChecked={accepted.includes(c.value)} disabled={!editable}
                      onChange={(e) => {
                        const next = e.target.checked ? [...accepted, c.value] : accepted.filter((a) => a !== c.value);
                        save({ validation: { ...(field.validation ?? {}), acceptedTypes: next } });
                      }} /> {c.label}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {field.type === "DEPARTMENT_CHOICE" && (
            <p className="text-xs text-subtle-foreground">Choices come from this cycle&apos;s departments automatically.</p>
          )}

          {field.type === "SUBCOMMITTEE_RANK" && (
            <Field label="Number to rank" hint="How many ordered choices the applicant makes. Choices come from active subcommittees.">
              <Input
                type="number"
                min={1}
                max={5}
                defaultValue={String((field.validation?.rankCount as number | undefined) ?? 3)}
                disabled={!editable}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(5, Number(e.target.value) || 3));
                  const current = (field.validation?.rankCount as number | undefined) ?? 3;
                  if (n !== current) save({ validation: { ...(field.validation ?? {}), rankCount: n } });
                }}
              />
            </Field>
          )}

          {otherFields.length > 0 && (
            <VisibleWhenEditor
              visibleWhen={field.visibleWhen}
              siblingFields={otherFields}
              departments={departments}
              disabled={!editable}
              onChange={(cond) => save({ visibleWhen: cond })}
            />
          )}
        </div>
      )}
    </Card>
  );
}
