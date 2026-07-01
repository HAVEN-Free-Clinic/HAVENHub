# Application Portal — Stage 2: Drafts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an identified applicant autosave a `DRAFT` application, resume it later (including uploaded files), and submit it (which finalizes the existing draft rather than creating a new row).

**Architecture:** A draft IS the `Application` in a new `DRAFT` state (`submittedAt` becomes nullable, set at finalize). A `drafts.ts` service upserts the draft `Applicant`+`Application` for a `(cycle, identity)` and persists file uploads immediately. `submitApplication` is changed from create-new to finalize-the-existing-draft. The apply form is identity-gated, loads the draft, autosaves (debounced), and uploads files on select. A daily cron sweeps abandoned drafts.

**Tech Stack:** Next.js 16 (App Router, server actions, route handlers), Prisma/Postgres, Vitest (node env), Tailwind v4. Builds on Stage 1 (`getApplicantIdentity`, the `/apply` portal).

**Spec:** `docs/superpowers/specs/2026-06-25-application-portal-design.md` (Stage 2 = the "Drafts (autosave)" section). Stage 1 (identity) is already merged.

## Global Constraints

- No em-dashes in user-facing copy or code comments. Use commas, parentheses, or colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`.
- No new dependencies.
- **Identity-first + isolation:** every draft read/write/upload is scoped to the resolved `ApplicantIdentity` (match `Applicant.emailLower === identity.email` OR `applicantPersonId === identity.personId`). An applicant can only ever touch their own `(cycle, email)` draft. Re-resolve identity on every server action.
- **Carry-forward from Stage 1 final review:** add `getApplicantIdentity` unit tests (SSO-wins / cookie-only / neither) in this stage before the resolver guards real draft data (Task 6 covers this).
- A draft is editable only while the cycle is OPEN and its status is `DRAFT`; a `SUBMITTED` application is read-only.
- Renewal integrity is preserved: the existing verified-session + eligibility + server-side email override still run at submit/finalize.
- Vitest is node-env (no DOM): services + actions get DB-backed tests; the apply-form/portal UI is verified by `npm run typecheck`, `npm run lint`, `npm run build`, and manual. One file: `npx vitest run <path>`; `resetDb()` from `@/platform/test/db`. After a migration, apply it to the test DB (Task 1).

---

### Task 1: Schema — DRAFT status + nullable submittedAt

**Files:**
- Modify: `prisma/schema.prisma` (`ApplicationStatus` enum; `Application.submittedAt`)
- Create: `prisma/migrations/<timestamp>_application_draft_status/migration.sql`
- Test: `src/modules/recruitment/services/drafts.test.ts`

**Interfaces:**
- Produces: `ApplicationStatus = DRAFT | SUBMITTED`; `Application.submittedAt DateTime?` (nullable).

- [ ] **Step 1: Edit the enum and column**

In `prisma/schema.prisma`:
```prisma
enum ApplicationStatus {
  DRAFT
  SUBMITTED
}
```
And change the `Application` model line `submittedAt DateTime @default(now())` to:
```prisma
  submittedAt DateTime?
```
(A draft has no `submittedAt`; the submit/finalize step sets it.)

- [ ] **Step 2: Hand-author the migration**

`prisma migrate dev` cannot run in this non-interactive shell. Create `prisma/migrations/<timestamp>_application_draft_status/migration.sql` (14-digit `YYYYMMDDHHMMSS` after the latest existing folder; check `ls prisma/migrations | sort | tail -3`):

```sql
-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'DRAFT';

-- AlterTable: submittedAt becomes nullable and loses its default
ALTER TABLE "Application" ALTER COLUMN "submittedAt" DROP DEFAULT;
ALTER TABLE "Application" ALTER COLUMN "submittedAt" DROP NOT NULL;
```

- [ ] **Step 3: Regenerate + apply to dev and test DBs**

Run: `npx prisma generate`
Run: `npx prisma migrate deploy`
Run: `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" DATABASE_URL_UNPOOLED="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" npx prisma migrate deploy`
Expected: applied (or no pending). If the DB is down: `npm run db:up`, retry; if still unreachable, report BLOCKED.
Note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in older Postgres; `prisma migrate deploy` runs each migration file in its own transaction, which Postgres 12+ allows for `ADD VALUE`. If deploy errors on the enum, split the enum `ADD VALUE` into its own migration folder applied first.

- [ ] **Step 4: Write the failing reachability test**

Create `src/modules/recruitment/services/drafts.test.ts`:
```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("can create a DRAFT application with a null submittedAt", async () => {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "d", departments: ["SRHD"], createdById: person.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email: "a@yale.edu", emailLower: "a@yale.edu" } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT" } });
  expect(app.status).toBe("DRAFT");
  expect(app.submittedAt).toBeNull();
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts`
Expected: PASS. (Fails if the migration was not applied to the test DB; re-run Step 3's test-DB deploy.)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/services/drafts.test.ts
git commit -m "feat(recruitment): DRAFT application status + nullable submittedAt"
```

---

### Task 2: Extract the file-persist helper

The draft service and the submit path both persist uploaded files. `persistFiles`/`cleanupFiles` are currently private in `submissions.ts`; extract them to a shared module so both can use them without duplication.

**Files:**
- Create: `src/modules/recruitment/services/upload.ts`
- Modify: `src/modules/recruitment/services/submissions.ts` (import from `./upload` instead of the local defs)

**Interfaces:**
- Produces:
  - `type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer }`
  - `persistFiles(cycleId: string, files: Record<string, UploadedFile>): Promise<{ answerPatch: Record<string, unknown>; storageKeys: string[] }>`
  - `cleanupFiles(storageKeys: string[]): Promise<void>`

- [ ] **Step 1: Create `upload.ts` with the existing helper code**

Move the current `UploadedFile` type and `persistFiles`/`cleanupFiles` (verbatim, from `submissions.ts`) into:
```ts
// src/modules/recruitment/services/upload.ts
import path from "node:path";
import { randomUUID } from "node:crypto";
import { putObject, deleteObject } from "@/platform/storage";

