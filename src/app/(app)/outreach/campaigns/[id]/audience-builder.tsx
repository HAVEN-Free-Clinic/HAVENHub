"use client";

import { useState } from "react";
import type { PersonFieldKind, PersonFieldView } from "@/platform/email/audience/person-fields";
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
import { ValueControl } from "./value-controls";
import { useNodeCounts, type NodeCounts } from "./use-node-counts";

export type NamedOption = { id: string; label: string };

/**
 * The whole tree's count key, distinct from any index-derived child path.
 *
 * Redeclared here rather than imported from audience/resolve.ts, which is a
 * server module reaching straight into prisma: importing it would drag the
 * whole query layer into the client bundle. Both sides' tests pin the literal
 * keys ("root", "0", "1.0"), so a drift between the two shows up as a failing
 * assertion rather than as counts silently landing on the wrong rows.
 */
const ROOT_NODE_PATH = "root";

/**
 * The key a node's count is returned under, mirroring enumerateNodes in
 * audience/resolve.ts. Root-level children are "0", "1"; a child of the node at
 * "1" is "1.0". Both sides derive the key from the same positional indices,
 * which is what lets one server round trip address every row on the client.
 */
function childNodePath(parentPath: string, index: number): string {
  return parentPath === ROOT_NODE_PATH ? String(index) : `${parentPath}.${index}`;
}

/**
 * A node's own match count, shown beside the clause that produced it.
 *
 * The wording is deliberate. A count says what the clause MATCHES on its own,
 * never what it contributes: inside an ALL group a condition narrows, and a
 * NONE group is a filter whose own fragment ("everyone matching none of these")
 * routinely matches more people than the audience it sits inside. Reporting
 * that number is the point -- three send-all bugs on this branch came from a
 * NONE group silently inverting to match everybody, and this is the first thing
 * that makes the widening visible -- but a bare "812" beside a NONE group would
 * read as "adding 812 people", so that one case spells out what it counted.
 *
 * While a fresh count is in flight the previous number stays put, dimmed, so
 * the tree does not flicker on every keystroke and no row ever briefly reads as
 * matching nobody.
 */
function NodeCount({
  path,
  counts,
  stale,
  match,
}: {
  path: string;
  counts: NodeCounts;
  stale: boolean;
  match?: AudienceGroup["match"];
}) {
  const count = counts[path];
  if (count === undefined) return null;
  return (
    <span
      data-node-count={path}
      data-stale={String(stale)}
      className={`text-xs tabular-nums ${stale ? "text-subtle-foreground/60" : "text-subtle-foreground"}`}
    >
      Matches {count} {count === 1 ? "person" : "people"}
      {match === "NONE" ? " (everyone matching none of these)" : ""}
    </span>
  );
}

type Props = {
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  terms: NamedOption[];
  cycles: NamedOption[];
  subcommittees: NamedOption[];
  initial: Audience;
  /**
   * The clinic's display zone in words, e.g. "Eastern (New York)". Shown beside
   * every absolute date control, because a calendar day in a condition is
   * resolved in THAT zone (see dateWhere in operators.ts) and not in the
   * sender's. Supplied by loadAudienceBuilderOptions so both call sites, the
   * campaign editor and the scope editor, get it from one place.
   */
  zoneLabel: string;
  /**
   * Counts the tree currently being edited, one entry per node path.
   *
   * Optional because the scope editor renders this same builder with no
   * campaign behind it, and there is nothing to count an unsaved SCOPE against:
   * a scope IS the boundary, so it has none of its own. Left out, no counts
   * render at all and no request is ever made.
   */
  countAction?: (audience: Audience) => Promise<NodeCounts>;
};

/**
 * The default reading of each operator, used when a field's kind has nothing
 * more specific to say. These have to be true for EVERY kind that declares the
 * operator, so `lt`/`gt` are the neutral numeric wording: an ordered comparison
 * is what they always mean, and a kind that wants a sharper reading overrides
 * it below.
 */
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
  lt: "is less than",
  gt: "is greater than",
  lte: "is at most",
  gte: "is at least",
  // Date operators, used by every dateField/relationDateField in
  // person-fields.ts (joinedAt, hipaaCompletedAt, ehsCompletedAt, etc.).
  before: "is before",
  after: "is after",
  onOrBefore: "is on or before",
  onOrAfter: "is on or after",
  between: "is between",
  // The unit is not in the label because the control renders a "days" suffix
  // next to the number input (see value-controls.tsx).
  withinNextDays: "is within the next",
  withinLastDays: "is within the last",
};

