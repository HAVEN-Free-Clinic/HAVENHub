"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Input, Textarea } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";
import { SubmitButton } from "@/platform/ui/submit-button";
import { runAction } from "@/platform/ui/run-action";
import { savePresetAction } from "./actions";

export type PresetFormProps = {
  presetId: string | null;
  initial: {
    name: string;
    nameTemplate: string;
    messageTemplate: string;
    departmentIds: string[];
  };
  departments: { id: string; code: string; name: string }[];
};

export function PresetForm({ presetId, initial, departments }: PresetFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const selected = new Set(initial.departmentIds);

  async function onSubmit(formData: FormData) {
    // runAction turns a REJECTED action into { error } too. Without it a Prisma
    // failure inside the transition is an unhandled rejection: no Alert renders,
    // the pending flag flips back, and the form looks like it saved.
    const result = await runAction(() => savePresetAction(presetId, formData));
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    startTransition(() => router.push("/schedule/triage-chats"));
  }

  return (
    <form action={onSubmit} className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}

      <label className="block space-y-1">
        <span className="text-sm font-medium">Preset name</span>
        <Input name="name" defaultValue={initial.name} required placeholder="Ancillary" />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Chat name pattern</span>
        <Input
          name="nameTemplate"
          defaultValue={initial.nameTemplate}
          required
          placeholder="{{clinicDateShort}} Ancillary Triage Chat"
        />
        <span className="text-xs text-muted-foreground">
          Available: {"{{clinicDateShort}}"} (05.30.26) and {"{{clinicDate}}"} (Saturday, May 30, 2026).
        </span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Opening message</span>
        <Textarea name="messageTemplate" defaultValue={initial.messageTemplate} rows={14} required />
        <span className="text-xs text-muted-foreground">
          Available: {"{{clinicDate}}"}, {"{{sessionCoordinators}}"}, {"{{clinicalAdvisors}}"},
          {" "}{"{{rosterBlock}}"}, {"{{teamsChannelUrl}}"}. Plain text; you can edit it again before sending.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Departments</legend>
        <p className="text-xs text-muted-foreground">
          Each contributes its triage-tagged directors on shift. The leadership departments
          configured in Admin &gt; Settings are always included and do not need ticking here.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {departments.map((dept) => (
            <label key={dept.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                name="departmentIds"
                value={dept.id}
                defaultChecked={selected.has(dept.id)}
              />
              <span>
                {dept.code} - {dept.name}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <SubmitButton pendingLabel="Saving...">Save preset</SubmitButton>
    </form>
  );
}
