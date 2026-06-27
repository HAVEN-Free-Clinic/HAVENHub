# Recruitment Email Customization (Per-Cycle Overrides) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all recruitment emails editable, with a global default per email type (via the existing email-template system) plus a per-cycle override layer.

**Architecture:** Register the 5 recruitment emails as descriptors in the existing `src/platform/email/templates` registry (gives global editing + variables + code defaults for free). Add an isolated `RecruitmentCycleEmail` table and a recruitment-module render seam `renderCycleEmail` that resolves source as cycle override -> global override -> descriptor default, then wraps in the shared layout. Switch the send sites from inline-HTML functions to the seam.

**Tech Stack:** Next.js 16 (App Router, server actions), React 19, Prisma/Postgres, Vitest (node env, no DOM), Tailwind v4. Render engine: `src/platform/email/render` (`renderTemplate`, `validateTemplate`, `esc`).

## Global Constraints

- No em-dashes anywhere (code, comments, copy). Use commas, parentheses, colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`. Existing email copy that says "HAVEN Free Clinic" is the org name, preserved verbatim.
- No new dependencies.
- Hand-authored Prisma migration applied to dev and test DBs; run `prisma migrate status` before any Neon deploy.
- Reuse the existing render engine, `validateTemplate`, registry, and layout. Do not fork the rendering or validation logic.
- Resolution order, per field, subject and body independently: cycle override -> global `EmailTemplate` override -> descriptor default. Layout stays global.
- The 5 keys (already used as `queueEmail` `template:` tags): `recruitment.acceptance`, `recruitment.interview_invite`, `recruitment.onboarding`, `recruitment.application_received`, `recruitment.portal_link`. Only the first four are cycle-scoped; `recruitment.portal_link` is global-only (no cycle at send time).

## File Structure

- Create `src/platform/email/templates/recruitment.ts` - the 5 recruitment `TemplateDescriptor`s.
- Modify `src/platform/email/templates/registry.ts` - add recruitment descriptors to `ALL`.
- Modify `prisma/schema.prisma` - add `RecruitmentCycleEmail` model + inverse relations.
- Create `prisma/migrations/<ts>_recruitment_cycle_email/migration.sql`.
- Create `src/modules/recruitment/email/render.ts` - `CYCLE_EMAIL_KEYS`, `resolveCycleEmail`, `renderResolvedEmail`, `renderCycleEmail`.
- Create `src/modules/recruitment/services/cycle-emails.ts` - `listCycleEmails`, `getCycleEmailForEdit`, `saveCycleEmail`, `resetCycleEmail`, `CycleEmailValidationError`.
- Modify send sites: `services/decisions.ts`, `services/interviews.ts`, `services/onboarding.ts`, `services/submissions.ts`, `services/portal-auth.ts`.
- Delete `email/templates/acceptance.ts`, `email/templates/interview-invite.ts`, `email/templates/onboarding.ts`, `services/portal-link-email.ts` (and their `.test.ts`).
- Create `src/app/(app)/recruitment/cycles/[id]/emails/page.tsx`, `.../emails/[key]/page.tsx`.
- Modify `src/app/(app)/recruitment/cycles/[id]/page.tsx` - add nav link.
- Modify `src/platform/test/db.ts` (resetDb) - truncate `RecruitmentCycleEmail`.

---

### Task 1: Recruitment email descriptors + registry

**Files:**
- Create: `src/platform/email/templates/recruitment.ts`
- Modify: `src/platform/email/templates/registry.ts`
- Test: `src/platform/email/templates/recruitment.test.ts`

**Interfaces:**
- Consumes: `TemplateDescriptor`, `VariableDef` from `./types`; `renderTemplate` from `@/platform/email/render/render`; `validateTemplate` from `@/platform/email/render/validate`.
- Produces: `recruitmentDescriptors: TemplateDescriptor[]` (5 entries with keys `recruitment.acceptance`, `recruitment.interview_invite`, `recruitment.onboarding`, `recruitment.application_received`, `recruitment.portal_link`). After this task `getDescriptor("recruitment.acceptance")` etc. resolve.

- [ ] **Step 1: Write the failing test**

Create `src/platform/email/templates/recruitment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recruitmentDescriptors } from "./recruitment";
import { getDescriptor, listDescriptors } from "./registry";
import { renderTemplate } from "@/platform/email/render/render";
import { validateTemplate } from "@/platform/email/render/validate";

const KEYS = [
  "recruitment.acceptance",
  "recruitment.interview_invite",
  "recruitment.onboarding",
  "recruitment.application_received",
  "recruitment.portal_link",
];

