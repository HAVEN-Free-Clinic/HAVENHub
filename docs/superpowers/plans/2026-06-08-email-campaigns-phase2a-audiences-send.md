# Email Campaigns — Phase 2A: Audiences + Send-Now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins compose a styled email, target a dynamic set of People via a structured condition builder, preview the recipients, and send the blast now (through the existing queue/worker).

**Architecture:** A structured **audience** (record type + match mode + flat condition list) compiles to a Prisma `where` over `Person`, scoped to the active term for membership/department conditions. `resolveAudience` returns recipients with per-person variables. A campaign stores an inline subject + body (composed in the Phase 1 rich-text editor) and the audience JSON. "Send now" resolves the audience, creates a run, renders each email (inline body wrapped in the shared branded layout), and enqueues one `EmailLog` per recipient via the existing `queueEmail` — the existing `email-send` worker delivers them. Safety: recipient preview, test-send-to-self, typed confirmation above a threshold, per-run dedup, and audit logging.

**Tech Stack:** TypeScript, Next.js App Router, Prisma + Postgres, vitest (integration tests against the isolated test DB), the Phase 1 render engine + branded layout + TipTap editor.

**Scope notes:**
- **People only.** The spec's Applicant audience is **deferred**: the recruitment models (`Applicant`/`Application`/`RecruitmentCycle`) live on the unmerged `plan-10` branch, not `main` (this branch's base). The audience engine is built with a `recordType` seam so `APPLICANT` can be added once plan-10 merges.
- **Send-now only.** Scheduling and recurrence are **Phase 2B** (a separate plan): a `campaign-dispatch` worker job, schedule columns, and per-period re-evaluation. Phase 2A's send path is reused there.
- **Flat conditions, ALL/ANY.** Conditions are a flat list combined with a single match mode (ALL = AND, ANY = OR). Nested AND/OR groups are a future extension; the types leave room but the compiler implements flat.

**Environment (for the implementer):**
- Isolated DBs: dev `havenhub_emailwt`, test `havenhub_test_emailwt` (localhost:5434, haven/haven_dev). Prisma CLI auto-loads `.env` → dev DB. **vitest does not load `.env`** — run DB tests ONLY with `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run <file>`. Never a bare `npm test`.
- If a Prisma migrate step ever prompts to RESET the database, STOP and report BLOCKED.

---

## File Structure

**New — audience engine (`src/platform/email/audience/`):**
- `types.ts` — `Audience`, `AudienceCondition`, `AudienceRecordType`, `ConditionOp`
- `person-fields.ts` — whitelist of Person audience fields → Prisma `where` fragments + UI option metadata
- `compile.ts` — `compilePersonWhere(audience, ctx)` → `Prisma.PersonWhereInput`
- `resolve.ts` — `resolveAudience(audience)` → `{ recipients, excludedNoEmail }`
- `variables.ts` — `PERSON_VARIABLES` catalog + `personVariables(person)` builder
- `*.test.ts` siblings

**New — campaigns (`src/platform/email/campaigns/`):**
- `service.ts` — CRUD for draft campaigns, `previewAudience`, `testSend`, `sendCampaignNow`
- `service.test.ts`

**New — inline rendering:**
- add `renderInlineEmail({subject, body}, context)` to `src/platform/email/templates/renderEmail.ts`

**New — admin UI (`src/app/admin/email/campaigns/`):**
- `page.tsx` — campaign list
- `new/page.tsx` — create a draft (name) → redirect to editor
- `[id]/page.tsx` — editor: compose + audience builder + preview + test-send + send
- `[id]/audience-builder.tsx` — client condition builder
- reuse `src/app/admin/email/templates/[key]/preview.tsx` `TemplateEditor` for the body (generalized: `templateKey`/`isLayout`/`layoutSource` made optional)

