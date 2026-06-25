// src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx
"use client";
import { useState, useTransition, type HTMLAttributes } from "react";
import { Copy, GripVertical, Pencil, Check, AlertCircle } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { FieldPreview, type PreviewFieldDef } from "@/modules/recruitment/components/field-preview";
import { FIELD_TYPE_META, fieldTypesByGroup } from "@/modules/recruitment/engine/field-types";
import { updateFieldAction, deleteFieldAction, duplicateFieldAction } from "./actions";
import { OptionsEditor } from "./options-editor";
import type { Choice } from "@/modules/recruitment/engine/options";
import type { SortableHandleProps } from "./sortable-list";
import { Field, Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export type BuilderField = PreviewFieldDef & { id: string; correctValue: string | null };

const FILE_TYPE_CHOICES: { label: string; value: string }[] = [
  { label: "PDF", value: "application/pdf" },
  { label: "Word", value: "application/msword" },
  { label: "Images", value: "image/*" },
];

export function FieldCard({
  cycleId, field, departments, editable, handle, onChanged,
}: {
  cycleId: string;
  field: BuilderField;
  departments: string[];
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

  function save(patch: Parameters<typeof updateFieldAction>[2]) {
    setError(null);
    startTransition(async () => {
      const res = await updateFieldAction(cycleId, field.id, patch);
      if (res.ok) { setSaved(true); onChanged(); setTimeout(() => setSaved(false), 1500); }
      else setError(res.error);
    });
  }

  return (
    <div className="group rounded-xl border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-1 cursor-grab text-subtle-foreground opacity-0 group-hover:opacity-100 disabled:cursor-not-allowed"
          disabled={!editable}
          aria-label="Drag to reorder field"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex-1">
          <FieldPreview f={field} departments={departments} disabled />
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          <span title={meta.label} className="px-1 text-subtle-foreground"><Icon className="h-4 w-4" aria-hidden /></span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-label="Edit field"><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button type="button" variant="ghost" size="sm" disabled={!editable || pending}
            onClick={() => startTransition(async () => { const r = await duplicateFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); })}
            aria-label="Duplicate field"><Copy className="h-4 w-4" aria-hidden /></Button>
          <form action={async () => { const r = await deleteFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }}>
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
        </div>
      )}
    </div>
  );
}
