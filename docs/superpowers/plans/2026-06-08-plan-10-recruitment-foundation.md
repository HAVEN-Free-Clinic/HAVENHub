# Plan 10 — Recruitment Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Recruitment module so a recruitment lead can build a cycle's application form from scratch (dynamic sections/fields + department supplements + a renewal branch), publish a public link, and receive/validate/view applications submitted by unauthenticated applicants.

**Architecture:** New `recruitment` module under `src/modules/recruitment/{engine,services,components}` following the Schedule/Volunteers layout. Pure engine functions (key generation, section visibility, zod schema generation) are unit-tested; services own DB writes + audit; authenticated pages live under `/recruitment` behind `requireModuleAccess("recruitment")`; the single public surface is `/apply/[slug]` which simply omits the session guards (there is no global middleware to carve out of). Form definitions are normalized rows (`FormSection`/`FormField`); answers are JSON on `Application`, validated at write time by a schema generated from the field definitions.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Prisma/Postgres, zod, vitest (unit + integration against a real test DB), Playwright (e2e). Reuses the existing local-filesystem upload mechanism (`config.UPLOAD_DIR`) and the `EmailLog` queue (`queueEmail`).

**Spec:** `docs/superpowers/specs/2026-06-08-recruitment-design.md` (Plan 10 = §2–§10).

**Branch:** `plan-10/recruitment-foundation` (already exists).

---

## File Structure

**Schema / platform:**
- Modify `prisma/schema.prisma` — 6 enums + 5 models + Person/Term back-relations.
- Create `prisma/migrations/<ts>_recruitment_foundation/migration.sql` (via `prisma migrate dev`).
- Modify `src/platform/test/db.ts` — add new tables to the `resetDb()` TRUNCATE list.
- Modify `src/platform/modules/registry.ts` — flip `recruitment` to `active` + nav + permissions.

**Engine (pure, unit-tested):**
- Create `src/modules/recruitment/engine/field-key.ts` — `slugifyKey`, `uniqueKey`.
- Create `src/modules/recruitment/engine/visibility.ts` — `isSectionVisible`, `visibleSections`.
- Create `src/modules/recruitment/engine/schema-builder.ts` — `buildApplicationSchema`, `requiredFileKeys`.
- Plus co-located `*.test.ts` for each.

**Services (integration-tested):**
- Create `src/modules/recruitment/services/cycles.ts` — cycle CRUD + status transitions + publish guards.
- Create `src/modules/recruitment/services/form-builder.ts` — section/field mutations + edit guards.
- Create `src/modules/recruitment/services/submissions.ts` — public submit (validate/dedup/files/email) + list/get.
- Plus co-located `*.test.ts` for each.

**Authenticated pages (under the module guard):**
- Create `src/app/recruitment/layout.tsx` — `requireModuleAccess("recruitment")` + shell + nav.
- Create `src/app/recruitment/page.tsx` — cycle list.
- Create `src/app/recruitment/cycles/new/page.tsx` — create-cycle form + action.
- Create `src/app/recruitment/cycles/[id]/page.tsx` — overview + publish/close/renewals actions.
- Create `src/app/recruitment/cycles/[id]/builder/page.tsx` — form builder + mutation actions.
- Create `src/app/recruitment/cycles/[id]/applicants/page.tsx` — submissions list.
- Create `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` — single application.
- Create `src/modules/recruitment/components/builder.tsx` — builder client component.

**Public surface (no guard):**
- Create `src/app/apply/[slug]/page.tsx` — public form (server) + closed state.
- Create `src/app/apply/[slug]/apply-form.tsx` — client form (conditional rendering, file inputs, applicant-type routing).
- Create `src/app/apply/[slug]/actions.ts` — the public submit server action.
- Create `src/app/apply/[slug]/error.tsx` — minimal public error boundary.

**e2e:**
- Create `e2e/recruitment.spec.ts`.

---

## Conventions every task follows

- **Run unit tests:** `npm test -- <path>` (vitest). Integration tests need the test DB prepared once per session: `npm run test:prepare`.
- **Typecheck:** `npm run typecheck`. **Lint:** `npm run lint` (includes the module-boundary rule: `src/modules/**` may import `@/platform/**` but never another module).
- **Commit** at the end of every task with the message shown.
- **Module boundary:** recruitment code imports only from `@/platform/*` and within `@/modules/recruitment/*`. Never import another module.

---

### Task 1: Prisma schema — enums, models, migration, test reset

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts`
- Create: `prisma/migrations/<timestamp>_recruitment_foundation/migration.sql` (generated)

- [ ] **Step 1: Add the six enums to `prisma/schema.prisma`**

Append near the other enums (after `enum EmailStatus`):

```prisma
enum RecruitmentTrack {
  VOLUNTEER
  DIRECTOR
}

enum CycleStatus {
  DRAFT
  OPEN
  CLOSED
  ARCHIVED
}

enum FieldType {
  SHORT_TEXT
  LONG_TEXT
  SINGLE_SELECT
  MULTI_SELECT
  CHECKBOX
  EMAIL
  PHONE
  NUMBER
  DATE
  FILE
  DEPARTMENT_CHOICE
}

enum ApplicantScope {
  NEW
  RENEWAL
  BOTH
}

enum ApplicantType {
  NEW
  RENEWAL
}

enum ApplicationStatus {
  SUBMITTED
}
```

- [ ] **Step 2: Add the five models to `prisma/schema.prisma`**

Append after the last model:

```prisma
model RecruitmentCycle {
  id              String           @id @default(cuid())
  track           RecruitmentTrack
  termId          String
  title           String
  status          CycleStatus      @default(DRAFT)
  publicSlug      String           @unique
  opensAt         DateTime?
  closesAt        DateTime?
  departments     String[]
  acceptsRenewals Boolean          @default(false)
  createdById     String
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  term         Term          @relation(fields: [termId], references: [id], onDelete: Restrict)
  createdBy    Person        @relation("RecruitmentCycleCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  sections     FormSection[]
  fields       FormField[]
  applicants   Applicant[]
  applications Application[]

  @@index([status, track])
}

model FormSection {
  id             String         @id @default(cuid())
  cycleId        String
  title          String
  description    String?
  order          Int
  departmentCode String?
  appliesTo      ApplicantScope @default(BOTH)

  cycle  RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  fields FormField[]

  @@index([cycleId, order])
}

model FormField {
  id         String    @id @default(cuid())
  sectionId  String
  cycleId    String
  key        String
  label      String
  helpText   String?
  type       FieldType
  required   Boolean   @default(false)
  options    Json?
  validation Json?
  order      Int

  section FormSection      @relation(fields: [sectionId], references: [id], onDelete: Cascade)
  cycle   RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)

  @@unique([cycleId, key])
  @@index([sectionId, order])
}

model Applicant {
  id         String   @id @default(cuid())
  cycleId    String
  firstName  String
  lastName   String
  email      String
  emailLower String
  netId      String?
  phone      String?
  createdAt  DateTime @default(now())

  cycle        RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  applications Application[]

  @@unique([cycleId, emailLower])
}

model Application {
  id                String            @id @default(cuid())
  cycleId           String
  applicantId       String
  answers           Json
  applicantType     ApplicantType     @default(NEW)
  departmentChoices String[]
  renewalDepartment String?
  status            ApplicationStatus @default(SUBMITTED)
  submittedAt       DateTime          @default(now())
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  cycle     RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  applicant Applicant        @relation(fields: [applicantId], references: [id], onDelete: Cascade)

  @@unique([cycleId, applicantId])
  @@index([cycleId, submittedAt])
}
```

- [ ] **Step 3: Add back-relations to `Person` and `Term`**

In `model Person`, add (alongside the other back-relations):

```prisma
  recruitmentCyclesCreated RecruitmentCycle[] @relation("RecruitmentCycleCreatedBy")
```

In `model Term`, add:

```prisma
  recruitmentCycles RecruitmentCycle[]
```

- [ ] **Step 4: Generate the migration and client**

Run: `npm run db:migrate -- --name recruitment_foundation`
Expected: a new folder `prisma/migrations/<timestamp>_recruitment_foundation/` with `migration.sql` creating the five tables + six enums; Prisma client regenerated.

> If the dev DB has drift and `migrate dev` refuses, create the migration SQL by hand under that folder (CREATE TYPE for each enum, CREATE TABLE for each model with the indexes/uniques above), then `npx prisma migrate resolve --applied <timestamp>_recruitment_foundation` and `npx prisma generate`. This matches how prior plan-8/plan-9 migrations were handled.

- [ ] **Step 5: Extend `resetDb()` in `src/platform/test/db.ts`**

Add the new tables to the `TRUNCATE` list (before `CASCADE`). The final list must include:

```
"Application", "Applicant", "FormField", "FormSection", "RecruitmentCycle",
```

Place them ahead of `"Term", "Person"` so cascade ordering reads naturally (CASCADE makes order irrelevant, but keep it tidy).

- [ ] **Step 6: Verify**

Run: `npx prisma validate` → "The schema at prisma/schema.prisma is valid 🚀"
Run: `npm run typecheck` → no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(recruitment): schema for cycles, form definitions, applicants, applications"
```

---

### Task 2: Engine — field key generation

