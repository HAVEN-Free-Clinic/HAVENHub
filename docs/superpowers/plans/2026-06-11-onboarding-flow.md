# Onboarding Flow (in-flow task completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a not-yet-cleared volunteer complete every onboarding task inside a contained `/get-started/*` flow (no app nav) instead of being deep-linked into the live hub pages.

**Architecture:** Hub-and-spoke. The `/get-started` checklist stays home; four new onboarding-scoped sub-routes render the *reused* task components (`MyInfoForm`, `HipaaPanel`, `TrainingQuiz`, course list) inside a shared `OnboardingStepShell` (no `AppShell`). Each sub-route redirects back to the checklist once its task is satisfied. The gate allowlist tightens to keep volunteers in the flow.

**Tech Stack:** Next.js 16 App Router (async `searchParams`/`params`, inline `"use server"` actions), React Server Components, Prisma, Tailwind v4, vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-onboarding-flow-design.md`

---

## File Structure

**New**
- `src/app/get-started/onboarding-step-shell.tsx` — shared onboarding chrome (back link + progress + title).
- `src/app/get-started/profile/page.tsx` — `MyInfoForm` in the shell.
- `src/app/get-started/hipaa/page.tsx` — `HipaaPanel` in the shell.
- `src/app/get-started/training/page.tsx` — `TrainingQuiz` + slim status in the shell.
- `src/app/get-started/learning/page.tsx` — assigned-course list in the shell.

**Modified**
- `src/platform/auth/onboarding-allowlist.ts` (+ `.test.ts`) — drop `/my-info`, `/training`.
- `src/modules/onboarding/services/onboarding.ts` — repoint `COPY` hrefs to `/get-started/*`.
- `src/app/learning/[courseId]/page.tsx` — optional `?from=onboarding` "Back to onboarding" link.

### Verified facts this plan relies on (read from the rebased codebase)

- `getOnboardingStatus(personId)` returns `{ hasActiveTerm, exempt, onboarded, completedCount, totalCount, tasks }` where `tasks: { key: "profile"|"hipaa"|"training"|"learning"; state: "COMPLETE"|"IN_PROGRESS"|"INCOMPLETE"|"NOT_REQUIRED"; ... }[]`.
- `getMyInfo(personId)` → `{ person, activeTerm, memberships }`; `person` satisfies `MyInfoForm`'s `Pick<Person, ...>`.
- `MyInfoForm({ action, person, error?, saved? })`; `action: (FormData) => Promise<void>`.
- `HipaaPanel({ certificates, uploadAction, dateAction, status, error?, certSaved?, dateError?, dateSaved? })`.
- `updateMyInfo(personId, { phone, contactEmail, yaleAffiliation, gradYear })`; `saveCertificate(personId, { name, type, size, bytes })`; `setCertificateCompletionDate(personId, certId, dateIso)`; `parseCertificateUpload(formData)`; `listMyCertificates(personId)`; `CertificateValidationError` (`.reason`) — all from `@/modules/my-info/services/my-info`. `PersonConflictError` (`.field`) from `@/platform/people`.
- `complianceStatus(cert | null, termEnd | null)` from `@/platform/compliance/rules`.
- `getMyTraining(personId)` → `MyTraining { state, cycle, locked, questions, passPercent, maxAttempts, attemptsUsed, intake, term }` (throws if no active term — safe here, we redirect first when `!hasActiveTerm`).
- `TrainingQuiz({ questions, passPercent, maxAttempts, attemptsUsed, intake })` (client component; grades via its own `gradeQuizAction` and calls `router.refresh()` when the attempt is terminal — no action wiring needed).
- `getMyCourses(personId)` → `{ id, title, description, status }[]`.
- `Card({ interactive?, pad? })` from `@/platform/ui/card`; `Badge({ tone })`; `HavenMark({ className })` (colors via `currentColor`).
- `/learning/*` is wrapped by `src/app/learning/layout.tsx` (AppShell + `requireModuleAccess("learning")`); `/learning` stays allowlisted so the SCORM player is reachable from onboarding.

---

## Task 1: Tighten the gate allowlist

**Files:**
- Modify: `src/platform/auth/onboarding-allowlist.ts`
- Test: `src/platform/auth/onboarding-allowlist.test.ts`

- [ ] **Step 1: Update the test first (red)**

Replace the body of `src/platform/auth/onboarding-allowlist.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { isAllowlistedPath } from "./onboarding-allowlist";

describe("isAllowlistedPath", () => {
  it("matches each allowlisted root exactly", () => {
    for (const p of ["/get-started", "/learning", "/login", "/welcome"]) {
      expect(isAllowlistedPath(p)).toBe(true);
    }
  });

  it("matches the onboarding sub-routes via the /get-started prefix", () => {
    expect(isAllowlistedPath("/get-started/profile")).toBe(true);
    expect(isAllowlistedPath("/get-started/hipaa")).toBe(true);
    expect(isAllowlistedPath("/get-started/training")).toBe(true);
    expect(isAllowlistedPath("/get-started/learning")).toBe(true);
  });

  it("matches the SCORM player under /learning", () => {
    expect(isAllowlistedPath("/learning/abc")).toBe(true);
    expect(isAllowlistedPath("/learning/play/123/index.html")).toBe(true);
  });

  it("no longer allowlists the live my-info and training pages", () => {
    expect(isAllowlistedPath("/my-info")).toBe(false);
    expect(isAllowlistedPath("/my-info/anything")).toBe(false);
    expect(isAllowlistedPath("/training")).toBe(false);
  });

  it("does not match gated pages", () => {
    expect(isAllowlistedPath("/")).toBe(false);
    expect(isAllowlistedPath("/schedule")).toBe(false);
    expect(isAllowlistedPath("/admin")).toBe(false);
  });

  it("does not treat a longer sibling as a prefix match", () => {
    expect(isAllowlistedPath("/learnings")).toBe(false);
    expect(isAllowlistedPath("/get-started-extra")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/platform/auth/onboarding-allowlist.test.ts`
Expected: FAIL (`/my-info` still allowlisted → the "no longer allowlists" case fails).

- [ ] **Step 3: Update the allowlist (green)**

In `src/platform/auth/onboarding-allowlist.ts`, change the `ONBOARDING_ALLOWLIST` array to:

```ts
export const ONBOARDING_ALLOWLIST = ["/get-started", "/learning", "/login", "/welcome"];
```

Update the leading doc comment's first sentence to: "Paths a not-yet-cleared volunteer may reach: the onboarding flow (`/get-started` and its sub-routes), the SCORM course player under `/learning`, and the auth escape hatches." Leave `isAllowlistedPath` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/platform/auth/onboarding-allowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/auth/onboarding-allowlist.ts src/platform/auth/onboarding-allowlist.test.ts
git commit -m "feat(onboarding): tighten gate allowlist to the in-flow routes"
```

---

## Task 2: Repoint the checklist CTAs

**Files:**
- Modify: `src/modules/onboarding/services/onboarding.ts`

- [ ] **Step 1: Change the COPY hrefs**

In `src/modules/onboarding/services/onboarding.ts`, in the `COPY` map, change only the four `href` values:

```ts
  profile: { ...,  href: "/get-started/profile",  ... },
  hipaa:   { ...,  href: "/get-started/hipaa",     ... },
  training:{ ...,  href: "/get-started/training",  ... },
  learning:{ ...,  href: "/get-started/learning",  ... },
```

Concretely, replace `href: "/my-info"` (profile), `href: "/my-info"` (hipaa), `href: "/training"`, and `href: "/learning"` with the four values above. Leave `label`, `description`, and `ctaLabel` unchanged.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/modules/onboarding/services/onboarding.ts
git commit -m "feat(onboarding): point checklist CTAs at the in-flow sub-routes"
```

---

## Task 3: OnboardingStepShell

**Files:**
- Create: `src/app/get-started/onboarding-step-shell.tsx`

- [ ] **Step 1: Write the component**

Create `src/app/get-started/onboarding-step-shell.tsx`:

```tsx
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HavenMark } from "@/platform/ui/haven-mark";

/**
 * Shared chrome for the onboarding task sub-routes: a slim sticky top bar with a
 * "Back to checklist" link, an "N of M complete" progress chip, and the HAVEN
 * mark, over the calm canvas. No AppShell / module nav -- that is what keeps a
 * not-yet-cleared volunteer inside the onboarding flow.
 */
