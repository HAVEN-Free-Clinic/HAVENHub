# Application Portal — Stage 3: Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each applicant the status of their application(s) in the portal, with neutral progress always visible and final ACCEPT/REJECT/WAITLIST decisions surfaced only after the team releases them.

**Architecture:** A `decisionsReleasedAt` timestamp on `RecruitmentCycle` (set by the existing `releaseDecisions` admin flow) is the release gate. A `getApplicantStatus(identity)` service aggregates each Application with its acceptances/interviews/onboarding-contract into a per-application status view, gating final outcomes behind the release signal and never reading internal evaluations. The portal home renders these views. The NEW-applicant submit is bound to the resolved identity (the email is no longer trusted from the form), closing the Stage 2 follow-up the reviewer flagged.

**Tech Stack:** Next.js 16, Prisma/Postgres, Vitest (node env), Tailwind v4. Builds on Stage 1 (identity) + Stage 2 (drafts).

**Spec:** `docs/superpowers/specs/2026-06-25-application-portal-design.md` (Stage 3 = the "Status portal + release safety" section). Stages 1-2 are merged.

## Global Constraints

- No em-dashes in user-facing copy or code comments. Use commas, parentheses, or colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`.
- No new dependencies.
- **Release gating:** a final decision is shown only when released. "Released" = the specific `Acceptance.emailedAt` is set (for an accept), or the cycle's `decisionsReleasedAt` is set (for a not-selected / waitlist). Before release, status stays neutral ("Under review"). NEVER read `Evaluation` or `InterviewPanelist` (internal); never surface an unreleased `Interview.decision` except a WAITLIST when the cycle is released.
- **Identity scoping (carried from Stage 2):** status is scoped to the resolved identity (`emailLower OR personId`).
- **NEW-submit identity binding:** for a NEW applicant the authoritative email is the resolved identity email (magic-link-verified or SSO), not the form `answers.email`. The submit overrides it, the same way renewals override with the session email.
- Vitest is node-env (no DOM): services get DB-backed tests; UI is verified by `npm run typecheck`, `npm run lint`, `npm run build`, manual. One file: `npx vitest run <path>`; `resetDb()` from `@/platform/test/db`. After a migration, apply it to the test DB (Task 1).

---

### Task 1: Release gate — decisionsReleasedAt

**Files:**
- Modify: `prisma/schema.prisma` (`RecruitmentCycle` add `decisionsReleasedAt DateTime?`)
- Create: `prisma/migrations/<timestamp>_cycle_decisions_released_at/migration.sql`
- Modify: `src/modules/recruitment/services/decisions.ts` (`releaseDecisions` sets it)
- Test: `src/modules/recruitment/services/decisions.test.ts` (add)

**Interfaces:**
- Produces: `RecruitmentCycle.decisionsReleasedAt DateTime?`, set to `now` whenever `releaseDecisions` runs.

- [ ] **Step 1: Add the field**

In `prisma/schema.prisma`, in `RecruitmentCycle`, add after `acceptsRenewals`:
```prisma
  decisionsReleasedAt DateTime?
```

- [ ] **Step 2: Hand-author the migration**

`prisma migrate dev` cannot run here. Create `prisma/migrations/<timestamp>_cycle_decisions_released_at/migration.sql` (14-digit timestamp after the latest; `ls prisma/migrations | sort | tail -3`):
```sql
-- AlterTable
ALTER TABLE "RecruitmentCycle" ADD COLUMN "decisionsReleasedAt" TIMESTAMP(3);
```

- [ ] **Step 3: Regenerate + apply to dev and test DBs**

Run: `npx prisma generate`
Run: `npx prisma migrate deploy`
Run: `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" DATABASE_URL_UNPOOLED="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" npx prisma migrate deploy`
Expected: applied. If the DB is down: `npm run db:up`; if still unreachable, report BLOCKED.

- [ ] **Step 4: Write the failing test**

