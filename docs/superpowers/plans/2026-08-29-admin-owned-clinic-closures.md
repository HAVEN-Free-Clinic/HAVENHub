# Admin-Owned Clinic Closures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the right to declare a clinic date closed from Faculty Relations (`schedule.manage_attendings`) to admins (`admin.manage_terms`), edited in Admin > Terms.

**Architecture:** A new `setClinicDayClosure` lands beside `upsertClinicDay` in the schedule builder service, guarded internally on `admin.manage_terms`. Admin > Terms gains per-date closure editing. The attendings Day view becomes read-only for closure, `upsertClinicDay` drops the two fields from its options type so the compiler enforces the boundary, and the workbook importer stops writing closure. No schema change and no migration — `ClinicDay.isClosed` and `ClinicDay.closedNote` are untouched.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma, PostgreSQL, Vitest (integration tests against a per-worker database clone), Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-29-admin-owned-clinic-closures-design.md`

## Global Constraints

- **No schema change.** Do not touch `prisma/schema.prisma` and do not create a migration. `ClinicDay.isClosed` and `ClinicDay.closedNote` keep their current shape.
- **No new permission.** Closure is guarded by the existing `admin.manage_terms`.
- **Closure semantics from PR #685 are unchanged.** A closed date stays fully assignable, the weekly reminder still sends with a closed notice, check-in and attendance stay off. This plan changes *who declares* a closure, never what happens after one.
- **Existing closure readers must not be modified.** `closedClinicDates`, `resolveOpenClinicDate`, `shift-reminders.ts`, the builder banner and the full schedule all keep working untouched. If a task needs to change one of them, stop — the design leaked.
- **Guard convention.** `src/modules/schedule/services/builder.ts` enforces permissions internally per mutation. Admin *pages* additionally call `requirePermission`. Both layers apply.
- **Run tests with:** `npx vitest run <file>` (single file) or `npm run test:related -- <file>`. The full suite is `npm test` (~170s).
- **Never run `prisma migrate`, `prisma db push`, or seed scripts.** The repo's `.env` `DATABASE_URL` points at the production Neon branch. `npm run dev` pins the local database explicitly and is safe; direct Prisma commands are not.

---

### Task 1: `setClinicDayClosure` service

Additive only. Nothing calls it yet, so the tree stays green.

**Files:**
- Modify: `src/modules/schedule/services/builder.ts` (add after `upsertClinicDay`, which ends near line 800)
- Test: `src/modules/schedule/services/builder.test.ts`

**Interfaces:**
- Consumes: existing module-locals in `builder.ts` — `loadEditableTerm`, `dateKeyToNoonUtc` (line 633), `auditSelect` (line 905), `auditShape` (line 925), `BuilderForbiddenError`, `BuilderValidationError`, `can`, `recordAudit`, `isoDateKey`.
- Produces: `setClinicDayClosure(actor: string, opts: { termId: string; dateKey: string; isClosed: boolean; closedNote?: string | null }): Promise<void>` — used by Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/schedule/services/builder.test.ts`. Put this `describe` immediately after the existing `describe("upsertClinicDay", ...)` block closes. It defines its own `adminSetup` because the existing `clinicSetup` grants `schedule.manage_attendings`, which is exactly the permission that must NOT work here.