/**
 * Per-kind overrides, for the operators whose neutral reading is not the right
 * one for a particular kind of field.
 *
 * The bug this exists to close: labels were keyed by OPERATOR ALONE, so `lt`
 * and `gt` read "is before" and "is after" for every kind that declares them.
 * DATE_OPERATORS contains neither (dates use before/after), so those two labels
 * were consumed only by `year` and `count` fields, and a count condition
 * rendered as "Shifts assigned this term is before 3", which describes a
 * comparison the condition is not making.
 *
 * Renaming the shared label alone would have moved the problem to `year`, where
 * the chronological reading is the correct one. So the neutral numeric wording
 * is the shared default (never WRONG for any kind, just less idiomatic for a
 * year) and `year` overrides it here. The shared table stays the fallback, so
 * an operator with no kind-specific entry still renders words.
 *
 * Every operator every kind declares (TEXT_OPERATORS, ENUM_OPERATORS,
 * MULTI_ENUM_OPERATORS, YEAR_OPERATORS, BOOLEAN_OPERATORS, NUMBER_OPERATORS and
 * DATE_OPERATORS in operators.ts) was read against the shared table; `lt` and
 * `gt` on a year are the only pair that needed a kind-specific reading. The two
 * relative-window labels were reworded in the shared table instead, since they
 * belong to `date` alone and no other kind declares them.
 */
const KIND_OP_LABELS: Partial<Record<PersonFieldKind, Partial<Record<ConditionOp, string>>>> = {
  // gradYear is a point in time held in a String column, so its ordered
  // comparison really is chronological.
  year: { lt: "is before", gt: "is after" },
};

/** The words shown for `op` on a field of `kind`. Exported for its own test. */
export function opLabel(kind: PersonFieldKind | undefined, op: ConditionOp): string {
  const specific = kind ? KIND_OP_LABELS[kind]?.[op] : undefined;
  return specific ?? OP_LABELS[op] ?? op;
}

/** Operators whose value is a checkbox selection rather than typed text. */
const SET_OPS = new Set<ConditionOp>(["in", "notIn"]);

/** Operators whose value is a whole number of days, not a calendar day. */
const WINDOW_OPS = new Set<ConditionOp>(["withinNextDays", "withinLastDays"]);

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
 * What an operator's value looks like, which is what decides whether a value
 * can survive an operator change.
 *
 * `pair` and `days` were folded in for the date and count controls. Before
 * them, `between` counted as "single", so switching a date `between` to
 * `before` left the two-element ARRAY in place: a condition that renders with
 * an empty date box while the stored audience still holds `["2026-03-18",
 * "2026-03-20"]`, and compiles to match-nobody. `days` is separate from
 * `single` for the same reason in the other direction: "30" is a whole number
 * of days, and carrying it into an absolute date operator puts it in a date
 * input, which renders blank while the saved JSON still says "30".
 */
type ValueArity = "none" | "single" | "days" | "pair" | "set";

function valueArity(op: ConditionOp): ValueArity {
  if (VALUELESS.has(op)) return "none";
  if (SET_OPS.has(op)) return "set";
  if (WINDOW_OPS.has(op)) return "days";
  if (op === "between") return "pair";
  return "single";
}

/**
 * Values do not survive an operator change intact: a checkbox selection is a
 * string[], a pasted list is one newline-joined string, a range is a
 * two-element array, and a single value is a bare string. Carrying the wrong
 * shape across produces a condition that looks filled in but compiles to
 * match-nobody, which is confusing rather than unsafe.
 *
 * The one value that IS carried across a shape change is a range endpoint,
 * because there the meaning survives: the start of "between the 18th and the
 * 20th" is a sensible "before the 18th", and a sender narrowing a range to a
 * single boundary should not have to retype the day they already picked. Every
 * other transition resets, since nothing about the old text means anything in
 * the new shape.
 */
