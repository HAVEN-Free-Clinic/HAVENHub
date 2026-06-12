# Email Audience Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins target email campaign audiences by any meaningful person attribute (name, NetID, email, Epic ID, phone, and more) plus a curated set of relational facts, with rich text operators.

**Architecture:** Convert the hardcoded `personFieldWhere` switch into a field registry where each field declares its kind, allowed operators, and a `compile()` function that returns a Prisma `PersonWhereInput` fragment. Scalar text columns share a generated compiler; relations get bespoke compilers. The builder UI gains an operator dropdown (text fields only) and a value control that adapts to the operator. The flat ALL / ANY wrapper, send paths, and recipient-count preview are untouched.

**Tech Stack:** TypeScript, Next.js App Router (server components + client builder), Prisma (Postgres / Neon), Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-11-email-audience-conditions-design.md`

---

## File Structure

- `src/platform/email/audience/types.ts` — expand the `ConditionOp` union. Owns the serialized audience shape.
- `src/platform/email/audience/person-fields.ts` — the field registry, the `textField` helper, the text compiler, `parseTextList`, and `personFieldWhere` dispatch. The heart of this change; all testable logic lives here.
- `src/platform/email/audience/person-fields.test.ts` — unit tests for every field and operator.
- `src/app/admin/email/campaigns/[id]/audience-builder.tsx` — client builder UI; operator dropdown + value-control switch + grouped field selector.

Untouched: `compile.ts`, `resolve.ts`, `variables.ts`, `compile.test.ts` (regression guard), `page.tsx`, and all send paths.

**Important conventions:**
- Run a single test file with: `npx vitest run src/platform/email/audience/person-fields.test.ts`
- Run all unit tests with: `npm test` (alias for `vitest run`).
- These audience tests are pure (no database); they assert the shape of the Prisma `where` object.
- Honor the repo style: no em-dashes in copy or comments.

---

## Task 1: Refactor the field registry (no behavior change)

Convert `PersonFieldDef` to carry `group`, `operators`, and a `compile` function, and make `personFieldWhere` dispatch to `field.compile`. Keep the same five fields and identical output so the existing tests stay green and act as the regression guard.

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts`
- Test (guard, unchanged): `src/platform/email/audience/person-fields.test.ts`

- [ ] **Step 1: Run the existing tests to confirm a green baseline**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 2: Rewrite `person-fields.ts` to the registry shape**

Replace the entire file with:

```ts
import type { Prisma } from "@prisma/client";
import type { AudienceCondition, ConditionOp } from "./types";

export type PersonFieldKind = "text" | "enum" | "multiEnum" | "boolean";

export type AudienceCtx = { activeTermId: string | null };

export type PersonFieldDef = {
  key: string;
  label: string;
  group: string;
  kind: PersonFieldKind;
  operators: ConditionOp[];
  options?: { value: string; label: string }[];
  compile: (cond: AudienceCondition, ctx: AudienceCtx) => Prisma.PersonWhereInput;
};

const COMPLIANCE_VALUES = ["COMPLIANT", "EXPIRING_SOON", "EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"];

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export const PERSON_FIELDS: PersonFieldDef[] = [
  {
    key: "status",
    label: "Account status",
    group: "Status & roles",
    kind: "enum",
    operators: ["eq"],
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "OFFBOARDED", label: "Offboarded" },
    ],
    compile: (cond) => ({ status: cond.value as "ACTIVE" | "OFFBOARDED" }),
  },
  {
    key: "role",
    label: "Role (this term)",
    group: "Status & roles",
    kind: "enum",
    operators: ["eq"],
    options: [
      { value: "DIRECTOR", label: "Director" },
      { value: "VOLUNTEER", label: "Volunteer" },
    ],
    compile: (cond, ctx) => ({
      memberships: {
        some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", kind: cond.value as "DIRECTOR" | "VOLUNTEER" },
      },
    }),
  },
  {
    key: "department",
    label: "Department (this term)",
    group: "Status & roles",
    kind: "multiEnum",
    operators: ["in"],
    compile: (cond, ctx) => ({
      memberships: {
        some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", department: { code: { in: asArray(cond.value) } } },
      },
    }),
  },
  {
    key: "complianceStatus",
    label: "HIPAA compliance status",
    group: "Status & roles",
    kind: "multiEnum",
    operators: ["in"],
    options: COMPLIANCE_VALUES.map((v) => ({ value: v, label: v })),
    compile: (cond) => ({ complianceReminder: { lastStatus: { in: asArray(cond.value) } } }),
  },
  {
    key: "hasEpicId",
    label: "Has an Epic ID",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => (cond.op === "isFalse" ? { epicId: null } : { epicId: { not: null } }),
  },
];

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  const field = PERSON_FIELDS.find((f) => f.key === cond.field);
  if (!field) throw new Error(`Unknown audience field: ${cond.field}`);
  return field.compile(cond, ctx);
}
```

