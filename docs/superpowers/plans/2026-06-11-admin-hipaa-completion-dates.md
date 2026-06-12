# Admin-managed HIPAA completion dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move HIPAA certificate completion-date entry from self-service to compliance-manager-only, with date entry available in the master roster's CertificateViewer modal; setting a date also verifies the cert.

**Architecture:** A new platform helper validates a `YYYY-MM-DD` string into a noon-UTC `Date`. A new compliance service action `setCompletionDateAsManager` (gated by `volunteers.manage_compliance`) sets `completionDate`, `extraction=MANUAL`, and the verified stamp in one transaction plus a Person mirror enqueue and audit. The `CertificateViewer` client component gains an optional manager date-entry form; the master roster page wires a bound server action into it. All self-service date entry is removed.

**Tech Stack:** Next.js 16 (App Router, server actions), React 19, Prisma, Vitest (integration tests against a Postgres test DB).

---

## Context for the implementer

- **Worktree:** `.claude/worktrees/feat+admin-hipaa-completion-dates` on branch `feat/admin-hipaa-completion-dates`. Run all commands from there.
- **Spec:** `docs/superpowers/specs/2026-06-11-admin-hipaa-completion-dates-design.md`.
- **Tests** run against a dedicated Postgres test DB. If you have never run them in this worktree, run `npm run test:prepare` once (requires the docker `postgres` service up). A single test file runs with `npx vitest run <path>`.
- **Typecheck:** `npm run typecheck`. **Lint:** `npm run lint`.
- **No em-dashes in prose/UI strings** (project style). Use commas, parentheses, or colons.
- Audit (`recordAudit`) is fire-and-forget and must not block the response; follow the existing pattern in `verifyCertificate`.

### Key existing code references

- `HipaaCertificate` model: `prisma/schema.prisma` — fields `completionDate DateTime?`, `extraction` (`PARSED|MANUAL|AIRTABLE|NONE`), `verifiedById`, `verifiedAt`.
- Validation logic being lifted from: `src/modules/my-info/services/my-info.ts:345-431` (`setCertificateCompletionDate`, being removed).
- Permission helper: `can(personId, permission)` in `src/platform/rbac/engine.ts`.
- Error types in `src/modules/volunteers/services/compliance.ts`: `CertificateNotFoundError`, `ComplianceForbiddenError`.
- `enqueueMirror` from `@/platform/outbox`; `recordAudit` from `@/platform/audit`.
- Test helpers in `src/modules/volunteers/services/compliance.test.ts`: `createPerson`, `createCert(personId, completionDate, uploadedAt?)`, `grantPermission(personId, permission)`, `noon(y,m,d)`.

---

## File Structure

- **Create** `src/platform/compliance/completion-date.ts` — `parseCompletionDate(dateIso): Date` + `CompletionDateError`. One responsibility: validate/normalize a date string.
- **Create** `src/platform/compliance/completion-date.test.ts` — unit tests for the helper (no DB).
- **Modify** `src/modules/volunteers/services/compliance.ts` — add `setCompletionDateAsManager`.
- **Modify** `src/modules/volunteers/services/compliance.test.ts` — tests for the new action.
- **Modify** `src/modules/my-info/services/my-info.ts` — remove `setCertificateCompletionDate`.
- **Modify** `src/modules/my-info/services/my-info.test.ts` — remove tests for the deleted function.
- **Modify** `src/modules/my-info/components/certificate-viewer.tsx` — add manager date-entry props + footer form.
- **Modify** `src/modules/my-info/components/hipaa-panel.tsx` — remove the self date-entry form + related props.
- **Modify** `src/app/my-info/page.tsx` — remove `dateAction` and the props passed to `HipaaPanel`.
- **Modify** `src/app/get-started/hipaa/page.tsx` — remove `dateAction` and the props passed to `HipaaPanel`.
- **Modify** `src/app/volunteers/master/page.tsx` — wire `canEditDate` + bound `onSetDate` server action.
- **Modify** `src/app/volunteers/page.tsx` — pass `canEditDate={false}` to its `CertificateViewer` (explicit view-only).

---

## Task 1: `parseCompletionDate` helper