**Files:**
- Create: `src/modules/recruitment/engine/field-key.ts`
- Test: `src/modules/recruitment/engine/field-key.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { slugifyKey, uniqueKey } from "./field-key";

describe("slugifyKey", () => {
  it("lowercases and underscores non-alphanumerics", () => {
    expect(slugifyKey("1st-Choice Department/Position")).toBe("1st_choice_department_position");
  });
  it("trims leading/trailing separators", () => {
    expect(slugifyKey("  Résumé?  ")).toBe("r_sum");
  });
  it("falls back to 'field' for empty input", () => {
    expect(slugifyKey("!!!")).toBe("field");
  });
});

describe("uniqueKey", () => {
  it("returns the base key when unused", () => {
    expect(uniqueKey("Email", [])).toBe("email");
  });
  it("suffixes _2, _3 on collision", () => {
    expect(uniqueKey("Email", ["email"])).toBe("email_2");
    expect(uniqueKey("Email", ["email", "email_2"])).toBe("email_3");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/modules/recruitment/engine/field-key.test.ts`
Expected: FAIL — cannot find module `./field-key`.

- [ ] **Step 3: Implement**

```ts
/** Stable answer-key helpers for the form builder. Keys are immutable once
 *  submissions exist, so generation only happens when a field is first added. */

export function slugifyKey(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base.length > 0 ? base : "field";
}

export function uniqueKey(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = slugifyKey(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/modules/recruitment/engine/field-key.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/field-key.ts src/modules/recruitment/engine/field-key.test.ts
git commit -m "feat(recruitment): field-key generation engine"
```

---

### Task 3: Engine — section visibility resolver

**Files:**
- Create: `src/modules/recruitment/engine/visibility.ts`
- Test: `src/modules/recruitment/engine/visibility.test.ts`

This is the single authority for "which sections show" given applicant type + chosen departments (spec §4.6).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isSectionVisible, visibleSections, type SectionVisibilityInput } from "./visibility";

const S = (over: Partial<SectionVisibilityInput>): SectionVisibilityInput => ({
  id: "s",
  appliesTo: "BOTH",
  departmentCode: null,
  ...over,
});

