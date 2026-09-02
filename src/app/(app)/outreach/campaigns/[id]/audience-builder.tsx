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
import { isAudienceGroup, isNegativeOp, VALUELESS_OPS } from "@/platform/email/audience/types";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Input, Textarea } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { FieldPicker } from "./field-picker";

export type NamedOption = { id: string; label: string };

type Props = {
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  terms: NamedOption[];
  cycles: NamedOption[];
  subcommittees: NamedOption[];
  initial: Audience;
};

const OP_LABELS: Record<ConditionOp, string> = {
  contains: "contains",
  notContains: "does not contain",
  eq: "is",
  notEq: "is not",
  startsWith: "starts with",
  endsWith: "ends with",
  in: "is any of",
  notIn: "is none of",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  isTrue: "yes",
  isFalse: "no",
  lt: "is before",
  gt: "is after",
  // Date operators, used by every dateField/relationDateField in
  // person-fields.ts (joinedAt, hipaaCompletedAt, ehsCompletedAt, etc.).
  before: "is before",
  after: "is after",
  onOrBefore: "is on or before",
  onOrAfter: "is on or after",
  between: "is between",
  withinNextDays: "is within the next (days)",
  withinLastDays: "is within the last (days)",
  // Count operators, used by every countField in person-fields.ts
  // (shiftCountThisTerm, attendanceCountThisTerm, etc.).
  lte: "is at most",
  gte: "is at least",
};

/** Operators whose value is a checkbox selection rather than typed text. */
const SET_OPS = new Set<ConditionOp>(["in", "notIn"]);

const VALUELESS = new Set<ConditionOp>(VALUELESS_OPS);

export function getFieldOptions(
  field: PersonFieldView,
  departments: { code: string; name: string }[],
  cycles: NamedOption[],
  subcommittees: NamedOption[],
): { value: string; label: string }[] {
  if (field.key === "department") {
    return departments.map((d) => ({ value: d.code, label: d.name }));
  }
  // acceptedInCycle names the same recruitment cycles appliedToCycle does (see
  // AudienceCtx.acceptedByCycle in person-fields.ts), so it maps to the exact
  // same `cycles` source.
  if (field.key === "appliedToCycle" || field.key === "acceptedInCycle") {
    return cycles.map((c) => ({ value: c.id, label: c.label }));
  }
  if (field.key === "subcommittee") {
    return subcommittees.map((s) => ({ value: s.id, label: s.label }));
  }
  return field.options ?? [];
}

export function defaultConditionFor(def: PersonFieldView): AudienceCondition {
  if (def.kind === "boolean") return { field: def.key, op: "isTrue" };
  if (def.kind === "multiEnum") return { field: def.key, op: "in", value: [] };
  if (def.kind === "text") return { field: def.key, op: "contains", value: "" };
  // YEAR_OPERATORS does not include "contains" (gradYear is an ordered
  // comparison over a 4-digit string, not free text -- see yearWhere in
  // operators.ts). This used to be lumped in with "text" above, which handed
  // personFieldWhere's operator gate an operator gradYear never declares --
  // the exact same MATCH_NOBODY-under-NONE hazard the date/count branches
  // below exist to avoid. "eq" is YEAR_OPERATORS' first real member.
  if (def.kind === "year") return { field: def.key, op: "eq", value: "" };
  // A date field's own operators never include "eq" (see DATE_OPERATORS in
  // operators.ts), so falling through to the enum-shaped default below would
  // hand personFieldWhere's operator gate an operator the field does not
  // declare -- MATCH_NOBODY, which is safe under ALL/ANY but, inside a NONE
  // group, silently widens to every Person in the table (see compileGroup).
  // onOrAfter is a real, always-declared operator for every date field.
  if (def.kind === "date") return { field: def.key, op: "onOrAfter", value: "" };
  // Count fields' operators (NUMBER_OPERATORS) do include "eq", so falling
  // through below is not the same operator-gate hazard as date -- but a count
  // field has no `options`, so the fallback's `def.options?.[0]?.value ?? ""`
  // always lands on a blank "eq" comparison, which reads as "shifts attended
  // equals (nothing)". "gte" with a blank value is the same blank-condition
  // state (still MATCH_NOBODY until filled in) but is the more sensible
  // starting point for a numeric field, and keeps every field kind resolved by
  // its own explicit branch rather than the enum-shaped catch-all below.
  if (def.kind === "count") return { field: def.key, op: "gte", value: "" };
  return { field: def.key, op: "eq", value: def.options?.[0]?.value ?? "" };
}