**Modified:**
- `prisma/schema.prisma` — `EmailCampaign`, `EmailCampaignRun` models; `EmailLog.campaignRunId` + relation + unique `(campaignRunId, toEmail)`
- `src/platform/test/db.ts` — add `EmailCampaign`, `EmailCampaignRun` to `resetDb()` TRUNCATE list
- `src/platform/email/send.ts` — `QueueEmailInput` gains optional `campaignRunId`
- `src/platform/modules/registry.ts` — add `admin.send_email_campaign` permission + an "Email" nav already exists
- `src/app/admin/email/page.tsx` — link to `/admin/email/campaigns`

---

## Task 1: Audience types

**Files:** Create `src/platform/email/audience/types.ts`; Test `src/platform/email/audience/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/audience/types.test.ts
import { describe, expect, it } from "vitest";
import { isAudience, type Audience } from "./types";

describe("audience types", () => {
  it("accepts a well-formed PERSON audience", () => {
    const a: Audience = { recordType: "PERSON", match: "ALL", conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] };
    expect(isAudience(a)).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isAudience(null)).toBe(false);
    expect(isAudience({ recordType: "PERSON" })).toBe(false);
    expect(isAudience({ recordType: "PERSON", match: "MAYBE", conditions: [] })).toBe(false);
    expect(isAudience({ recordType: "OTHER", match: "ALL", conditions: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`...npx vitest run src/platform/email/audience/types.test.ts`)

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/audience/types.ts
export type AudienceRecordType = "PERSON"; // extensible: future "APPLICANT"
export type ConditionOp = "eq" | "in" | "isTrue" | "isFalse";

export type AudienceCondition = {
  field: string;
  op: ConditionOp;
  value?: string | string[];
};

export type Audience = {
  recordType: AudienceRecordType;
  match: "ALL" | "ANY";
  conditions: AudienceCondition[];
};

export function isAudience(v: unknown): v is Audience {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.recordType !== "PERSON") return false;
  if (a.match !== "ALL" && a.match !== "ANY") return false;
  if (!Array.isArray(a.conditions)) return false;
  return a.conditions.every(
    (c) => c && typeof c === "object" && typeof (c as AudienceCondition).field === "string",
  );
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): audience condition types"`)

---

## Task 2: Person field whitelist

**Files:** Create `src/platform/email/audience/person-fields.ts`; Test `person-fields.test.ts`

Each field maps a condition (+ active term context) to a `Prisma.PersonWhereInput` fragment, and carries UI metadata (label, kind, options).

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/audience/person-fields.test.ts
import { describe, expect, it } from "vitest";
import { PERSON_FIELDS, personFieldWhere } from "./person-fields";

const ctx = { activeTermId: "term1" };

