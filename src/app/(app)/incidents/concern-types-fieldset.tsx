"use client";

import { useState } from "react";
import { Checkbox } from "@/platform/ui/checkbox";

type ConcernOption = { value: string; label: string; help: string };

/**
 * The concern-type checkboxes for the incident report, with a client-side
 * "at least one" guard.
 *
 * submitReport rejects an empty selection server-side, and that validation
 * redirect discards the entire uncontrolled 10-section form (all answers, every
 * linked subject). So we enforce the rule in the browser: while nothing is
 * checked, the first box carries `required`, and native form validation blocks
 * the submit before the round-trip. The requirement lifts the moment any box is
 * checked, so the group behaves as "at least one".
 */
export function ConcernTypesFieldset({ options }: { options: readonly ConcernOption[] }) {
  const [checkedCount, setCheckedCount] = useState(0);
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">1. Type of concern (select all that apply)</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((t, i) => (
          <label key={t.value} className="flex items-start gap-2 text-sm">
            <Checkbox
              name="concernTypes"
              value={t.value}
              className="mt-0.5"
              required={i === 0 && checkedCount === 0}
              onChange={(e) => setCheckedCount((c) => c + (e.target.checked ? 1 : -1))}
            />
            <span>
              <span className="font-medium">{t.label}</span> -{" "}
              <span className="text-muted-foreground">{t.help}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