describe("recruitment email descriptors", () => {
  it("exports all five keys", () => {
    expect(recruitmentDescriptors.map((d) => d.key).sort()).toEqual([...KEYS].sort());
  });

  it("registers them in the shared registry", () => {
    for (const key of KEYS) expect(getDescriptor(key)?.key).toBe(key);
    const all = listDescriptors().map((d) => d.key);
    for (const key of KEYS) expect(all).toContain(key);
  });

  it("each default subject and body uses only declared variables", () => {
    for (const d of recruitmentDescriptors) {
      const allowed = d.variables.map((v) => v.name);
      expect(validateTemplate(d.defaultSubject, allowed).ok).toBe(true);
      expect(validateTemplate(d.defaultBody, allowed).ok).toBe(true);
    }
  });

  it("renders each default body with sample values without leftover tags", () => {
    for (const d of recruitmentDescriptors) {
      const ctx: Record<string, unknown> = {};
      for (const v of d.variables) ctx[v.name] = v.sampleValue;
      const out = renderTemplate(d.defaultBody, ctx);
      expect(out).not.toContain("{{");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("escapes interpolated values but renders joinLink raw", () => {
    const invite = getDescriptor("recruitment.interview_invite")!;
    const out = renderTemplate(invite.defaultBody, {
      firstName: "<script>x</script>",
      departmentName: "R & D",
      interviewTime: "Monday",
      joinLink: '<a href="https://z">https://z</a>',
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("R &amp; D");
    expect(out).toContain('<a href="https://z">');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/email/templates/recruitment.test.ts`
Expected: FAIL ("Cannot find module './recruitment'").

- [ ] **Step 3: Create the descriptors**

Create `src/platform/email/templates/recruitment.ts`:

```ts
import type { TemplateDescriptor } from "./types";

/**
 * Recruitment email templates. Registered here so admins can edit a global
 * default for each (in /admin/email/templates) and so each cycle can override
 * them (see src/modules/recruitment/email/render.ts). These replace the former
 * inline-HTML functions; the render engine handles HTML escaping, so bodies are
 * pure interpolation and values are passed raw in the context.
 *
 * joinLink is rendered raw ({{{ }}}) because its context builder emits either an
 * anchor tag or the plain fallback text. All other values use escaped {{ }}.
 */
export const recruitmentDescriptors: TemplateDescriptor[] = [
  {
    key: "recruitment.acceptance",
    name: "Recruitment: acceptance",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
      { name: "departmentName", label: "Department name", sampleValue: "Student Run Health Department" },
    ],
    defaultSubject: "You've been accepted to HAVEN: {{ departmentName }}",
    defaultBody:
      "<p>Congratulations {{ firstName }},</p><p>You've been accepted into <strong>{{ departmentName }}</strong> for {{ cycleTitle }}. We'll follow up shortly with onboarding next steps.</p>",
  },
  {
    key: "recruitment.interview_invite",
    name: "Recruitment: interview invitation",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "departmentName", label: "Department name", sampleValue: "Student Run Health Department" },
      { name: "interviewTime", label: "Interview date and time", sampleValue: "Monday, April 15, 2026 at 6:30 PM" },
      { name: "joinLink", label: "Join link (HTML)", sampleValue: '<a href="https://zoom.us/j/123">https://zoom.us/j/123</a>' },
    ],
    defaultSubject: "HAVEN {{ departmentName }} director interview",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>You're invited to a director interview for <strong>{{ departmentName }}</strong> at HAVEN Free Clinic.</p><p>Time: {{ interviewTime }}<br/>Join: {{{ joinLink }}}</p><p>Please reply if you need to reschedule.</p>",
  },
  {
    key: "recruitment.onboarding",
    name: "Recruitment: onboarding link",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
      { name: "contractUrl", label: "Onboarding link URL", sampleValue: "https://hub.havenfreeclinic.com/onboard/abc123" },
    ],
    defaultSubject: "Complete your HAVEN onboarding for {{ cycleTitle }}",
    defaultBody:
      '<p>Congratulations {{ firstName }},</p><p>To finish joining HAVEN for {{ cycleTitle }}, please complete your onboarding contract here: <a href="{{ contractUrl }}">{{ contractUrl }}</a></p><p>It collects your signatures, EPIC access details, and HIPAA certificate.</p>',
  },
  {
    key: "recruitment.application_received",
    name: "Recruitment: application received",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "cycleTitle", label: "Cycle title", sampleValue: "Volunteer SU26" },
    ],
    defaultSubject: "We received your {{ cycleTitle }} application",
    defaultBody:
      "<p>Hi {{ firstName }},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your {{ cycleTitle }} application and will be in touch.</p>",
  },
  {
    key: "recruitment.portal_link",
    name: "Recruitment: application link (magic link)",
    category: "transactional",
    variables: [
      { name: "firstName", label: "Applicant first name", sampleValue: "Sam" },
      { name: "portalUrl", label: "Magic link URL", sampleValue: "https://hub.havenfreeclinic.com/apply/verify?token=abc" },
    ],
    defaultSubject: "Your HAVEN Hub application link",
    defaultBody:
      '<p>Hi {{ firstName }},</p><p>Use this link to access your HAVEN Hub application. It expires in 30 minutes and can be used once.</p><p><a href="{{ portalUrl }}">Open my application</a></p><p>If you did not request this, you can ignore this email.</p>',
  },
];
```

- [ ] **Step 4: Register in the registry**

Modify `src/platform/email/templates/registry.ts`. Add the import and spread:

```ts
import type { TemplateDescriptor } from "./types";
import { layoutDescriptor } from "./layout";
import { complianceDescriptors } from "./compliance";
import { epicDescriptors } from "./epic";
import { recruitmentDescriptors } from "./recruitment";

export const LAYOUT_KEY = "layout";

const ALL: TemplateDescriptor[] = [layoutDescriptor, ...complianceDescriptors, ...epicDescriptors, ...recruitmentDescriptors];
```

(Leave the rest of the file unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/platform/email/templates/recruitment.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/platform/email/templates/recruitment.ts src/platform/email/templates/registry.ts src/platform/email/templates/recruitment.test.ts
git commit -m "feat(email): register recruitment email descriptors"
```

---

### Task 2: RecruitmentCycleEmail model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260625210000_recruitment_cycle_email/migration.sql`
- Modify: `src/platform/test/db.ts`
- Test: (covered by the model compiling + the resetDb usage in later tasks; no standalone test file)

**Interfaces:**
- Produces: Prisma model `RecruitmentCycleEmail` with fields `id, cycleId, key, subject, body, updatedById, createdAt, updatedAt` and `@@unique([cycleId, key])`. Prisma client accessor `prisma.recruitmentCycleEmail`. Composite unique selector `where: { cycleId_key: { cycleId, key } }`.

- [ ] **Step 1: Add the model to the schema**

In `prisma/schema.prisma`, add after the `EmailTemplate` model:

```prisma
/// Per-cycle override of a recruitment email. A row exists only when a cycle
/// customizes that email; absence means inherit the global default. `key` is one
/// of the cycle-scoped recruitment descriptor keys (not recruitment.portal_link).
model RecruitmentCycleEmail {
  id          String           @id @default(cuid())
  cycleId     String
  cycle       RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  key         String
  subject     String
  body        String
  updatedById String?
  updatedBy   Person?          @relation("recruitmentCycleEmailUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@unique([cycleId, key])
}
```

- [ ] **Step 2: Add the inverse relation fields**

In the `RecruitmentCycle` model, add a relation field (place it among the other relation fields):

```prisma
  cycleEmails           RecruitmentCycleEmail[]
```

In the `Person` model, add (near the other `@relation`-named back-references such as `emailTemplatesUpdated`):

```prisma
  recruitmentCycleEmailsUpdated RecruitmentCycleEmail[] @relation("recruitmentCycleEmailUpdatedBy")
```

- [ ] **Step 3: Write the migration**

Create `prisma/migrations/20260625210000_recruitment_cycle_email/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "RecruitmentCycleEmail" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentCycleEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentCycleEmail_cycleId_key_key" ON "RecruitmentCycleEmail"("cycleId", "key");

-- AddForeignKey
ALTER TABLE "RecruitmentCycleEmail" ADD CONSTRAINT "RecruitmentCycleEmail_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "RecruitmentCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCycleEmail" ADD CONSTRAINT "RecruitmentCycleEmail_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Apply to the dev DB and regenerate the client:
```bash
npx prisma migrate deploy
npx prisma generate
```
Then apply to the test DB. This repo runs vitest against a separate test database; if a `TEST_DATABASE_URL` env var is set for this worktree (see the vitest-test-DB-isolation convention), run:
```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
```
If no `TEST_DATABASE_URL` is set, the dev and test DBs are the same and the first `migrate deploy` already covered it.
Expected: migration `20260625210000_recruitment_cycle_email` applied; `prisma generate` succeeds.

- [ ] **Step 5: Add the table to resetDb**

In `src/platform/test/db.ts`, find the truncate/delete list used by `resetDb` and add `RecruitmentCycleEmail` to it (match the existing style, whether it is a `TRUNCATE ... CASCADE` list or a sequence of `deleteMany` calls). It must be truncated alongside the other recruitment tables.

- [ ] **Step 6: Verify the client and schema typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). If the editor cache is stale, `rm -rf .next` and re-run.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260625210000_recruitment_cycle_email src/platform/test/db.ts
git commit -m "feat(recruitment): add RecruitmentCycleEmail per-cycle override table"
```

---

### Task 3: Render seam (renderCycleEmail)

**Files:**
- Create: `src/modules/recruitment/email/render.ts`
- Test: `src/modules/recruitment/email/render.test.ts`

**Interfaces:**
- Consumes: `getDescriptor` from `@/platform/email/templates/registry`; `loadLayoutSource` from `@/platform/email/templates/renderEmail`; `renderTemplate` from `@/platform/email/render/render`; `prisma` from `@/platform/db`; `prisma.recruitmentCycleEmail`, `prisma.emailTemplate`.
- Produces:
  - `CYCLE_EMAIL_KEYS: readonly [...]` and `type CycleEmailKey`.
  - `type EmailSources = { subjectSource: string; bodySource: string; layoutSource: string }`.
  - `resolveCycleEmail(cycleId: string, key: CycleEmailKey): Promise<EmailSources>`.
  - `renderResolvedEmail(sources: EmailSources, context: Record<string, unknown>): { subject: string; html: string }`.
  - `renderCycleEmail(cycleId: string, key: CycleEmailKey, context: Record<string, unknown>): Promise<{ subject: string; html: string }>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/email/render.test.ts`:

```ts
import { beforeEach, afterEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "@/modules/recruitment/services/cycles";
import { renderCycleEmail, resolveCycleEmail, CYCLE_EMAIL_KEYS } from "./render";

// createCycle is the canonical cycle factory used by the other recruitment
// service tests (see subcommittees.test.ts); it sets required defaults.
async function makeCycle() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rc-render", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("renders the descriptor default wrapped in the layout when there is no override", async () => {
  const cycle = await makeCycle();
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("You've been accepted to HAVEN: SRHD");
  expect(html).toContain("Congratulations Ann,");
  expect(html).toContain("<!DOCTYPE html>"); // layout wrapper applied
});

it("prefers a cycle override over the global default", async () => {
  const cycle = await makeCycle();
  await prisma.recruitmentCycleEmail.create({ data: { cycleId: cycle.id, key: "recruitment.acceptance", subject: "Welcome {{ firstName }}", body: "<p>Custom {{ departmentName }}</p>" } });
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Welcome Ann");
  expect(html).toContain("Custom SRHD");
});

it("falls back to the global EmailTemplate override when there is no cycle override", async () => {
  const cycle = await makeCycle();
  await prisma.emailTemplate.create({ data: { key: "recruitment.acceptance", subject: "Global {{ firstName }}", body: "<p>Global body</p>" } });
  const { subject, html } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Global Ann");
  expect(html).toContain("Global body");
});

it("cycle override beats global override", async () => {
  const cycle = await makeCycle();
  await prisma.emailTemplate.create({ data: { key: "recruitment.acceptance", subject: "Global", body: "<p>Global</p>" } });
  await prisma.recruitmentCycleEmail.create({ data: { cycleId: cycle.id, key: "recruitment.acceptance", subject: "Cycle", body: "<p>Cycle</p>" } });
  const { subject } = await renderCycleEmail(cycle.id, "recruitment.acceptance", { firstName: "Ann", cycleTitle: "V", departmentName: "SRHD" });
  expect(subject).toBe("Cycle");
});

it("rejects a non-cycle key and an unknown key", async () => {
  const cycle = await makeCycle();
  // @ts-expect-error portal_link is global-only, not a CycleEmailKey
  await expect(resolveCycleEmail(cycle.id, "recruitment.portal_link")).rejects.toThrow();
  // @ts-expect-error unknown key
  await expect(resolveCycleEmail(cycle.id, "nope")).rejects.toThrow();
});

it("exposes exactly the four cycle-scoped keys", () => {
  expect([...CYCLE_EMAIL_KEYS].sort()).toEqual([
    "recruitment.acceptance",
    "recruitment.application_received",
    "recruitment.interview_invite",
    "recruitment.onboarding",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/email/render.test.ts`
Expected: FAIL ("Cannot find module './render'").

- [ ] **Step 3: Implement the render seam**

Create `src/modules/recruitment/email/render.ts`:

```ts
import { prisma } from "@/platform/db";
import { getDescriptor } from "@/platform/email/templates/registry";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { renderTemplate } from "@/platform/email/render/render";

/** The recruitment emails that carry a cycle in their send context and can be
 *  overridden per cycle. recruitment.portal_link is global-only (no cycle). */
export const CYCLE_EMAIL_KEYS = [
  "recruitment.acceptance",
  "recruitment.interview_invite",
  "recruitment.onboarding",
  "recruitment.application_received",
] as const;
export type CycleEmailKey = (typeof CYCLE_EMAIL_KEYS)[number];

export type EmailSources = { subjectSource: string; bodySource: string; layoutSource: string };

function assertCycleKey(key: string): asserts key is CycleEmailKey {
  if (!(CYCLE_EMAIL_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Not a cycle email key: ${key}`);
  }
}