```ts
describe("setClinicDayClosure", () => {
  /** An actor holding admin.manage_terms — the term-calendar grant, not the FR one. */
  async function adminSetup() {
    const admin = await createPerson("Terms Admin");
    const role = await prisma.role.create({
      data: {
        name: `r-${Date.now()}-${Math.random()}`,
        isSystem: false,
        grants: { create: [{ permission: "admin.manage_terms" }] },
      },
    });
    await prisma.roleAssignment.create({
      data: { roleId: role.id, personId: admin.id, termId: null },
    });
    return { admin };
  }

  it("refuses an actor without admin.manage_terms", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const nobody = await createPerson("Nobody");

    await expect(
      setClinicDayClosure(nobody.id, {
        termId: term.id,
        dateKey: isoDateKey(dates[0]),
        isClosed: true,
      })
    ).rejects.toThrow(BuilderForbiddenError);
  });

  it("refuses a Faculty Relations actor holding only schedule.manage_attendings", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { fcrl } = await clinicSetup();

    await expect(
      setClinicDayClosure(fcrl.id, {
        termId: term.id,
        dateKey: isoDateKey(dates[0]),
        isClosed: true,
      })
    ).rejects.toThrow(BuilderForbiddenError);
  });

  it("creates a ClinicDay row for a date that has none", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { admin } = await adminSetup();

    expect(await prisma.clinicDay.count({ where: { termId: term.id } })).toBe(0);

    await setClinicDayClosure(admin.id, {
      termId: term.id,
      dateKey: isoDateKey(dates[0]),
      isClosed: true,
      closedNote: "HAVEN FREE CLINIC CLOSED",
    });

    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.isClosed).toBe(true);
    expect(day.closedNote).toBe("HAVEN FREE CLINIC CLOSED");
  });

  it("leaves slots, on call and specialty standing", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { morning, derm, fcrl } = await clinicSetup();
    const { admin } = await adminSetup();
    const peggy = await prisma.attending.create({
      data: { scheduleName: "Peggy", fullName: "Peggy" },
    });
    const key = { termId: term.id, dateKey: isoDateKey(dates[0]) };

    await upsertClinicDay(fcrl.id, {
      ...key,
      attendingsBySlot: { [morning.id]: [peggy.id] },
      specialtyId: derm.id,
      directorName: "Patel",
    });

    await setClinicDayClosure(admin.id, { ...key, isClosed: true });

    const day = await prisma.clinicDay.findFirstOrThrow({
      where: { termId: term.id },
      include: { attendings: true },
    });
    expect(day.isClosed).toBe(true);
    expect(day.specialtyId).toBe(derm.id);
    expect(day.directorName).toBe("Patel");
    expect(day.attendings).toHaveLength(1);
  });

  it("drops the reason when the closure is cleared", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { admin } = await adminSetup();
    const key = { termId: term.id, dateKey: isoDateKey(dates[0]) };

    await setClinicDayClosure(admin.id, { ...key, isClosed: true, closedNote: "Thanksgiving" });
    await setClinicDayClosure(admin.id, { ...key, isClosed: false });

    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.isClosed).toBe(false);
    // A reason that outlived its closure would surface on a day that is running.
    expect(day.closedNote).toBeNull();
  });

  it("normalises a blank reason to null", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { admin } = await adminSetup();

    await setClinicDayClosure(admin.id, {
      termId: term.id,
      dateKey: isoDateKey(dates[0]),
      isClosed: true,
      closedNote: "   ",
    });

    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.closedNote).toBeNull();
  });

  it("rejects an unparseable date key", async () => {
    const term = await createTerm(sixSaturdays());
    const { admin } = await adminSetup();

    await expect(
      setClinicDayClosure(admin.id, { termId: term.id, dateKey: "not-a-date", isClosed: true })
    ).rejects.toThrow(BuilderValidationError);
  });
});
```