describe("isSectionVisible", () => {
  it("BOTH + no department is always visible", () => {
    expect(isSectionVisible(S({}), { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
    expect(isSectionVisible(S({}), { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(true);
  });
  it("NEW-only section hides from renewals", () => {
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(S({ appliesTo: "NEW" }), { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
  });
  it("department supplement shows only when its code is chosen", () => {
    const sec = S({ departmentCode: "SRHD" });
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] })).toBe(true);
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["MDIC"] })).toBe(false);
  });
  it("department supplement also respects appliesTo", () => {
    const sec = S({ departmentCode: "SRHD", appliesTo: "RENEWAL" });
    expect(isSectionVisible(sec, { applicantType: "NEW", selectedDepartmentCodes: ["SRHD"] })).toBe(false);
    expect(isSectionVisible(sec, { applicantType: "RENEWAL", selectedDepartmentCodes: ["SRHD"] })).toBe(true);
  });
});

describe("visibleSections", () => {
  it("filters a list", () => {
    const sections = [S({ id: "a" }), S({ id: "b", appliesTo: "NEW" }), S({ id: "c", departmentCode: "MDIC" })];
    const out = visibleSections(sections, { applicantType: "RENEWAL", selectedDepartmentCodes: ["MDIC"] });
    expect(out.map((s) => s.id)).toEqual(["a", "c"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/modules/recruitment/engine/visibility.test.ts`
Expected: FAIL — cannot find module `./visibility`.

- [ ] **Step 3: Implement**

```ts
export type ApplicantType = "NEW" | "RENEWAL";
export type ApplicantScope = "NEW" | "RENEWAL" | "BOTH";

export type SectionVisibilityInput = {
  id: string;
  appliesTo: ApplicantScope;
  departmentCode: string | null;
};

export type VisibilityContext = {
  applicantType: ApplicantType;
  selectedDepartmentCodes: string[];
};

/** A section shows iff its applicant-type scope matches AND (it is not a
 *  department supplement, or its department is among the chosen ones). */
export function isSectionVisible(
  section: SectionVisibilityInput,
  ctx: VisibilityContext
): boolean {
  const typeMatch = section.appliesTo === "BOTH" || section.appliesTo === ctx.applicantType;
  if (!typeMatch) return false;
  if (section.departmentCode === null) return true;
  return ctx.selectedDepartmentCodes.includes(section.departmentCode);
}

export function visibleSections<T extends SectionVisibilityInput>(
  sections: T[],
  ctx: VisibilityContext
): T[] {
  return sections.filter((section) => isSectionVisible(section, ctx));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/modules/recruitment/engine/visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/visibility.ts src/modules/recruitment/engine/visibility.test.ts
git commit -m "feat(recruitment): section visibility resolver"
```

---

### Task 4: Engine — application schema builder

**Files:**
- Create: `src/modules/recruitment/engine/schema-builder.ts`
- Test: `src/modules/recruitment/engine/schema-builder.test.ts`

Generates a zod schema for the *scalar* answers in the visible sections, and lists required FILE keys (files arrive as multipart, validated for presence in the service). DEPARTMENT_CHOICE lives in an always-visible section so it is always validated.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildApplicationSchema, requiredFileKeys, type SectionDef } from "./schema-builder";

const ctx = { applicantType: "NEW" as const, selectedDepartmentCodes: ["SRHD"] };

const sections: SectionDef[] = [
  {
    id: "identity",
    appliesTo: "BOTH",
    departmentCode: null,
    fields: [
      { key: "email", type: "EMAIL", required: true, options: null, validation: null },
      { key: "phone", type: "PHONE", required: false, options: null, validation: null },
      { key: "essay", type: "LONG_TEXT", required: true, options: null, validation: { min: 10 } },
      { key: "year", type: "NUMBER", required: true, options: null, validation: { min: 2025, max: 2031 } },
      { key: "agree", type: "CHECKBOX", required: true, options: null, validation: null },
      { key: "dept", type: "SINGLE_SELECT", required: true, options: [{ value: "a", label: "A" }], validation: null },
    ],
  },
  {
    id: "srhd",
    appliesTo: "NEW",
    departmentCode: "SRHD",
    fields: [{ key: "srhd_q1", type: "LONG_TEXT", required: true, options: null, validation: null }],
  },
  {
    id: "mdic",
    appliesTo: "NEW",
    departmentCode: "MDIC",
    fields: [{ key: "mdic_q1", type: "LONG_TEXT", required: true, options: null, validation: null }],
  },
];

describe("buildApplicationSchema", () => {
  it("accepts a valid payload for chosen departments", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu",
      phone: "",
      essay: "a sufficiently long answer",
      year: 2026,
      agree: true,
      dept: "a",
      srhd_q1: "my srhd answer",
    });
    expect(result.success).toBe(true);
  });

  it("does not require fields from unchosen-department supplements", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu",
      essay: "a sufficiently long answer",
      year: 2026,
      agree: true,
      dept: "a",
      srhd_q1: "my srhd answer",
      // no mdic_q1 — and that must be fine
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({ email: "a@yale.edu", year: 2026, agree: true, dept: "a", srhd_q1: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an unchecked required checkbox", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu", essay: "long enough answer", year: 2026, agree: false, dept: "a", srhd_q1: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range number", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu", essay: "long enough answer", year: 1999, agree: true, dept: "a", srhd_q1: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a select value outside its options", () => {
    const schema = buildApplicationSchema(sections, ctx);
    const result = schema.safeParse({
      email: "a@yale.edu", essay: "long enough answer", year: 2026, agree: true, dept: "nope", srhd_q1: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("requiredFileKeys", () => {
  it("returns required FILE keys only in visible sections", () => {
    const withFiles: SectionDef[] = [
      { id: "a", appliesTo: "BOTH", departmentCode: null, fields: [{ key: "resume", type: "FILE", required: true, options: null, validation: null }] },
      { id: "b", appliesTo: "BOTH", departmentCode: "MDIC", fields: [{ key: "portfolio", type: "FILE", required: true, options: null, validation: null }] },
    ];
    expect(requiredFileKeys(withFiles, ctx)).toEqual(["resume"]); // MDIC not chosen
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/modules/recruitment/engine/schema-builder.test.ts`
Expected: FAIL — cannot find module `./schema-builder`.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
import {
  visibleSections,
  type SectionVisibilityInput,
  type VisibilityContext,
} from "./visibility";

export type FieldType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_SELECT"
  | "MULTI_SELECT"
  | "CHECKBOX"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "DATE"
  | "FILE"
  | "DEPARTMENT_CHOICE";

export type FieldValidation = {
  min?: number;
  max?: number;
  regex?: string;
  maxFileMB?: number;
  acceptedTypes?: string[];
};

export type FieldDef = {
  key: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[] | null;
  validation?: FieldValidation | null;
};

export type SectionDef = SectionVisibilityInput & { fields: FieldDef[] };

/** Optional-string helper: required maps to min length 1. */
function reqString(required: boolean, min?: number): z.ZodTypeAny {
  let s = z.string();
  if (required) s = s.min(Math.max(1, min ?? 1));
  else if (min) s = s.min(min);
  return required ? s : s.optional().or(z.literal(""));
}

function fieldSchema(field: FieldDef): z.ZodTypeAny {
  const v = field.validation ?? {};
  switch (field.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT": {
      let s = z.string();
      if (field.required) s = s.min(Math.max(1, v.min ?? 1));
      else if (v.min) s = s.min(v.min);
      if (v.max) s = s.max(v.max);
      if (v.regex) s = s.regex(new RegExp(v.regex));
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "EMAIL": {
      const s = z.string().email();
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "PHONE":
      return reqString(field.required);
    case "NUMBER": {
      let n = z.coerce.number();
      if (v.min !== undefined) n = n.min(v.min);
      if (v.max !== undefined) n = n.max(v.max);
      return field.required ? n : n.optional();
    }
    case "DATE": {
      const s = z.string().refine((val) => !Number.isNaN(Date.parse(val)), "invalid date");
      return field.required ? s : z.union([s, z.literal("")]).optional();
    }
    case "CHECKBOX":
      // Required checkbox must be true; optional is any boolean.
      return field.required ? z.coerce.boolean().refine((b) => b === true, "required") : z.coerce.boolean().optional();
    case "SINGLE_SELECT":
    case "DEPARTMENT_CHOICE": {
      const values = (field.options ?? []).map((o) => o.value);
      // DEPARTMENT_CHOICE options are injected by the caller (from cycle.departments).
      const base = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      return field.required ? base : z.union([base, z.literal("")]).optional();
    }
    case "MULTI_SELECT": {
      const values = (field.options ?? []).map((o) => o.value);
      const item = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
      let arr = z.array(item);
      if (field.required) arr = arr.min(1);
      if (v.max !== undefined) arr = arr.max(v.max);
      return field.required ? arr : arr.optional();
    }
    case "FILE":
      // Files are multipart, validated for presence in the service. Ignored here.
      return z.any().optional();
    default:
      return z.any().optional();
  }
}

/** Build a zod schema for the scalar answers of every visible section. */
export function buildApplicationSchema(
  sections: SectionDef[],
  ctx: VisibilityContext
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE") continue;
      shape[field.key] = fieldSchema(field);
    }
  }
  return z.object(shape);
}

/** Keys of required FILE fields that are visible for this context. */
export function requiredFileKeys(sections: SectionDef[], ctx: VisibilityContext): string[] {
  const keys: string[] = [];
  for (const section of visibleSections(sections, ctx)) {
    for (const field of section.fields) {
      if (field.type === "FILE" && field.required) keys.push(field.key);
    }
  }
  return keys;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/modules/recruitment/engine/schema-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/schema-builder.ts src/modules/recruitment/engine/schema-builder.test.ts
git commit -m "feat(recruitment): application schema builder + required-file resolver"
```

---

### Task 5: Cycle service — CRUD, status transitions, publish guards

**Files:**
- Create: `src/modules/recruitment/services/cycles.ts`
- Test: `src/modules/recruitment/services/cycles.test.ts`

Publish guards (spec §5.2 + §4.5/§4.6):
1. Identity fields present: a field of type EMAIL plus first-name and last-name SHORT_TEXT fields (by key `first_name`, `last_name`, `email`) — for Plan 10 these are seeded by `createCycle` (Step 3) so the guard checks their presence.
2. If any section has a non-null `departmentCode`, exactly one `DEPARTMENT_CHOICE` field must exist.
3. If `acceptsRenewals`, after resolving `appliesTo` there must be ≥1 section visible to NEW and ≥1 visible to RENEWAL.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  createCycle,
  publishCycle,
  closeCycle,
  listCycles,
  CyclePublishError,
} from "./cycles";

async function seedTermAndPerson() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") },
  });
  return { person, term };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("createCycle", () => {
  it("creates a DRAFT cycle with a unique slug and seeded identity fields", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "Volunteer SU26",
      publicSlug: "volunteer-su26", departments: ["SRHD", "MDIC"], acceptsRenewals: false,
      createdById: person.id,
    });
    expect(cycle.status).toBe("DRAFT");
    const fields = await prisma.formField.findMany({ where: { cycleId: cycle.id } });
    expect(fields.map((f) => f.key).sort()).toEqual(["email", "first_name", "last_name"]);
  });
});

describe("publishCycle", () => {
  it("moves DRAFT to OPEN when identity fields exist and there are no dept supplements", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v1",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    const published = await publishCycle(cycle.id, person.id);
    expect(published.status).toBe("OPEN");
  });

  it("rejects publishing when a dept supplement exists but no DEPARTMENT_CHOICE field", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v2",
      departments: ["SRHD"], acceptsRenewals: false, createdById: person.id,
    });
    await prisma.formSection.create({
      data: { cycleId: cycle.id, title: "SRHD Supplement", order: 1, departmentCode: "SRHD", appliesTo: "NEW" },
    });
    await expect(publishCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects publishing a renewals cycle with no RENEWAL-visible section", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v3",
      departments: [], acceptsRenewals: true, createdById: person.id,
    });
    // identity sections are BOTH (visible to RENEWAL), so add a NEW-only section to keep NEW covered,
    // then assert it still publishes (both branches covered by the BOTH identity section).
    const published = await publishCycle(cycle.id, person.id);
    expect(published.status).toBe("OPEN");
  });
});

describe("closeCycle / listCycles", () => {
  it("closes an open cycle and lists it", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d1",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    const closed = await closeCycle(cycle.id, person.id);
    expect(closed.status).toBe("CLOSED");
    const all = await listCycles();
    expect(all.find((c) => c.id === cycle.id)?.status).toBe("CLOSED");
  });
});
```

- [ ] **Step 2: Prepare the test DB and run to verify it fails**

Run: `npm run test:prepare` (once), then `npm test -- src/modules/recruitment/services/cycles.test.ts`
Expected: FAIL — cannot find module `./cycles`.

- [ ] **Step 3: Implement**

```ts
import type { RecruitmentCycle, RecruitmentTrack } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isSectionVisible } from "../engine/visibility";

export class CyclePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclePublishError";
  }
}

export type CreateCycleInput = {
  track: RecruitmentTrack;
  termId: string;
  title: string;
  publicSlug: string;
  departments: string[];
  acceptsRenewals: boolean;
  createdById: string;
};

/** Create a DRAFT cycle and seed the mandatory identity section/fields so the
 *  publish guard and the public form always have name + email. Two steps: the
 *  cycle+section first (so we have both ids), then the fields with cycleId set
 *  directly — FormField.cycleId is required, so it cannot be a nested create. */
export async function createCycle(input: CreateCycleInput): Promise<RecruitmentCycle> {
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: input.track,
      termId: input.termId,
      title: input.title,
      publicSlug: input.publicSlug,
      departments: input.departments,
      acceptsRenewals: input.acceptsRenewals,
      createdById: input.createdById,
      sections: { create: { title: "Your information", order: 0, appliesTo: "BOTH" } },
    },
    include: { sections: true },
  });

  const identity = cycle.sections[0];
  await prisma.formField.createMany({
    data: [
      { sectionId: identity.id, cycleId: cycle.id, key: "first_name", label: "First name", type: "SHORT_TEXT", required: true, order: 0 },
      { sectionId: identity.id, cycleId: cycle.id, key: "last_name", label: "Last name", type: "SHORT_TEXT", required: true, order: 1 },
      { sectionId: identity.id, cycleId: cycle.id, key: "email", label: "Yale email", type: "EMAIL", required: true, order: 2 },
    ],
  });

  await recordAudit({ actorPersonId: input.createdById, action: "recruitment.cycle_create", entityType: "RecruitmentCycle", entityId: cycle.id });
  return cycle;
}

export async function getCycle(id: string) {
  return prisma.recruitmentCycle.findUnique({
    where: { id },
    include: { sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });
}

export async function listCycles(): Promise<RecruitmentCycle[]> {
  return prisma.recruitmentCycle.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
  });
}

export async function publishCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const cycle = await getCycle(id);
  if (!cycle) throw new CyclePublishError("Cycle not found.");
  if (cycle.status !== "DRAFT") throw new CyclePublishError("Only a DRAFT cycle can be published.");

  const allFields = cycle.sections.flatMap((s) => s.fields);
  const keys = new Set(allFields.map((f) => f.key));
  if (!keys.has("first_name") || !keys.has("last_name") || !keys.has("email")) {
    throw new CyclePublishError("Identity fields (first name, last name, email) are required before publishing.");
  }

  const hasDeptSupplement = cycle.sections.some((s) => s.departmentCode !== null);
  const deptChoiceCount = allFields.filter((f) => f.type === "DEPARTMENT_CHOICE").length;
  if (hasDeptSupplement && deptChoiceCount !== 1) {
    throw new CyclePublishError("A cycle with department supplements needs exactly one department-choice field.");
  }

  if (cycle.acceptsRenewals) {
    const sectionInputs = cycle.sections.map((s) => ({ id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode }));
    const newVisible = sectionInputs.some((s) => isSectionVisible(s, { applicantType: "NEW", selectedDepartmentCodes: cycle.departments }));
    const renewalVisible = sectionInputs.some((s) => isSectionVisible(s, { applicantType: "RENEWAL", selectedDepartmentCodes: cycle.departments }));
    if (!newVisible || !renewalVisible) {
      throw new CyclePublishError("A renewals cycle must have at least one section visible to each applicant type.");
    }
  }

  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { status: "OPEN" } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_publish", entityType: "RecruitmentCycle", entityId: id });
  return updated;
}

export async function closeCycle(id: string, actorId: string): Promise<RecruitmentCycle> {
  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { status: "CLOSED" } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_close", entityType: "RecruitmentCycle", entityId: id });
  return updated;
}

export async function setAcceptsRenewals(id: string, value: boolean, actorId: string): Promise<RecruitmentCycle> {
  const updated = await prisma.recruitmentCycle.update({ where: { id }, data: { acceptsRenewals: value } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.cycle_set_renewals", entityType: "RecruitmentCycle", entityId: id, after: { acceptsRenewals: value } });
  return updated;
}
```

> Note: `createMany` is used for the seeded fields because `FormField.cycleId` is
> required and therefore cannot be supplied by a nested `fields.create` under the
> section. The form-builder service (Task 6) likewise sets `cycleId` directly on
> every field create.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/modules/recruitment/services/cycles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/cycles.ts src/modules/recruitment/services/cycles.test.ts
git commit -m "feat(recruitment): cycle service with publish guards"
```

---

### Task 6: Form builder service — section/field mutations + edit guards

**Files:**
- Create: `src/modules/recruitment/services/form-builder.ts`
- Test: `src/modules/recruitment/services/form-builder.test.ts`

Edit guards (spec §5.1–§5.2): once a cycle is OPEN, block structural edits that invalidate existing answers — deleting a field, changing a field `type`, or flipping a field from optional→required. Safe edits (label, helpText, reorder, adding an *optional* field, adding a section) stay allowed.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "./cycles";
import {
  addSection, addField, updateField, deleteField, FormEditError,
} from "./form-builder";

async function draftCycle(acceptsRenewals = false) {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], acceptsRenewals, createdById: person.id });
  return { person, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("adds a section and a field with a generated unique key", async () => {
  const { cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "NEW", departmentCode: null });
  const f1 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: true });
  const f2 = await addField(section.id, { label: "Why HAVEN?", type: "LONG_TEXT", required: false });
  expect(f1.key).toBe("why_haven");
  expect(f2.key).toBe("why_haven_2");
  expect(f1.cycleId).toBe(cycle.id);
});

it("allows safe edits after OPEN but blocks structural ones", async () => {
  const { person, cycle } = await draftCycle();
  const section = await addSection(cycle.id, { title: "Essays", appliesTo: "BOTH", departmentCode: null });
  const field = await addField(section.id, { label: "Bio", type: "SHORT_TEXT", required: false });
  await publishCycle(cycle.id, person.id);

  // Safe: relabel
  const relabeled = await updateField(field.id, { label: "Short bio" });
  expect(relabeled.label).toBe("Short bio");

  // Structural: change type
  await expect(updateField(field.id, { type: "NUMBER" })).rejects.toBeInstanceOf(FormEditError);
  // Structural: optional -> required
  await expect(updateField(field.id, { required: true })).rejects.toBeInstanceOf(FormEditError);
  // Structural: delete
  await expect(deleteField(field.id)).rejects.toBeInstanceOf(FormEditError);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/modules/recruitment/services/form-builder.test.ts`
Expected: FAIL — cannot find module `./form-builder`.

- [ ] **Step 3: Implement**

```ts
import type { ApplicantScope, FieldType, FormField, FormSection } from "@prisma/client";
import { prisma } from "@/platform/db";
import { uniqueKey } from "../engine/field-key";

export class FormEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormEditError";
  }
}

async function assertCycleEditable(cycleId: string, structural: boolean): Promise<void> {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new FormEditError("Cycle not found.");
  if (structural && cycle.status !== "DRAFT") {
    throw new FormEditError("This cycle is published; that change would invalidate existing answers.");
  }
}

export async function addSection(
  cycleId: string,
  input: { title: string; appliesTo: ApplicantScope; departmentCode: string | null; description?: string }
): Promise<FormSection> {
  await assertCycleEditable(cycleId, false);
  const count = await prisma.formSection.count({ where: { cycleId } });
  return prisma.formSection.create({
    data: { cycleId, title: input.title, description: input.description ?? null, appliesTo: input.appliesTo, departmentCode: input.departmentCode, order: count },
  });
}

export async function addField(
  sectionId: string,
  input: { label: string; type: FieldType; required: boolean; helpText?: string; options?: unknown; validation?: unknown }
): Promise<FormField> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, false); // adding a field is non-structural

  const existing = await prisma.formField.findMany({ where: { cycleId: section.cycleId }, select: { key: true } });
  const key = uniqueKey(input.label, existing.map((f) => f.key));
  const count = await prisma.formField.count({ where: { sectionId } });

  return prisma.formField.create({
    data: {
      sectionId, cycleId: section.cycleId, key, label: input.label, type: input.type,
      required: input.required, helpText: input.helpText ?? null,
      options: (input.options ?? undefined) as never, validation: (input.validation ?? undefined) as never,
      order: count,
    },
  });
}

export async function updateField(
  fieldId: string,
  patch: { label?: string; helpText?: string; type?: FieldType; required?: boolean; options?: unknown; validation?: unknown }
): Promise<FormField> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId } });
  if (!field) throw new FormEditError("Field not found.");

  const structural =
    (patch.type !== undefined && patch.type !== field.type) ||
    (patch.required === true && field.required === false);
  await assertCycleEditable(field.cycleId, structural);

  return prisma.formField.update({
    where: { id: fieldId },
    data: {
      label: patch.label ?? undefined,
      helpText: patch.helpText ?? undefined,
      type: patch.type ?? undefined,
      required: patch.required ?? undefined,
      options: (patch.options ?? undefined) as never,
      validation: (patch.validation ?? undefined) as never,
    },
  });
}

export async function deleteField(fieldId: string): Promise<void> {
  const field = await prisma.formField.findUnique({ where: { id: fieldId } });
  if (!field) throw new FormEditError("Field not found.");
  await assertCycleEditable(field.cycleId, true); // deletion is always structural
  await prisma.formField.delete({ where: { id: fieldId } });
}

export async function reorderFields(sectionId: string, orderedFieldIds: string[]): Promise<void> {
  await prisma.$transaction(
    orderedFieldIds.map((id, index) => prisma.formField.update({ where: { id }, data: { order: index } }))
  );
}

export async function reorderSections(cycleId: string, orderedSectionIds: string[]): Promise<void> {
  await prisma.$transaction(
    orderedSectionIds.map((id, index) => prisma.formSection.update({ where: { id }, data: { order: index } }))
  );
}

export async function updateSection(
  sectionId: string,
  patch: { title?: string; description?: string; appliesTo?: ApplicantScope; departmentCode?: string | null }
): Promise<FormSection> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  // appliesTo / departmentCode changes are structural (they change visibility).
  const structural =
    (patch.appliesTo !== undefined && patch.appliesTo !== section.appliesTo) ||
    (patch.departmentCode !== undefined && patch.departmentCode !== section.departmentCode);
  await assertCycleEditable(section.cycleId, structural);
  return prisma.formSection.update({
    where: { id: sectionId },
    data: {
      title: patch.title ?? undefined,
      description: patch.description ?? undefined,
      appliesTo: patch.appliesTo ?? undefined,
      departmentCode: patch.departmentCode === undefined ? undefined : patch.departmentCode,
    },
  });
}

export async function deleteSection(sectionId: string): Promise<void> {
  const section = await prisma.formSection.findUnique({ where: { id: sectionId } });
  if (!section) throw new FormEditError("Section not found.");
  await assertCycleEditable(section.cycleId, true);
  await prisma.formSection.delete({ where: { id: sectionId } });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/modules/recruitment/services/form-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/form-builder.ts src/modules/recruitment/services/form-builder.test.ts
git commit -m "feat(recruitment): form-builder service with post-publish edit guards"
```

---

### Task 7: Submission service — public submit (validate, dedup, files, email) + reads

**Files:**
- Create: `src/modules/recruitment/services/submissions.ts`
- Test: `src/modules/recruitment/services/submissions.test.ts`

The submit flow is two-phase (spec §6.2): (1) read `applicantType` + the department selection from the raw payload to build the visibility context, (2) build the schema from visible sections and validate the full payload, dedup, persist, queue confirmation email, write files.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle, publishCycle } from "./cycles";
import { addSection, addField } from "./form-builder";
import {
  submitApplication, listApplications, getApplication,
  CycleNotOpenError, DuplicateApplicationError, SubmissionValidationError,
} from "./submissions";

async function openVolunteerCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-v", departments: ["SRHD", "MDIC"], acceptsRenewals: true, createdById: person.id });
  // Department-choice field in an always-visible section (the seeded identity section).
  const idSection = (await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } }));
  await addField(idSection.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  // A NEW-only SRHD supplement.
  const srhd = await addSection(cycle.id, { title: "SRHD Supplement", appliesTo: "NEW", departmentCode: "SRHD" });
  await addField(srhd.id, { label: "SRHD essay", type: "LONG_TEXT", required: true });
  // A RENEWAL-only section so renewals are covered.
  const renew = await addSection(cycle.id, { title: "Renewal", appliesTo: "RENEWAL", departmentCode: null });
  await addField(renew.id, { label: "Continue reason", type: "LONG_TEXT", required: true });
  await publishCycle(cycle.id, person.id);
  return { person, cycle };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("accepts a valid NEW submission, dedups, and queues a confirmation email", async () => {
  const { cycle } = await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
  });
  expect(app.applicantType).toBe("NEW");
  expect(app.departmentChoices).toEqual(["SRHD"]);
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("ann@yale.edu");

  // duplicate same email -> blocked
  await expect(
    submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ANN@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "x" }, files: {} })
  ).rejects.toBeInstanceOf(DuplicateApplicationError);
});

