# Plan 11 — Recruitment Review & Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let department directors review volunteer applicants scoped to their department and accept them in (with notes), let SRR resolve multi-department conflicts and release a batch of acceptance emails — building on the Plan 10 recruitment foundation.

**Architecture:** A new `Acceptance` model (applicant×department, approving director, notes, emailedAt). A pure `findAcceptanceConflicts` engine. A `review` service (scope resolution via the existing `manageableDepartmentIds`, scoped applicant queue, accept/revoke with server-side authorization) and a `decisions` service (conflicts, batched email release). The Plan 10 applicants list/detail pages are extended with an accept panel; a new SRR-only decisions page handles conflicts + release. Acceptance email is notification-only (onboarding link is Plan 13).

**Tech Stack:** Next.js 16 App Router (server components + server actions), Prisma/Postgres, vitest (unit + integration), Playwright (e2e). Reuses `@/platform/departments` (`manageableDepartmentIds`), `@/platform/rbac/engine` (`can`), `@/platform/email/send` (`queueEmail`), `@/platform/audit` (`recordAudit`).

**Spec:** `docs/superpowers/specs/2026-06-08-recruitment-review-design.md`.

**Branch:** `plan-11/recruitment-review` (already exists, stacked on `plan-10/recruitment-foundation`).

---

## File Structure

**Schema / platform:**
- Modify `prisma/schema.prisma` — `Acceptance` model + back-relations on `Application` and `Person`.
- Create `prisma/migrations/<ts>_recruitment_acceptance/migration.sql` (generated).
- Modify `src/platform/test/db.ts` — add `"Acceptance"` to the `resetDb()` TRUNCATE list.
- Modify `src/platform/modules/registry.ts` — add `recruitment.review` + `recruitment.review_all` permissions and a "Decisions" nav entry.

**Engine (pure, unit-tested):**
- Create `src/modules/recruitment/engine/conflicts.ts` — `findAcceptanceConflicts`.

**Email:**
- Create `src/modules/recruitment/email/templates/acceptance.ts` — `acceptanceEmail`.

**Services (integration-tested):**
- Create `src/modules/recruitment/services/review.ts` — `reviewScope`, `listApplicantsForReview`, `listAcceptances`, `acceptApplicant`, `revokeAcceptance`, errors `RecruitmentAuthError`/`AcceptanceError`.
- Create `src/modules/recruitment/services/decisions.ts` — `listConflicts`, `releaseSummary`, `releaseDecisions`.

**Pages / actions:**
- Modify `src/app/recruitment/cycles/[id]/applicants/page.tsx` — scope-aware queue + acceptance badges.
- Modify `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` — accept panel.
- Create `src/app/recruitment/cycles/[id]/applicants/actions.ts` — accept/revoke server actions.
- Create `src/app/recruitment/cycles/[id]/decisions/page.tsx` — SRR conflicts + release.
- Create `src/app/recruitment/cycles/[id]/decisions/actions.ts` — release server action.

**e2e:**
- Create `e2e/recruitment-review.spec.ts`.

---

## Conventions every task follows

- Unit tests: `npm test -- <path>`. Integration tests need the test DB prepared: `npm run test:prepare` (once per session).
- `npm run typecheck` and `npm run lint` must stay clean. Module-boundary rule: `src/modules/recruitment/**` imports only `@/platform/**` and within the module; never another module.
- Commit at the end of every task with the message shown.

---

### Task 1: Prisma — `Acceptance` model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts`
- Create: `prisma/migrations/<ts>_recruitment_acceptance/migration.sql` (generated)

- [ ] **Step 1: Add the model to `prisma/schema.prisma`** (append after the `Application` model):

```prisma
model Acceptance {
  id             String   @id @default(cuid())
  applicationId  String
  departmentCode String
  approvedById   String
  notes          String?
  emailedAt      DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  application Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  approvedBy  Person      @relation("recruitmentAcceptanceApprover", fields: [approvedById], references: [id], onDelete: Restrict)

  @@unique([applicationId, departmentCode])
  @@index([applicationId])
}
```

- [ ] **Step 2: Add back-relations.** In `model Application`, add:
```prisma
  acceptances Acceptance[]
```
In `model Person`, add (near `recruitmentCyclesCreated`):
```prisma
  recruitmentAcceptances Acceptance[] @relation("recruitmentAcceptanceApprover")
```

- [ ] **Step 3: Generate the migration + client.**

Run: `npm run db:migrate -- --name recruitment_acceptance`
Expected: a new `prisma/migrations/<ts>_recruitment_acceptance/migration.sql` creating the `Acceptance` table with the unique + index; client regenerated. If `migrate dev` refuses due to drift, hand-write the SQL (CREATE TABLE "Acceptance" with the FK constraints, `@@unique` as a UNIQUE index, the `@@index`) then `npx prisma migrate resolve --applied <ts>_recruitment_acceptance` and `npx prisma generate`.

