"use client";

import { useState } from "react";
import { Combobox } from "@/platform/ui/combobox";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field } from "@/platform/ui/input";
import type { SubjectOption } from "@/modules/incidents/services/report";

/**
 * Section 4 subject control for the incident report form.
 *
 * A searchable person picker links any person in the system (the chosen id rides
 * in a hidden `subjectPersonId` input, so the parent server-action form is
 * unchanged). The "Request a strike" checkbox (`requestStrike`) only appears once
 * the picked person is a volunteer the reporter manages (`strikeEligibleIds`);
 * submitReport re-checks eligibility server-side, so this gating is UX only.
 */
export function SubjectPicker({
  people,
  strikeEligibleIds,
}: {
  people: SubjectOption[];
  strikeEligibleIds: string[];
}) {
  const [picked, setPicked] = useState("");
  const canRequestStrike = strikeEligibleIds.length > 0;
  const eligible = picked !== "" && strikeEligibleIds.includes(picked);

  return (
    <div className="space-y-2">
      <Field
        label="Link the person involved (optional)"
        hint="Search anyone in the system - a volunteer, director, or staff member. Use the box above if they are not listed."
      >
        <Combobox
          name="subjectPersonId"
          ariaLabel="Search people to link to this report"
          placeholder="Search by name..."
          options={people.map((p) => ({
            value: p.id,
            label: p.hint ? `${p.name} (${p.hint})` : p.name,
          }))}
          onValueChange={setPicked}
        />
      </Field>

      {canRequestStrike && eligible && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="requestStrike" /> Request a strike against this volunteer (a reviewer approves before it
          counts)
        </label>
      )}
      {canRequestStrike && !eligible && (
        <p className="text-xs text-subtle-foreground">
          To request a strike, pick a volunteer you manage from the list above.
        </p>
      )}
    </div>
  );
}