/** Resolve subject/body/layout sources for a cycle email: cycle override ->
 *  global EmailTemplate override -> descriptor default. Layout stays global. */
export async function resolveCycleEmail(cycleId: string, key: CycleEmailKey): Promise<EmailSources> {
  assertCycleKey(key);
  const descriptor = getDescriptor(key);
  if (!descriptor) throw new Error(`Unknown email template: ${key}`);

  const [cycleOverride, globalOverride, layoutSource] = await Promise.all([
    prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } }),
    prisma.emailTemplate.findUnique({ where: { key } }),
    loadLayoutSource(),
  ]);

  return {
    subjectSource: cycleOverride?.subject ?? globalOverride?.subject ?? descriptor.defaultSubject,
    bodySource: cycleOverride?.body ?? globalOverride?.body ?? descriptor.defaultBody,
    layoutSource,
  };
}

/** Render already-resolved sources with a context. Pure and synchronous, so the
 *  acceptance loop can resolve once and render per applicant. */
export function renderResolvedEmail(sources: EmailSources, context: Record<string, unknown>): { subject: string; html: string } {
  const subject = renderTemplate(sources.subjectSource, context);
  const body = renderTemplate(sources.bodySource, context);
  const html = renderTemplate(sources.layoutSource, { ...context, subject, body });
  return { subject, html };
}