**Files:**
- Create: `src/platform/compliance/completion-date.ts`
- Test: `src/platform/compliance/completion-date.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/platform/compliance/completion-date.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCompletionDate, CompletionDateError } from "./completion-date";

describe("parseCompletionDate", () => {
  it("parses a valid date to noon UTC", () => {
    const d = parseCompletionDate("2025-06-01");
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(5); // June = 5
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(12);
  });

  it("rejects a malformed string", () => {
    expect(() => parseCompletionDate("06/01/2025")).toThrow(CompletionDateError);
  });

  it("rejects a calendar-overflow date (Feb 30)", () => {
    expect(() => parseCompletionDate("2025-02-30")).toThrow(CompletionDateError);
  });

  it("rejects a future date", () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(() => parseCompletionDate(`${nextYear}-01-01`)).toThrow(CompletionDateError);
  });

  it("rejects a date older than 5 years", () => {
    const old = new Date().getUTCFullYear() - 6;
    expect(() => parseCompletionDate(`${old}-01-01`)).toThrow(CompletionDateError);
  });

  it("exposes a reason on the error", () => {
    try {
      parseCompletionDate("not-a-date");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CompletionDateError);
      expect(typeof (err as CompletionDateError).reason).toBe("string");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/compliance/completion-date.test.ts`
Expected: FAIL — cannot resolve `./completion-date`.

- [ ] **Step 3: Write the helper**

Create `src/platform/compliance/completion-date.ts`:

```ts
/**
 * Validates and normalizes a user-entered HIPAA completion date.
 *
 * Rules (shared by every entry path): the string must be exactly YYYY-MM-DD,
 * a real calendar date, not in the future, and not older than 5 years. The
 * result is normalized to noon UTC to match the PDF parser convention, so a
 * date never shifts a day across time zones.
 */
export class CompletionDateError extends Error {
  constructor(public reason: string) {
    super(`Completion date validation failed: ${reason}`);
    this.name = "CompletionDateError";
  }
}

export function parseCompletionDate(dateIso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) {
    throw new CompletionDateError(`invalid date "${dateIso}"; expected YYYY-MM-DD format`);
  }

  const year = parseInt(match[1], 10);
  const month0 = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);

  const completionDate = new Date(Date.UTC(year, month0, day, 12, 0, 0, 0));

  // Reject calendar overflow (e.g. Feb 30 rolling into March).
  if (
    completionDate.getUTCFullYear() !== year ||
    completionDate.getUTCMonth() !== month0 ||
    completionDate.getUTCDate() !== day
  ) {
    throw new CompletionDateError(`invalid date "${dateIso}"`);
  }

  const now = new Date();
  if (completionDate.getTime() > now.getTime()) {
    throw new CompletionDateError("completion date cannot be in the future");
  }

  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear() - 5,
    now.getUTCMonth(),
    now.getUTCDate(),
    12, 0, 0, 0
  ));
  if (completionDate.getTime() < cutoff.getTime()) {
    throw new CompletionDateError("completion date is too old (older than 5 years)");
  }

  return completionDate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/compliance/completion-date.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/compliance/completion-date.ts src/platform/compliance/completion-date.test.ts
git commit -m "feat(compliance): add parseCompletionDate helper"
```

---

## Task 2: `setCompletionDateAsManager` service action

**Files:**
- Modify: `src/modules/volunteers/services/compliance.ts`
- Test: `src/modules/volunteers/services/compliance.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/volunteers/services/compliance.test.ts`. First add the imports the new block needs by extending the existing import from `./compliance` to include `setCompletionDateAsManager`, and add a `CompletionDateError` import:

```ts
// at the existing `from "./compliance"` import, add: setCompletionDateAsManager
// add near the other imports:
import { CompletionDateError } from "@/platform/compliance/completion-date";
```

Then append this describe block at the end of the file:

