"use client";

/**
 * EpicPersonPicker: pick one or more active people to attach an Epic request to.
 * A department Select scopes a checkbox list; selections persist across
 * department switches and render as removable chips. Selected ids are emitted
 * as hidden inputs named "personIds" for the enclosing server-action form.
 *
 * `quickAdd` (optional) pre-lists the ticket requester as a one-click add.
 */
import { useMemo, useState } from "react";
import type { DepartmentWithMembers, MemberLite } from "@/modules/support/services/itcm";
import { Select } from "@/platform/ui/select";
import { Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";

type QuickAdd = { id: string; name: string | null };

export function EpicPersonPicker({
  departments,
  quickAdd,
}: {
  departments: DepartmentWithMembers[];
  quickAdd?: QuickAdd;
}) {
  const [deptId, setDeptId] = useState<string>("");
  const [selected, setSelected] = useState<Map<string, string>>(() =>
    quickAdd ? new Map([[quickAdd.id, quickAdd.name ?? "Requester"]]) : new Map()
  );

  const dept = useMemo(
    () => departments.find((d) => d.department.id === deptId),
    [departments, deptId]
  );
  const members: MemberLite[] = useMemo(
    () => (dept ? [...dept.directors, ...dept.volunteers] : []),
    [dept]
  );

  function toggle(id: string, name: string | null) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, name ?? "Unknown");
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {quickAdd && !selected.has(quickAdd.id) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => toggle(quickAdd.id, quickAdd.name)}
        >
          + Add requester ({quickAdd.name ?? "requester"})
        </Button>
      )}

      <Field label="Department">
        <Select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
          <option value="">Select a department…</option>
          {departments.map((d) => (
            <option key={d.department.id} value={d.department.id}>
              {d.department.name}
            </option>
          ))}
        </Select>
      </Field>

      {members.length > 0 && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected.has(m.id)} onChange={() => toggle(m.id, m.name)} />
              <span>{m.name}</span>
              {m.epicId && <span className="text-subtle-foreground text-xs">{m.epicId}</span>}
            </label>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap gap-2">
          {[...selected.entries()].map(([id, name]) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => toggle(id, name)}
                // eslint-disable-next-line no-restricted-syntax -- icon-only chip-remove glyph, not a labeled Button
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {[...selected.keys()].map((id) => (
        <input key={id} type="hidden" name="personIds" value={id} />
      ))}
    </div>
  );
}
