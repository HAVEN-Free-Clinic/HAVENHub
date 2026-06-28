"use client";

import { useState } from "react";
import { Pencil, Check, X } from "lucide-react";

export function TicketNumberField({
  ticketId,
  serviceRequestNumber,
  updateAction,
}: {
  ticketId: string;
  serviceRequestNumber: string | null;
  updateAction: (ticketId: string, value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(serviceRequestNumber ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    await updateAction(ticketId, value.trim());
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. RITM1234567"
          className="rounded-md border border-border-strong px-2 py-1 text-xs w-32"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="grid h-6 w-6 place-items-center rounded-md bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
          aria-label="Save"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(serviceRequestNumber ?? "");
          }}
          className="grid h-6 w-6 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  if (serviceRequestNumber) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
      >
        Service request: <span className="font-medium text-foreground-soft">{serviceRequestNumber}</span>
        <Pencil className="h-3 w-3" aria-hidden />
      </button>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs font-medium text-brand-fg hover:bg-brand-faint transition"
    >
      <Pencil className="h-3 w-3" aria-hidden />
      Add ticket number
    </button>
  );
}