export async function renderCycleEmail(
  cycleId: string,
  key: CycleEmailKey,
  context: Record<string, unknown>,
): Promise<{ subject: string; html: string }> {
  const sources = await resolveCycleEmail(cycleId, key);
  return renderResolvedEmail(sources, context);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/email/render.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/email/render.ts src/modules/recruitment/email/render.test.ts
git commit -m "feat(recruitment): cycle email render seam with layered resolution"
```

---

### Task 4: Cycle-emails service (list/edit/save/reset)

**Files:**
- Create: `src/modules/recruitment/services/cycle-emails.ts`
- Test: `src/modules/recruitment/services/cycle-emails.test.ts`

**Interfaces:**
- Consumes: `CYCLE_EMAIL_KEYS`, `CycleEmailKey`, `resolveCycleEmail` from `../email/render`; `getDescriptor` from `@/platform/email/templates/registry`; `loadLayoutSource` from `@/platform/email/templates/renderEmail`; `validateTemplate` from `@/platform/email/render/validate`; `can` from `@/platform/rbac/engine`; `recordAudit` from `@/platform/audit`; `prisma`.
- Produces:
  - `class CycleEmailValidationError extends Error { problems: string[] }`.
  - `class CycleEmailAuthError extends Error {}`.
  - `type CycleEmailSummary = { key: CycleEmailKey; name: string; hasOverride: boolean }`.
  - `type CycleEmailForEdit = { key: CycleEmailKey; name: string; variables: VariableDef[]; subject: string; body: string; hasOverride: boolean; layoutSource: string }`.
  - `listCycleEmails(cycleId): Promise<CycleEmailSummary[]>`.
  - `getCycleEmailForEdit(cycleId, key): Promise<CycleEmailForEdit>`.
  - `saveCycleEmail(cycleId, key, input: { subject; body }, actorId): Promise<void>`.
  - `resetCycleEmail(cycleId, key, actorId): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/services/cycle-emails.test.ts`:

```ts
import { beforeEach, afterEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import {
  listCycleEmails, getCycleEmailForEdit, saveCycleEmail, resetCycleEmail,
  CycleEmailValidationError, CycleEmailAuthError,
} from "./cycle-emails";

// Grant a permission via a role + a global (termId: null) person assignment,
// the proven pattern from subcommittees.test.ts / engine.test.ts.
async function manager() {
  const p = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Mgr", isSystem: false, grants: { create: [{ permission: "recruitment.manage_cycles" }] } } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: p.id, termId: null } });
  return p;
}
async function outsider() {
  return prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
}
async function makeCycle(createdById: string) {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rc-ce", departments: ["SRHD"], acceptsRenewals: false, createdById });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists the four cycle-scoped emails with no overrides initially", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const list = await listCycleEmails(cycle.id);
  expect(list.map((e) => e.key).sort()).toEqual([
    "recruitment.acceptance", "recruitment.application_received", "recruitment.interview_invite", "recruitment.onboarding",
  ]);
  expect(list.every((e) => e.hasOverride === false)).toBe(true);
});

it("getCycleEmailForEdit returns the effective default when unset", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(false);
  expect(e.subject).toBe("You've been accepted to HAVEN: {{ departmentName }}");
  expect(e.variables.map((v) => v.name)).toContain("departmentName");
  expect(e.layoutSource).toContain("{{{ body }}}");
});

it("saves a valid override, marks hasOverride, and records audit", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ firstName }}", body: "<p>{{ departmentName }}</p>" }, mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(true);
  expect(e.subject).toBe("Hi {{ firstName }}");
  const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.cycle_email_save" } });
  expect(audit).not.toBeNull();
});

it("rejects an unknown variable", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await expect(
    saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ bogus }}", body: "<p>x</p>" }, mgr.id)
  ).rejects.toBeInstanceOf(CycleEmailValidationError);
});

it("rejects a save by someone without manage_cycles", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  const out = await outsider();
  await expect(
    saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi", body: "<p>x</p>" }, out.id)
  ).rejects.toBeInstanceOf(CycleEmailAuthError);
});

