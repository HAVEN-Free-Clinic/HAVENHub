"use client";

import { useState } from "react";
import type { PersonFieldView } from "@/platform/email/audience/person-fields";
import type {
  Audience,
  AudienceCondition,
  AudienceGroup,
  AudienceNode,
  ConditionOp,
} from "@/platform/email/audience/types";
import { isAudienceGroup } from "@/platform/email/audience/types";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input, Textarea } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";

type Props = {
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  initial: Audience;
};

type FieldGroup = { name: string; fields: PersonFieldView[] };

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

// ---------------------------------------------------------------------------
// Match-mode toggle (ALL / ANY), shared by every group
// ---------------------------------------------------------------------------

function MatchToggle({ match, onChange }: { match: "ALL" | "ANY"; onChange: (m: "ALL" | "ANY") => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-foreground-soft">Match</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
        {/* eslint-disable-next-line no-restricted-syntax -- segmented match-mode toggle, active state applied inline */}
        <button type="button" aria-pressed={match === "ALL"} onClick={() => onChange("ALL")} className={`px-3 py-1.5 ${match === "ALL" ? "bg-brand text-white" : "bg-surface text-foreground-soft hover:bg-muted"}`}>
          ALL conditions
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- segmented match-mode toggle, active state applied inline */}
        <button type="button" aria-pressed={match === "ANY"} onClick={() => onChange("ANY")} className={`px-3 py-1.5 ${match === "ANY" ? "bg-brand text-white" : "bg-surface text-foreground-soft hover:bg-muted"}`}>
          ANY condition
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single leaf condition row
// ---------------------------------------------------------------------------

function ConditionRow({
  cond,
  fields,
  fieldGroups,
  departments,
  onChange,
  onRemove,
}: {
  cond: AudienceCondition;
  fields: PersonFieldView[];
  fieldGroups: FieldGroup[];
  departments: { code: string; name: string }[];
  onChange: (next: AudienceCondition) => void;
  onRemove: () => void;
}) {
  const def = fields.find((f) => f.key === cond.field) ?? fields[0];
  const options = def ? getFieldOptions(def, departments) : [];
  const selectedValues = Array.isArray(cond.value) ? cond.value : [];
  const textValue = typeof cond.value === "string" ? cond.value : "";

  function changeField(newFieldKey: string) {
    const nextDef = fields.find((f) => f.key === newFieldKey);
    if (nextDef) onChange(defaultConditionFor(nextDef));
  }

  function changeTextOp(op: ConditionOp) {
    if (VALUELESS_OPS.has(op)) return onChange({ ...cond, op, value: undefined });
    // "is any of" stores a multi-line paste; that format is incompatible with the
    // single-value operators, so clear it when switching away from "in".
    const carry = cond.op !== "in" && typeof cond.value === "string";
    onChange({ ...cond, op, value: carry ? cond.value : "" });
  }

  function toggleMultiValue(val: string) {
    const arr = Array.isArray(cond.value) ? cond.value : [];
    const next = arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
    onChange({ ...cond, op: "in", value: next });
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-muted p-3">
      <Select aria-label="Field" value={cond.field} onChange={(e) => changeField(e.target.value)} className="w-auto">
        {fieldGroups.map((g) => (
          <optgroup key={g.name} label={g.name}>
            {g.fields.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </optgroup>
        ))}
      </Select>

      {def?.kind === "text" && (
        <>
          <Select aria-label="Operator" value={cond.op} onChange={(e) => changeTextOp(e.target.value as ConditionOp)} className="w-auto">
            {def.operators.map((op) => (
              <option key={op} value={op}>{TEXT_OP_LABELS[op] ?? op}</option>
            ))}
          </Select>

          {cond.op === "in" ? (
            <Textarea aria-label="Value" value={textValue} onChange={(e) => onChange({ ...cond, value: e.target.value })} rows={2} placeholder="Paste values, one per line or comma-separated" className="min-w-[16rem] flex-1" />
          ) : !VALUELESS_OPS.has(cond.op) ? (
            <Input aria-label="Value" type="text" value={textValue} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder="Enter a value" className="min-w-[12rem] flex-1" />
          ) : null}
        </>
      )}

      {def?.kind === "enum" && (
        <Select aria-label="Value" value={typeof cond.value === "string" ? cond.value : ""} onChange={(e) => onChange({ ...cond, op: "eq", value: e.target.value })} className="w-auto">
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      )}

      {def?.kind === "multiEnum" && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={selectedValues.includes(o.value)} onChange={() => toggleMultiValue(o.value)} />
              {o.label}
            </label>
          ))}
          {options.length === 0 && (
            <span className="text-xs text-subtle-foreground italic">No options available</span>
          )}
        </div>
      )}

      {def?.kind === "boolean" && (
        <Select aria-label="Yes or no" value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as "isTrue" | "isFalse", value: undefined })} className="w-auto">
          <option value="isTrue">Yes</option>
          <option value="isFalse">No</option>
        </Select>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="ml-auto text-xs text-subtle-foreground hover:text-critical-foreground">
        Remove
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A group: its own ALL/ANY toggle over child conditions + nested groups
// ---------------------------------------------------------------------------

