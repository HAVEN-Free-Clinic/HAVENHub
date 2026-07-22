# Workday training links + Epic access button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point volunteers with outstanding EHS/HIPAA requirements to Yale Workday Learning, and give Epic-provisioned users a one-click "Access Epic" shortcut to the YNHH apps portal.

**Architecture:** Two hardcoded external-URL constants feed (a) a shared `ExternalLinkButton` primitive used by three "Complete in Workday" CTAs (EHS panel, HIPAA panel, onboarding checklist), and (b) a dashboard side-rail `EpicAccessCard` gated on `Person.epicId`. One pure predicate (`hipaaNeedsTrainingLink`) decides when the HIPAA CTA shows. No data model, onboarding-engine, or settings changes.

**Tech Stack:** Next.js App Router (React Server Components), TypeScript, Tailwind, Prisma, vitest, lucide-react.

## Global Constraints

- No em-dashes anywhere (code, comments, copy). Use commas/periods/parentheses. (Repo lints them out.)
- External links use a raw `<a href target="_blank" rel="noopener noreferrer">` with an sr-only "(opens in a new tab)" span. This is the app convention (`clinic-channel-card.tsx`) and needs NO `eslint-disable`.
- URLs are hardcoded constants in `src/platform/external-links.ts`. Do NOT add settings/registry entries.
- Do NOT thread external URLs through `OnboardingTask.href` (that field is internal `<Link>` routing).
- After every task: `npm run typecheck` and `npm run lint` must pass. Logic tasks also run `npm test`.
- `buttonClasses(variant = "primary", size = "md", extra?)` is exported from `@/platform/ui/button`; its `variant`/`size` unions are NOT exported (reference them via `Parameters<typeof buttonClasses>`).
- `ComplianceStatus = "COMPLIANT" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN_DATE" | "PENDING_VERIFICATION" | "NO_CERTIFICATE"` (from `@/platform/compliance/rules`).
- Prisma client is `import { prisma } from "@/platform/db"`.

---

### Task 1: `hipaaNeedsTrainingLink` predicate

**Files:**
- Modify: `src/platform/compliance/rules.ts` (append predicate near the `ComplianceStatus` type, ~line 47)
- Test: `src/platform/compliance/rules.test.ts` (append a `describe` block; extend the existing `./rules` import)

**Interfaces:**
- Consumes: `ComplianceStatus` (already defined in `rules.ts`)
- Produces: `hipaaNeedsTrainingLink(status: ComplianceStatus): boolean`: `true` for `NO_CERTIFICATE | EXPIRED | EXPIRING_SOON`, else `false`.

- [ ] **Step 1: Write the failing test**

In `src/platform/compliance/rules.test.ts`, add `hipaaNeedsTrainingLink` to the existing top import from `"./rules"`:

```ts
import {
  CERT_VALIDITY_DAYS,
  TERM_END_BUFFER_DAYS,
  RENEWAL_WARNING_DAYS,
  certExpiresAt,
  complianceStatus,
  effectiveComplianceStatus,
  overallClearance,
  hipaaNeedsTrainingLink,
} from "./rules";
```

Append at the end of the file:

```ts
describe("hipaaNeedsTrainingLink", () => {
  it("is true when the person must (re)take the course", () => {
    expect(hipaaNeedsTrainingLink("NO_CERTIFICATE")).toBe(true);
    expect(hipaaNeedsTrainingLink("EXPIRED")).toBe(true);
    expect(hipaaNeedsTrainingLink("EXPIRING_SOON")).toBe(true);
  });

  it("is false when a cert is on file awaiting a manager, or compliant", () => {
    expect(hipaaNeedsTrainingLink("COMPLIANT")).toBe(false);
    expect(hipaaNeedsTrainingLink("PENDING_VERIFICATION")).toBe(false);
    expect(hipaaNeedsTrainingLink("UNKNOWN_DATE")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/compliance/rules.test.ts -t "hipaaNeedsTrainingLink"`
Expected: FAIL, because the file fails to import because `hipaaNeedsTrainingLink` is not exported from `./rules`.

- [ ] **Step 3: Write minimal implementation**

In `src/platform/compliance/rules.ts`, immediately after the `ComplianceStatus` type declaration (after line 47), add:

```ts
/**
 * Whether to show the "complete HIPAA training in Workday" link for a status.
 * True when the person must (re)take the course: no cert on file, expired, or
 * expiring soon. False when a cert is on file awaiting a manager
 * (UNKNOWN_DATE, PENDING_VERIFICATION) or already compliant, where sending them
 * back to the course would misdirect.
 */
export function hipaaNeedsTrainingLink(status: ComplianceStatus): boolean {
  return (
    status === "NO_CERTIFICATE" ||
    status === "EXPIRED" ||
    status === "EXPIRING_SOON"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/compliance/rules.test.ts -t "hipaaNeedsTrainingLink"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/compliance/rules.ts src/platform/compliance/rules.test.ts
git commit -m "feat(compliance): add hipaaNeedsTrainingLink predicate"
```

---

### Task 2: External-URL constants + `ExternalLinkButton` primitive

**Files:**
- Create: `src/platform/external-links.ts`
- Create: `src/platform/ui/external-link-button.tsx`

**Interfaces:**
- Produces: `WORKDAY_LEARNING_URL: string`, `EPIC_APPS_URL: string` (from `@/platform/external-links`)
- Produces: `ExternalLinkButton({ href, children, variant?, size?, className? })` (from `@/platform/ui/external-link-button`): renders an external anchor styled via `buttonClasses`, with a trailing `ExternalLink` icon and sr-only "(opens in a new tab)". Defaults: `variant="outline"`, `size="sm"`.

- [ ] **Step 1: Create the constants file**

`src/platform/external-links.ts`:

```ts
/**
 * External institution URLs. Hardcoded like the app's other Yale/YNHH
 * assumptions (SSO, Epic requests). Promote to configurable settings only if a
 * second deployment ever needs different values.
 */

/** Yale Workday Learning: where volunteers complete EHS and HIPAA training. */
export const WORKDAY_LEARNING_URL = "https://www.myworkday.com/yale/learning";

/** YNHH remote apps portal: where provisioned users launch Epic. */
export const EPIC_APPS_URL = "https://myapps.ynhh.org";
```

- [ ] **Step 2: Create the primitive**

`src/platform/ui/external-link-button.tsx`:

```tsx
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { buttonClasses } from "./button";

/**
 * An external link styled as a button. <Button> renders a <button> only, so
 * external CTAs are anchors; this centralizes the app's external-link
 * convention (target=_blank + rel + sr-only "opens in a new tab") so every one
 * looks and behaves the same.
 */
export function ExternalLinkButton({
  href,
  children,
  variant = "outline",
  size = "sm",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: Parameters<typeof buttonClasses>[0];
  size?: Parameters<typeof buttonClasses>[1];
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonClasses(variant, size, className)}
    >
      {children}
      <ExternalLink aria-hidden className="ml-1.5 h-3.5 w-3.5 shrink-0" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
```

- [ ] **Step 3: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass (no errors). Unused-export is fine; later tasks consume these.

- [ ] **Step 4: Commit**

```bash
git add src/platform/external-links.ts src/platform/ui/external-link-button.tsx
git commit -m "feat(ui): add external-link constants and ExternalLinkButton primitive"
```

---

### Task 3: EHS panel "Complete in Workday" CTA

**Files:**
- Modify: `src/modules/my-info/components/ehs-panel.tsx`

**Interfaces:**
- Consumes: `ExternalLinkButton`, `WORKDAY_LEARNING_URL`, `MyEhsItem` (existing)

- [ ] **Step 1: Add imports**

At the top of `src/modules/my-info/components/ehs-panel.tsx`, add below the existing imports:

```tsx
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { WORKDAY_LEARNING_URL } from "@/platform/external-links";
```

- [ ] **Step 2: Compute the outstanding flag and render the CTA**

In the non-empty branch (the `return (<Card>...</Card>)` after the `items.length === 0` guard), add the flag just before `return` and the CTA just before the closing `</Card>`. The full non-empty branch becomes:

```tsx
  const hasOutstanding = items.some((item) => !item.complete);
  return (
    <Card>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              {item.complete ? (
                <span className="text-success-foreground font-medium">Done</span>
              ) : (
                <span className="text-subtle-foreground">Needed</span>
              )}
              <span>{item.name}</span>
            </span>
            {item.complete && item.completedAt && (
              <span className="shrink-0 text-xs text-subtle-foreground">
                completed <DateOnly value={item.completedAt} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {hasOutstanding && (
        <div className="mt-4">
          <ExternalLinkButton href={WORKDAY_LEARNING_URL} variant="primary">
            Complete EHS training in Workday
          </ExternalLinkButton>
        </div>
      )}
    </Card>
  );
```