it("resets an override and records audit", async () => {
  const mgr = await manager();
  const cycle = await makeCycle(mgr.id);
  await saveCycleEmail(cycle.id, "recruitment.acceptance", { subject: "Hi {{ firstName }}", body: "<p>x</p>" }, mgr.id);
  await resetCycleEmail(cycle.id, "recruitment.acceptance", mgr.id);
  const e = await getCycleEmailForEdit(cycle.id, "recruitment.acceptance");
  expect(e.hasOverride).toBe(false);
  const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.cycle_email_reset" } });
  expect(audit).not.toBeNull();
});
```

Note: confirm the role/grant/roleAssignment and `auditLog` shapes against an existing recruitment service test (for example `subcommittees.test.ts` and how `recordAudit` writes) and adjust the `manager()`/audit-query helpers to match the real schema before running. Use the same construction the existing tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/cycle-emails.test.ts`
Expected: FAIL ("Cannot find module './cycle-emails'").

- [ ] **Step 3: Implement the service**

Create `src/modules/recruitment/services/cycle-emails.ts`:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { getDescriptor } from "@/platform/email/templates/registry";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { validateTemplate } from "@/platform/email/render/validate";
import type { VariableDef } from "@/platform/email/templates/types";
import { CYCLE_EMAIL_KEYS, type CycleEmailKey, resolveCycleEmail } from "../email/render";

export class CycleEmailValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid template: ${problems.join("; ")}`);
    this.name = "CycleEmailValidationError";
  }
}
export class CycleEmailAuthError extends Error {
  constructor(message = "You do not have permission to edit cycle emails.") {
    super(message);
    this.name = "CycleEmailAuthError";
  }
}

export type CycleEmailSummary = { key: CycleEmailKey; name: string; hasOverride: boolean };
export type CycleEmailForEdit = {
  key: CycleEmailKey;
  name: string;
  variables: VariableDef[];
  subject: string;
  body: string;
  hasOverride: boolean;
  layoutSource: string;
};

function descriptorOrThrow(key: CycleEmailKey) {
  const d = getDescriptor(key);
  if (!d) throw new Error(`Unknown email template: ${key}`);
  return d;
}

function validateOrThrow(key: CycleEmailKey, subject: string, body: string): void {
  const allowed = descriptorOrThrow(key).variables.map((v) => v.name);
  const s = validateTemplate(subject, allowed);
  const b = validateTemplate(body, allowed);
  const problems = [
    ...s.errors,
    ...b.errors,
    ...s.unknownVariables.map((v) => `Unknown variable in subject: ${v}`),
    ...b.unknownVariables.map((v) => `Unknown variable in body: ${v}`),
  ];
  if (problems.length > 0) throw new CycleEmailValidationError(problems);
}

export async function listCycleEmails(cycleId: string): Promise<CycleEmailSummary[]> {
  const overrides = await prisma.recruitmentCycleEmail.findMany({ where: { cycleId }, select: { key: true } });
  const overridden = new Set(overrides.map((o) => o.key));
  return CYCLE_EMAIL_KEYS.map((key) => ({ key, name: descriptorOrThrow(key).name, hasOverride: overridden.has(key) }));
}

export async function getCycleEmailForEdit(cycleId: string, key: CycleEmailKey): Promise<CycleEmailForEdit> {
  const d = descriptorOrThrow(key);
  const [override, sources] = await Promise.all([
    prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } }),
    resolveCycleEmail(cycleId, key),
  ]);
  return {
    key,
    name: d.name,
    variables: d.variables,
    subject: sources.subjectSource,
    body: sources.bodySource,
    hasOverride: override !== null,
    layoutSource: await loadLayoutSource(),
  };
}

export async function saveCycleEmail(
  cycleId: string,
  key: CycleEmailKey,
  input: { subject: string; body: string },
  actorId: string,
): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) throw new CycleEmailAuthError();
  validateOrThrow(key, input.subject, input.body);
  const before = await prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } });
  await prisma.recruitmentCycleEmail.upsert({
    where: { cycleId_key: { cycleId, key } },
    create: { cycleId, key, subject: input.subject, body: input.body, updatedById: actorId },
    update: { subject: input.subject, body: input.body, updatedById: actorId },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_email_save",
    entityType: "RecruitmentCycleEmail",
    entityId: `${cycleId}:${key}`,
    before: before ? { subject: before.subject, body: before.body } : undefined,
    after: { subject: input.subject, body: input.body },
  });
}

export async function resetCycleEmail(cycleId: string, key: CycleEmailKey, actorId: string): Promise<void> {
  if (!(await can(actorId, "recruitment.manage_cycles"))) throw new CycleEmailAuthError();
  const before = await prisma.recruitmentCycleEmail.findUnique({ where: { cycleId_key: { cycleId, key } } });
  if (!before) return;
  await prisma.recruitmentCycleEmail.delete({ where: { cycleId_key: { cycleId, key } } });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.cycle_email_reset",
    entityType: "RecruitmentCycleEmail",
    entityId: `${cycleId}:${key}`,
    before: { subject: before.subject, body: before.body },
  });
}
```

Note: match `recordAudit`'s actual parameter names by checking `src/platform/audit` and an existing caller (for example `decisions.ts` uses `actorPersonId`, `action`, `entityType`, `entityId`, `after`). Adjust the calls above if the signature differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/cycle-emails.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/cycle-emails.ts src/modules/recruitment/services/cycle-emails.test.ts
git commit -m "feat(recruitment): cycle email service (list, edit, save, reset)"
```

---

### Task 5: Migrate acceptance + interview-invite send sites

**Files:**
- Modify: `src/modules/recruitment/services/decisions.ts`
- Modify: `src/modules/recruitment/services/interviews.ts`
- Delete: `src/modules/recruitment/email/templates/acceptance.ts`, `src/modules/recruitment/email/templates/acceptance.test.ts`
- Delete: `src/modules/recruitment/email/templates/interview-invite.ts`, `src/modules/recruitment/email/templates/interview-invite.test.ts`
- Test: extend `src/modules/recruitment/services/decisions.test.ts`, `src/modules/recruitment/services/interviews.test.ts`

**Interfaces:**
- Consumes: `resolveCycleEmail`, `renderResolvedEmail`, `renderCycleEmail` from `../email/render`; `esc` from `@/platform/email/render/escape`.

- [ ] **Step 1: Write the failing tests**

In `src/modules/recruitment/services/decisions.test.ts`, add a test that a cycle override changes the queued acceptance email. Use the file's existing helpers for building a cycle with an acceptance and releasing decisions; the new assertion:

```ts
it("uses the cycle's acceptance email override when present", async () => {
  // ... existing setup that creates a cycle with one acceptance ready to release;
  // capture the cycleId and the acceptance's applicant email.
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId, key: "recruitment.acceptance", subject: "Custom accept {{ firstName }}", body: "<p>Joined {{ departmentName }}</p>" },
  });
  await releaseDecisions(cycleId, actorId);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.acceptance" } });
  expect(mail.subject).toBe("Custom accept Ann"); // applicant firstName Ann
  expect(mail.html).toContain("Joined");
  expect(mail.html).toContain("<!DOCTYPE html>"); // layout applied
});
```

In `src/modules/recruitment/services/interviews.test.ts`, add:

```ts
it("uses the cycle's interview-invite override when present", async () => {
  // ... existing setup that creates an interview with scheduledAt set, capture cycleId + interviewId
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId, key: "recruitment.interview_invite", subject: "Talk {{ departmentName }}", body: "<p>At {{ interviewTime }}, join {{{ joinLink }}}</p>" },
  });
  await sendInterviewInvite(interviewId, actorId);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.interview_invite" } });
  expect(mail.subject).toContain("Talk");
  expect(mail.html).toContain("At ");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