Add to `src/modules/recruitment/services/decisions.test.ts` (it has a `seed()` returning `{ srr, cycle, clean, ... }` and imports `releaseDecisions`, `acceptApplicant`):
```ts
it("stamps decisionsReleasedAt on the cycle when decisions are released", async () => {
  const { srr, cycle, clean } = await seed();
  await acceptApplicant(clean.id, "SRHD", srr.id, null);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).toBeNull();
  await releaseDecisions(cycle.id, srr.id);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).not.toBeNull();
});

it("stamps decisionsReleasedAt even when there are no acceptances (all not-selected)", async () => {
  const { srr, cycle } = await seed();
  const res = await releaseDecisions(cycle.id, srr.id);
  expect(res.sent).toBe(0);
  expect((await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).decisionsReleasedAt).not.toBeNull();
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/decisions.test.ts -t "decisionsReleasedAt"`
Expected: FAIL (the field is never set).

- [ ] **Step 6: Set it in `releaseDecisions`**

In `decisions.ts`, in `releaseDecisions`, after the `for (const acc of acceptances) { ... }` loop and before the `recordAudit` call, add:
```ts
  // Mark the cycle's decisions released so the applicant portal may surface
  // final outcomes (accepted via emailedAt, not-selected/waitlist via this stamp).
  await prisma.recruitmentCycle.update({ where: { id: cycleId }, data: { decisionsReleasedAt: new Date() } });
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/decisions.test.ts`
Expected: PASS (all decisions tests, including the 2 new).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/services/decisions.ts src/modules/recruitment/services/decisions.test.ts
git commit -m "feat(recruitment): stamp decisionsReleasedAt when releasing decisions"
```

---

### Task 2: Bind the NEW-applicant submit to the resolved identity

The Stage 2 reviewer flagged that a NEW applicant could submit under a form email that differs from their verified identity. Bind it: for NEW, the authoritative email is the resolved identity email (override the form value), mirroring how renewals override with the session email.

**Files:**
- Modify: `src/app/apply/[slug]/actions.ts` (resolve identity, pass its email)
- Modify: `src/modules/recruitment/services/submissions.ts` (use the identity email for NEW)
- Test: `src/modules/recruitment/services/submissions.test.ts` (add)

**Interfaces:**
- `SubmitInput` gains `identityEmail?: string | null`. For `applicantType === "NEW"`, when `identityEmail` is set, the submission email/emailLower (the dedup + owner key) is `identityEmail`, ignoring a differing `answers.email`.

- [ ] **Step 1: Write the failing test**

Add to `submissions.test.ts`:
```ts
it("binds a NEW submission to the resolved identity email, ignoring a tampered form email", async () => {
  await openVolunteerCycle();
  const app = await submitApplication("apply-v", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "tampered@evil.com", "1st_choice_department": "SRHD", srhd_essay: "x" },
    files: {},
    identityEmail: "ann@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.email).toBe("ann@yale.edu"); // identity wins, not the form value
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "binds a NEW submission"`
Expected: FAIL (today the form email is used; applicant.email is `tampered@evil.com`).

- [ ] **Step 3: Extend `SubmitInput` and bind the NEW email**

In `submissions.ts`, add to `SubmitInput`:
```ts
  identityEmail?: string | null;
```
Then change the NEW-applicant answer injection. Just after the renewal block (the `if (input.applicantType === "RENEWAL") { ... }` that ends by overriding `input.answers.email`), add the symmetric NEW binding:
```ts
  if (input.applicantType === "NEW" && input.identityEmail) {
    // The apply page is identity-gated; the authoritative email is the verified
    // identity (magic-link or SSO), not the form value. Override so the dedup +
    // owner key cannot be a different, unverified address.
    input.answers = { ...input.answers, email: input.identityEmail };
  }
```
The existing `const email = (input.applicantType === "RENEWAL" ? input.sessionEmail! : String(input.answers.email ?? "")).trim();` now reads the overridden NEW answer for the email, so no further change is needed there.

- [ ] **Step 4: Pass the identity email from the action**

In `src/app/apply/[slug]/actions.ts`, add the import and resolve identity:
```ts
import { getApplicantIdentity } from "@/modules/recruitment/services/portal-auth";
```
After `const session = await auth();`, add:
```ts
  const identity = await getApplicantIdentity();
```
And add `identityEmail: identity?.email ?? null,` to the `submitApplication(...)` call's input object.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (all submission tests, including the new binding test). Run `npm run typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add "src/app/apply/[slug]/actions.ts" src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): bind NEW submit to the verified identity email"
```

---

### Task 3: getApplicantStatus service

**Files:**
- Modify: `src/modules/recruitment/services/portal-status.ts`
- Test: `src/modules/recruitment/services/portal-status.test.ts` (add)

**Interfaces:**
- Consumes: `prisma`; `ApplicantIdentity`.
- Produces:
  - `type ApplicantStatusView = { slug: string; cycleTitle: string; state: "DRAFT" | "SUBMITTED" | "INTERVIEW" | "ACCEPTED" | "ONBOARDING" | "NOT_SELECTED" | "WAITLISTED"; headline: string; detail: string | null; canContinue: boolean }`
  - `getApplicantStatus(identity: ApplicantIdentity): Promise<ApplicantStatusView[]>`
  - (Keep `listApplicantApplications` for now; Task 4 switches the page to `getApplicantStatus`.)

**Status precedence (most-advanced wins), with release gating:**
1. `DRAFT` -> state DRAFT, headline "Draft", detail "Continue your application", canContinue true.
2. an Acceptance has a `contract` -> ONBOARDING, headline "Onboarding in progress", detail by contract status (PENDING "Form sent to you", SUBMITTED "Form submitted", PROMOTED "Complete").
3. an Acceptance has `emailedAt` set -> ACCEPTED, headline `Accepted to ${deptName}`.
4. cycle `decisionsReleasedAt` set AND no acceptance:
   - any Interview `decision === "WAITLIST"` -> WAITLISTED, headline "Waitlisted".
   - else -> NOT_SELECTED, headline "Not selected this cycle".
5. any Interview `scheduledAt` set -> INTERVIEW, headline "Interview scheduled", detail the local time (+ join link note if `zoomLink`).
6. else -> SUBMITTED, headline "Submitted", detail "Under review".

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/recruitment/services/portal-status.test.ts` (it has `resetDb`, `prisma`). Use the recruitment services to create downstream records:
```ts
import { getApplicantStatus } from "./portal-status";
import { acceptApplicant } from "./review";
import { releaseDecisions } from "./decisions";
import { createOrResendContract } from "./onboarding";

async function cycleWithApp(slug: string, email: string, opts?: { released?: boolean }) {
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "RA " + slug, grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "F", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "Student Run Health Dept" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "Volunteer 2026", publicSlug: slug, departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Reed", lastName: "R", email, emailLower: email.toLowerCase() } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], status: "SUBMITTED", submittedAt: new Date() } });
  return { srr, cycle, applicant, app };
}
const ID = (email: string) => ({ email, personId: null });

it("shows Submitted / under review before any decision", async () => {
  await cycleWithApp("c1", "reed@yale.edu");
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("SUBMITTED");
});

it("shows Accepted only after the acceptance email is sent (released)", async () => {
  const { srr, app } = await cycleWithApp("c2", "reed@yale.edu");
  await acceptApplicant(app.id, "SRHD", srr.id, null);
  // Accepted but not yet released: still neutral.
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("SUBMITTED");
  await releaseDecisions((await prisma.recruitmentCycle.findFirstOrThrow({ where: { publicSlug: "c2" } })).id, srr.id);
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("ACCEPTED");
  expect(v.headline).toContain("Student Run Health Dept");
});

it("shows Not selected only after decisions are released", async () => {
  const { srr, cycle } = await cycleWithApp("c3", "reed@yale.edu");
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("SUBMITTED");
  await releaseDecisions(cycle.id, srr.id);
  expect((await getApplicantStatus(ID("reed@yale.edu")))[0].state).toBe("NOT_SELECTED");
});

it("shows Onboarding once a contract exists", async () => {
  const { srr, app, cycle } = await cycleWithApp("c4", "reed@yale.edu");
  const acc = await acceptApplicant(app.id, "SRHD", srr.id, null);
  await releaseDecisions(cycle.id, srr.id);
  await createOrResendContract(acc.id, srr.id, "http://test");
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("ONBOARDING");
});

it("shows a scheduled interview as neutral progress", async () => {
  const { app } = await cycleWithApp("c5", "reed@yale.edu");
  await prisma.interview.create({ data: { applicationId: app.id, departmentCode: "SRHD", scheduledAt: new Date("2026-09-01T14:00:00Z"), createdById: (await prisma.person.findFirstOrThrow()).id } });
  const [v] = await getApplicantStatus(ID("reed@yale.edu"));
  expect(v.state).toBe("INTERVIEW");
});

it("does not leak another identity's status", async () => {
  await cycleWithApp("c6", "reed@yale.edu");
  expect(await getApplicantStatus(ID("other@yale.edu"))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/portal-status.test.ts`
Expected: FAIL (`getApplicantStatus` missing).

- [ ] **Step 3: Implement `getApplicantStatus`**

Append to `portal-status.ts`:
```ts
export type ApplicantStatusView = {
  slug: string;
  cycleTitle: string;
  state: "DRAFT" | "SUBMITTED" | "INTERVIEW" | "ACCEPTED" | "ONBOARDING" | "NOT_SELECTED" | "WAITLISTED";
  headline: string;
  detail: string | null;
  canContinue: boolean;
};

/** Per-application status for the portal. Final outcomes are shown only after
 *  release: an accept via Acceptance.emailedAt, a not-selected/waitlist via
 *  the cycle's decisionsReleasedAt. Internal evaluations are never read. */
export async function getApplicantStatus(identity: ApplicantIdentity): Promise<ApplicantStatusView[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: {
      cycle: { select: { publicSlug: true, title: true, decisionsReleasedAt: true } },
      applications: {
        include: {
          acceptances: { select: { departmentCode: true, emailedAt: true, contract: { select: { status: true } } } },
          interviews: { select: { scheduledAt: true, zoomLink: true, decision: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Department code -> name, for the accepted-to headline.
  const codes = new Set<string>();
  for (const a of applicants) for (const app of a.applications) for (const acc of app.acceptances) codes.add(acc.departmentCode);
  const depts = codes.size ? await prisma.department.findMany({ where: { code: { in: [...codes] } }, select: { code: true, name: true } }) : [];
  const deptName = new Map(depts.map((d) => [d.code, d.name]));

  const views: ApplicantStatusView[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    const base = { slug: a.cycle.publicSlug, cycleTitle: a.cycle.title };
    if (app.status === "DRAFT") {
      views.push({ ...base, state: "DRAFT", headline: "Draft", detail: "Continue your application", canContinue: true });
      continue;
    }
    const released = a.cycle.decisionsReleasedAt != null;
    const emailedAcc = app.acceptances.find((acc) => acc.emailedAt != null);
    const onboardingAcc = app.acceptances.find((acc) => acc.contract != null);
    const scheduledInterview = app.interviews.find((iv) => iv.scheduledAt != null);
    const waitlisted = released && app.interviews.some((iv) => iv.decision === "WAITLIST");

    if (onboardingAcc?.contract) {
      const step = onboardingAcc.contract.status === "PROMOTED" ? "Complete" : onboardingAcc.contract.status === "SUBMITTED" ? "Form submitted" : "Form sent to you";
      views.push({ ...base, state: "ONBOARDING", headline: "Onboarding in progress", detail: step, canContinue: false });
    } else if (emailedAcc) {
      views.push({ ...base, state: "ACCEPTED", headline: `Accepted to ${deptName.get(emailedAcc.departmentCode) ?? emailedAcc.departmentCode}`, detail: null, canContinue: false });
    } else if (released && waitlisted) {
      views.push({ ...base, state: "WAITLISTED", headline: "Waitlisted", detail: "We will be in touch if a spot opens.", canContinue: false });
    } else if (released) {
      views.push({ ...base, state: "NOT_SELECTED", headline: "Not selected this cycle", detail: "Thank you for applying.", canContinue: false });
    } else if (scheduledInterview?.scheduledAt) {
      const when = scheduledInterview.scheduledAt.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
      views.push({ ...base, state: "INTERVIEW", headline: "Interview scheduled", detail: scheduledInterview.zoomLink ? `${when} (join link in your email)` : when, canContinue: false });
    } else {
      views.push({ ...base, state: "SUBMITTED", headline: "Submitted", detail: "Under review", canContinue: false });
    }
  }
  return views;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/portal-status.test.ts`
Expected: PASS (the existing `listApplicantApplications` test + the 6 new status tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/portal-status.ts src/modules/recruitment/services/portal-status.test.ts
git commit -m "feat(recruitment): applicant status with release gating"
```

---

### Task 4: Portal home renders rich status

**Files:**
- Modify: `src/app/apply/page.tsx` (use `getApplicantStatus`, render status views)

**Interfaces:**
- Consumes: `getApplicantStatus` from `@/modules/recruitment/services/portal-status`.

- [ ] **Step 1: Swap the list for status views**

In `src/app/apply/page.tsx`, change the import from `listApplicantApplications` to `getApplicantStatus`, replace `const myApps = await listApplicantApplications(identity);` with `const myApps = await getApplicantStatus(identity);`, and replace the "Your applications" section's list rendering with status rows. A DRAFT row links to `/apply/<slug>` to continue; non-draft rows show the headline + detail (not a link):
```tsx
      {myApps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your applications</h2>
          <ul className="space-y-2">
            {myApps.map((a) => (
              <li key={a.slug}>
                {a.canContinue ? (
                  <Link href={`/apply/${a.slug}`} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 hover:bg-muted">
                    <span><span className="block text-sm font-medium text-foreground">{a.cycleTitle}</span><span className="block text-xs text-muted-foreground">{a.detail}</span></span>
                    <span className="text-sm text-brand-fg">Continue</span>
                  </Link>
                ) : (
                  <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
                    <span><span className="block text-sm font-medium text-foreground">{a.cycleTitle}</span><span className="block text-xs text-muted-foreground">{a.detail}</span></span>
                    <span className="text-sm font-medium text-foreground">{a.headline}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean (lint's pre-existing `HAVEN Free Clinic Design System/` errors are not yours; if `listApplicantApplications` is now unused anywhere, leave it exported, the service keeps it).

Manual check (run skill or `npm run dev`): as a signed-in applicant with a submitted application, the portal shows "Submitted / Under review"; after an admin accepts + releases, it shows "Accepted to <dept>"; a draft shows "Continue"; another email sees nothing.

- [ ] **Step 3: Commit**

```bash
git add "src/app/apply/page.tsx"
git commit -m "feat(recruitment): portal home shows application status"
```

---

### Task 5: Full verification pass

- [ ] **Step 1:** `npm run test` — expect pass; the only acceptable failures are this repo's known shared-test-DB contention flakes and the `/tmp` cert flakes (non-deterministic, in modules this stage does not touch). Confirm any recruitment failure passes in isolation (`npx vitest run src/modules/recruitment`).
- [ ] **Step 2:** `npm run typecheck && npm run lint && npm run build` — all clean.
- [ ] **Step 3:** Manual end-to-end: submit an application, see "Submitted / Under review"; have an admin accept + `releaseDecisions`, see "Accepted to <dept>"; an unaccepted applicant in a released cycle sees "Not selected"; a contract makes it "Onboarding in progress"; a scheduled interview (unreleased) shows "Interview scheduled"; an unreleased decision never leaks; another identity sees nothing.
- [ ] **Step 4:** Commit any verification fixes.

---

## Self-Review Notes

- **Spec coverage (Stage 3):** the `decisionsReleasedAt` release gate set by `releaseDecisions` (Task 1); the NEW-submit identity binding the Stage 2 reviewer asked for before identity-keyed status (Task 2); `getApplicantStatus` with the precise release-gated mapping, never reading evaluations (Task 3); the portal rendering (Task 4); verification (Task 5). The status mapping matches the spec: neutral progress always (Draft / Submitted / Interview scheduled / Onboarding), accept shown via `emailedAt`, not-selected/waitlist only via `decisionsReleasedAt`.
- **Release-gate definition:** accept = `Acceptance.emailedAt`; not-selected/waitlist = `cycle.decisionsReleasedAt`. Onboarding (a contract exists) implies the applicant was emailed the onboarding link, so it is shown as progress. This is the single explicit, team-controlled gate.
- **Isolation:** `getApplicantStatus` scopes to `emailLower OR personId` (test covers the negative case); the NEW-submit binding (Task 2) ensures a submitted application's owner email is the verified identity, so the identity-keyed status cannot attach to an unverified address.
- **Type consistency:** `ApplicantStatusView` + `getApplicantStatus` (Task 3) are consumed by the page (Task 4); `SubmitInput.identityEmail` (Task 2) is supplied by the action; `ApplicantIdentity` from Stage 1 flows throughout.
- **Risks to confirm during execution:** the precedence order (onboarding > accepted > released-negative > interview > submitted) is intentional, so an accepted+released applicant with a stale scheduled interview still shows Accepted/Onboarding, not Interview; the dept-name lookup falls back to the code if a Department row is missing.
