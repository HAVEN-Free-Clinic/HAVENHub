"use client";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { Button } from "@/platform/ui/button";
import { fieldTypesByGroup, FIELD_TYPE_META } from "@/modules/recruitment/engine/field-types";

const GROUP_LABELS: Record<string, string> = {
  Text: "Text", Choice: "Choice", Contact: "Contact",
  DateNumber: "Date & number", File: "File", Department: "Department",
};

export function TypePicker({
  onPick, disabled = false, label = "Add field",
}: { onPick: (type: FieldType) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Plus className="h-4 w-4" aria-hidden /> {label}
      </Button>
      {open && (
        <div role="menu"
          className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded-xl border border-border bg-surface p-2 shadow-lg">
          {fieldTypesByGroup().map(({ group, types }) => (
            <div key={group} className="mb-1">
              <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">{GROUP_LABELS[group]}</p>
              {types.map((t) => {
                const meta = FIELD_TYPE_META[t];
                const Icon = meta.icon;
                return (
                  // eslint-disable-next-line no-restricted-syntax -- popover dropdown menu item with role="menuitem"
                  <button key={t} type="button" role="menuitem" onClick={() => { onPick(t); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted">
                    <Icon className="h-4 w-4 text-subtle-foreground" aria-hidden /> {meta.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