```ts
describe("setCompletionDateAsManager", () => {
  it("sets the date, marks MANUAL, and stamps verified in one action", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, null);

    const before = new Date();
    await setCompletionDateAsManager(actor.id, cert.id, "2025-06-01");
    const after = new Date();

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.completionDate?.toISOString()).toBe(
      new Date(Date.UTC(2025, 5, 1, 12, 0, 0, 0)).toISOString()
    );
    expect(updated.extraction).toBe("MANUAL");
    expect(updated.verifiedById).toBe(actor.id);
    expect(updated.verifiedAt).not.toBeNull();
    expect(updated.verifiedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updated.verifiedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("writes a compliance.set_date audit entry", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, null);

    await setCompletionDateAsManager(actor.id, cert.id, "2025-06-01");

    const log = await prisma.auditLog.findFirst({
      where: { action: "compliance.set_date", entityId: cert.id },
    });
    expect(log).not.toBeNull();
    expect(log?.actorPersonId).toBe(actor.id);
  });

  it("enqueues a Person mirror row for hipaaStatus", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, null);

    await setCompletionDateAsManager(actor.id, cert.id, "2025-06-01");

    const mirror = await prisma.outboxEvent.findFirst({
      where: { entityType: "Person", entityId: owner.id },
    });
    expect(mirror).not.toBeNull();
  });

  it("throws ComplianceForbiddenError for a non-manager actor", async () => {
    const actor = await createPerson("PlainDirector", "dir001"); // no manage_compliance grant
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, null);

    await expect(
      setCompletionDateAsManager(actor.id, cert.id, "2025-06-01")
    ).rejects.toBeInstanceOf(ComplianceForbiddenError);

    const unchanged = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(unchanged.completionDate).toBeNull();
  });

  it("throws CertificateNotFoundError when the cert does not exist", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");

    await expect(
      setCompletionDateAsManager(actor.id, "nonexistent-id", "2025-06-01")
    ).rejects.toBeInstanceOf(CertificateNotFoundError);
  });

  it("rejects setting a date that is already set", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, noon(2025, 1, 1));

    await expect(
      setCompletionDateAsManager(actor.id, cert.id, "2025-06-01")
    ).rejects.toBeInstanceOf(CompletionDateError);
  });

  it("rejects a future date", async () => {
    const actor = await createPerson("Manager", "mgr001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, null);
    const nextYear = new Date().getUTCFullYear() + 1;

    await expect(
      setCompletionDateAsManager(actor.id, cert.id, `${nextYear}-01-01`)
    ).rejects.toBeInstanceOf(CompletionDateError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/volunteers/services/compliance.test.ts -t setCompletionDateAsManager`
Expected: FAIL — `setCompletionDateAsManager` is not exported.

- [ ] **Step 3: Implement the action**

In `src/modules/volunteers/services/compliance.ts`, add these imports near the existing imports at the top:

```ts
import { can } from "@/platform/rbac/engine";
import { enqueueMirror } from "@/platform/outbox";
import { parseCompletionDate, CompletionDateError } from "@/platform/compliance/completion-date";
```

Then add this function (place it right after `verifyCertificate`):

```ts
// ---------------------------------------------------------------------------
// setCompletionDateAsManager
// ---------------------------------------------------------------------------

/**
 * Set a HIPAA certificate's completion date as a compliance manager.
 *
 * Only holders of `volunteers.manage_compliance` may call this (a master-key
 * check, NOT canViewCertificate: department directors do not get date entry).
 * Entry is set-once: a cert that already has a completionDate is rejected.
 *
 * Setting the date also verifies the cert (the manager read the PDF to get the
 * date), so completionDate, extraction=MANUAL, and the verified stamp are
 * written in one transaction alongside the Person mirror enqueue. Audits
 * "compliance.set_date" with before/after.
 *
 * Throws ComplianceForbiddenError (not a manager), CertificateNotFoundError
 * (no such cert), or CompletionDateError (already set, or invalid date).
 */
export async function setCompletionDateAsManager(
  actorPersonId: string,
  certId: string,
  dateIso: string
): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.manage_compliance"))) {
    throw new ComplianceForbiddenError(
      "Only compliance managers can set certificate completion dates."
    );
  }

  const cert = await prisma.hipaaCertificate.findUnique({ where: { id: certId } });
  if (!cert) throw new CertificateNotFoundError(certId);

  if (cert.completionDate !== null) {
    throw new CompletionDateError("completion date is already set");
  }

  // Validates format/future/5-year and normalizes to noon UTC. Throws CompletionDateError.
  const completionDate = parseCompletionDate(dateIso);
  const now = new Date();

  const before = { completionDate: null, extraction: cert.extraction };

  await prisma.$transaction(async (tx) => {
    await tx.hipaaCertificate.update({
      where: { id: cert.id },
      data: {
        completionDate,
        extraction: "MANUAL",
        verifiedById: actorPersonId,
        verifiedAt: now,
      },
    });

    await enqueueMirror(tx, {
      entityType: "Person",
      entityId: cert.personId,
      changedFields: ["hipaaStatus"],
    });
  });

  await recordAudit({
    actorPersonId,
    action: "compliance.set_date",
    entityType: "HipaaCertificate",
    entityId: cert.id,
    before,
    after: { completionDate, extraction: "MANUAL", verifiedById: actorPersonId, verifiedAt: now },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/volunteers/services/compliance.test.ts`
