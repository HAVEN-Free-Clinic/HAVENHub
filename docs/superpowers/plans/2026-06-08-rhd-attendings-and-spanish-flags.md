# RHD Attending Editor + Spanish/RN Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Person.spanishSpeaking`/`licensedRN` editable in the people admin and visible per-person in the schedule builder, and let schedule managers edit the RHD attending roster + capabilities (admin page under `/schedule` + quick-add from the readiness panel).

**Architecture:** Next.js App Router (server components + server actions), Prisma. Phase 1 extends the existing person edit path (`src/platform/people.ts` → admin form/table) and adds badges in the builder. Phase 2 adds a new `attendings` schedule service (modeled on `upsertRhdClinic`), a `/schedule/attendings` CRUD page gated by `requireModuleAccess("schedule")` with mutations enforcing RHD-manager scope, and a quick-add in the readiness panel. No schema migration — all columns already exist.

**Tech Stack:** Next.js, React, Prisma/Postgres, Tailwind, Vitest (services, test DB `havenhub_test`), Playwright (e2e). Gates: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`. Run from the worktree `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/pr-11-caprice` (node_modules/.env symlinked). NOTE: `npm run build` fails only at page-data collection on `/admin/people` due to missing Graph email env vars — a pre-existing, environment-only failure; treat the compile+typecheck stage passing as success. `npm test` has 5 pre-existing failing files from the same Graph config issue — ignore those; the people/attendings service tests are unaffected.

**Spec:** `docs/superpowers/specs/2026-06-08-rhd-attendings-and-spanish-flags-design.md`

---

## File Structure

Phase 1:
- **Modify** `src/platform/people.ts` — `PersonInput` + `updatePersonFields` accept `spanishSpeaking`/`licensedRN`.
- **Modify** `src/platform/people.test.ts` — cover the new fields.
- **Modify** `src/modules/admin/components/person-form.tsx` — two checkboxes.
- **Modify** `src/app/admin/people/[id]/page.tsx` — read the checkboxes in `updateAction`.
- **Modify** `src/modules/admin/components/people-table.tsx` — `ES`/`RN` chips.
- **Modify** `src/app/schedule/builder/page.tsx` — per-person `ES`/`RN` badges.

Phase 2:
- **Modify** `src/modules/schedule/services/builder.ts` — `export` `RHD_CODES`.
- **Create** `src/modules/schedule/services/attendings.ts` — CRUD service.
- **Create** `src/modules/schedule/services/attendings.test.ts` — service tests.
- **Create** `src/modules/schedule/components/attending-form.tsx` — add/edit form.
- **Create** `src/app/schedule/attendings/page.tsx` — list.
- **Create** `src/app/schedule/attendings/[id]/page.tsx` — edit.
- **Create** `src/app/schedule/attendings/new/page.tsx` — create.
- **Modify** `src/platform/modules/registry.ts` — schedule nav link.
- **Modify** `src/modules/schedule/components/readiness-panel.tsx` — quick-add + manage link.
- **Modify** `src/app/schedule/builder/page.tsx` — `addAttendingAction`, pass to `ReadinessPanel`.

---

# PHASE 1 — Spanish & RN flags

### Task 1: Person service accepts spanishSpeaking / licensedRN

**Files:**
- Modify: `src/platform/people.ts`
- Test: `src/platform/people.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/platform/people.test.ts`, inside the `describe("updatePersonFields", ...)` block, add:

```typescript
  it("persists spanishSpeaking and licensedRN and audits only the changed flag", async () => {
    const person = await createPersonRecord(ACTOR, { name: "Flagged" });
    expect(person.spanishSpeaking).toBe(false);
    expect(person.licensedRN).toBe(false);
    await prisma.auditLog.deleteMany();
    await prisma.outbox.deleteMany();

    const updated = await updatePersonFields(ACTOR, person.id, { spanishSpeaking: true });
    expect(updated.spanishSpeaking).toBe(true);
    expect(updated.licensedRN).toBe(false);

    // Only the changed flag is audited; these flags are not mirrored to Airtable.
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.outbox.count()).toBe(0);
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- src/platform/people.test.ts -t "spanishSpeaking and licensedRN"`
Expected: FAIL — `updated.spanishSpeaking` is still `false` (the service ignores keys not in its `fields` list).

- [ ] **Step 3: Add the fields to `PersonInput` and the diff list**

In `src/platform/people.ts`, extend the `PersonInput` type (currently ends at `gradYear`):

```typescript
export type PersonInput = {
  name: string;
  netId?: string | null;
  contactEmail?: string | null;
  phone?: string | null;
  epicId?: string | null;
  yaleAffiliation?: string | null;
  gradYear?: string | null;
  spanishSpeaking?: boolean;
  licensedRN?: boolean;
};
```

In `updatePersonFields`, add the two keys to the `fields` array:

```typescript
  const fields: Array<keyof PersonInput> = [
    "name",
    "netId",
    "contactEmail",
    "phone",
    "epicId",
    "yaleAffiliation",
    "gradYear",
    "spanishSpeaking",
    "licensedRN",
  ];
```

No other change is needed: `normalize` spreads `...input` so booleans pass through untouched; the diff loop uses `data[key] ?? null` (a `false` value compares correctly because `false ?? null` is `false`); and these keys are absent from `MIRRORED_FIELDS` (they are not in `ALL_PEOPLE_FIELDS`), so no Airtable mirror is enqueued.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- src/platform/people.test.ts`
Expected: PASS (all existing `people.test.ts` tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/platform/people.ts src/platform/people.test.ts
git commit -m "feat(people): allow editing spanishSpeaking and licensedRN"
```

---

### Task 2: Person edit form checkboxes

**Files:**
- Modify: `src/modules/admin/components/person-form.tsx`
- Modify: `src/app/admin/people/[id]/page.tsx`

- [ ] **Step 1: Add the two flags to the PersonForm props and render checkboxes**

In `src/modules/admin/components/person-form.tsx`, extend the `person` prop's `Pick` to include the flags:

```typescript
  person?: Pick<
    Person,
    | "name"
    | "netId"
    | "contactEmail"
    | "phone"
    | "epicId"
    | "yaleAffiliation"
    | "gradYear"
    | "spanishSpeaking"
    | "licensedRN"
  >;
```

Then, inside the `<form>`, immediately after the closing `</div>` of the `grid gap-4 sm:grid-cols-2` block (before the submit-button `div`), add:

```tsx
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="spanishSpeaking"
            defaultChecked={person?.spanishSpeaking ?? false}
            className="h-4 w-4 rounded accent-brand"
          />
          Spanish-speaking
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="licensedRN"
            defaultChecked={person?.licensedRN ?? false}
            className="h-4 w-4 rounded accent-brand"
          />
          Licensed RN
        </label>
      </div>
```

- [ ] **Step 2: Read the checkboxes in `updateAction`**

In `src/app/admin/people/[id]/page.tsx`, extend the `updatePerson` call inside `updateAction` (an unchecked checkbox is absent from `formData`, so compare to `"on"`):

```typescript
    await updatePerson(actorSession.personId, id, {
      name: (formData.get("name") as string) ?? "",
      netId: (formData.get("netId") as string) || null,
      contactEmail: (formData.get("contactEmail") as string) || null,
      phone: (formData.get("phone") as string) || null,
      epicId: (formData.get("epicId") as string) || null,
      yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
      gradYear: (formData.get("gradYear") as string) || null,
      spanishSpeaking: formData.get("spanishSpeaking") === "on",
      licensedRN: formData.get("licensedRN") === "on",
    });
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck + lint pass. (Build stops at the known `/admin/people` Graph-env error during page-data collection — acceptable; confirm no NEW errors about `person-form` or `spanishSpeaking`.)

- [ ] **Step 4: Commit**

```bash
git add src/modules/admin/components/person-form.tsx "src/app/admin/people/[id]/page.tsx"
git commit -m "feat(admin): edit Spanish-speaking and Licensed RN on the person form"
```

---

### Task 3: ES / RN chips in the people list

**Files:**
- Modify: `src/modules/admin/components/people-table.tsx`

`searchPeople` does `prisma.person.findMany` with no `select`, so each `Person` row already includes `spanishSpeaking`/`licensedRN`. No service change needed.

- [ ] **Step 1: Add a Flags column header**

In `src/modules/admin/components/people-table.tsx`, in the `<THead>` `<TR>`, add a header before `<TH>Status</TH>`:

```tsx
          <TH>Flags</TH>
```

- [ ] **Step 2: Render ES/RN chips per row**

In the row `<TR>`, add a cell before the Status `<TD>`:

```tsx
            <TD>
              <span className="flex flex-wrap gap-1">
                {person.spanishSpeaking && <Badge tone="default">ES</Badge>}
                {person.licensedRN && <Badge tone="default">RN</Badge>}
              </span>
            </TD>
```

(`Badge` is already imported in this file.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck + lint pass; no new errors (same known build stop).

- [ ] **Step 4: Commit**

```bash
git add src/modules/admin/components/people-table.tsx
git commit -m "feat(admin): show ES/RN chips in the people list"
```

---

### Task 4: Per-person ES / RN badges in the schedule builder

**Files:**
- Modify: `src/app/schedule/builder/page.tsx`

`BuilderMember.person` already includes `spanishSpeaking` and `licensedRN`, so no service change.

- [ ] **Step 1: Add a `flagBadges` helper next to `assignCard`**

In `src/app/schedule/builder/page.tsx`, immediately above the `assignCard` function, add:

```tsx
  function flagBadges(person: { spanishSpeaking: boolean; licensedRN: boolean }) {
    if (!person.spanishSpeaking && !person.licensedRN) return null;
    return (
      <>
        {person.spanishSpeaking && <Badge tone="default">ES</Badge>}
        {person.licensedRN && <Badge tone="default">RN</Badge>}
      </>
    );
  }
```

- [ ] **Step 2: Render badges in `assignCard`**

In `assignCard`, in the header row, add the badges right after the Director/Volunteer `<Badge>` (before the `{!available && <Badge tone="warning">not free</Badge>}` line):

```tsx
          {flagBadges(member.person)}
```

- [ ] **Step 3: Render badges on the Assigned Directors card**

In the assigned **Directors** map, replace the name span line:

```tsx
                          <span className="text-sm font-bold text-slate-800">{name}</span>
```

with:

```tsx
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-slate-800">{name}</span>
                            {m?.person && flagBadges(m.person)}
                          </span>
```

- [ ] **Step 4: Render badges on the Assigned Volunteers card**

In the assigned **Volunteers** map, the name appears as `<span className="font-medium text-slate-800">{name}</span>` inside a `flex flex-wrap items-center gap-2 text-sm` row that also renders conflicts. Add the badges right after that name span:

```tsx
                            {m?.person && flagBadges(m.person)}
```

- [ ] **Step 5: Render badges on the Assigned Shadows card**

In the assigned **Shadows** map, the card renders `<span className="text-sm font-medium text-slate-700">{name}</span>` directly inside a `flex items-center justify-between` div. Wrap the name + badges:

```tsx
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-slate-700">{name}</span>
                            {m?.person && flagBadges(m.person)}
                          </span>
```

(Replace the existing standalone shadow name span with the block above.)

- [ ] **Step 6: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck + lint pass; no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/schedule/builder/page.tsx
git commit -m "feat(schedule): show per-person ES/RN badges in the builder"
```

---

# PHASE 2 — RHD attending editor

### Task 5: Attendings service + tests

**Files:**
- Modify: `src/modules/schedule/services/builder.ts` (export `RHD_CODES`)
- Create: `src/modules/schedule/services/attendings.ts`
- Create: `src/modules/schedule/services/attendings.test.ts`

- [ ] **Step 1: Export `RHD_CODES` from builder.ts**

In `src/modules/schedule/services/builder.ts`, change:

```typescript
const RHD_CODES = new Set(["SCTS", "JCTS", "CCRH"]);
```

to:

```typescript
export const RHD_CODES = new Set(["SCTS", "JCTS", "CCRH"]);
```

- [ ] **Step 2: Write the failing service tests**

Create `src/modules/schedule/services/attendings.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listAttendings,
  createAttending,
  updateAttending,
  setAttendingActive,
  AttendingValidationError,
  AttendingForbiddenError,
} from "./attendings";

const ACTOR = "actor-1";

async function rhdManager() {
  await prisma.person.create({ data: { id: ACTOR, name: "RHD Director" } });
  await prisma.department.upsert({ where: { code: "SCTS" }, update: {}, create: { code: "SCTS", name: "SCTS Dept" } });
  // schedule.edit_all makes every department manageable, including SCTS.
  const role = await prisma.role.create({
    data: { name: `r-${Date.now()}`, isSystem: false, grants: { create: [{ permission: "schedule.edit_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: ACTOR, termId: null } });
}

beforeEach(resetDb);

describe("createAttending", () => {
  it("creates an attending with capabilities defaulting to unknown", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    expect(a.scheduleName).toBe("Rivera");
    expect(a.iudIn).toBe("unknown");
    expect(a.isActive).toBe(true);
  });

  it("applies provided capabilities", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, {
      scheduleName: "Chen",
      fullName: "Dr. Chen",
      capabilities: { iudIn: "yes", gac: "no" },
    });
    expect(a.iudIn).toBe("yes");
    expect(a.gac).toBe("no");
    expect(a.emb).toBe("unknown");
  });

  it("rejects a duplicate scheduleName", async () => {
    await rhdManager();
    await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    await expect(
      createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Other" }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an invalid capability value", async () => {
    await rhdManager();
    await expect(
      createAttending(ACTOR, { scheduleName: "X", fullName: "Y", capabilities: { iudIn: "maybe" as never } }),
    ).rejects.toBeInstanceOf(AttendingValidationError);
  });

  it("rejects an actor who manages no RHD department", async () => {
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    await expect(
      createAttending(ACTOR, { scheduleName: "Z", fullName: "Z" }),
    ).rejects.toBeInstanceOf(AttendingForbiddenError);
  });
});

describe("updateAttending", () => {
  it("patches only provided fields", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    const u = await updateAttending(ACTOR, a.id, { capabilities: { iudIn: "yes" }, notes: "fast" });
    expect(u.iudIn).toBe("yes");
    expect(u.notes).toBe("fast");
    expect(u.scheduleName).toBe("Rivera");
  });
});

describe("setAttendingActive", () => {
  it("toggles isActive", async () => {
    await rhdManager();
    const a = await createAttending(ACTOR, { scheduleName: "Rivera", fullName: "Dr. Rivera" });
    const u = await setAttendingActive(ACTOR, a.id, false);
    expect(u.isActive).toBe(false);
    const list = await listAttendings();
    expect(list.find((x) => x.id === a.id)?.isActive).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npm test -- src/modules/schedule/services/attendings.test.ts`
Expected: FAIL — module `./attendings` does not exist.

- [ ] **Step 4: Implement the service**

Create `src/modules/schedule/services/attendings.ts`:

```typescript
/**
 * RHD attending roster service.
 *
 * The readiness panel reads each attending's six procedure capabilities. This
 * service lets schedule managers maintain the roster. Mutations require the
 * actor to manage an RHD-family department (same scope as upsertRhdClinic).
 */

import type { RhdAttending } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { manageableScheduleDepartmentIds, RHD_CODES } from "./builder";

export type CapabilityValue = "yes" | "no" | "unknown";
export const CAPABILITY_KEYS = ["iudIn", "iudOut", "nexplanon", "gac", "emb", "seesMale"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export class AttendingForbiddenError extends Error {
  constructor(message = "Actor does not manage any RHD-family department.") {
    super(message);
    this.name = "AttendingForbiddenError";
  }
}

export class AttendingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendingValidationError";
  }
}

async function assertRhdManager(actor: string): Promise<void> {
  const manageable = await manageableScheduleDepartmentIds(actor);
  const rhdDepts = await prisma.department.findMany({
    where: { code: { in: [...RHD_CODES] } },
    select: { id: true },
  });
  const rhdIds = new Set(rhdDepts.map((d) => d.id));
  if (!manageable.some((id) => rhdIds.has(id))) throw new AttendingForbiddenError();
}

function validCapability(v: unknown): CapabilityValue {
  if (v === "yes" || v === "no" || v === "unknown") return v;
  throw new AttendingValidationError(`Invalid capability value: ${String(v)}`);
}

export function listAttendings(): Promise<RhdAttending[]> {
  return prisma.rhdAttending.findMany({ orderBy: { scheduleName: "asc" } });
}

export function getAttending(id: string): Promise<RhdAttending | null> {
  return prisma.rhdAttending.findUnique({ where: { id } });
}

type CapabilityInput = Partial<Record<CapabilityKey, CapabilityValue>>;

export async function createAttending(
  actor: string,
  input: { scheduleName: string; fullName: string; capabilities?: CapabilityInput; notes?: string | null },
): Promise<RhdAttending> {
  await assertRhdManager(actor);
  const scheduleName = input.scheduleName.trim();
  const fullName = input.fullName.trim();
  if (!scheduleName) throw new AttendingValidationError("Schedule name is required.");
  if (!fullName) throw new AttendingValidationError("Full name is required.");

  const caps: Record<CapabilityKey, CapabilityValue> = {
    iudIn: "unknown", iudOut: "unknown", nexplanon: "unknown", gac: "unknown", emb: "unknown", seesMale: "unknown",
  };
  for (const k of CAPABILITY_KEYS) {
    if (input.capabilities && k in input.capabilities) caps[k] = validCapability(input.capabilities[k]);
  }

  const existing = await prisma.rhdAttending.findUnique({ where: { scheduleName } });
  if (existing) throw new AttendingValidationError(`An attending named "${scheduleName}" already exists.`);

  const created = await prisma.rhdAttending.create({
    data: { scheduleName, fullName, ...caps, notes: input.notes ?? null },
  });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_create",
    entityType: "RhdAttending",
    entityId: created.id,
    after: { scheduleName, fullName, ...caps },
  });
  return created;
}

export async function updateAttending(
  actor: string,
  id: string,
  patch: { scheduleName?: string; fullName?: string; capabilities?: CapabilityInput; notes?: string | null; isActive?: boolean },
): Promise<RhdAttending> {
  await assertRhdManager(actor);
  const existing = await prisma.rhdAttending.findUnique({ where: { id } });
  if (!existing) throw new AttendingValidationError("Attending not found.");

  const data: Record<string, unknown> = {};
  if (patch.scheduleName !== undefined) {
    const sn = patch.scheduleName.trim();
    if (!sn) throw new AttendingValidationError("Schedule name is required.");
    if (sn !== existing.scheduleName) {
      const dup = await prisma.rhdAttending.findUnique({ where: { scheduleName: sn } });
      if (dup) throw new AttendingValidationError(`An attending named "${sn}" already exists.`);
    }
    data.scheduleName = sn;
  }
  if (patch.fullName !== undefined) {
    const fn = patch.fullName.trim();
    if (!fn) throw new AttendingValidationError("Full name is required.");
    data.fullName = fn;
  }
  if (patch.capabilities) {
    for (const k of CAPABILITY_KEYS) {
      if (k in patch.capabilities) data[k] = validCapability(patch.capabilities[k]);
    }
  }
  if ("notes" in patch) data.notes = patch.notes ?? null;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  const updated = await prisma.rhdAttending.update({ where: { id }, data });
  await recordAudit({
    actorPersonId: actor,
    action: "schedule.attending_update",
    entityType: "RhdAttending",
    entityId: id,
    before: existing,
    after: updated,
  });
  return updated;
}

export async function setAttendingActive(actor: string, id: string, isActive: boolean): Promise<RhdAttending> {
  return updateAttending(actor, id, { isActive });
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npm test -- src/modules/schedule/services/attendings.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/schedule/services/attendings.ts src/modules/schedule/services/attendings.test.ts src/modules/schedule/services/builder.ts
git commit -m "feat(schedule): RHD attending roster service with RHD-manager scope"
```

---

### Task 6: `/schedule/attendings` pages + form

**Files:**
- Create: `src/modules/schedule/components/attending-form.tsx`
- Create: `src/app/schedule/attendings/page.tsx`
- Create: `src/app/schedule/attendings/new/page.tsx`
- Create: `src/app/schedule/attendings/[id]/page.tsx`

- [ ] **Step 1: Create the AttendingForm component**

Create `src/modules/schedule/components/attending-form.tsx`:

```tsx
/**
 * AttendingForm: server component for creating/editing an RhdAttending.
 * Bound to a server action; capabilities are yes/no/unknown selects.
 */

import type { RhdAttending } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";
import { CAPABILITY_KEYS } from "@/modules/schedule/services/attendings";

const CAPABILITY_LABELS: Record<(typeof CAPABILITY_KEYS)[number], string> = {
  iudIn: "IUD In",
  iudOut: "IUD Out",
  nexplanon: "Nexplanon",
  gac: "GAC",
  emb: "EMB",
  seesMale: "Sees Male",
};

type AttendingFormProps = {
  action: (formData: FormData) => Promise<void>;
  attending?: RhdAttending;
  error?: string;
};

export function AttendingForm({ action, attending, error }: AttendingFormProps) {
  return (
    <form action={action} className="space-y-6">
      {error && (
        <p role="alert" className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Schedule name">
          <Input name="scheduleName" defaultValue={attending?.scheduleName ?? ""} required placeholder="Rivera" />
        </Field>
        <Field label="Full name">
          <Input name="fullName" defaultValue={attending?.fullName ?? ""} required placeholder="Dr. Rivera" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {CAPABILITY_KEYS.map((key) => (
          <Field key={key} label={CAPABILITY_LABELS[key]}>
            <Select name={key} defaultValue={(attending?.[key] as string) ?? "unknown"}>
              <option value="yes">yes</option>
              <option value="no">no</option>
              <option value="unknown">unknown</option>
            </Select>
          </Field>
        ))}
      </div>

      <Field label="Notes">
        <Input name="notes" defaultValue={attending?.notes ?? ""} placeholder="Optional" />
      </Field>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="isActive" defaultChecked={attending?.isActive ?? true} className="h-4 w-4 rounded accent-brand" />
        Active
      </label>

      <Button type="submit" variant="primary">Save</Button>
    </form>
  );
}
```

- [ ] **Step 2: Create the list page**

Create `src/app/schedule/attendings/page.tsx`:

```tsx
import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { listAttendings, CAPABILITY_KEYS } from "@/modules/schedule/services/attendings";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { buttonClasses } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";

export default async function AttendingsListPage() {
  await requireModuleAccess("schedule");
  const attendings = await listAttendings();

  return (
    <div className="space-y-6">
      <PageHeader title="RHD Attendings" />
      <div>
        <Link href="/schedule/attendings/new" className={buttonClasses("primary", "sm")}>
          Add attending
        </Link>
      </div>
      {attendings.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500">
          No attendings yet.
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              {CAPABILITY_KEYS.map((k) => (
                <TH key={k}>{k}</TH>
              ))}
              <TH>Active</TH>
              <TH></TH>
            </TR>
          </THead>
          <tbody>
            {attendings.map((a) => (
              <TR key={a.id}>
                <TD>
                  <span className="font-medium text-slate-800">{a.scheduleName}</span>
                  <span className="block text-xs text-slate-400">{a.fullName}</span>
                </TD>
                {CAPABILITY_KEYS.map((k) => (
                  <TD key={k} className="text-slate-500 text-xs">{a[k] as string}</TD>
                ))}
                <TD>{a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}</TD>
                <TD>
                  <Link href={`/schedule/attendings/${a.id}`} className="text-brand hover:underline text-sm">Edit</Link>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create the "new" page**

Create `src/app/schedule/attendings/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { createAttending, CAPABILITY_KEYS, AttendingValidationError, AttendingForbiddenError, type CapabilityValue } from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewAttendingPage({ searchParams }: PageProps) {
  await requireModuleAccess("schedule");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("schedule");
    const capabilities = Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [k, (formData.get(k) as string) as CapabilityValue]),
    );
    try {
      await createAttending(session.personId, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        capabilities,
        notes: (formData.get("notes") as string) || null,
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Add attending" />
      <AttendingForm action={createAction} error={error} />
    </div>
  );
}
```

- [ ] **Step 4: Create the edit page**

Create `src/app/schedule/attendings/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { getAttending, updateAttending, CAPABILITY_KEYS, AttendingValidationError, AttendingForbiddenError, type CapabilityValue } from "@/modules/schedule/services/attendings";
import { AttendingForm } from "@/modules/schedule/components/attending-form";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function EditAttendingPage({ params, searchParams }: PageProps) {
  await requireModuleAccess("schedule");
  const { id } = await params;
  const { error } = await searchParams;
  const attending = await getAttending(id);
  if (!attending) notFound();

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("schedule");
    const capabilities = Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [k, (formData.get(k) as string) as CapabilityValue]),
    );
    try {
      await updateAttending(session.personId, id, {
        scheduleName: (formData.get("scheduleName") as string) ?? "",
        fullName: (formData.get("fullName") as string) ?? "",
        capabilities,
        notes: (formData.get("notes") as string) || null,
        isActive: formData.get("isActive") === "on",
      });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(`/schedule/attendings/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/schedule/attendings");
  }

  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${attending.scheduleName}`} />
      <AttendingForm action={updateAction} attending={attending} error={error} />
    </div>
  );
}
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck + lint pass; no new errors (same known build stop). Fix any import path errors before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/schedule/components/attending-form.tsx src/app/schedule/attendings
git commit -m "feat(schedule): /schedule/attendings CRUD pages for the RHD roster"
```

---

### Task 7: Schedule nav link

**Files:**
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Add the nav entry**

In `src/platform/modules/registry.ts`, in the `schedule` module's `nav` array (currently My schedule / Full schedule / Builder), add:

```typescript
      { label: "Attendings", href: "/schedule/attendings" },
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/platform/modules/registry.ts
git commit -m "feat(schedule): add Attendings to the schedule nav"
```

---

### Task 8: Quick-add + "Manage attendings" in the readiness panel

**Files:**
- Modify: `src/modules/schedule/components/readiness-panel.tsx`
- Modify: `src/app/schedule/builder/page.tsx`

- [ ] **Step 1: Add `addAttendingAction` in the builder page**

In `src/app/schedule/builder/page.tsx`, add this import at the top with the other service imports:

```typescript
import { createAttending, AttendingValidationError, AttendingForbiddenError } from "@/modules/schedule/services/attendings";
```

Then add a new server action next to `rhdClinicAction` (it must be defined before the `ReadinessPanel` render):

```tsx
  async function addAttendingAction(formData: FormData) {
    "use server";
    const actor = await requireModuleAccess("schedule");
    const scheduleName = ((formData.get("scheduleName") as string) ?? "").trim();
    const fullName = ((formData.get("fullName") as string) ?? "").trim();
    const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode });
    try {
      await createAttending(actor.personId, { scheduleName, fullName: fullName || scheduleName });
    } catch (err) {
      if (err instanceof AttendingValidationError || err instanceof AttendingForbiddenError) {
        redirect(buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode, gmode, error: "validation", message: err.message }));
      }
      throw err;
    }
    revalidatePath("/schedule/builder");
    redirect(base);
  }
```

Add `AttendingValidationError, AttendingForbiddenError` to the `createAttending` import:

```typescript
import { createAttending, AttendingValidationError, AttendingForbiddenError } from "@/modules/schedule/services/attendings";
```

- [ ] **Step 2: Pass the action to ReadinessPanel**

In the `<ReadinessPanel ... />` render, add the prop:

```tsx
                <ReadinessPanel
                  rhd={data.rhd!}
                  clinicAction={rhdClinicAction}
                  addAttendingAction={addAttendingAction}
                  dateKey={selectedDateKey!}
                />
```

- [ ] **Step 3: Render quick-add + manage link in ReadinessPanel**

In `src/modules/schedule/components/readiness-panel.tsx`, add `addAttendingAction` to the props type:

```typescript
type ReadinessPanelProps = {
  rhd: BuilderRhd;
  clinicAction: (fd: FormData) => Promise<void>;
  addAttendingAction: (fd: FormData) => Promise<void>;
  dateKey: string;
};
```

Destructure it in the component signature, and add this block immediately after the Attending `<Select>`'s closing `</div>` (the one wrapping the attending label + select). Import `Link` from `next/link`, `Input` from `@/platform/ui/input`, and `Button` from `@/platform/ui/button` at the top if not already imported:

```tsx
      {/* Quick-add a new attending */}
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">＋ Add attending</summary>
        <form action={addAttendingAction} className="mt-2 flex flex-col gap-2">
          <Input name="scheduleName" placeholder="Schedule name (e.g. Rivera)" required className="text-sm" />
          <Input name="fullName" placeholder="Full name (optional)" className="text-sm" />
          <Button type="submit" variant="outline" size="sm">Add</Button>
        </form>
      </details>
      <Link href="/schedule/attendings" className="text-xs text-brand hover:underline">
        Manage attendings
      </Link>
```

(The new attending defaults all capabilities to "unknown"; edit them on the Manage attendings page.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck + lint pass; no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/schedule/components/readiness-panel.tsx src/app/schedule/builder/page.tsx
git commit -m "feat(schedule): quick-add attending and manage link in the readiness panel"
```

---

### Task 9: e2e — attending add appears in the readiness dropdown

**Files:**
- Modify: `e2e/schedule.spec.ts`

Reuses `devLogin` / `selectDeptByCode`. j.carney has `schedule.edit_all`, so manages SCTS (an RHD dept) and can add attendings. The test names the attending with a `Date.now()` suffix so reruns never collide on the unique `scheduleName` (a leftover attending is harmless; `Date.now()` is allowed in Playwright tests).

- [ ] **Step 1: Add the test**

Append to `e2e/schedule.spec.ts`:

```tsx
test("RHD attendings: add one and see it in the readiness dropdown", async ({ page }) => {
  const name = `Test-${Date.now()}`;
  await devLogin(page, "j.carney@yale.edu");

  // Create via the management page.
  await page.goto("/schedule/attendings/new");
  await page.waitForURL((url) => url.pathname === "/schedule/attendings/new");
  await page.fill('input[name="scheduleName"]', name);
  await page.fill('input[name="fullName"]', `Dr. ${name}`);
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL((url) => url.pathname === "/schedule/attendings");
  await expect(page.getByText(name, { exact: false })).toBeVisible();

  // It appears in the builder readiness Attending dropdown for an RHD dept (SCTS).
  await page.goto("/schedule/builder");
  await selectDeptByCode(page, "SCTS");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");
  await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
  await page.waitForLoadState("networkidle");

  const attendingSelect = page.locator('select[name="attendingId"]');
  await expect(attendingSelect).toBeVisible();
  await expect(attendingSelect.locator("option", { hasText: name })).toHaveCount(1);
});
```

- [ ] **Step 2: Run the e2e**

Run: `npm run db:up && npx playwright test e2e/schedule.spec.ts -g "RHD attendings"`
Expected: PASS. If the e2e environment cannot start in the sandbox, report DONE_WITH_CONCERNS noting the test compiles and the service-level behavior is covered by `attendings.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add e2e/schedule.spec.ts
git commit -m "test(schedule): e2e for adding an RHD attending"
```

---

## Final verification

- [ ] `npm run typecheck && npm run lint` pass.
- [ ] `npm test -- src/platform/people.test.ts src/modules/schedule/services/attendings.test.ts` pass.
- [ ] `npm run build` reaches the known `/admin/people` Graph-env stop with no earlier errors.
- [ ] Manual smoke (`npm run dev`): edit a person's Spanish/RN flags → they persist and show as `ES`/`RN` chips in the list and badges in the builder; `/schedule/attendings` lists/adds/edits attendings; readiness panel quick-add creates one that appears in the Attending dropdown.
