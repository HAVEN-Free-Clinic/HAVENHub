"use client";

import { useState } from "react";
import { Combobox } from "@/platform/ui/combobox";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { Field } from "@/platform/ui/input";
import type { SubjectOption } from "@/modules/incidents/services/report";

/**
 * Section 4 people picker for the incident report form.
 *
 * A searchable person picker adds people one at a time to an on-page list; each
 * added person rides in a hidden `subjectPersonIds` input, so the parent
 * server-action form receives the full set. A person who is a volunteer the
 * reporter manages (`strikeEligibleIds`) gets a per-row "Request a strike"
 * checkbox valued with their id (`strikePersonIds`); submitReport re-checks
 * eligibility server-side, so this gating is UX only.
 */
export function SubjectPicker({
  people,
  strikeEligibleIds,
}: {
  people: SubjectOption[];
  strikeEligibleIds: string[];
}) {
  const [added, setAdded] = useState<SubjectOption[]>([]);
  const [picked, setPicked] = useState("");
  const [comboKey, setComboKey] = useState(0);

  const eligible = new Set(strikeEligibleIds);
  const byId = new Map(people.map((p) => [p.id, p]));
  const addedIds = new Set(added.map((p) => p.id));

  function add() {
    if (!picked || addedIds.has(picked)) return;
    const person = byId.get(picked);
    if (!person) return;
    setAdded((prev) => [...prev, person]);
    setPicked("");
    setComboKey((k) => k + 1); // remount Combobox to clear its text + value
  }

  function remove(id: string) {
    setAdded((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-3">
      <Field
        label="Link the people involved (optional)"
        hint="Search anyone in the system, a volunteer, director, or staff member. Add as many as apply. Use the box above for anyone not listed."
      >
        <div className="flex gap-2">
          <div className="flex-1">
            <Combobox
              key={comboKey}
              name="subjectSearch"
              ariaLabel="Search people to link to this report"
              placeholder="Search by name..."
              options={people
                .filter((p) => !addedIds.has(p.id))
                .map((p) => ({ value: p.id, label: p.hint ? `${p.name} (${p.hint})` : p.name }))}
              onValueChange={setPicked}
            />
          </div>
          <Button type="button" variant="outline" onClick={add} disabled={!picked}>
            Add
          </Button>
        </div>
      </Field>

      {added.length > 0 && (
        <ul className="space-y-2">
          {added.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-subtle px-3 py-2 text-sm"
            >
              <input type="hidden" name="subjectPersonIds" value={p.id} />
              <span className="font-medium text-foreground">{p.name}</span>
              {p.hint && <span className="text-subtle-foreground">{p.hint}</span>}
              {eligible.has(p.id) && (
                <label className="flex items-center gap-2 text-sm text-foreground-soft">
                  <Checkbox name="strikePersonIds" value={p.id} /> Request a strike
                </label>
              )}
              <button
                type="button"
                onClick={() => remove(p.id)}
                // eslint-disable-next-line no-restricted-syntax -- inline text-link remove action, not a full Button
                className="ml-auto text-xs text-subtle-foreground underline hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
