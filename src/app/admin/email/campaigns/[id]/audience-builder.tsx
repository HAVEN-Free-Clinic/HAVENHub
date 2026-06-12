"use client";

import { useState } from "react";
import type { PersonFieldDef } from "@/platform/email/audience/person-fields";
import type { Audience, AudienceCondition, ConditionOp } from "@/platform/email/audience/types";

type Props = {
  fields: PersonFieldDef[];
  departments: { code: string; name: string }[];
  initial: Audience;
};

const TEXT_OP_LABELS: Record<string, string> = {
  contains: "contains",
  eq: "is exactly",
  startsWith: "starts with",
  endsWith: "ends with",
  in: "is any of",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

// Operators where no value control is shown.
const VALUELESS_OPS = new Set<ConditionOp>(["isEmpty", "isNotEmpty", "isTrue", "isFalse"]);

function getFieldOptions(
  field: PersonFieldDef,
  departments: { code: string; name: string }[],
): { value: string; label: string }[] {
  if (field.key === "department") {
    return departments.map((d) => ({ value: d.code, label: d.name }));
  }
  return field.options ?? [];
}

function defaultConditionFor(def: PersonFieldDef): AudienceCondition {
  if (def.kind === "boolean") return { field: def.key, op: "isTrue" };
  if (def.kind === "multiEnum") return { field: def.key, op: "in", value: [] };
  if (def.kind === "text") return { field: def.key, op: "contains", value: "" };
  return { field: def.key, op: "eq", value: def.options?.[0]?.value ?? "" };
}

export function AudienceBuilder({ fields, departments, initial }: Props) {
  const [match, setMatch] = useState<"ALL" | "ANY">(initial.match);
  const [conditions, setConditions] = useState<AudienceCondition[]>(initial.conditions);

  const audience: Audience = { recordType: "PERSON", match, conditions };

  // Group fields for the selector while preserving order.
  const groups: { name: string; fields: PersonFieldDef[] }[] = [];
  for (const f of fields) {
    const existing = groups.find((g) => g.name === f.group);
    if (existing) existing.fields.push(f);
    else groups.push({ name: f.group, fields: [f] });
  }

  function addCondition() {
    const first = fields[0];
    if (!first) return;
    setConditions((prev) => [...prev, defaultConditionFor(first)]);
  }

  function removeCondition(idx: number) {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }

  function changeField(idx: number, newFieldKey: string) {
    const def = fields.find((f) => f.key === newFieldKey);
    if (!def) return;
    setConditions((prev) => prev.map((c, i) => (i === idx ? defaultConditionFor(def) : c)));
  }

  function changeEnumValue(idx: number, value: string) {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, op: "eq" as const, value } : c)));
  }

  function changeBooleanOp(idx: number, op: "isTrue" | "isFalse") {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, op, value: undefined } : c)));
  }

  function changeTextOp(idx: number, op: ConditionOp) {
    setConditions((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        if (VALUELESS_OPS.has(op)) return { ...c, op, value: undefined };
        return { ...c, op, value: typeof c.value === "string" ? c.value : "" };
      }),
    );
  }

  function changeTextValue(idx: number, value: string) {
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, value } : c)));
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
          Choose who receives this campaign. Add at least one condition; an empty audience matches nobody (a safeguard against an accidental send-all).
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
          No conditions yet; this audience matches nobody. Add a condition to choose recipients.
        </p>
      )}

      <div className="space-y-2">
        {conditions.map((cond, idx) => {
          const def = fields.find((f) => f.key === cond.field) ?? fields[0];
          const options = def ? getFieldOptions(def, departments) : [];
          const selectedValues = Array.isArray(cond.value) ? cond.value : [];
          const textValue = typeof cond.value === "string" ? cond.value : "";

          return (
            <div
              key={idx}
              className="flex flex-wrap items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
            >
              {/* Field selector, grouped */}
              <select
                value={cond.field}
                onChange={(e) => changeField(idx, e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
              >
                {groups.map((g) => (
                  <optgroup key={g.name} label={g.name}>
                    {g.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              {/* Text fields: operator dropdown + adaptive value control */}
              {def?.kind === "text" && (
                <>
                  <select
                    value={cond.op}
                    onChange={(e) => changeTextOp(idx, e.target.value as ConditionOp)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                  >
                    {def.operators.map((op) => (
                      <option key={op} value={op}>
                        {TEXT_OP_LABELS[op] ?? op}
                      </option>
                    ))}
                  </select>

                  {cond.op === "in" ? (
                    <textarea
                      value={textValue}
                      onChange={(e) => changeTextValue(idx, e.target.value)}
                      rows={2}
                      placeholder="Paste values, one per line or comma-separated"
                      className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                    />
                  ) : !VALUELESS_OPS.has(cond.op) ? (
                    <input
                      type="text"
                      value={textValue}
                      onChange={(e) => changeTextValue(idx, e.target.value)}
                      placeholder="Enter a value"
                      className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/15"
                    />
                  ) : null}
                </>
              )}

              {/* Enum value */}
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

              {/* MultiEnum checkboxes */}
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

              {/* Boolean yes/no */}
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
