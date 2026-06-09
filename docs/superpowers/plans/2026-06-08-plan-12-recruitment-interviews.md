# Plan 12 — Recruitment Director-Track Interviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the director-track interview lifecycle (schedule, panel, invite, per-panelist recommendations, Accept/Reject/Waitlist decision) on top of the Plan 10/11 recruitment foundation, reusing Plan 11's Acceptance + batched-release machinery for accepted candidates.

**Architecture:** Three new models (`Interview`, `InterviewPanelist`, `Evaluation`) plus two pure engine helpers. Services reuse Plan 11's `reviewScope` for dept-scoped coordinator authorization and panel-membership for evaluators. A director **Accept** decision writes the same `Acceptance` row Plan 11 already releases/emails. A dedicated interviews surface plus an evaluator "my assignments" view; the volunteer flow is untouched.

**Tech Stack:** Next.js 16 App Router, Prisma/Postgres, vitest (unit + integration), Playwright (e2e). Reuses `@/modules/recruitment/services/review` (`reviewScope`, `RecruitmentAuthError`, `AcceptanceError`), `@/platform/rbac/engine` (`can`), `@/platform/email/send` (`queueEmail`), `@/platform/audit` (`recordAudit`).

**Spec:** `docs/superpowers/specs/2026-06-08-recruitment-interviews-design.md`.

**Branch:** `plan-12/recruitment-interviews` (exists, stacked on plan-11).

**Project rule:** NO em-dashes in any shipped UI/email text or comments. Use a colon, comma, or plain words.

---

## File Structure

**Schema / platform:**
- Modify `prisma/schema.prisma` — 2 enums + 3 models + back-relations on `Application` and `Person`.
- Create `prisma/migrations/<ts>_recruitment_interviews/migration.sql`.
- Modify `src/platform/test/db.ts` — add `"Evaluation"`, `"InterviewPanelist"`, `"Interview"` to `resetDb()`.

**Engine / email (pure):**
- Create `src/modules/recruitment/engine/interview-eval.ts` — `evaluationSummary`, `missingPanelists`.
- Create `src/modules/recruitment/email/templates/interview-invite.ts` — `interviewInviteEmail`.

**Services:**
- Create `src/modules/recruitment/services/interviews.ts` — `InterviewError`, `createInterview`, `updateInterview`, `addPanelist`, `removePanelist`, `sendInterviewInvite`, `listInterviewsForReview`, `myAssignedInterviews`, `getInterview`.
- Create `src/modules/recruitment/services/evaluations.ts` — `submitEvaluation`, `listEvaluations`.
- Create `src/modules/recruitment/services/interview-decisions.ts` — `decideInterview`.

**Pages / actions:**
- Modify `src/app/recruitment/cycles/[id]/page.tsx` — add "Interviews" link for director cycles.
- Modify `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` — director cycles show "Schedule interview" instead of the volunteer accept panel.
- Modify `src/app/recruitment/cycles/[id]/applicants/actions.ts` — add `scheduleInterviewAction`.
- Create `src/app/recruitment/cycles/[id]/interviews/page.tsx` + `interviews/actions.ts`.
- Create `src/app/recruitment/cycles/[id]/interviews/[interviewId]/page.tsx`.
- Create `src/app/recruitment/interviews/page.tsx` (my assignments).

**e2e:** Create `e2e/recruitment-interviews.spec.ts`.

---

## Conventions every task follows
- Unit tests `npm test -- <path>`; integration tests need `npm run test:prepare` once.
- `npm run typecheck` and `npm run lint` stay clean. Module-boundary: `src/modules/recruitment/**` imports only `@/platform/**` and within the module.
- Commit at the end of every task with the message shown (colon, no em-dash).

---

### Task 1: Schema — Interview / InterviewPanelist / Evaluation

**Files:** Modify `prisma/schema.prisma`, `src/platform/test/db.ts`; create migration.

- [ ] **Step 1: Add enums** (after the recruitment enums near `enum ApplicationStatus`):
```prisma
enum InterviewDecision {
  PENDING
  ACCEPT
  REJECT
  WAITLIST
}

enum Recommendation {
  STRONG_YES
  YES
  MAYBE
  NO
}
```

- [ ] **Step 2: Add models** (append after the `Acceptance` model):
```prisma
model Interview {
  id             String            @id @default(cuid())
  applicationId  String
  departmentCode String
  scheduledAt    DateTime?
  zoomLink       String?
  invitedAt      DateTime?
  decision       InterviewDecision @default(PENDING)
  decidedById    String?
  decidedAt      DateTime?
  notes          String?
  createdById    String
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt

  application Application         @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  decidedBy   Person?            @relation("interviewDecidedBy", fields: [decidedById], references: [id], onDelete: SetNull)
  createdBy   Person             @relation("interviewCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)
  panelists   InterviewPanelist[]
  evaluations Evaluation[]

  @@unique([applicationId, departmentCode])
  @@index([applicationId])
}

model InterviewPanelist {
  id          String  @id @default(cuid())
  interviewId String
  personId    String
  isLead      Boolean @default(false)

  interview Interview @relation(fields: [interviewId], references: [id], onDelete: Cascade)
  person    Person    @relation("interviewPanelistPerson", fields: [personId], references: [id], onDelete: Cascade)

  @@unique([interviewId, personId])
  @@index([personId])
}

model Evaluation {
  id             String         @id @default(cuid())
  interviewId    String
  evaluatorId    String
  recommendation Recommendation
  comments       String?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  interview Interview @relation(fields: [interviewId], references: [id], onDelete: Cascade)
  evaluator Person    @relation("interviewEvaluator", fields: [evaluatorId], references: [id], onDelete: Cascade)

  @@unique([interviewId, evaluatorId])
}
```