export type UploadedFile = { fileName: string; mimeType: string; bytes: Buffer };

/** Store each uploaded file under a path-safe key and return the answer refs
 *  plus the storage keys (for cleanup on failure). */
export async function persistFiles(cycleId: string, files: Record<string, UploadedFile>) {
  const answerPatch: Record<string, unknown> = {};
  const storageKeys: string[] = [];
  for (const [key, file] of Object.entries(files)) {
    const safeKey = key.replace(/[^a-z0-9_]/gi, "_");
    const safeExt = (path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? "";
    const storedName = `${safeKey}-${randomUUID()}${safeExt}`;
    const storageKey = `recruitment/${cycleId}/${storedName}`;
    await putObject(storageKey, file.bytes, file.mimeType);
    storageKeys.push(storageKey);
    answerPatch[key] = { storedName, fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length };
  }
  return { answerPatch, storageKeys };
}

export async function cleanupFiles(storageKeys: string[]): Promise<void> {
  await Promise.all(storageKeys.map((k) => deleteObject(k)));
}
```

- [ ] **Step 2: Update `submissions.ts` to import from `./upload`**

In `submissions.ts`: remove the local `UploadedFile` type, `persistFiles`, and `cleanupFiles` definitions and the now-unused `path`/`randomUUID`/`putObject`/`deleteObject` imports they used (keep any still used elsewhere). Add:
```ts
import { persistFiles, cleanupFiles, type UploadedFile } from "./upload";
```
Re-export `UploadedFile` if other files import it from `submissions.ts`: `export type { UploadedFile } from "./upload";` (check `actions.ts` imports `UploadedFile` from `submissions` and keep that working).

- [ ] **Step 3: Verify (pure refactor)**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: all existing submission tests still pass (the refactor is behavior-preserving).

- [ ] **Step 4: Commit**

```bash
git add src/modules/recruitment/services/upload.ts src/modules/recruitment/services/submissions.ts
git commit -m "refactor(recruitment): extract shared file-persist helper"
```

---

### Task 3: drafts.ts — load + save a draft

**Files:**
- Create: `src/modules/recruitment/services/drafts.ts`
- Test: `src/modules/recruitment/services/drafts.test.ts` (add)

**Interfaces:**
- Consumes: `prisma`; `type ApplicantIdentity` from `./portal-auth`.
- Produces:
  - `type DraftView = { applicationId: string; status: "DRAFT" | "SUBMITTED"; applicantType: "NEW" | "RENEWAL"; renewalDepartment: string | null; answers: Record<string, unknown> }`
  - `getDraft(slug: string, identity: ApplicantIdentity): Promise<DraftView | null>` (the applicant's row for this cycle, draft or submitted, or null)
  - `saveDraft(slug: string, identity: ApplicantIdentity, input: { answers: Record<string, unknown>; applicantType?: "NEW" | "RENEWAL"; renewalDepartment?: string | null }): Promise<void>` (upserts the DRAFT; rejects when the cycle is closed or the row is already SUBMITTED)
  - `class DraftError extends Error` (for closed-cycle / already-submitted)

- [ ] **Step 1: Write the failing tests**

Add to `drafts.test.ts` (reuse a small open-cycle fixture):
```ts
import { getDraft, saveDraft, DraftError } from "./drafts";

async function openCycle(slug = "draft-cyc") {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  return prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: slug, departments: ["SRHD"], createdById: lead.id, status: "OPEN" } });
}
const ID = { email: "reed@yale.edu", personId: null };

it("creates a draft on first save and updates it on the next", async () => {
  await openCycle();
  expect(await getDraft("draft-cyc", ID)).toBeNull();
  await saveDraft("draft-cyc", ID, { answers: { first_name: "Reed" } });
  const d1 = await getDraft("draft-cyc", ID);
  expect(d1?.status).toBe("DRAFT");
  expect(d1?.answers).toEqual({ first_name: "Reed" });
  await saveDraft("draft-cyc", ID, { answers: { first_name: "Reed", last_name: "R" } });
  const d2 = await getDraft("draft-cyc", ID);
  expect(d2?.applicationId).toBe(d1?.applicationId); // same row, no duplicate
  expect(d2?.answers).toEqual({ first_name: "Reed", last_name: "R" });
  const count = await prisma.applicant.count({ where: { cycleId: (await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "draft-cyc" } })).id } });
  expect(count).toBe(1);
});

it("rejects saving when the application is already submitted", async () => {
  const cycle = await openCycle("sub-cyc");
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "R", lastName: "R", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "SUBMITTED", submittedAt: new Date() } });
  await expect(saveDraft("sub-cyc", ID, { answers: { x: "y" } })).rejects.toBeInstanceOf(DraftError);
});

