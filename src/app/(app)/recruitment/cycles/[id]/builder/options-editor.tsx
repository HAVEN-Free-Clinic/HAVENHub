// src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx
"use client";
import { GripVertical, Plus, X } from "lucide-react";
import { appendChoice, renameChoice, type Choice } from "@/modules/recruitment/engine/options";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { SortableList } from "./sortable-list";

export function OptionsEditor({
  options, onChange, disabled = false, markCorrect,
}: {
  options: Choice[];
  onChange: (next: Choice[]) => void;
  disabled?: boolean;
  markCorrect?: { value: string | null; onPick: (value: string) => void };
}) {
  const items = options.map((o) => ({ id: o.value, ...o }));

  function reorder(orderedIds: string[]) {
    onChange(orderedIds.map((id) => options.find((o) => o.value === id)!).filter(Boolean));
  }
  function remove(value: string) {
    onChange(options.filter((o) => o.value !== value));
  }

  return (
    <div className="space-y-2">
      <SortableList items={items} onReorder={reorder} disabled={disabled} renderItem={(item, handle) => (
        <div className="flex items-center gap-2 py-1">
          <button type="button" className="cursor-grab text-subtle-foreground disabled:cursor-not-allowed"
            disabled={disabled} aria-label="Drag to reorder option"
            {...(handle.attributes as React.HTMLAttributes<HTMLButtonElement>)}
            {...((handle.listeners ?? {}) as React.HTMLAttributes<HTMLButtonElement>)}>
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
          {markCorrect && (
            <input type="radio" name="__correct" aria-label="Correct answer"
              className="h-4 w-4 accent-brand" checked={markCorrect.value === item.value}
              disabled={disabled} onChange={() => markCorrect.onPick(item.value)} />
          )}
          <Input defaultValue={item.label} disabled={disabled} aria-label="Option label"
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.label) onChange(renameChoice(options, item.value, v)); }} />
          <Button type="button" variant="ghost" size="sm" disabled={disabled}
            onClick={() => remove(item.value)} aria-label="Remove option">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )} />
      <Button type="button" variant="ghost" size="sm" disabled={disabled}
        onClick={() => onChange(appendChoice(options, `Option ${options.length + 1}`))}>
        <Plus className="h-4 w-4" aria-hidden /> Add option
      </Button>
    </div>
  );
}