- [ ] **Step 3: Add back-relations.** In `model Application`, add `interviews Interview[]`. In `model Person`, add:
```prisma
  interviewsCreated      Interview[]         @relation("interviewCreatedBy")
  interviewsDecided      Interview[]         @relation("interviewDecidedBy")
  interviewPanels        InterviewPanelist[] @relation("interviewPanelistPerson")
  interviewEvaluations   Evaluation[]        @relation("interviewEvaluator")
```

- [ ] **Step 4: Migration.** Run `npm run db:migrate -- --name recruitment_interviews`. Expect the migration to create the 3 tables + 2 enum types with the uniques/indexes/FKs (Application=Cascade, decidedBy=SetNull, createdBy=Restrict, panelist/evaluator person=Cascade). If `migrate dev` refuses due to drift, hand-write the SQL then `npx prisma migrate resolve --applied <ts>_recruitment_interviews` and `npx prisma generate`.

- [ ] **Step 5: resetDb.** In `src/platform/test/db.ts` add `"Evaluation", "InterviewPanelist", "Interview",` to the TRUNCATE list BEFORE `"Acceptance"`.

- [ ] **Step 6: Verify.** `npx prisma validate` → valid. `npm run typecheck` → clean.

- [ ] **Step 7: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(recruitment): interview, panelist, evaluation models"
```

---

### Task 2: Engine — evaluation summary + missing panelists

**Files:** Create `src/modules/recruitment/engine/interview-eval.ts`; test alongside.

- [ ] **Step 1: Write the failing test** (`interview-eval.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { evaluationSummary, missingPanelists } from "./interview-eval";

describe("evaluationSummary", () => {
  it("counts recommendations and total", () => {
    const s = evaluationSummary([
      { recommendation: "STRONG_YES" }, { recommendation: "YES" }, { recommendation: "YES" }, { recommendation: "NO" },
    ]);
    expect(s).toEqual({ strongYes: 1, yes: 2, maybe: 0, no: 1, total: 4 });
  });
  it("is all zero for no evaluations", () => {
    expect(evaluationSummary([])).toEqual({ strongYes: 0, yes: 0, maybe: 0, no: 0, total: 0 });
  });
});

