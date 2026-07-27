"use client";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { Button } from "@/platform/ui/button";
import { fieldTypesByGroup, FIELD_TYPE_META, FIELD_GROUP_LABELS } from "@/modules/recruitment/engine/field-types";

export function TypePicker({
  onPick, disabled = false, label = "Add field", types,
}: { onPick: (type: FieldType) => void; disabled?: boolean; label?: string; types?: FieldType[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Restore focus to the trigger so a keyboard user who picked a type or pressed Escape
  // is not dropped to <body> and forced to Tab from the top of the page back to this
  // section for every field they add (#24). Button does not forward refs, and the
  // trigger is the first button in the container. The read lives inside event handlers
  // only (never during render). NOT called for click-outside dismissal, which
  // deliberately moved focus elsewhere. Mirrors notification-bell.tsx.
  const focusTrigger = () => ref.current?.querySelector("button")?.focus();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        focusTrigger();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  // Group the options: explicit `types` render as one flat, header-less group; the
  // default renders each field-type group with its label header.
  type Grp = keyof typeof FIELD_GROUP_LABELS;
  const groups: { group: Grp | null; groupTypes: FieldType[] }[] = types
    ? [{ group: null, groupTypes: types }]
    : fieldTypesByGroup().map((g) => ({ group: g.group, groupTypes: g.types }));

  return (
    <div ref={ref} className="relative">
      <Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Plus className="h-4 w-4" aria-hidden /> {label}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded-xl glass-panel p-2">
          {groups.map(({ group, groupTypes }) => (
            <div key={group ?? "__all"} className="mb-1">
              {group && (
                <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">{FIELD_GROUP_LABELS[group]}</p>
              )}
              {groupTypes.map((t) => {
                const meta = FIELD_TYPE_META[t];
                const Icon = meta.icon;
                return (
                  // eslint-disable-next-line no-restricted-syntax -- styled full-width option button inside the add-field popover
                  <button key={t} type="button" onClick={() => { onPick(t); setOpen(false); focusTrigger(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted">
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
