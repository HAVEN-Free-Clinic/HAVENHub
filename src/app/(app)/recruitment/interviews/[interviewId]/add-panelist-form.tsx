"use client";

import { useState } from "react";
import { Combobox } from "@/platform/ui/combobox";
import { Checkbox } from "@/platform/ui/checkbox";
import { SubmitButton } from "@/platform/ui/submit-button";

/**
 * Adds a person to an interview panel via a searchable name picker. Replaces the
 * old "type a person id" field: the Combobox carries the selected id in a hidden
 * `personId` input, so the bound server action is unchanged. Submit stays
 * disabled until a real candidate is chosen.
 */
export function AddPanelistForm({
  action,
  candidates,
}: {
  action: (formData: FormData) => void | Promise<void>;
  candidates: { id: string; name: string }[];
}) {
  const [picked, setPicked] = useState("");
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
      <div className="min-w-[16rem] flex-1">
        <Combobox
          name="personId"
          ariaLabel="Search people to add to the panel"
          placeholder="Search people…"
          options={candidates.map((c) => ({ value: c.id, label: c.name }))}
          onValueChange={setPicked}
        />
      </div>
      <label className="flex items-center gap-2 py-2 text-sm text-foreground-soft">
        <Checkbox name="isLead" /> Lead
      </label>
      <SubmitButton size="sm" pendingLabel="Adding…" disabled={!picked}>
        Add panelist
      </SubmitButton>
    </form>
  );
}