export function OnboardingStepShell({
  title,
  description,
  completedCount,
  totalCount,
  children,
}: {
  title: string;
  description?: string;
  completedCount: number;
  totalCount: number;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3.5">
          <Link
            href="/get-started"
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-slate-600 transition-colors hover:text-slate-900"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            Back to checklist
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-slate-500">
              {completedCount} of {totalCount} complete
            </span>
            <HavenMark className="h-7 w-7 text-brand" />
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-[22px] font-extrabold tracking-tight text-slate-800">{title}</h1>
        {description && <p className="mt-1 text-[14px] leading-relaxed text-slate-600">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/onboarding-step-shell.tsx
git commit -m "feat(onboarding): shared step shell for the in-flow task pages"
```

---

## Task 4: Profile sub-route

**Files:**
- Create: `src/app/get-started/profile/page.tsx`

- [ ] **Step 1: Write the page**

Create `src/app/get-started/profile/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { PersonConflictError } from "@/platform/people";
import { getMyInfo, updateMyInfo } from "@/modules/my-info/services/my-info";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "profile");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const sp = await searchParams;
  const { person: me } = await getMyInfo(person.personId);

  async function action(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    try {
      await updateMyInfo(s.personId, {
        phone: (formData.get("phone") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
      });
    } catch (err) {
      if (err instanceof PersonConflictError) {
        redirect(`/get-started/profile?error=${encodeURIComponent(`${err.field} already belongs to another person`)}`);
      }
      throw err;
    }
    redirect("/get-started");
  }

  return (
    <OnboardingStepShell
      title="Profile & agreements"
      description="Confirm your contact details so we can reach you about shifts."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <MyInfoForm action={action} person={me} error={sp.error} />
    </OnboardingStepShell>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/profile/page.tsx
git commit -m "feat(onboarding): in-flow profile step"
```

---

## Task 5: HIPAA sub-route

**Files:**
- Create: `src/app/get-started/hipaa/page.tsx`

- [ ] **Step 1: Write the page**

Create `src/app/get-started/hipaa/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  getMyInfo,
  listMyCertificates,
  saveCertificate,
  setCertificateCompletionDate,
  parseCertificateUpload,
  CertificateValidationError,
} from "@/modules/my-info/services/my-info";
import { complianceStatus } from "@/platform/compliance/rules";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingHipaaPage({
  searchParams,
}: {
  searchParams: Promise<{ certError?: string; certSaved?: string; dateError?: string; dateSaved?: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "hipaa");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const sp = await searchParams;
  const [{ activeTerm }, certificates] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
  ]);
  const certStatus = complianceStatus(certificates[0] ?? null, activeTerm?.endDate ?? null);

  async function uploadAction(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    const parsed = parseCertificateUpload(formData);
    if (!parsed) redirect("/get-started/hipaa?certError=Choose+a+PDF+file.");
    try {
      const bytes = Buffer.from(await parsed.file.arrayBuffer());
      await saveCertificate(s.personId, { name: parsed.name, type: parsed.type, size: parsed.size, bytes });
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(`/get-started/hipaa?certError=${encodeURIComponent(err.reason)}`);
      }
      throw err;
    }
    // Stay on the step so the volunteer can set the completion date if the PDF
    // parser did not find one. The per-task guard above bounces to the checklist
    // once the certificate is compliant.
    redirect("/get-started/hipaa?certSaved=1");
  }

  async function dateAction(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    const certId = (formData.get("certId") as string | null) ?? "";
    try {
      await setCertificateCompletionDate(s.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(`/get-started/hipaa?dateError=${encodeURIComponent(err.reason)}`);
      }
      throw err;
    }
    redirect("/get-started/hipaa?dateSaved=1");
  }

  return (
    <OnboardingStepShell
      title="HIPAA certificate"
      description="Upload your current HIPAA certificate so we can verify it is valid through the term."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <HipaaPanel
        certificates={certificates}
        uploadAction={uploadAction}
        dateAction={dateAction}
        status={certStatus}
        error={sp.certError}
        certSaved={sp.certSaved === "1"}
        dateError={sp.dateError}
        dateSaved={sp.dateSaved === "1"}
      />
    </OnboardingStepShell>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/hipaa/page.tsx
git commit -m "feat(onboarding): in-flow HIPAA step"
```

---

## Task 6: Training sub-route

**Files:**
- Create: `src/app/get-started/training/page.tsx`

- [ ] **Step 1: Write the page**

Create `src/app/get-started/training/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { Alert } from "@/platform/ui/alert";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { TrainingQuiz } from "@/app/training/training-quiz";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingTrainingPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "training");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const my = await getMyTraining(person.personId);

  return (
    <OnboardingStepShell
      title="Volunteer training"
      description="Most volunteers attend the live session. Missed it? Take the makeup quiz here to clear training."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      {!my.cycle ? (
        <Alert tone="info">
          Training for {my.term.name} is not open yet. You will get an email when it is ready.
        </Alert>
      ) : my.locked ? (
        <Alert tone="error">
          Your makeup quiz is locked after {my.maxAttempts} attempts. Contact your recruitment
          director to reset it, or attend a live session.
        </Alert>
      ) : (
        <TrainingQuiz
          questions={my.questions}
          passPercent={my.passPercent}
          maxAttempts={my.maxAttempts}
          attemptsUsed={my.attemptsUsed}
          intake={my.intake}
        />
      )}
    </OnboardingStepShell>
  );
}
```

Note: `TrainingQuiz` grades via its own `gradeQuizAction` and calls `router.refresh()` when the attempt passes (or hits the cap). The refresh re-renders this server page; once `getMyTraining().state === "COMPLETE"`, the training task is `COMPLETE`, so the per-task guard at the top redirects to `/get-started`. No action wiring is needed here.

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean. (`Alert`'s tone union is `"error" | "success" | "warning" | "info"` — the page uses `info` and `error`.)

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/training/page.tsx
git commit -m "feat(onboarding): in-flow training step"
```

---

## Task 7: Learning sub-route

**Files:**
- Create: `src/app/get-started/learning/page.tsx`

- [ ] **Step 1: Write the page**

Create `src/app/get-started/learning/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePersonSession } from "@/platform/auth/session";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

const LABEL = { COMPLETE: "Complete", IN_PROGRESS: "In progress", NOT_STARTED: "Not started" } as const;

export default async function OnboardingLearningPage() {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "learning");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const courses = await getMyCourses(person.personId);

  return (
    <OnboardingStepShell
      title="Learning modules"
      description="Complete the courses your department assigned to you. Each opens in the course player; you return here when you are done."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <div className="space-y-3">
        {courses.map((c) => (
          <Link key={c.id} href={`/learning/${c.id}?from=onboarding`} className="block">
            <Card interactive>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-slate-800">{c.title}</span>
                <Badge tone={c.status === "COMPLETE" ? "success" : "default"}>{LABEL[c.status]}</Badge>
              </div>
              {c.description && <p className="mt-1 text-sm text-slate-500">{c.description}</p>}
            </Card>
          </Link>
        ))}
      </div>
    </OnboardingStepShell>
  );
}
```

(No empty-state branch is needed: with zero assigned courses the learning task is `NOT_REQUIRED`, so the per-task guard already redirected to the checklist.)

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/get-started/learning/page.tsx
git commit -m "feat(onboarding): in-flow learning course list"
```

---

## Task 8: Learning player "Back to onboarding" link

**Files:**
- Modify: `src/app/learning/[courseId]/page.tsx`

- [ ] **Step 1: Add the optional back link**

Edit `src/app/learning/[courseId]/page.tsx`. Add imports at the top:

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
```

Change the function signature to also accept `searchParams`:

```tsx
export default async function LearningCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;
  const { from } = await searchParams;
```

Then replace the existing `return ( ... )` block with this one (the only change is the added `{from === "onboarding" && ...}` link as the first child; the rest is byte-for-byte the current content):

```tsx
  return (
    <>
      {from === "onboarding" && (
        <Link
          href="/get-started/learning"
          className="mb-4 inline-flex items-center gap-2 text-[13px] font-semibold text-brand transition-colors hover:underline"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to onboarding
        </Link>
      )}
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.status === "COMPLETE" && (
          <Alert tone="success">You have completed this course.</Alert>
        )}
        {course.entryHref ? (
          <ScormPlayer courseId={course.id} entryHref={course.entryHref} initialCmi={course.cmi} />
        ) : (
          <p className="text-sm text-slate-500">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
```

Without `?from=onboarding`, behavior is identical to today (the link simply does not render).

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/learning/[courseId]/page.tsx"
git commit -m "feat(onboarding): return to onboarding from the course player"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck, lint, allowlist tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/platform/auth/onboarding-allowlist.test.ts src/modules/onboarding`
Expected: all clean / passing.

- [ ] **Step 2: Production build**

Run: `DATABASE_URL="postgresql://u:p@localhost:5432/db" DATABASE_URL_UNPOOLED="postgresql://u:p@localhost:5432/db" NEXTAUTH_SECRET="dummy" AUTH_SECRET="dummy" npm run build`
Expected: `✓ Compiled successfully`; the route table lists `ƒ /get-started/profile`, `/get-started/hipaa`, `/get-started/training`, `/get-started/learning`, and `ƒ Proxy (Middleware)`.

- [ ] **Step 3: Manual smoke (dev server, if a DB is available)**

As a not-yet-cleared volunteer:
- From `/get-started`, each task CTA opens its `/get-started/*` step inside the shell (no app nav), with a working "Back to checklist" link and the progress chip.
- Profile: save → returns to checklist, profile shows Done.
- HIPAA: upload a cert → stays on the step to set the completion date if needed; once compliant → returns to checklist.
- Training: pass the makeup quiz → returns to checklist.
- Learning: open a course → full-screen player with a "Back to onboarding" link → returns to `/get-started/learning`.
- Confirm a gated volunteer can no longer reach `/my-info` or `/training` directly (redirected to `/get-started`).
- Complete all tasks → `/get-started` lifts and the hub loads.

- [ ] **Step 4: Final commit (only if lint/build fixups were needed)**

```bash
git add -A
git commit -m "chore(onboarding): verification fixups"
```

---

## Self-review notes

- **Spec coverage:** sub-routes (Tasks 4-7), shared shell (Task 3), CTA repoint (Task 2), allowlist tightening + tests (Task 1), learning return (Task 8), verification (Task 9). All four reused components wired with their existing actions; no service or gate-logic changes.
- **Per-task guard:** every sub-route redirects to `/` when exempt/no-term/onboarded and to `/get-started` when its own task is already satisfied — this drives the HIPAA upload→date→checklist flow and makes re-visits safe.
- **Type consistency:** `getOnboardingStatus` shape, `OnboardingStepShell` props, and the reused component prop names match across all tasks.
- **No new pure logic** beyond the allowlist change (Task 1), which is the only TDD task; the sub-routes are thin wrappers verified by typecheck + build + manual smoke, consistent with the existing page conventions.