function GroupEditor({
  group,
  fields,
  fieldGroups,
  departments,
  onChange,
  onRemove,
  depth,
}: {
  group: AudienceGroup;
  fields: PersonFieldView[];
  fieldGroups: FieldGroup[];
  departments: { code: string; name: string }[];
  onChange: (next: AudienceGroup) => void;
  onRemove?: () => void;
  depth: number;
}) {
  function updateChild(i: number, child: AudienceNode) {
    onChange({ ...group, children: group.children.map((c, idx) => (idx === i ? child : c)) });
  }
  function removeChild(i: number) {
    onChange({ ...group, children: group.children.filter((_, idx) => idx !== i) });
  }
  function addCondition() {
    const first = fields[0];
    if (!first) return;
    onChange({ ...group, children: [...group.children, defaultConditionFor(first)] });
  }
  function addGroup() {
    onChange({ ...group, children: [...group.children, { match: "ALL", children: [] }] });
  }

  const nested = depth > 0;

  return (
    <div className={nested ? "rounded-xl border border-dashed border-border bg-surface/50 p-3" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MatchToggle match={group.match} onChange={(m) => onChange({ ...group, match: m })} />
        {nested && onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="text-xs text-subtle-foreground hover:text-critical-foreground">
            Remove group
          </Button>
        )}
      </div>

      {group.children.length === 0 && (
        <p className="mt-2 text-sm text-subtle-foreground italic">
          {nested ? "Empty group; it matches nobody until you add a condition." : "No conditions yet; this audience matches nobody. Add a condition to choose recipients."}
        </p>
      )}

      <div className="mt-2 space-y-2">
        {group.children.map((child, i) =>
          isAudienceGroup(child) ? (
            <GroupEditor
              key={i}
              group={child}
              fields={fields}
              fieldGroups={fieldGroups}
              departments={departments}
              onChange={(g) => updateChild(i, g)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
            />
          ) : (
            <ConditionRow
              key={i}
              cond={child}
              fields={fields}
              fieldGroups={fieldGroups}
              departments={departments}
              onChange={(c) => updateChild(i, c)}
              onRemove={() => removeChild(i)}
            />
          ),
        )}
      </div>

      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addCondition} className="border-dashed">
          + Add condition
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={addGroup} className="border-dashed">
          + Add group
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root builder
// ---------------------------------------------------------------------------

export function AudienceBuilder({ fields, departments, initial }: Props) {
  const [root, setRoot] = useState<AudienceGroup>({ match: initial.match, children: initial.conditions });

  const audience: Audience = { recordType: "PERSON", match: root.match, conditions: root.children };

  // Group fields for the selector while preserving order.
  const fieldGroups: FieldGroup[] = [];
  for (const f of fields) {
    const existing = fieldGroups.find((g) => g.name === f.group);
    if (existing) existing.fields.push(f);
    else fieldGroups.push({ name: f.group, fields: [f] });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground-soft">Audience</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose who receives this campaign. Add at least one condition; an empty audience matches nobody (a safeguard against an accidental send-all). Use groups to combine ALL/ANY logic, e.g. GROUP A (this and this) OR GROUP B (this or this).
        </p>
      </div>

      <GroupEditor
        group={root}
        fields={fields}
        fieldGroups={fieldGroups}
        departments={departments}
        onChange={setRoot}
        depth={0}
      />

      {/* Hidden serialized audience for form submission */}
      <input type="hidden" name="audience" value={JSON.stringify(audience)} />
    </div>
  );
}