```

Adapt variable names (`cycleId`, `actorId`, `interviewId`, applicant first name) to each test file's existing setup helpers. Read the current tests first and reuse their fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/recruitment/services/decisions.test.ts src/modules/recruitment/services/interviews.test.ts`
Expected: FAIL (the override is ignored; queued subject is still the default).

- [ ] **Step 3: Migrate decisions.ts (acceptance loop)**

In `src/modules/recruitment/services/decisions.ts`:
- Remove `import { acceptanceEmail } from "../email/templates/acceptance";`.
- Add `import { resolveCycleEmail, renderResolvedEmail } from "../email/render";`.
- Resolve the sources once before the loop, render per applicant. Replace the loop body's email construction:

```ts
  // Resolve the acceptance email sources once for the whole cycle.
  const acceptanceSources = await resolveCycleEmail(cycleId, "recruitment.acceptance");

  let sent = 0;
  const skippedApps = new Set<string>();
  for (const acc of acceptances) {
    if (acc.emailedAt) continue;
    if (conflictIds.has(acc.applicationId)) { skippedApps.add(acc.applicationId); continue; }
    const applicant = acc.application.applicant;
    const email = renderResolvedEmail(acceptanceSources, {
      firstName: applicant.firstName || "there",
      cycleTitle: cycle.title,
      departmentName: deptName.get(acc.departmentCode) ?? acc.departmentCode,
    });
    await prisma.$transaction(async (tx) => {
      await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
      await tx.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    });
    sent += 1;
  }
```

- [ ] **Step 4: Migrate interviews.ts (interview invite)**

In `src/modules/recruitment/services/interviews.ts`:
- Remove `import { interviewInviteEmail } from "../email/templates/interview-invite";`.
- Add `import { renderCycleEmail } from "../email/render";` and `import { esc } from "@/platform/email/render/escape";`.
- The interview query already includes `application: { include: { applicant: true } }`; also read the cycle id. Update the query to include the cycle id (the application has `cycleId`):

```ts
  const iv = await prisma.interview.findUnique({ where: { id: interviewId }, include: { application: { include: { applicant: true, cycle: { select: { id: true } } } } } });
```

- Replace the email construction + queue:

```ts
  const dept = await prisma.department.findUnique({ where: { code: iv.departmentCode }, select: { name: true } });
  const applicant = iv.application.applicant;
  const interviewTime = iv.scheduledAt.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "America/New_York" });
  const joinLink = iv.zoomLink ? `<a href="${esc(iv.zoomLink)}">${esc(iv.zoomLink)}</a>` : "link to follow";
  const email = await renderCycleEmail(iv.application.cycle.id, "recruitment.interview_invite", {
    firstName: applicant.firstName || "there",
    departmentName: dept?.name ?? iv.departmentCode,
    interviewTime,
    joinLink,
  });
  await prisma.$transaction(async (tx) => {
    await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.interview_invite" });
    await tx.interview.update({ where: { id: interviewId }, data: { invitedAt: new Date() } });
  });
```

(`iv.scheduledAt` is already null-checked earlier in the function by the existing `if (!iv.scheduledAt) throw ...` guard.)

- [ ] **Step 5: Delete the obsolete inline templates and their tests**

```bash
git rm src/modules/recruitment/email/templates/acceptance.ts src/modules/recruitment/email/templates/acceptance.test.ts \
       src/modules/recruitment/email/templates/interview-invite.ts src/modules/recruitment/email/templates/interview-invite.test.ts
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/decisions.test.ts src/modules/recruitment/services/interviews.test.ts`
Expected: PASS (existing tests plus the two new override tests). Also run `npx tsc --noEmit` to confirm the deleted imports are gone.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(recruitment): route acceptance + interview emails through cycle render seam"
```

---

### Task 6: Migrate onboarding + application-received + portal-link send sites

**Files:**
- Modify: `src/modules/recruitment/services/onboarding.ts`
- Modify: `src/modules/recruitment/services/submissions.ts`
- Modify: `src/modules/recruitment/services/portal-auth.ts`
- Delete: `src/modules/recruitment/email/templates/onboarding.ts`, `src/modules/recruitment/email/templates/onboarding.test.ts`
- Delete: `src/modules/recruitment/services/portal-link-email.ts`
- Test: extend `src/modules/recruitment/services/onboarding.test.ts`, `src/modules/recruitment/services/submissions.test.ts`, `src/modules/recruitment/services/portal-auth.test.ts`

**Interfaces:**
- Consumes: `renderCycleEmail` from `../email/render`; `renderEmail` from `@/platform/email/templates/renderEmail` (for the global magic link).

- [ ] **Step 1: Write the failing tests**

In `src/modules/recruitment/services/onboarding.test.ts`, add a test that a cycle override changes the queued onboarding email (reuse the file's setup that creates an acceptance and calls `createOrResendContract`):

```ts
it("uses the cycle's onboarding email override when present", async () => {
  // ... existing setup creating an acceptance; capture cycleId and call createOrResendContract
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId, key: "recruitment.onboarding", subject: "Finish {{ cycleTitle }}", body: '<p>Go to <a href="{{ contractUrl }}">link</a></p>' },
  });
  await createOrResendContract(acceptanceId, actorId, "https://hub.test");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.onboarding" } });
  expect(mail.subject).toContain("Finish");
  expect(mail.html).toContain("Go to");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