- [ ] **Step 3: Run the tests to confirm they still pass**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: PASS (6 tests). The whitelist test still sees exactly `["status", "role", "department", "complianceStatus", "hasEpicId"]`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/platform/email/audience/person-fields.ts
git commit -m "refactor(email): field registry for audience conditions"
```

---

## Task 2: Text fields and text operators

Add the text operators to `ConditionOp`, a `textField` helper plus `textCompile`, a `parseTextList` parser, and the seven direct text fields. Incomplete text conditions must match nobody.

**Files:**
- Modify: `src/platform/email/audience/types.ts`
- Modify: `src/platform/email/audience/person-fields.ts`
- Test: `src/platform/email/audience/person-fields.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("person fields", ...)` block in `person-fields.test.ts`, and update the existing whitelist test to the new field order.

Replace the existing whitelist test body with:

```ts
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "name", "netId", "contactEmail", "epicId", "phone", "yaleAffiliation", "gradYear",
      "status", "role", "department", "complianceStatus", "hasEpicId",
    ]);
  });
```

Update the existing import line at the top of the file (do not add a second import statement) from:

```ts
import { PERSON_FIELDS, personFieldWhere } from "./person-fields";
```
to:

```ts
import { PERSON_FIELDS, personFieldWhere, parseTextList } from "./person-fields";
```

Then add two new `describe` blocks at the end of the file:

```ts
describe("text operators", () => {
  it("contains -> case-insensitive contains", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "jane" }, ctx)).toEqual({
      name: { contains: "jane", mode: "insensitive" },
    });
  });

  it("eq -> case-insensitive equals", () => {
    expect(personFieldWhere({ field: "name", op: "eq", value: "Jane Doe" }, ctx)).toEqual({
      name: { equals: "Jane Doe", mode: "insensitive" },
    });
  });

  it("startsWith / endsWith -> case-insensitive", () => {
    expect(personFieldWhere({ field: "contactEmail", op: "endsWith", value: "@yale.edu" }, ctx)).toEqual({
      contactEmail: { endsWith: "@yale.edu", mode: "insensitive" },
    });
    expect(personFieldWhere({ field: "netId", op: "startsWith", value: "abc" }, ctx)).toEqual({
      netId: { startsWith: "abc", mode: "insensitive" },
    });
  });

  it("in (is any of) -> parses a comma/newline list, exact match", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "abc123, def456\nghi789" }, ctx)).toEqual({
      netId: { in: ["abc123", "def456", "ghi789"] },
    });
  });

  it("isEmpty / isNotEmpty -> null-or-blank checks", () => {
    expect(personFieldWhere({ field: "epicId", op: "isEmpty" }, ctx)).toEqual({
      OR: [{ epicId: null }, { epicId: "" }],
    });
    expect(personFieldWhere({ field: "epicId", op: "isNotEmpty" }, ctx)).toEqual({
      AND: [{ epicId: { not: null } }, { epicId: { not: "" } }],
    });
  });

  it("safety: a blank value operator matches nobody", () => {
    expect(personFieldWhere({ field: "name", op: "contains", value: "" }, ctx)).toEqual({ id: { in: [] } });
    expect(personFieldWhere({ field: "name", op: "contains", value: "   " }, ctx)).toEqual({ id: { in: [] } });
  });

  it("safety: an empty 'is any of' list matches nobody", () => {
    expect(personFieldWhere({ field: "netId", op: "in", value: "  , \n " }, ctx)).toEqual({ id: { in: [] } });
  });
});