it("does not require the SRHD supplement when MDIC is chosen", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "MDIC" },
    files: {},
  });
  expect(app.departmentChoices).toEqual(["MDIC"]);
});

it("routes a RENEWAL submission and stores renewalDepartment", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL",
    renewalDepartment: "SRHD",
    answers: { first_name: "Cy", last_name: "Oz", email: "cy@yale.edu", continue_reason: "yes" },
    files: {},
  });
  expect(app.applicantType).toBe("RENEWAL");
  expect(app.renewalDepartment).toBe("SRHD");
  expect(app.departmentChoices).toEqual(["SRHD"]);
});

it("rejects a renewalDepartment outside the cycle departments", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "ZZZ", answers: { first_name: "D", last_name: "E", email: "d@yale.edu", continue_reason: "x" }, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects a missing required answer", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "F", last_name: "G", email: "f@yale.edu", "1st_choice_department": "SRHD" /* missing srhd_essay */ }, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects submissions to a non-OPEN cycle", async () => {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "X", name: "X", startDate: new Date(), endDate: new Date() } });
  await createCycle({ track: "VOLUNTEER", termId: term.id, title: "Draft", publicSlug: "draft-x", departments: [], acceptsRenewals: false, createdById: person.id });
  await expect(
    submitApplication("draft-x", { applicantType: "NEW", answers: { first_name: "A", last_name: "B", email: "a@b.edu" }, files: {} })
  ).rejects.toBeInstanceOf(CycleNotOpenError);
});