- [ ] **Step 4: Extend `resetDb()` in `src/platform/test/db.ts`** — add `"Acceptance"` to the TRUNCATE list, placed before `"Application"`:
```
"Acceptance", "Application", "Applicant", "FormField", "FormSection", "RecruitmentCycle",
```

- [ ] **Step 5: Verify.** `npx prisma validate` → valid. `npm run typecheck` → clean.

- [ ] **Step 6: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(recruitment): Acceptance model for review & acceptance"
```

---

### Task 2: Engine — acceptance conflict detection

**Files:**
- Create: `src/modules/recruitment/engine/conflicts.ts`
- Test: `src/modules/recruitment/engine/conflicts.test.ts`

- [ ] **Step 1: Write the failing test** (`conflicts.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { findAcceptanceConflicts } from "./conflicts";

describe("findAcceptanceConflicts", () => {
  it("returns an empty set for no acceptances", () => {
    expect(findAcceptanceConflicts([]).size).toBe(0);
  });
  it("does not flag an application accepted by a single department (even twice in the list)", () => {
    const out = findAcceptanceConflicts([
      { applicationId: "a", departmentCode: "SRHD" },
      { applicationId: "a", departmentCode: "SRHD" },
    ]);
    expect(out.has("a")).toBe(false);
  });
  it("flags an application accepted by two distinct departments", () => {
    const out = findAcceptanceConflicts([
      { applicationId: "a", departmentCode: "SRHD" },
      { applicationId: "a", departmentCode: "MDIC" },
      { applicationId: "b", departmentCode: "MDIC" },
    ]);
    expect([...out]).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run it — FAIL** (`npm test -- src/modules/recruitment/engine/conflicts.test.ts`).

- [ ] **Step 3: Implement** (`conflicts.ts`):

```ts
/** Given (applicationId, departmentCode) acceptance pairs, return the set of
 *  applicationIds accepted by MORE THAN ONE distinct department — the conflicts
 *  SRR must resolve before those applicants can be notified. Pure. */
export function findAcceptanceConflicts(
  acceptances: { applicationId: string; departmentCode: string }[]
): Set<string> {
  const byApp = new Map<string, Set<string>>();
  for (const a of acceptances) {
    const set = byApp.get(a.applicationId) ?? new Set<string>();
    set.add(a.departmentCode);
    byApp.set(a.applicationId, set);
  }
  const conflicts = new Set<string>();
  for (const [applicationId, departments] of byApp) {
    if (departments.size > 1) conflicts.add(applicationId);
  }
  return conflicts;
}
```

- [ ] **Step 4: Run it — PASS** (3 tests).

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/engine/conflicts.ts src/modules/recruitment/engine/conflicts.test.ts
git commit -m "feat(recruitment): acceptance conflict detection engine"
```

---

### Task 3: Acceptance email template

**Files:**
- Create: `src/modules/recruitment/email/templates/acceptance.ts`
- Test: `src/modules/recruitment/email/templates/acceptance.test.ts`

- [ ] **Step 1: Write the failing test** (`acceptance.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { acceptanceEmail } from "./acceptance";

describe("acceptanceEmail", () => {
  it("greets by first name and names the department", () => {
    const { subject, html } = acceptanceEmail({ firstName: "Ann", cycleTitle: "Volunteer SU26", departmentName: "Student Run Health Department" });
    expect(subject).toContain("Student Run Health Department");
    expect(html).toContain("Ann");
    expect(html).toContain("Student Run Health Department");
    expect(html).toContain("Volunteer SU26");
  });
  it("escapes HTML in user-supplied values", () => {
    const { html } = acceptanceEmail({ firstName: "<script>x</script>", cycleTitle: "C", departmentName: "D & E" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });
  it("falls back to a neutral greeting when first name is empty", () => {
    const { html } = acceptanceEmail({ firstName: "", cycleTitle: "C", departmentName: "D" });
    expect(html).toContain("there");
  });
});
```

- [ ] **Step 2: Run it — FAIL.**

- [ ] **Step 3: Implement** (`acceptance.ts`):

```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Notification-only acceptance email (Plan 11). The onboarding/contract link is
 *  added in Plan 13; this email only congratulates and names the department. */
export function acceptanceEmail(input: {
  firstName: string;
  cycleTitle: string;
  departmentName: string;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const dept = escapeHtml(input.departmentName);
  const cycle = escapeHtml(input.cycleTitle);
  return {
    subject: `You've been accepted to HAVEN — ${input.departmentName}`,
    html: `<p>Congratulations ${name},</p><p>You've been accepted into <strong>${dept}</strong> for ${cycle}. We'll follow up shortly with onboarding next steps.</p>`,
  };
}
```

> The subject is plain text (no HTML), so it uses the raw `departmentName`.

- [ ] **Step 4: Run it — PASS (3 tests).**

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/email/templates/acceptance.ts src/modules/recruitment/email/templates/acceptance.test.ts
git commit -m "feat(recruitment): acceptance email template"
```

---

### Task 4: Review service — scope, queue, accept, revoke

**Files:**
- Create: `src/modules/recruitment/services/review.ts`
- Test: `src/modules/recruitment/services/review.test.ts`

- [ ] **Step 1: Write the failing test** (`review.test.ts`). This sets up a term, departments, a director membership, an RBAC role granting `recruitment.review_all`, a published volunteer cycle, and applications, then exercises scope + accept/revoke.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  reviewScope, listApplicantsForReview, acceptApplicant, revokeAcceptance,
  RecruitmentAuthError, AcceptanceError,
} from "./review";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const mdic = await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });
  // director of SRHD only
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: srhd.id, kind: "DIRECTOR", status: "ACTIVE" } });
  // SRR: gets recruitment.review_all via a role grant
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // a cycle + two applications: one ranked SRHD, one ranked MDIC
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rv", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const mkApp = async (email: string, choices: string[]) => {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() } });
    return prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
  };
  const appSrhd = await mkApp("s@yale.edu", ["SRHD"]);
  const appMdic = await mkApp("m@yale.edu", ["MDIC"]);
  return { term, srhd, mdic, director, srr, cycle, appSrhd, appMdic };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("reviewScope", () => {
  it("resolves a director's department codes and the review_all flag", async () => {
    const { director, srr } = await seed();
    const dScope = await reviewScope(director.id);
    expect(dScope.all).toBe(false);
    expect(dScope.departmentCodes).toEqual(["SRHD"]);
    const sScope = await reviewScope(srr.id);
    expect(sScope.all).toBe(true);
  });
});