describe("missingPanelists", () => {
  it("returns panelist ids with no evaluation", () => {
    expect(missingPanelists(["a", "b", "c"], [{ evaluatorId: "b" }])).toEqual(["a", "c"]);
  });
  it("returns empty when all submitted", () => {
    expect(missingPanelists(["a"], [{ evaluatorId: "a" }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`interview-eval.ts`):
```ts
export type Recommendation = "STRONG_YES" | "YES" | "MAYBE" | "NO";

export function evaluationSummary(
  evaluations: { recommendation: Recommendation }[]
): { strongYes: number; yes: number; maybe: number; no: number; total: number } {
  const s = { strongYes: 0, yes: 0, maybe: 0, no: 0, total: evaluations.length };
  for (const e of evaluations) {
    if (e.recommendation === "STRONG_YES") s.strongYes += 1;
    else if (e.recommendation === "YES") s.yes += 1;
    else if (e.recommendation === "MAYBE") s.maybe += 1;
    else if (e.recommendation === "NO") s.no += 1;
  }
  return s;
}

/** Panelist ids who have not submitted an evaluation, preserving input order. */
export function missingPanelists(
  panelistIds: string[],
  evaluations: { evaluatorId: string }[]
): string[] {
  const submitted = new Set(evaluations.map((e) => e.evaluatorId));
  return panelistIds.filter((id) => !submitted.has(id));
}
```

- [ ] **Step 4: Run — PASS (4 tests).**

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/engine/interview-eval.ts src/modules/recruitment/engine/interview-eval.test.ts
git commit -m "feat(recruitment): interview evaluation summary engine"
```

---

### Task 3: Email — interview invite template

**Files:** Create `src/modules/recruitment/email/templates/interview-invite.ts`; test alongside.

- [ ] **Step 1: Write the failing test** (`interview-invite.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { interviewInviteEmail } from "./interview-invite";

describe("interviewInviteEmail", () => {
  it("names the candidate, department, time, and zoom link", () => {
    const { subject, html } = interviewInviteEmail({
      firstName: "Ada", departmentName: "Education", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://zoom.us/j/123",
    });
    expect(subject).toContain("Education");
    expect(html).toContain("Ada");
    expect(html).toContain("https://zoom.us/j/123");
    expect(html).toContain("2026");
  });
  it("escapes HTML in user-supplied values and has no em-dash", () => {
    const { subject, html } = interviewInviteEmail({ firstName: "<b>X</b>", departmentName: "R & D", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://z" });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&amp;");
    expect(subject).not.toContain("—");
    expect(html).not.toContain("—");
  });
  it("handles a missing zoom link", () => {
    const { html } = interviewInviteEmail({ firstName: "A", departmentName: "D", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: null });
    expect(html).toContain("link to follow");
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`interview-invite.ts`):
```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Candidate interview invitation. Notification-only; manual scheduling (no
 *  calendar integration). User-supplied values are HTML-escaped. */
export function interviewInviteEmail(input: {
  firstName: string;
  departmentName: string;
  scheduledAt: Date;
  zoomLink: string | null;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const dept = escapeHtml(input.departmentName);
  const when = escapeHtml(
    input.scheduledAt.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "America/New_York" })
  );
  const zoom = input.zoomLink
    ? `<a href="${escapeHtml(input.zoomLink)}">${escapeHtml(input.zoomLink)}</a>`
    : "link to follow";
  return {
    subject: `HAVEN ${input.departmentName} director interview`,
    html: `<p>Hi ${name},</p><p>You're invited to a director interview for <strong>${dept}</strong> at HAVEN Free Clinic.</p><p>Time: ${when}<br/>Join: ${zoom}</p><p>Please reply if you need to reschedule.</p>`,
  };
}
```

- [ ] **Step 4: Run — PASS (3 tests).**

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/email/templates/interview-invite.ts src/modules/recruitment/email/templates/interview-invite.test.ts
git commit -m "feat(recruitment): interview invite email template"
```

---

### Task 4: Interviews service

**Files:** Create `src/modules/recruitment/services/interviews.ts`; test alongside.

Reuses `reviewScope`, `RecruitmentAuthError` from `./review`; `can` from `@/platform/rbac/engine`; `queueEmail`, `recordAudit`; `interviewInviteEmail`.

- [ ] **Step 1: Write the failing test** (`interviews.test.ts`):
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  createInterview, updateInterview, addPanelist, removePanelist, sendInterviewInvite,
  listInterviewsForReview, myAssignedInterviews, getInterview, InterviewError,
} from "./interviews";

async function seed(track: "DIRECTOR" | "VOLUNTEER" = "DIRECTOR") {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const pcar = await prisma.department.create({ data: { code: "PCAR", name: "Patient Care" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const panelist = await prisma.person.create({ data: { name: "Panelist", status: "ACTIVE" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track, termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC", "PCAR"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Cand", lastName: "Idate", email: "cand@yale.edu", emailLower: "cand@yale.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  return { term, educ, pcar, director, panelist, srr, cycle, applicant, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates an interview for a director cycle within scope", async () => {
  const { director, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  expect(iv.departmentCode).toBe("EDUC");
  expect(iv.decision).toBe("PENDING");
});

it("rejects creating an interview on a volunteer cycle", async () => {
  const { srr, application } = await seed("VOLUNTEER");
  await expect(createInterview(application.id, "EDUC", srr.id)).rejects.toBeInstanceOf(InterviewError);
});

it("rejects a director scheduling outside their department", async () => {
  const { director, application } = await seed();
  await expect(createInterview(application.id, "PCAR", director.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("rejects a duplicate interview", async () => {
  const { director, application } = await seed();
  await createInterview(application.id, "EDUC", director.id);
  await expect(createInterview(application.id, "EDUC", director.id)).rejects.toBeInstanceOf(InterviewError);
});

it("schedules, panels, and invites; invite requires a time and stamps invitedAt + queues email", async () => {
  const { director, panelist, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  await expect(sendInterviewInvite(iv.id, director.id)).rejects.toBeInstanceOf(InterviewError); // no time yet
  await updateInterview(iv.id, { scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://z", notes: null }, director.id);
  const p = await addPanelist(iv.id, panelist.id, true, director.id);
  expect(p.isLead).toBe(true);
  await sendInterviewInvite(iv.id, director.id);
  const after = await prisma.interview.findUniqueOrThrow({ where: { id: iv.id } });
  expect(after.invitedAt).not.toBeNull();
  const emails = await prisma.emailLog.findMany();
  expect(emails).toHaveLength(1);
  expect(emails[0].template).toBe("recruitment.interview_invite");
  await removePanelist(p.id, director.id);
  expect(await prisma.interviewPanelist.count({ where: { interviewId: iv.id } })).toBe(0);
});

it("lists interviews in scope and the panelist's assignments", async () => {
  const { director, panelist, srr, cycle, application } = await seed();
  const iv = await createInterview(application.id, "EDUC", director.id);
  await addPanelist(iv.id, panelist.id, false, director.id);
  expect((await listInterviewsForReview(cycle.id, director.id)).map((i) => i.id)).toEqual([iv.id]);
  expect((await listInterviewsForReview(cycle.id, srr.id))).toHaveLength(1);
  expect((await myAssignedInterviews(panelist.id)).map((i) => i.id)).toEqual([iv.id]);
  expect(await getInterview(iv.id)).not.toBeNull();
});
```

- [ ] **Step 2: Prepare DB + run — FAIL.**

- [ ] **Step 3: Implement** (`interviews.ts`):
```ts
import type { Interview, InterviewPanelist } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";
import { interviewInviteEmail } from "../email/templates/interview-invite";

export class InterviewError extends Error {
  constructor(message: string) { super(message); this.name = "InterviewError"; }
}

async function assertCanManage(departmentCode: string, actorId: string): Promise<void> {
  const scope = await reviewScope(actorId);
  if (!(scope.all || scope.departmentCodes.includes(departmentCode))) {
    throw new RecruitmentAuthError("You can't manage interviews for that department.");
  }
}

export async function createInterview(applicationId: string, departmentCode: string, createdById: string): Promise<Interview> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { cycle: true } });
  if (!app) throw new InterviewError("Application not found.");
  if (app.cycle.track !== "DIRECTOR") throw new InterviewError("Interviews apply to director cycles.");
  if (!app.cycle.departments.includes(departmentCode)) throw new InterviewError("That department is not part of this cycle.");
  await assertCanManage(departmentCode, createdById);
  try {
    const interview = await prisma.interview.create({ data: { applicationId, departmentCode, createdById } });
    await recordAudit({ actorPersonId: createdById, action: "recruitment.interview_create", entityType: "Interview", entityId: interview.id, after: { applicationId, departmentCode } });
    return interview;
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      throw new InterviewError("An interview already exists for that department.");
    }
    throw err;
  }
}

export async function updateInterview(
  interviewId: string,
  patch: { scheduledAt?: Date | null; zoomLink?: string | null; notes?: string | null },
  actorId: string
): Promise<Interview> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  return prisma.interview.update({
    where: { id: interviewId },
    data: {
      scheduledAt: patch.scheduledAt === undefined ? undefined : patch.scheduledAt,
      zoomLink: patch.zoomLink === undefined ? undefined : patch.zoomLink,
      notes: patch.notes === undefined ? undefined : patch.notes,
    },
  });
}

export async function addPanelist(interviewId: string, personId: string, isLead: boolean, actorId: string): Promise<InterviewPanelist> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  try {
    return await prisma.interviewPanelist.create({ data: { interviewId, personId, isLead } });
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code === "P2002") {
      throw new InterviewError("That person is already on the panel.");
    }
    throw err;
  }
}

export async function removePanelist(panelistId: string, actorId: string): Promise<void> {
  const p = await prisma.interviewPanelist.findUnique({ where: { id: panelistId }, include: { interview: true } });
  if (!p) throw new InterviewError("Panelist not found.");
  await assertCanManage(p.interview.departmentCode, actorId);
  await prisma.interviewPanelist.delete({ where: { id: panelistId } });
}

export async function sendInterviewInvite(interviewId: string, actorId: string): Promise<void> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId }, include: { application: { include: { applicant: true } } } });
  if (!iv) throw new InterviewError("Interview not found.");
  await assertCanManage(iv.departmentCode, actorId);
  if (!iv.scheduledAt) throw new InterviewError("Set an interview time first.");
  const dept = await prisma.department.findUnique({ where: { code: iv.departmentCode }, select: { name: true } });
  const applicant = iv.application.applicant;
  const email = interviewInviteEmail({ firstName: applicant.firstName, departmentName: dept?.name ?? iv.departmentCode, scheduledAt: iv.scheduledAt, zoomLink: iv.zoomLink });
  await prisma.$transaction(async (tx) => {
    await queueEmail(tx, { to: applicant.email, subject: email.subject, html: email.html, template: "recruitment.interview_invite" });
    await tx.interview.update({ where: { id: interviewId }, data: { invitedAt: new Date() } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.interview_invite", entityType: "Interview", entityId: interviewId });
}

export async function listInterviewsForReview(cycleId: string, viewerId: string) {
  const scope = await reviewScope(viewerId);
  const seeAll = scope.all || (await can(viewerId, "recruitment.manage_cycles"));
  const interviews = await prisma.interview.findMany({
    where: { application: { cycleId } },
    include: {
      application: { include: { applicant: { select: { firstName: true, lastName: true, email: true } } } },
      panelists: true,
      evaluations: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (seeAll) return interviews;
  const mine = new Set(scope.departmentCodes);
  return interviews.filter((i) => mine.has(i.departmentCode));
}

export async function myAssignedInterviews(personId: string) {
  return prisma.interview.findMany({
    where: { panelists: { some: { personId } } },
    include: {
      application: { include: { applicant: { select: { firstName: true, lastName: true } }, cycle: { select: { id: true, title: true } } } },
      evaluations: { where: { evaluatorId: personId } },
    },
    orderBy: { scheduledAt: "asc" },
  });
}

export async function getInterview(interviewId: string) {
  return prisma.interview.findUnique({
    where: { id: interviewId },
    include: {
      application: { include: { applicant: true, cycle: true } },
      panelists: { include: { person: { select: { id: true, name: true } } } },
      evaluations: { include: { evaluator: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
}
```

- [ ] **Step 4: Run — PASS.** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/interviews.ts src/modules/recruitment/services/interviews.test.ts
git commit -m "feat(recruitment): interviews service: schedule, panel, invite, queries"
```

---

### Task 5: Evaluations service

**Files:** Create `src/modules/recruitment/services/evaluations.ts`; test alongside.

- [ ] **Step 1: Write the failing test** (`evaluations.test.ts`) — reuse the Task 4 `seed` shape inline (term/dept/director/panelist/cycle/application + an interview + panel):
```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { createInterview, addPanelist } from "./interviews";
import { submitEvaluation, listEvaluations } from "./evaluations";

async function seedInterview() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const panelist = await prisma.person.create({ data: { name: "Pan", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "C", lastName: "I", email: "c@y.edu", emailLower: "c@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  const iv = await createInterview(application.id, "EDUC", director.id);
  await addPanelist(iv.id, panelist.id, false, director.id);
  return { iv, panelist, outsider };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lets a panelist submit and update their evaluation (upsert)", async () => {
  const { iv, panelist } = await seedInterview();
  await submitEvaluation(iv.id, panelist.id, "YES", "solid");
  await submitEvaluation(iv.id, panelist.id, "STRONG_YES", "even better");
  const evals = await listEvaluations(iv.id);
  expect(evals).toHaveLength(1);
  expect(evals[0].recommendation).toBe("STRONG_YES");
  expect(evals[0].comments).toBe("even better");
});

it("rejects an evaluation from a non-panelist", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(submitEvaluation(iv.id, outsider.id, "YES", null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`evaluations.ts`):
```ts
import type { Evaluation, Recommendation } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function submitEvaluation(
  interviewId: string,
  evaluatorId: string,
  recommendation: Recommendation,
  comments: string | null
): Promise<Evaluation> {
  const panelist = await prisma.interviewPanelist.findUnique({ where: { interviewId_personId: { interviewId, personId: evaluatorId } } });
  if (!panelist) throw new RecruitmentAuthError("You are not on this interview's panel.");
  const ev = await prisma.evaluation.upsert({
    where: { interviewId_evaluatorId: { interviewId, evaluatorId } },
    create: { interviewId, evaluatorId, recommendation, comments: comments },
    update: { recommendation, comments: comments },
  });
  await recordAudit({ actorPersonId: evaluatorId, action: "recruitment.evaluation_submit", entityType: "Evaluation", entityId: ev.id });
  return ev;
}

export async function listEvaluations(interviewId: string) {
  return prisma.evaluation.findMany({
    where: { interviewId },
    include: { evaluator: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}
```

- [ ] **Step 4: Run — PASS.** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/evaluations.ts src/modules/recruitment/services/evaluations.test.ts
git commit -m "feat(recruitment): evaluations service with panel-membership authz"
```

---

### Task 6: Interview decisions service

**Files:** Create `src/modules/recruitment/services/interview-decisions.ts`; test alongside.

Keeps the `Acceptance` in sync with the decision (spec §8): ACCEPT creates an Acceptance if absent; a non-ACCEPT outcome removes any not-yet-emailed Acceptance for that (application, department).

- [ ] **Step 1: Write the failing test** (`interview-decisions.test.ts`):
```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { createInterview, InterviewError } from "./interviews";
import { decideInterview } from "./interview-decisions";

async function seedInterview() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const educ = await prisma.department.create({ data: { code: "EDUC", name: "Education" } });
  const director = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId: term.id, departmentId: educ.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const outsiderDept = await prisma.department.create({ data: { code: "PCAR", name: "PCAR" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d", departments: ["EDUC"], createdById: director.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "C", lastName: "I", email: "c@y.edu", emailLower: "c@y.edu" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["EDUC"] } });
  const iv = await createInterview(application.id, "EDUC", director.id);
  return { iv, director, outsider, application };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("ACCEPT records the decision and creates an Acceptance", async () => {
  const { iv, director, application } = await seedInterview();
  const updated = await decideInterview(iv.id, "ACCEPT", director.id, "great");
  expect(updated.decision).toBe("ACCEPT");
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).not.toBeNull();
});

it("changing ACCEPT to REJECT removes the not-yet-emailed Acceptance", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await decideInterview(iv.id, "REJECT", director.id, "not a fit");
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).toBeNull();
});

it("does not remove an already-emailed Acceptance when changing away from ACCEPT", async () => {
  const { iv, director, application } = await seedInterview();
  await decideInterview(iv.id, "ACCEPT", director.id, null);
  await prisma.acceptance.update({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } }, data: { emailedAt: new Date() } });
  await decideInterview(iv.id, "WAITLIST", director.id, null);
  const acc = await prisma.acceptance.findUnique({ where: { applicationId_departmentCode: { applicationId: application.id, departmentCode: "EDUC" } } });
  expect(acc).not.toBeNull();
});

it("rejects a decider outside the interview's department scope", async () => {
  const { iv, outsider } = await seedInterview();
  await expect(decideInterview(iv.id, "ACCEPT", outsider.id, null)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("throws InterviewError for a missing interview", async () => {
  const { director } = await seedInterview();
  await expect(decideInterview("nope", "ACCEPT", director.id, null)).rejects.toBeInstanceOf(InterviewError);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`interview-decisions.ts`):
```ts
import type { Interview } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";
import { InterviewError } from "./interviews";

export type InterviewOutcome = "ACCEPT" | "REJECT" | "WAITLIST";

export async function decideInterview(
  interviewId: string,
  outcome: InterviewOutcome,
  deciderId: string,
  notes: string | null
): Promise<Interview> {
  const iv = await prisma.interview.findUnique({ where: { id: interviewId } });
  if (!iv) throw new InterviewError("Interview not found.");
  const scope = await reviewScope(deciderId);
  if (!(scope.all || scope.departmentCodes.includes(iv.departmentCode))) {
    throw new RecruitmentAuthError("You can't decide interviews for that department.");
  }

  const key = { applicationId_departmentCode: { applicationId: iv.applicationId, departmentCode: iv.departmentCode } };
  if (outcome === "ACCEPT") {
    const existing = await prisma.acceptance.findUnique({ where: key });
    if (!existing) {
      await prisma.acceptance.create({ data: { applicationId: iv.applicationId, departmentCode: iv.departmentCode, approvedById: deciderId, notes } });
    }
  } else {
    const existing = await prisma.acceptance.findUnique({ where: key });
    if (existing && !existing.emailedAt) await prisma.acceptance.delete({ where: { id: existing.id } });
  }

  const updated = await prisma.interview.update({
    where: { id: interviewId },
    data: { decision: outcome, decidedById: deciderId, decidedAt: new Date(), notes: notes === undefined ? undefined : notes },
  });
  await recordAudit({ actorPersonId: deciderId, action: "recruitment.interview_decide", entityType: "Interview", entityId: interviewId, after: { decision: outcome } });
  return updated;
}
```

- [ ] **Step 4: Run — PASS (5 tests).** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/interview-decisions.ts src/modules/recruitment/services/interview-decisions.test.ts
git commit -m "feat(recruitment): interview decision with acceptance sync"
```

---

### Task 7: Applicant detail branch + schedule action + overview link

**Files:** Modify `src/app/recruitment/cycles/[id]/page.tsx`, `src/app/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, `src/app/recruitment/cycles/[id]/applicants/actions.ts`.

- [ ] **Step 1: Overview "Interviews" link.** In `cycles/[id]/page.tsx`, in the same `flex gap-3` link row, add (director cycles only):
```tsx
        {cycle.track === "DIRECTOR" && <Link href={`/recruitment/cycles/${id}/interviews`} className="rounded-md border px-3 py-1.5 text-sm">Interviews</Link>}
```

- [ ] **Step 2: Schedule-interview action.** Add to the top imports of `applicants/actions.ts`: `import { createInterview, InterviewError } from "@/modules/recruitment/services/interviews";` (the file already imports `redirect`, `requirePersonSession`, and `RecruitmentAuthError`). Then append the action:
```ts
export async function scheduleInterviewAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const departmentCode = String(formData.get("departmentCode") ?? "").trim();
  try {
    const iv = await createInterview(applicationId, departmentCode, person.personId);
    redirect(`/recruitment/cycles/${cycleId}/interviews/${iv.id}`);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof InterviewError) {
      redirect(`/recruitment/cycles/${cycleId}/applicants/${applicationId}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
```
(Add `InterviewError` to the imports; `redirect` is already imported.)

- [ ] **Step 3: Applicant detail branch.** In `applicants/[applicationId]/page.tsx`, the Decision `<section>` currently renders the volunteer accept panel. Wrap it so it only renders for VOLUNTEER cycles, and add a director branch. Replace the accept-panel `<section>` with:
```tsx
      {app.cycle.track === "VOLUNTEER" ? (
        /* ... existing volunteer Decision section unchanged ... */
      ) : (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Interview</h2>
          {error && <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {choices.length > 0 ? (
            <form action={scheduleInterviewAction.bind(null, id, applicationId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <select name="departmentCode" required className="rounded border px-2 py-1">{choices.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Schedule interview</button>
            </form>
          ) : <p className="mt-2 text-sm text-slate-500">No eligible department to interview for in your scope.</p>}
        </section>
      )}
```
Keep the existing `choices` computation (eligible departments) and add the import `import { scheduleInterviewAction } from "../actions";`. The `error`/`choices`/`scope`/`canView` logic from Plan 11 stays. (For director cycles `choices` = eligible departments to interview for, computed identically.)

- [ ] **Step 4: Verify.** `npm run typecheck` → clean. `npx eslint src` → clean. No em-dashes.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/page.tsx" "src/app/recruitment/cycles/[id]/applicants"
git commit -m "feat(recruitment): director applicant detail schedules interviews"
```

---

### Task 8: Interviews list + coordinator detail pages

**Files:** Create `src/app/recruitment/cycles/[id]/interviews/page.tsx`, `.../interviews/actions.ts`, `.../interviews/[interviewId]/page.tsx`.

- [ ] **Step 1: Coordinator actions** (`interviews/actions.ts`):
```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { updateInterview, addPanelist, removePanelist, sendInterviewInvite, InterviewError } from "@/modules/recruitment/services/interviews";
import { decideInterview, type InterviewOutcome } from "@/modules/recruitment/services/interview-decisions";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";

function detail(cycleId: string, interviewId: string, error?: string) {
  return `/recruitment/cycles/${cycleId}/interviews/${interviewId}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
}
function isDomain(err: unknown) {
  return err instanceof RecruitmentAuthError || err instanceof AcceptanceError || err instanceof InterviewError;
}

export async function scheduleAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const rawAt = String(formData.get("scheduledAt") ?? "").trim();
  const scheduledAt = rawAt ? new Date(rawAt) : null;
  const zoomLink = String(formData.get("zoomLink") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await updateInterview(interviewId, { scheduledAt, zoomLink, notes }, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function addPanelistAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const personId = String(formData.get("personId") ?? "").trim();
  const isLead = formData.get("isLead") === "on";
  try { await addPanelist(interviewId, personId, isLead, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function removePanelistAction(cycleId: string, interviewId: string, panelistId: string) {
  const person = await requirePersonSession();
  try { await removePanelist(panelistId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function sendInviteAction(cycleId: string, interviewId: string) {
  const person = await requirePersonSession();
  try { await sendInterviewInvite(interviewId, person.personId); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}

export async function decideAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const outcome = String(formData.get("outcome") ?? "") as InterviewOutcome;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  try { await decideInterview(interviewId, outcome, person.personId, notes); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}
```

- [ ] **Step 2: Interviews list page** (`interviews/page.tsx`):
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listInterviewsForReview } from "@/modules/recruitment/services/interviews";

function status(iv: { scheduledAt: Date | null; decision: string }): string {
  if (iv.decision !== "PENDING") return iv.decision;
  return iv.scheduledAt ? "Scheduled" : "Offered";
}

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const interviews = await listInterviewsForReview(id, person.personId);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Interviews: {cycle.title}</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Candidate</th><th>Dept</th><th>Status</th><th>Panel</th><th>Evals</th></tr></thead>
        <tbody>
          {interviews.map((iv) => (
            <tr key={iv.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${id}/interviews/${iv.id}`}>{iv.application.applicant.firstName} {iv.application.applicant.lastName}</Link></td>
              <td>{iv.departmentCode}</td>
              <td>{status(iv)}</td>
              <td>{iv.panelists.length}</td>
              <td>{iv.evaluations.length}/{iv.panelists.length}</td>
            </tr>
          ))}
          {interviews.length === 0 && <tr><td colSpan={5} className="py-6 text-slate-500">No interviews in your scope.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Coordinator interview detail page** (`interviews/[interviewId]/page.tsx`). Gate visibility (scope over dept OR panelist), render schedule/panel/invite/evaluations/decision. Use `getInterview`, `reviewScope`, `evaluationSummary`, `can`:
```tsx
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { getInterview } from "@/modules/recruitment/services/interviews";
import { reviewScope } from "@/modules/recruitment/services/review";
import { evaluationSummary } from "@/modules/recruitment/engine/interview-eval";
import { scheduleAction, addPanelistAction, removePanelistAction, sendInviteAction, decideAction } from "../actions";

const RECS = ["STRONG_YES", "YES", "MAYBE", "NO"];

export default async function InterviewDetail({ params, searchParams }: { params: Promise<{ id: string; interviewId: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id, interviewId } = await params;
  const { error } = await searchParams;
  const person = await requirePersonSession();
  const iv = await getInterview(interviewId);
  if (!iv || iv.application.cycle.id !== id) notFound();
  const [scope, managesCycles] = await Promise.all([reviewScope(person.personId), can(person.personId, "recruitment.manage_cycles")]);
  const isPanelist = iv.panelists.some((p) => p.person.id === person.personId);
  const canManage = scope.all || managesCycles || scope.departmentCodes.includes(iv.departmentCode);
  if (!canManage && !isPanelist) notFound();
  const summary = evaluationSummary(iv.evaluations);
  const scheduledValue = iv.scheduledAt ? new Date(iv.scheduledAt.getTime() - iv.scheduledAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{iv.application.applicant.firstName} {iv.application.applicant.lastName}</h1>
      <p className="text-sm text-slate-500">{iv.departmentCode} director interview · {iv.decision}</p>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {canManage && (
        <>
          <section className="rounded border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Schedule</h2>
            <form action={scheduleAction.bind(null, id, interviewId)} className="mt-3 space-y-2 text-sm">
              <label className="block">Time<input type="datetime-local" name="scheduledAt" defaultValue={scheduledValue} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <label className="block">Zoom link<input name="zoomLink" defaultValue={iv.zoomLink ?? ""} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <label className="block">Notes<input name="notes" defaultValue={iv.notes ?? ""} className="mt-1 w-full rounded border px-2 py-1" /></label>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Save</button>
            </form>
            <form action={sendInviteAction.bind(null, id, interviewId)} className="mt-3">
              <button className="rounded-md border px-3 py-1.5 text-sm">{iv.invitedAt ? "Resend invite" : "Send invite"}</button>
              {iv.invitedAt && <span className="ml-2 text-xs text-slate-500">sent {iv.invitedAt.toLocaleString()}</span>}
            </form>
          </section>

          <section className="rounded border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Panel</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {iv.panelists.map((p) => (
                <li key={p.id} className="flex items-center justify-between border-t py-1">
                  <span>{p.person.name}{p.isLead ? " (lead)" : ""}</span>
                  <form action={removePanelistAction.bind(null, id, interviewId, p.id)}><button className="text-xs text-red-600">Remove</button></form>
                </li>
              ))}
            </ul>
            <form action={addPanelistAction.bind(null, id, interviewId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <input name="personId" placeholder="person id" required className="rounded border px-2 py-1" />
              <label className="flex items-center gap-1"><input type="checkbox" name="isLead" /> lead</label>
              <button className="rounded bg-slate-900 px-2 py-1 text-white">Add panelist</button>
            </form>
            <p className="mt-1 text-xs text-slate-500">Panel members can submit an evaluation from their My interviews page.</p>
          </section>
        </>
      )}

      <section className="rounded border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Evaluations ({summary.total})</h2>
        <p className="mt-1 text-xs text-slate-500">Strong yes {summary.strongYes} · Yes {summary.yes} · Maybe {summary.maybe} · No {summary.no}</p>
        <ul className="mt-2 space-y-1 text-sm">
          {iv.evaluations.map((e) => (<li key={e.id} className="border-t py-1"><strong>{e.evaluator.name}</strong>: {e.recommendation}{e.comments ? ` (${e.comments})` : ""}</li>))}
          {iv.evaluations.length === 0 && <li className="text-slate-500">No evaluations yet.</li>}
        </ul>
      </section>

      {canManage && (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Decision</h2>
          <form action={decideAction.bind(null, id, interviewId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <select name="outcome" required className="rounded border px-2 py-1"><option value="ACCEPT">Accept</option><option value="REJECT">Reject</option><option value="WAITLIST">Waitlist</option></select>
            <input name="notes" placeholder="notes (optional)" className="rounded border px-2 py-1" />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Record decision</button>
          </form>
          <p className="mt-1 text-xs text-slate-500">Accept creates an acceptance, released from the Decisions page.</p>
        </section>
      )}

      {isPanelist && <div data-evaluator-slot />}
    </div>
  );
}
```
> The `<div data-evaluator-slot />` is a placeholder Task 9 replaces with the "Your evaluation" form. `RECS` is used by Task 9; keep it. The `personId` text input for adding a panelist is a deliberate MVP (a person-picker is a later polish); the e2e and admins use known ids.

- [ ] **Step 4: Verify.** `npm run typecheck` → clean. `npx eslint src` → clean. No em-dashes.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/interviews"
git commit -m "feat(recruitment): interviews list and coordinator detail pages"
```

---

### Task 9: Evaluator surface — evaluation form + my assignments

**Files:** Modify `src/app/recruitment/cycles/[id]/interviews/[interviewId]/page.tsx` and `.../interviews/actions.ts`; create `src/app/recruitment/interviews/page.tsx`.

- [ ] **Step 1: Evaluation action.** Append to `interviews/actions.ts`:
```ts
import { submitEvaluation } from "@/modules/recruitment/services/evaluations";
import type { Recommendation } from "@prisma/client";

export async function submitEvaluationAction(cycleId: string, interviewId: string, formData: FormData) {
  const person = await requirePersonSession();
  const recommendation = String(formData.get("recommendation") ?? "") as Recommendation;
  const comments = String(formData.get("comments") ?? "").trim() || null;
  try { await submitEvaluation(interviewId, person.personId, recommendation, comments); }
  catch (err) { if (isDomain(err)) redirect(detail(cycleId, interviewId, (err as Error).message)); throw err; }
  revalidatePath(detail(cycleId, interviewId));
}
```

- [ ] **Step 2: Your-evaluation form.** In `interviews/[interviewId]/page.tsx`, import `submitEvaluationAction` from `../actions`, compute the viewer's own evaluation, and replace `{isPanelist && <div data-evaluator-slot />}` with:
```tsx
      {isPanelist && (
        <section className="rounded border p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Your evaluation</h2>
          <form action={submitEvaluationAction.bind(null, id, interviewId)} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <select name="recommendation" required defaultValue={iv.evaluations.find((e) => e.evaluator.id === person.personId)?.recommendation ?? ""} className="rounded border px-2 py-1">
              <option value="" disabled>Recommendation</option>
              {RECS.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
            </select>
            <input name="comments" placeholder="comments" defaultValue={iv.evaluations.find((e) => e.evaluator.id === person.personId)?.comments ?? ""} className="rounded border px-2 py-1" />
            <button className="rounded bg-slate-900 px-2 py-1 text-white">Submit</button>
          </form>
        </section>
      )}
```

- [ ] **Step 3: My interviews page** (`src/app/recruitment/interviews/page.tsx`):
```tsx
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { myAssignedInterviews } from "@/modules/recruitment/services/interviews";

export default async function MyInterviewsPage() {
  const person = await requirePersonSession();
  const interviews = await myAssignedInterviews(person.personId);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">My interview assignments</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-2">Candidate</th><th>Dept</th><th>When</th><th>Your eval</th></tr></thead>
        <tbody>
          {interviews.map((iv) => (
            <tr key={iv.id} className="border-t">
              <td className="py-2"><Link className="font-medium" href={`/recruitment/cycles/${iv.application.cycle.id}/interviews/${iv.id}`}>{iv.application.applicant.firstName} {iv.application.applicant.lastName}</Link></td>
              <td>{iv.departmentCode}</td>
              <td>{iv.scheduledAt ? iv.scheduledAt.toLocaleString() : "TBD"}</td>
              <td>{iv.evaluations.length > 0 ? iv.evaluations[0].recommendation : "Pending"}</td>
            </tr>
          ))}
          {interviews.length === 0 && <tr><td colSpan={4} className="py-6 text-slate-500">No interview assignments.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
```
> This page lives under the recruitment module layout, so the layout's `requireModuleAccess("recruitment")` gate applies; a panelist needs `recruitment.access`.

- [ ] **Step 4: Verify.** `npm run typecheck` → clean. `npx eslint src` → clean. No em-dashes.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/interviews" "src/app/recruitment/interviews"
git commit -m "feat(recruitment): evaluator evaluation form and my-interviews page"
```

---

### Task 10: e2e — director interview flow

**Files:** Create `e2e/recruitment-interviews.spec.ts`.

`j.carney@yale.edu` (platform admin, holds `*`) satisfies `review_all` AND can be a panelist. Build a DIRECTOR cycle, submit an application, schedule an interview, add the admin as a panelist, submit an evaluation, Accept, release, assert the acceptance email is queued.

- [ ] **Step 1: Write the spec** (read `e2e/recruitment.spec.ts` and `e2e/recruitment-review.spec.ts` for the build/apply/release helpers; the admin's own personId is needed for the panelist add — fetch it via the page, or add the admin as a panelist using the `personId` input by reading it from the DB is not possible in e2e, so instead: the admin is the decider; for the evaluation step, add the admin as a panelist by typing their person id — obtain it by navigating, OR simplify: the e2e asserts the coordinator flow through Accept+release and treats the evaluation as optional). Core assertions: an interview is created and schedulable; Accept produces an acceptance that releases with "Released 1 acceptance email(s)".

```ts
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

test("director interview: schedule, decide accept, release", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");

  // build + publish a DIRECTOR cycle with a department-choice field
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Director E2E");
  const slug = `dir-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.selectOption('select[name="track"]', "DIRECTOR");
  await page.fill('input[name="departments"]', "EDUC, PCAR");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];
  const idForm = page.locator("section", { hasText: "Your information" }).locator('form:has(select[name="type"])');
  await idForm.locator('input[name="label"]').fill("1st choice department");
  await idForm.locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await idForm.locator('button:has-text("Add field")').click();
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span", { hasText: "OPEN" })).toBeVisible();

  // public application choosing EDUC
  const ctx = await page.context().browser()!.newContext();
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  await apply.fill('input[name="first_name"]', "Dee");
  await apply.fill('input[name="last_name"]', "Rector");
  await apply.fill('input[name="email"]', "dee@yale.edu");
  await apply.selectOption('select[name="1st_choice_department"]', "EDUC");
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  // schedule an interview from the applicant detail
  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Dee Rector/ }).click();
  await page.selectOption('select[name="departmentCode"]', "EDUC");
  await page.click('button:has-text("Schedule interview")');
  await page.waitForURL((url) => url.pathname.includes("/interviews/"));

  // set a time, then decide Accept
  await page.fill('input[name="scheduledAt"]', "2026-04-15T18:30");
  await page.click('button:has-text("Save")');
  await page.selectOption('select[name="outcome"]', "ACCEPT");
  await page.click('button:has-text("Record decision")');

  // release decisions emails the accepted candidate
  await page.goto(`/recruitment/cycles/${cycleId}/decisions`);
  await page.click('button:has-text("Release decisions")');
  await expect(page.getByText(/Released 1 acceptance email\(s\)/)).toBeVisible();
});
```

- [ ] **Step 2: Run** `npm run e2e -- recruitment-interviews.spec.ts`, adapt selectors to real markup, iterate to green. If the create-cycle form has no `track` select option value "DIRECTOR", read `cycles/new/page.tsx` and use the actual value.

- [ ] **Step 3: Commit.**
```bash
git add e2e/recruitment-interviews.spec.ts
git commit -m "test(recruitment): e2e director interview schedule, accept, release"
```

---

### Task 11: Final verification

- [ ] **Step 1:** `npm run test:prepare && npm test` → all green.
- [ ] **Step 2:** `npm run typecheck` clean; `npm run lint` clean; `npm run build` succeeds.
- [ ] **Step 3:** Em-dash sweep: `grep -rn "—" src/modules/recruitment src/app/recruitment src/app/apply | grep -v ".test."` → no matches.
- [ ] **Step 4:** Commit any fixups: `git add -A && git commit -m "chore(recruitment): final verification fixups" || echo "nothing to commit"`.

---

## Self-Review notes (for the executor)

- **Spec coverage:** models (§3) → Task 1; engine (§6) → Task 2; invite email (§7) → Task 3; interviews service incl. scope authz + invite guard (§4,§5,§8,§9) → Task 4; evaluations panel-authz (§4,§8) → Task 5; decision + acceptance sync (§8) → Task 6; applicant branch + overview link (§5) → Task 7; coordinator surfaces (§5) → Task 8; evaluator surfaces (§5) → Task 9; testing (§10) → Tasks 2-6,10; done-criteria (§11) → Task 11.
- **Reuse:** `Acceptance` + `decisions.ts` release are untouched; a director ACCEPT writes an `Acceptance` row the existing Decisions page releases. `reviewScope`/`RecruitmentAuthError`/`AcceptanceError` imported from `./review`.
- **Type consistency:** `InterviewOutcome` ("ACCEPT"|"REJECT"|"WAITLIST") in `interview-decisions.ts` used by `decideAction`; `InterviewError` defined in `interviews.ts`, imported by `interview-decisions.ts` and the actions; `evaluationSummary` shape `{strongYes,yes,maybe,no,total}` matches its page use; Prisma compound-unique accessors `applicationId_departmentCode` (Acceptance + Interview), `interviewId_personId` (panelist), `interviewId_evaluatorId` (evaluation).
- **Acceptance sync sharp edge (Task 6):** non-ACCEPT removes only a NOT-yet-emailed acceptance; an emailed one stays (revocable via Plan 11's `review_all` path), matching the volunteer post-email rule.
- **No em-dashes** in any added UI/email text; Task 11 sweeps to confirm.
