// src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx
"use client";
import { useState, useTransition, type HTMLAttributes } from "react";
import { GripVertical, Settings2 } from "lucide-react";
import type { ApplicantScope, FieldType } from "@prisma/client";
import { FieldCard, type BuilderField } from "./field-card";
import { SortableList, type SortableHandleProps } from "./sortable-list";
import { TypePicker } from "./type-picker";
import { updateSectionAction, deleteSectionAction, addFieldAction, reorderFieldsAction } from "./actions";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export type BuilderSection = {
  id: string;
  title: string;
  description: string | null;
  appliesTo: "NEW" | "RENEWAL" | "BOTH";
  departmentCode: string | null;
  fields: BuilderField[];
};

export function SectionCard({
  cycleId, section, departments, editable, handle, onChanged,
}: {
  cycleId: string;
  section: BuilderSection;
  departments: string[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [, startTransition] = useTransition();

  function saveSection(patch: Parameters<typeof updateSectionAction>[2]) {
    startTransition(async () => { const r = await updateSectionAction(cycleId, section.id, patch); if (r.ok) onChanged(); });
  }
  function addField(type: FieldType) {
    startTransition(async () => { const r = await addFieldAction(cycleId, section.id, { type }); if (r.ok) onChanged(); });
  }
  function reorder(orderedFieldIds: string[]) {
    startTransition(async () => { const r = await reorderFieldsAction(cycleId, section.id, orderedFieldIds); if (r.ok) onChanged(); });
  }

  const scope = section.appliesTo === "BOTH" ? "NEW · RENEWAL" : section.appliesTo;

  return (
    <section className="rounded-2xl border border-border bg-muted/30 p-4">
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-1 cursor-grab text-subtle-foreground disabled:cursor-not-allowed"
          disabled={!editable}
          aria-label="Drag to reorder section"
          {...(handle.attributes as HTMLAttributes<HTMLButtonElement>)}
          {...((handle.listeners ?? {}) as HTMLAttributes<HTMLButtonElement>)}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex-1">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
          <p className="text-xs text-subtle-foreground">{scope}{section.departmentCode ? ` · ${section.departmentCode}` : ""}</p>
          {section.description && <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowSettings((v) => !v)} aria-label="Section settings"><Settings2 className="h-4 w-4" aria-hidden /></Button>
        <form action={async () => { const r = await deleteSectionAction(cycleId, section.id); if (r.ok) onChanged(); }}>
          <ConfirmButton label="Delete section" size="sm" disabled={!editable} />
        </form>
      </div>

      {showSettings && (
        <div className="mt-3 grid gap-3 rounded-xl border border-border-subtle bg-surface p-3 sm:grid-cols-2">
          <Field label="Title">
            <Input defaultValue={section.title} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== section.title) saveSection({ title: v }); }} />
          </Field>
          <Field label="Applies to">
            <Select defaultValue={section.appliesTo} disabled={!editable} onChange={(e) => saveSection({ appliesTo: e.target.value as ApplicantScope })}>
              <option value="BOTH">New and renewing</option>
              <option value="NEW">New only</option>
              <option value="RENEWAL">Renewing only</option>
            </Select>
          </Field>
          <Field label="Description" hint="Shown under the section title.">
            <Textarea defaultValue={section.description ?? ""} rows={2} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (section.description ?? "")) saveSection({ description: v }); }} />
          </Field>
          <Field label="Department code" hint="Supplement only.">
            <Input defaultValue={section.departmentCode ?? ""} disabled={!editable} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (section.departmentCode ?? "")) saveSection({ departmentCode: v || null }); }} />
          </Field>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <SortableList items={section.fields} onReorder={reorder} disabled={!editable} renderItem={(field, fhandle) => (
          <div className="py-1">
            <FieldCard cycleId={cycleId} field={field} departments={departments} editable={editable} handle={fhandle} onChanged={onChanged} />
          </div>
        )} />
        {section.fields.length === 0 && <p className="py-2 text-sm text-subtle-foreground">No fields yet.</p>}
        <div className="pt-1"><TypePicker onPick={addField} disabled={!editable} /></div>
      </div>
    </section>
  );
}