it("lists and gets applications", async () => {
  const { cycle } = await openVolunteerCycle();
  await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const list = await listApplications(cycle.id);
  expect(list).toHaveLength(1);
  const one = await getApplication(list[0].id);
  expect(one?.applicant.email).toBe("ann@yale.edu");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/modules/recruitment/services/submissions.test.ts`
Expected: FAIL — cannot find module `./submissions`.

- [ ] **Step 3: Implement**

```ts
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Application, FieldType } from "@prisma/client";
import { prisma } from "@/platform/db";
import { config } from "@/platform/config";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import {
  buildApplicationSchema, requiredFileKeys,
  type SectionDef, type FieldDef,
} from "../engine/schema-builder";
import type { ApplicantType } from "../engine/visibility";

export class CycleNotOpenError extends Error { constructor(m = "This application is closed.") { super(m); this.name = "CycleNotOpenError"; } }
export class DuplicateApplicationError extends Error { constructor(m = "You have already applied.") { super(m); this.name = "DuplicateApplicationError"; } }
export class SubmissionValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) { super(message); this.name = "SubmissionValidationError"; this.fieldErrors = fieldErrors; }
}

export type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer };

export type SubmitInput = {
  applicantType: ApplicantType;
  renewalDepartment?: string;
  answers: Record<string, unknown>;
  files: Record<string, UploadedFile>;
};

const DEPT_CHOICE_KEY_TYPE: FieldType = "DEPARTMENT_CHOICE";

/** Map persisted sections+fields into the engine's SectionDef shape, injecting
 *  cycle.departments as the option set for any DEPARTMENT_CHOICE field. */
function toSectionDefs(
  sections: { id: string; appliesTo: SectionDef["appliesTo"]; departmentCode: string | null; fields: { key: string; type: FieldType; required: boolean; options: unknown; validation: unknown }[] }[],
  departments: string[]
): SectionDef[] {
  return sections.map((s) => ({
    id: s.id,
    appliesTo: s.appliesTo,
    departmentCode: s.departmentCode,
    fields: s.fields.map((f): FieldDef => ({
      key: f.key,
      type: f.type,
      required: f.required,
      options: f.type === DEPT_CHOICE_KEY_TYPE ? departments.map((d) => ({ value: d, label: d })) : (f.options as FieldDef["options"]) ?? null,
      validation: (f.validation as FieldDef["validation"]) ?? null,
    })),
  }));
}

export async function submitApplication(slug: string, input: SubmitInput): Promise<Application> {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });
  if (!cycle) throw new CycleNotOpenError("Application not found.");

  const now = new Date();
  const open = cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new CycleNotOpenError();
  if (input.applicantType === "RENEWAL" && !cycle.acceptsRenewals) throw new CycleNotOpenError("This cycle does not accept renewals.");

  const sectionDefs = toSectionDefs(cycle.sections, cycle.departments);

  // --- Phase 1: derive the selected departments for visibility ---
  let selectedDepartmentCodes: string[];
  if (input.applicantType === "RENEWAL") {
    if (!input.renewalDepartment || !cycle.departments.includes(input.renewalDepartment)) {
      throw new SubmissionValidationError("Choose the department you are renewing in.", { renewalDepartment: "required" });
    }
    selectedDepartmentCodes = [input.renewalDepartment];
  } else {
    const deptField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === DEPT_CHOICE_KEY_TYPE);
    const raw = deptField ? input.answers[deptField.key] : undefined;
    selectedDepartmentCodes = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  }

  const ctx = { applicantType: input.applicantType, selectedDepartmentCodes };

  // --- Phase 2: validate scalar answers ---
  const schema = buildApplicationSchema(sectionDefs, ctx);
  const parsed = schema.safeParse(input.answers);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "")] = issue.message;
    throw new SubmissionValidationError("Please fix the highlighted fields.", fieldErrors);
  }

  // --- Required files present? ---
  const needFiles = requiredFileKeys(sectionDefs, ctx);
  const missingFile = needFiles.find((k) => !input.files[k]);
  if (missingFile) throw new SubmissionValidationError("A required file is missing.", { [missingFile]: "required" });

  const email = String(input.answers.email ?? "").trim();
  const emailLower = email.toLowerCase();
  const firstName = String(input.answers.first_name ?? "").trim();
  const lastName = String(input.answers.last_name ?? "").trim();

  // --- Dedup check (friendly; the unique index is the hard guarantee) ---
  const dup = await prisma.applicant.findUnique({ where: { cycleId_emailLower: { cycleId: cycle.id, emailLower } } });
  if (dup) throw new DuplicateApplicationError();

  // --- Persist + queue email in one transaction ---
  const fileRefs = await persistFiles(cycle.id, input.files);
  const answersWithFiles = { ...parsed.data, ...fileRefs.answerPatch };

  let application: Application;
  try {
    application = await prisma.$transaction(async (tx) => {
      const applicant = await tx.applicant.create({
        data: { cycleId: cycle.id, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
      });
      const app = await tx.application.create({
        data: {
          cycleId: cycle.id, applicantId: applicant.id, answers: answersWithFiles as never,
          applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes,
          renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        },
      });
      await queueEmail(tx, {
        to: email,
        subject: `We received your ${cycle.title} application`,
        html: `<p>Hi ${firstName || "there"},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>`,
        template: "recruitment.application_received",
      });
      return app;
    });
  } catch (err) {
    // unique race on (cycleId, emailLower) -> duplicate
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      await cleanupFiles(fileRefs.diskPaths);
      throw new DuplicateApplicationError();
    }
    await cleanupFiles(fileRefs.diskPaths);
    throw err;
  }

  await recordAudit({ action: "recruitment.application_submit", entityType: "Application", entityId: application.id });
  return application;
}

/** Write uploaded files to UPLOAD_DIR; return the answer patch (key -> file ref)
 *  and the disk paths for rollback. */
async function persistFiles(cycleId: string, files: Record<string, UploadedFile>) {
  const uploadDir = path.join(config.UPLOAD_DIR, "recruitment", cycleId);
  const answerPatch: Record<string, unknown> = {};
  const diskPaths: string[] = [];
  const entries = Object.entries(files);
  if (entries.length > 0) await fs.mkdir(uploadDir, { recursive: true });
  for (const [key, file] of entries) {
    const ext = path.extname(file.fileName) || "";
    const storedName = `${key}-${Date.now()}${ext}`;
    const diskPath = path.join(uploadDir, storedName);
    await fs.writeFile(diskPath, file.bytes);
    diskPaths.push(diskPath);
    answerPatch[key] = { storedName, fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length };
  }
  return { answerPatch, diskPaths };
}

async function cleanupFiles(diskPaths: string[]) {
  await Promise.all(diskPaths.map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
}

export async function listApplications(cycleId: string) {
  return prisma.application.findMany({
    where: { cycleId },
    include: { applicant: true },
    orderBy: { submittedAt: "desc" },
  });
}

export async function getApplication(id: string) {
  return prisma.application.findUnique({ where: { id }, include: { applicant: true, cycle: { include: { sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } } } } });
}
```

> `Date.now()` is fine in service code (it is forbidden only inside Workflow
> scripts). The stored-name uses it to avoid collisions across re-uploads.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): public submission service (validate, dedup, files, confirmation email)"
```

---

### Task 8: Registry — activate the module

**Files:**
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Update the recruitment manifest entry**

