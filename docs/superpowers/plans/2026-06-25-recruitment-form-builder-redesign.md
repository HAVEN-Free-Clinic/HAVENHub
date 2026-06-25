# Recruitment Form Builder Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the recruitment application-form and training-quiz builders as an Airtable-style WYSIWYG editor with inline editing, drag-to-reorder, friendly type names, and type-aware editors.

**Architecture:** The builder page becomes a thin server wrapper that loads the cycle and renders a client canvas. The canvas renders each field with the same shared renderer the public form uses, so the builder *is* the live preview. Each edit persists per-action through typed server actions wrapping the existing (already-guarded) form-builder services; nothing in the service layer changes.

**Tech Stack:** Next.js 16 (App Router, React 19), Prisma, Tailwind v4, lucide-react, `@dnd-kit` (new), Vitest (node env).

## Global Constraints

- Product name is "HAVEN Hub" (two words) in any user-facing copy; code identifiers stay `havenhub`.
- No em-dashes in any user-facing copy or comments. Use commas, parentheses, or colons.
- All builder server actions require `requirePermission("recruitment.manage_cycles")`.
- No service-layer changes: `addSection`, `updateSection`, `deleteSection`, `reorderSections`, `addField`, `updateField`, `deleteField`, `reorderFields` in `src/modules/recruitment/services/form-builder.ts` already exist with the correct DRAFT-vs-published guards. Wrap them; do not duplicate or alter them.
- Structural edits (type change, required→true, delete, add, applies-to/dept change) are rejected by the service when `cycle.status !== "DRAFT"`. The UI must disable those controls when not editable; the action error is a backstop.
- Choice `value`s are derived once from the label and stay stable forever (submitted answers reference them). Editing a label never changes an existing option's `value`.
- Vitest runs in `environment: "node"` (no DOM). Only pure logic and DB-backed service/action code get automated tests. React components are verified by `npm run typecheck`, `npm run lint`, `npm run build`, and a manual render check.
- Test DB: tests use `resetDb()` from `@/platform/test/db` in `beforeEach`/`afterEach`. Per the test-DB isolation note, each worktree sets its own `TEST_DATABASE_URL`. Run the full suite with `npm run test`; a single file with `npx vitest run <path>`.

---

### Task 1: Field-type metadata map

Single source of truth mapping each `FieldType` to a friendly label, icon, picker group, and capability flags. Kills the raw `SHORT_TEXT` strings and drives the type picker, row icons, and which editors render.

**Files:**
- Create: `src/modules/recruitment/engine/field-types.ts`
- Test: `src/modules/recruitment/engine/field-types.test.ts`

**Interfaces:**
- Produces:
  - `type FieldTypeMeta = { label: string; icon: LucideIcon; group: FieldGroup; hasOptions: boolean; isFile: boolean }`
  - `type FieldGroup = "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department"`
  - `const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta>`
  - `const FIELD_GROUP_ORDER: FieldGroup[]`
  - `function fieldTypesByGroup(): { group: FieldGroup; types: FieldType[] }[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/engine/field-types.test.ts
import { expect, it } from "vitest";
import type { FieldType } from "@prisma/client";
import { FIELD_TYPE_META, fieldTypesByGroup } from "./field-types";

const ALL_TYPES: FieldType[] = [
  "SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX",
  "EMAIL", "PHONE", "NUMBER", "DATE", "FILE", "DEPARTMENT_CHOICE",
];

it("has metadata for every FieldType", () => {
  for (const t of ALL_TYPES) {
    const meta = FIELD_TYPE_META[t];
    expect(meta, `missing meta for ${t}`).toBeTruthy();
    expect(meta.label.length).toBeGreaterThan(0);
    expect(meta.icon).toBeTruthy();
  }
});

it("marks only select types as having options", () => {
  expect(FIELD_TYPE_META.SINGLE_SELECT.hasOptions).toBe(true);
  expect(FIELD_TYPE_META.MULTI_SELECT.hasOptions).toBe(true);
  expect(FIELD_TYPE_META.SHORT_TEXT.hasOptions).toBe(false);
  expect(FIELD_TYPE_META.DEPARTMENT_CHOICE.hasOptions).toBe(false);
});

it("marks FILE as a file field", () => {
  expect(FIELD_TYPE_META.FILE.isFile).toBe(true);
  expect(FIELD_TYPE_META.SHORT_TEXT.isFile).toBe(false);
});

it("groups every type exactly once", () => {
  const flat = fieldTypesByGroup().flatMap((g) => g.types);
  expect(new Set(flat).size).toBe(ALL_TYPES.length);
  for (const t of ALL_TYPES) expect(flat).toContain(t);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/engine/field-types.test.ts`
Expected: FAIL (cannot find module `./field-types`).

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/recruitment/engine/field-types.ts
import type { FieldType } from "@prisma/client";
import {
  Type, AlignLeft, ChevronDownSquare, ListChecks, CheckSquare,
  Mail, Phone, Hash, Calendar, Paperclip, Building2, type LucideIcon,
} from "lucide-react";

export type FieldGroup = "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department";

export type FieldTypeMeta = {
  label: string;
  icon: LucideIcon;
  group: FieldGroup;
  hasOptions: boolean;
  isFile: boolean;
};

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  SHORT_TEXT: { label: "Short text", icon: Type, group: "Text", hasOptions: false, isFile: false },
  LONG_TEXT: { label: "Paragraph", icon: AlignLeft, group: "Text", hasOptions: false, isFile: false },
  SINGLE_SELECT: { label: "Dropdown (one)", icon: ChevronDownSquare, group: "Choice", hasOptions: true, isFile: false },
  MULTI_SELECT: { label: "Checkboxes (many)", icon: ListChecks, group: "Choice", hasOptions: true, isFile: false },
  CHECKBOX: { label: "Single checkbox", icon: CheckSquare, group: "Choice", hasOptions: false, isFile: false },
  EMAIL: { label: "Email", icon: Mail, group: "Contact", hasOptions: false, isFile: false },
  PHONE: { label: "Phone", icon: Phone, group: "Contact", hasOptions: false, isFile: false },
  NUMBER: { label: "Number", icon: Hash, group: "DateNumber", hasOptions: false, isFile: false },
  DATE: { label: "Date", icon: Calendar, group: "DateNumber", hasOptions: false, isFile: false },
  FILE: { label: "File upload", icon: Paperclip, group: "File", hasOptions: false, isFile: true },
  DEPARTMENT_CHOICE: { label: "Department picker", icon: Building2, group: "Department", hasOptions: false, isFile: false },
};

export const FIELD_GROUP_ORDER: FieldGroup[] = ["Text", "Choice", "Contact", "DateNumber", "File", "Department"];