(The `items.length === 0` empty-state branch is unchanged: no link when no EHS is required.)

- [ ] **Step 3: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/my-info/components/ehs-panel.tsx
git commit -m "feat(my-info): link outstanding EHS training to Workday"
```

---

### Task 4: HIPAA panel "Complete in Workday" CTA

**Files:**
- Modify: `src/modules/my-info/components/hipaa-panel.tsx`

**Interfaces:**
- Consumes: `hipaaNeedsTrainingLink` (Task 1), `ExternalLinkButton` + `WORKDAY_LEARNING_URL` (Task 2), `status: ComplianceStatus` (existing prop)

- [ ] **Step 1: Add imports**

In `src/modules/my-info/components/hipaa-panel.tsx`, the existing import
`import { certExpiresAt } from "@/platform/compliance/rules";` becomes:

```tsx
import { certExpiresAt, hipaaNeedsTrainingLink } from "@/platform/compliance/rules";
```

And add below the existing imports:

```tsx
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { WORKDAY_LEARNING_URL } from "@/platform/external-links";
```

- [ ] **Step 2: Render the CTA in the Upload section**

In the "Upload form" block, immediately after the `<SectionHeader as="h3" className="mb-2">Upload New Certificate</SectionHeader>` line and before the `{error && (...)}` block, insert:

```tsx
        {hipaaNeedsTrainingLink(status) && (
          <div className="mb-3 space-y-2">
            <p className="text-sm text-foreground-soft">
              Complete or renew your HIPAA training in Workday, then upload the certificate below.
            </p>
            <ExternalLinkButton href={WORKDAY_LEARNING_URL} variant="primary">
              Complete HIPAA training in Workday
            </ExternalLinkButton>
          </div>
        )}
```

- [ ] **Step 3: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/my-info/components/hipaa-panel.tsx
git commit -m "feat(my-info): link outstanding HIPAA cert to Workday training"
```

---

### Task 5: Onboarding checklist EHS row CTA

**Files:**
- Modify: `src/app/get-started/onboarding-checklist.tsx`

**Interfaces:**
- Consumes: `ExternalLinkButton` + `WORKDAY_LEARNING_URL` (Task 2), existing `OnboardingTask`, `buttonClasses`

- [ ] **Step 1: Add imports**

In `src/app/get-started/onboarding-checklist.tsx`, add below the existing imports:

```tsx
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { WORKDAY_LEARNING_URL } from "@/platform/external-links";
```

- [ ] **Step 2: Rewrite `TaskRow` to add the EHS external CTA and correct the pill**

Replace the entire `TaskRow` function with:

```tsx
function TaskRow({ task }: { task: OnboardingTask }) {
  const Icon = ICON[task.key];
  const done = task.state === "COMPLETE" || task.state === "NOT_REQUIRED";
  // EHS is recorded by a coordinator (no internal href), but volunteers still
  // complete it in Workday, so it gets an external CTA and counts as actionable.
  const workdayHref = task.key === "ehs" ? WORKDAY_LEARNING_URL : null;
  const actionable = !!task.href || !!workdayHref;
  return (
    <li
      className={`flex items-center gap-4 rounded-2xl border p-4 shadow-sm ${
        done ? "border-border bg-muted" : "border-border bg-surface"
      }`}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
        style={{ ...hueStyle(task.key), background: "var(--mhbg)", color: "var(--mh)" }}
      >
        <Icon aria-hidden className="h-[22px] w-[22px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold tracking-tight text-foreground">{task.label}</span>
          <StatusPill state={task.state} actionable={actionable} />
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-foreground-soft">{task.description}</p>
      </div>
      {done ? (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check aria-hidden className="h-4 w-4" strokeWidth={3} />
        </span>
      ) : task.href ? (
        <Link href={task.href} className={buttonClasses(task.state === "INCOMPLETE" ? "primary" : "outline", "sm")}>
          {task.ctaLabel}
        </Link>
      ) : workdayHref ? (
        <ExternalLinkButton href={workdayHref} variant={task.state === "INCOMPLETE" ? "primary" : "outline"}>
          Complete in Workday
        </ExternalLinkButton>
      ) : null}
    </li>
  );
}
```

