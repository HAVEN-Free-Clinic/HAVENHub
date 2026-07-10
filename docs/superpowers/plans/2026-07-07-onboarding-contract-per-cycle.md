# Per-cycle editable onboarding contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins edit the onboarding contract (sent via "Send onboarding links") — both its prose agreements and its fields — per recruitment cycle, without changing the downstream promotion/compliance pipeline.

**Architecture:** The contract becomes an ordered JSON **layout** of typed blocks (`system_field` | `agreement` | `custom_question`), resolved per cycle via `cycle override ?? global default ?? code default` (mirrors the recruitment email pattern). The resolved layout is snapshotted onto each `OnboardingContract` at send time; `/onboard/[token]` renders from that snapshot. System-field blocks keep writing their existing typed columns, so `promotion.ts` is untouched.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Zod v4, React client components, existing `@/platform/ui/*` primitives and recruitment form-builder components.

## Global Constraints

- **Product naming:** "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`. No em-dashes in copy (an ESLint rule enforces this).
- **DB migrations:** Never run `prisma migrate`/vitest `resetDb` against the repo `.env` URLs — they point at shared Neon and would wipe it. Author migration SQL by hand and trim any pre-existing drift (`prisma migrate dev` folds unrelated drift into new migrations). New nullable `Json?` columns need no default.
- **DB-backed tests run in CI only.** Vitest in a worktree uses a stale shared Prisma client; do not `prisma generate` locally. Design service logic so the *pure* parts (layout resolution merge, zod validation, default-layout parity, block mutation on in-memory structures) are unit-testable without a DB. DB-backed `*.test.ts` are written but verified in CI.
- **XSS:** Agreement prose is admin-authored but shown to unauthenticated applicants. Render it as **escaped text** with preserved paragraph/line breaks (never `dangerouslySetInnerHTML`). Do NOT add a markdown/sanitizer dependency. Variable substitution (`{{firstName}}`, `{{orgName}}`) uses the existing `renderTemplate` from `@/platform/email/render/render`, whose output is still rendered as escaped text.
- **Permissions:** Per-cycle contract editing is gated on `recruitment.manage_cycles`; the global master editor on the same permission that guards `/admin/settings`. Sending links stays on `recruitment.review_all`.
- **Editing is NOT gated on cycle status** (unlike the application form's DRAFT gate): snapshotting protects already-sent contracts. Archived cycles remain read-only.

---

## File Structure

New module `src/modules/recruitment/contract/`:
- `layout.ts` — `ContractLayout`/`ContractBlock` TS types + `contractLayoutSchema` (zod). One responsibility: the layout shape and its validation.
- `system-fields.ts` — `SYSTEM_FIELDS` registry (system key → core?/label/renderer/columns) + `DEFAULT_CONTRACT_LAYOUT`.
- `resolve.ts` — `resolveContractLayout(cycleId)` and `getContractLayoutForEdit(...)`.
- `template.ts` — per-cycle + global mutation service (materialize override, block CRUD, reset, save global).

Modified backend:
- `prisma/schema.prisma` — new `RecruitmentCycleContract`, new `OnboardingContract` columns, relation.
- `src/platform/settings/registry.ts` — `onboarding.contractTemplate` setting.
- `src/modules/recruitment/services/onboarding.ts` — snapshot on send; submit persists `customAnswers`/`signatures`.

Modified/new UI:
- `src/app/onboard/[token]/page.tsx` + `onboard-form.tsx` + new `contract-field.tsx` — layout-driven render.
- `src/app/(app)/recruitment/cycles/[id]/builder/contract/` — per-cycle editor (page + client editor + actions).
- `src/app/(app)/recruitment/cycles/[id]/page.tsx` — "Edit contract" link.
- `src/app/(app)/admin/contract/` — global master editor (page + actions), reusing the editor component.

---

# Phase 1 — Structural core (parity)

Delivers `/onboard` rendered from a layout with identical behavior to today, plus the snapshot pipeline. No editing UI yet. This is the highest-risk phase; keep it a pure refactor with parity tests.

### Task 1.1: Schema — layout storage columns and per-cycle override table

**Files:**
- Modify: `prisma/schema.prisma` (`OnboardingContract` model ~1011-1054; `RecruitmentCycle` model ~867-896)
- Create: `prisma/migrations/<timestamp>_onboarding_contract_layout/migration.sql`

**Interfaces:**
- Produces: `RecruitmentCycleContract` model; `OnboardingContract.templateSnapshot/customAnswers/signatures` (`Json?`); `RecruitmentCycle.contract` relation.

- [ ] **Step 1: Add the new model and columns to the schema**

Add to `OnboardingContract` (after `updatedAt`, before the relations block):
```prisma
  templateSnapshot Json?
  customAnswers    Json?
  signatures       Json?
```
Add the relation line to `RecruitmentCycle` (in its relations block, beside `cycleEmails`):
```prisma
  contract     RecruitmentCycleContract?
```
Add the new model after `RecruitmentCycle`:
```prisma
model RecruitmentCycleContract {
  id        String   @id @default(cuid())
  cycleId   String   @unique
  layout    Json
  updatedAt DateTime @updatedAt

  cycle RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Hand-author the migration SQL** (do NOT run `prisma migrate dev` against Neon)

`prisma/migrations/<timestamp>_onboarding_contract_layout/migration.sql`:
```sql
ALTER TABLE "OnboardingContract"
  ADD COLUMN "templateSnapshot" JSONB,
  ADD COLUMN "customAnswers" JSONB,
  ADD COLUMN "signatures" JSONB;

CREATE TABLE "RecruitmentCycleContract" (
  "id" TEXT NOT NULL,
  "cycleId" TEXT NOT NULL,
  "layout" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecruitmentCycleContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecruitmentCycleContract_cycleId_key" ON "RecruitmentCycleContract"("cycleId");

ALTER TABLE "RecruitmentCycleContract"
  ADD CONSTRAINT "RecruitmentCycleContract_cycleId_fkey"
  FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Verify the schema is valid**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(contract): schema for per-cycle onboarding contract layout + snapshot"
```

---

### Task 1.2: Layout types and zod validation

**Files:**
- Create: `src/modules/recruitment/contract/layout.ts`
- Test: `src/modules/recruitment/contract/layout.test.ts`

**Interfaces:**
- Consumes: `FieldType` from `@prisma/client`.
- Produces:
  - `type ContractLayout = { blocks: ContractBlock[] }`
  - `type ContractBlock` union (see below)
  - `type SystemFieldKey` (string union)
  - `contractLayoutSchema: z.ZodType<ContractLayout>`
  - `parseContractLayout(value: unknown): ContractLayout` (throws `ContractLayoutError` on invalid)
  - `class ContractLayoutError extends Error { problems: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseContractLayout, ContractLayoutError } from "./layout";

describe("parseContractLayout", () => {
  it("accepts a minimal valid layout", () => {
    const layout = parseContractLayout({
      blocks: [
        { kind: "system_field", systemKey: "name" },
        { kind: "agreement", id: "a1", title: "Agreement", body: "", signatureLabel: "type your name" },
        { kind: "custom_question", key: "tshirt", label: "T-shirt size", type: "SHORT_TEXT", required: false },
      ],
    });
    expect(layout.blocks).toHaveLength(3);
  });

  it("rejects an unknown system key", () => {
    expect(() => parseContractLayout({ blocks: [{ kind: "system_field", systemKey: "nope" }] }))
      .toThrow(ContractLayoutError);
  });

  it("rejects duplicate custom-question keys", () => {
    expect(() => parseContractLayout({ blocks: [
      { kind: "custom_question", key: "q", label: "A", type: "SHORT_TEXT", required: false },
      { kind: "custom_question", key: "q", label: "B", type: "SHORT_TEXT", required: false },
    ] })).toThrow(ContractLayoutError);
  });

  it("rejects a custom-question key that collides with a system key", () => {
    expect(() => parseContractLayout({ blocks: [
      { kind: "custom_question", key: "email", label: "Email", type: "EMAIL", required: true },
    ] })).toThrow(ContractLayoutError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/modules/recruitment/contract/layout.test.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Implement `layout.ts`**

```ts
import { z } from "zod";
import type { FieldType } from "@prisma/client";
import { SYSTEM_FIELD_KEYS } from "./system-fields";

export type SystemFieldKey = (typeof SYSTEM_FIELD_KEYS)[number];

export type SystemFieldBlock = {
  kind: "system_field";
  systemKey: SystemFieldKey;
  label?: string;
  helpText?: string;
  enabled?: boolean; // optional fields only; core fields ignore this
};
export type AgreementBlock = {
  kind: "agreement";
  id: string;
  title: string;
  body: string;
  signatureLabel: string;
};
export type CustomQuestionBlock = {
  kind: "custom_question";
  key: string;
  label: string;
  helpText?: string;
  type: FieldType;
  required: boolean;
  options?: { value: string; label: string }[];
};
export type ContractBlock = SystemFieldBlock | AgreementBlock | CustomQuestionBlock;
export type ContractLayout = { blocks: ContractBlock[] };

export class ContractLayoutError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "ContractLayoutError";
    this.problems = problems;
  }
}

const FIELD_TYPES: [FieldType, ...FieldType[]] = [
  "SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT", "CHECKBOX",
  "EMAIL", "PHONE", "NUMBER", "DATE", "FILE", "DEPARTMENT_CHOICE", "SUBCOMMITTEE_RANK",
];

const optionSchema = z.object({ value: z.string().min(1), label: z.string().min(1) });

const blockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system_field"),
    systemKey: z.enum(SYSTEM_FIELD_KEYS),
    label: z.string().optional(),
    helpText: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("agreement"),
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    signatureLabel: z.string().min(1),
  }),
  z.object({
    kind: z.literal("custom_question"),
    key: z.string().regex(/^[a-z0-9_]+$/, "key must be lowercase alphanumeric/underscore"),
    label: z.string().min(1),
    helpText: z.string().optional(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    options: z.array(optionSchema).optional(),
  }),
]);

export const contractLayoutSchema: z.ZodType<ContractLayout> = z.object({
  blocks: z.array(blockSchema),
});

export function parseContractLayout(value: unknown): ContractLayout {
  const parsed = contractLayoutSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractLayoutError(parsed.error.issues.map((i) => i.message));
  }
  const layout = parsed.data;
  const problems: string[] = [];

  // custom-question keys unique and disjoint from system keys
  const seen = new Set<string>();
  const systemKeySet = new Set<string>(SYSTEM_FIELD_KEYS);
  for (const b of layout.blocks) {
    if (b.kind !== "custom_question") continue;
    if (systemKeySet.has(b.key)) problems.push(`Custom question key "${b.key}" collides with a system field.`);
    if (seen.has(b.key)) problems.push(`Duplicate custom question key "${b.key}".`);
    seen.add(b.key);
  }
  // agreement ids unique
  const seenAgreements = new Set<string>();
  for (const b of layout.blocks) {
    if (b.kind !== "agreement") continue;
    if (seenAgreements.has(b.id)) problems.push(`Duplicate agreement id "${b.id}".`);
    seenAgreements.add(b.id);
  }
  if (problems.length) throw new ContractLayoutError(problems);
  return layout;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/modules/recruitment/contract/layout.test.ts`
Expected: PASS (all 4). (This test is pure — no DB — so it runs locally.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/layout.ts src/modules/recruitment/contract/layout.test.ts
git commit -m "feat(contract): contract layout types + zod validation"
```

---

### Task 1.3: System-field registry and the default layout

**Files:**
- Create: `src/modules/recruitment/contract/system-fields.ts`
- Test: `src/modules/recruitment/contract/system-fields.test.ts`

**Interfaces:**
- Produces:
  - `const SYSTEM_FIELD_KEYS = [...] as const` (consumed by `layout.ts`)
  - `type SystemFieldSpec = { key; core: boolean; defaultLabel: string; render: SystemRenderKind; columns: string[] }`
  - `const SYSTEM_FIELDS: Record<SystemFieldKey, SystemFieldSpec>`
  - `const DEFAULT_CONTRACT_LAYOUT: ContractLayout`
  - `type SystemRenderKind = "text" | "email" | "tel" | "date" | "checkbox" | "epicBlock" | "hipaaBlock"`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, DEFAULT_CONTRACT_LAYOUT } from "./system-fields";
import { parseContractLayout } from "./layout";

describe("system fields + default layout", () => {
  it("marks name, email, epic, hipaa as core", () => {
    expect(SYSTEM_FIELDS.name.core).toBe(true);
    expect(SYSTEM_FIELDS.email.core).toBe(true);
    expect(SYSTEM_FIELDS.epic.core).toBe(true);
    expect(SYSTEM_FIELDS.hipaa.core).toBe(true);
  });

  it("DEFAULT_CONTRACT_LAYOUT validates and reproduces today's fields", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    const systemKeys = layout.blocks.filter((b) => b.kind === "system_field").map((b: any) => b.systemKey);
    // parity: every field on today's onboard-form is represented
    for (const k of ["name","email","netId","phone","dob","dietary","yaleAffiliation","gradYear","epic","spanish","licensedRN","hipaa","initials"]) {
      expect(systemKeys).toContain(k);
    }
    const agreements = layout.blocks.filter((b) => b.kind === "agreement").map((b: any) => b.id);
    expect(agreements).toEqual(["agreement", "professionalism", "training"]);
  });

  it("default agreement bodies are empty for parity with today's form", () => {
    const layout = parseContractLayout(DEFAULT_CONTRACT_LAYOUT);
    for (const b of layout.blocks) if (b.kind === "agreement") expect(b.body).toBe("");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/modules/recruitment/contract/system-fields.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `system-fields.ts`**

```ts
import type { ContractLayout } from "./layout";

export const SYSTEM_FIELD_KEYS = [
  "name", "email", "netId", "phone", "dob", "dietary", "yaleAffiliation",
  "gradYear", "epic", "spanish", "licensedRN", "hipaa", "initials",
] as const;

export type SystemRenderKind =
  | "text" | "email" | "tel" | "date" | "checkbox" | "epicBlock" | "hipaaBlock";

export type SystemFieldSpec = {
  key: (typeof SYSTEM_FIELD_KEYS)[number];
  core: boolean;
  defaultLabel: string;
  render: SystemRenderKind;
  columns: string[];
};

export const SYSTEM_FIELDS: Record<(typeof SYSTEM_FIELD_KEYS)[number], SystemFieldSpec> = {
  name:            { key: "name", core: true, defaultLabel: "Your name", render: "text", columns: ["firstName", "lastName"] },
  email:           { key: "email", core: true, defaultLabel: "Email", render: "email", columns: ["email"] },
  netId:           { key: "netId", core: false, defaultLabel: "NetID", render: "text", columns: ["netId"] },
  phone:           { key: "phone", core: false, defaultLabel: "Phone", render: "tel", columns: ["phone"] },
  dob:             { key: "dob", core: false, defaultLabel: "Date of birth", render: "date", columns: ["dateOfBirth"] },
  dietary:         { key: "dietary", core: false, defaultLabel: "Dietary restrictions", render: "text", columns: ["dietaryRestrictions"] },
  yaleAffiliation: { key: "yaleAffiliation", core: false, defaultLabel: "Yale affiliation", render: "text", columns: ["yaleAffiliation"] },
  gradYear:        { key: "gradYear", core: false, defaultLabel: "Graduation year", render: "text", columns: ["gradYear"] },
  epic:            { key: "epic", core: true, defaultLabel: "Epic access", render: "epicBlock", columns: ["epicNeeded", "hasEpic", "existingEpicId", "epicAccessType", "worksWithYnhh"] },
  spanish:         { key: "spanish", core: false, defaultLabel: "I can speak Spanish with patients", render: "checkbox", columns: ["spanishSelfReported"] },
  licensedRN:      { key: "licensedRN", core: false, defaultLabel: "I am a licensed RN", render: "checkbox", columns: ["licensedRN"] },
  hipaa:           { key: "hipaa", core: true, defaultLabel: "HIPAA", render: "hipaaBlock", columns: ["hipaaCompletedAt", "hipaaFile"] },
  initials:        { key: "initials", core: false, defaultLabel: "Initials", render: "text", columns: ["initials"] },
};

// Reproduces src/app/onboard/[token]/onboard-form.tsx field-for-field. Agreement
// bodies are empty so the rendered form is identical to today (label + signature
// only); admins fill prose later. Order matches the current form's sections.
export const DEFAULT_CONTRACT_LAYOUT: ContractLayout = {
  blocks: [
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "netId" },
    { kind: "system_field", systemKey: "phone" },
    { kind: "system_field", systemKey: "dob" },
    { kind: "system_field", systemKey: "dietary" },
    { kind: "system_field", systemKey: "yaleAffiliation" },
    { kind: "system_field", systemKey: "gradYear" },
    { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "", signatureLabel: "type your full name" },
    { kind: "agreement", id: "professionalism", title: "Professionalism policy", body: "", signatureLabel: "type your full name" },
    { kind: "agreement", id: "training", title: "Training acknowledgement", body: "", signatureLabel: "type your full name" },
    { kind: "system_field", systemKey: "initials" },
    { kind: "system_field", systemKey: "epic" },
    { kind: "system_field", systemKey: "spanish" },
    { kind: "system_field", systemKey: "licensedRN" },
    { kind: "system_field", systemKey: "hipaa" },
  ],
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/modules/recruitment/contract/system-fields.test.ts`
Expected: PASS (all 3). Also re-run `layout.test.ts` to confirm the now-real `SYSTEM_FIELD_KEYS` import resolves: `npx vitest run src/modules/recruitment/contract/`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/system-fields.ts src/modules/recruitment/contract/system-fields.test.ts
git commit -m "feat(contract): system-field registry + parity default layout"
```

---

### Task 1.4: Layout resolution + settings registry entry

**Files:**
- Create: `src/modules/recruitment/contract/resolve.ts`
- Modify: `src/platform/settings/registry.ts` (add setting to the `SETTINGS` array)
- Test: `src/modules/recruitment/contract/resolve.test.ts`

**Interfaces:**
- Consumes: `getSetting` from `@/platform/settings/service`; `prisma` from `@/platform/db`; `DEFAULT_CONTRACT_LAYOUT`, `parseContractLayout`.
- Produces:
  - `resolveContractLayout(cycleId: string): Promise<ContractLayout>` — cycle override ?? global default (settings) ?? code default.
  - `resolveLayoutSources(cycleOverride: unknown, globalDefault: unknown): ContractLayout` — the pure merge, DB-free, for unit tests.

- [ ] **Step 1: Register the setting** in `src/platform/settings/registry.ts`

Add near the branding block (import `parseContractLayout`/`DEFAULT_CONTRACT_LAYOUT` at top of file), inside the `SETTINGS` array:
```ts
  define<import("@/modules/recruitment/contract/layout").ContractLayout>({
    key: "onboarding.contractTemplate",
    category: "Onboarding",
    label: "Onboarding contract (master template)",
    help: "The default onboarding contract every new cycle inherits. Edit per cycle from the cycle's Form builder.",
    // Hidden from the generic settings form (edited via its own page); the schema
    // still validates DB reads/writes.
    input: { type: "textarea" },
    schema: z.custom<import("@/modules/recruitment/contract/layout").ContractLayout>(
      (v) => { try { require("@/modules/recruitment/contract/layout").parseContractLayout(v); return true; } catch { return false; } },
      { message: "Invalid contract layout." },
    ),
    envDefault: () => require("@/modules/recruitment/contract/system-fields").DEFAULT_CONTRACT_LAYOUT,
    secret: false,
  }),
```
Note: if the registry disallows `require`, use top-of-file `import { parseContractLayout } from "@/modules/recruitment/contract/layout"` and `import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields"` and reference them directly. Confirm the auto-rendered `/admin/settings` form skips or safely renders this key; if it renders a raw textarea, hide it by giving it a category the settings page filters, or add a `hidden` guard consistent with how `branding.logo`/image settings are handled.

- [ ] **Step 2: Write the failing test** (pure merge — no DB)

```ts
import { describe, it, expect } from "vitest";
import { resolveLayoutSources } from "./resolve";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";

describe("resolveLayoutSources", () => {
  it("prefers the cycle override", () => {
    const override = { blocks: [{ kind: "agreement", id: "x", title: "X", body: "hi", signatureLabel: "sign" }] };
    expect(resolveLayoutSources(override, null).blocks).toHaveLength(1);
  });
  it("falls back to the global default", () => {
    const global = { blocks: [{ kind: "system_field", systemKey: "name" }] };
    expect(resolveLayoutSources(null, global).blocks[0]).toMatchObject({ systemKey: "name" });
  });
  it("falls back to the code default when both are null", () => {
    expect(resolveLayoutSources(null, null).blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
  it("falls back to the code default when a stored value is malformed", () => {
    expect(resolveLayoutSources({ garbage: true }, null).blocks).toEqual(DEFAULT_CONTRACT_LAYOUT.blocks);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/modules/recruitment/contract/resolve.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `resolve.ts`**

```ts
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import type { ContractLayout } from "./layout";
import { parseContractLayout } from "./layout";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";

function safe(value: unknown): ContractLayout | null {
  if (value == null) return null;
  try { return parseContractLayout(value); } catch { return null; }
}

/** Pure precedence merge, DB-free: cycle override -> global default -> code default. */
export function resolveLayoutSources(cycleOverride: unknown, globalDefault: unknown): ContractLayout {
  return safe(cycleOverride) ?? safe(globalDefault) ?? DEFAULT_CONTRACT_LAYOUT;
}

export async function resolveContractLayout(cycleId: string): Promise<ContractLayout> {
  const [row, globalDefault] = await Promise.all([
    prisma.recruitmentCycleContract.findUnique({ where: { cycleId } }),
    getSetting<unknown>("onboarding.contractTemplate"),
  ]);
  return resolveLayoutSources(row?.layout ?? null, globalDefault);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run src/modules/recruitment/contract/resolve.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no new errors.
```bash
git add src/modules/recruitment/contract/resolve.ts src/modules/recruitment/contract/resolve.test.ts src/platform/settings/registry.ts
git commit -m "feat(contract): layout resolution + master-template setting"
```

---

### Task 1.5: Snapshot the resolved layout onto the contract at send time

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts` (`createOrResendContract` ~27-107)
- Test: `src/modules/recruitment/services/onboarding.test.ts` (add a case; DB-backed, CI-verified)

**Interfaces:**
- Consumes: `resolveContractLayout` from `../contract/resolve`.
- Produces: `OnboardingContract.templateSnapshot` set to the resolved layout when the contract is first created (and set on resend if still `PENDING` and snapshot is null).

- [ ] **Step 1: Write the failing test** (append to `onboarding.test.ts`, matching its existing setup helpers)

```ts
it("freezes the resolved contract layout onto the contract at send time", async () => {
  const { acceptanceId, actorId, baseUrl } = await seedAcceptanceReadyToOnboard(); // existing-style helper
  const contract = await createOrResendContract(acceptanceId, actorId, baseUrl);
  expect(contract.templateSnapshot).toBeTruthy();
  const snap = contract.templateSnapshot as { blocks: unknown[] };
  expect(Array.isArray(snap.blocks)).toBe(true);
  expect(snap.blocks.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts -t "freezes"`
Expected: FAIL locally with a Prisma/DB error OR assertion failure. (DB-backed — final verification is in CI. If the local DB is unavailable, confirm the assertion logic by inspection and rely on CI.)

- [ ] **Step 3: Implement the snapshot**

In `createOrResendContract`, import at top:
```ts
import { resolveContractLayout } from "../contract/resolve";
```
Resolve the layout once (after the conflict checks, before the create):
```ts
  const layout = await resolveContractLayout(cycle.id);
```
Set it on create:
```ts
  if (!contract) {
    contract = await prisma.onboardingContract.create({
      data: {
        acceptanceId,
        token: randomUUID(),
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        netId: applicant.netId,
        phone: applicant.phone,
        templateSnapshot: layout as object,
      },
    });
  } else if (!contract.templateSnapshot) {
    // Resend of a pre-snapshot PENDING contract: freeze now.
    contract = await prisma.onboardingContract.update({
      where: { id: contract.id },
      data: { templateSnapshot: layout as object },
    });
  }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts -t "freezes"` (CI-verified)
Expected: PASS. Locally, run `npx tsc --noEmit` to confirm types.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.test.ts
git commit -m "feat(contract): snapshot resolved layout onto contract at send"
```

---

### Task 1.6: Render `/onboard` from the snapshot (parity)

**Files:**
- Create: `src/app/onboard/[token]/contract-field.tsx` (client component: renders one block)
- Modify: `src/app/onboard/[token]/onboard-form.tsx` (drive from layout)
- Modify: `src/app/onboard/[token]/page.tsx` (pass the layout to the form)

**Interfaces:**
- Consumes: `contract.templateSnapshot` (or `DEFAULT_CONTRACT_LAYOUT` when null); `parseContractLayout`; block types; `renderTemplate`.
- Produces: `ContractField` component rendering a single `ContractBlock`; `OnboardForm` accepts `layout: ContractLayout`.

- [ ] **Step 1: Implement `contract-field.tsx`**

Renders one block. System fields reproduce today's markup exactly (dispatch on `SYSTEM_FIELDS[systemKey].render`); agreements render title + escaped prose paragraphs (`whitespace-pre-line`) + a signature input named `sig__<id>`; custom questions reuse `FieldPreview` with `name` = `custom__<key>`.

```tsx
"use client";
import { useState } from "react";
import { Input, Field } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";
import { SYSTEM_FIELDS } from "@/modules/recruitment/contract/system-fields";
import type { ContractBlock } from "@/modules/recruitment/contract/layout";

type Ctx = { firstName: string; orgName: string };
type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string };

function renderVars(text: string, ctx: Ctx): string {
  // Escaped-text output only; renderTemplate substitutes {{firstName}} / {{orgName}}.
  // Kept simple here to avoid importing server-only helpers into a client component:
  return text.replace(/\{\{\s*firstName\s*\}\}/g, ctx.firstName).replace(/\{\{\s*orgName\s*\}\}/g, ctx.orgName);
}

export function ContractField({
  block, prefill, ctx, err,
}: { block: ContractBlock; prefill: Prefill; ctx: Ctx; err: (k: string) => string | undefined }) {
  const [hasEpic, setHasEpic] = useState(false);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();

  if (block.kind === "agreement") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{block.title}</p>
        {block.body.trim() && (
          <p className="whitespace-pre-line text-sm text-foreground-soft">{renderVars(block.body, ctx)}</p>
        )}
        <Field label={`${block.title} (${block.signatureLabel})`} required>
          <Input name={`sig__${block.id}`} required />
        </Field>
        {err(`sig__${block.id}`) && <p className="mt-1 text-xs text-critical">{err(`sig__${block.id}`)}</p>}
      </div>
    );
  }

  if (block.kind === "custom_question") {
    return (
      <div>
        <FieldPreview
          f={{ key: `custom__${block.key}`, label: block.label, helpText: block.helpText ?? null, type: block.type, required: block.required, options: block.options ?? null, validation: null }}
          departments={[]}
          fieldError={err(`custom__${block.key}`)}
        />
      </div>
    );
  }

  // system_field
  const spec = SYSTEM_FIELDS[block.systemKey];
  const label = block.label ?? spec.defaultLabel;
  switch (spec.render) {
    case "epicBlock":
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="epicNeeded" /><span>Epic access is required for my role</span></label>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} /><span>I already have an Epic ID</span></label>
          {hasEpic && <Field label="Existing Epic ID" required><Input name="existingEpicId" required /></Field>}
          <Field label="Access type (if known)"><Input name="epicAccessType" /></Field>
          <label className="flex items-center gap-2 text-sm"><Checkbox name="worksWithYnhh" /><span>I currently work with Yale New Haven Hospital</span></label>
        </div>
      );
    case "hipaaBlock": {
      const maxHipaa = iso(today);
      const minHipaa = iso(new Date(today.getFullYear() - 5, today.getMonth(), today.getDate()));
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <Field label="HIPAA completion date" required><Input name="hipaaCompletedAt" type="date" required min={minHipaa} max={maxHipaa} /></Field>
          {err("hipaaCompletedAt") && <p className="mt-1 text-xs text-critical">{err("hipaaCompletedAt")}</p>}
          <Field label="HIPAA certificate (PDF)" required>
            {/* eslint-disable-next-line no-restricted-syntax -- native file input, no file primitive exists */}
            <input name="hipaaFile" type="file" accept="application/pdf,image/*" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
          </Field>
          {err("hipaaFile") && <p className="mt-1 text-xs text-critical">{err("hipaaFile")}</p>}
        </div>
      );
    }
    case "checkbox":
      return <label className="flex items-center gap-2 text-sm"><Checkbox name={block.systemKey === "spanish" ? "spanishSelfReported" : "licensedRN"} /><span>{label}</span></label>;
    case "date": case "email": case "tel": case "text": default: {
      const nameByKey: Record<string, string> = { name: "firstName", email: "email", netId: "netId", phone: "phone", dob: "dateOfBirth", dietary: "dietaryRestrictions", yaleAffiliation: "yaleAffiliation", gradYear: "gradYear", initials: "initials" };
      // "name" is special: two inputs (first + last).
      if (block.systemKey === "name") {
        return (
          <div className="space-y-4">
            <Field label="First name" required><Input name="firstName" defaultValue={prefill.firstName} required /></Field>
            <Field label="Last name" required><Input name="lastName" defaultValue={prefill.lastName} required /></Field>
          </div>
        );
      }
      const type = spec.render === "text" ? "text" : spec.render;
      const defaults: Record<string, string> = { email: prefill.email, netId: prefill.netId, phone: prefill.phone };
      const required = block.systemKey === "email" || block.systemKey === "initials";
      return (
        <div>
          <Field label={label} required={required}><Input name={nameByKey[block.systemKey]} type={type} defaultValue={defaults[block.systemKey]} required={required} /></Field>
          {err(nameByKey[block.systemKey]) && <p className="mt-1 text-xs text-critical">{err(nameByKey[block.systemKey])}</p>}
        </div>
      );
    }
  }
}
```
Note: match the exact labels/required-ness from the current `onboard-form.tsx` when wiring `defaultLabel`s (adjust `SYSTEM_FIELDS` labels if a parity diff shows). The custom-question and agreement branches are inert in Phase 1 (default layout has no custom questions and empty agreement bodies) but are implemented now so Phase 2 needs no render changes.

- [ ] **Step 2: Rewrite `onboard-form.tsx` to map blocks**

Replace the hardcoded `<FormSection>`s with a map over `layout.blocks`, keeping the same outer `<Card>`, `<form>`, submit button, and `err()` helper. Accept `layout` and a `ctx` (firstName, orgName) prop; keep `enabled !== false` filtering for optional system fields:
```tsx
{layout.blocks
  .filter((b) => b.kind !== "system_field" || b.enabled !== false || SYSTEM_FIELDS[b.systemKey].core)
  .map((b, i) => <ContractField key={i} block={b} prefill={prefill} ctx={ctx} err={err} />)}
```

- [ ] **Step 3: Pass the layout from `page.tsx`**

```tsx
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { getSetting } from "@/platform/settings/service";
// ...
let layout = DEFAULT_CONTRACT_LAYOUT;
try { if (contract.templateSnapshot) layout = parseContractLayout(contract.templateSnapshot); } catch { /* fall back to default */ }
const orgName = await getSetting<string>("branding.orgName");
// ...
<OnboardForm token={contract.token} prefill={prefill} layout={layout} ctx={{ firstName: contract.firstName, orgName }} />
```

- [ ] **Step 4: Verify parity in the running app**

Run the app (see `/run` skill or `npm run dev`), open a valid onboarding link, and confirm the form is visually and behaviorally identical to before (same fields, same required markers, `hasEpic` still reveals the Epic ID field, HIPAA min/max still applied). Use the `verify` skill to drive the flow end-to-end (fill + submit a test contract) and confirm submission still succeeds.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npx tsc --noEmit && npx eslint src/app/onboard/\[token\]`
Expected: clean.
```bash
git add "src/app/onboard/[token]"
git commit -m "feat(contract): render onboarding form from layout snapshot (parity)"
```

---

### Task 1.7: Persist custom answers and agreement signatures on submit

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts` (`ContractSubmission` type + `submitContract`)
- Modify: `src/app/onboard/[token]/actions.ts` (collect `custom__*` and `sig__*` from FormData)
- Test: `src/modules/recruitment/services/onboarding.test.ts` (add cases; CI-verified)

**Interfaces:**
- Consumes: the contract's `templateSnapshot` layout (to know which agreements/customs are required).
- Produces: `submitContract` writes `signatures` (`{ [agreementId]: value }`) and `customAnswers` (`{ [key]: value }`); validates required agreement signatures and required custom questions; still writes all system columns as today.

- [ ] **Step 1: Write the failing test**

```ts
it("stores agreement signatures and required custom answers from the snapshot layout", async () => {
  const { token } = await seedContractWithLayout({
    blocks: [
      { kind: "system_field", systemKey: "name" },
      { kind: "system_field", systemKey: "email" },
      { kind: "system_field", systemKey: "hipaa" },
      { kind: "agreement", id: "agreement", title: "Volunteer agreement", body: "", signatureLabel: "sign" },
      { kind: "custom_question", key: "tshirt", label: "T-shirt size", type: "SHORT_TEXT", required: true },
    ],
  });
  await expect(submitContract(token, baseValidSubmission({ signatures: {}, customAnswers: {} })))
    .rejects.toThrow(ContractValidationError); // missing required signature + custom answer
  const ok = await submitContract(token, baseValidSubmission({
    signatures: { agreement: "Jane Doe" },
    customAnswers: { tshirt: "M" },
  }));
  expect(ok.signatures).toMatchObject({ agreement: "Jane Doe" });
  expect(ok.customAnswers).toMatchObject({ tshirt: "M" });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts -t "agreement signatures"` (CI-verified)
Expected: FAIL.

- [ ] **Step 3: Extend `ContractSubmission` and `submitContract`**

Add to `ContractSubmission`:
```ts
  signatures?: Record<string, string>;
  customAnswers?: Record<string, string | string[]>;
```
In `submitContract`, load the snapshot layout and validate required agreement/custom blocks:
```ts
  const layout = contract.templateSnapshot ? safeParseLayout(contract.templateSnapshot) : DEFAULT_CONTRACT_LAYOUT;
  for (const b of layout.blocks) {
    if (b.kind === "agreement" && !input.signatures?.[b.id]?.trim()) e[`sig__${b.id}`] = "required";
    if (b.kind === "custom_question" && b.required) {
      const v = input.customAnswers?.[b.key];
      const empty = v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
      if (empty) e[`custom__${b.key}`] = "required";
    }
  }
```
(Keep the existing system-field validation. For the default layout, the three legacy `*Signature` inputs are gone from the form; the legacy required checks on `agreementSignature`/`professionalismSignature`/`trainingSignature` in the current `submitContract` must be REMOVED and replaced by the agreement-block loop above — otherwise valid submissions fail. `initials` stays validated as a system field.)
Persist in the `update` data:
```ts
    signatures: (input.signatures ?? {}) as object,
    customAnswers: (input.customAnswers ?? {}) as object,
```
Leave the legacy `*Signature`/`initials` column writes as-is only if still supplied; otherwise set them from the agreement loop is unnecessary (promotion ignores them). Add a private `safeParseLayout` helper (try `parseContractLayout`, fall back to `DEFAULT_CONTRACT_LAYOUT`).

- [ ] **Step 4: Update `actions.ts` to collect the dynamic fields**

```ts
  const signatures: Record<string, string> = {};
  const customAnswers: Record<string, string | string[]> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("sig__")) signatures[k.slice(5)] = String(v).trim();
    else if (k.startsWith("custom__")) {
      const key = k.slice(8);
      const val = String(v);
      // MULTI_SELECT / SUBCOMMITTEE_RANK submit repeated keys -> collect to array
      if (key in customAnswers) customAnswers[key] = [...[customAnswers[key]].flat(), val];
      else customAnswers[key] = val;
    }
  }
```
Add `signatures` and `customAnswers` to the `input` object passed to `submitContract`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts` (CI-verified) and `npx tsc --noEmit` locally.
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/services/onboarding.ts "src/app/onboard/[token]/actions.ts" src/modules/recruitment/services/onboarding.test.ts
git commit -m "feat(contract): persist agreement signatures + custom answers on submit"
```

**Phase 1 gate:** `/onboard` renders identically to before, submissions still promote correctly, snapshot is stored. Ship.

---

# Phase 2 — Per-cycle editor

Adds the builder tab that edits a cycle's contract layout (materializing a `RecruitmentCycleContract` override), with two-tier enforcement, agreements + custom questions, reorder, and reset-to-default.

### Task 2.1: Contract-template mutation service

**Files:**
- Create: `src/modules/recruitment/contract/template.ts`
- Test: `src/modules/recruitment/contract/template.test.ts` (pure mutation tests + a DB-backed materialize test)

**Interfaces:**
- Consumes: `resolveContractLayout`, `parseContractLayout`, `SYSTEM_FIELDS`, `prisma`, `getSetting`, `setSetting`.
- Produces (pure, DB-free — unit-tested locally):
  - `applyBlockOp(layout: ContractLayout, op: BlockOp): ContractLayout` where
    `type BlockOp = { t: "addAgreement" } | { t: "addCustom"; fieldType: FieldType } | { t: "updateBlock"; index: number; patch: Partial<...> } | { t: "removeBlock"; index: number } | { t: "reorder"; order: number[] } | { t: "toggleSystem"; index: number; enabled: boolean }`
  - `assertTwoTier(layout: ContractLayout): void` — throws `ContractLayoutError` if a core system field is missing, disabled, or a system field was deleted.
- Produces (DB — CI-verified):
  - `getContractLayoutForEdit(cycleId): Promise<{ layout: ContractLayout; hasOverride: boolean }>`
  - `saveCycleContractLayout(cycleId, layout): Promise<void>` (validates + upserts the override row)
  - `resetCycleContractLayout(cycleId): Promise<void>` (deletes the override row)
  - `saveGlobalContractLayout(layout): Promise<void>` (validates + `setSetting("onboarding.contractTemplate", ...)`)

- [ ] **Step 1: Write failing pure tests**

```ts
import { describe, it, expect } from "vitest";
import { applyBlockOp, assertTwoTier } from "./template";
import { DEFAULT_CONTRACT_LAYOUT } from "./system-fields";
import { ContractLayoutError } from "./layout";

describe("applyBlockOp", () => {
  it("adds an agreement with a unique id", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addAgreement" });
    expect(out.blocks.filter((b) => b.kind === "agreement").length)
      .toBe(DEFAULT_CONTRACT_LAYOUT.blocks.filter((b) => b.kind === "agreement").length + 1);
  });
  it("adds a custom question with a unique, namespaced key", () => {
    const out = applyBlockOp(DEFAULT_CONTRACT_LAYOUT, { t: "addCustom", fieldType: "SHORT_TEXT" });
    const cq = out.blocks.find((b) => b.kind === "custom_question") as any;
    expect(cq.key).toMatch(/^[a-z0-9_]+$/);
  });
});

describe("assertTwoTier", () => {
  it("rejects removing a core system field", () => {
    const noHipaa = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.filter((b) => !(b.kind === "system_field" && b.systemKey === "hipaa")) };
    expect(() => assertTwoTier(noHipaa)).toThrow(ContractLayoutError);
  });
  it("rejects disabling a core system field", () => {
    const disabled = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.map((b) => b.kind === "system_field" && b.systemKey === "epic" ? { ...b, enabled: false } : b) };
    expect(() => assertTwoTier(disabled)).toThrow(ContractLayoutError);
  });
  it("allows disabling an optional system field", () => {
    const disabled = { blocks: DEFAULT_CONTRACT_LAYOUT.blocks.map((b) => b.kind === "system_field" && b.systemKey === "gradYear" ? { ...b, enabled: false } : b) };
    expect(() => assertTwoTier(disabled)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/modules/recruitment/contract/template.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `template.ts`** (pure functions + DB functions)

Implement `applyBlockOp` (immutable updates), `assertTwoTier` (every core key in `SYSTEM_FIELDS` must appear as a system_field block with `enabled !== false`), unique-id/key generation (derive from label + numeric suffix, avoiding collisions — mirror `uniqueKey` from `../engine/field-key`), then the DB functions:
```ts
export async function getContractLayoutForEdit(cycleId: string) {
  const row = await prisma.recruitmentCycleContract.findUnique({ where: { cycleId } });
  if (row) return { layout: parseContractLayout(row.layout), hasOverride: true };
  return { layout: await resolveContractLayout(cycleId), hasOverride: false };
}
export async function saveCycleContractLayout(cycleId: string, layout: ContractLayout) {
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  await prisma.recruitmentCycleContract.upsert({
    where: { cycleId },
    create: { cycleId, layout: parsed as object },
    update: { layout: parsed as object },
  });
}
export async function resetCycleContractLayout(cycleId: string) {
  await prisma.recruitmentCycleContract.deleteMany({ where: { cycleId } });
}
export async function saveGlobalContractLayout(layout: ContractLayout) {
  const parsed = parseContractLayout(layout);
  assertTwoTier(parsed);
  await setSetting("onboarding.contractTemplate", parsed);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/modules/recruitment/contract/template.test.ts` (pure tests pass locally; DB functions verified in CI) and `npx tsc --noEmit`.
Expected: pure tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/contract/template.ts src/modules/recruitment/contract/template.test.ts
git commit -m "feat(contract): per-cycle + global layout mutation service with two-tier guard"
```

---

### Task 2.2: Server actions for the contract editor

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/actions.ts`

**Interfaces:**
- Consumes: `saveCycleContractLayout`, `resetCycleContractLayout`, `ContractLayoutError`; `requirePermission`; `revalidatePath`.
- Produces: `saveContractAction(cycleId, layout)`, `resetContractAction(cycleId)` returning `{ ok: true } | { ok: false; error: string }`, mirroring the builder `run()` wrapper pattern.

- [ ] **Step 1: Implement the actions** (mirror `builder/actions.ts` structure)

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { saveCycleContractLayout, resetCycleContractLayout } from "@/modules/recruitment/contract/template";
import { ContractLayoutError, type ContractLayout } from "@/modules/recruitment/contract/layout";

export type ActionResult = { ok: true } | { ok: false; error: string };
const contractPath = (id: string) => `/recruitment/cycles/${id}/builder/contract`;

export async function saveContractAction(cycleId: string, layout: ContractLayout): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  try { await saveCycleContractLayout(cycleId, layout); }
  catch (err) { if (err instanceof ContractLayoutError) return { ok: false, error: err.message }; throw err; }
  revalidatePath(contractPath(cycleId));
  return { ok: true };
}

export async function resetContractAction(cycleId: string): Promise<ActionResult> {
  await requirePermission("recruitment.manage_cycles");
  await resetCycleContractLayout(cycleId);
  revalidatePath(contractPath(cycleId));
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`
```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract/actions.ts"
git commit -m "feat(contract): server actions for per-cycle contract editor"
```

---

### Task 2.3: Contract editor client component + builder page

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx` (client)
- Create: `src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx` (server)

**Interfaces:**
- Consumes: `getContractLayoutForEdit`, `saveContractAction`/`resetContractAction`, `SYSTEM_FIELDS`, existing `SortableList` (`../sortable-list`), `TypePicker` (`../type-picker`), UI primitives.
- Produces: an editor that renders the block list with per-block controls and calls `saveContractAction` with the full edited `ContractLayout`.

- [ ] **Step 1: Implement the editor component**

A client component holding `layout` in state. For each block, render an editable card:
- `system_field`: show the label (editable text input -> `label`), a lock badge if `SYSTEM_FIELDS[key].core`, an enable/disable toggle if not core; drag handle for reorder. No delete for system fields.
- `agreement`: editable `title`, `signatureLabel`, and a `body` `<Textarea>` (plain text; helper text: "Plain text. Use {{firstName}} and {{orgName}} for personalization."); delete + drag.
- `custom_question`: reuse the application builder's `field-card` editing affordances where practical (label, required toggle, options editor for select types via `../options-editor`); delete + drag.
Add "Add agreement" and a `TypePicker`-driven "Add question" control. A "Save" button calls `saveContractAction(cycleId, layout)` and surfaces `error`. A "Reset to default" button (shown when `hasOverride`) calls `resetContractAction`. Reuse `SortableList` for drag-reorder, calling a local reorder that updates state (persisted on Save).

Keep the component focused; if it grows past ~250 lines, split per-block cards into `system-field-card.tsx` / `agreement-card.tsx` / `custom-question-card.tsx` under the same folder.

- [ ] **Step 2: Implement the page** (mirror `builder/quiz/page.tsx`)

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { getContractLayoutForEdit } from "@/modules/recruitment/contract/template";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "./contract-editor";

export default async function ContractBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("recruitment.manage_cycles");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const { layout, hasOverride } = await getContractLayoutForEdit(id);
  return (
    <div className="max-w-3xl space-y-6">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title, section: { label: "Form builder", slug: "builder" }, leaf: "Onboarding contract" })} />
      <PageHeader title="Onboarding contract" description={cycle.title} />
      <ContractEditor cycleId={id} initialLayout={layout} hasOverride={hasOverride} />
    </div>
  );
}
```

- [ ] **Step 3: Verify in the app**

Use `/run` + `verify`: open `/recruitment/cycles/<id>/builder/contract`, add an agreement with prose, add a custom question, toggle off an optional field, save, then open a fresh onboarding link for that cycle (send links) and confirm the edited contract renders and validates. Confirm core fields cannot be removed/disabled and Reset restores the default.

- [ ] **Step 4: Typecheck + lint + commit**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/builder/contract"`
```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder/contract"
git commit -m "feat(contract): per-cycle onboarding contract editor UI"
```

---

### Task 2.4: Link the editor from the cycle detail page

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (the "Training" card region ~197-223, or the form-builder card)

**Interfaces:**
- Consumes: nothing new. Adds a link to `/recruitment/cycles/${id}/builder/contract`.

- [ ] **Step 1: Add an "Edit onboarding contract" link** beside the existing form-builder / quiz links, gated by the same `recruitment.manage_cycles` visibility used for those links.

```tsx
<Link href={`/recruitment/cycles/${id}/builder/contract`} className="text-brand-fg hover:text-brand-hover">
  Edit onboarding contract
</Link>
```

- [ ] **Step 2: Verify the link renders and routes; typecheck; commit**

Run: `npx tsc --noEmit`
```bash
git add "src/app/(app)/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(contract): link onboarding contract editor from cycle page"
```

**Phase 2 gate:** admins can fully author a cycle's contract; edits apply to newly-sent links; already-sent links are unchanged (snapshot). Ship.

---

# Phase 3 — Global master editor

Lets admins edit the default that every new cycle inherits.

### Task 3.1: Global contract editor actions + page

**Files:**
- Create: `src/app/(app)/admin/contract/actions.ts`
- Create: `src/app/(app)/admin/contract/page.tsx`
- Modify: the admin index/nav (`src/app/(app)/admin/page.tsx`) to link the new page.

**Interfaces:**
- Consumes: `getSetting("onboarding.contractTemplate")`, `saveGlobalContractLayout`, the `ContractEditor` component from Phase 2, the admin-settings permission.
- Produces: `saveGlobalContractAction(layout)`.

- [ ] **Step 1: Implement the action**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { saveGlobalContractLayout } from "@/modules/recruitment/contract/template";
import { ContractLayoutError, type ContractLayout } from "@/modules/recruitment/contract/layout";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function saveGlobalContractAction(layout: ContractLayout): Promise<ActionResult> {
  await requirePermission("admin.manage_settings"); // match the permission guarding /admin/settings
  try { await saveGlobalContractLayout(layout); }
  catch (err) { if (err instanceof ContractLayoutError) return { ok: false, error: err.message }; throw err; }
  revalidatePath("/admin/contract");
  return { ok: true };
}
```
(Confirm the exact settings permission name from `src/app/(app)/admin/settings/page.tsx` and use it verbatim.)

- [ ] **Step 2: Implement the page** (reuse `ContractEditor` with a `mode="global"` prop that swaps the save action and hides "Reset to default")

Add an optional `onSave` / `mode` prop to `ContractEditor` (default `mode="cycle"`). In global mode, call `saveGlobalContractAction`. Page:
```tsx
import { requirePermission } from "@/platform/auth/session";
import { getSetting } from "@/platform/settings/service";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { PageHeader } from "@/platform/ui/page-header";
import { ContractEditor } from "@/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor";

export default async function AdminContractPage() {
  await requirePermission("admin.manage_settings");
  const raw = await getSetting<unknown>("onboarding.contractTemplate");
  let layout = DEFAULT_CONTRACT_LAYOUT;
  try { layout = parseContractLayout(raw); } catch { /* default */ }
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Onboarding contract" description="Master template inherited by new cycles" />
      <ContractEditor mode="global" cycleId="" initialLayout={layout} hasOverride={false} />
    </div>
  );
}
```

- [ ] **Step 3: Add an admin nav/index link** to `/admin/contract` alongside the other admin cards in `src/app/(app)/admin/page.tsx`.

- [ ] **Step 4: Verify + typecheck + commit**

Use `/run` + `verify`: edit the master template, create a NEW cycle, and confirm it inherits the edited default (before any per-cycle edit). Confirm an existing cycle with its own override is unaffected.
Run: `npx tsc --noEmit && npx eslint "src/app/(app)/admin/contract"`
```bash
git add "src/app/(app)/admin/contract" "src/app/(app)/admin/page.tsx" "src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx"
git commit -m "feat(contract): global master onboarding-contract editor"
```

**Phase 3 gate:** global default editable; new cycles inherit it; per-cycle overrides and already-sent snapshots unaffected.

---

## Self-Review

**Spec coverage:**
- Both prose + fields per cycle → Tasks 1.2/1.3 (types + agreement + custom blocks), 2.1/2.3 (editor). ✓
- Two tiers (core locked, optional toggle, custom free) → `assertTwoTier` (2.1), editor affordances (2.3). ✓
- Global default seeds each cycle → `onboarding.contractTemplate` setting (1.4), `resolveContractLayout` precedence (1.4), lazy override materialization (2.1 `getContractLayoutForEdit`/`saveCycleContractLayout`), global editor (3.1). ✓
- Snapshot at send → Task 1.5; render from snapshot 1.6; validate against snapshot 1.7. ✓
- Prose sanitized/limited → escaped-text render, no dep (1.6), Global Constraints. ✓
- Parity-first 3 phases → phase structure. ✓
- Promotion untouched → system fields keep writing existing columns (1.6/1.7), no `promotion.ts` change. ✓
- Legacy signature columns single-source-of-truth → agreements write `signatures` JSON (1.7). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each task shows real code. Two intentional in-app verification notes (labels parity in 1.6; exact settings-permission name in 3.1) are explicit lookups, not deferred logic.

**Type consistency:** `ContractLayout`/`ContractBlock`/`SystemFieldKey` defined in 1.2 and consumed unchanged in 1.3–3.1; `resolveContractLayout`/`getContractLayoutForEdit`/`saveCycleContractLayout`/`saveGlobalContractLayout` names consistent across resolve/template/actions/pages; form field naming (`sig__<id>`, `custom__<key>`) consistent between render (1.6), submit (1.7), and actions (1.7).

**Open confirmations for the implementer (verify in-repo, not blockers):**
1. Whether `src/platform/settings/registry.ts` tolerates a JSON-valued setting hidden from the auto-rendered form; if not, hide via the page filter used for image settings (Task 1.4).
2. Exact admin settings permission name (Task 3.1) and exact cycle-detail link placement (Task 2.4).