function valueForOp(cond: AudienceCondition, nextOp: ConditionOp): AudienceCondition["value"] {
  const from = valueArity(cond.op);
  const to = valueArity(nextOp);
  if (to === "none") return undefined;
  if (from === to) return cond.value;
  if (to === "set") return [];
  if (to === "pair") {
    return from === "single" && typeof cond.value === "string" ? [cond.value, ""] : ["", ""];
  }
  if (to === "single" && from === "pair") {
    return Array.isArray(cond.value) ? (cond.value[0] ?? "") : "";
  }
  return "";
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
  zoneLabel,
  path,
  counts,
  countsStale,
  onChange,
  onRemove,
}: {
  cond: AudienceCondition;
  fields: PersonFieldView[];
  departments: { code: string; name: string }[];
  terms: NamedOption[];
  cycles: NamedOption[];
  subcommittees: NamedOption[];
  zoneLabel: string;
  path: string;
  counts: NodeCounts;
  countsStale: boolean;
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
  // Date and count fields get their own controls (a date picker, a range, a
  // whole-number box) rather than the generic text input, which could only ever
  // produce a string the compiler then had to reject. See value-controls.tsx.
  const usesValueControl = def?.kind === "date" || def?.kind === "count";

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
            <option key={op} value={op}>{opLabel(def.kind, op)}</option>
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
        ) : usesValueControl && def ? (
          <ValueControl
            kind={def.kind}
            op={cond.op}
            value={cond.value}
            onChange={(value) => onChange({ ...cond, value })}
            zoneLabel={zoneLabel}
          />
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

      <div className="ml-auto flex items-center gap-3">
        <NodeCount path={path} counts={counts} stale={countsStale} />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="text-xs text-subtle-foreground hover:text-critical-foreground">
          Remove
        </Button>
      </div>

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
  zoneLabel,
  path,
  counts,
  countsStale,
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
  zoneLabel: string;
  path: string;
  counts: NodeCounts;
  countsStale: boolean;
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
        <div className="flex flex-wrap items-center gap-3">
          <MatchToggle
            match={group.match}
            onChange={(m) => onChange({ ...group, match: m })}
            allowNone={nested}
          />
          <NodeCount path={path} counts={counts} stale={countsStale} match={group.match} />
        </div>
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
              zoneLabel={zoneLabel}
              path={childNodePath(path, i)}
              counts={counts}
              countsStale={countsStale}
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
              zoneLabel={zoneLabel}
              path={childNodePath(path, i)}
              counts={counts}
              countsStale={countsStale}
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

export function AudienceBuilder({
  fields,
  departments,
  terms,
  cycles,
  subcommittees,
  initial,
  zoneLabel,
  countAction,
}: Props) {
  const [root, setRoot] = useState<AudienceGroup>({ match: initial.match, children: initial.conditions });

  // The root connective is narrowed back to ALL/ANY: MatchToggle never offers
  // NONE at depth 0, and Audience.match does not admit it.
  const rootMatch: Audience["match"] = root.match === "NONE" ? "ALL" : root.match;
  const audience: Audience = { recordType: "PERSON", match: rootMatch, conditions: root.children };

  const { counts, stale } = useNodeCounts(audience, countAction);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground-soft">Audience</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose who receives this campaign. Add at least one condition; an empty audience matches nobody (a safeguard against an accidental send-all). Use groups to combine ALL/ANY logic, e.g. GROUP A (this and this) OR GROUP B (this or this), and a NONE group to exclude a cohort. Roster conditions apply to the current term unless you pick terms.
        </p>
        {countAction && (
          <p className="mt-1 text-xs text-muted-foreground">
            Each clause shows how many people it matches ON ITS OWN, within this campaign&apos;s
            scope, not how many it adds. The audience is the whole tree combined, counted beside
            the top Match control.
          </p>
        )}
      </div>

      <GroupEditor
        group={root}
        fields={fields}
        departments={departments}
        terms={terms}
        cycles={cycles}
        subcommittees={subcommittees}
        zoneLabel={zoneLabel}
        path={ROOT_NODE_PATH}
        counts={counts}
        countsStale={stale}
        onChange={setRoot}
        depth={0}
      />

      {/* Hidden serialized audience for form submission */}
      <input type="hidden" name="audience" value={JSON.stringify(audience)} />
    </div>
  );
}