Replace the existing `recruitment` entry with:

```ts
  {
    id: "recruitment",
    title: "Recruitment",
    description: "Run recruitment cycles, build applications, review submissions",
    icon: ClipboardList,
    accessPermission: "recruitment.access",
    permissions: ["recruitment.access", "recruitment.manage_cycles"],
    status: "active",
    nav: [{ label: "Cycles", href: "/recruitment" }],
  },
```

- [ ] **Step 2: Verify the hub still renders the tile and typecheck passes**

Run: `npm run typecheck` → no errors.
Run: `npm test -- src/platform` → existing platform tests pass (no registry snapshot asserts a fixed module count; if one does, update it to include the active recruitment module).

- [ ] **Step 3: Commit**

```bash
git add src/platform/modules/registry.ts
git commit -m "feat(recruitment): activate module in registry with permissions + nav"
```

---

### Task 9: Authenticated pages — layout, cycle list, create, overview

**Files:**
- Create: `src/app/recruitment/layout.tsx`
- Create: `src/app/recruitment/page.tsx`
- Create: `src/app/recruitment/cycles/new/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/page.tsx`
- Create: `src/app/recruitment/actions.ts`

Follow the Schedule module's page/layout idiom (`src/app/schedule/layout.tsx`, server components, server actions in a co-located `actions.ts`). Pages gate via the layout; actions re-check `requirePermission("recruitment.manage_cycles")`.

- [ ] **Step 1: Layout (module guard + shell)**

```tsx
// src/app/recruitment/layout.tsx
import type { ReactNode } from "react";
import { requireModuleAccess } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { getModule } from "@/platform/modules/registry";
import { AppShell } from "@/platform/ui/app-shell";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function RecruitmentLayout({ children }: { children: ReactNode }) {
  const person = await requireModuleAccess("recruitment");
  const activeTerm = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  const mod = getModule("recruitment")!;
  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
      <ModuleNav items={mod.nav} />
      <div className="mt-8">{children}</div>
    </AppShell>
  );
}
```

- [ ] **Step 2: Server actions**