describe("person fields", () => {
  it("exposes a whitelist with options", () => {
    const keys = PERSON_FIELDS.map((f) => f.key);
    expect(keys).toEqual(["status", "role", "department", "complianceStatus", "hasEpicId"]);
  });

  it("status -> direct equality", () => {
    expect(personFieldWhere({ field: "status", op: "eq", value: "ACTIVE" }, ctx)).toEqual({ status: "ACTIVE" });
  });

  it("role -> active-term membership of that kind", () => {
    expect(personFieldWhere({ field: "role", op: "eq", value: "DIRECTOR" }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", kind: "DIRECTOR" } },
    });
  });

  it("department -> active-term membership in those department codes", () => {
    expect(personFieldWhere({ field: "department", op: "in", value: ["CARDIO", "PEDS"] }, ctx)).toEqual({
      memberships: { some: { termId: "term1", status: "ACTIVE", department: { code: { in: ["CARDIO", "PEDS"] } } } },
    });
  });

  it("complianceStatus -> ComplianceReminder.lastStatus in values", () => {
    expect(personFieldWhere({ field: "complianceStatus", op: "in", value: ["EXPIRED"] }, ctx)).toEqual({
      complianceReminder: { lastStatus: { in: ["EXPIRED"] } },
    });
  });

  it("hasEpicId true/false", () => {
    expect(personFieldWhere({ field: "hasEpicId", op: "isTrue" }, ctx)).toEqual({ epicId: { not: null } });
    expect(personFieldWhere({ field: "hasEpicId", op: "isFalse" }, ctx)).toEqual({ epicId: null });
  });

  it("throws on an unknown field", () => {
    expect(() => personFieldWhere({ field: "bogus", op: "eq", value: "x" }, ctx)).toThrow(/Unknown audience field/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/audience/person-fields.ts
import type { Prisma } from "@prisma/client";
import type { AudienceCondition } from "./types";

export type PersonFieldKind = "enum" | "multiEnum" | "boolean";
export type PersonFieldDef = {
  key: string;
  label: string;
  kind: PersonFieldKind;
  options?: { value: string; label: string }[];
};

export type AudienceCtx = { activeTermId: string | null };

const COMPLIANCE_VALUES = ["COMPLIANT", "EXPIRING_SOON", "EXPIRED", "UNKNOWN_DATE", "NO_CERTIFICATE"];

export const PERSON_FIELDS: PersonFieldDef[] = [
  { key: "status", label: "Account status", kind: "enum", options: [
    { value: "ACTIVE", label: "Active" }, { value: "OFFBOARDED", label: "Offboarded" } ] },
  { key: "role", label: "Role (this term)", kind: "enum", options: [
    { value: "DIRECTOR", label: "Director" }, { value: "VOLUNTEER", label: "Volunteer" } ] },
  { key: "department", label: "Department (this term)", kind: "multiEnum" },
  { key: "complianceStatus", label: "HIPAA compliance status", kind: "multiEnum",
    options: COMPLIANCE_VALUES.map((v) => ({ value: v, label: v })) },
  { key: "hasEpicId", label: "Has an Epic ID", kind: "boolean" },
];

function asArray(value: AudienceCondition["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export function personFieldWhere(cond: AudienceCondition, ctx: AudienceCtx): Prisma.PersonWhereInput {
  switch (cond.field) {
    case "status":
      return { status: cond.value as "ACTIVE" | "OFFBOARDED" };
    case "role":
      return { memberships: { some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", kind: cond.value as "DIRECTOR" | "VOLUNTEER" } } };
    case "department":
      return { memberships: { some: { termId: ctx.activeTermId ?? "", status: "ACTIVE", department: { code: { in: asArray(cond.value) } } } } };
    case "complianceStatus":
      return { complianceReminder: { lastStatus: { in: asArray(cond.value) } } };
    case "hasEpicId":
      return cond.op === "isFalse" ? { epicId: null } : { epicId: { not: null } };
    default:
      throw new Error(`Unknown audience field: ${cond.field}`);
  }
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): person audience field whitelist"`)

> Note: department options are loaded dynamically from the DB in the UI (Task 11), not hardcoded here.

---

## Task 3: Compile audience → Prisma where

**Files:** Create `src/platform/email/audience/compile.ts`; Test `compile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/audience/compile.test.ts
import { describe, expect, it } from "vitest";
import { compilePersonWhere } from "./compile";

const ctx = { activeTermId: "t1" };

describe("compilePersonWhere", () => {
  it("ALL -> AND of fragments", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "role", op: "eq", value: "VOLUNTEER" },
      ] }, ctx);
    expect(where).toEqual({ AND: [
      { status: "ACTIVE" },
      { memberships: { some: { termId: "t1", status: "ACTIVE", kind: "VOLUNTEER" } } },
    ] });
  });

  it("ANY -> OR of fragments", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ANY", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "hasEpicId", op: "isTrue" },
      ] }, ctx);
    expect(where).toEqual({ OR: [{ status: "ACTIVE" }, { epicId: { not: null } }] });
  });

  it("no conditions -> match nothing (guards against an accidental send-all)", () => {
    expect(compilePersonWhere({ recordType: "PERSON", match: "ALL", conditions: [] }, ctx)).toEqual({ id: { in: [] } });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/audience/compile.ts
import type { Prisma } from "@prisma/client";
import type { Audience } from "./types";
import { personFieldWhere, type AudienceCtx } from "./person-fields";

export function compilePersonWhere(audience: Audience, ctx: AudienceCtx): Prisma.PersonWhereInput {
  // Empty condition list matches NOTHING — never an accidental "everyone" blast.
  if (audience.conditions.length === 0) return { id: { in: [] } };
  const fragments = audience.conditions.map((c) => personFieldWhere(c, ctx));
  return audience.match === "ALL" ? { AND: fragments } : { OR: fragments };
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): compile audience to prisma where"`)

---

## Task 4: Person variables catalog

**Files:** Create `src/platform/email/audience/variables.ts`; Test `variables.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/audience/variables.test.ts
import { describe, expect, it } from "vitest";
import { PERSON_VARIABLES, personVariables } from "./variables";

describe("person variables", () => {
  it("declares a campaign variable catalog", () => {
    expect(PERSON_VARIABLES.map((v) => v.name)).toEqual(["firstName", "name"]);
  });

  it("derives firstName from the first whitespace-separated token", () => {
    expect(personVariables({ name: "Jane Q Doe" })).toEqual({ firstName: "Jane", name: "Jane Q Doe" });
    expect(personVariables({ name: "" })).toEqual({ firstName: "", name: "" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/audience/variables.ts
import type { VariableDef } from "@/platform/email/templates/types";

export const PERSON_VARIABLES: VariableDef[] = [
  { name: "firstName", label: "First name", sampleValue: "Sam" },
  { name: "name", label: "Full name", sampleValue: "Sam Rivera" },
];

export function personVariables(p: { name: string }): Record<string, string> {
  const firstName = p.name.trim().split(/\s+/)[0] ?? "";
  return { firstName: p.name.trim() === "" ? "" : firstName, name: p.name };
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): person variable catalog"`)

---

## Task 5: Resolve audience → recipients (DB-backed)

**Files:** Create `src/platform/email/audience/resolve.ts`; Test `resolve.test.ts`

- [ ] **Step 1: Write the failing test** (seeds People + memberships, asserts resolution + email exclusion)

```typescript
// src/platform/email/audience/resolve.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";

beforeEach(resetDb);

async function person(name: string, email: string | null, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, contactEmail: email, status } });
}

describe("resolveAudience (PERSON)", () => {
  it("returns recipients matching the where and excludes blank emails", async () => {
    await person("Active One", "one@example.com", "ACTIVE");
    await person("Active NoEmail", null, "ACTIVE");
    await person("Offboarded", "off@example.com", "OFFBOARDED");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual(["one@example.com"]);
    expect(res.excludedNoEmail).toBe(1);
    expect(res.recipients[0].variables).toEqual({ firstName: "Active", name: "Active One" });
    expect(res.recipients[0].recordType).toBe("PERSON");
  });

  it("empty conditions resolve to zero recipients", async () => {
    await person("Someone", "s@example.com");
    const res = await resolveAudience({ recordType: "PERSON", match: "ALL", conditions: [] });
    expect(res.recipients).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/platform/email/audience/resolve.ts
import { prisma } from "@/platform/db";
import type { Audience } from "./types";
import { compilePersonWhere } from "./compile";
import { personVariables } from "./variables";

export type Recipient = {
  email: string;
  displayName: string;
  recordType: "PERSON";
  recordId: string;
  variables: Record<string, string>;
};

export type ResolvedAudience = { recipients: Recipient[]; excludedNoEmail: number };

export async function resolveAudience(audience: Audience): Promise<ResolvedAudience> {
  const activeTerm = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  const where = compilePersonWhere(audience, { activeTermId: activeTerm?.id ?? null });
  const people = await prisma.person.findMany({
    where,
    select: { id: true, name: true, contactEmail: true },
    orderBy: { name: "asc" },
  });

  const recipients: Recipient[] = [];
  let excludedNoEmail = 0;
  for (const p of people) {
    const email = p.contactEmail?.trim() ?? "";
    if (email === "") { excludedNoEmail++; continue; }
    recipients.push({
      email,
      displayName: p.name,
      recordType: "PERSON",
      recordId: p.id,
      variables: personVariables({ name: p.name }),
    });
  }
  return { recipients, excludedNoEmail };
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): resolve person audience to recipients"`)

---

## Task 6: `renderInlineEmail`

**Files:** Modify `src/platform/email/templates/renderEmail.ts`; Test add to `renderEmail.test.ts`

Campaigns compose an inline subject+body (not a registry descriptor). Add a sibling renderer that renders inline subject/body and wraps the body in the shared layout (same override resolution as `renderEmail`).

- [ ] **Step 1: Write the failing test** (append to renderEmail.test.ts)

```typescript
  it("renderInlineEmail renders inline subject/body and wraps in the layout", async () => {
    const out = await renderInlineEmail(
      { subject: "Hi {{ firstName }}", body: "<p>Hello {{ name }}</p>" },
      { firstName: "Sam", name: "Sam Rivera" },
    );
    expect(out.subject).toBe("Hi Sam");
    expect(out.html).toContain("<p>Hello Sam Rivera</p>");
    expect(out.html).toContain("HAVEN Free Clinic"); // wrapped in branded layout
  });
```

(Add `renderInlineEmail` to the import at the top of the test file.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — add to `renderEmail.ts`, refactoring the layout-wrap into a shared helper:

```typescript
async function loadLayoutSource(): Promise<string> {
  const layout = getDescriptor(LAYOUT_KEY);
  if (!layout) throw new Error("Missing layout template");
  const override = await prisma.emailTemplate.findUnique({ where: { key: LAYOUT_KEY } });
  return override?.body ?? layout.defaultBody;
}

export async function renderInlineEmail(
  input: { subject: string; body: string },
  context: Record<string, unknown>,
): Promise<RenderedEmail> {
  const subject = renderTemplate(input.subject, context);
  const renderedBody = renderTemplate(input.body, context);
  const layoutSource = await loadLayoutSource();
  const html = renderTemplate(layoutSource, { ...context, body: renderedBody, subject });
  return { subject, html };
}
```

(Leave the existing `renderEmail` behavior unchanged; it may optionally call `loadLayoutSource` too, but do not change its output.)

- [ ] **Step 4: Run — expect PASS** (run the whole renderEmail.test.ts)
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): renderInlineEmail for campaign bodies"`)

---

## Task 7: Campaign schema + migration

**Files:** Modify `prisma/schema.prisma`, `src/platform/test/db.ts`, `src/platform/email/send.ts`

- [ ] **Step 1: Add models + EmailLog link to `schema.prisma`**

```prisma
enum EmailCampaignStatus {
  DRAFT
  SENDING
  SENT
  CANCELLED
}

model EmailCampaign {
  id          String              @id @default(cuid())
  name        String
  recordType  String              @default("PERSON")
  audienceJson Json
  subject     String              @default("")
  body        String              @default("")
  status      EmailCampaignStatus @default(DRAFT)
  createdById String?
  createdBy   Person?             @relation("campaignCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  runs        EmailCampaignRun[]
}

model EmailCampaignRun {
  id             String        @id @default(cuid())
  campaignId     String
  campaign       EmailCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  runAt          DateTime      @default(now())
  recipientCount Int           @default(0)
  status         String        @default("SENT")
  emails         EmailLog[]    @relation("emailLogCampaignRun")

  @@index([campaignId])
}
```

Add to `EmailLog`:
```prisma
  campaignRunId String?
  campaignRun   EmailCampaignRun? @relation("emailLogCampaignRun", fields: [campaignRunId], references: [id], onDelete: SetNull)
```
and a per-run dedup unique:
```prisma
  @@unique([campaignRunId, toEmail])
```

Add the back-relation to `Person`:
```prisma
  campaignsCreated EmailCampaign[] @relation("campaignCreatedBy")
```

> Note on the unique: `(null, toEmail)` rows (all non-campaign emails) do not collide because Postgres treats NULLs as distinct in unique indexes — existing transactional emails are unaffected.

- [ ] **Step 2: Migrate dev + test DBs**

`npx prisma migrate dev --name add_email_campaigns` (dev DB via .env). Then apply to test DB:
`DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx prisma migrate deploy`
If a reset is prompted, STOP and report BLOCKED.

- [ ] **Step 3: Update `resetDb()`** — add `"EmailCampaign"` and `"EmailCampaignRun"` to the TRUNCATE list in `src/platform/test/db.ts` (next to `"EmailLog"`; order: child `EmailCampaignRun` and `EmailLog` before `EmailCampaign` is unnecessary with CASCADE, but include all three).

- [ ] **Step 4: Extend `QueueEmailInput`** in `src/platform/email/send.ts`:

```typescript
export type QueueEmailInput = {
  to: string;
  subject: string;
  html: string;
  template: string;
  personId?: string | null;
  triggeredById?: string | null;
  campaignRunId?: string | null;
};
```
and in `queueEmail`'s `data`, add `campaignRunId: input.campaignRunId ?? null`.

- [ ] **Step 5: Typecheck** `npx tsc --noEmit` — expect PASS.
- [ ] **Step 6: Commit** (`git commit -m "feat(campaigns): EmailCampaign/Run models + EmailLog link + migration"`)

---

## Task 8: Permission

**Files:** Modify `src/platform/modules/registry.ts`

- [ ] **Step 1:** Add `"admin.send_email_campaign"` to the `admin` module manifest's `permissions` array (after `"admin.manage_email_templates"`).
- [ ] **Step 2:** Run the registry invariant test to confirm the `admin.` prefix is accepted:
  `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run src/platform/modules/registry.test.ts` — expect PASS.
- [ ] **Step 3: Commit** (`git commit -m "feat(campaigns): admin.send_email_campaign permission"`)

---

## Task 9: Campaign service (CRUD + preview + test-send + send-now)

**Files:** Create `src/platform/email/campaigns/service.ts`; Test `service.test.ts`

Key behaviors and the safety rules they enforce:
- `createDraft(actorId, name)` → new DRAFT campaign with an empty `ALL` PERSON audience.
- `getCampaign(id)`, `listCampaigns()`.
- `updateCampaign(actorId, id, { name?, subject?, body?, audience })` — validates `audience` via `isAudience` and the body/subject via `validateTemplate` against `PERSON_VARIABLES`. Throws `CampaignValidationError` on bad input.
- `previewAudience(id)` → `{ count, sample (<=20), excludedNoEmail }` via `resolveAudience`.
- `testSend(actorId, id, toEmail)` → render with sample person variables and `queueEmail` ONE message (no run, `template: "campaign:test"`). Audited.
- `sendCampaignNow(actorId, id, opts: { confirmCount?: number })`:
  1. Load campaign; must be DRAFT.
  2. Resolve audience → recipients.
  3. If `recipients.length > CAMPAIGN_CONFIRM_THRESHOLD` (25) require `opts.confirmCount === recipients.length`, else throw `CampaignConfirmationError`.
  4. Create an `EmailCampaignRun` (recipientCount = recipients.length).
  5. For each recipient: `renderInlineEmail({subject, body}, recipient.variables)` then `queueEmail(prisma, { to, subject, html, template: "campaign", personId: recipientId, campaignRunId })`. Dedup is enforced by the unique `(campaignRunId, toEmail)`; de-duplicate the recipient list by email before inserting so a duplicate email doesn't throw.
  6. Set campaign `status = SENT`.
  7. `recordAudit({ action: "campaign.send", entityType: "EmailCampaign", entityId: id, after: { recipientCount, runId } })`.
  8. Return `{ runId, recipientCount }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform/email/campaigns/service.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createDraft, updateCampaign, previewAudience, sendCampaignNow,
  CampaignValidationError, CampaignConfirmationError,
} from "./service";

beforeEach(resetDb);

async function activePerson(name: string, email: string) {
  return prisma.person.create({ data: { name, contactEmail: email, status: "ACTIVE" } });
}

const ALL_ACTIVE = { recordType: "PERSON" as const, match: "ALL" as const, conditions: [{ field: "status", op: "eq" as const, value: "ACTIVE" }] };

describe("campaign service", () => {
  it("creates a draft, updates it, previews recipients", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    const c = await createDraft(null, "Newsletter");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>{{ name }}</p>", audience: ALL_ACTIVE });
    const preview = await previewAudience(c.id);
    expect(preview.count).toBe(1);
    expect(preview.sample[0].email).toBe("sam@example.com");
  });

  it("rejects a body with unknown variables", async () => {
    const c = await createDraft(null, "Bad");
    await expect(
      updateCampaign(null, c.id, { subject: "x", body: "{{ bogus }}", audience: ALL_ACTIVE }),
    ).rejects.toBeInstanceOf(CampaignValidationError);
  });

  it("send-now enqueues one email per recipient and marks SENT", async () => {
    await activePerson("Sam Rivera", "sam@example.com");
    await activePerson("Pat Lee", "pat@example.com");
    const c = await createDraft(null, "Blast");
    await updateCampaign(null, c.id, { subject: "Hi {{ firstName }}", body: "<p>Hi {{ firstName }}</p>", audience: ALL_ACTIVE });
    const res = await sendCampaignNow(null, c.id, {});
    expect(res.recipientCount).toBe(2);
    const logs = await prisma.emailLog.findMany({ where: { campaignRunId: res.runId } });
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.html.includes("HAVEN Free Clinic"))).toBe(true);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.status).toBe("SENT");
  });

  it("requires a matching typed count above the threshold", async () => {
    for (let i = 0; i < 26; i++) await activePerson(`P ${i}`, `p${i}@example.com`);
    const c = await createDraft(null, "Big");
    await updateCampaign(null, c.id, { subject: "s", body: "<p>hi</p>", audience: ALL_ACTIVE });
    await expect(sendCampaignNow(null, c.id, {})).rejects.toBeInstanceOf(CampaignConfirmationError);
    const ok = await sendCampaignNow(null, c.id, { confirmCount: 26 });
    expect(ok.recipientCount).toBe(26);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `service.ts`** per the behavior list above. Use `CAMPAIGN_CONFIRM_THRESHOLD = 25` (a module const; can move to `config.ts` later). Validate with `validateTemplate(subject|body, PERSON_VARIABLES.map(v=>v.name))`. De-dupe recipients by lowercased email before enqueue. Wrap the run creation + enqueues in `prisma.$transaction` so a failure doesn't leave a half-sent run.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** (`git commit -m "feat(campaigns): campaign service with audience preview + guarded send-now"`)

---

## Task 10: Generalize `TemplateEditor` for reuse

**Files:** Modify `src/app/admin/email/templates/[key]/preview.tsx`

- [ ] **Step 1:** Make `templateKey` optional and default `isLayout` to `false`. The component already uses `layoutSource` for the non-layout preview path; ensure it renders fine when `templateKey` is undefined (it is only used, if at all, for display). Keep all existing behavior for the templates page.
- [ ] **Step 2: Typecheck + the existing templates page still compiles.** `npx tsc --noEmit` — expect PASS.
- [ ] **Step 3: Commit** (`git commit -m "refactor(email): make TemplateEditor reusable for campaigns"`)

---

## Task 11: Campaign UI — list + create + editor

**Files:** Create `src/app/admin/email/campaigns/page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `[id]/audience-builder.tsx`; Modify `src/app/admin/email/page.tsx`

UI glue over the Task 9 service, following the admin server-action conventions (server actions declared in the page, gated by `requirePermission("admin.send_email_campaign")`, error via `searchParams`). Manual verification (no DB test for the React layer).

- [ ] **Step 1: List page** (`campaigns/page.tsx`) — gated; lists campaigns (name, status, createdAt) with a "New campaign" link and links to each editor.

- [ ] **Step 2: Create page** (`campaigns/new/page.tsx`) — a single "name" form; `createAction` calls `createDraft(actor.personId, name)` then `redirect(/admin/email/campaigns/<id>)`.

- [ ] **Step 3: Audience builder client component** (`[id]/audience-builder.tsx`) — `"use client"`. Props: `fields` (PERSON_FIELDS + department options loaded server-side), `departments: {code,name}[]`, `initial: Audience`. Renders: a match-mode toggle (ALL/ANY), a list of condition rows (field select → operator/value control driven by the field's `kind`: enum select, multiEnum checkboxes, boolean true/false), add/remove row buttons. Serializes the audience to a hidden `<input name="audience">` as JSON (kept in sync with state).

- [ ] **Step 4: Editor page** (`[id]/page.tsx`) — server component. Loads the campaign, the effective layout source (via the templates service `getTemplateForEdit("layout").layoutSource` or `loadLayoutSource`), and departments (`prisma.department.findMany`). Renders three sections inside one form:
  - **Compose**: `<TemplateEditor variables={PERSON_VARIABLES} initialSubject initialBody isLayout={false} layoutSource={layoutSource} />`
  - **Audience**: `<AudienceBuilder .../>`
  - A **Save** button → `saveAction` calls `updateCampaign(actor.personId, id, { subject, body, audience: JSON.parse(formData.get("audience")) })`, catching `CampaignValidationError` → error redirect.
  - **Preview recipients** button → `previewAction` calls `previewAudience(id)`, stashes the result in `searchParams` (count + excluded) or renders inline; show the count, the excluded-no-email count, and a sample list (names + emails).
  - **Test send to me**: `testAction` reads the actor's email and calls `testSend(actor.personId, id, actor.email)`.
  - **Send now**: `sendAction` calls `sendCampaignNow(actor.personId, id, { confirmCount })`. When the last preview count was > 25, require a typed-count input whose value is posted as `confirmCount`; catch `CampaignConfirmationError` → error redirect prompting to type the count. On success redirect with a `?sent=<n>` flash.

- [ ] **Step 5: Link** from `src/app/admin/email/page.tsx` — add a "Campaigns" link next to "Manage templates".

- [ ] **Step 6: Typecheck + lint** — `npx tsc --noEmit` and `npm run lint` — expect PASS.

- [ ] **Step 7: Manual verification** — log in as a holder of `admin.send_email_campaign` (or `*`). Create a campaign, compose a body with `{{ firstName }}`, build an audience (status = ACTIVE), preview recipients (count + sample shown, no-email excluded), test-send to self, then send to a small set and confirm `EmailLog` rows appear under the run in `/admin/email`. Confirm the >25 typed-confirmation gate triggers.

- [ ] **Step 8: Commit** (`git commit -m "feat(campaigns): admin campaign wizard (compose, audience, preview, send)"`)

---

## Task 12: Full-suite verification

- [ ] **Step 1:** `npx tsc --noEmit` — PASS.
- [ ] **Step 2:** `npm run lint` — PASS.
- [ ] **Step 3:** Full suite — `TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_emailwt npx vitest run` — PASS.
- [ ] **Step 4:** Tick boxes; commit (`git commit -m "docs(campaigns): mark phase 2A plan complete"`).

---

## Self-Review (completed during planning)

**Spec coverage (Phase 2A subset):** structured condition builder over Person → safe Prisma where (Tasks 1–3) ✓; per-recipient variables + recipient resolution with no-email exclusion (Tasks 4–5) ✓; inline campaign composition rendered through the branded layout (Task 6, reuses Phase 1) ✓; campaign + run model with per-run dedup (Task 7) ✓; send-now via existing queue/worker (Task 9) ✓; safety — recipient preview, test-send-to-self, typed confirmation >25, audit, dedup (Task 9) ✓; `admin.send_email_campaign` permission (Task 8) ✓; campaign wizard reusing the Phase 1 rich editor (Tasks 10–11) ✓. **Deferred (documented):** Applicant audiences (needs plan-10 models); scheduling + recurrence (Phase 2B).

**Type consistency:** `Audience`/`AudienceCondition` (Task 1) flow through `personFieldWhere` (Task 2) → `compilePersonWhere` (Task 3) → `resolveAudience` → `Recipient` (Task 5). `renderInlineEmail({subject,body}, context)` (Task 6) is consumed by `sendCampaignNow`/`testSend` (Task 9). `QueueEmailInput.campaignRunId` (Task 7) is set in Task 9's enqueue. `PERSON_VARIABLES` (Task 4) is the validation catalog in Task 9 and the editor catalog in Task 11.

**Empty-audience guard:** `compilePersonWhere` maps zero conditions to `{ id: { in: [] } }` (matches nobody) — a deliberate guard so a misconfigured campaign can never blast everyone.