Expected: PASS (new block + all pre-existing compliance tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/modules/volunteers/services/compliance.ts src/modules/volunteers/services/compliance.test.ts
git commit -m "feat(compliance): add manager-only setCompletionDateAsManager"
```

---

## Task 3: Remove self-service date entry

This task deletes `setCertificateCompletionDate` and every caller/UI for it. After this task there is intentionally no way for a volunteer to enter their own date.

**Files:**
- Modify: `src/modules/my-info/services/my-info.ts`
- Modify: `src/modules/my-info/services/my-info.test.ts`
- Modify: `src/modules/my-info/components/hipaa-panel.tsx`
- Modify: `src/app/my-info/page.tsx`
- Modify: `src/app/get-started/hipaa/page.tsx`

- [ ] **Step 1: Remove the failing-after-removal tests first**

In `src/modules/my-info/services/my-info.test.ts`, find the `describe("setCertificateCompletionDate", ...)` block (and any import of `setCertificateCompletionDate` from `./my-info`) and delete the whole block and the unused import. Run:

`npx vitest run src/modules/my-info/services/my-info.test.ts`
Expected: PASS (remaining my-info tests green; no references to the removed function).

- [ ] **Step 2: Delete the service function**

In `src/modules/my-info/services/my-info.ts`, delete the entire `setCertificateCompletionDate` function (the export spanning roughly lines 333-431, including its doc comment). Leave `saveCertificate`, `CertificateValidationError`, and everything else intact. Do NOT remove `CertificateValidationError` — `saveCertificate` still uses it for file validation.

- [ ] **Step 3: Remove the My Info page wiring**

In `src/app/my-info/page.tsx`:
- Remove `setCertificateCompletionDate` from the import on line ~11.
- Delete the `dateAction` server function (lines ~114-128).
- In the `<HipaaPanel ... />` render (around line 215), remove the `dateAction`, `dateError`, and `dateSaved` props.
- If `CertificateValidationError` is now unused in this file after removing `dateAction`, remove its import too. (It may still be used by the upload `updateAction` catch — keep it if so.)

- [ ] **Step 4: Remove the onboarding-gate page wiring**

In `src/app/get-started/hipaa/page.tsx`, apply the same removals as Step 3: drop the `setCertificateCompletionDate` import, delete its `dateAction` server function, and remove the `dateAction`/`dateError`/`dateSaved` props from its `<HipaaPanel />`. Remove a now-unused `CertificateValidationError` import if applicable.

- [ ] **Step 5: Update the HipaaPanel component**

In `src/modules/my-info/components/hipaa-panel.tsx`:
- Remove `dateAction`, `dateError`, and `dateSaved` from the component's props type and its destructured parameter list.
- Remove the `needsDateEntry` constant and the entire date-entry `<form action={dateAction} ...>` block (the block around lines 110-134, including the surrounding "We could not read a completion date..." copy and the error/saved messages tied to it).
- Where a latest cert has no `completionDate`, leave the existing "Completion date needed" badge (the `getStatusBadge`/`Badge tone="default"` path) plus a short read-only line such as: `A compliance manager will confirm the completion date.` (no em-dashes). Do not render any input.
- Remove now-unused imports (`Input`, `Field`) if nothing else in the file uses them. Verify by searching the file before deleting.

- [ ] **Step 6: Typecheck and test**

Run: `npm run typecheck`
Expected: no errors (no dangling references to `setCertificateCompletionDate`, `dateAction`, etc.).

Run: `npx vitest run src/modules/my-info`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/my-info src/app/my-info/page.tsx src/app/get-started/hipaa/page.tsx
git commit -m "feat(hipaa): remove self-service completion-date entry"
```

---

## Task 4: CertificateViewer manager date entry

Add an optional date-entry form to the viewer modal. It renders only when `canEditDate` is true and the cert has no `completionDate`. The form calls a server action passed from the page that returns `{ error?: string }`; on success the component refreshes the route and closes.

**Files:**
- Modify: `src/modules/my-info/components/certificate-viewer.tsx`

- [ ] **Step 1: Rewrite the component with the new props + form**

Replace the entire contents of `src/modules/my-info/components/certificate-viewer.tsx` with:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { Modal } from "@/platform/ui/modal";
import { buttonClasses } from "@/platform/ui/button";
import { Field, Input } from "@/platform/ui/input";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
  /** The cert's current completion date, if any. Controls whether entry is offered. */
  completionDate?: Date | null;
  /** True only when the viewer holds volunteers.manage_compliance. Gates date entry. */
  canEditDate?: boolean;
  /** Bound server action: (dateIso) => result. Required for entry to render. */
  onSetDate?: (dateIso: string) => Promise<{ error?: string }>;
};