```

In `src/modules/recruitment/services/submissions.test.ts`, add a test that a cycle override changes the application-received confirmation:

```ts
it("uses the cycle's application-received override when present", async () => {
  const { cycle } = await openVolunteerCycle();
  await prisma.recruitmentCycleEmail.create({
    data: { cycleId: cycle.id, key: "recruitment.application_received", subject: "Got it {{ firstName }}", body: "<p>Re {{ cycleTitle }}</p>" },
  });
  await submitApplication("apply-v", { applicantType: "NEW", answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "MDIC" }, files: {} });
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.application_received" } });
  expect(mail.subject).toBe("Got it Ann");
  expect(mail.html).toContain("Re V");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
```

In `src/modules/recruitment/services/portal-auth.test.ts`, add a test that the magic link uses the global template default and is wrapped in the layout (reuse the file's `requestMagicLink` setup):

```ts
it("queues a magic link rendered through the global template + layout", async () => {
  await requestMagicLink("someone@yale.edu");
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { template: "recruitment.portal_link" } });
  expect(mail.subject).toBe("Your HAVEN Hub application link");
  expect(mail.html).toContain("Open my application");
  expect(mail.html).toContain("<!DOCTYPE html>");
});
```

Adapt the captured ids (`cycleId`, `acceptanceId`, `actorId`) to each file's existing fixtures.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts src/modules/recruitment/services/submissions.test.ts src/modules/recruitment/services/portal-auth.test.ts`
Expected: FAIL (overrides ignored; magic link not layout-wrapped).

- [ ] **Step 3: Migrate onboarding.ts**

In `src/modules/recruitment/services/onboarding.ts`:
- Remove `import { onboardingEmail } from "../email/templates/onboarding";`.
- Add `import { renderCycleEmail } from "../email/render";`.
- The `acceptance` query already includes `application: { include: { applicant: true, cycle: { select: { title: true } } } }`. Add `id: true` to the cycle select: `cycle: { select: { id: true, title: true } }`.
- Replace the email construction (keep the rest of the transaction unchanged):

```ts
  const url = `${baseUrl}/onboard/${contract.token}`;
  const email = await renderCycleEmail(acceptance.application.cycle.id, "recruitment.onboarding", {
    firstName: contract.firstName || "there",
    cycleTitle: acceptance.application.cycle.title,
    contractUrl: url,
  });
  const c = contract;
```

- [ ] **Step 4: Migrate submissions.ts (application received)**

In `src/modules/recruitment/services/submissions.ts`, replace the inline `queueEmail` for the confirmation. The send happens inside a `tx` block; render before/within is fine since `renderCycleEmail` reads via the global client. Just before the `tx.application` create/update returns, build the email and queue it:

```ts
      const receivedEmail = await renderCycleEmail(cycle.id, "recruitment.application_received", {
        firstName: firstName || "there",
        cycleTitle: cycle.title,
      });
      await queueEmail(tx, {
        to: email,
        subject: receivedEmail.subject,
        html: receivedEmail.html,
        template: "recruitment.application_received",
      });
```

Add `import { renderCycleEmail } from "../email/render";` at the top. If `escapeHtml` is now unused in `submissions.ts` after this change, remove its definition/import to keep the file clean (check for other uses first; it may still be used elsewhere in the file, in which case leave it).

- [ ] **Step 5: Migrate portal-auth.ts (magic link, global)**

In `src/modules/recruitment/services/portal-auth.ts`:
- Remove `import { portalLinkEmail } from "./portal-link-email";`.
- Add `import { renderEmail } from "@/platform/email/templates/renderEmail";`.
- Replace the email build + queue in `requestMagicLink`:

```ts
  const url = `${config.APP_BASE_URL}/apply/verify?token=${encodeURIComponent(raw)}`;
  const mail = await renderEmail("recruitment.portal_link", { firstName: "there", portalUrl: url });
  await queueEmail(prisma, { to: emailLower, subject: mail.subject, html: mail.html, template: "recruitment.portal_link" });
```

- [ ] **Step 6: Delete the obsolete inline templates**

```bash
git rm src/modules/recruitment/email/templates/onboarding.ts src/modules/recruitment/email/templates/onboarding.test.ts \
       src/modules/recruitment/services/portal-link-email.ts
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/modules/recruitment/services/onboarding.test.ts src/modules/recruitment/services/submissions.test.ts src/modules/recruitment/services/portal-auth.test.ts`
Expected: PASS. Run `npx tsc --noEmit` to confirm no dangling imports.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(recruitment): route onboarding, confirmation, and magic-link emails through the template system"
```

---

### Task 7: Per-cycle email editor UI

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/emails/page.tsx`
- Create: `src/app/(app)/recruitment/cycles/[id]/emails/[key]/page.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (add nav link)
- Test: manual (UI). No node-env test (the editor is a client component; the service is covered by Task 4).

**Interfaces:**
- Consumes: `listCycleEmails`, `getCycleEmailForEdit`, `saveCycleEmail`, `resetCycleEmail`, `CycleEmailValidationError` from `@/modules/recruitment/services/cycle-emails`; `TemplateEditor` from `@/app/(app)/admin/email/templates/[key]/preview`; `requirePermission` from `@/platform/auth/session`; `CYCLE_EMAIL_KEYS` / `CycleEmailKey` from `@/modules/recruitment/email/render`.

- [ ] **Step 1: Add the nav link**

In `src/app/(app)/recruitment/cycles/[id]/page.tsx`, add a nav link alongside the existing ones (near the "Onboarding" link, using the same `navLink` class):

```tsx
        <Link href={`/recruitment/cycles/${id}/emails`} className={navLink}>Edit emails</Link>