it("rejects saving when the cycle is not open", async () => {
  const cycle = await openCycle("closed-cyc");
  await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "CLOSED" } });
  await expect(saveDraft("closed-cyc", ID, { answers: {} })).rejects.toBeInstanceOf(DraftError);
});

it("scopes a draft to the identity (other identity sees nothing)", async () => {
  await openCycle("iso-cyc");
  await saveDraft("iso-cyc", ID, { answers: { a: 1 } });
  expect(await getDraft("iso-cyc", { email: "other@yale.edu", personId: null })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts`
Expected: FAIL (cannot find `./drafts` exports).

- [ ] **Step 3: Implement `drafts.ts`**

```ts
// src/modules/recruitment/services/drafts.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";

export class DraftError extends Error {
  constructor(m: string) { super(m); this.name = "DraftError"; }
}

export type DraftView = {
  applicationId: string;
  status: "DRAFT" | "SUBMITTED";
  applicantType: "NEW" | "RENEWAL";
  renewalDepartment: string | null;
  answers: Record<string, unknown>;
};

/** The applicant's row (draft or submitted) for this cycle, scoped to identity. */
async function findRow(slug: string, identity: ApplicantIdentity) {
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { publicSlug: slug }, select: { id: true, status: true, opensAt: true, closesAt: true } });
  if (!cycle) return null;
  const applicant = await prisma.applicant.findFirst({
    where: {
      cycleId: cycle.id,
      OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])],
    },
    include: { applications: true },
  });
  return { cycle, applicant };
}

export async function getDraft(slug: string, identity: ApplicantIdentity): Promise<DraftView | null> {
  const row = await findRow(slug, identity);
  const app = row?.applicant?.applications[0];
  if (!app) return null;
  return {
    applicationId: app.id,
    status: app.status as "DRAFT" | "SUBMITTED",
    applicantType: app.applicantType,
    renewalDepartment: app.renewalDepartment,
    answers: (app.answers as Record<string, unknown>) ?? {},
  };
}