describe("listApplicantsForReview", () => {
  it("scopes a director to applicants who ranked their department", async () => {
    const { director, cycle, appSrhd } = await seed();
    const apps = await listApplicantsForReview(cycle.id, director.id);
    expect(apps.map((a) => a.id)).toEqual([appSrhd.id]);
  });
  it("shows SRR every applicant", async () => {
    const { srr, cycle } = await seed();
    const apps = await listApplicantsForReview(cycle.id, srr.id);
    expect(apps).toHaveLength(2);
  });
});

describe("acceptApplicant", () => {
  it("lets a director accept into their own department with notes + audit", async () => {
    const { director, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, "great fit");
    expect(acc.departmentCode).toBe("SRHD");
    const audit = await prisma.auditLog.findFirst({ where: { action: "recruitment.accept" } });
    expect(audit).not.toBeNull();
  });
  it("rejects a director accepting into a department they don't direct", async () => {
    const { director, appMdic } = await seed();
    await expect(acceptApplicant(appMdic.id, "MDIC", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
  it("rejects a director accepting into a department the applicant didn't rank", async () => {
    const { director, appSrhd } = await seed();
    // appSrhd ranked only SRHD; director also can't place into MDIC (not their dept) — use SRR to test the rank rule in isolation:
    await expect(acceptApplicant(appSrhd.id, "MDIC", director.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
  });
  it("lets SRR place an applicant into any cycle department (flexibility), even one not ranked", async () => {
    const { srr, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "MDIC", srr.id, null);
    expect(acc.departmentCode).toBe("MDIC");
  });
  it("rejects a department not in the cycle", async () => {
    const { srr, appSrhd } = await seed();
    await expect(acceptApplicant(appSrhd.id, "ZZZ", srr.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });
  it("rejects a duplicate acceptance", async () => {
    const { director, appSrhd } = await seed();
    await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await expect(acceptApplicant(appSrhd.id, "SRHD", director.id, null)).rejects.toBeInstanceOf(AcceptanceError);
  });
});

describe("revokeAcceptance", () => {
  it("lets an in-scope director revoke an un-emailed acceptance", async () => {
    const { director, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await revokeAcceptance(acc.id, director.id);
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
  it("blocks a director from revoking an already-emailed acceptance, but allows SRR", async () => {
    const { director, srr, appSrhd } = await seed();
    const acc = await acceptApplicant(appSrhd.id, "SRHD", director.id, null);
    await prisma.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    await expect(revokeAcceptance(acc.id, director.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
    await revokeAcceptance(acc.id, srr.id); // SRR can
    expect(await prisma.acceptance.findUnique({ where: { id: acc.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Prepare DB + run — FAIL** (`npm run test:prepare`; then `npm test -- src/modules/recruitment/services/review.test.ts`).

- [ ] **Step 3: Implement** (`review.ts`):

```ts
import type { Acceptance, Application } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { manageableDepartmentIds } from "@/platform/departments";
import { recordAudit } from "@/platform/audit";

export class RecruitmentAuthError extends Error {
  constructor(message: string) { super(message); this.name = "RecruitmentAuthError"; }
}
export class AcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "AcceptanceError"; }
}

export type ReviewScope = { all: boolean; departmentCodes: string[] };

/** A reviewer's scope: SRR (review_all) sees everything; a director sees the
 *  departments they direct (active-term DIRECTOR memberships + one-hop delegation,
 *  via manageableDepartmentIds), mapped from ids to codes. */
export async function reviewScope(personId: string): Promise<ReviewScope> {
  const all = await can(personId, "recruitment.review_all");
  const deptIds = await manageableDepartmentIds(personId);
  let departmentCodes: string[] = [];
  if (deptIds.length > 0) {
    const depts = await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { code: true } });
    departmentCodes = depts.map((d) => d.code);
  }
  return { all, departmentCodes };
}

export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string };
  acceptances: Acceptance[];
};

/** Applications a viewer may review for a cycle. SRR/review_all (and cycle
 *  managers) see all; a director sees only applications intersecting their
 *  department codes. */
export async function listApplicantsForReview(cycleId: string, viewerId: string): Promise<ReviewApplication[]> {
  const scope = await reviewScope(viewerId);
  const seeAll = scope.all || (await can(viewerId, "recruitment.manage_cycles"));
  const apps = await prisma.application.findMany({
    where: { cycleId },
    include: { applicant: { select: { firstName: true, lastName: true, email: true } }, acceptances: true },
    orderBy: { submittedAt: "desc" },
  });
  if (seeAll) return apps;
  const mine = new Set(scope.departmentCodes);
  return apps.filter((a) => a.departmentChoices.some((d) => mine.has(d)));
}

export async function listAcceptances(applicationId: string): Promise<Acceptance[]> {
  return prisma.acceptance.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
}

export async function acceptApplicant(
  applicationId: string,
  departmentCode: string,
  approvedById: string,
  notes: string | null
): Promise<Acceptance> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { cycle: true } });
  if (!app) throw new AcceptanceError("Application not found.");
  if (app.cycle.track !== "VOLUNTEER") throw new AcceptanceError("Review for this track is handled separately.");
  if (!app.cycle.departments.includes(departmentCode)) throw new AcceptanceError("That department is not part of this cycle.");

  const scope = await reviewScope(approvedById);
  const inScope = scope.all || scope.departmentCodes.includes(departmentCode);
  if (!inScope) throw new RecruitmentAuthError("You can't accept applicants for that department.");
  // Dept-scoped reviewers may only accept into a department the applicant ranked.
  // review_all (SRR) may place flexibly into any cycle department.
  if (!scope.all && !app.departmentChoices.includes(departmentCode)) {
    throw new RecruitmentAuthError("This applicant didn't rank your department.");
  }

  try {
    const acceptance = await prisma.acceptance.create({
      data: { applicationId, departmentCode, approvedById, notes: notes || null },
    });
    await recordAudit({ actorPersonId: approvedById, action: "recruitment.accept", entityType: "Acceptance", entityId: acceptance.id, after: { applicationId, departmentCode } });
    return acceptance;
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      throw new AcceptanceError("Already accepted into that department.");
    }
    throw err;
  }
}

export async function revokeAcceptance(acceptanceId: string, actorId: string): Promise<void> {
  const acc = await prisma.acceptance.findUnique({ where: { id: acceptanceId } });
  if (!acc) throw new AcceptanceError("Acceptance not found.");
  const scope = await reviewScope(actorId);
  const inScope = scope.all || scope.departmentCodes.includes(acc.departmentCode);
  if (!inScope) throw new RecruitmentAuthError("You can't revoke that acceptance.");
  if (acc.emailedAt && !scope.all) {
    throw new RecruitmentAuthError("This applicant was already notified; ask SRR to revoke.");
  }
  await prisma.acceptance.delete({ where: { id: acceptanceId } });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.revoke", entityType: "Acceptance", entityId: acceptanceId, before: { applicationId: acc.applicationId, departmentCode: acc.departmentCode } });
}
```

- [ ] **Step 4: Run — PASS** (all review tests).

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/review.ts src/modules/recruitment/services/review.test.ts
git commit -m "feat(recruitment): review service — scope, queue, accept, revoke"
```

---

### Task 5: Decisions service — conflicts, summary, batched release

**Files:**
- Create: `src/modules/recruitment/services/decisions.ts`
- Test: `src/modules/recruitment/services/decisions.test.ts`

- [ ] **Step 1: Write the failing test** (`decisions.test.ts`). Reuses the same seed shape as Task 4 (inline a local `seed`), accepts applicants via the `review` service, then exercises conflicts + release.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { acceptApplicant, RecruitmentAuthError } from "./review";
import { listConflicts, releaseSummary, releaseDecisions } from "./decisions";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const mdic = await prisma.department.create({ data: { code: "MDIC", name: "Medical Dept" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Recruitment Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "rv", departments: ["SRHD", "MDIC"], createdById: srr.id, status: "OPEN" } });
  const mkApp = async (email: string, choices: string[]) => {
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "B", email, emailLower: email.toLowerCase() } });
    return prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: choices } });
  };
  const clean = await mkApp("clean@yale.edu", ["SRHD"]);
  const conflicted = await mkApp("conf@yale.edu", ["SRHD", "MDIC"]);
  return { srr, plain, cycle, srhd, mdic, clean, conflicted };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists conflicts (applications accepted by >1 department)", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);
  const conflicts = await listConflicts(cycle.id);
  expect(conflicts.map((c) => c.applicationId)).toEqual([conflicted.id]);
  expect(conflicts[0].departments.sort()).toEqual(["MDIC", "SRHD"]);
});

it("release sends one email per accepted, non-conflicted, un-emailed acceptance and stamps emailedAt; idempotent", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);

  const res = await releaseDecisions(cycle.id, srr.id);
  expect(res.sent).toBe(1); // only the clean one
  expect(res.skippedConflicted).toBe(1); // the conflicted application

  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].toEmail).toBe("clean@yale.edu");
  expect(emails[0].template).toBe("recruitment.acceptance");

  const cleanAcc = await prisma.acceptance.findFirstOrThrow({ where: { applicationId: clean.id } });
  expect(cleanAcc.emailedAt).not.toBeNull();

  // Re-run sends nothing new.
  const again = await releaseDecisions(cycle.id, srr.id);
  expect(again.sent).toBe(0);
  expect(await prisma.emailLog.count()).toBe(1);
});

it("requires review_all", async () => {
  const { plain, cycle } = await seed();
  await expect(releaseDecisions(cycle.id, plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("releaseSummary reports the counts", async () => {
  const { srr, cycle, clean, conflicted } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "SRHD", srr.id, null);
  await acceptApplicant(conflicted.id, "MDIC", srr.id, null);
  const s = await releaseSummary(cycle.id);
  expect(s.acceptedApplications).toBe(2);
  expect(s.conflictedApplications).toBe(1);
  expect(s.unnotified).toBe(1); // clean, not yet emailed
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`decisions.ts`):

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { findAcceptanceConflicts } from "../engine/conflicts";
import { acceptanceEmail } from "../email/templates/acceptance";
import { RecruitmentAuthError, AcceptanceError } from "./review";

export type Conflict = { applicationId: string; applicantName: string; departments: string[] };

export async function listConflicts(cycleId: string): Promise<Conflict[]> {
  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: { select: { firstName: true, lastName: true } } } } },
  });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));
  const byApp = new Map<string, Conflict>();
  for (const a of acceptances) {
    if (!conflictIds.has(a.applicationId)) continue;
    const existing = byApp.get(a.applicationId);
    if (existing) {
      existing.departments.push(a.departmentCode);
    } else {
      byApp.set(a.applicationId, {
        applicationId: a.applicationId,
        applicantName: `${a.application.applicant.firstName} ${a.application.applicant.lastName}`,
        departments: [a.departmentCode],
      });
    }
  }
  return [...byApp.values()];
}

export async function releaseSummary(cycleId: string): Promise<{
  acceptedApplications: number;
  conflictedApplications: number;
  unnotified: number;
  emailed: number;
}> {
  const acceptances = await prisma.acceptance.findMany({ where: { application: { cycleId } } });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));
  const acceptedApplications = new Set(acceptances.map((a) => a.applicationId)).size;
  let unnotified = 0;
  let emailed = 0;
  for (const a of acceptances) {
    if (a.emailedAt) { emailed += 1; continue; }
    if (!conflictIds.has(a.applicationId)) unnotified += 1;
  }
  return { acceptedApplications, conflictedApplications: conflictIds.size, unnotified, emailed };
}

/** Email every accepted, non-conflicted, un-emailed applicant once; stamp
 *  emailedAt. Idempotent. Conflicted applications are skipped (counted by
 *  distinct application). Requires review_all. */
export async function releaseDecisions(cycleId: string, actorId: string): Promise<{ sent: number; skippedConflicted: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can release decisions.");
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new AcceptanceError("Cycle not found.");

  const depts = await prisma.department.findMany({ where: { code: { in: cycle.departments } }, select: { code: true, name: true } });
  const deptName = new Map(depts.map((d) => [d.code, d.name]));

  const acceptances = await prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: true } } },
  });
  const conflictIds = findAcceptanceConflicts(acceptances.map((a) => ({ applicationId: a.applicationId, departmentCode: a.departmentCode })));

  let sent = 0;
  const skippedApps = new Set<string>();
  for (const acc of acceptances) {
    if (acc.emailedAt) continue;
    if (conflictIds.has(acc.applicationId)) { skippedApps.add(acc.applicationId); continue; }
    const applicant = acc.application.applicant;
    const email = acceptanceEmail({ firstName: applicant.firstName, cycleTitle: cycle.title, departmentName: deptName.get(acc.departmentCode) ?? acc.departmentCode });
    await prisma.$transaction(async (tx) => {
      await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.acceptance" });
      await tx.acceptance.update({ where: { id: acc.id }, data: { emailedAt: new Date() } });
    });
    sent += 1;
  }

  await recordAudit({ actorPersonId: actorId, action: "recruitment.release", entityType: "RecruitmentCycle", entityId: cycleId, after: { sent, skippedConflicted: skippedApps.size } });
  return { sent, skippedConflicted: skippedApps.size };
}
```

- [ ] **Step 4: Run — PASS** (4 tests).

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/decisions.ts src/modules/recruitment/services/decisions.test.ts
git commit -m "feat(recruitment): decisions service — conflicts, summary, batched release"
```

---

### Task 6: Registry — review permissions + Decisions nav

**Files:**
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1:** Update the `recruitment` manifest entry's `permissions` and `nav`:

```ts
    permissions: ["recruitment.access", "recruitment.manage_cycles", "recruitment.review", "recruitment.review_all"],
    status: "active",
    nav: [
      { label: "Cycles", href: "/recruitment" },
    ],
```

> Leave `nav` with only "Cycles" at the top level — the Decisions/applicants links are per-cycle (reached from the cycle overview), so they are NOT top-level nav. Do not add per-cycle routes to `nav` (they need a cycle id).

- [ ] **Step 2:** On the cycle overview page `src/app/recruitment/cycles/[id]/page.tsx`, add a "Decisions" link next to the existing "View applicants" link:
```tsx
        <Link href={`/recruitment/cycles/${id}/decisions`} className="rounded-md border px-3 py-1.5 text-sm">Decisions</Link>
```
(Place it in the same `flex gap-3` row as the "Edit form" / "View applicants" links.)

- [ ] **Step 3: Verify.** `npm run typecheck` → clean. `npm test -- src/platform` → green (no registry test asserts the exact permission list; if one does, update it to include the two new permissions).

- [ ] **Step 4: Commit.**
```bash
git add src/platform/modules/registry.ts "src/app/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): declare review permissions + decisions link"
```

---

### Task 7: Extend applicants pages with the accept panel

**Files:**
- Modify: `src/app/recruitment/cycles/[id]/applicants/page.tsx`
- Modify: `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/applicants/actions.ts`

- [ ] **Step 1: Accept/revoke server actions** (`applicants/actions.ts`):

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { acceptApplicant, revokeAcceptance, RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";

function bounce(cycleId: string, applicationId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/applicants/${applicationId}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}

export async function acceptApplicantAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try {
    await acceptApplicant(applicationId, departmentCode, person.personId, notes);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}

export async function revokeAcceptanceAction(cycleId: string, applicationId: string, acceptanceId: string) {
  const person = await requirePersonSession();
  try {
    await revokeAcceptance(acceptanceId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) redirect(bounce(cycleId, applicationId, err.message));
    throw err;
  }
  revalidatePath(bounce(cycleId, applicationId));
}
```

- [ ] **Step 2: Replace the applicants list page** (`applicants/page.tsx`) to use the scoped queue + acceptance badges:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listApplicantsForReview } from "@/modules/recruitment/services/review";

function badge(depts: string[]): string {
  if (depts.length === 0) return "—";
  const distinct = [...new Set(depts)];
  return distinct.length > 1 ? `Conflict: ${distinct.join(" + ")}` : `Accepted: ${distinct[0]}`;
}

export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const apps = await listApplicantsForReview(id, person.personId);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Applicants — {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Name</th><th>Email</th><th>Type</th><th>Ranked</th><th>Decision</th></tr></thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/applicants/${a.id}`}>{a.applicant.firstName} {a.applicant.lastName}</Link></td>
              <td>{a.applicant.email}</td>
              <td>{a.applicantType}</td>
              <td>{a.departmentChoices.join(", ")}</td>
              <td>{badge(a.acceptances.map((x) => x.departmentCode))}</td>
            </tr>
          ))}
          {apps.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No applicants in your review scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Extend the detail page** (`applicants/[applicationId]/page.tsx`) — add the accept panel below the existing answer rendering. Add these imports at the top:

```tsx
import { requirePersonSession } from "@/platform/auth/session";
import { reviewScope, listAcceptances } from "@/modules/recruitment/services/review";
import { acceptApplicantAction, revokeAcceptanceAction } from "../actions";
```

Change the signature to also read `searchParams` for the error, and compute the viewer scope + acceptances. After `const app = await getApplication(applicationId); if (!app) notFound();`, add:

```tsx
  const person = await requirePersonSession();
  const scope = await reviewScope(person.personId);
  const acceptances = await listAcceptances(applicationId);
  // Departments this viewer may accept this applicant into:
  const eligible = scope.all
    ? app.cycle.departments
    : app.cycle.departments.filter((d) => scope.departmentCodes.includes(d) && app.departmentChoices.includes(d));
  const accepted = new Set(acceptances.map((a) => a.departmentCode));
  const choices = eligible.filter((d) => !accepted.has(d));
```

Then render (after the sections map, before the closing `</div>`):

```tsx
      <section className="rounded border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Decision</h2>
        {error && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {acceptances.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm">
            {acceptances.map((a) => (
              <li key={a.id} className="flex items-center justify-between border-t py-1">
                <span>Accepted into <strong>{a.departmentCode}</strong>{a.notes ? ` — ${a.notes}` : ""}{a.emailedAt ? " · notified" : ""}</span>
                <form action={revokeAcceptanceAction.bind(null, id, applicationId, a.id)}><button className="text-xs text-red-600">Revoke</button></form>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-slate-500">No acceptances yet.</p>}
        {choices.length > 0 && (
          <form action={acceptApplicantAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <select name="departmentCode" required className="rounded border px-2 py-1">{choices.map((d) => <option key={d} value={d}>{d}</option>)}</select>
            <input name="notes" placeholder="notes (optional)" className="rounded border px-2 py-1" />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Accept</button>
          </form>
        )}
      </section>
```

The signature/`searchParams` change for the detail page:
```tsx
export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string; applicationId: string }> }) {
  const { id, applicationId } = await params;
```
> NOTE: the route is `/recruitment/cycles/[id]/applicants/[applicationId]`, so `params` carries BOTH `id` and `applicationId`. Read both. Add `searchParams: Promise<{ error?: string }>` to the props and `const { error } = await searchParams;`.

- [ ] **Step 4: Verify.** `npm run typecheck` → clean. `npm run lint` → clean. Manually confirm the detail page reads both `id` and `applicationId` from params.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/applicants"
git commit -m "feat(recruitment): accept panel on applicant review pages"
```

---

### Task 8: Decisions page (SRR conflicts + release)

**Files:**
- Create: `src/app/recruitment/cycles/[id]/decisions/page.tsx`
- Create: `src/app/recruitment/cycles/[id]/decisions/actions.ts`

- [ ] **Step 1: Release action** (`decisions/actions.ts`):

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { releaseDecisions } from "@/modules/recruitment/services/decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";

export async function releaseDecisionsAction(cycleId: string) {
  const person = await requirePersonSession();
  try {
    const res = await releaseDecisions(cycleId, person.personId);
    redirect(`/recruitment/cycles/${cycleId}/decisions?sent=${res.sent}&skipped=${res.skippedConflicted}`);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof AcceptanceError) {
      redirect(`/recruitment/cycles/${cycleId}/decisions?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
```
> `redirect` throws NEXT_REDIRECT; the success redirect is inside `try` but its NEXT_REDIRECT is an error whose `name` is not `RecruitmentAuthError`/`AcceptanceError`, so the `catch` re-throws it correctly. (Same pattern the repo uses in `admin/email/page.tsx`.)

- [ ] **Step 2: Decisions page** (`decisions/page.tsx`) — gate on `recruitment.review_all`:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listConflicts, releaseSummary } from "@/modules/recruitment/services/decisions";
import { releaseDecisionsAction } from "./actions";

export default async function DecisionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; skipped?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const [conflicts, summary] = await Promise.all([listConflicts(id), releaseSummary(id)]);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Decisions — {cycle.title}</h1>
      {sp.error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{sp.error}</p>}
      {sp.sent !== undefined && <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">Released {sp.sent} acceptance email(s); skipped {sp.skipped} conflicted applicant(s).</p>}

      <div className="grid grid-cols-4 gap-3 text-sm">
        <div className="rounded border p-3"><div className="text-slate-500">Accepted</div><div className="text-lg font-semibold">{summary.acceptedApplications}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Unnotified</div><div className="text-lg font-semibold">{summary.unnotified}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Conflicts</div><div className="text-lg font-semibold">{summary.conflictedApplications}</div></div>
        <div className="rounded border p-3"><div className="text-slate-500">Emailed</div><div className="text-lg font-semibold">{summary.emailed}</div></div>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Conflicts to resolve</h2>
        {conflicts.length === 0 ? <p className="mt-2 text-sm text-slate-500">No conflicts.</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {conflicts.map((c) => (
              <li key={c.applicationId} className="border-t py-1">
                <a className="font-medium text-blue-700 underline" href={`/recruitment/cycles/${id}/applicants/${c.applicationId}`}>{c.applicantName}</a> — accepted by {c.departments.join(" + ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={releaseDecisionsAction.bind(null, id)}>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white">Release decisions</button>
        <p className="mt-1 text-xs text-slate-500">Emails every accepted, non-conflicted applicant who hasn&apos;t been notified yet.</p>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify.** `npm run typecheck` → clean. `npm run lint` → clean.

- [ ] **Step 4: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/decisions"
git commit -m "feat(recruitment): SRR decisions page — conflicts + batched release"
```

---

### Task 9: e2e — review, accept, conflict, release

**Files:**
- Create: `e2e/recruitment-review.spec.ts`

The dev login (`j.carney@yale.edu`) is a platform admin and holds `*`, so it satisfies `recruitment.review_all`. Build a cycle via the existing UI helpers, submit applicants publicly, then accept + release through the review/decisions pages. Read `e2e/recruitment.spec.ts` (Plan 10) for the established cycle-build + public-apply helpers and selectors, and reuse them.

- [ ] **Step 1: Write the spec** — one test that:
  1. Dev-logs in as `j.carney@yale.edu`.
  2. Creates a published volunteer cycle with departments `SRHD, MDIC`, a `DEPARTMENT_CHOICE` field, and (for the conflict case) `acceptsRenewals` off; reuse the Plan 10 build helper.
  3. Submits TWO public applications: one ranking `SRHD`, one ranking `SRHD` then changes to also rank `MDIC` is not possible via single-select — so instead submit one ranking `SRHD` and accept it into both SRHD and MDIC via the SRR UI (SRR may place flexibly) to create a conflict.
  4. On `/recruitment/cycles/<id>/applicants`, open the first applicant, accept into `SRHD`.
  5. Open the second applicant, accept into `SRHD`, then accept into `MDIC` (SRR flexible placement) → creates a conflict.
  6. Go to `/recruitment/cycles/<id>/decisions`: assert the conflict row is shown; click **Release decisions**; assert the success banner reports `sent 1` and `skipped 1`.

```ts
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("review: accept, conflict, release", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // --- build a published volunteer cycle with a department-choice field ---
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Review E2E");
  const slug = `review-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD, MDIC");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];
  // add DEPARTMENT_CHOICE to the seeded "Your information" section
  const idForm = page.locator('section', { hasText: "Your information" }).locator('form:has(select[name="type"])');
  await idForm.locator('input[name="label"]').fill("1st choice department");
  await idForm.locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await idForm.locator('button:has-text("Add field")').click();
  // publish
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator('span', { hasText: "OPEN" })).toBeVisible();

  // --- two public submissions (unauthenticated) both ranking SRHD ---
  for (const email of ["one@yale.edu", "two@yale.edu"]) {
    const ctx = await page.context().browser()!.newContext();
    const apply = await ctx.newPage();
    await apply.goto(`/apply/${slug}`);
    await apply.fill('input[name="first_name"]', "App");
    await apply.fill('input[name="last_name"]', email.split("@")[0]);
    await apply.fill('input[name="email"]', email);
    await apply.selectOption('select[name="1st_choice_department"]', "SRHD");
    await apply.click('button:has-text("Submit application")');
    await expect(apply.getByText(/your application was received/i)).toBeVisible();
    await ctx.close();
  }

  // --- accept applicant one into SRHD ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /App one/ }).click();
  await page.selectOption('select[name="departmentCode"]', "SRHD");
  await page.click('button:has-text("Accept")');
  await expect(page.getByText(/Accepted into/)).toBeVisible();

  // --- accept applicant two into BOTH SRHD and MDIC (SRR flexible) → conflict ---
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /App two/ }).click();
  await page.selectOption('select[name="departmentCode"]', "SRHD");
  await page.click('button:has-text("Accept")');
  await page.selectOption('select[name="departmentCode"]', "MDIC");
  await page.click('button:has-text("Accept")');

  // --- decisions: conflict shown, release reports sent 1 / skipped 1 ---
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);
  await expect(page.getByText(/accepted by SRHD \+ MDIC|SRHD \+ MDIC/)).toBeVisible();
  await page.click('button:has-text("Release decisions")');
  await expect(page.getByText(/Released 1 acceptance email\(s\); skipped 1/)).toBeVisible();
});
```

- [ ] **Step 2: Run** `npm run e2e -- recruitment-review.spec.ts`, adjust selectors to the real markup as needed (read the actual pages), and iterate until green.

- [ ] **Step 3: Commit.**
```bash
git add e2e/recruitment-review.spec.ts
git commit -m "test(recruitment): e2e review, accept, conflict, release"
```

---

### Task 10: Final verification

- [ ] **Step 1:** `npm run test:prepare && npm test` → all green (re-run any known DB-timeout flake in isolation).
- [ ] **Step 2:** `npm run typecheck` → clean; `npm run lint` → clean; `npm run build` → succeeds.
- [ ] **Step 3:** Commit any fixups:
```bash
git add -A && git commit -m "chore(recruitment): final verification fixups" || echo "nothing to commit"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Acceptance model (§3) → Task 1; conflicts engine (§6) → Task 2; acceptance email (§6) → Task 3; reviewScope/queue/accept/revoke + authorization rules (§4–§5, §8) → Task 4; conflicts/summary/release (§6) → Task 5; permissions + nav (§4) → Task 6; reviewer surface (§5) → Task 7; decisions surface (§6) → Task 8; testing (§9) → Tasks 2–5,9; done-criteria (§10) → Task 10.
- **Type consistency:** `ReviewScope { all, departmentCodes }`, `RecruitmentAuthError`/`AcceptanceError` defined in `review.ts` and imported by `decisions.ts` and the actions; `findAcceptanceConflicts` returns `Set<string>` used by both services; `acceptanceEmail({firstName, cycleTitle, departmentName})` signature matches its caller in `releaseDecisions`.
- **Authorization is server-side:** every action calls `requirePersonSession`/`requirePermission` and the service re-checks scope; pages only reflect.
- **Back-relation type name:** the `Person` back-relation is `Acceptance[]` with relation name `"recruitmentAcceptanceApprover"`, matching the `Acceptance.approvedBy` side.
- **e2e dept-choice is single-select** in Plan 10, so the conflict is created via SRR flexible placement (accept the same applicant into two departments), not via an applicant ranking two departments.
- **Seed-data field names verified** against the schema: `Role`/`RoleGrant` (nested `grants: { create: [{ permission }] }`), `RoleAssignment` (personId-only global grant), `TermMembership` (personId/termId/departmentId/kind; status defaults ACTIVE; `baselineAvailability` defaults to `[]`).
