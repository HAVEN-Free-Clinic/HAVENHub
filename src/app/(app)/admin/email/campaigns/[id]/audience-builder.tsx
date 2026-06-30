"use client";

import { useState } from "react";
import type { PersonFieldView } from "@/platform/email/audience/person-fields";
import type { Audience, AudienceCondition, ConditionOp } from "@/platform/email/audience/types";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input, Textarea } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

type Props = {
  fields: PersonFieldView[];
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
  field: PersonFieldView,
  departments: { code: string; name: string }[],
): { value: string; label: string }[] {
  if (field.key === "department") {
    return departments.map((d) => ({ value: d.code, label: d.name }));
  }
  return field.options ?? [];
}

function defaultConditionFor(def: PersonFieldView): AudienceCondition {
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
  const groups: { name: string; fields: PersonFieldView[] }[] = [];
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
        // "is any of" stores a multi-line paste; that format is incompatible with
        // the single-value operators, so clear it when switching away from "in".
        const carry = c.op !== "in" && typeof c.value === "string";
        return { ...c, op, value: carry ? c.value : "" };
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
        <label className="block text-sm font-medium text-foreground-soft">Audience</label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose who receives this campaign. Add at least one condition; an empty audience matches nobody (a safeguard against an accidental send-all).
        </p>
      </div>

      {/* Match mode */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-foreground-soft">Match</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
          <button
            type="button"
            onClick={() => setMatch("ALL")}
            className={`px-3 py-1.5 ${match === "ALL" ? "bg-brand text-white" : "bg-surface text-foreground-soft hover:bg-muted"}`}
          >
            ALL conditions
          </button>
          <button
            type="button"
            onClick={() => setMatch("ANY")}
            className={`px-3 py-1.5 ${match === "ANY" ? "bg-brand text-white" : "bg-surface text-foreground-soft hover:bg-muted"}`}
          >
            ANY condition
          </button>
        </div>
      </div>

      {/* Condition rows */}
      {conditions.length === 0 && (
        <p className="text-sm text-subtle-foreground italic">
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
              className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-muted p-3"
            >
              {/* Field selector, grouped */}
              <Select
                value={cond.field}
                onChange={(e) => changeField(idx, e.target.value)}
                className="w-auto"
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
              </Select>

              {/* Text fields: operator dropdown + adaptive value control */}
              {def?.kind === "text" && (
                <>
                  <Select
                    value={cond.op}
                    onChange={(e) => changeTextOp(idx, e.target.value as ConditionOp)}
                    className="w-auto"
                  >
                    {def.operators.map((op) => (
                      <option key={op} value={op}>
                        {TEXT_OP_LABELS[op] ?? op}
                      </option>
                    ))}
                  </Select>

                  {cond.op === "in" ? (
                    <Textarea
                      value={textValue}
                      onChange={(e) => changeTextValue(idx, e.target.value)}
                      rows={2}
                      placeholder="Paste values, one per line or comma-separated"
                      className="min-w-[16rem] flex-1"
                    />
                  ) : !VALUELESS_OPS.has(cond.op) ? (
                    <Input
                      type="text"
                      value={textValue}
                      onChange={(e) => changeTextValue(idx, e.target.value)}
                      placeholder="Enter a value"
                      className="min-w-[12rem] flex-1"
                    />
                  ) : null}
                </>
              )}

              {/* Enum value */}
              {def?.kind === "enum" && (
                <Select
                  value={typeof cond.value === "string" ? cond.value : ""}
                  onChange={(e) => changeEnumValue(idx, e.target.value)}
                  className="w-auto"
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}

              {/* MultiEnum checkboxes */}
              {def?.kind === "multiEnum" && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {options.map((o) => (
                    <label key={o.value} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={selectedValues.includes(o.value)}
                        onChange={() => toggleMultiValue(idx, o.value)}
                      />
                      {o.label}
                    </label>
                  ))}
                  {options.length === 0 && (
                    <span className="text-xs text-subtle-foreground italic">No options available</span>
                  )}
                </div>
              )}

              {/* Boolean yes/no */}
              {def?.kind === "boolean" && (
                <Select
                  value={cond.op}
                  onChange={(e) => changeBooleanOp(idx, e.target.value as "isTrue" | "isFalse")}
                  className="w-auto"
                >
                  <option value="isTrue">Yes</option>
                  <option value="isFalse">No</option>
                </Select>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeCondition(idx)}
                className="ml-auto text-xs text-subtle-foreground hover:text-critical"
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addCondition}
        className="border-dashed"
      >
        + Add condition
      </Button>

      {/* Hidden serialized audience for form submission */}
      <input type="hidden" name="audience" value={JSON.stringify(audience)} />
    </div>
  );
}