/**
 * Values do not survive an operator change intact: a checkbox selection is a
 * string[], a pasted list is one newline-joined string, and a single value is a
 * bare string. Carrying the wrong shape across produces a condition that looks
 * filled in but compiles to match-nobody, which is confusing rather than unsafe.
 */
function valueForOp(cond: AudienceCondition, nextOp: ConditionOp): AudienceCondition["value"] {
  if (VALUELESS.has(nextOp)) return undefined;
  const wasSet = SET_OPS.has(cond.op);
  const isSet = SET_OPS.has(nextOp);
  if (wasSet === isSet) return cond.value;
  return isSet ? [] : "";
}

// ---------------------------------------------------------------------------
// Match-mode toggle, shared by every group
// ---------------------------------------------------------------------------

const MATCH_MODES = [
  { value: "ALL", label: "ALL conditions" },
  { value: "ANY", label: "ANY condition" },
  { value: "NONE", label: "NONE of these" },
] as const;

function MatchToggle({
  match,
  onChange,
  allowNone,
}: {
  match: AudienceGroup["match"];
  onChange: (m: AudienceGroup["match"]) => void;
  allowNone: boolean;
}) {
  // NONE is offered on nested groups only. At the root it would read "everyone
  // except ...", which is a send-all wearing a disguise.
  const modes = MATCH_MODES.filter((m) => m.value !== "NONE" || allowNone);
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-foreground-soft">Match</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
        {modes.map((m) => {
          const active = match === m.value;
          return (
            /* eslint-disable-next-line no-restricted-syntax -- segmented match-mode toggle, active state applied inline */
            <button key={m.value} type="button" aria-pressed={active} onClick={() => onChange(m.value)} className={`px-3 py-1.5 ${active ? "bg-brand text-white" : "bg-surface text-foreground-soft hover:bg-muted"}`}>
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Term scope, for roster-shaped fields
// ---------------------------------------------------------------------------

function TermScopePicker({
  cond,
  terms,
  onChange,
}: {
  cond: AudienceCondition;
  terms: NamedOption[];
  onChange: (next: AudienceCondition) => void;
}) {
  const selected = cond.terms ?? [];

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((t) => t !== id) : [...selected, id];
    // Store no key at all rather than an empty array, so an audience that never
    // touched the picker serialises exactly as it did before term scoping.
    onChange({ ...cond, terms: next.length > 0 ? next : undefined });
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2">
      <span className="text-xs font-medium text-foreground-soft">Terms</span>
      {terms.map((t) => (
        <label key={t.id} className="flex items-center gap-1.5 text-xs">
          <Checkbox checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
          {t.label}
        </label>
      ))}
      {selected.length === 0 && (
        <span className="text-xs text-subtle-foreground italic">
          None selected: uses the current term
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single leaf condition row
// ---------------------------------------------------------------------------

function ConditionRow({
  cond,
  fields,
  departments,
  terms,
  cycles,
  subcommittees,
  onChange,
  onRemove,
}: {
  cond: AudienceCondition;
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  terms: NamedOption[];
  cycles: NamedOption[];
  subcommittees: NamedOption[];
  onChange: (next: AudienceCondition) => void;
  onRemove: () => void;
}) {
  const def = fields.find((f) => f.key === cond.field) ?? fields[0];
  const options = def ? getFieldOptions(def, departments, cycles, subcommittees) : [];
  const selectedValues = Array.isArray(cond.value) ? cond.value : [];
  const textValue = typeof cond.value === "string" ? cond.value : "";

  function changeField(newFieldKey: string) {
    // Deliberately NOT `?? fields[0]`: FieldPicker only ever calls onChange
    // with a key drawn from its own `fields` list (see its `choose`), so
    // `newFieldKey` should always resolve. An unresolvable key here is a
    // wiring bug, not user input -- FieldPicker's "remove unknown field"
    // control goes through `onRemove` below instead of `onChange`, precisely
    // so it never reaches this function at all. Silently defaulting to an
    // arbitrary field would hide that bug behind a condition that LOOKS
    // deliberately configured; doing nothing at least fails visibly inert.
    const nextDef = fields.find((f) => f.key === newFieldKey);
    if (nextDef) onChange(defaultConditionFor(nextDef));
  }

  function changeOp(op: ConditionOp) {
    onChange({ ...cond, op, value: valueForOp(cond, op) });
  }

  function toggleMultiValue(val: string) {
    const arr = Array.isArray(cond.value) ? cond.value : [];
    const next = arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
    onChange({ ...cond, value: next });
  }

  const isBoolean = def?.kind === "boolean";
  const usesCheckboxes = def && (def.kind === "multiEnum" || (def.kind === "enum" && SET_OPS.has(cond.op)));

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-muted p-3">
      <FieldPicker fields={fields} value={cond.field} onChange={changeField} onRemove={onRemove} />

      {/* The operator select doubles as the value control for booleans, whose
          two operators (yes / no) ARE the value. */}
      {def && (
        <Select
          aria-label={isBoolean ? "Yes or no" : "Operator"}
          value={cond.op}
          onChange={(e) => changeOp(e.target.value as ConditionOp)}
          className="w-auto"
        >
          {def.operators.map((op) => (
            <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>
          ))}
        </Select>
      )}

      {/* Value control */}
      {!isBoolean && !VALUELESS.has(cond.op) && (
        usesCheckboxes ? (
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
        ) : def?.kind === "enum" ? (
          <Select
            aria-label="Value"
            value={textValue}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            className="w-auto"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        ) : SET_OPS.has(cond.op) ? (
          <Textarea
            aria-label="Value"
            value={textValue}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            rows={2}
            placeholder="Paste values, one per line or comma-separated"
            className="min-w-[16rem] flex-1"
          />
        ) : (
          <Input
            aria-label="Value"
            type="text"
            value={textValue}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            placeholder={def?.kind === "year" ? "e.g. 2026" : "Enter a value"}
            className="min-w-[12rem] flex-1"
          />
        )
      )}

      <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="ml-auto text-xs text-subtle-foreground hover:text-critical-foreground">
        Remove
      </Button>

      {def?.termScoped && <TermScopePicker cond={cond} terms={terms} onChange={onChange} />}

      {isNegativeOp(cond.op) && (
        <p className="w-full text-xs text-muted-foreground">
          Negative conditions widen the audience. Preview the recipient list before sending.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A group: its own match toggle over child conditions + nested groups
// ---------------------------------------------------------------------------

function GroupEditor({
  group,
  fields,
  departments,
  terms,
  cycles,
  subcommittees,
  onChange,
  onRemove,
  depth,
}: {
  group: AudienceGroup;
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  terms: NamedOption[];
  cycles: NamedOption[];
  subcommittees: NamedOption[];
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
        <MatchToggle
          match={group.match}
          onChange={(m) => onChange({ ...group, match: m })}
          allowNone={nested}
        />
        {nested && onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="text-xs text-subtle-foreground hover:text-critical-foreground">
            Remove group
          </Button>
        )}
      </div>

      {group.match === "NONE" && group.children.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Everyone matching any condition in this group is excluded from the audience.
        </p>
      )}

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
              departments={departments}
              terms={terms}
              cycles={cycles}
              subcommittees={subcommittees}
              onChange={(g) => updateChild(i, g)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
            />
          ) : (
            <ConditionRow
              key={i}
              cond={child}
              fields={fields}
              departments={departments}
              terms={terms}
              cycles={cycles}
              subcommittees={subcommittees}
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

export function AudienceBuilder({ fields, departments, terms, cycles, subcommittees, initial }: Props) {
  const [root, setRoot] = useState<AudienceGroup>({ match: initial.match, children: initial.conditions });

  // The root connective is narrowed back to ALL/ANY: MatchToggle never offers
  // NONE at depth 0, and Audience.match does not admit it.
  const rootMatch: Audience["match"] = root.match === "NONE" ? "ALL" : root.match;
  const audience: Audience = { recordType: "PERSON", match: rootMatch, conditions: root.children };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground-soft">Audience</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose who receives this campaign. Add at least one condition; an empty audience matches nobody (a safeguard against an accidental send-all). Use groups to combine ALL/ANY logic, e.g. GROUP A (this and this) OR GROUP B (this or this), and a NONE group to exclude a cohort. Roster conditions apply to the current term unless you pick terms.
        </p>
      </div>

      <GroupEditor
        group={root}
        fields={fields}
        departments={departments}
        terms={terms}
        cycles={cycles}
        subcommittees={subcommittees}
        onChange={setRoot}
        depth={0}
      />

      {/* Hidden serialized audience for form submission */}
      <input type="hidden" name="audience" value={JSON.stringify(audience)} />
    </div>
  );
}