describe("parseTextList", () => {
  it("splits on commas and newlines, trims, drops blanks", () => {
    expect(parseTextList("a, b\nc ,, \n d")).toEqual(["a", "b", "c", "d"]);
  });
  it("passes through an array, trimming and dropping blanks", () => {
    expect(parseTextList(["a", " b ", ""])).toEqual(["a", "b"]);
  });
  it("returns [] for undefined", () => {
    expect(parseTextList(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: FAIL. `parseTextList` is not exported and the `name`/`netId`/etc. fields do not exist (whitelist mismatch + "Unknown audience field").

- [ ] **Step 3: Expand the `ConditionOp` union**

In `src/platform/email/audience/types.ts`, replace the `ConditionOp` line:

```ts
export type ConditionOp =
  | "eq"
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "isTrue"
  | "isFalse";
```

Leave `AudienceCondition`, `Audience`, and `isAudience` unchanged.

- [ ] **Step 4: Add the text compiler, helper, parser, and fields**

In `src/platform/email/audience/person-fields.ts`, add this constant near the top (after `COMPLIANCE_VALUES`):

```ts
const MATCH_NOBODY: Prisma.PersonWhereInput = { id: { in: [] } };

const TEXT_OPERATORS: ConditionOp[] = [
  "contains",
  "eq",
  "startsWith",
  "endsWith",
  "in",
  "isEmpty",
  "isNotEmpty",
];

export function parseTextList(value: AudienceCondition["value"]): string[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function textCompile(column: string, cond: AudienceCondition): Prisma.PersonWhereInput {
  switch (cond.op) {
    case "isEmpty":
      return { OR: [{ [column]: null }, { [column]: "" }] } as Prisma.PersonWhereInput;
    case "isNotEmpty":
      return {
        AND: [{ [column]: { not: null } }, { [column]: { not: "" } }],
      } as Prisma.PersonWhereInput;
    case "in": {
      const list = parseTextList(cond.value);
      return list.length === 0 ? MATCH_NOBODY : ({ [column]: { in: list } } as Prisma.PersonWhereInput);
    }
    case "contains":
    case "startsWith":
    case "endsWith":
    case "eq": {
      const raw = typeof cond.value === "string" ? cond.value.trim() : "";
      if (raw === "") return MATCH_NOBODY;
      const prismaOp = cond.op === "eq" ? "equals" : cond.op;
      return { [column]: { [prismaOp]: raw, mode: "insensitive" } } as Prisma.PersonWhereInput;
    }
    default:
      throw new Error(`Unsupported text operator: ${cond.op}`);
  }
}

function textField(key: string, label: string, column: string): PersonFieldDef {
  return {
    key,
    label,
    group: "Identity",
    kind: "text",
    operators: TEXT_OPERATORS,
    compile: (cond) => textCompile(column, cond),
  };
}
```

Then prepend the seven text fields to the front of the `PERSON_FIELDS` array (before the `status` entry):

```ts
  textField("name", "Full name", "name"),
  textField("netId", "NetID", "netId"),
  textField("contactEmail", "Email", "contactEmail"),
  textField("epicId", "Epic ID", "epicId"),
  textField("phone", "Phone", "phone"),
  textField("yaleAffiliation", "Yale affiliation", "yaleAffiliation"),
  textField("gradYear", "Grad year", "gradYear"),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: PASS (all existing plus new text and parseTextList tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/email/audience/types.ts src/platform/email/audience/person-fields.ts src/platform/email/audience/person-fields.test.ts
git commit -m "feat(email): text-field audience conditions with rich operators"
```

---

## Task 3: Direct booleans and curated relations

Add the `spanishSpeaking` and `licensedRN` boolean fields, plus the two curated relational conditions `hasOpenEpicRequest` and `hasDisciplinaryAction`.

**Files:**
- Modify: `src/platform/email/audience/person-fields.ts`
- Test: `src/platform/email/audience/person-fields.test.ts`

- [ ] **Step 1: Write the failing tests**

Update the whitelist test to the full final order:

```ts
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "name", "netId", "contactEmail", "epicId", "phone", "yaleAffiliation", "gradYear",
      "status", "role", "department", "complianceStatus", "hasEpicId",
      "spanishSpeaking", "licensedRN", "hasOpenEpicRequest", "hasDisciplinaryAction",
    ]);
  });
```

Add a new `describe` block at the end of the file:

```ts
describe("booleans and relations", () => {
  it("spanishSpeaking / licensedRN -> direct boolean", () => {
    expect(personFieldWhere({ field: "spanishSpeaking", op: "isTrue" }, ctx)).toEqual({ spanishSpeaking: true });
    expect(personFieldWhere({ field: "spanishSpeaking", op: "isFalse" }, ctx)).toEqual({ spanishSpeaking: false });
    expect(personFieldWhere({ field: "licensedRN", op: "isTrue" }, ctx)).toEqual({ licensedRN: true });
  });

  it("hasOpenEpicRequest -> some/none PENDING epic request", () => {
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isTrue" }, ctx)).toEqual({
      epicRequests: { some: { status: "PENDING" } },
    });
    expect(personFieldWhere({ field: "hasOpenEpicRequest", op: "isFalse" }, ctx)).toEqual({
      epicRequests: { none: { status: "PENDING" } },
    });
  });

  it("hasDisciplinaryAction -> some/none disciplinary action", () => {
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isTrue" }, ctx)).toEqual({
      disciplinaryActions: { some: {} },
    });
    expect(personFieldWhere({ field: "hasDisciplinaryAction", op: "isFalse" }, ctx)).toEqual({
      disciplinaryActions: { none: {} },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: FAIL with "Unknown audience field: spanishSpeaking" and a whitelist mismatch.

- [ ] **Step 3: Add the four fields**

Append these entries to the end of the `PERSON_FIELDS` array in `person-fields.ts` (after the `hasEpicId` entry):

```ts
  {
    key: "spanishSpeaking",
    label: "Spanish-speaking",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ spanishSpeaking: cond.op === "isTrue" }),
  },
  {
    key: "licensedRN",
    label: "Licensed RN",
    group: "Attributes",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) => ({ licensedRN: cond.op === "isTrue" }),
  },
  {
    key: "hasOpenEpicRequest",
    label: "Has an open EPIC request",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { epicRequests: { none: { status: "PENDING" } } }
        : { epicRequests: { some: { status: "PENDING" } } },
  },
  {
    key: "hasDisciplinaryAction",
    label: "Has a disciplinary action",
    group: "Records",
    kind: "boolean",
    operators: ["isTrue", "isFalse"],
    compile: (cond) =>
      cond.op === "isFalse"
        ? { disciplinaryActions: { none: {} } }
        : { disciplinaryActions: { some: {} } },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/email/audience/person-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite and typecheck**

Run: `npm test`
Expected: PASS (including `compile.test.ts` and `resolve.test.ts`, unchanged).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/audience/person-fields.ts src/platform/email/audience/person-fields.test.ts
git commit -m "feat(email): boolean and curated relational audience conditions"
```

---

## Task 4: Operator-aware builder UI

Add an operator dropdown for text fields, a value control that adapts to the operator, and group the field selector by category. Enum, multiEnum, and boolean controls stay visually identical to today.

**Files:**
- Modify: `src/app/admin/email/campaigns/[id]/audience-builder.tsx`

No unit test (no component-test harness in this repo). Verified by typecheck, lint, and a manual smoke test.

- [ ] **Step 1: Replace `audience-builder.tsx` with the operator-aware version**

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors in `audience-builder.tsx`.

- [ ] **Step 4: Manual smoke test**

Start the app (`npm run dev`), open a DRAFT campaign at `/admin/email/campaigns/<id>`, and in the Audience section:
- Add a condition, choose "Full name" (under the Identity group), operator "contains", type a value.
- Click "Preview audience" and confirm the count reflects the filter.
- Switch the operator to "is any of", paste two NetIDs on separate lines, switch the field to "NetID", and preview again.
- Add a "Has a disciplinary action" condition set to "No" and confirm preview still returns a sensible count.
- Save the draft, reload, and confirm the conditions round-trip (deserialize) correctly.

Expected: each preview returns a count consistent with the filter; conditions persist across reload.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/email/campaigns/[id]/audience-builder.tsx
git commit -m "feat(email): operator-aware audience builder UI"
```

---

## Self-Review Notes

- **Spec coverage:** text operators (Task 2), is-any-of list paste (Task 2 + UI textarea), is-empty/is-not-empty (Task 2), direct text fields (Task 2), direct booleans (Task 3), curated relations (Task 3), operator-aware UI with grouping (Task 4), incomplete-condition-matches-nobody safety (Task 2). The recipient-count preview and send paths are reused unchanged (verified in Task 4 smoke test).
- **Type consistency:** `PersonFieldDef.compile`, `personFieldWhere`, `parseTextList`, and `ConditionOp` names match across tasks. UI imports `ConditionOp` from `types.ts`.
- **Regression guard:** `compile.test.ts` and `resolve.test.ts` are unchanged and must stay green (verified in Task 3 Step 5).