Add `setClinicDayClosure` to the existing import block at the top of the test file (the one that already imports `upsertClinicDay` from `./builder`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "setClinicDayClosure"`
Expected: FAIL — `setClinicDayClosure is not a function` / import error.

- [ ] **Step 3: Implement `setClinicDayClosure`**

Add to `src/modules/schedule/services/builder.ts`, directly after `upsertClinicDay`:

```ts
/**
 * Declare or clear a clinic date's closure.
 *
 * Closure is a CALENDAR fact -- a holiday, a break week -- so it is owned by
 * admin.manage_terms, the same grant that owns Term.clinicDates, and NOT by the
 * Faculty Relations grant that owns everything else on this row. Faculty
 * Relations still reads closures to staff around them; they no longer declare
 * one.
 *
 * It lives here rather than in the admin module because every ClinicDay write
 * belongs under this file's internal-guard convention, and it needs this file's
 * dateKeyToNoonUtc and audit helpers. Splitting one field's write into a module
 * whose services trust their callers would leave ClinicDay guarded two ways.
 */
export async function setClinicDayClosure(
  actor: string,
  opts: {
    termId: string;
    dateKey: string;
    isClosed: boolean;
    /** Ignored when isClosed is false: a cleared closure drops its reason. */
    closedNote?: string | null;
  }
): Promise<void> {
  if (!(await can(actor, "admin.manage_terms"))) {
    throw new BuilderForbiddenError("You do not manage the term calendar.");
  }

  const term = await loadEditableTerm(opts.termId);

  // A date the term does not list is still accepted, matching upsertClinicDay:
  // the calendar and the day rows drift, and refusing here would make a closure
  // impossible to clear after a date was removed from the term.
  const listed = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  const clinicDate = listed ?? dateKeyToNoonUtc(opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a valid date.`);
  }

  const dayFields = {
    isClosed: opts.isClosed,
    // Cleared with the closure it explained, and blank text is no reason at all.
    closedNote: opts.isClosed ? opts.closedNote?.trim() || null : null,
  };

  const where = { termId_clinicDate: { termId: term.id, clinicDate } };
  const before = await prisma.clinicDay.findUnique({ where, select: auditSelect });
  const after = await prisma.clinicDay.upsert({
    where,
    create: { termId: term.id, clinicDate, ...dayFields },
    update: dayFields,
    select: auditSelect,
  });

  await recordAudit({
    actorPersonId: actor,
    action: "admin.clinic_day_closure",
    entityType: "ClinicDay",
    entityId: `${term.id}|${opts.dateKey}`,
    ...(before && { before: auditShape(before) }),
    after: auditShape(after),
  });
}
```

Note: `auditSelect`, `auditShape` and `dateKeyToNoonUtc` are declared *below* this point in the file. That is fine — `function` declarations and `const` used inside a function body are resolved at call time, and `upsertClinicDay` already does exactly this.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "setClinicDayClosure"`
Expected: PASS, 7 tests.

Then confirm nothing else broke: `npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Update the test file's header comment**

The file opens with a "Test matrix:" block. Add a line under the `upsertClinicDay` entry:

```
 *   setClinicDayClosure: admin.manage_terms ok; FR actor and stranger rejected; creates a
 *     row; preserves staffing; clears the note with the closure; blank note null.
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/services/builder.ts src/modules/schedule/services/builder.test.ts
git commit -m "feat(schedule): add admin-guarded setClinicDayClosure"
```

---

### Task 2: Closure editing in Admin > Terms

**Files:**
- Modify: `src/modules/admin/components/clinic-dates-editor.tsx`
- Modify: `src/app/(app)/admin/terms/[id]/page.tsx`

**Interfaces:**
- Consumes: `setClinicDayClosure` from Task 1.
- Produces: a `closureAction(formData: FormData)` server action on the term page; `ClinicDatesEditor` gains a `closures` prop and a `closureAction` prop, both consumed only by that page.

- [ ] **Step 1: Load closure state on the term page**

`ClinicDatesEditor` renders from `term.clinicDates`, which carries no closure, so the page must fetch the `ClinicDay` rows and merge by date key.

In `src/app/(app)/admin/terms/[id]/page.tsx`, after the existing `const term = await prisma.term.findUnique({...})` (near line 43) and its `notFound()` guard, add:

```ts
// Closure lives on ClinicDay, not on Term.clinicDates, so the editor needs both.
// Rows are sparse -- a term routinely has more clinic dates than day rows -- so
// a missing entry means "open", not "missing data".
const clinicDayRows = await prisma.clinicDay.findMany({
  where: { termId: id },
  select: { clinicDate: true, isClosed: true, closedNote: true },
});
const closures: Record<string, { isClosed: boolean; closedNote: string | null }> =
  Object.fromEntries(
    clinicDayRows.map((r) => [
      isoDateKey(r.clinicDate),
      { isClosed: r.isClosed, closedNote: r.closedNote },
    ])
  );
```

Add `import { isoDateKey } from "@/platform/dates";` if the file does not already import it.

- [ ] **Step 2: Add the closure server action**

In the same file, beside `clinicDatesAction` (near line 101):

```ts
/** Declare or clear one date's closure. Admin owns closure; Faculty Relations reads it. */
async function closureAction(formData: FormData) {
  "use server";
  const actorSession = await requirePermission("admin.manage_terms");
  const dateKey = String(formData.get("dateKey") ?? "");
  // Safe to read a missing field as "open" here, unlike the attendings form
  // this replaces: that one shared a single form across the whole day, so an
  // absent isClosed could not be told from a form that never rendered the
  // control. This form is per-date and always renders it, so unchecked is
  // unambiguously open.
  const isClosed = formData.get("isClosed") === "on";
  const closedNote = String(formData.get("closedNote") ?? "");

  try {
    await setClinicDayClosure(actorSession.personId, {
      termId: id,
      dateKey,
      isClosed,
      closedNote,
    });
  } catch (err) {
    const message =
      err instanceof BuilderValidationError || err instanceof BuilderForbiddenError
        ? err.message
        : "Failed to update the closure.";
    redirect(`/admin/terms/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/admin/terms/${id}?saved=1`);
}
```

Add the imports:

```ts
import {
  setClinicDayClosure,
  BuilderValidationError,
  BuilderForbiddenError,
} from "@/modules/schedule/services/builder";
```

- [ ] **Step 3: Pass the new props to the editor**

Change the existing `<ClinicDatesEditor .../>` call (near line 235) to:

```tsx
<ClinicDatesEditor
  termId={id}
  clinicDates={term.clinicDates}
  saturdayIsos={saturdayIsos}
  updateAction={clinicDatesAction}
  closures={closures}
  closureAction={closureAction}
/>
```

- [ ] **Step 4: Render the closure controls**

In `src/modules/admin/components/clinic-dates-editor.tsx`, extend the props type:

```ts
type ClinicDatesEditorProps = {
  termId: string;
  clinicDates: Date[];
  /** ISO date strings for all Saturdays between startDate and endDate. */
  saturdayIsos: string[];
  /** Server action: receives FormData with "dates" (JSON array) and "termId". */
  updateAction: (formData: FormData) => Promise<void>;
  /** Closure by ISO date key. A missing entry means the date is open. */
  closures: Record<string, { isClosed: boolean; closedNote: string | null }>;
  /** Server action: receives "dateKey", "isClosed" and "closedNote". */
  closureAction: (formData: FormData) => Promise<void>;
};
```

Destructure `closures` and `closureAction` in the signature, then replace the per-date row inside `clinicDates.map(...)` with:

```tsx
{clinicDates.map((d, idx) => {
  // Remaining dates after removing this one.
  const remaining = currentIsos.filter((_, i) => i !== idx);
  const iso = toIsoDate(d);
  const closure = closures[iso];
  const isClosed = closure?.isClosed ?? false;
  return (
    <div key={iso} className="flex flex-wrap items-center gap-3 py-1">
      <span className="w-52 text-sm">{formatClinicDate(d)}</span>

      {/* Closure is a calendar fact and is owned here, not by Faculty
          Relations. The date stays in the term either way: a closed
          Saturday is still staffable (departments run triage on one). */}
      <form action={closureAction} className="flex items-center gap-2">
        <input type="hidden" name="dateKey" value={iso} />
        <label className="flex items-center gap-1.5 text-sm text-foreground-soft">
          <Checkbox name="isClosed" defaultChecked={isClosed} />
          Closed
        </label>
        <Input
          type="text"
          name="closedNote"
          defaultValue={closure?.closedNote ?? ""}
          placeholder="Reason (optional)"
          aria-label={`Closure reason for ${formatClinicDate(d)}`}
          className="w-56"
        />
        <Button type="submit" variant="outline" size="sm">
          Save
        </Button>
      </form>

      <form action={updateAction}>
        <input type="hidden" name="termId" value={termId} />
        <HiddenDatesField dates={remaining} />
        <ConfirmButton
          label="Remove"
          confirmLabel="Remove this date? Any shifts and pending requests on it are cleared."
        />
      </form>
    </div>
  );
})}
```

Add `import { Checkbox } from "@/platform/ui/checkbox";` to the file's imports.

- [ ] **Step 5: Update the component's header comment**

The file's doc comment lists "Three operations". Replace that list with four, adding:

```
 *  - Set or clear a date's closure, with an optional reason (posts to closureAction)
```

and note underneath:

```
 * Closure is owned by admin.manage_terms, the same grant as the dates
 * themselves. It is stored on ClinicDay rather than on Term, so the page reads
 * those rows and passes them in as `closures`.
```

- [ ] **Step 6: Verify it typechecks and the suite is clean**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/components/clinic-dates-editor.tsx "src/app/(app)/admin/terms/[id]/page.tsx"
git commit -m "feat(admin): own clinic closures in Admin > Terms"
```

---

### Task 3: Attendings Day view goes read-only

After this task nothing in the schedule module sends closure, which is what makes Task 4 safe.

**Files:**
- Modify: `src/modules/schedule/components/attending-day-view.tsx`
- Modify: `src/app/(app)/schedule/attendings/page.tsx`

**Interfaces:**
- Consumes: `row.storedClosed`, `row.isClosed`, `row.closedNote` from `attendingSchedule` — all already present on the row type, no service change needed.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the checkbox with a statement**

In `src/modules/schedule/components/attending-day-view.tsx`, replace the whole `{row.isClinicDate ? (...) : (...)}` block (the `<label>` holding `closedMarker` and the `Checkbox`, around lines 82-97) with:

```tsx
{row.isClosed ? (
  // Read-only: closure is a calendar fact owned by admin.manage_terms and set
  // in Admin > Terms. Faculty Relations must still SEE it -- a closed Saturday
  // is still staffed for triage -- so it is stated here rather than hidden.
  <span className="text-sm text-warning">
    Clinic closed
    {row.closedNote ? ` — ${row.closedNote}` : ""}
  </span>
) : null}
```

- [ ] **Step 2: Point people at the owner**

Immediately below the existing `{!row.isClinicDate && (<Alert tone="info">...)}` block, add a sibling for a date the term *does* list but that is closed:

```tsx
{row.isClinicDate && row.storedClosed && (
  <Alert tone="warning">
    <strong>The clinic is closed this date.</strong>{" "}
    {row.closedNote ?? "No reason was recorded."} Departments can still be
    scheduled for it. Closures are set in Admin &gt; Terms.
  </Alert>
)}
```

`clinicalEditable` already reads `!row.storedClosed`, so the day's clinical controls stay disabled with no change.

- [ ] **Step 3: Stop the action writing closure**

In `src/app/(app)/schedule/attendings/page.tsx`, inside `saveDayAction`, delete these three lines from the `upsertClinicDay` call:

```ts
          ...(formData.has("isClosed") || formData.has("closedMarker")
            ? { isClosed: formData.get("isClosed") === "on" }
            : {}),
```

- [ ] **Step 4: Mark closed dates in the date strip**

This is the gap PR #685 left: the builder and full schedule pass `closedKeys`, the attendings page never did — on the one screen that links to closure.

In the same file, change the `<ClinicDateStrip ... />` call (near line 439) to:

```tsx
<ClinicDateStrip
  dates={schedule.rows.map((r) => r.clinicDate)}
  selectedKey={selectedDateKey}
  closedKeys={schedule.rows.filter((r) => r.isClosed).map((r) => r.dateKey)}
  hrefFor={(key) => attendingViewHref(BASE, { ...hrefParams, date: key }, "day")}
  ariaLabel="Clinic dates"
/>
```

`schedule.rows` is already loaded and each row already carries `isClosed` and `dateKey`, so this needs no extra query.

- [ ] **Step 5: Update the page's doc comment**

The file's header comment describes the Day view. Add:

```
 * Closure is READ-ONLY here. It is a calendar fact owned by admin.manage_terms
 * and set in Admin > Terms; this page shows it so the schedule can be staffed
 * around it.
```

- [ ] **Step 6: Test that the Day view states the closure and offers no control**

`attending-day-view.tsx` has no test file yet. Create `src/modules/schedule/components/attending-day-view.test.tsx`, following the pattern already used by `clinic-date-strip.test.tsx` in the same directory (`renderToStaticMarkup`, no DOM):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttendingDayView } from "./attending-day-view";
import type { AttendingScheduleRow } from "@/modules/schedule/services/attendings";

function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function row(over: Partial<AttendingScheduleRow> = {}): AttendingScheduleRow {
  return {
    dateKey: "2026-09-05",
    clinicDate: d(2026, 9, 5),
    isClinicDate: true,
    isClosed: false,
    storedClosed: false,
    closedNote: null,
    onCallAttendingId: null,
    onCallName: null,
    specialtyId: null,
    directorName: null,
    proceduresBooked: null,
    slots: [],
    ...over,
  } as AttendingScheduleRow;
}

function render(r: AttendingScheduleRow) {
  return renderToStaticMarkup(
    <AttendingDayView
      row={r}
      slots={[]}
      specialties={[]}
      options={[]}
      termId="t1"
      termName="Fall 2026"
      editable
      saveAction={async () => {}}
    />,
  );
}

describe("AttendingDayView closure", () => {
  it("offers no closure control, even to an editor", () => {
    // Closure is owned by admin.manage_terms and set in Admin > Terms.
    const out = render(row({ storedClosed: true, isClosed: true }));
    expect(out).not.toContain('name="isClosed"');
    expect(out).not.toContain('name="closedMarker"');
  });

  it("states the closure and its reason, and names the owner", () => {
    const out = render(
      row({ storedClosed: true, isClosed: true, closedNote: "Thanksgiving" }),
    );
    expect(out).toContain("Clinic closed");
    expect(out).toContain("Thanksgiving");
    expect(out).toContain("Admin &gt; Terms");
  });

  it("says a reason was not recorded rather than going silent", () => {
    const out = render(row({ storedClosed: true, isClosed: true, closedNote: null }));
    expect(out).toContain("No reason was recorded.");
  });

  it("says nothing about closure on an open date", () => {
    const out = render(row());
    expect(out).not.toContain("Clinic closed");
  });
});
```

If the real `AttendingScheduleRow` has fields this fixture omits, add them — do not loosen the type to `any`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/modules/schedule/components/attending-day-view.test.tsx`
Expected: PASS, 4 tests.

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run src/modules/schedule/services/attendings.test.ts`
Expected: PASS. `attendingSchedule` is unchanged, so this is a guard against accidental edits.

- [ ] **Step 8: Commit**

```bash
git add src/modules/schedule/components/attending-day-view.tsx src/modules/schedule/components/attending-day-view.test.tsx "src/app/(app)/schedule/attendings/page.tsx"
git commit -m "feat(schedule): show closures read-only on the attendings day view"
```

---

### Task 4: Close the door on `upsertClinicDay`

Removes the fields from the options type so the compiler, not a convention, keeps the schedule module out of closure. Safe now: Task 3 removed the only caller that passed them.

**Files:**
- Modify: `src/modules/schedule/services/builder.ts`
- Test: `src/modules/schedule/services/builder.test.ts`

**Interfaces:**
- Produces: `upsertClinicDay` options type no longer has `isClosed` or `closedNote`. Nothing downstream depends on their absence beyond the compiler.

- [ ] **Step 1: Replace the old closure test**

In `src/modules/schedule/services/builder.test.ts`, delete the `it("marks a date closed", ...)` test (near line 1356) — Task 1 already covers that behaviour against the correct service. Replace it with:

```ts
  it("does not let a Faculty Relations actor reach closure", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const { fcrl } = await clinicSetup();
    const key = { termId: term.id, dateKey: isoDateKey(dates[0]) };

    // Closure is not in the options type. Cast past it to prove the service
    // ignores it even when a caller forces the field through at runtime.
    await upsertClinicDay(fcrl.id, {
      ...key,
      directorName: "Patel",
      ...({ isClosed: true, closedNote: "sneaked in" } as object),
    } as Parameters<typeof upsertClinicDay>[1]);

    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.isClosed).toBe(false);
    expect(day.closedNote).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts -t "does not let a Faculty Relations actor reach closure"`
Expected: FAIL — `isClosed` is still honoured, so `day.isClosed` is `true`.

- [ ] **Step 3: Remove the fields**

In `src/modules/schedule/services/builder.ts`, in the `upsertClinicDay` options type, delete these two lines:

```ts
    isClosed?: boolean;
    closedNote?: string | null;
```

Then find where `dayFields` is assembled in that function and remove the `isClosed` and `closedNote` entries from it, so neither reaches the upsert.

Add to the function's doc comment:

```
 * Closure is NOT settable here. isClosed and closedNote are owned by
 * admin.manage_terms through setClinicDayClosure; see that function for why.
```

Leave `auditSelect` and `auditShape` alone — the audit diff should still *report* closure even though this path cannot change it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/schedule/services/builder.test.ts`
Expected: PASS, whole file.

Run: `npm run typecheck`
Expected: no errors. A failure here means a caller still passes closure — find it and remove the field rather than restoring the type.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/services/builder.ts src/modules/schedule/services/builder.test.ts
git commit -m "refactor(schedule)!: upsertClinicDay no longer accepts closure"
```

---

### Task 5: Importer stops writing closure

**Files:**
- Modify: `src/platform/attendings/import/schedule.ts`
- Test: `src/platform/attendings/import/schedule.test.ts`

**Interfaces:**
- Produces: `ParsedScheduleRow` loses `isClosed` and `closedNote`; `ScheduleImportReport` loses `closedDays`. The `CLOSED` regex is kept as a skip.

**Note on this file:** `schedule.test.ts` is currently pure-unit — it imports only `normaliseLabel`, `parseTermSchedule` and `splitNames`, and never touches the database. This task adds the first DB-backed test to it, so it also adds the `prisma` / `resetDb` imports and a `beforeEach`. `runTermScheduleImport` takes a **parse**, not a workbook: build one with the file's existing `sheet()` helper and `parseTermSchedule`.

- [ ] **Step 1: Write the regression test**

This is the most valuable test in the plan — it pins the silent revert that made the importer unsafe once admins own closure.

Add to the top of `src/platform/attendings/import/schedule.test.ts`:

```ts
import { beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runTermScheduleImport } from "./schedule";
```

and extend the existing value import to `import { normaliseLabel, parseTermSchedule, splitNames, runTermScheduleImport } from "./schedule";` rather than importing the module twice.

Then append this block at the end of the file:

```ts
describe("runTermScheduleImport closure", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** Noon-UTC anchored, matching how the schema stores clinicDate. */
  function d(year: number, month: number, day: number): Date {
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  }

  it("leaves an admin's closure standing across a re-import", async () => {
    const clinicDate = d(2026, 6, 6);
    const term = await prisma.term.create({
      data: {
        code: `SU26-${Date.now()}-${Math.random()}`,
        name: "Summer 2026",
        startDate: d(2026, 5, 30),
        endDate: d(2026, 9, 26),
        status: "ACTIVE",
        clinicDates: [clinicDate],
      },
    });

    // An admin closed this date in Admin > Terms.
    await prisma.clinicDay.create({
      data: {
        termId: term.id,
        clinicDate,
        isClosed: true,
        closedNote: "Thanksgiving",
      },
    });

    // The sheet carries NO closed marker. Before this change the importer wrote
    // isClosed: false unconditionally, silently re-opening the date.
    const parse = parseTermSchedule(sheet(["June"], ["6"]), { startYear: 2026 });
    await runTermScheduleImport(parse, { termId: term.id, dryRun: false });

    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.isClosed).toBe(true);
    expect(day.closedNote).toBe("Thanksgiving");
  });

  it("does not close a date just because the sheet says closed", async () => {
    const clinicDate = d(2026, 6, 6);
    const term = await prisma.term.create({
      data: {
        code: `SU26-${Date.now()}-${Math.random()}`,
        name: "Summer 2026",
        startDate: d(2026, 5, 30),
        endDate: d(2026, 9, 26),
        status: "ACTIVE",
        clinicDates: [clinicDate],
      },
    });

    const parse = parseTermSchedule(
      sheet(["June"], ["6", "", "(HAVEN FREE CLINIC CLOSED)"]),
      { startYear: 2026 },
    );
    await runTermScheduleImport(parse, { termId: term.id, dryRun: false });

    // Closure originates from an admin, never from an import.
    const day = await prisma.clinicDay.findFirstOrThrow({ where: { termId: term.id } });
    expect(day.isClosed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/attendings/import/schedule.test.ts -t "leaves an admin's closure standing"`
Expected: FAIL — `day.isClosed` is `false`, because the update branch overwrote it.

- [ ] **Step 3: Stop parsing the marker into the row**

In `src/platform/attendings/import/schedule.ts`, in `ParsedScheduleRow`, delete:

```ts
  isClosed: boolean;
  closedNote: string | null;
```

In the row initialiser (near line 116), delete the matching `isClosed: false,` and `closedNote: null,` entries.

Replace the marker branch (near line 130) with:

```ts
      // A closed marker describes the whole day and is not an attending name,
      // so it is still SKIPPED -- otherwise "(HAVEN FREE CLINIC CLOSED)" would
      // be read as a person in whatever column it sits in. It is no longer
      // recorded: closure is owned by admin.manage_terms and set in
      // Admin > Terms, never as a side effect of an import.
      if (CLOSED.test(raw)) continue;
```

Keep the `const CLOSED = /closed/i;` declaration at line 32.

- [ ] **Step 4: Stop writing closure**

In the same file, in the `tx.clinicDay.upsert` call (near line 353), delete `isClosed: row.isClosed,` and `closedNote: row.closedNote,` from **both** the `create` and the `update` branches. `create` then relies on the schema default `isClosed = false`, which is correct for a day row the importer is creating.

- [ ] **Step 5: Drop the now-meaningless `closedDays` report field**

The report counts days the sheet marked closed, which the importer no longer acts on. Reporting a number it did not write would be a lie.

In `src/platform/attendings/import/schedule.ts`:
- Delete `closedDays: number;` from `ScheduleImportReport` (line 177).
- Delete `closedDays: 0,` from the report initialiser (line 210).
- Delete the line `if (row.isClosed) report.closedDays++;` (line 341).

In `scripts/import-attending-schedule.ts`, delete line 69:

```ts
  console.log(`days marked closed:  ${report.closedDays}`);
```

This is the only consumer, so no other caller breaks.

- [ ] **Step 6: Fix the parse test that asserted the old fields**

The existing test near line 106 asserts `parse.rows[0].isClosed` and `.closedNote`. Those fields no longer exist. Replace its two assertions with one proving the marker is not mistaken for a name:

```ts
  // The marker is skipped, not recorded and not read as an attending.
  expect(parse.rows[0].bySlotLabel).toEqual({});
```

Keep the surrounding `sheet([...])` fixture as-is — it is the case that would regress.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/platform/attendings/import/schedule.test.ts`
Expected: PASS, whole file.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/platform/attendings/import/schedule.ts src/platform/attendings/import/schedule.test.ts scripts/import-attending-schedule.ts
git commit -m "feat(attendings): stop the workbook import writing closure"
```

---

### Task 6: Documentation and full-suite verification

**Files:**
- Modify: `docs/scheduling.md`

- [ ] **Step 1: Correct the scheduling doc**

`docs/scheduling.md` has a "Closed clinic days" section (added by PR #685) whose first paragraph says the flag is "set from the attending Day view or by the workbook importer". Both halves are now wrong. Replace that paragraph with:

```markdown
A Saturday the clinic is not running is stored as a flag on the `ClinicDay` row
(`isClosed`, with an optional `closedNote`), declared by an admin in
Admin > Terms alongside the term's clinic dates. Closure is a calendar fact and
is owned by `admin.manage_terms`, the same grant that owns `Term.clinicDates` --
not by `schedule.manage_attendings`, which owns the rest of the row. The
attending Day view shows closures read-only, and the workbook importer does not
write them. The date stays in `Term.clinicDates`.
```

In the bullet list further down that section, change the attendings bullet so it no longer implies the flag is set there, and add the admin bullet:

```markdown
- Admin > Terms is where a closure is declared or cleared, with its reason.
- The attending Day view states the closure and its reason, read-only.
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS. Takes roughly 170s.

If anything outside the files this plan touched fails, stop and report it rather than adjusting the test — per the Global Constraints, the closure readers were supposed to be untouched, and a failure there means the design leaked.

- [ ] **Step 3: Lint and build**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add docs/scheduling.md
git commit -m "docs(schedule): closures are declared in Admin > Terms"
```

---

## Post-implementation: operational follow-ups

These are **not code changes** and are not part of any task above. They are recorded because the feature does not function in production without them. Hand them to the user; do not attempt them from a plan executor.

1. **`Faculty Relations Manager` is missing `schedule.view` in production.** `system-roles.ts` grants `["schedule.view", "schedule.manage_attendings"]`; the live row has only the latter. The schedule module gates on `schedule.view` with no `additionalAccessPermissions`, so anyone assigned that role today is redirected to `/no-access`. System roles are seeded once by a frozen bootstrap migration with no reconcile, so this will not self-heal.
2. **No one is assigned to any closure-capable role.** Faculty Relations Manager, RHD and Executive Director all have zero people. Before this change, closure depended on a single `*` holder; after it, it still does.
3. **Granting `admin.manage_terms` alone is not enough.** The Admin module gates on `admin.access` with no `additionalAccessPermissions`, so a role meant to close dates needs both grants — the same trap as (1).