/**
 * "View" button that opens a modal previewing the certificate PDF inline. The
 * iframe is only mounted while the modal is open (so roster rows never each load
 * a PDF) and unmounts on close. Download / Open-in-new-tab are provided as
 * fallbacks for browsers that will not render PDFs in an iframe.
 *
 * When canEditDate is true, onSetDate is provided, and the cert has no
 * completion date, a date-entry form appears in the footer so a compliance
 * manager can record the date read off the PDF. Saving also verifies the cert.
 */
export function CertificateViewer({
  certId,
  fileName,
  ownerName,
  completionDate,
  canEditDate,
  onSetDate,
}: CertificateViewerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName}: ${fileName}` : fileName;

  const showDateEntry = Boolean(canEditDate && onSetDate && !completionDate);

  function handleSubmit(formData: FormData) {
    if (!onSetDate) return;
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    setError(null);
    startTransition(async () => {
      const result = await onSetDate(dateIso);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "sm", "gap-1.5")}
      >
        <Eye className="h-4 w-4" />
        View
      </button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          footer={
            <div className="flex w-full items-end justify-between gap-3">
              {showDateEntry ? (
                <form action={handleSubmit} className="flex items-end gap-2">
                  <Field label="Completion date">
                    <Input type="date" name="completionDate" required max={today} />
                  </Field>
                  <button
                    type="submit"
                    disabled={isPending}
                    className={buttonClasses("primary", "sm")}
                  >
                    {isPending ? "Saving..." : "Save and verify"}
                  </button>
                </form>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <a
                  href={inlineHref}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses("ghost", "sm")}
                >
                  Open in new tab
                </a>
                <a href={downloadHref} className={buttonClasses("outline", "sm")}>
                  Download
                </a>
              </div>
            </div>
          }
        >
          {error && (
            <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
          <iframe
            src={inlineHref}
            title={`Certificate preview: ${fileName}`}
            className="h-[75vh] w-full rounded-lg border border-slate-200"
          />
        </Modal>
      )}
    </>
  );
}
```

Note: the footer markup changed from a fragment to a flex container. Confirm the `Modal` footer accepts arbitrary nodes (it renders `footer` as-is) — it does, per `src/platform/ui/modal.tsx`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Existing callers pass only `certId`/`fileName`/`ownerName`; the new props are optional, so they still compile.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors in the changed file.

- [ ] **Step 4: Commit**

```bash
git add src/modules/my-info/components/certificate-viewer.tsx
git commit -m "feat(hipaa): add manager date entry to CertificateViewer"
```

---

## Task 5: Wire the master roster

**Files:**
- Modify: `src/app/volunteers/master/page.tsx`

- [ ] **Step 1: Add imports**

In `src/app/volunteers/master/page.tsx`, add to the imports:

```ts
import { setCompletionDateAsManager, CertificateNotFoundError } from "@/modules/volunteers/services/compliance";
import { CompletionDateError } from "@/platform/compliance/completion-date";
import { ComplianceForbiddenError } from "@/modules/volunteers/services/compliance";
import { revalidatePath } from "next/cache";
```

