"use client";

import { useState } from "react";
import { Pencil, Check, X } from "lucide-react";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

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
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. RITM1234567"
          className="w-32 py-1 text-xs"
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          aria-label="Save"
          className="h-6 w-6 grid place-items-center p-0"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(false);
            setValue(serviceRequestNumber ?? "");
          }}
          aria-label="Cancel"
          className="h-6 w-6 grid place-items-center p-0"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  if (serviceRequestNumber) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setEditing(true)}
        className="gap-1.5 text-xs px-0 py-0 h-auto"
      >
        Service request: <span className="font-medium text-foreground-soft">{serviceRequestNumber}</span>
        <Pencil className="h-3 w-3" aria-hidden />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setEditing(true)}
      className="gap-1.5 border-dashed border-border text-brand-fg hover:bg-brand-faint text-xs"
    >
      <Pencil className="h-3 w-3" aria-hidden />
      Add ticket number
    </Button>
  );
}