- [ ] **Step 3: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/get-started/onboarding-checklist.tsx
git commit -m "feat(onboarding): link the EHS checklist row to Workday"
```

---

### Task 6: Epic access card on the dashboard

**Files:**
- Create: `src/app/(app)/epic-access-card.tsx`
- Modify: `src/app/(app)/page.tsx` (import + render in the side rail)

**Interfaces:**
- Consumes: `EPIC_APPS_URL` (Task 2), `prisma`, `person.personId` (existing in `page.tsx`)
- Produces: `EpicAccessCard({ personId: string })`: async Server Component; renders the card only when `Person.epicId` is set, else `null`.

- [ ] **Step 1: Create the card component**

`src/app/(app)/epic-access-card.tsx`:

```tsx
import { ExternalLink, Stethoscope } from "lucide-react";
import { prisma } from "@/platform/db";
import { EPIC_APPS_URL } from "@/platform/external-links";

/**
 * Side-rail shortcut to the YNHH remote apps portal (Epic), shown only to
 * volunteers who have a provisioned Epic account (Person.epicId). Its own async
 * Server Component so a DB hiccup degrades to rendering nothing rather than
 * taking down the dashboard: this card is optional, so a render-path read
 * failure must never throw.
 */
export async function EpicAccessCard({ personId }: { personId: string }) {
  let epicId: string | null = null;
  try {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { epicId: true },
    });
    epicId = person?.epicId ?? null;
  } catch {
    return null;
  }
  if (!epicId) return null;

  return (
    <a
      href={EPIC_APPS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-2xl border border-brand/20 bg-brand-faint p-4 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand/15 bg-surface text-brand-fg">
        <Stethoscope aria-hidden className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-brand-fg">
          Access Epic
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium text-foreground-soft">
          YNHH remote apps
        </span>
        <span className="sr-only"> (opens in a new tab)</span>
      </span>
      <ExternalLink aria-hidden className="ml-auto h-4 w-4 shrink-0 text-brand-fg" />
    </a>
  );
}
```

- [ ] **Step 2: Import the card in the dashboard**

In `src/app/(app)/page.tsx`, add next to the existing `import { ClinicChannelCard } from "./clinic-channel-card";` (line 20):

```tsx
import { EpicAccessCard } from "./epic-access-card";
```

- [ ] **Step 3: Render the card in the side rail**

In `src/app/(app)/page.tsx`, in the side-rail `<aside>`, directly after the `ClinicChannelCard` `</Suspense>` (currently line 460) and before the `<Card>` "Your status" block, insert:

```tsx
          <EpicAccessCard personId={person.personId} />
```

Resulting order inside `<aside className="flex flex-col gap-4 lg:sticky lg:top-20">`:

```tsx
          <Suspense fallback={null}>
            <ClinicChannelCard />
          </Suspense>

          <EpicAccessCard personId={person.personId} />

          <Card>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-subtle-foreground">Your status</h3>
```

- [ ] **Step 4: Verify typecheck, lint, and build**

Run: `npm run typecheck && npm run lint`
Expected: both pass.
Run: `npm run build`
Expected: build succeeds (the new Server Component compiles; the dashboard route builds).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/epic-access-card.tsx" "src/app/(app)/page.tsx"
git commit -m "feat(dashboard): add an Access Epic shortcut for provisioned users"
```

---

## Final verification

- [ ] Run the full unit suite: `npm test`: all pass.
- [ ] `npm run typecheck`: clean.
- [ ] `npm run lint`: clean.
- [ ] `npm run build`: succeeds.

## Manual QA notes (not automated; e2e runs only in CI)

- As a user with an incomplete EHS training: `/my-info` EHS panel shows "Complete EHS training in Workday" → `https://www.myworkday.com/yale/learning`; `/get-started` EHS row shows "Complete in Workday" with an "Action needed" pill.
- As a user with no/expired HIPAA cert: `/my-info` and `/get-started/hipaa` show "Complete HIPAA training in Workday" in the upload section. A compliant or pending-verification user does not.
- As a user with `Person.epicId` set: the dashboard side rail shows the "Access Epic" card → `https://myapps.ynhh.org`. A user without `epicId` sees no card.
