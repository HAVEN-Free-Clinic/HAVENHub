"use client";

import { useState } from "react";
import type { PersonFieldDef } from "@/platform/email/audience/person-fields";
import type { Audience, AudienceCondition } from "@/platform/email/audience/types";

type Props = {
  fields: PersonFieldDef[];
  departments: { code: string; name: string }[];
  initial: Audience;
};

function getFieldOptions(
  field: PersonFieldDef,
  departments: { code: string; name: string }[],
): { value: string; label: string }[] {
  if (field.key === "department") {
    return departments.map((d) => ({ value: d.code, label: d.name }));
  }
  return field.options ?? [];
}

export function AudienceBuilder({ fields, departments, initial }: Props) {
  const [match, setMatch] = useState<"ALL" | "ANY">(initial.match);
  const [conditions, setConditions] = useState<AudienceCondition[]>(initial.conditions);

  const audience: Audience = { recordType: "PERSON", match, conditions };

  function addCondition() {
    const first = fields[0];
    if (!first) return;
    const newCond: AudienceCondition =
      first.kind === "boolean"
        ? { field: first.key, op: "isTrue" }
        : first.kind === "multiEnum"
          ? { field: first.key, op: "in", value: [] }
          : { field: first.key, op: "eq", value: first.options?.[0]?.value ?? "" };
    setConditions((prev) => [...prev, newCond]);
  }

  function removeCondition(idx: number) {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  function changeField(idx: number, newFieldKey: string) {
    const def = fields.find((f) => f.key === newFieldKey);
    if (!def) return;
    let newCond: AudienceCondition;
    if (def.kind === "boolean") {
      newCond = { field: def.key, op: "isTrue" };
    } else if (def.kind === "multiEnum") {
      newCond = { field: def.key, op: "in", value: [] };
    } else {
      newCond = { field: def.key, op: "eq", value: def.options?.[0]?.value ?? "" };
    }
    setConditions((prev) => prev.map((c, i) => (i === idx ? newCond : c)));
  }

  function changeEnumValue(idx: number, value: string) {
    setConditions((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, op: "eq" as const, value } : c)),
    );
  }

  function changeBooleanOp(idx: number, op: "isTrue" | "isFalse") {
    setConditions((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, op, value: undefined } : c)),
    );
  }

  function toggleMultiValue(idx: number, val: string) {
    setConditions((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        const arr = Array.isArray(c.value) ? c.value : [];
        const next = arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
        return { ...c, op: "in" as const, value: next };
      }),
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700">Audience</label>
        <p className="mt-0.5 text-xs text-slate-500">
          Choose who receives this campaign. Add at least one condition &mdash; an empty audience matches nobody (a safeguard against an accidental send-all).
        </p>
      </div>

      {/* Match mode */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-700">Match</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 text-xs">
          <button
            type="button"
            onClick={() => setMatch("ALL")}
            className={`px-3 py-1.5 ${match === "ALL" ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            ALL conditions
          </button>
          <button
            type="button"
            onClick={() => setMatch("ANY")}
            className={`px-3 py-1.5 ${match === "ANY" ? "bg-brand text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            ANY condition
          </button>
        </div>
      </div>

      {/* Condition rows */}
      {conditions.length === 0 && (
        <p className="text-sm text-slate-400 italic">
          No conditions yet &mdash; this audience matches nobody. Add a condition to choose recipients.
        </p>
      )}

      <div className="space-y-2">
        {conditions.map((cond, idx) => {
          const def = fields.find((f) => f.key === cond.field) ?? fields[0];
          const options = def ? getFieldOptions(def, departments) : [];
          const selectedValues = Array.isArray(cond.value) ? cond.value : [];

          return (
            <div
              key={idx}
              className="flex flex-wrap items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
            >
              {/* Field selector */}
              <select
                value={cond.field}
                onChange={(e) => changeField(idx, e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
              >
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>

              {/* Value control based on kind */}
              {def?.kind === "enum" && (
                <select
                  value={typeof cond.value === "string" ? cond.value : ""}
                  onChange={(e) => changeEnumValue(idx, e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}

              {def?.kind === "multiEnum" && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {options.map((o) => (
                    <label key={o.value} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedValues.includes(o.value)}
                        onChange={() => toggleMultiValue(idx, o.value)}
                        className="rounded-lg"
                      />
                      {o.label}
                    </label>
                  ))}
                  {options.length === 0 && (
                    <span className="text-xs text-slate-400 italic">No options available</span>
                  )}
                </div>
              )}

              {def?.kind === "boolean" && (
                <select
                  value={cond.op}
                  onChange={(e) => changeBooleanOp(idx, e.target.value as "isTrue" | "isFalse")}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                >
                  <option value="isTrue">Yes</option>
                  <option value="isFalse">No</option>
                </select>
              )}

              <button
                type="button"
                onClick={() => removeCondition(idx)}
                className="ml-auto text-xs text-slate-400 hover:text-critical"
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addCondition}
        className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:border-slate-400 hover:text-slate-800"
      >
        + Add condition
      </button>

      {/* Hidden serialized audience for form submission */}
      <input type="hidden" name="audience" value={JSON.stringify(audience)} />
    </div>
  );
}