export async function saveDraft(
  slug: string,
  identity: ApplicantIdentity,
  input: { answers: Record<string, unknown>; applicantType?: "NEW" | "RENEWAL"; renewalDepartment?: string | null },
): Promise<void> {
  const row = await findRow(slug, identity);
  if (!row) throw new DraftError("Application not found.");
  const { cycle, applicant } = row;
  const now = new Date();
  const open = cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new DraftError("This application is closed.");

  const existing = applicant?.applications[0];
  if (existing && existing.status === "SUBMITTED") throw new DraftError("Your application has already been submitted.");

  const data = {
    answers: input.answers as never,
    ...(input.applicantType ? { applicantType: input.applicantType } : {}),
    ...(input.renewalDepartment !== undefined ? { renewalDepartment: input.renewalDepartment } : {}),
  };

  if (existing) {
    await prisma.application.update({ where: { id: existing.id }, data });
    return;
  }
  // Create the draft applicant + application. Identity fields fill in as the
  // applicant types; the email is the verified identity email.
  await prisma.applicant.upsert({
    where: { cycleId_emailLower: { cycleId: cycle.id, emailLower: identity.email } },
    create: {
      cycleId: cycle.id, applicantPersonId: identity.personId, firstName: "", lastName: "", email: identity.email, emailLower: identity.email,
      applications: { create: { cycleId: cycle.id, applicantType: input.applicantType ?? "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT", renewalDepartment: input.renewalDepartment ?? null, answers: input.answers as never } },
    },
    update: {
      applications: { create: { cycleId: cycle.id, applicantType: input.applicantType ?? "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT", renewalDepartment: input.renewalDepartment ?? null, answers: input.answers as never } },
    },
  });
}
```

(Note: `Applicant` has at most one `Application` per the `(cycleId, applicantId)` unique on Application + one Applicant per `(cycleId, emailLower)`, so `applications[0]` is the single row. The `upsert` handles the rare case of an Applicant row with no Application.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts`
Expected: PASS (reachability + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/drafts.ts src/modules/recruitment/services/drafts.test.ts
git commit -m "feat(recruitment): draft load + autosave service"
```

---

### Task 4: drafts.ts — upload a draft file

**Files:**
- Modify: `src/modules/recruitment/services/drafts.ts`
- Test: `src/modules/recruitment/services/drafts.test.ts` (add)

**Interfaces:**
- Consumes: `persistFiles`, `cleanupFiles`, `type UploadedFile` from `./upload`; the draft row helpers.
- Produces: `uploadDraftFile(slug: string, identity: ApplicantIdentity, fieldKey: string, file: UploadedFile): Promise<{ fileName: string }>` — uploads, records the ref into the draft `answers[fieldKey]`, deletes a previously-stored file at that key, returns the stored file name. Rejects (DraftError) if no draft / closed / submitted / the field is not a visible FILE field.

- [ ] **Step 1: Write the failing test**

Add to `drafts.test.ts`:
```ts
import { uploadDraftFile } from "./drafts";

it("uploads a draft file and records the ref in answers", async () => {
  const cycle = await openCycle("file-cyc");
  // The cycle needs a FILE field for the key to be allowed.
  const idSection = await prisma.formSection.create({ data: { cycleId: cycle.id, title: "Main", order: 0, appliesTo: "BOTH", purpose: "APPLICATION" } });
  await prisma.formField.create({ data: { sectionId: idSection.id, cycleId: cycle.id, key: "resume", label: "Resume", type: "FILE", required: false, order: 0 } });
  await saveDraft("file-cyc", ID, { answers: {} });
  const res = await uploadDraftFile("file-cyc", ID, "resume", { fileName: "cv.pdf", mimeType: "application/pdf", bytes: Buffer.from("hi") });
  expect(res.fileName).toBe("cv.pdf");
  const d = await getDraft("file-cyc", ID);
  expect((d?.answers.resume as { fileName: string }).fileName).toBe("cv.pdf");
});

it("rejects a draft upload to an unknown field key", async () => {
  await openCycle("file-cyc2");
  await saveDraft("file-cyc2", ID, { answers: {} });
  await expect(uploadDraftFile("file-cyc2", ID, "not_a_field", { fileName: "x.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") })).rejects.toBeInstanceOf(DraftError);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts -t "draft file"`
Expected: FAIL (`uploadDraftFile` missing).

- [ ] **Step 3: Implement `uploadDraftFile`**

Append to `drafts.ts` (add the imports `import { persistFiles, cleanupFiles, type UploadedFile } from "./upload";` at the top):
```ts
export async function uploadDraftFile(
  slug: string,
  identity: ApplicantIdentity,
  fieldKey: string,
  file: UploadedFile,
): Promise<{ fileName: string }> {
  const row = await findRow(slug, identity);
  if (!row) throw new DraftError("Application not found.");
  const { cycle, applicant } = row;
  const now = new Date();
  const open = cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new DraftError("This application is closed.");
  const app = applicant?.applications[0];
  if (!app || app.status === "SUBMITTED") throw new DraftError("No editable draft.");

  // The key must be a FILE field in this cycle (the same allowlist defense the
  // submit path uses, since the key builds the storage path).
  const fileField = await prisma.formField.findFirst({ where: { cycleId: cycle.id, key: fieldKey, type: "FILE" }, select: { key: true } });
  if (!fileField) throw new DraftError("Unexpected file upload.");

  const { answerPatch, storageKeys } = await persistFiles(cycle.id, { [fieldKey]: file });
  const prior = (app.answers as Record<string, unknown>)[fieldKey] as { storedName?: string } | undefined;
  try {
    await prisma.application.update({ where: { id: app.id }, data: { answers: { ...(app.answers as Record<string, unknown>), ...answerPatch } as never } });
  } catch (err) {
    await cleanupFiles(storageKeys);
    throw err;
  }
  // Best-effort delete of the file this one replaced.
  if (prior?.storedName) await cleanupFiles([`recruitment/${cycle.id}/${prior.storedName}`]);
  return { fileName: file.fileName };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts`
Expected: PASS (all draft tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/drafts.ts src/modules/recruitment/services/drafts.test.ts
git commit -m "feat(recruitment): draft file upload-on-select"
```

---

### Task 5: submitApplication finalizes the existing draft

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts`
- Test: `src/modules/recruitment/services/submissions.test.ts` (add)

**Interfaces:**
- The `submitApplication` signature is unchanged. Its behavior changes: instead of always creating a new `Applicant`+`Application`, it finds the applicant's existing row for `(cycle, emailLower)`; a `SUBMITTED` row returns `DuplicateApplicationError`; a `DRAFT` row (or no row) is finalized/created and flipped to `SUBMITTED` with `submittedAt = now`.

- [ ] **Step 1: Write the failing tests**

Add to `submissions.test.ts` (it has `openVolunteerCycle`; you will also use the `drafts` service):
```ts
import { saveDraft } from "./drafts";

it("finalizes an existing draft into a submission (no duplicate Applicant)", async () => {
  await openVolunteerCycle();
  const ID = { email: "ann@yale.edu", personId: null };
  await saveDraft("apply-v", ID, { answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu" } });
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", srhd_essay: "because" },
    files: {},
  });
  expect(app.status).toBe("SUBMITTED");
  expect(app.submittedAt).not.toBeNull();
  const applicants = await prisma.applicant.count({ where: { emailLower: "ann@yale.edu" } });
  expect(applicants).toBe(1); // the draft applicant was finalized, not duplicated
});

it("rejects submitting when the application is already SUBMITTED", async () => {
  await openVolunteerCycle();
  const args = { applicantType: "NEW" as const, answers: { first_name: "Bo", last_name: "Ng", email: "bo@yale.edu", "1st_choice_department": "MDIC" }, files: {} };
  await submitApplication("apply-v", args);
  await expect(submitApplication("apply-v", args)).rejects.toBeInstanceOf(DuplicateApplicationError);
});
```

(The existing "accepts a valid NEW submission" test still applies: a submit with NO prior draft still creates the row and finalizes it.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "finalizes an existing draft"`
Expected: FAIL (today it creates a second Applicant, or the dedup pre-check throws Duplicate on the draft row).

- [ ] **Step 3: Change the create/dedup logic in `submitApplication`**

Read the current `submitApplication` in `submissions.ts`. Make these precise changes (preserve everything else, including the renewal gate, subcommittee `resolveRanking`, file validation, and the email):

(a) Replace the **duplicate pre-check** (currently `const dup = await prisma.applicant.findUnique({ where: { cycleId_emailLower: ... } }); if (dup) throw new DuplicateApplicationError();`) with a lookup that distinguishes state and surfaces any files already uploaded in the draft:
```ts
  const existingApplicant = await prisma.applicant.findUnique({
    where: { cycleId_emailLower: { cycleId: cycle.id, emailLower } },
    include: { applications: true },
  });
  const existingApp = existingApplicant?.applications[0];
  if (existingApp && existingApp.status === "SUBMITTED") throw new DuplicateApplicationError();
  // Files uploaded during the draft live in the draft answers as refs; treat
  // them as already-present so a resumed applicant need not re-pick them.
  const draftAnswers = (existingApp?.answers as Record<string, unknown>) ?? {};
  const draftFileKeys = Object.keys(draftAnswers).filter((k) => {
    const v = draftAnswers[k];
    return v != null && typeof v === "object" && "storedName" in (v as object);
  });
```

(a2) Update the **required-file check** (currently `const missingFile = needFiles.find((k) => !input.files[k]);`) so a file already in the draft counts:
```ts
  const missingFile = needFiles.find((k) => !input.files[k] && !draftFileKeys.includes(k));
```

(a3) Update the **answers-with-files** construction (currently `const answersWithFiles = { ...parsed.data, ...fileRefs.answerPatch };`) to layer draft file refs under the form answers and new uploads over the top:
```ts
  const draftFileRefs = Object.fromEntries(draftFileKeys.map((k) => [k, draftAnswers[k]]));
  const answersWithFiles = { ...draftFileRefs, ...parsed.data, ...fileRefs.answerPatch };
```

(b) Replace the **transaction create block** so it finalizes the draft when one exists, else creates the row, then always flips to `SUBMITTED`:
```ts
  application = await prisma.$transaction(async (tx) => {
    let applicantId = existingApplicant?.id;
    if (applicantId) {
      // Finalize the existing draft applicant: fill in identity fields from answers.
      await tx.applicant.update({
        where: { id: applicantId },
        data: { applicantPersonId, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
      });
    } else {
      const created = await tx.applicant.create({
        data: { cycleId: cycle.id, applicantPersonId, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
      });
      applicantId = created.id;
    }
    const appData = {
      answers: answersWithFiles as never,
      applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes, subcommitteeRanking,
      renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
      status: "SUBMITTED" as const, submittedAt: new Date(),
    };
    const app = existingApp
      ? await tx.application.update({ where: { id: existingApp.id }, data: appData })
      : await tx.application.create({ data: { cycleId: cycle.id, applicantId, ...appData } });
    await queueEmail(tx, {
      to: email,
      subject: `We received your ${cycle.title} application`,
      html: `<p>Hi ${escapeHtml(firstName) || "there"},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your application and will be in touch.</p>`,
      template: "recruitment.application_received",
    });
    return app;
  });
```

Keep the `P2002 -> DuplicateApplicationError` catch and the `cleanupFiles` calls as they are.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (all existing submission tests, including renewal + subcommittee, plus the 2 new draft-finalize tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): submit finalizes the existing draft"
```

---

### Task 6: Draft server actions + getApplicantIdentity tests

**Files:**
- Create: `src/app/apply/[slug]/draft-actions.ts`
- Test: `src/modules/recruitment/services/portal-auth.test.ts` (add the carried-forward `getApplicantIdentity` cases)

**Interfaces:**
- Consumes: `getApplicantIdentity` from `@/modules/recruitment/services/portal-auth`; `saveDraft`, `uploadDraftFile`, `DraftError` from `@/modules/recruitment/services/drafts`.
- Produces (server actions, all re-resolve identity):
  - `saveDraftAction(slug: string, payload: { answers: Record<string, unknown>; applicantType?: "NEW" | "RENEWAL"; renewalDepartment?: string | null }): Promise<{ ok: boolean }>`
  - `uploadDraftFileAction(slug: string, fieldKey: string, formData: FormData): Promise<{ ok: boolean; fileName?: string; error?: string }>` (the file is `formData.get("file")`)

- [ ] **Step 1: Add the carried-forward identity tests**

The Stage 1 final review asked for these before the resolver guards real draft data. Add to `portal-auth.test.ts` (the file already `vi.mock`s `next/headers` and `@/platform/auth/auth`):
```ts
import { getApplicantIdentity } from "./portal-auth";
import { auth } from "@/platform/auth/auth";
import { cookies } from "next/headers";
import { vi } from "vitest";

it("getApplicantIdentity prefers the SSO session, then the cookie, then null", async () => {
  vi.mocked(auth).mockResolvedValueOnce({ personId: "p1", user: { email: "Member@Yale.edu" } } as never);
  vi.mocked(cookies).mockResolvedValueOnce({ get: () => undefined } as never);
  expect(await getApplicantIdentity()).toEqual({ email: "member@yale.edu", personId: "p1" });

  // No session -> cookie path
  const { signApplicantCookie, APPLICANT_COOKIE } = await import("./portal-auth");
  vi.mocked(auth).mockResolvedValueOnce(null as never);
  vi.mocked(cookies).mockResolvedValueOnce({ get: (n: string) => (n === APPLICANT_COOKIE ? { value: signApplicantCookie("guest@yale.edu") } : undefined) } as never);
  expect(await getApplicantIdentity()).toEqual({ email: "guest@yale.edu", personId: null });

  // Neither -> null
  vi.mocked(auth).mockResolvedValueOnce(null as never);
  vi.mocked(cookies).mockResolvedValueOnce({ get: () => undefined } as never);
  expect(await getApplicantIdentity()).toBeNull();
});
```
Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts` and confirm it passes (the resolver already exists from Stage 1; adapt the mock shape to whatever the existing `vi.mock` stubs in this file expose, the implementer reads the file).

- [ ] **Step 2: Implement the actions**

```ts
// src/app/apply/[slug]/draft-actions.ts
"use server";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { saveDraft, uploadDraftFile, DraftError } from "@/modules/recruitment/services/drafts";

export async function saveDraftAction(
  slug: string,
  payload: { answers: Record<string, unknown>; applicantType?: "NEW" | "RENEWAL"; renewalDepartment?: string | null },
): Promise<{ ok: boolean }> {
  const identity = await getApplicantIdentity();
  if (!identity) return { ok: false };
  try {
    await saveDraft(slug, identity, payload);
    return { ok: true };
  } catch (err) {
    if (err instanceof DraftError) return { ok: false };
    throw err;
  }
}

export async function uploadDraftFileAction(
  slug: string,
  fieldKey: string,
  formData: FormData,
): Promise<{ ok: boolean; fileName?: string; error?: string }> {
  const identity = await getApplicantIdentity();
  if (!identity) return { ok: false, error: "Please sign in again." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No file." };
  try {
    const res = await uploadDraftFile(slug, identity, fieldKey, { fileName: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return { ok: true, fileName: res.fileName };
  } catch (err) {
    if (err instanceof DraftError) return { ok: false, error: err.message };
    throw err;
  }
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean.
Run: `npx vitest run src/modules/recruitment/services/portal-auth.test.ts`
Expected: pass (including the new identity cases).

- [ ] **Step 4: Commit**

```bash
git add "src/app/apply/[slug]/draft-actions.ts" src/modules/recruitment/services/portal-auth.test.ts
git commit -m "feat(recruitment): draft server actions + identity resolver tests"
```

---

### Task 7: Apply form — identity gate, draft load, autosave, file-on-select

**Files:**
- Modify: `src/app/apply/[slug]/page.tsx` (resolve identity, load draft, pass to form; redirect to `/apply?next=` when not identified)
- Modify: `src/app/apply/[slug]/apply-form.tsx` (initialize from the draft, debounced autosave, file upload-on-select, submit unchanged)

**Interfaces:**
- Consumes: `getApplicantIdentity`, `getDraft` (server, in the page); `saveDraftAction`, `uploadDraftFileAction` (client, in the form).

- [ ] **Step 1: Gate the page on identity and load the draft**

In `src/app/apply/[slug]/page.tsx`, after the cycle-open check and before building `def`, resolve identity and (if absent) redirect to the portal sign-in carrying the return path:
```ts
import { redirect } from "next/navigation";
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
import { getDraft } from "@/modules/recruitment/services/drafts";
// ...
  const identity = await getApplicantIdentity();
  if (!identity) redirect(`/apply?next=${encodeURIComponent(`/apply/${slug}`)}`);
  const draft = await getDraft(slug, identity);
  if (draft?.status === "SUBMITTED") {
    // Already submitted: this stage shows a simple confirmation; Stage 3 adds status.
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold">Application submitted</h1>
        <p className="mt-2 text-muted-foreground">You have already submitted this application. We will be in touch.</p>
      </main>
    );
  }
```
Pass two new props to `<ApplyForm>`: `initialAnswers={(draft?.answers as Record<string, string>) ?? {}}` and `initialApplicantTypeFromDraft={draft?.applicantType}` (use the draft's type to seed the form when present, else the existing `?type` logic). Keep all existing renewal/prefill props.

- [ ] **Step 2: Wire autosave + file-on-select in `apply-form.tsx`**

Read the current `apply-form.tsx`. Add (preserving the existing renewal gating, FieldPreview usage with `subcommittees`, and the submit flow):

1. Accept new optional props: `initialAnswers?: Record<string, string>` (default `{}`) and `initialApplicantTypeFromDraft?: "NEW" | "RENEWAL"`. Seed `applicantType` from the draft type when present.
2. Seed each field's value from `initialAnswers[f.key]` by passing `prefill={prefill?.values[f.key] ?? initialAnswers[f.key]}` to `FieldPreview` (prefill already renders as a default value; locked stays for renewal email).
3. A `formRef` on the `<form>`. A debounced autosave: on the form's `onChange`, read `new FormData(formRef.current)` minus the `__`-prefixed meta and minus File entries, debounce ~800ms, and call `saveDraftAction(def.slug, { answers, applicantType, renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null })`. Show a subtle "Saved" / "Saving…" indicator from the result.
4. File-on-select: when a FILE input changes, call `uploadDraftFileAction(def.slug, fieldKey, fd)` with the file; on success show "Attached: <name>" beside that field and record it so submit includes it (the server already stored the ref in the draft answers; the final submit reads files from the form, so a draft-uploaded file that the user does not re-pick is already in the draft answers and will be merged at finalize). Keep it minimal: an inline status text per file field.

Implementation guidance for the debounce (no new deps):
```tsx
import { useRef, useState } from "react";
const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
function scheduleSave() {
  if (renewalGate) return; // not identified for renewal yet; nothing to save
  if (saveTimer.current) clearTimeout(saveTimer.current);
  setSaveState("saving");
  saveTimer.current = setTimeout(async () => {
    const form = formRef.current; if (!form) return;
    const fd = new FormData(form);
    const answers: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) { if (k.startsWith("__") || v instanceof File) continue; answers[k] = answers[k] === undefined ? v : ([] as unknown[]).concat(answers[k], v); }
    const res = await saveDraftAction(def.slug, { answers, applicantType, renewalDepartment: applicantType === "RENEWAL" ? renewalDept : null });
    setSaveState(res.ok ? "saved" : "idle");
  }, 800);
}
```
Attach `onChange={scheduleSave}` to the `<form>` (text/select changes bubble). For FILE inputs, the upload-on-select is a separate handler that calls `uploadDraftFileAction` and does NOT go through `scheduleSave`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean (lint errors confined to the `HAVEN Free Clinic Design System/` folder are not yours).

Manual check (run skill or `npm run dev`): sign in at `/apply` (SSO or magic link), open an open cycle, type some answers, reload the page, and confirm the answers come back (draft resumed). Pick a file, reload, confirm it is still attached. Submit and confirm it finalizes (status SUBMITTED, no duplicate applicant). A signed-out visit to `/apply/<slug>` redirects to `/apply?next=…`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/apply/[slug]/page.tsx" "src/app/apply/[slug]/apply-form.tsx"
git commit -m "feat(recruitment): identity-gated apply form with draft autosave"
```

---

### Task 8: Portal home lists the applicant's applications

**Files:**
- Modify: `src/app/apply/page.tsx` (add a "My applications" section above the open cycles)
- Create: `src/modules/recruitment/services/portal-status.ts` (a minimal `listApplicantApplications` for Stage 2; Stage 3 adds rich status)
- Test: `src/modules/recruitment/services/portal-status.test.ts`

**Interfaces:**
- Produces:
  - `type ApplicantAppRow = { slug: string; cycleTitle: string; status: "DRAFT" | "SUBMITTED" }`
  - `listApplicantApplications(identity: ApplicantIdentity): Promise<ApplicantAppRow[]>`

- [ ] **Step 1: Write the failing test**

```ts
// src/modules/recruitment/services/portal-status.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { listApplicantApplications } from "./portal-status";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists the identity's applications across cycles with status", async () => {
  const lead = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date() } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: "v26", departments: ["SRHD"], createdById: lead.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email: "reed@yale.edu", emailLower: "reed@yale.edu" } });
  await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status: "DRAFT" } });

  const rows = await listApplicantApplications({ email: "reed@yale.edu", personId: null });
  expect(rows).toEqual([{ slug: "v26", cycleTitle: "Volunteer 2026", status: "DRAFT" }]);
  expect(await listApplicantApplications({ email: "nobody@yale.edu", personId: null })).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-status.test.ts`
Expected: FAIL (missing module).

- [ ] **Step 3: Implement `listApplicantApplications`**

```ts
// src/modules/recruitment/services/portal-status.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";

export type ApplicantAppRow = { slug: string; cycleTitle: string; status: "DRAFT" | "SUBMITTED" };

export async function listApplicantApplications(identity: ApplicantIdentity): Promise<ApplicantAppRow[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: { cycle: { select: { publicSlug: true, title: true } }, applications: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
  });
  const rows: ApplicantAppRow[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    rows.push({ slug: a.cycle.publicSlug, cycleTitle: a.cycle.title, status: app.status as "DRAFT" | "SUBMITTED" });
  }
  return rows;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the "My applications" section to the portal home**

In `src/app/apply/page.tsx` (the identified branch), call `listApplicantApplications(identity)` and render a section above "Open applications":
```tsx
import { listApplicantApplications } from "@/modules/recruitment/services/portal-status";
// ... in the identified branch:
  const myApps = await listApplicantApplications(identity);
// ... render above the open-cycles section:
  {myApps.length > 0 && (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your applications</h2>
      <ul className="space-y-2">
        {myApps.map((a) => (
          <li key={a.slug}>
            <Link href={`/apply/${a.slug}`} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-sm hover:bg-muted">
              <span className="font-medium text-foreground">{a.cycleTitle}</span>
              <span className={a.status === "DRAFT" ? "text-brand-fg" : "text-muted-foreground"}>{a.status === "DRAFT" ? "Continue" : "Submitted"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )}
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean.
```bash
git add src/modules/recruitment/services/portal-status.ts src/modules/recruitment/services/portal-status.test.ts "src/app/apply/page.tsx"
git commit -m "feat(recruitment): portal home lists the applicant's applications"
```

---

### Task 9: Orphan-draft sweep cron

**Files:**
- Modify: `src/modules/recruitment/services/drafts.ts` (add `sweepAbandonedDrafts`)
- Create: `src/app/api/cron/recruitment-drafts/route.ts`
- Modify: `vercel.json` (register the daily cron)
- Test: `src/modules/recruitment/services/drafts.test.ts` (add)

**Interfaces:**
- Produces: `sweepAbandonedDrafts(olderThanDays = 30): Promise<{ deleted: number }>` — deletes DRAFT applications (and their Applicant + uploaded objects) not updated in `olderThanDays`.

- [ ] **Step 1: Write the failing test**

Add to `drafts.test.ts`:
```ts
import { sweepAbandonedDrafts } from "./drafts";

it("sweeps abandoned drafts older than the cutoff, leaving recent and submitted ones", async () => {
  const cycle = await openCycle("sweep-cyc");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const mk = async (email: string, status: "DRAFT" | "SUBMITTED", updatedAt: Date) => {
    const ap = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "", lastName: "", email, emailLower: email } });
    await prisma.application.create({ data: { cycleId: cycle.id, applicantId: ap.id, answers: {}, applicantType: "NEW", departmentChoices: [], subcommitteeRanking: [], status, submittedAt: status === "SUBMITTED" ? new Date() : null } });
    await prisma.application.updateMany({ where: { applicantId: ap.id }, data: { updatedAt } });
  };
  await mk("oldraft@yale.edu", "DRAFT", old);
  await mk("newdraft@yale.edu", "DRAFT", new Date());
  await mk("oldsub@yale.edu", "SUBMITTED", old);
  const res = await sweepAbandonedDrafts(30);
  expect(res.deleted).toBe(1);
  expect(await prisma.applicant.findFirst({ where: { emailLower: "oldraft@yale.edu" } })).toBeNull();
  expect(await prisma.applicant.findFirst({ where: { emailLower: "newdraft@yale.edu" } })).not.toBeNull();
  expect(await prisma.applicant.findFirst({ where: { emailLower: "oldsub@yale.edu" } })).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts -t "sweeps abandoned"`
Expected: FAIL (`sweepAbandonedDrafts` missing).

- [ ] **Step 3: Implement the sweep**

Append to `drafts.ts`:
```ts
import { cleanupFiles } from "./upload";

/** Delete DRAFT applications (and their applicant + uploaded files) not touched
 *  in `olderThanDays`. Submitted applications are never swept. */
export async function sweepAbandonedDrafts(olderThanDays = 30): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.application.findMany({
    where: { status: "DRAFT", updatedAt: { lt: cutoff } },
    select: { id: true, applicantId: true, cycleId: true, answers: true },
  });
  let deleted = 0;
  for (const app of stale) {
    const answers = (app.answers as Record<string, unknown>) ?? {};
    const keys: string[] = [];
    for (const v of Object.values(answers)) {
      if (v && typeof v === "object" && "storedName" in (v as object)) {
        keys.push(`recruitment/${app.cycleId}/${(v as { storedName: string }).storedName}`);
      }
    }
    await cleanupFiles(keys);
    // Deleting the Applicant cascades to its Application (Application FK is onDelete: Cascade).
    await prisma.applicant.delete({ where: { id: app.applicantId } });
    deleted += 1;
  }
  return { deleted };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/drafts.test.ts`
Expected: PASS (all draft tests).

- [ ] **Step 5: Create the cron route**

```ts
// src/app/api/cron/recruitment-drafts/route.ts
import { authorizeCron } from "@/platform/cron";
import { sweepAbandonedDrafts } from "@/modules/recruitment/services/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorizeCron(req)) return new Response("Unauthorized", { status: 401 });
  const { deleted } = await sweepAbandonedDrafts(30);
  return Response.json({ ok: true, deleted });
}
```

- [ ] **Step 6: Register the cron in `vercel.json`**

Add a `crons` array to `vercel.json` (daily at 04:00 UTC):
```json
  "crons": [{ "path": "/api/cron/recruitment-drafts", "schedule": "0 4 * * *" }]
```
(If a `crons` array already exists, append this entry. Crons require Vercel Pro and the `CRON_SECRET`, which the existing email cron already relies on.)

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck && npm run build`
Expected: clean.
```bash
git add src/modules/recruitment/services/drafts.ts "src/app/api/cron/recruitment-drafts/route.ts" vercel.json src/modules/recruitment/services/drafts.test.ts
git commit -m "feat(recruitment): orphan-draft sweep cron"
```

---

### Task 10: Full verification pass

- [ ] **Step 1:** `npm run test` — expect pass; the only acceptable failures are the pre-existing `/tmp` cert flakes in `certificates.test.ts`/`my-info.test.ts`.
- [ ] **Step 2:** `npm run typecheck && npm run lint && npm run build` — all clean (lint's pre-existing `HAVEN Free Clinic Design System/` errors are not new).
- [ ] **Step 3:** Manual end-to-end: sign in (SSO + magic link), start an application, type + reload (resumes), attach a file + reload (still attached), submit (finalizes, no duplicate applicant, status SUBMITTED), revisit the portal home (the app shows under "Your applications"), and confirm a signed-out `/apply/<slug>` redirects to sign-in.
- [ ] **Step 4:** Commit any verification fixes.

---

## Self-Review Notes

- **Spec coverage (Stage 2):** `DRAFT` status + nullable `submittedAt` (Task 1); shared file helper (Task 2); draft load/save autosave (Task 3); file upload-on-select persisted in the draft (Task 4); submit finalizes the existing draft, dedup distinguishes DRAFT vs SUBMITTED (Task 5); identity-resolved draft actions + the carried-forward `getApplicantIdentity` tests (Task 6); identity-gated apply form with autosave + file-on-select (Task 7); portal "My applications" (Task 8); orphan sweep cron (Task 9). Status display (interview/decision/onboarding, the release gate) is Stage 3, out of scope here.
- **Isolation:** every draft read/write/upload and the application list scope to `emailLower OR personId` (Tasks 3, 4, 8) and re-resolve identity in the actions (Task 6).
- **Type consistency:** `ApplicantIdentity` (Stage 1) is consumed by `getDraft`/`saveDraft`/`uploadDraftFile`/`listApplicantApplications`; `DraftView`, `DraftError`, `ApplicantAppRow`, `UploadedFile` (Task 2) flow as defined; the draft actions' payload shape matches `saveDraft`'s input.
- **Risks to confirm during execution:** the enum `ADD VALUE` migration may need its own transaction/file (Task 1 note); the `apply-form.tsx` autosave wiring (Task 7) is the least-mechanical part and must preserve the existing renewal gating + subcommittee FieldPreview props; the FILE upload-on-select interplay with the final submit (a draft-uploaded file already lives in the draft answers, so the finalize merges it) should be manually verified.