```

- [ ] **Step 2: Build the list page**

Create `src/app/(app)/recruitment/cycles/[id]/emails/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { listCycleEmails } from "@/modules/recruitment/services/cycle-emails";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";

export default async function CycleEmailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!cycle) notFound();
  const emails = await listCycleEmails(cycle.id);
  return (
    <div className="space-y-6">
      <PageHeader title="Cycle emails" description={`Customize the emails sent for ${cycle.title}. Unset emails use the global default.`} />
      <ul className="space-y-2">
        {emails.map((e) => (
          <li key={e.key} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-foreground">{e.name}</span>
              <span className="block text-xs text-muted-foreground">{e.hasOverride ? "Customized for this cycle" : "Using the default"}</span>
            </span>
            <Link href={`/recruitment/cycles/${cycle.id}/emails/${encodeURIComponent(e.key)}`} className={buttonClasses("outline", "sm")}>Edit</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Build the editor page**

Create `src/app/(app)/recruitment/cycles/[id]/emails/[key]/page.tsx` (mirrors the admin editor page at `src/app/(app)/admin/email/templates/[key]/page.tsx`, but scoped to the cycle service and key set):

```tsx
import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getCycleEmailForEdit, saveCycleEmail, resetCycleEmail, CycleEmailValidationError,
} from "@/modules/recruitment/services/cycle-emails";
import { CYCLE_EMAIL_KEYS, type CycleEmailKey } from "@/modules/recruitment/email/render";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";

type Props = { params: Promise<{ id: string; key: string }>; searchParams: Promise<{ error?: string }> };

function isCycleKey(k: string): k is CycleEmailKey {
  return (CYCLE_EMAIL_KEYS as readonly string[]).includes(k);
}

export default async function EditCycleEmailPage({ params, searchParams }: Props) {
  await requirePermission("recruitment.manage_cycles");
  const { id, key } = await params;
  const { error } = await searchParams;
  const decodedKey = decodeURIComponent(key);
  if (!isCycleKey(decodedKey)) notFound();
  const t = await getCycleEmailForEdit(id, decodedKey);
  const base = `/recruitment/cycles/${id}/emails/${key}`;

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    try {
      await saveCycleEmail(id, decodedKey as CycleEmailKey, { subject, body }, actor.personId);
    } catch (err) {
      if (err instanceof CycleEmailValidationError) {
        redirect(`${base}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(base);
    redirect(base);
  }

  async function resetAction() {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    await resetCycleEmail(id, decodedKey as CycleEmailKey, actor.personId);
    revalidatePath(base);
    redirect(base);
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t.name} description={t.hasOverride ? "Customized for this cycle" : "Using the default"} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <form action={saveAction}>
        <TemplateEditor
          templateKey={t.key}
          variables={t.variables}
          initialSubject={t.subject}
          initialBody={t.body}
          isLayout={false}
          layoutSource={t.layoutSource}
        />
        <div className="mt-4 flex gap-2">
          <Button type="submit">Save</Button>
        </div>
      </form>
      {t.hasOverride ? (
        <form action={resetAction}>
          <Button type="submit" variant="outline">Reset to default</Button>
        </form>
      ) : null}
    </div>
  );
}
```

Note: confirm `requirePermission` returns an object with `personId` (the admin editor page uses `actor.personId`). If its shape differs, match the admin page's usage exactly. Confirm the `TemplateEditor` import path resolves from this location; if the route-group alias makes the deep import awkward, re-export `TemplateEditor` from a small shared module and import that instead, rather than duplicating the component.

- [ ] **Step 4: Verify build + typecheck**

Run: `npm run typecheck && npm run build`
Expected: PASS, both pages compile.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(recruitment): per-cycle email editor UI on the cycle page"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1:** `npx vitest run src/modules/recruitment src/platform/email` - expect pass. Any failure outside these paths that is a known shared-test-DB or /tmp cert flake is acceptable; a recruitment/email failure is not.
- [ ] **Step 2:** `npm run typecheck` - clean.
- [ ] **Step 3:** `npm run lint` - the only errors are the pre-existing ones under `HAVEN Free Clinic Design System/`; nothing in the files this plan touched.
- [ ] **Step 4:** `npm run build` - clean (page count compiles).
- [ ] **Step 5:** `npx prisma migrate status` - the new migration is listed as applied; no drift.
- [ ] **Step 6:** Manual smoke (record as a note, not a code change): on a cycle page, open Edit emails, edit the acceptance subject with `{{ firstName }}`, save (preview renders), confirm hasOverride flips; reset returns to default; the global `/admin/email/templates` list now shows all five recruitment templates.
- [ ] **Step 7:** Commit any verification fixes (if none, nothing to commit).

---

## Self-Review Notes

- **Spec coverage:** descriptors + registry (Task 1) [spec: Descriptors]; data model + migration + resetDb (Task 2) [spec: Data model, Testing]; render seam with cycle->global->default + layout (Task 3) [spec: Render seam, Resolution order]; service list/edit/save/reset with permission + validation + audit (Task 4) [spec: Service layer]; all five send-site migrations + deletion of inline functions (Tasks 5-6) [spec: Send-site integration]; per-cycle editor UI gated by recruitment.manage_cycles reusing TemplateEditor (Task 7) [spec: Admin UX]; verification incl. migrate status (Task 8). Global editing of all five is delivered by Task 1's registration (spec: Global editor, no extra work).
- **Shared-layout consequence:** every migrated email now renders inside the layout; the tests assert `<!DOCTYPE html>` to lock this in.
- **Type consistency:** `CycleEmailKey` / `CYCLE_EMAIL_KEYS` (Task 3) are reused verbatim in Tasks 4 and 7; `resolveCycleEmail` / `renderResolvedEmail` / `renderCycleEmail` signatures (Task 3) match their call sites (Tasks 4, 5, 6); the composite selector `where: { cycleId_key: { cycleId, key } }` (Task 2 unique) is used consistently in Tasks 3 and 4.
- **Fixture caveat flagged in-task:** the exact role/grant/audit construction (Task 4) and the per-file send-site fixtures (Tasks 5-6) must be matched to the existing test files; each task says to read the current tests first and reuse their helpers rather than invent new ones.
```