If `masterCompliance` is already imported from `@/modules/volunteers/services/compliance`, merge the new named imports into that existing import statement instead of duplicating it.

- [ ] **Step 2: Define the bound server action inside the page component**

The page is an async server component that already calls `requirePermission("volunteers.manage_compliance")` (the result is `viewer`). Add this server action inside the component body, before the `return`:

```tsx
async function setDateAction(certId: string, dateIso: string): Promise<{ error?: string }> {
  "use server";
  const actor = await requirePermission("volunteers.manage_compliance");
  try {
    await setCompletionDateAsManager(actor.personId, certId, dateIso);
  } catch (err) {
    if (err instanceof CompletionDateError) return { error: err.reason };
    if (err instanceof ComplianceForbiddenError) return { error: err.message };
    if (err instanceof CertificateNotFoundError) return { error: "Certificate not found." };
    throw err;
  }
  revalidatePath("/volunteers/master");
  return {};
}
```

(`requirePermission` returns a `PersonSession` whose person id is `.personId` — same shape as the existing `viewer` on line ~92. Re-call `requirePermission` inside the action as shown rather than closing over the render-time `viewer`, so the permission is re-checked freshly on the POST.)

- [ ] **Step 3: Pass the new props into the row's CertificateViewer**

Find the `<CertificateViewer .../>` render (around lines 322-326) and replace it with:

```tsx
<CertificateViewer
  certId={row.cert.id}
  fileName={row.cert.fileName}
  ownerName={row.person.name}
  completionDate={row.cert.completionDate}
  canEditDate
  onSetDate={setDateAction.bind(null, row.cert.id)}
/>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`.bind(null, certId)` yields `(dateIso: string) => Promise<{ error?: string }>`, matching the prop.)

- [ ] **Step 5: Build check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/volunteers/master/page.tsx
git commit -m "feat(hipaa): wire manager date entry into master roster"
```

---

## Task 6: Keep the department roster view-only

The department page (`src/app/volunteers/page.tsx`) must not offer date entry. Make that explicit so a future refactor does not accidentally turn it on.

**Files:**
- Modify: `src/app/volunteers/page.tsx`

- [ ] **Step 1: Find the CertificateViewer render**

Run: `grep -n "CertificateViewer" src/app/volunteers/page.tsx`
Expected: a `<CertificateViewer ... />` usage (director view).

- [ ] **Step 2: Pass canEditDate={false} explicitly**

On that `<CertificateViewer />`, add the prop `canEditDate={false}`. Do not pass `onSetDate`. Leave `certId`, `fileName`, `ownerName` as they are. This is documentation-as-code: directors view and verify, but never set dates.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/volunteers/page.tsx
git commit -m "chore(hipaa): make department roster cert viewer explicitly view-only"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: all tests pass. Pay attention to `compliance.test.ts`, `completion-date.test.ts`, and `my-info` tests.

- [ ] **Step 4: Confirm self-service entry is truly gone**

Run: `grep -rn "setCertificateCompletionDate\|my-info.certificate_date" src` (excluding any matches you intentionally kept).
Expected: no matches in `src` (the function and its action name are removed). If `my-info.certificate_date` still appears only in a historical migration/comment, note it; it must not appear in live code paths.

- [ ] **Step 5: Manual smoke test (optional but recommended)**

Start the dev server (`npm run dev`) and, as a `volunteers.manage_compliance` user, open `/volunteers/master`, click View on a member whose cert has no completion date, enter a date, click "Save and verify". Confirm the row then shows the completion date, an expiry date, and a "verified by" stamp. Confirm `/my-info` no longer shows a date-entry form.

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(hipaa): verification fixes for admin completion dates"
```

---

## Self-Review notes (for the implementer)

- The spec's "inline in the master roster row" requirement is satisfied by the existing per-row View button opening the modal where the date form lives — there is intentionally no separate inline input (per the approved design).
- `extraction` stays `MANUAL` for manager entry; there is no separate enum value (audit + `verifiedById` distinguish who entered it).
- The "set-once" guard (`completionDate !== null` rejected) means re-setting a wrong date is out of scope; if a manager needs to correct a date later, that is a future enhancement, not part of this plan.