export function fieldTypesByGroup(): { group: FieldGroup; types: FieldType[] }[] {
  return FIELD_GROUP_ORDER.map((group) => ({
    group,
    types: (Object.keys(FIELD_TYPE_META) as FieldType[]).filter((t) => FIELD_TYPE_META[t].group === group),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/engine/field-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/field-types.ts src/modules/recruitment/engine/field-types.test.ts
git commit -m "feat(recruitment): field-type metadata map for the builder"
```

---

### Task 2: Stable choice-option helper

A pure helper to append a choice with a slugged, unique, stable `value`. Used by the options editor and quiz question editor so labels can be renamed without breaking stored answers.

**Files:**
- Create: `src/modules/recruitment/engine/options.ts`
- Test: `src/modules/recruitment/engine/options.test.ts`

**Interfaces:**
- Consumes: `uniqueKey` from `./field-key`.
- Produces:
  - `type Choice = { value: string; label: string }`
  - `function appendChoice(options: Choice[], label: string): Choice[]` (returns a new array; new value is `uniqueKey(label, existingValues)`)
  - `function renameChoice(options: Choice[], value: string, label: string): Choice[]` (changes only the label of the matching value; value untouched)

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/engine/options.test.ts
import { expect, it } from "vitest";
import { appendChoice, renameChoice } from "./options";

it("derives a slugged value when appending", () => {
  const out = appendChoice([], "Patient health information");
  expect(out).toEqual([{ value: "patient_health_information", label: "Patient health information" }]);
});

it("keeps appended values unique", () => {
  let opts = appendChoice([], "Yes");
  opts = appendChoice(opts, "Yes");
  expect(opts.map((o) => o.value)).toEqual(["yes", "yes_2"]);
});

it("rename changes the label but never the value", () => {
  const opts = appendChoice([], "Hopsital revenue"); // typo
  const fixed = renameChoice(opts, "hopsital_revenue", "Hospital revenue");
  expect(fixed).toEqual([{ value: "hopsital_revenue", label: "Hospital revenue" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/engine/options.test.ts`
Expected: FAIL (cannot find module `./options`).

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/recruitment/engine/options.ts
import { uniqueKey } from "./field-key";

export type Choice = { value: string; label: string };

export function appendChoice(options: Choice[], label: string): Choice[] {
  const value = uniqueKey(label, options.map((o) => o.value));
  return [...options, { value, label }];
}

export function renameChoice(options: Choice[], value: string, label: string): Choice[] {
  return options.map((o) => (o.value === value ? { ...o, label } : o));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/engine/options.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/options.ts src/modules/recruitment/engine/options.test.ts
git commit -m "feat(recruitment): stable choice-option helpers"
```

---

### Task 3: Typed builder server actions

Rewrite `actions.ts` so every action takes typed args and returns `ActionResult`, mapping `FormEditError` to an inline error instead of a redirect. Add the missing wiring (`reorderFieldsAction`, `reorderSectionsAction`, `updateSectionAction`, `duplicateFieldAction`) and enrich `updateFieldAction`/`addFieldAction`. No service changes.

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/actions.ts` (full rewrite)
- Test: `src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts`

**Interfaces:**
- Consumes: services from `@/modules/recruitment/services/form-builder`; `requirePermission` from `@/platform/auth/session`.
- Produces (all `"use server"`, all return `Promise<ActionResult>` unless noted):
  - `type ActionResult = { ok: true } | { ok: false; error: string }`
  - `addSectionAction(cycleId, input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; purpose?: "APPLICATION" | "QUIZ" })`
  - `updateSectionAction(cycleId, sectionId, patch: { title?: string; description?: string | null; appliesTo?: ApplicantScope; departmentCode?: string | null })`
  - `deleteSectionAction(cycleId, sectionId)`
  - `reorderSectionsAction(cycleId, orderedSectionIds: string[])`
  - `addFieldAction(cycleId, sectionId, input: { type: FieldType })` (label defaults to the type's friendly label)
  - `updateFieldAction(cycleId, fieldId, patch: { label?: string; helpText?: string | null; required?: boolean; type?: FieldType; options?: { value: string; label: string }[]; validation?: Record<string, unknown> | null; correctValue?: string | null })`
  - `duplicateFieldAction(cycleId, fieldId)`
  - `deleteFieldAction(cycleId, fieldId)`
  - `reorderFieldsAction(cycleId, sectionId, orderedFieldIds: string[])`

Note: `description`, `helpText`, `validation`, and `correctValue` accept `null` to clear; the services already treat `undefined` as "leave unchanged" and `null` as "set null". When a patch field is omitted, pass `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/session", () => ({
  requirePermission: vi.fn().mockResolvedValue({ personId: "p1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "@/modules/recruitment/services/cycles";
import {
  addSectionAction, updateSectionAction, reorderSectionsAction,
  addFieldAction, updateFieldAction, duplicateFieldAction, reorderFieldsAction,
} from "./actions";

async function draftCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("adds a field with the type's friendly default label", async () => {
  const cycle = await draftCycle();
  const r = await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  expect(r.ok).toBe(true);
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
  const add = await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  expect(add.ok).toBe(true);
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  expect(field.label).toBe("Short text");
});

it("updates a section's safe fields", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
  const r = await updateSectionAction(cycle.id, section.id, { title: "About you", description: "Tell us." });
  expect(r.ok).toBe(true);
  const after = await prisma.formSection.findUniqueOrThrow({ where: { id: section.id } });
  expect(after.title).toBe("About you");
  expect(after.description).toBe("Tell us.");
});

it("reorders fields and persists order", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  await addFieldAction(cycle.id, section.id, { type: "EMAIL" });
  const fields = await prisma.formField.findMany({ where: { sectionId: section.id }, orderBy: { order: "asc" } });
  const reversed = [fields[1].id, fields[0].id];
  const r = await reorderFieldsAction(cycle.id, section.id, reversed);
  expect(r.ok).toBe(true);
  const after = await prisma.formField.findMany({ where: { sectionId: section.id }, orderBy: { order: "asc" } });
  expect(after.map((f) => f.id)).toEqual(reversed);
});

it("duplicates a field into the same section", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  const r = await duplicateFieldAction(cycle.id, field.id);
  expect(r.ok).toBe(true);
  const count = await prisma.formField.count({ where: { sectionId: section.id } });
  expect(count).toBe(2);
});

it("rejects a structural type change on a published cycle as an inline error", async () => {
  const cycle = await draftCycle();
  await addSectionAction(cycle.id, { title: "About", appliesTo: "BOTH", departmentCode: null });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id } });
  await addFieldAction(cycle.id, section.id, { type: "SHORT_TEXT" });
  const field = await prisma.formField.findFirstOrThrow({ where: { sectionId: section.id } });
  await publishCycle(cycle.id);
  const r = await updateFieldAction(cycle.id, field.id, { type: "NUMBER" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/published/i);
  const safe = await updateFieldAction(cycle.id, field.id, { label: "Renamed" });
  expect(safe.ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts"`
Expected: FAIL (new action exports do not exist yet).

> Note: if `publishCycle` is not exported from `cycles.ts`, check the export name with `grep -n "export" src/modules/recruitment/services/cycles.ts` and use the actual one (the existing `form-builder.test.ts` imports `publishCycle` from `./cycles`, so it should exist).

- [ ] **Step 3: Write the implementation**

```ts
// src/app/(app)/recruitment/cycles/[id]/builder/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  addSection, updateSection, deleteSection, reorderSections,
  addField, updateField, deleteField, reorderFields, FormEditError,
} from "@/modules/recruitment/services/form-builder";
import { FIELD_TYPE_META } from "@/modules/recruitment/engine/field-types";
import { prisma } from "@/platform/db";
import type { ApplicantScope, FieldType } from "@prisma/client";

export type ActionResult = { ok: true } | { ok: false; error: string };

function builderPath(cycleId: string) {
  return `/recruitment/cycles/${cycleId}/builder`;
}
function quizPath(cycleId: string) {
  return `/recruitment/cycles/${cycleId}/builder/quiz`;
}

async function run(cycleId: string, fn: () => Promise<unknown>, paths: string[] = []): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  try {
    await fn();
  } catch (err) {
    if (err instanceof FormEditError) return { ok: false, error: err.message };
    throw err;
  }
  for (const p of paths.length ? paths : [builderPath(cycleId)]) revalidatePath(p);
  return { ok: true };
}

export async function addSectionAction(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; purpose?: "APPLICATION" | "QUIZ" },
): Promise<ActionResult> {
  const paths = input.purpose === "QUIZ" ? [quizPath(cycleId)] : [builderPath(cycleId)];
  return run(cycleId, () => addSection(cycleId, input), paths);
}

export async function updateSectionAction(
  cycleId: string,
  sectionId: string,
  patch: { title?: string; description?: string | null; appliesTo?: ApplicantScope; departmentCode?: string | null },
): Promise<ActionResult> {
  return run(cycleId, () => updateSection(sectionId, patch), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function deleteSectionAction(cycleId: string, sectionId: string): Promise<ActionResult> {
  return run(cycleId, () => deleteSection(sectionId), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function reorderSectionsAction(cycleId: string, orderedSectionIds: string[]): Promise<ActionResult> {
  return run(cycleId, () => reorderSections(cycleId, orderedSectionIds));
}

export async function addFieldAction(
  cycleId: string,
  sectionId: string,
  input: { type: FieldType },
): Promise<ActionResult> {
  return run(cycleId, () =>
    addField(sectionId, { label: FIELD_TYPE_META[input.type].label, type: input.type, required: false }),
  );
}

export async function updateFieldAction(
  cycleId: string,
  fieldId: string,
  patch: {
    label?: string; helpText?: string | null; required?: boolean; type?: FieldType;
    options?: { value: string; label: string }[]; validation?: Record<string, unknown> | null; correctValue?: string | null;
  },
): Promise<ActionResult> {
  return run(cycleId, () => updateField(fieldId, patch), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function duplicateFieldAction(cycleId: string, fieldId: string): Promise<ActionResult> {
  return run(cycleId, async () => {
    const field = await prisma.formField.findUnique({ where: { id: fieldId } });
    if (!field) throw new FormEditError("Field not found.");
    await addField(field.sectionId, {
      label: `${field.label} (copy)`,
      type: field.type,
      required: field.required,
      helpText: field.helpText ?? undefined,
      options: field.options ?? undefined,
      validation: field.validation ?? undefined,
      correctValue: field.correctValue,
    });
  });
}

export async function deleteFieldAction(cycleId: string, fieldId: string): Promise<ActionResult> {
  return run(cycleId, () => deleteField(fieldId), [builderPath(cycleId), quizPath(cycleId)]);
}

export async function reorderFieldsAction(cycleId: string, sectionId: string, orderedFieldIds: string[]): Promise<ActionResult> {
  return run(cycleId, () => reorderFields(sectionId, orderedFieldIds), [builderPath(cycleId), quizPath(cycleId)]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts"`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The old `page.tsx`/`quiz/page.tsx` still import the now-removed FormData actions; if typecheck complains about those imports, that is expected and gets fixed in Tasks 10-11. If you prefer a green typecheck now, temporarily keep the old default-export pages compiling by deferring the import change, but the cleanest path is to proceed to Tasks 10-11 next.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/actions.ts" "src/app/(app)/recruitment/cycles/[id]/builder/actions.test.ts"
git commit -m "feat(recruitment): typed builder actions with reorder and section updates"
```

---

### Task 4: Extract the shared field renderer

Move the per-type `Field` switch out of the public apply form into a shared component so the builder canvas renders the identical preview. Add a `disabled` mode for the builder.

**Files:**
- Create: `src/modules/recruitment/components/field-preview.tsx`
- Modify: `src/app/apply/[slug]/apply-form.tsx` (remove the inline `Field`, import `FieldPreview`)

**Interfaces:**
- Produces:
  - `type PreviewFieldDef = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null }`
  - `function FieldPreview(props: { f: PreviewFieldDef; departments: string[]; fieldError?: string; onDeptChoice?: (v: string) => void; disabled?: boolean }): JSX.Element`
- Consumes (in apply-form): replaces the local `Field` usage at `apply-form.tsx:67-70`.

- [ ] **Step 1: Create the shared component (verbatim move + `disabled`)**

```tsx
// src/modules/recruitment/components/field-preview.tsx
import { Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";

export type PreviewFieldDef = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
};

export function FieldPreview({
  f, departments, fieldError, onDeptChoice, disabled = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  fieldError?: string;
  onDeptChoice?: (v: string) => void;
  disabled?: boolean;
}) {
  const label = <span className="block text-sm font-medium">{f.label}{f.required && <span className="text-critical"> *</span>}</span>;
  const help = f.helpText ? <span className="block text-xs text-muted-foreground">{f.helpText}</span> : null;
  const err = fieldError ? <span className="block text-xs text-critical">{fieldError}</span> : null;
  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <Textarea name={f.key} required={f.required} disabled={disabled} className="mt-1" rows={4} />; break;
    case "CHECKBOX": control = <input type="checkbox" name={f.key} disabled={disabled} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "DATE": control = <Input type="date" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={f.required} disabled={disabled} className="mt-1" />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <Input type="file" name={f.key} required={f.required} disabled={disabled} accept={accept} className="mt-1 cursor-pointer" />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <Select name={f.key} required={f.required} disabled={disabled} className="mt-1" onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>;
      break;
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={f.required} disabled={disabled} className="mt-1" defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT":
      control = <span className="mt-1 flex flex-col gap-1">{(f.options ?? []).map((o) => <label key={o.value} className="text-sm"><input type="checkbox" name={f.key} value={o.value} disabled={disabled} /> {o.label}</label>)}</span>;
      break;
    default: control = <Input type="text" name={f.key} required={f.required} disabled={disabled} className="mt-1" />;
  }
  return <label className="block">{label}{help}{control}{err}</label>;
}
```

> Note: this also adds a `PHONE` case (the original `apply-form.tsx` fell through to text for phone, which is harmless; `tel` is a small correctness improvement and matches the metadata).

- [ ] **Step 2: Update the apply form to use it**

In `src/app/apply/[slug]/apply-form.tsx`: delete the local `Field` function (lines 79-107) and its usage, and update the import + the section map.

Replace the import block top (lines 5-8 area) so it includes:
```tsx
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
```
Replace the field map (currently lines 67-70) with:
```tsx
          {section.fields.map((f) => (
            <FieldPreview key={f.key} f={f} departments={def.departments}
              fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
              onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined} />
          ))}
```
Delete the now-unused local `Field` function entirely. If `Input`, `Textarea`, or `Select` become unused in `apply-form.tsx` after removal, remove those imports too (the `Select` is still used by the renewal-department picker at line 57, so keep `Select`; check `Input`/`Textarea` usage with a quick search and drop if unused).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

Manual render check: invoke the `run` skill (or `npm run dev`) and open a published cycle's public apply page at `/apply/<slug>`; confirm fields render exactly as before.

- [ ] **Step 4: Commit**

```bash
git add src/modules/recruitment/components/field-preview.tsx src/app/apply/[slug]/apply-form.tsx
git commit -m "refactor(recruitment): extract shared FieldPreview renderer"
```

---

### Task 5: SortableList primitive (install @dnd-kit)

A thin, reusable drag-to-reorder list wrapper so fields and sections can both use it. Install `@dnd-kit` here.

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/sortable-list.tsx`

**Interfaces:**
- Produces:
  - `function SortableList<T extends { id: string }>(props: { items: T[]; onReorder: (orderedIds: string[]) => void; disabled?: boolean; renderItem: (item: T, handle: SortableHandleProps) => React.ReactNode }): JSX.Element`
  - `type SortableHandleProps = { attributes: Record<string, unknown>; listeners: Record<string, unknown> | undefined; isDragging: boolean }`
- Consumes: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.

- [ ] **Step 1: Install the dependency**

Run: `npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`
Expected: three packages added; `package.json` + lockfile updated.

- [ ] **Step 2: Write the component**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/sortable-list.tsx
"use client";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type SortableHandleProps = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  isDragging: boolean;
};

function SortableRow<T extends { id: string }>({
  item, renderItem,
}: { item: T; renderItem: (item: T, handle: SortableHandleProps) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.85 : 1 };
  return (
    <div ref={setNodeRef} style={style}>
      {renderItem(item, { attributes, listeners, isDragging })}
    </div>
  );
}

export function SortableList<T extends { id: string }>({
  items, onReorder, disabled = false, renderItem,
}: {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  disabled?: boolean;
  renderItem: (item: T, handle: SortableHandleProps) => React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (disabled) {
    return <>{items.map((it) => renderItem(it, { attributes: {}, listeners: undefined, isDragging: false }))}</>;
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(items, oldIndex, newIndex).map((i) => i.id));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((it) => <SortableRow key={it.id} item={it} renderItem={renderItem} />)}
      </SortableContext>
    </DndContext>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json "src/app/(app)/recruitment/cycles/[id]/builder/sortable-list.tsx"
git commit -m "feat(recruitment): SortableList primitive with @dnd-kit"
```

---

### Task 6: TypePicker menu

A small popover menu (no menu primitive exists, so build a self-contained one) listing field types grouped, with icons and friendly names. Used by "+ Add field".

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx`

**Interfaces:**
- Consumes: `fieldTypesByGroup`, `FIELD_TYPE_META` from `@/modules/recruitment/engine/field-types`; `Button` from `@/platform/ui/button`.
- Produces: `function TypePicker(props: { onPick: (type: FieldType) => void; disabled?: boolean; label?: string }): JSX.Element`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { Button } from "@/platform/ui/button";
import { fieldTypesByGroup, FIELD_TYPE_META } from "@/modules/recruitment/engine/field-types";

const GROUP_LABELS: Record<string, string> = {
  Text: "Text", Choice: "Choice", Contact: "Contact",
  DateNumber: "Date & number", File: "File", Department: "Department",
};

export function TypePicker({
  onPick, disabled = false, label = "Add field",
}: { onPick: (type: FieldType) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Plus className="h-4 w-4" aria-hidden /> {label}
      </Button>
      {open && (
        <div role="menu"
          className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-auto rounded-xl border border-border bg-surface p-2 shadow-lg">
          {fieldTypesByGroup().map(({ group, types }) => (
            <div key={group} className="mb-1">
              <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">{GROUP_LABELS[group]}</p>
              {types.map((t) => {
                const meta = FIELD_TYPE_META[t];
                const Icon = meta.icon;
                return (
                  <button key={t} type="button" role="menuitem"
                    onClick={() => { onPick(t); setOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted">
                    <Icon className="h-4 w-4 text-subtle-foreground" aria-hidden /> {meta.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/type-picker.tsx"
git commit -m "feat(recruitment): field type picker menu"
```

---

### Task 7: OptionsEditor

Add / rename / remove / reorder choice labels for select fields and quiz questions. Values are derived and stable via the Task 2 helpers. Emits the full options array up to the parent, which persists.

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx`

**Interfaces:**
- Consumes: `appendChoice`, `renameChoice`, `type Choice` from `@/modules/recruitment/engine/options`; `SortableList` from `./sortable-list`; `Input` from `@/platform/ui/input`; `Button` from `@/platform/ui/button`.
- Produces: `function OptionsEditor(props: { options: Choice[]; onChange: (next: Choice[]) => void; disabled?: boolean; markCorrect?: { value: string | null; onPick: (value: string) => void } }): JSX.Element`
  - When `markCorrect` is provided (quiz mode), each row shows a radio to mark the correct answer.

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx
"use client";
import { GripVertical, Plus, X } from "lucide-react";
import { appendChoice, renameChoice, type Choice } from "@/modules/recruitment/engine/options";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { SortableList } from "./sortable-list";

export function OptionsEditor({
  options, onChange, disabled = false, markCorrect,
}: {
  options: Choice[];
  onChange: (next: Choice[]) => void;
  disabled?: boolean;
  markCorrect?: { value: string | null; onPick: (value: string) => void };
}) {
  const items = options.map((o) => ({ id: o.value, ...o }));

  function reorder(orderedIds: string[]) {
    onChange(orderedIds.map((id) => options.find((o) => o.value === id)!).filter(Boolean));
  }
  function remove(value: string) {
    onChange(options.filter((o) => o.value !== value));
  }

  return (
    <div className="space-y-2">
      <SortableList items={items} onReorder={reorder} disabled={disabled} renderItem={(item, handle) => (
        <div className="flex items-center gap-2 py-1">
          <button type="button" className="cursor-grab text-subtle-foreground disabled:cursor-not-allowed"
            disabled={disabled} aria-label="Drag to reorder option"
            {...handle.attributes} {...(handle.listeners ?? {})}>
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
          {markCorrect && (
            <input type="radio" name="__correct" aria-label="Correct answer"
              className="h-4 w-4 accent-brand" checked={markCorrect.value === item.value}
              disabled={disabled} onChange={() => markCorrect.onPick(item.value)} />
          )}
          <Input defaultValue={item.label} disabled={disabled} aria-label="Option label"
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.label) onChange(renameChoice(options, item.value, v)); }} />
          <Button type="button" variant="ghost" size="sm" disabled={disabled}
            onClick={() => remove(item.value)} aria-label="Remove option">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )} />
      <Button type="button" variant="ghost" size="sm" disabled={disabled}
        onClick={() => onChange(appendChoice(options, `Option ${options.length + 1}`))}>
        <Plus className="h-4 w-4" aria-hidden /> Add option
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/options-editor.tsx"
git commit -m "feat(recruitment): options editor with stable values"
```

---

### Task 8: FieldCard (resting preview + inline editor)

One field as it appears to applicants (resting) that expands into an inline editor on click. Persists each change via `updateFieldAction`. Disables structural controls when not editable.

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`

**Interfaces:**
- Consumes: `FieldPreview`, `PreviewFieldDef` from `@/modules/recruitment/components/field-preview`; `FIELD_TYPE_META`, `fieldTypesByGroup` from field-types; `OptionsEditor` from `./options-editor`; `updateFieldAction`, `deleteFieldAction`, `duplicateFieldAction` from `./actions`; `Field`, `Input`, `Textarea` from `@/platform/ui/input`; `Select` from `@/platform/ui/select`; `Checkbox` from `@/platform/ui/checkbox`; `Button` from `@/platform/ui/button`; `ConfirmButton` from `@/platform/ui/confirm-button`; `SortableHandleProps` from `./sortable-list`.
- Produces:
  - `type BuilderField = PreviewFieldDef & { id: string; correctValue: string | null }`
  - `function FieldCard(props: { cycleId: string; field: BuilderField; departments: string[]; editable: boolean; handle: SortableHandleProps; onChanged: () => void }): JSX.Element`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx
"use client";
import { useState, useTransition } from "react";
import { Copy, GripVertical, Pencil, Check, AlertCircle } from "lucide-react";
import type { FieldType } from "@prisma/client";
import { FieldPreview, type PreviewFieldDef } from "@/modules/recruitment/components/field-preview";
import { FIELD_TYPE_META, fieldTypesByGroup } from "@/modules/recruitment/engine/field-types";
import { updateFieldAction, deleteFieldAction, duplicateFieldAction } from "./actions";
import { OptionsEditor } from "./options-editor";
import type { Choice } from "@/modules/recruitment/engine/options";
import type { SortableHandleProps } from "./sortable-list";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export type BuilderField = PreviewFieldDef & { id: string; correctValue: string | null };

const FILE_TYPE_CHOICES: { label: string; value: string }[] = [
  { label: "PDF", value: "application/pdf" },
  { label: "Word", value: "application/msword" },
  { label: "Images", value: "image/*" },
];

export function FieldCard({
  cycleId, field, departments, editable, handle, onChanged,
}: {
  cycleId: string;
  field: BuilderField;
  departments: string[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = FIELD_TYPE_META[field.type as FieldType];
  const Icon = meta.icon;
  const accepted = Array.isArray(field.validation?.acceptedTypes) ? (field.validation!.acceptedTypes as string[]) : [];

  function save(patch: Parameters<typeof updateFieldAction>[2]) {
    setError(null);
    startTransition(async () => {
      const res = await updateFieldAction(cycleId, field.id, patch);
      if (res.ok) { setSaved(true); onChanged(); setTimeout(() => setSaved(false), 1500); }
      else setError(res.error);
    });
  }

  return (
    <div className="group rounded-xl border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <button type="button" className="mt-1 cursor-grab text-subtle-foreground opacity-0 group-hover:opacity-100 disabled:cursor-not-allowed"
          disabled={!editable} aria-label="Drag to reorder field" {...handle.attributes} {...(handle.listeners ?? {})}>
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex-1">
          <FieldPreview f={field} departments={departments} disabled />
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          <span title={meta.label} className="px-1 text-subtle-foreground"><Icon className="h-4 w-4" aria-hidden /></span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-label="Edit field"><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button type="button" variant="ghost" size="sm" disabled={!editable || pending}
            onClick={() => startTransition(async () => { const r = await duplicateFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); })}
            aria-label="Duplicate field"><Copy className="h-4 w-4" aria-hidden /></Button>
          <form action={async () => { const r = await deleteFieldAction(cycleId, field.id); if (r.ok) onChanged(); else setError(r.error); }}>
            <ConfirmButton label="Remove" size="sm" disabled={!editable} />
          </form>
        </div>
      </div>

      {(saved || error) && (
        <p className={`mt-1 flex items-center gap-1 text-xs ${error ? "text-critical" : "text-subtle-foreground"}`}>
          {error ? <><AlertCircle className="h-3 w-3" aria-hidden /> {error}</> : <><Check className="h-3 w-3" aria-hidden /> Saved</>}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-border-subtle pt-3">
          <Field label="Label">
            <Input defaultValue={field.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== field.label) save({ label: v }); }} />
          </Field>
          <Field label="Help text" hint="Shown under the field.">
            <Input defaultValue={field.helpText ?? ""} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (field.helpText ?? "")) save({ helpText: v || null }); }} />
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Type">
              <Select defaultValue={field.type} disabled={!editable} onChange={(e) => save({ type: e.target.value as FieldType })}>
                {fieldTypesByGroup().map(({ group, types }) => (
                  <optgroup key={group} label={group}>
                    {types.map((t) => <option key={t} value={t}>{FIELD_TYPE_META[t].label}</option>)}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 py-2 text-sm text-foreground-soft">
              <Checkbox defaultChecked={field.required} disabled={!editable && !field.required}
                onChange={(e) => save({ required: e.target.checked })} /> Required
            </label>
          </div>

          {meta.hasOptions && (
            <Field label="Choices">
              <OptionsEditor options={(field.options ?? []) as Choice[]} disabled={!editable}
                onChange={(next) => save({ options: next })} />
            </Field>
          )}

          {meta.isFile && (
            <Field label="Accepted file types">
              <div className="flex flex-wrap gap-3">
                {FILE_TYPE_CHOICES.map((c) => (
                  <label key={c.value} className="flex items-center gap-2 text-sm">
                    <Checkbox defaultChecked={accepted.includes(c.value)} disabled={!editable}
                      onChange={(e) => {
                        const next = e.target.checked ? [...accepted, c.value] : accepted.filter((a) => a !== c.value);
                        save({ validation: { ...(field.validation ?? {}), acceptedTypes: next } });
                      }} /> {c.label}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {field.type === "DEPARTMENT_CHOICE" && (
            <p className="text-xs text-subtle-foreground">Choices come from this cycle&apos;s departments automatically.</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx"
git commit -m "feat(recruitment): field card with inline editor"
```

---

### Task 9: SectionCard

A section group: header (title + scope chip + gear editor), its fields (sortable `FieldCard`s), and the "+ Add field" picker.

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx`

**Interfaces:**
- Consumes: `FieldCard`, `BuilderField` from `./field-card`; `SortableList` from `./sortable-list`; `TypePicker` from `./type-picker`; `updateSectionAction`, `deleteSectionAction`, `addFieldAction`, `reorderFieldsAction` from `./actions`; `Field`, `Input`, `Textarea` from `@/platform/ui/input`; `Select` from `@/platform/ui/select`; `Button` from `@/platform/ui/button`; `ConfirmButton` from `@/platform/ui/confirm-button`; `SortableHandleProps` from `./sortable-list`.
- Produces:
  - `type BuilderSection = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: BuilderField[] }`
  - `function SectionCard(props: { cycleId: string; section: BuilderSection; departments: string[]; editable: boolean; handle: SortableHandleProps; onChanged: () => void }): JSX.Element`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx
"use client";
import { useState, useTransition } from "react";
import { GripVertical, Settings2 } from "lucide-react";
import type { ApplicantScope, FieldType } from "@prisma/client";
import { FieldCard, type BuilderField } from "./field-card";
import { SortableList, type SortableHandleProps } from "./sortable-list";
import { TypePicker } from "./type-picker";
import { updateSectionAction, deleteSectionAction, addFieldAction, reorderFieldsAction } from "./actions";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

export type BuilderSection = {
  id: string;
  title: string;
  description: string | null;
  appliesTo: "NEW" | "RENEWAL" | "BOTH";
  departmentCode: string | null;
  fields: BuilderField[];
};

export function SectionCard({
  cycleId, section, departments, editable, handle, onChanged,
}: {
  cycleId: string;
  section: BuilderSection;
  departments: string[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [, startTransition] = useTransition();

  function saveSection(patch: Parameters<typeof updateSectionAction>[2]) {
    startTransition(async () => { const r = await updateSectionAction(cycleId, section.id, patch); if (r.ok) onChanged(); });
  }
  function addField(type: FieldType) {
    startTransition(async () => { const r = await addFieldAction(cycleId, section.id, { type }); if (r.ok) onChanged(); });
  }
  function reorder(orderedFieldIds: string[]) {
    startTransition(async () => { const r = await reorderFieldsAction(cycleId, section.id, orderedFieldIds); if (r.ok) onChanged(); });
  }

  const scope = section.appliesTo === "BOTH" ? "NEW · RENEWAL" : section.appliesTo;

  return (
    <section className="rounded-2xl border border-border bg-muted/30 p-4">
      <div className="flex items-start gap-2">
        <button type="button" className="mt-1 cursor-grab text-subtle-foreground disabled:cursor-not-allowed"
          disabled={!editable} aria-label="Drag to reorder section" {...handle.attributes} {...(handle.listeners ?? {})}>
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex-1">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
          <p className="text-xs text-subtle-foreground">{scope}{section.departmentCode ? ` · ${section.departmentCode}` : ""}</p>
          {section.description && <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowSettings((v) => !v)} aria-label="Section settings"><Settings2 className="h-4 w-4" aria-hidden /></Button>
        <form action={async () => { const r = await deleteSectionAction(cycleId, section.id); if (r.ok) onChanged(); }}>
          <ConfirmButton label="Delete section" size="sm" disabled={!editable} />
        </form>
      </div>

      {showSettings && (
        <div className="mt-3 grid gap-3 rounded-xl border border-border-subtle bg-surface p-3 sm:grid-cols-2">
          <Field label="Title">
            <Input defaultValue={section.title} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== section.title) saveSection({ title: v }); }} />
          </Field>
          <Field label="Applies to">
            <Select defaultValue={section.appliesTo} disabled={!editable} onChange={(e) => saveSection({ appliesTo: e.target.value as ApplicantScope })}>
              <option value="BOTH">New and renewing</option>
              <option value="NEW">New only</option>
              <option value="RENEWAL">Renewing only</option>
            </Select>
          </Field>
          <Field label="Description" hint="Shown under the section title.">
            <Textarea defaultValue={section.description ?? ""} rows={2} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (section.description ?? "")) saveSection({ description: v || null }); }} />
          </Field>
          <Field label="Department code" hint="Supplement only.">
            <Input defaultValue={section.departmentCode ?? ""} disabled={!editable} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (section.departmentCode ?? "")) saveSection({ departmentCode: v || null }); }} />
          </Field>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <SortableList items={section.fields} onReorder={reorder} disabled={!editable} renderItem={(field, fhandle) => (
          <div className="py-1">
            <FieldCard cycleId={cycleId} field={field} departments={departments} editable={editable} handle={fhandle} onChanged={onChanged} />
          </div>
        )} />
        {section.fields.length === 0 && <p className="py-2 text-sm text-subtle-foreground">No fields yet.</p>}
        <div className="pt-1"><TypePicker onPick={addField} disabled={!editable} /></div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx"
git commit -m "feat(recruitment): section card with settings and add-field"
```

---

### Task 10: FormBuilder canvas + thin server page

The application-form canvas: header card, sortable sections, "+ Add section", and the published banner. Rewrite `page.tsx` to load the cycle and render it.

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/page.tsx` (thin server wrapper)

**Interfaces:**
- Consumes: `SectionCard`, `BuilderSection` from `./section-card`; `SortableList` from `./sortable-list`; `addSectionAction`, `reorderSectionsAction` from `./actions`; `Alert` from `@/platform/ui/alert`; `Button` from `@/platform/ui/button`; `useRouter` from `next/navigation`.
- Produces: `function FormBuilder(props: { cycleId: string; cycleTitle: string; editable: boolean; status: string; departments: string[]; sections: BuilderSection[] }): JSX.Element`

- [ ] **Step 1: Write the canvas**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { SectionCard, type BuilderSection } from "./section-card";
import { SortableList } from "./sortable-list";
import { addSectionAction, reorderSectionsAction } from "./actions";
import { Alert } from "@/platform/ui/alert";
import { Button } from "@/platform/ui/button";

export function FormBuilder({
  cycleId, cycleTitle, editable, status, departments, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  status: string;
  departments: string[];
  sections: BuilderSection[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => router.refresh();

  function addSection() {
    startTransition(async () => { const r = await addSectionAction(cycleId, { title: "New section", appliesTo: "BOTH", departmentCode: null }); if (r.ok) refresh(); });
  }
  function reorder(orderedSectionIds: string[]) {
    startTransition(async () => { const r = await reorderSectionsAction(cycleId, orderedSectionIds); if (r.ok) refresh(); });
  }

  return (
    <div className="space-y-4">
      {!editable && (
        <Alert tone="warning">
          This cycle is {status}. You can edit labels, help text, and descriptions; structural changes (types, required, adding, deleting, reordering scope) are locked to protect submitted answers.
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="p-5">
          <h1 className="text-lg font-semibold text-foreground">{cycleTitle}</h1>
          <p className="text-sm text-muted-foreground">Application form</p>
        </div>
      </div>

      <SortableList items={sections} onReorder={reorder} disabled={!editable} renderItem={(section, handle) => (
        <div className="py-2">
          <SectionCard cycleId={cycleId} section={section} departments={departments} editable={editable} handle={handle} onChanged={refresh} />
        </div>
      )} />

      <Button type="button" variant="outline" onClick={addSection} disabled={!editable}>
        <Plus className="h-4 w-4" aria-hidden /> Add section
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the server page**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { FormBuilder } from "./form-builder";
import type { BuilderSection } from "./section-card";

export default async function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  const sections: BuilderSection[] = cycle.sections
    .filter((s) => s.purpose === "APPLICATION")
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      appliesTo: s.appliesTo,
      departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({
        id: f.id, key: f.key, label: f.label, helpText: f.helpText, type: f.type,
        required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null,
        validation: (f.validation as Record<string, unknown> | null) ?? null, correctValue: f.correctValue,
      })),
    }));

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Form builder", slug: "builder" } })} />
      <PageHeader title="Form builder" description={cycle.title}
        action={<Link href={`/recruitment/cycles/${id}/builder/quiz`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-fg hover:text-brand-hover">Training quiz <ArrowRight className="h-4 w-4" aria-hidden /></Link>} />
      <FormBuilder cycleId={id} cycleTitle={cycle.title} editable={cycle.status === "DRAFT"} status={cycle.status}
        departments={cycle.departments} sections={sections} />
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors. (If `cycle.departments` is not on the `getCycle` result, confirm the field name with `grep -n "departments" src/modules/recruitment/services/cycles.ts`; the schema defines `RecruitmentCycle.departments String[]`.)

Manual render check (run skill or `npm run dev`): open `/recruitment/cycles/<draftCycleId>/builder`. Verify: header card, sections render as preview, hover shows drag handle + actions, clicking a field expands the editor, adding a field via the picker works, drag reorders and persists after refresh, and a published cycle disables structural controls and shows the banner.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/page.tsx"
git commit -m "feat(recruitment): WYSIWYG application form builder canvas"
```

---

### Task 11: QuizBuilder canvas + thin server page

The quiz canvas: quiz sections, each question shown with its answer options as radios where clicking marks the correct answer (one step). "+ Add question" creates a prompt with two starter options. Rewrite `quiz/page.tsx`.

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/quiz/page.tsx` (thin server wrapper)

**Interfaces:**
- Consumes: `OptionsEditor` from `../options-editor`; `addSectionAction`, `addFieldAction`, `updateFieldAction`, `deleteFieldAction` from `../actions`; `appendChoice`, `type Choice` from `@/modules/recruitment/engine/options`; `Field`, `Input` from `@/platform/ui/input`; `Button` from `@/platform/ui/button`; `ConfirmButton` from `@/platform/ui/confirm-button`; `Alert` from `@/platform/ui/alert`; `useRouter` from `next/navigation`.
- Produces:
  - `type QuizQuestion = { id: string; label: string; options: Choice[]; correctValue: string | null }`
  - `type QuizSection = { id: string; title: string; questions: QuizQuestion[] }`
  - `function QuizBuilder(props: { cycleId: string; cycleTitle: string; editable: boolean; sections: QuizSection[] }): JSX.Element`

- [ ] **Step 1: Write the canvas**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { addSectionAction, addFieldAction, updateFieldAction, deleteFieldAction } from "../actions";
import { OptionsEditor } from "../options-editor";
import { appendChoice, type Choice } from "@/modules/recruitment/engine/options";
import { Field, Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";

export type QuizQuestion = { id: string; label: string; options: Choice[]; correctValue: string | null };
export type QuizSection = { id: string; title: string; questions: QuizQuestion[] };

export function QuizBuilder({
  cycleId, cycleTitle, editable, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  sections: QuizSection[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const refresh = () => router.refresh();

  function addQuizSection() {
    const title = newSectionTitle.trim() || "Quiz";
    startTransition(async () => { const r = await addSectionAction(cycleId, { title, appliesTo: "BOTH", departmentCode: null, purpose: "QUIZ" }); if (r.ok) { setNewSectionTitle(""); refresh(); } });
  }
  function addQuestion(sectionId: string) {
    startTransition(async () => {
      const r = await addFieldAction(cycleId, sectionId, { type: "SINGLE_SELECT" });
      if (!r.ok) return;
      refresh();
    });
  }
  function saveQuestion(fieldId: string, patch: Parameters<typeof updateFieldAction>[2]) {
    startTransition(async () => { const r = await updateFieldAction(cycleId, fieldId, patch); if (r.ok) refresh(); });
  }

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="warning">This cycle is published. Quiz edits that change scoring are limited.</Alert>}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="h-2 bg-brand" aria-hidden />
        <div className="p-5"><h1 className="text-lg font-semibold text-foreground">{cycleTitle}</h1><p className="text-sm text-muted-foreground">Training quiz</p></div>
      </div>

      {sections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-border bg-muted/30 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
          <div className="mt-3 space-y-4">
            {section.questions.map((q) => (
              <div key={q.id} className="rounded-xl border border-border bg-surface p-3">
                <Field label="Question">
                  <Input defaultValue={q.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== q.label) saveQuestion(q.id, { label: v }); }} />
                </Field>
                <p className="mb-1 mt-3 text-xs font-medium text-subtle-foreground">Answers (select the correct one)</p>
                <OptionsEditor
                  options={q.options}
                  onChange={(next) => saveQuestion(q.id, { options: next })}
                  markCorrect={{ value: q.correctValue, onPick: (value) => saveQuestion(q.id, { correctValue: value }) }}
                />
                <div className="mt-2 flex justify-end">
                  <form action={async () => { const r = await deleteFieldAction(cycleId, q.id); if (r.ok) refresh(); }}>
                    <ConfirmButton label="Remove question" size="sm" disabled={!editable} />
                  </form>
                </div>
              </div>
            ))}
            {section.questions.length === 0 && <p className="text-sm text-subtle-foreground">No questions yet.</p>}
            <Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => addQuestion(section.id)}>
              <Plus className="h-4 w-4" aria-hidden /> Add question
            </Button>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-dashed border-border-strong bg-muted/60 p-5">
        <Field label="Quiz section title">
          <Input value={newSectionTitle} onChange={(e) => setNewSectionTitle(e.target.value)} className="min-w-[14rem]" />
        </Field>
        <Button type="button" onClick={addQuizSection} disabled={!editable}>Add quiz section</Button>
      </div>
    </div>
  );
}
```

> Note: `addQuestion` creates a `SINGLE_SELECT` field with the type's default label and no options. After it appears, the author renames it and adds answer options via the inline editor. New options get stable values from `appendChoice` inside `OptionsEditor`; `appendChoice` is imported here for type re-export only and may be dropped if unused after lint. The starter "two options" intent is satisfied by the author clicking "Add option" twice; if you want auto-seeded options, extend `addFieldAction` is out of scope — keep it manual to avoid a service change.

- [ ] **Step 2: Rewrite the server page**

```tsx
// src/app/(app)/recruitment/cycles/[id]/builder/quiz/page.tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { QuizBuilder, type QuizSection } from "./quiz-builder";

export default async function QuizBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  const sections: QuizSection[] = cycle.sections
    .filter((s) => s.purpose === "QUIZ")
    .map((s) => ({
      id: s.id,
      title: s.title,
      questions: s.fields.map((f) => ({
        id: f.id, label: f.label,
        options: (f.options as { value: string; label: string }[] | null) ?? [],
        correctValue: f.correctValue,
      })),
    }));

  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Form builder", slug: "builder" }, leaf: "Training quiz" })} />
      <PageHeader title="Training quiz" description={cycle.title} />
      <QuizBuilder cycleId={id} cycleTitle={cycle.title} editable={cycle.status === "DRAFT"} sections={sections} />
    </div>
  );
}
```

- [ ] **Step 3: Delete dead code**

The old `addQuizQuestionAction` and `setCorrectAnswerAction` in `actions.ts` are no longer used (the quiz now uses `addFieldAction` + `updateFieldAction`). Remove them and confirm nothing else imports them: `grep -rn "addQuizQuestionAction\|setCorrectAnswerAction" src/`. Expected: no remaining references.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors.

Manual render check: open `/recruitment/cycles/<draftCycleId>/builder/quiz`. Add a quiz section, add a question, rename it, add two answer options, click a radio to mark the correct one, refresh, and confirm the correct answer persists.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/quiz/page.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/actions.ts"
git commit -m "feat(recruitment): WYSIWYG quiz builder with one-click correct answer"
```

---

### Task 12: Full verification pass

**Files:** none (verification + any small fixes surfaced).

- [ ] **Step 1: Run the full suite**

Run: `npm run test`
Expected: PASS, including the new `field-types`, `options`, and `actions` tests, and the pre-existing `form-builder` tests. (Per the test-DB isolation note, the 4 cert `/tmp` ENOENT tests are known pre-existing flakes and unrelated to this work.)

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 3: End-to-end manual walkthrough (run skill or `npm run dev`)**

On a DRAFT cycle:
- Add a section; rename it via the gear; set Applies-to and a description.
- Add fields of several types (short text, dropdown, file, department picker); confirm the canvas preview matches each type.
- Edit a dropdown's choices; rename a choice and confirm its value stays stable (add a field reference if needed); reorder choices.
- Set a File field's accepted types.
- Drag to reorder fields within a section and sections themselves; refresh and confirm order persists.
- Duplicate and delete a field.
- Open `/apply/<slug>` for a published cycle and confirm the public form still renders identically (shared renderer).

On a published (non-DRAFT) cycle:
- Confirm the banner shows and structural controls are disabled, while label/help-text/description edits still save.

Quiz:
- Add a quiz section and question; mark the correct answer with the radio; refresh and confirm it persists.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore(recruitment): verification fixes for form builder redesign"
```

---

## Self-Review Notes

- **Spec coverage:** WYSIWYG canvas (Tasks 10-11), shared renderer = live preview (Task 4), friendly type names + icons (Task 1), inline editing incl. help text / file types / section description (Tasks 8-9), stable option values (Task 2), drag reorder (Tasks 5, 8-10), per-action save with inline feedback (Task 8), published safe-edit handling (Tasks 8-11), quiz one-click correct answer (Task 11), new actions wiring existing services (Task 3), @dnd-kit dependency (Task 5). All spec sections map to a task.
- **Out of scope (unchanged):** cross-section field drag, branching logic, validation beyond file types, separate preview route.
- **Type consistency:** `BuilderField` (Task 8) extends `PreviewFieldDef` (Task 4) + `{ id, correctValue }`; `BuilderSection` (Task 9) carries `BuilderField[]`; `SortableHandleProps` (Task 5) flows through `SortableList` → `SectionCard`/`FieldCard`; `ActionResult` (Task 3) is consumed by every client caller. `updateFieldAction`'s patch shape is reused via `Parameters<typeof updateFieldAction>[2]` in Tasks 8, 9, 11 so it can't drift.
- **Risk to watch during execution:** confirm `getCycle` returns `departments`, `sections[].purpose`, `description`, and per-field `options`/`validation`/`correctValue` (the schema has them; verify the select in `cycles.ts:getCycle`). If `getCycle` doesn't already include fields ordered by `order`, sort `sections` and `fields` by `order` in the page mappers before passing down.