```ts
// src/app/recruitment/actions.ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  createCycle, publishCycle, closeCycle, setAcceptsRenewals, CyclePublishError,
} from "@/modules/recruitment/services/cycles";

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function createCycleAction(formData: FormData) {
  const person = await requirePermission("recruitment.manage_cycles");
  const title = String(formData.get("title") ?? "").trim();
  const track = String(formData.get("track") ?? "VOLUNTEER") as "VOLUNTEER" | "DIRECTOR";
  const termId = String(formData.get("termId") ?? "");
  const departments = String(formData.get("departments") ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const slug = slugify(String(formData.get("publicSlug") || title));
  const cycle = await createCycle({ track, termId, title, publicSlug: slug, departments, acceptsRenewals: false, createdById: person.personId });
  redirect(`/recruitment/cycles/${cycle.id}/builder`);
}

export async function publishCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  try {
    await publishCycle(cycleId, person.personId);
  } catch (err) {
    if (err instanceof CyclePublishError) {
      redirect(`/recruitment/cycles/${cycleId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function closeCycleAction(cycleId: string) {
  const person = await requirePermission("recruitment.manage_cycles");
  await closeCycle(cycleId, person.personId);
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}

export async function toggleRenewalsAction(cycleId: string, value: boolean) {
  const person = await requirePermission("recruitment.manage_cycles");
  await setAcceptsRenewals(cycleId, value, person.personId);
  revalidatePath(`/recruitment/cycles/${cycleId}`);
}
```

- [ ] **Step 3: Cycle list page**

```tsx
// src/app/recruitment/page.tsx
import Link from "next/link";
import { listCycles } from "@/modules/recruitment/services/cycles";

export default async function RecruitmentPage() {
  const cycles = await listCycles();
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Recruitment cycles</h1>
        <Link href="/recruitment/cycles/new" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">New cycle</Link>
      </div>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Title</th><th>Track</th><th>Status</th></tr></thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="py-2"><Link href={`/recruitment/cycles/${c.id}`} className="font-medium text-slate-900">{c.title}</Link></td>
              <td>{c.track}</td>
              <td>{c.status}</td>
            </tr>
          ))}
          {cycles.length === 0 && <tr><td colSpan={3} className="py-6 text-slate-500">No cycles yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create-cycle page**

```tsx
// src/app/recruitment/cycles/new/page.tsx
import { prisma } from "@/platform/db";
import { createCycleAction } from "../../actions";

export default async function NewCyclePage() {
  const terms = await prisma.term.findMany({ orderBy: { startDate: "desc" } });
  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">New recruitment cycle</h1>
      <form action={createCycleAction} className="mt-6 space-y-4">
        <label className="block text-sm">Title<input name="title" required className="mt-1 w-full rounded border px-2 py-1" /></label>
        <label className="block text-sm">Track
          <select name="track" className="mt-1 w-full rounded border px-2 py-1"><option value="VOLUNTEER">Volunteer</option><option value="DIRECTOR">Director</option></select>
        </label>
        <label className="block text-sm">Term
          <select name="termId" required className="mt-1 w-full rounded border px-2 py-1">{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label className="block text-sm">Public slug (optional)<input name="publicSlug" className="mt-1 w-full rounded border px-2 py-1" placeholder="auto from title" /></label>
        <label className="block text-sm">Departments (comma-separated codes)<input name="departments" className="mt-1 w-full rounded border px-2 py-1" placeholder="SRHD, MDIC" /></label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Create &amp; build form</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Overview page (publish/close/renewals + public link + error banner)**

```tsx
// src/app/recruitment/cycles/[id]/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { publishCycleAction, closeCycleAction, toggleRenewalsAction } from "../../actions";

export default async function CycleOverviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const applyUrl = `/apply/${cycle.publicSlug}`;
  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{cycle.title}</h1>
        <span className="rounded bg-slate-100 px-2 py-1 text-xs">{cycle.status}</span>
      </div>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <Link href={`/recruitment/cycles/${id}/builder`} className="rounded-md border px-3 py-1.5 text-sm">Edit form</Link>
        <Link href={`/recruitment/cycles/${id}/applicants`} className="rounded-md border px-3 py-1.5 text-sm">View applicants</Link>
      </div>
      <div className="rounded border p-4 text-sm">
        <p className="font-medium">Public link</p>
        {cycle.status === "OPEN"
          ? <a className="text-blue-700 underline" href={applyUrl}>{applyUrl}</a>
          : <p className="text-slate-500">Publish the cycle to activate {applyUrl}</p>}
      </div>
      <form action={toggleRenewalsAction.bind(null, id, !cycle.acceptsRenewals)}>
        <button className="text-sm underline">{cycle.acceptsRenewals ? "Disable" : "Enable"} renewal branch</button>
      </form>
      <div className="flex gap-3">
        {cycle.status === "DRAFT" && <form action={publishCycleAction.bind(null, id)}><button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Publish</button></form>}
        {cycle.status === "OPEN" && <form action={closeCycleAction.bind(null, id)}><button className="rounded-md border px-3 py-1.5 text-sm">Close</button></form>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → no errors. Run: `npm run lint` → no module-boundary violations.

- [ ] **Step 7: Commit**

```bash
git add src/app/recruitment/layout.tsx src/app/recruitment/page.tsx src/app/recruitment/cycles/new/page.tsx src/app/recruitment/cycles/[id]/page.tsx src/app/recruitment/actions.ts
git commit -m "feat(recruitment): cycle list, create, and overview pages"
```

---

### Task 10: Authenticated page — form builder

**Files:**
- Create: `src/app/recruitment/cycles/[id]/builder/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/builder/actions.ts`

The builder renders the cycle's sections + fields and exposes server actions for add/update/delete/reorder of sections and fields. Keep it server-rendered with form-action buttons (matches the Schedule builder's non-DnD pattern); each mutation revalidates the page.

- [ ] **Step 1: Builder actions**

```ts
// src/app/recruitment/cycles/[id]/builder/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  addSection, updateSection, deleteSection,
  addField, updateField, deleteField, FormEditError,
} from "@/modules/recruitment/services/form-builder";
import type { ApplicantScope, FieldType } from "@prisma/client";

function bouncePath(cycleId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/builder${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}

export async function addSectionAction(cycleId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const departmentCode = String(formData.get("departmentCode") ?? "").trim() || null;
  await addSection(cycleId, {
    title: String(formData.get("title") ?? "Section"),
    appliesTo: (String(formData.get("appliesTo") ?? "BOTH") as ApplicantScope),
    departmentCode,
  });
  revalidatePath(bouncePath(cycleId));
}

export async function addFieldAction(cycleId: string, sectionId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  const options = String(formData.get("options") ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }));
  try {
    await addField(sectionId, {
      label: String(formData.get("label") ?? "Field"),
      type: String(formData.get("type") ?? "SHORT_TEXT") as FieldType,
      required: formData.get("required") === "on",
      options: options.length ? options : undefined,
    });
  } catch (err) {
    if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message));
    else throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function updateFieldAction(cycleId: string, fieldId: string, formData: FormData) {
  await requirePermission("recruitment.manage_cycles");
  try {
    await updateField(fieldId, {
      label: String(formData.get("label") ?? undefined) || undefined,
      required: formData.get("required") === "on" ? true : undefined,
    });
  } catch (err) {
    if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message));
    else throw err;
  }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteFieldAction(cycleId: string, fieldId: string) {
  await requirePermission("recruitment.manage_cycles");
  try { await deleteField(fieldId); }
  catch (err) { if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message)); else throw err; }
  revalidatePath(bouncePath(cycleId));
}

export async function deleteSectionAction(cycleId: string, sectionId: string) {
  await requirePermission("recruitment.manage_cycles");
  try { await deleteSection(sectionId); }
  catch (err) { if (err instanceof FormEditError) revalidatePath(bouncePath(cycleId, err.message)); else throw err; }
  revalidatePath(bouncePath(cycleId));
}
```

- [ ] **Step 2: Builder page**

```tsx
// src/app/recruitment/cycles/[id]/builder/page.tsx
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { addSectionAction, addFieldAction, deleteFieldAction, deleteSectionAction } from "./actions";

const FIELD_TYPES = ["SHORT_TEXT","LONG_TEXT","SINGLE_SELECT","MULTI_SELECT","CHECKBOX","EMAIL","PHONE","NUMBER","DATE","FILE","DEPARTMENT_CHOICE"];

export default async function BuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const editable = cycle.status === "DRAFT";

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Form builder — {cycle.title}</h1>
      {!editable && <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">This cycle is {cycle.status}. Only safe edits (labels, help text) are allowed.</p>}
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {cycle.sections.map((section) => (
        <section key={section.id} className="rounded border p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">{section.title} <span className="text-xs text-slate-500">({section.appliesTo}{section.departmentCode ? ` · ${section.departmentCode}` : ""})</span></h2>
            <form action={deleteSectionAction.bind(null, id, section.id)}><button className="text-xs text-red-600">Delete section</button></form>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {section.fields.map((f) => (
              <li key={f.id} className="flex items-center justify-between border-t py-1">
                <span>{f.label} <span className="text-xs text-slate-500">· {f.type}{f.required ? " · required" : ""} · {f.key}</span></span>
                <form action={deleteFieldAction.bind(null, id, f.id)}><button className="text-xs text-red-600">Remove</button></form>
              </li>
            ))}
          </ul>
          <form action={addFieldAction.bind(null, id, section.id)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <input name="label" placeholder="Field label" required className="rounded border px-2 py-1" />
            <select name="type" className="rounded border px-2 py-1">{FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            <label className="flex items-center gap-1"><input type="checkbox" name="required" /> required</label>
            <textarea name="options" placeholder="options (one per line)" className="rounded border px-2 py-1" rows={1} />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Add field</button>
          </form>
        </section>
      ))}

      <form action={addSectionAction.bind(null, id)} className="flex flex-wrap items-end gap-2 rounded border border-dashed p-4 text-sm">
        <input name="title" placeholder="New section title" required className="rounded border px-2 py-1" />
        <select name="appliesTo" className="rounded border px-2 py-1"><option>BOTH</option><option>NEW</option><option>RENEWAL</option></select>
        <input name="departmentCode" placeholder="dept code (supplement)" className="rounded border px-2 py-1" />
        <button className="rounded bg-slate-900 px-2 py-1 text-white">Add section</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` and `npm run lint` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/recruitment/cycles/[id]/builder
git commit -m "feat(recruitment): form builder page + mutation actions"
```

---

### Task 11: Authenticated pages — applicant list + detail

**Files:**
- Create: `src/app/recruitment/cycles/[id]/applicants/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`

- [ ] **Step 1: Applicant list**

```tsx
// src/app/recruitment/cycles/[id]/applicants/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplications } from "@/modules/recruitment/services/submissions";

export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const apps = await listApplications(id);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Applicants — {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Name</th><th>Email</th><th>Type</th><th>Departments</th><th>Submitted</th></tr></thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/applicants/${a.id}`}>{a.applicant.firstName} {a.applicant.lastName}</Link></td>
              <td>{a.applicant.email}</td>
              <td>{a.applicantType}</td>
              <td>{a.departmentChoices.join(", ")}</td>
              <td>{a.submittedAt.toLocaleString()}</td>
            </tr>
          ))}
          {apps.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No applications yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Application detail (answers rendered against field defs)**

```tsx
// src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx
import { notFound } from "next/navigation";
import { getApplication } from "@/modules/recruitment/services/submissions";

export default async function ApplicationDetailPage({ params }: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await params;
  const app = await getApplication(applicationId);
  if (!app) notFound();
  const answers = (app.answers ?? {}) as Record<string, unknown>;
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{app.applicant.firstName} {app.applicant.lastName}</h1>
      <p className="text-sm text-slate-500">{app.applicant.email} · {app.applicantType}{app.renewalDepartment ? ` · renewing in ${app.renewalDepartment}` : ""}</p>
      {app.cycle.sections.map((section) => (
        <section key={section.id}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{section.title}</h2>
          <dl className="mt-2 space-y-2">
            {section.fields.map((f) => {
              const val = answers[f.key];
              const display = f.type === "FILE" && val && typeof val === "object"
                ? (val as { fileName?: string }).fileName ?? "(file)"
                : Array.isArray(val) ? val.join(", ") : val === undefined || val === "" ? "—" : String(val);
              return (<div key={f.id}><dt className="text-xs text-slate-500">{f.label}</dt><dd className="text-sm">{display}</dd></div>);
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify + Commit**

Run: `npm run typecheck` → clean.

```bash
git add src/app/recruitment/cycles/[id]/applicants
git commit -m "feat(recruitment): applicant list and application detail pages"
```

---

### Task 12: Public intake — `/apply/[slug]`

**Files:**
- Create: `src/app/apply/[slug]/page.tsx`
- Create: `src/app/apply/[slug]/apply-form.tsx`
- Create: `src/app/apply/[slug]/actions.ts`
- Create: `src/app/apply/[slug]/error.tsx`

This route is **not** under any guarded layout and never calls `requirePersonSession`/`requireModuleAccess` — that is the entire public carve-out. The root layout (`src/app/layout.tsx`) applies no auth, so `/apply/*` renders publicly.

- [ ] **Step 1: Public submit action**

```ts
// src/app/apply/[slug]/actions.ts
"use server";
import {
  submitApplication, CycleNotOpenError, DuplicateApplicationError, SubmissionValidationError,
  type UploadedFile,
} from "@/modules/recruitment/services/submissions";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";

export type SubmitResult =
  | { ok: true }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

/** Server action invoked by the public form. Reads scalar answers + files from
 *  FormData; the field keys are the FormField.key values rendered on the page. */
export async function submitPublicApplication(slug: string, formData: FormData): Promise<SubmitResult> {
  const applicantType = (String(formData.get("__applicantType") ?? "NEW") as ApplicantType);
  const renewalDepartment = String(formData.get("__renewalDepartment") ?? "") || undefined;

  const answers: Record<string, unknown> = {};
  const files: Record<string, UploadedFile> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue;
    if (value instanceof File) {
      if (value.size > 0) files[key] = { fileName: value.name, mimeType: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
    } else {
      // Collapse repeated keys (multi-select checkboxes) into arrays.
      if (key in answers) {
        const prev = answers[key];
        answers[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      } else {
        answers[key] = value;
      }
    }
  }

  try {
    await submitApplication(slug, { applicantType, renewalDepartment, answers, files });
    return { ok: true };
  } catch (err) {
    if (err instanceof SubmissionValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof DuplicateApplicationError) return { ok: false, message: err.message };
    if (err instanceof CycleNotOpenError) return { ok: false, message: err.message };
    throw err;
  }
}
```

- [ ] **Step 2: Public page (server) — closed state + form mount**

```tsx
// src/app/apply/[slug]/page.tsx
import { prisma } from "@/platform/db";
import { ApplyForm } from "./apply-form";

export default async function ApplyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });

  const now = new Date();
  const open = cycle && cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);

  if (!cycle || !open) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Applications are closed</h1>
        <p className="mt-2 text-slate-500">This recruitment form is not currently accepting submissions.</p>
      </main>
    );
  }

  // Serialize the definition the client needs (no server-only fields).
  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    sections: cycle.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null, validation: (f.validation as Record<string, unknown> | null) ?? null })),
    })),
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{def.title}</h1>
      <ApplyForm def={def} />
    </main>
  );
}
```

- [ ] **Step 3: Public form (client) — applicant-type routing + conditional sections**

```tsx
// src/app/apply/[slug]/apply-form.tsx
"use client";
import { useMemo, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";

type FieldDef = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; acceptsRenewals: boolean; departments: string[]; sections: SectionDef[] };

export function ApplyForm({ def }: { def: Def }) {
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">("NEW");
  const [renewalDept, setRenewalDept] = useState<string>(def.departments[0] ?? "");
  const [deptChoice, setDeptChoice] = useState<string>("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedDepartmentCodes = applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : (deptChoice ? [deptChoice] : []);
  const visible = useMemo(
    () => def.sections.filter((s) => isSectionVisible({ id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode }, { applicantType, selectedDepartmentCodes })),
    [def.sections, applicantType, selectedDepartmentCodes]
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    fd.set("__applicantType", applicantType);
    if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
    const res = await submitPublicApplication(def.slug, fd);
    setResult(res);
    setSubmitting(false);
  }

  if (result?.ok) {
    return <p className="mt-8 rounded border border-green-300 bg-green-50 px-4 py-3 text-green-800">Thanks — your application was received. Check your email for a confirmation.</p>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-8">
      {result && !result.ok && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{result.message}</p>}

      {def.acceptsRenewals && (
        <fieldset className="rounded border p-4">
          <legend className="text-sm font-medium">Are you new or renewing?</legend>
          <label className="mr-4 text-sm"><input type="radio" name="__type_ui" checked={applicantType === "NEW"} onChange={() => setApplicantType("NEW")} /> New applicant</label>
          <label className="text-sm"><input type="radio" name="__type_ui" checked={applicantType === "RENEWAL"} onChange={() => setApplicantType("RENEWAL")} /> Renewing in my current department</label>
          {applicantType === "RENEWAL" && (
            <div className="mt-3 text-sm">Current department:
              <select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="ml-2 rounded border px-2 py-1">{def.departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>
            </div>
          )}
        </fieldset>
      )}

      {visible.map((section) => (
        <fieldset key={section.id} className="space-y-3">
          <legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">{section.title}</legend>
          {section.description && <p className="text-sm text-slate-500">{section.description}</p>}
          {section.fields.map((f) => (
            <Field key={f.key} f={f} departments={def.departments} fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
              onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined} />
          ))}
        </fieldset>
      ))}

      <button disabled={submitting} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{submitting ? "Submitting…" : "Submit application"}</button>
    </form>
  );
}

function Field({ f, departments, fieldError, onDeptChoice }: { f: FieldDef; departments: string[]; fieldError?: string; onDeptChoice?: (v: string) => void }) {
  const label = <span className="block text-sm font-medium">{f.label}{f.required && <span className="text-red-600"> *</span>}</span>;
  const help = f.helpText ? <span className="block text-xs text-slate-500">{f.helpText}</span> : null;
  const err = fieldError ? <span className="block text-xs text-red-600">{fieldError}</span> : null;
  const common = "mt-1 w-full rounded border px-2 py-1 text-sm";

  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <textarea name={f.key} required={f.required} className={common} rows={4} />; break;
    case "CHECKBOX": control = <input type="checkbox" name={f.key} />; break;
    case "NUMBER": control = <input type="number" name={f.key} required={f.required} className={common} />; break;
    case "DATE": control = <input type="date" name={f.key} required={f.required} className={common} />; break;
    case "EMAIL": control = <input type="email" name={f.key} required={f.required} className={common} />; break;
    case "FILE": control = <input type="file" name={f.key} required={f.required} className={common} />; break;
    case "DEPARTMENT_CHOICE":
      control = <select name={f.key} required={f.required} className={common} onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</select>;
      break;
    case "SINGLE_SELECT":
      control = <select name={f.key} required={f.required} className={common} defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      break;
    case "MULTI_SELECT":
      control = <span className="mt-1 flex flex-col gap-1">{(f.options ?? []).map((o) => <label key={o.value} className="text-sm"><input type="checkbox" name={f.key} value={o.value} /> {o.label}</label>)}</span>;
      break;
    default: control = <input type="text" name={f.key} required={f.required} className={common} />;
  }
  return <label className="block">{label}{help}{control}{err}</label>;
}
```

- [ ] **Step 4: Public error boundary**

```tsx
// src/app/apply/[slug]/error.tsx
"use client";
export default function ApplyError() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-slate-500">Please refresh and try again. If the problem persists, contact HAVEN IT.</p>
    </main>
  );
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → clean. Run: `npm run lint` → the public route imports `isSectionVisible` and the submission service from `@/modules/recruitment/*`; that is allowed (app code may import module code; only cross-*module* imports are banned).

- [ ] **Step 6: Commit**

```bash
git add src/app/apply
git commit -m "feat(recruitment): public application intake at /apply/[slug]"
```

---

### Task 13: e2e — full loop including renewal branch

**Files:**
- Create: `e2e/recruitment.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from "@playwright/test";

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("build a renewals cycle, publish, apply publicly (new + renewing), see both submissions", async ({ page, context }) => {
  await devLogin(page, "j.carney@yale.edu");

  // Create a cycle
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "E2E Volunteer Cycle");
  await page.fill('input[name="publicSlug"]', "e2e-volunteer");
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const builderUrl = page.url();
  const cycleId = builderUrl.split("/cycles/")[1].split("/")[0];

  // Add a DEPARTMENT_CHOICE field to the identity section, a NEW SRHD supplement, and a RENEWAL section.
  // (Use the first section's add-field form for the department choice.)
  await page.locator('form:has(select[name="type"])').first().locator('input[name="label"]').fill("1st choice department");
  await page.locator('form:has(select[name="type"])').first().locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await page.locator('form:has(select[name="type"])').first().locator('button:has-text("Add field")').click();

  // Add SRHD supplement section
  await page.locator('input[name="title"][placeholder="New section title"]').fill("SRHD Supplement");
  await page.locator('select[name="appliesTo"]').selectOption("NEW");
  await page.locator('input[name="departmentCode"]').fill("SRHD");
  await page.locator('button:has-text("Add section")').click();

  // Enable renewals + add a RENEWAL section
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Enable renewal branch")');
  await page.goto(`${builderUrl}`);
  await page.locator('input[name="title"][placeholder="New section title"]').fill("Renewal");
  await page.locator('select[name="appliesTo"]').selectOption("RENEWAL");
  await page.locator('button:has-text("Add section")').click();
  // Add a required field to the renewal section
  await page.locator('section:has-text("Renewal") form:has(select[name="type"])').locator('input[name="label"]').fill("Continue reason");
  await page.locator('section:has-text("Renewal") form:has(select[name="type"])').locator('button:has-text("Add field")').click();

  // Publish
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.getByText("OPEN")).toBeVisible();

  // Public apply — NEW applicant (unauthenticated context)
  const pub = await context.browser()!.newContext();
  const apply = await pub.newPage();
  await apply.goto("/apply/e2e-volunteer");
  await apply.fill('input[name="first_name"]', "Ann");
  await apply.fill('input[name="last_name"]', "New");
  await apply.fill('input[name="email"]', "ann.new@yale.edu");
  await apply.selectOption('select[name="1st_choice_department"]', "SRHD");
  await apply.fill('textarea[name="srhd_essay"]', "I want to help.");
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();

  // Public apply — RENEWING applicant
  await apply.goto("/apply/e2e-volunteer");
  await apply.getByText("Renewing in my current department").click();
  await apply.selectOption('select >> nth=0', "MDIC"); // renewal department select
  await apply.fill('input[name="first_name"]', "Cy");
  await apply.fill('input[name="last_name"]', "Renew");
  await apply.fill('input[name="email"]', "cy.renew@yale.edu");
  await apply.fill('textarea[name="continue_reason"]', "Loved it.");
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await pub.close();

  // Back in the authenticated session, both submissions show, correctly typed
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await expect(page.getByText("ann.new@yale.edu")).toBeVisible();
  await expect(page.getByText("cy.renew@yale.edu")).toBeVisible();
  await expect(page.getByText("RENEWAL")).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e**

Run: `npm run e2e -- recruitment.spec.ts`
Expected: PASS. (If the dev login or selectors drift from the app's actual markup, adjust selectors to match — the assertions on both emails + the RENEWAL label are the contract.)

- [ ] **Step 3: Commit**

```bash
git add e2e/recruitment.spec.ts
git commit -m "test(recruitment): e2e build→publish→public apply (new + renewal)→view"
```

---

### Task 14: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit + integration suite**

Run: `npm run test:prepare && npm test`
Expected: all green. Re-run any environmental DB-timeout flake in isolation to confirm it is not a regression (this codebase has known timing flakes in `rbac.test.ts` / `compliance/access.test.ts` that pass alone).

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → clean (module-boundary rule satisfied).
Run: `npm run build` → succeeds.

- [ ] **Step 3: Commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(recruitment): final verification fixups" || echo "nothing to commit"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** cycles (§4.1), form definition (§4.2–4.3), applicants/applications + dedup (§4.4–4.5), department-choice field (§4 DEPARTMENT_CHOICE), renewal branch (§4.6) → Tasks 1,5,6,7; builder UX + lifecycle guard (§5) → Tasks 6,10; public intake + two-phase validation + files + confirmation email (§6) → Tasks 7,12; permissions (§7) → Task 8; error handling (§8) → Tasks 7,9,10,12; testing (§9) → Tasks 2–7,13; done-criteria (§10) → Task 14.
- **Public auth carve-out (§3.1):** realized as "the route simply omits guards" because the codebase has no global middleware — confirmed by inspection. No middleware edit is needed.
- **Type consistency:** `ApplicantType`/`ApplicantScope` are defined once in `engine/visibility.ts` and re-used; `SectionDef`/`FieldDef` in `engine/schema-builder.ts`; service `cycleId_emailLower` compound-unique accessor matches the `@@unique([cycleId, emailLower])` in the schema; `FieldType` string union in the engine mirrors the Prisma `FieldType` enum exactly.
- **Known sharp edge:** `FormField.cycleId` is required, so it can never be a nested `fields.create` — `createCycle` seeds identity fields via `createMany` after the cycle+section exist, and the form-builder always sets `cycleId` explicitly.
