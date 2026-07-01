# Subcommittee Ranking + Post-Acceptance Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let applicants rank subcommittee preferences on the application form, and let the recruitment team assign a final subcommittee to each accepted applicant in the hub.

**Architecture:** A new admin-managed `Subcommittee` entity (mirrors `Department`, soft-delete). A new `SUBCOMMITTEE_RANK` form-builder field type whose options are injected from active subcommittees at render/submit and whose ordered answer is hoisted into `Application.subcommitteeRanking[]` (mirrors `DEPARTMENT_CHOICE` → `departmentChoices[]`). A post-acceptance assignment service + dedicated cycle view records one `assignedSubcommitteeId` per accepted application. The legacy free-text training intake field is removed.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Zod, Vitest (integration tests against a per-worktree test DB), Tailwind.

## Global Constraints

- **Product name** "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`.
- **No em-dashes** in copy or comments; use other punctuation.
- **Soft-delete only** for `Subcommittee` (set `isActive = false`); never hard-delete, so historical ranking IDs always resolve to a name.
- **Permissions:** admin subcommittee management uses `admin.manage_subcommittees` (covered by the Platform Admin `*` wildcard; no seed change required). Assignment is gated to recruitment leads via the existing `reviewScope().all || can("recruitment.manage_cycles")` "seeAll" pattern — no new permission.
- **Ranking field "required" semantics:** required = at least one ranked choice (not all `rankCount`); optional = may be left entirely blank.
- **Test DB:** integration tests need the migration applied to the test DB. After creating the migration run `npm run test:prepare` (set `TEST_DATABASE_URL` to this worktree's DB first, per project convention). Run the suite with `npm test`.
- **Prisma on Neon:** preview deploys share the prod DB; run `npx prisma migrate status` before any deploy (a branch behind a migration crashes with P2021).

---

### Task 1: Schema — Subcommittee model, Application fields, enum value, drop training column

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_subcommittee_ranking/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma model `Subcommittee { id, name, isActive, order, createdAt, updatedAt }`; `Application.subcommitteeRanking: string[]`, `Application.assignedSubcommitteeId: string | null`, `Application.assignedSubcommitteeById: string | null`, `Application.assignedSubcommitteeAt: Date | null`, relations `assignedSubcommittee`, `assignedSubcommitteeBy`; enum `FieldType.SUBCOMMITTEE_RANK`. Removes `Training.subcommitteeInterest`.

- [ ] **Step 1: Add the `Subcommittee` model.** Insert after the `Department` model block (after its closing `}` near line 205) in `prisma/schema.prisma`:

```prisma
/// Admin-managed subcommittees applicants rank at application time and the
/// recruitment team assigns post-acceptance. Soft-delete via isActive so
/// historical rankings always resolve to a name.
model Subcommittee {
  id                   String        @id @default(cuid())
  name                 String
  isActive             Boolean       @default(true)
  order                Int           @default(0)
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt
  assignedApplications Application[] @relation("applicationAssignedSubcommittee")

  @@index([isActive, order])
}
```

- [ ] **Step 2: Add the new `FieldType` enum value.** In the `enum FieldType { ... }` block, add `SUBCOMMITTEE_RANK` after `DEPARTMENT_CHOICE`:

```prisma
enum FieldType {
  SHORT_TEXT
  LONG_TEXT
  SINGLE_SELECT
  MULTI_SELECT
  CHECKBOX
  EMAIL
  PHONE
  NUMBER
  DATE
  FILE
  DEPARTMENT_CHOICE
  SUBCOMMITTEE_RANK
}
```

- [ ] **Step 3: Add the `Application` columns + relations.** In `model Application`, add the scalar fields after `renewalDepartment String?` and the relations alongside the existing ones:

```prisma
  // ordered subcommittee IDs the applicant ranked (1st -> Nth); hoisted from the
  // SUBCOMMITTEE_RANK field answer at submit, like departmentChoices.
  subcommitteeRanking      String[]
  assignedSubcommitteeId   String?
  assignedSubcommitteeById String?
  assignedSubcommitteeAt   DateTime?
```

And in the relations section of `Application` (next to `cycle`/`applicant`):

```prisma
  assignedSubcommittee   Subcommittee? @relation("applicationAssignedSubcommittee", fields: [assignedSubcommitteeId], references: [id], onDelete: SetNull)
  assignedSubcommitteeBy Person?       @relation("applicationSubcommitteeAssigner", fields: [assignedSubcommitteeById], references: [id], onDelete: SetNull)
```

- [ ] **Step 4: Add the `Person` back-relation.** Find `model Person { ... }` and add (anywhere in its relation list):

```prisma
  subcommitteeAssignments Application[] @relation("applicationSubcommitteeAssigner")
```

- [ ] **Step 5: Remove the training intake column.** In `model Training`, delete the line:

```prisma
  subcommitteeInterest        String?
```

- [ ] **Step 6: Create + apply the migration.**

Run: `npx prisma migrate dev --name subcommittee_ranking`
Expected: migration created and applied; `prisma generate` runs; no errors. The generated SQL should `CREATE TABLE "Subcommittee"`, `ALTER TABLE "Application" ADD COLUMN ...`, add the enum value, and `ALTER TABLE "Training" DROP COLUMN "subcommitteeInterest"`.

- [ ] **Step 7: Apply to the test DB.**

Run: `npm run test:prepare`
Expected: `prisma migrate deploy` reports the new migration applied (no pending migrations).

- [ ] **Step 8: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (note: `training.ts` and `training-quiz.tsx` still reference the dropped column and will fail typecheck — that is expected and is fixed in Task 10. If you are running tasks out of order, expect those two files to error until Task 10. To keep this task green on its own, proceed to Step 9 and commit; the cross-file fix is Task 10's responsibility.)

> If running strictly in order, do Task 10 immediately after this task if you want a green typecheck at every commit. Otherwise the schema change and the training cleanup can be one combined commit. Recommended: keep them separate and accept that typecheck is red between Task 1 and Task 10. Reviewers: this is the one intentional cross-task break.

- [ ] **Step 9: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recruitment): add Subcommittee model, application ranking/assignment columns; drop training subcommitteeInterest"
```

---

### Task 2: Admin Subcommittee service (CRUD)

**Files:**
- Create: `src/modules/admin/services/subcommittees.ts`
- Test: `src/modules/admin/services/subcommittees.test.ts`

**Interfaces:**
- Consumes: `prisma`, `recordAudit` (Task 1 schema).
- Produces:
  - `listSubcommittees(): Promise<(Subcommittee & { _count: { assignedApplications: number } })[]>`
  - `createSubcommittee(actorPersonId: string, input: { name: string; isActive?: boolean }): Promise<Subcommittee>`
  - `updateSubcommittee(actorPersonId: string, id: string, input: { name: string; isActive: boolean; order?: number }): Promise<Subcommittee>`
  - `getSubcommittee(id: string): Promise<Subcommittee | null>`
  - `class SubcommitteeNotFoundError`, `class SubcommitteeValidationError`

- [ ] **Step 1: Write the failing test.** Create `src/modules/admin/services/subcommittees.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  listSubcommittees, createSubcommittee, updateSubcommittee, getSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "./subcommittees";

async function actor() {
  return prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates a subcommittee, defaults active, and lists it with a usage count", async () => {
  const a = await actor();
  const sc = await createSubcommittee(a.id, { name: "Community Outreach" });
  expect(sc.name).toBe("Community Outreach");
  expect(sc.isActive).toBe(true);
  const rows = await listSubcommittees();
  expect(rows).toHaveLength(1);
  expect(rows[0]._count.assignedApplications).toBe(0);
});

it("rejects a blank name", async () => {
  const a = await actor();
  await expect(createSubcommittee(a.id, { name: "   " })).rejects.toBeInstanceOf(SubcommitteeValidationError);
});

it("renames and deactivates (soft delete) an existing subcommittee", async () => {
  const a = await actor();
  const sc = await createSubcommittee(a.id, { name: "Old" });
  const updated = await updateSubcommittee(a.id, sc.id, { name: "New", isActive: false });
  expect(updated.name).toBe("New");
  expect(updated.isActive).toBe(false);
  expect(await getSubcommittee(sc.id)).not.toBeNull();
});

it("throws when updating a missing subcommittee", async () => {
  const a = await actor();
  await expect(updateSubcommittee(a.id, "missing", { name: "x", isActive: true }))
    .rejects.toBeInstanceOf(SubcommitteeNotFoundError);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/modules/admin/services/subcommittees.test.ts`
Expected: FAIL with "Cannot find module './subcommittees'".

- [ ] **Step 3: Write the implementation.** Create `src/modules/admin/services/subcommittees.ts`:

```ts
/**
 * Subcommittees service: create, update (name/active/order), list. Mirrors
 * departments.ts — typed errors, actor-scoped mutations that audit. Permission
 * checks are the caller's job. Removal is soft (isActive=false) so historical
 * application rankings always resolve to a name.
 */
import type { Subcommittee } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

export class SubcommitteeNotFoundError extends Error {
  constructor(public id: string) {
    super(`Subcommittee ${id} not found.`);
    this.name = "SubcommitteeNotFoundError";
  }
}
export class SubcommitteeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubcommitteeValidationError";
  }
}

export type SubcommitteeRow = Subcommittee & { _count: { assignedApplications: number } };

/** All subcommittees, active first then by order then name, with usage counts. */
export async function listSubcommittees(): Promise<SubcommitteeRow[]> {
  return prisma.subcommittee.findMany({
    include: { _count: { select: { assignedApplications: true } } },
    orderBy: [{ isActive: "desc" }, { order: "asc" }, { name: "asc" }],
  });
}

export async function getSubcommittee(id: string): Promise<Subcommittee | null> {
  return prisma.subcommittee.findUnique({ where: { id } });
}

export async function createSubcommittee(
  actorPersonId: string,
  input: { name: string; isActive?: boolean; order?: number }
): Promise<Subcommittee> {
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");

  const sc = await prisma.subcommittee.create({
    data: { name, isActive: input.isActive ?? true, order: input.order ?? 0 },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.create",
    entityType: "Subcommittee",
    entityId: sc.id,
    after: { name: sc.name, isActive: sc.isActive },
  });
  return sc;
}

export async function updateSubcommittee(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; order?: number }
): Promise<Subcommittee> {
  const before = await prisma.subcommittee.findUnique({ where: { id } });
  if (!before) throw new SubcommitteeNotFoundError(id);
  const name = input.name.trim();
  if (!name) throw new SubcommitteeValidationError("Name is required.");

  const sc = await prisma.subcommittee.update({
    where: { id },
    data: { name, isActive: input.isActive, order: input.order ?? before.order },
  });
  await recordAudit({
    actorPersonId,
    action: "subcommittee.update",
    entityType: "Subcommittee",
    entityId: id,
    before: { name: before.name, isActive: before.isActive, order: before.order },
    after: { name: sc.name, isActive: sc.isActive, order: sc.order },
  });
  return sc;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/modules/admin/services/subcommittees.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/admin/services/subcommittees.ts src/modules/admin/services/subcommittees.test.ts
git commit -m "feat(admin): subcommittees CRUD service with soft-delete and audit"
```

---

### Task 3: Admin Subcommittees UI (`/admin/subcommittees`)

**Files:**
- Create: `src/modules/admin/components/subcommittee-form.tsx`
- Create: `src/app/(app)/admin/subcommittees/page.tsx`
- Create: `src/app/(app)/admin/subcommittees/new/page.tsx`
- Create: `src/app/(app)/admin/subcommittees/[id]/page.tsx`
- Modify: `src/app/(app)/admin/page.tsx` (add a quick link)

**Interfaces:**
- Consumes: Task 2 service functions; `requirePermission`; `optionalInt` from `@/modules/admin/form-coerce`.

- [ ] **Step 1: Create the form component.** Create `src/modules/admin/components/subcommittee-form.tsx`:

```tsx
import type { Subcommittee } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Alert } from "@/platform/ui/alert";

type SubcommitteeFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  subcommittee?: Pick<Subcommittee, "name" | "isActive" | "order">;
  error?: string;
  saved?: string;
};

/** Create/edit form for a Subcommittee. Soft-delete via the Active toggle. */
export function SubcommitteeForm({ action, mode, subcommittee, error, saved }: SubcommitteeFormProps) {
  return (
    <form action={action} className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Changes saved.</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" defaultValue={subcommittee?.name ?? ""} required placeholder="Community Outreach" />
        </Field>
        <Field label="Order" hint="Lower shows first. Optional.">
          <Input name="order" type="number" min="0" defaultValue={String(subcommittee?.order ?? 0)} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="isActive" defaultChecked={subcommittee?.isActive ?? true} />
        Active
      </label>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" variant="primary">
          {mode === "create" ? "Create subcommittee" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Create the list page.** Create `src/app/(app)/admin/subcommittees/page.tsx`:

```tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listSubcommittees } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

export default async function SubcommitteesListPage() {
  await requirePermission("admin.manage_subcommittees");
  const subcommittees = await listSubcommittees();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subcommittees"
        description="Manage the subcommittees applicants rank and the recruitment team assigns."
        action={
          <Link href="/admin/subcommittees/new" className={buttonClasses("primary", "sm")}>
            Create subcommittee
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Status</TH>
            <TH>Assigned</TH>
            <TH></TH>
          </TR>
        </THead>
        <tbody>
          {subcommittees.map((s) => (
            <TR key={s.id} className={s.isActive ? "" : "opacity-60"}>
              <TD className="font-medium">{s.name}</TD>
              <TD>
                {s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
              </TD>
              <TD>{s._count.assignedApplications}</TD>
              <TD>
                <Link href={`/admin/subcommittees/${s.id}`} className={buttonClasses("outline", "sm")}>
                  Edit
                </Link>
              </TD>
            </TR>
          ))}
          {subcommittees.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-sm text-subtle-foreground">
                No subcommittees yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Create the "new" page.** Create `src/app/(app)/admin/subcommittees/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { createSubcommittee, SubcommitteeValidationError } from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewSubcommitteePage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_subcommittees");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_subcommittees");
    try {
      const sc = await createSubcommittee(session.personId, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
      redirect(`/admin/subcommittees/${sc.id}?saved=1`);
    } catch (err) {
      if (err instanceof SubcommitteeValidationError) {
        redirect(`/admin/subcommittees/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create subcommittee" description="Applicants will be able to rank active subcommittees." />
      <SubcommitteeForm action={createAction} mode="create" error={error} />
    </div>
  );
}
```

- [ ] **Step 4: Create the edit page.** Create `src/app/(app)/admin/subcommittees/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getSubcommittee, updateSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function EditSubcommitteePage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_subcommittees");
  const { id } = await params;
  const { error, saved } = await searchParams;

  const subcommittee = await getSubcommittee(id);
  if (!subcommittee) notFound();

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_subcommittees");
    try {
      await updateSubcommittee(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
      });
    } catch (err) {
      if (err instanceof SubcommitteeValidationError || err instanceof SubcommitteeNotFoundError) {
        redirect(`/admin/subcommittees/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/subcommittees/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={`Edit ${subcommittee.name}`} description="Toggle Active to deactivate (soft remove)." />
      <SubcommitteeForm action={updateAction} mode="edit" subcommittee={subcommittee} error={error} saved={saved} />
    </div>
  );
}
```

- [ ] **Step 5: Add the admin quick link.** In `src/app/(app)/admin/page.tsx`, add to the `quickLinks` array (after the `Roles` entry):

```tsx
    { label: "Subcommittees", href: "/admin/subcommittees" },
```

- [ ] **Step 6: Verify build + typecheck.**

Run: `npm run typecheck`
Expected: PASS for these new files (Task 10 still pending may keep training files red; the new admin files must not add errors).

- [ ] **Step 7: Commit.**

```bash
git add src/modules/admin/components/subcommittee-form.tsx "src/app/(app)/admin/subcommittees" "src/app/(app)/admin/page.tsx"
git commit -m "feat(admin): subcommittees CRUD pages and admin quick link"
```

---

### Task 4: Engine — field type metadata + schema-builder handling

**Files:**
- Modify: `src/modules/recruitment/engine/field-types.ts`
- Modify: `src/modules/recruitment/engine/schema-builder.ts`
- Test: `src/modules/recruitment/engine/field-types.test.ts`
- Test: `src/modules/recruitment/engine/schema-builder.test.ts`

**Interfaces:**
- Produces: `FIELD_TYPE_META.SUBCOMMITTEE_RANK`; `FieldGroup` includes `"Subcommittee"`; engine `FieldType` union includes `"SUBCOMMITTEE_RANK"`; `FieldValidation.rankCount?: number`; `buildApplicationSchema` skips `SUBCOMMITTEE_RANK` (handled in submissions, like `FILE`).

- [ ] **Step 1: Write the failing engine test.** First open `src/modules/recruitment/engine/field-types.test.ts` and confirm what it already imports (it should already import `FIELD_TYPE_META` / `fieldTypesByGroup` and `it`/`expect`). Add ONLY this test case body (reusing the existing imports — do NOT add a duplicate import line):

```ts
it("exposes SUBCOMMITTEE_RANK in a Subcommittee group", () => {
  expect(FIELD_TYPE_META.SUBCOMMITTEE_RANK).toBeDefined();
  expect(FIELD_TYPE_META.SUBCOMMITTEE_RANK.hasOptions).toBe(false);
  const groups = fieldTypesByGroup();
  const sub = groups.find((g) => g.group === "Subcommittee");
  expect(sub?.types).toContain("SUBCOMMITTEE_RANK");
});
```

(If any of `FIELD_TYPE_META`, `fieldTypesByGroup`, `it`, or `expect` is not already imported at the top of the file, add it to the existing import — do not introduce a second import statement.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- src/modules/recruitment/engine/field-types.test.ts`
Expected: FAIL — `FIELD_TYPE_META.SUBCOMMITTEE_RANK` is undefined.

- [ ] **Step 3: Implement field-types metadata.** In `src/modules/recruitment/engine/field-types.ts`:

Change the import to add an icon:
```ts
import {
  Type, AlignLeft, ChevronDownSquare, ListChecks, CheckSquare,
  Mail, Phone, Hash, Calendar, Paperclip, Building2, ListOrdered, type LucideIcon,
} from "lucide-react";
```

Add `"Subcommittee"` to the `FieldGroup` union:
```ts
export type FieldGroup = "Text" | "Choice" | "Contact" | "DateNumber" | "File" | "Department" | "Subcommittee";
```

Add the meta entry after the `DEPARTMENT_CHOICE` line:
```ts
  SUBCOMMITTEE_RANK: { label: "Subcommittee ranking", icon: ListOrdered, group: "Subcommittee", hasOptions: false, isFile: false },
```

Add the group to the order:
```ts
export const FIELD_GROUP_ORDER: FieldGroup[] = ["Text", "Choice", "Contact", "DateNumber", "File", "Department", "Subcommittee"];
```

- [ ] **Step 4: Run the engine test to verify it passes.**

Run: `npm test -- src/modules/recruitment/engine/field-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing schema-builder test.** Append to `src/modules/recruitment/engine/schema-builder.test.ts`:

```ts
it("excludes SUBCOMMITTEE_RANK from the generated scalar schema (handled in submissions)", () => {
  const sections = [{
    id: "s1", appliesTo: "BOTH" as const, departmentCode: null,
    fields: [
      { key: "subs", type: "SUBCOMMITTEE_RANK" as const, required: true, options: null, validation: { rankCount: 3 } },
      { key: "name", type: "SHORT_TEXT" as const, required: true, options: null, validation: null },
    ],
  }];
  const schema = buildApplicationSchema(sections, { applicantType: "NEW", selectedDepartmentCodes: [] });
  const parsed = schema.parse({ name: "Ann" }); // no `subs` key needed
  expect(parsed).toEqual({ name: "Ann" });
});
```

(Match the existing import style in that test file for `buildApplicationSchema`.)

- [ ] **Step 6: Run it to verify it fails.**

Run: `npm test -- src/modules/recruitment/engine/schema-builder.test.ts`
Expected: FAIL — `SUBCOMMITTEE_RANK` not in the `FieldType` union (type error) or schema requires `subs`.

- [ ] **Step 7: Implement schema-builder changes.** In `src/modules/recruitment/engine/schema-builder.ts`:

Add to the `FieldType` union:
```ts
  | "DEPARTMENT_CHOICE"
  | "SUBCOMMITTEE_RANK";
```

Add `rankCount` to `FieldValidation`:
```ts
export type FieldValidation = {
  min?: number;
  max?: number;
  regex?: string;
  maxFileMB?: number;
  acceptedTypes?: string[];
  rankCount?: number;
};
```

In `buildApplicationSchema`, skip the field (next to the existing `if (field.type === "FILE") continue;`):
```ts
      if (field.type === "FILE") continue;
      if (field.type === "SUBCOMMITTEE_RANK") continue; // ordered ranking is validated + hoisted in submissions
```

- [ ] **Step 8: Run both engine tests to verify they pass.**

Run: `npm test -- src/modules/recruitment/engine`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/modules/recruitment/engine/field-types.ts src/modules/recruitment/engine/schema-builder.ts src/modules/recruitment/engine/field-types.test.ts src/modules/recruitment/engine/schema-builder.test.ts
git commit -m "feat(recruitment): SUBCOMMITTEE_RANK field type + engine handling"
```

---

### Task 5: Capture ranking in submissions

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts`
- Test: `src/modules/recruitment/services/submissions.test.ts`

**Interfaces:**
- Consumes: `prisma`, `SubmissionValidationError`, Task 1 columns, Task 4 engine types.
- Produces: `submitApplication` now writes `Application.subcommitteeRanking` (ordered, validated subcommittee IDs) and keeps the raw answer out of stored `answers`.

- [ ] **Step 1: Write the failing test.** Append to `src/modules/recruitment/services/submissions.test.ts`. First extend the `openVolunteerCycle` helper to add a ranking field and seed subcommittees, OR add a new dedicated helper to avoid disturbing existing assertions. Add this new helper + tests at the end of the file:

```ts
async function openCycleWithRanking() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const a = await prisma.subcommittee.create({ data: { name: "Outreach", order: 0 } });
  const b = await prisma.subcommittee.create({ data: { name: "Events", order: 1 } });
  const c = await prisma.subcommittee.create({ data: { name: "Fundraising", order: 2 } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-rank", departments: ["SRHD"], acceptsRenewals: false, createdById: person.id });
  const section = await prisma.formSection.findFirstOrThrow({ where: { cycleId: cycle.id }, orderBy: { order: "asc" } });
  await addField(section.id, { label: "1st choice department", type: "DEPARTMENT_CHOICE", required: true });
  await addField(section.id, { label: "Subcommittee preferences", type: "SUBCOMMITTEE_RANK", required: true, validation: { rankCount: 3 } });
  await publishCycle(cycle.id, person.id);
  return { person, cycle, subs: { a, b, c } };
}

it("hoists ranked subcommittee IDs into subcommitteeRanking in order", async () => {
  const { subs } = await openCycleWithRanking();
  const app = await submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: {
      first_name: "Ann", last_name: "Lee", email: "ann@yale.edu",
      "1st_choice_department": "SRHD",
      subcommittee_preferences: [subs.b.id, subs.a.id],
    },
    files: {},
  });
  expect(app.subcommitteeRanking).toEqual([subs.b.id, subs.a.id]);
  const stored = (app.answers ?? {}) as Record<string, unknown>;
  expect(stored.subcommittee_preferences).toBeUndefined();
});

it("rejects a required ranking left empty", async () => {
  await openCycleWithRanking();
  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "Ann", last_name: "Lee", email: "ann@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: [] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("rejects duplicate or unknown subcommittee IDs and over-count", async () => {
  const { subs } = await openCycleWithRanking();
  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "B", last_name: "B", email: "b@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: [subs.a.id, subs.a.id] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);

  await expect(submitApplication("apply-rank", {
    applicantType: "NEW",
    answers: { first_name: "C", last_name: "C", email: "c@yale.edu", "1st_choice_department": "SRHD", subcommittee_preferences: ["nope"] },
    files: {},
  })).rejects.toBeInstanceOf(SubmissionValidationError);
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- src/modules/recruitment/services/submissions.test.ts`
Expected: FAIL — `subcommitteeRanking` is `[]` / not populated.

- [ ] **Step 3: Implement the hoist + validation.** In `src/modules/recruitment/services/submissions.ts`:

Add a constant near `DEPT_CHOICE_KEY_TYPE`:
```ts
const SUBCOMMITTEE_RANK_TYPE: FieldType = "SUBCOMMITTEE_RANK";
```

Add a helper above `submitApplication`:
```ts
/** Validate + normalize a ranking answer into ordered subcommittee IDs.
 *  Filters blanks (unfilled dropdowns submit ""), enforces distinct, known-active,
 *  and the field's rankCount cap; required means at least one. */
function resolveRanking(
  raw: unknown,
  required: boolean,
  rankCount: number,
  activeIds: Set<string>,
  fieldKey: string
): string[] {
  const list = (Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw])
    .map((v) => String(v))
    .filter((v) => v !== "");
  if (list.length === 0) {
    if (required) throw new SubmissionValidationError("Please rank at least one subcommittee.", { [fieldKey]: "required" });
    return [];
  }
  if (new Set(list).size !== list.length) {
    throw new SubmissionValidationError("Each subcommittee can be ranked only once.", { [fieldKey]: "duplicate choice" });
  }
  if (list.length > rankCount) {
    throw new SubmissionValidationError(`Rank at most ${rankCount} subcommittees.`, { [fieldKey]: `max ${rankCount}` });
  }
  for (const id of list) {
    if (!activeIds.has(id)) {
      throw new SubmissionValidationError("That subcommittee is not available.", { [fieldKey]: "unknown choice" });
    }
  }
  return list;
}
```

In `submitApplication`, after the `selectedDepartmentCodes` block and before building the schema (the schema skips this field), compute the ranking. Insert after the `const ctx = ...` line is built, but BEFORE the `$transaction`. Concretely, add right after the file/validation checks (after the `for (const [key, file] ...)` upload loop, before reading `email`):

```ts
  // Subcommittee ranking: hoisted into its own column like departmentChoices, and
  // intentionally kept out of stored answers (single source of truth = the column).
  const rankField = cycle.sections.flatMap((s) => s.fields).find((f) => f.type === SUBCOMMITTEE_RANK_TYPE);
  let subcommitteeRanking: string[] = [];
  if (rankField) {
    const activeSubs = await prisma.subcommittee.findMany({ where: { isActive: true }, select: { id: true } });
    const activeIds = new Set(activeSubs.map((s) => s.id));
    const rankCount = (rankField.validation as { rankCount?: number } | null)?.rankCount ?? 3;
    subcommitteeRanking = resolveRanking(input.answers[rankField.key], rankField.required, rankCount, activeIds, rankField.key);
  }
```

Then strip the raw ranking key from stored answers — modify the `answersWithFiles` line:
```ts
  const answersWithFiles = { ...parsed.data, ...fileRefs.answerPatch };
  if (rankField) delete (answersWithFiles as Record<string, unknown>)[rankField.key];
```

(Note: `parsed.data` already omits `SUBCOMMITTEE_RANK` because the schema skips it, but `delete` is a belt-and-suspenders guard and harmless.)

Then write the column in the `tx.application.create` data:
```ts
        data: {
          cycleId: cycle.id, applicantId: applicant.id, answers: answersWithFiles as never,
          applicantType: input.applicantType, departmentChoices: selectedDepartmentCodes,
          subcommitteeRanking,
          renewalDepartment: input.applicantType === "RENEWAL" ? input.renewalDepartment! : null,
        },
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (existing tests still green + 3 new).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): hoist + validate subcommittee ranking on submit"
```

---

### Task 6: Public form rendering of the ranking field

**Files:**
- Modify: `src/modules/recruitment/components/field-preview.tsx`
- Modify: `src/app/apply/[slug]/page.tsx`
- Modify: `src/app/apply/[slug]/apply-form.tsx`

**Interfaces:**
- Consumes: Task 1 (`subcommittee` table), Task 4 (`rankCount` in validation).
- Produces: `FieldPreview` accepts `subcommittees?: { id: string; name: string }[]` and renders a `SUBCOMMITTEE_RANK` case; `ApplyForm` `Def` gains `subcommittees`.

- [ ] **Step 1: Add the `subcommittees` prop + render case to `FieldPreview`.** In `src/modules/recruitment/components/field-preview.tsx`:

Change the signature + props:
```tsx
export function FieldPreview({
  f, departments, subcommittees = [], fieldError, onDeptChoice, disabled = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  subcommittees?: { id: string; name: string }[];
  fieldError?: string;
  onDeptChoice?: (v: string) => void;
  disabled?: boolean;
}) {
```

Add a case before `default:` in the `switch (f.type)`:
```tsx
    case "SUBCOMMITTEE_RANK": {
      const rankCount = typeof f.validation?.rankCount === "number" ? f.validation.rankCount : 3;
      const ordinals = ["1st choice", "2nd choice", "3rd choice", "4th choice", "5th choice"];
      control = (
        <span className="mt-1 flex flex-col gap-2">
          {Array.from({ length: rankCount }).map((_, i) => (
            <label key={i} className="flex items-center gap-2 text-sm">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{ordinals[i] ?? `Choice ${i + 1}`}</span>
              <Select name={f.key} required={f.required && i === 0} disabled={disabled} defaultValue="" className="flex-1">
                <option value="">{i === 0 && f.required ? "Select…" : "None"}</option>
                {subcommittees.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
          ))}
        </span>
      );
      break;
    }
```

(Note: all dropdowns list every active subcommittee. Duplicate picks are rejected server-side in `submitApplication` with a clear field error — `resolveRanking` enforces distinctness (Task 5). The spec mentions client-side dedup as a nicety; it is intentionally deferred here to keep the shared preview/builder/public control stateless. If added later, it belongs in a controlled wrapper in `apply-form.tsx`, not in the shared `FieldPreview`.)

- [ ] **Step 2: Load subcommittees + pass them in `apply/[slug]/page.tsx`.** In `src/app/apply/[slug]/page.tsx`:

After fetching `cycle`, fetch active subcommittees (add to the function, e.g. right after the `cycle` query):
```ts
  const subcommittees = await prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
```

Add `subcommittees` to the `def` object:
```ts
  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    subcommittees,
    sections: cycle.sections.map((s) => ({
```

- [ ] **Step 3: Thread `subcommittees` through `ApplyForm`.** In `src/app/apply/[slug]/apply-form.tsx`:

Extend the `Def` type:
```ts
type Def = { slug: string; title: string; acceptsRenewals: boolean; departments: string[]; subcommittees: { id: string; name: string }[]; sections: SectionDef[] };
```

Pass `subcommittees` to `FieldPreview` in the `section.fields.map`:
```tsx
            <FieldPreview key={f.key} f={f} departments={def.departments} subcommittees={def.subcommittees}
              fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
              onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined} />
```

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: PASS for these files (training files may still be red until Task 10).

- [ ] **Step 5: Manual verification.**

Run: `npm run dev`, create/seed a couple of subcommittees via `/admin/subcommittees`, add a `SUBCOMMITTEE_RANK` field to a DRAFT cycle's form, publish, open `/apply/<slug>`, and confirm three ordered dropdowns appear listing the subcommittees. Submit and confirm the application's `subcommitteeRanking` is stored in order (check via Prisma Studio or the assign view in Task 9).
Expected: dropdowns render; submission succeeds; ranking stored in order.

- [ ] **Step 6: Commit.**

```bash
git add src/modules/recruitment/components/field-preview.tsx "src/app/apply/[slug]/page.tsx" "src/app/apply/[slug]/apply-form.tsx"
git commit -m "feat(recruitment): render subcommittee ranking on the public application form"
```

---

### Task 7: Builder field settings (rankCount) + preview wiring

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/builder/page.tsx`

**Interfaces:**
- Consumes: Task 6 `FieldPreview` `subcommittees` prop; Task 4 `validation.rankCount`.
- Produces: builder threads `subcommittees` to previews; `SUBCOMMITTEE_RANK` field shows a "Number to rank" input writing `validation.rankCount`.

- [ ] **Step 1: Load subcommittees in the builder page.** In `src/app/(app)/recruitment/cycles/[id]/builder/page.tsx`:

Add the import:
```ts
import { prisma } from "@/platform/db";
```

Fetch after `getCycle`:
```ts
  const subcommittees = await prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
```

Pass to `FormBuilder`:
```tsx
      <FormBuilder
        cycleId={id}
        cycleTitle={cycle.title}
        editable={cycle.status === "DRAFT"}
        status={cycle.status}
        departments={cycle.departments}
        subcommittees={subcommittees}
        sections={sections}
      />
```

- [ ] **Step 2: Thread through `FormBuilder`.** In `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx`, add `subcommittees` to props + pass to `SectionCard`:

Props type + destructure:
```tsx
export function FormBuilder({
  cycleId, cycleTitle, editable, status, departments, subcommittees, sections,
}: {
  cycleId: string;
  cycleTitle: string;
  editable: boolean;
  status: string;
  departments: string[];
  subcommittees: { id: string; name: string }[];
  sections: BuilderSection[];
}) {
```

In the `renderItem` for sections:
```tsx
            <SectionCard
              cycleId={cycleId}
              section={section}
              departments={departments}
              subcommittees={subcommittees}
              editable={editable}
              handle={handle}
              onChanged={refresh}
            />
```

- [ ] **Step 3: Thread through `SectionCard`.** In `src/app/(app)/recruitment/cycles/[id]/builder/section-card.tsx`, add `subcommittees` to props + pass to `FieldCard`:

```tsx
export function SectionCard({
  cycleId, section, departments, subcommittees, editable, handle, onChanged,
}: {
  cycleId: string;
  section: BuilderSection;
  departments: string[];
  subcommittees: { id: string; name: string }[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
```

In the field `renderItem`:
```tsx
            <FieldCard cycleId={cycleId} field={field} departments={departments} subcommittees={subcommittees} editable={editable} handle={fhandle} onChanged={onChanged} />
```

- [ ] **Step 4: Use it + add the rankCount setting in `FieldCard`.** In `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx`:

Add `subcommittees` to props:
```tsx
export function FieldCard({
  cycleId, field, departments, subcommittees, editable, handle, onChanged,
}: {
  cycleId: string;
  field: BuilderField;
  departments: string[];
  subcommittees: { id: string; name: string }[];
  editable: boolean;
  handle: SortableHandleProps;
  onChanged: () => void;
}) {
```

Pass `subcommittees` to the preview:
```tsx
          <FieldPreview f={field} departments={departments} subcommittees={subcommittees} disabled />
```

Add a settings block next to the existing `DEPARTMENT_CHOICE` hint (after that `{field.type === "DEPARTMENT_CHOICE" && ...}` block):
```tsx
          {field.type === "SUBCOMMITTEE_RANK" && (
            <Field label="Number to rank" hint="How many ordered choices the applicant makes. Choices come from active subcommittees.">
              <Input
                type="number"
                min={1}
                max={5}
                defaultValue={String((field.validation?.rankCount as number | undefined) ?? 3)}
                disabled={!editable}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(5, Number(e.target.value) || 3));
                  const current = (field.validation?.rankCount as number | undefined) ?? 3;
                  if (n !== current) save({ validation: { ...(field.validation ?? {}), rankCount: n } });
                }}
              />
            </Field>
          )}
```

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: PASS for builder files (training still red until Task 10).

- [ ] **Step 6: Manual verification.**

Run: `npm run dev`, open a DRAFT cycle builder, add a "Subcommittee ranking" field (Subcommittee group in the type picker), open its editor, change "Number to rank" to 2, confirm the preview shows 2 ordered dropdowns of active subcommittees.
Expected: works; rankCount persists across refresh.

- [ ] **Step 7: Commit.**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/builder"
git commit -m "feat(recruitment): builder support for subcommittee ranking field (rankCount + preview)"
```

---

### Task 8: Assignment service

**Files:**
- Create: `src/modules/recruitment/services/subcommittees.ts`
- Test: `src/modules/recruitment/services/subcommittees.test.ts`

**Interfaces:**
- Consumes: `prisma`, `reviewScope`/`RecruitmentAuthError` from `./review`, `can`, `recordAudit`, Task 1 columns.
- Produces:
  - `class SubcommitteeAssignError`
  - `assignSubcommittee(applicationId: string, subcommitteeId: string | null, actorId: string): Promise<void>`
  - `type AssignmentRow = { applicationId, applicant: { firstName, lastName, email }, acceptedDepartments: string[], ranking: { id, name, active }[], assignedSubcommitteeId: string | null }`
  - `listAcceptedForAssignment(cycleId: string, viewerId: string): Promise<AssignmentRow[]>`
  - `listAssignableSubcommittees(): Promise<{ id: string; name: string }[]>` (active only)

- [ ] **Step 1: Write the failing test.** Create `src/modules/recruitment/services/subcommittees.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "./cycles";
import { acceptApplicant } from "./review";
import {
  assignSubcommittee, listAcceptedForAssignment, SubcommitteeAssignError,
} from "./subcommittees";
import { RecruitmentAuthError } from "./review";

async function seed() {
  const lead = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  // grant review_all so the lead is "seeAll"
  const role = await prisma.role.create({ data: { name: "SRR Lead", isSystem: false, grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: lead.id, termId: null } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date(), endDate: new Date() } });
  const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "apply-x", departments: ["SRHD"], acceptsRenewals: false, createdById: lead.id });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ann", lastName: "Lee", email: "ann@yale.edu", emailLower: "ann@yale.edu" } });
  const sub = await prisma.subcommittee.create({ data: { name: "Outreach" } });
  const app = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], subcommitteeRanking: [sub.id] } });
  return { lead, cycle, app, sub };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("refuses to assign before the applicant is accepted", async () => {
  const { lead, app, sub } = await seed();
  await expect(assignSubcommittee(app.id, sub.id, lead.id)).rejects.toBeInstanceOf(SubcommitteeAssignError);
});

it("assigns a subcommittee to an accepted applicant and records who/when", async () => {
  const { lead, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBe(sub.id);
  expect(after.assignedSubcommitteeById).toBe(lead.id);
  expect(after.assignedSubcommitteeAt).not.toBeNull();
});

it("clears an assignment with null", async () => {
  const { lead, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  await assignSubcommittee(app.id, null, lead.id);
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(after.assignedSubcommitteeId).toBeNull();
});

it("rejects a non-lead caller", async () => {
  const { app, sub } = await seed();
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  await prisma.acceptance.create({ data: { applicationId: app.id, departmentCode: "SRHD", approvedById: outsider.id } });
  await expect(assignSubcommittee(app.id, sub.id, outsider.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("lists accepted applicants with resolved ranking + current assignment", async () => {
  const { lead, cycle, app, sub } = await seed();
  await acceptApplicant(app.id, "SRHD", lead.id, null);
  await assignSubcommittee(app.id, sub.id, lead.id);
  const rows = await listAcceptedForAssignment(cycle.id, lead.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].acceptedDepartments).toEqual(["SRHD"]);
  expect(rows[0].ranking.map((r) => r.name)).toEqual(["Outreach"]);
  expect(rows[0].assignedSubcommitteeId).toBe(sub.id);
});
```

(Confirm the `Role`/`Grant` relation names match the schema — adjust the `grants: { create: [...] }` shape if the grant model differs. Check `prisma/seed.ts` lines 165-170, which create grants via `{ roleId, permission }`.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `npm test -- src/modules/recruitment/services/subcommittees.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service.** Create `src/modules/recruitment/services/subcommittees.ts`:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { reviewScope, RecruitmentAuthError } from "./review";

export class SubcommitteeAssignError extends Error {
  constructor(message: string) { super(message); this.name = "SubcommitteeAssignError"; }
}

/** Recruitment leads only: review_all or manage_cycles. */
async function assertLead(actorId: string): Promise<void> {
  const [scope, managesCycles] = await Promise.all([
    reviewScope(actorId),
    can(actorId, "recruitment.manage_cycles"),
  ]);
  if (!(scope.all || managesCycles)) {
    throw new RecruitmentAuthError("Only recruitment leads can assign subcommittees.");
  }
}

/** Assign (or clear with null) the final subcommittee for an accepted applicant. */
export async function assignSubcommittee(
  applicationId: string,
  subcommitteeId: string | null,
  actorId: string
): Promise<void> {
  await assertLead(actorId);

  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { _count: { select: { acceptances: true } } },
  });
  if (!app) throw new SubcommitteeAssignError("Application not found.");
  if (app._count.acceptances === 0) {
    throw new SubcommitteeAssignError("Assign a subcommittee only after the applicant is accepted.");
  }

  if (subcommitteeId !== null) {
    const sub = await prisma.subcommittee.findFirst({ where: { id: subcommitteeId, isActive: true } });
    if (!sub) throw new SubcommitteeAssignError("That subcommittee is not available.");
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      assignedSubcommitteeId: subcommitteeId,
      assignedSubcommitteeById: subcommitteeId === null ? null : actorId,
      assignedSubcommitteeAt: subcommitteeId === null ? null : new Date(),
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "recruitment.subcommittee_assign",
    entityType: "Application",
    entityId: applicationId,
    after: { assignedSubcommitteeId: subcommitteeId },
  });
}

export type AssignmentRow = {
  applicationId: string;
  applicant: { firstName: string; lastName: string; email: string };
  acceptedDepartments: string[];
  ranking: { id: string; name: string; active: boolean }[];
  assignedSubcommitteeId: string | null;
};

/** Accepted applicants for a cycle (>=1 acceptance) with their ranked preferences
 *  resolved to names + current assignment. Leads only. */
export async function listAcceptedForAssignment(cycleId: string, viewerId: string): Promise<AssignmentRow[]> {
  await assertLead(viewerId);

  const apps = await prisma.application.findMany({
    where: { cycleId, acceptances: { some: {} } },
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true } },
      acceptances: { select: { departmentCode: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { submittedAt: "desc" },
  });

  // Resolve every referenced subcommittee id (active or not) to a name in one query.
  const ids = [...new Set(apps.flatMap((a) => a.subcommitteeRanking))];
  const subs = ids.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isActive: true } })
    : [];
  const byId = new Map(subs.map((s) => [s.id, s]));

  return apps.map((a) => ({
    applicationId: a.id,
    applicant: a.applicant,
    acceptedDepartments: [...new Set(a.acceptances.map((x) => x.departmentCode))],
    ranking: a.subcommitteeRanking
      .map((id) => byId.get(id))
      .filter((s): s is { id: string; name: string; isActive: boolean } => Boolean(s))
      .map((s) => ({ id: s.id, name: s.name, active: s.isActive })),
    assignedSubcommitteeId: a.assignedSubcommitteeId,
  }));
}

/** Active subcommittees offered in the assignment dropdown. */
export async function listAssignableSubcommittees(): Promise<{ id: string; name: string }[]> {
  return prisma.subcommittee.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/modules/recruitment/services/subcommittees.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/modules/recruitment/services/subcommittees.ts src/modules/recruitment/services/subcommittees.test.ts
git commit -m "feat(recruitment): subcommittee assignment service (post-acceptance, lead-gated)"
```

---

### Task 9: Assignment view + detail display + cycle nav link

**Files:**
- Create: `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx`
- Create: `src/app/(app)/recruitment/cycles/[id]/subcommittees/actions.ts`
- Modify: `src/app/(app)/recruitment/cycles/[id]/page.tsx` (nav link)
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (read-only display)

**Interfaces:**
- Consumes: Task 8 service; `requirePersonSession`; `getCycle`; `cycleTrail`.

- [ ] **Step 1: Create the assignment server action.** Create `src/app/(app)/recruitment/cycles/[id]/subcommittees/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { assignSubcommittee } from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { SubcommitteeAssignError } from "@/modules/recruitment/services/subcommittees";

export async function assignSubcommitteeAction(cycleId: string, applicationId: string, formData: FormData) {
  const person = await requirePersonSession();
  const raw = String(formData.get("subcommitteeId") ?? "");
  const subcommitteeId = raw === "" ? null : raw;
  try {
    await assignSubcommittee(applicationId, subcommitteeId, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof SubcommitteeAssignError) {
      redirect(`/recruitment/cycles/${cycleId}/subcommittees?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  redirect(`/recruitment/cycles/${cycleId}/subcommittees?saved=1`);
}
```

- [ ] **Step 2: Create the assignment page.** Create `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listAcceptedForAssignment, listAssignableSubcommittees } from "@/modules/recruitment/services/subcommittees";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { assignSubcommitteeAction } from "./actions";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Select } from "@/platform/ui/select";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function AssignSubcommitteesPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const [person, cycle] = await Promise.all([requirePersonSession(), getCycle(id)]);
  if (!cycle) notFound();

  let rows;
  try {
    rows = await listAcceptedForAssignment(id, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError) notFound();
    throw err;
  }
  const subcommittees = await listAssignableSubcommittees();

  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Subcommittees", slug: "subcommittees" },
        })}
      />
      <PageHeader title="Assign subcommittees" description={`${cycle.title} — accepted applicants and their ranked preferences.`} />
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Assignment saved.</Alert>}

      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Accepted</TH>
            <TH>Ranked preferences</TH>
            <TH>Assignment</TH>
          </TR>
        </THead>
        <tbody>
          {rows.map((r) => (
            <TR key={r.applicationId}>
              <TD className="font-medium">{r.applicant.firstName} {r.applicant.lastName}</TD>
              <TD className="text-foreground-soft">{r.acceptedDepartments.join(", ")}</TD>
              <TD className="text-foreground-soft">
                {r.ranking.length === 0
                  ? <span className="text-subtle-foreground">None ranked</span>
                  : <ol className="list-decimal pl-4">{r.ranking.map((s) => <li key={s.id}>{s.name}{!s.active && <Badge tone="default" className="ml-1">inactive</Badge>}</li>)}</ol>}
              </TD>
              <TD>
                <form action={assignSubcommitteeAction.bind(null, id, r.applicationId)} className="flex items-center gap-2">
                  <Select name="subcommitteeId" defaultValue={r.assignedSubcommitteeId ?? ""} className="w-44">
                    <option value="">Unassigned</option>
                    {subcommittees.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
                </form>
              </TD>
            </TR>
          ))}
          {rows.length === 0 && (
            <TR>
              <TD colSpan={4} className="py-10 text-center text-subtle-foreground">
                No accepted applicants yet.
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Add the cycle nav link.** In `src/app/(app)/recruitment/cycles/[id]/page.tsx`, add inside the nav `div` (after the Decisions link, only for VOLUNTEER cycles since assignment follows volunteer acceptances):

```tsx
        {cycle.track === "VOLUNTEER" && (
          <Link href={`/recruitment/cycles/${id}/subcommittees`} className={navLink}>Subcommittees</Link>
        )}
```

- [ ] **Step 4: Show ranking + assignment on the applicant detail page.** In `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`:

The `getApplication` include does not load subcommittee names. Add a lightweight resolve at the top of the component after `app` is loaded. Add the import:
```ts
import { prisma } from "@/platform/db";
```

After `const accepted = new Set(...)` (or anywhere after `app` is confirmed), resolve names:
```ts
  const rankIds = [...new Set([...app.subcommitteeRanking, app.assignedSubcommitteeId].filter((x): x is string => Boolean(x)))];
  const subRows = rankIds.length
    ? await prisma.subcommittee.findMany({ where: { id: { in: rankIds } }, select: { id: true, name: true } })
    : [];
  const subName = new Map(subRows.map((s) => [s.id, s.name]));
```

Add a display section (place it after the answer `sections.map(...)` block and before the Decision section):
```tsx
      {(app.subcommitteeRanking.length > 0 || app.assignedSubcommitteeId) && (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Subcommittee</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-subtle-foreground">Ranked preferences</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.subcommitteeRanking.length === 0
                  ? "(none)"
                  : app.subcommitteeRanking.map((sid, i) => `${i + 1}. ${subName.get(sid) ?? "(removed)"}`).join("  ·  ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">Assigned</dt>
              <dd className="mt-0.5 text-sm text-foreground">
                {app.assignedSubcommitteeId ? (subName.get(app.assignedSubcommitteeId) ?? "(removed)") : "Not assigned"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-subtle-foreground">Assign from the cycle&apos;s Subcommittees view.</p>
        </section>
      )}
```

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: PASS for these files (training still red until Task 10).

- [ ] **Step 6: Manual verification.**

Run: `npm run dev`. With a VOLUNTEER cycle that has accepted applicants who ranked subcommittees: open the cycle overview, click "Subcommittees", confirm accepted applicants list with ranked preferences, assign one, see the success alert and the dropdown retain the choice. Open the applicant detail page and confirm the ranking + assignment show.
Expected: assignment persists; detail page reflects it.

- [ ] **Step 7: Commit.**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/subcommittees" "src/app/(app)/recruitment/cycles/[id]/page.tsx" "src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx"
git commit -m "feat(recruitment): assign-subcommittees view + ranking display on applicant detail"
```

---

### Task 10: Remove the free-text training intake field

**Files:**
- Modify: `src/modules/recruitment/services/training.ts`
- Modify: `src/app/(app)/training/training-quiz.tsx`
- Modify: `src/modules/recruitment/services/training.test.ts` (if it references `subcommitteeInterest`)

**Interfaces:**
- Produces: `TrainingIntake` no longer has `subcommitteeInterest`; nothing reads/writes the dropped column.

- [ ] **Step 1: Find every reference.**

Run: `grep -rn "subcommitteeInterest" src`
Expected: matches in `training.ts` (type, read mapping, write), `training-quiz.tsx` (payload + input), possibly `training.test.ts`. Use this list to drive the edits below.

- [ ] **Step 2: Update `TrainingIntake` type.** In `src/modules/recruitment/services/training.ts`, remove the `subcommitteeInterest` line from the type:

```ts
export type TrainingIntake = {
  additionalShiftAvailability?: string | null;
  minShiftsWanted?: string | null;
  feedback?: string | null;
};
```

- [ ] **Step 3: Remove the read mapping.** In `getMyTraining`, change the `intake` object (remove the `subcommitteeInterest` line):

```ts
      intake: {
        additionalShiftAvailability: row?.additionalShiftAvailability ?? null,
        minShiftsWanted: row?.minShiftsWanted ?? null,
        feedback: row?.feedback ?? null,
      },
```

- [ ] **Step 4: Remove the write.** In `submitQuiz`'s `tx.training.update`, remove the `subcommitteeInterest` line:

```ts
      data: {
        additionalShiftAvailability: input.intake.additionalShiftAvailability ?? undefined,
        minShiftsWanted: input.intake.minShiftsWanted ?? undefined,
        feedback: input.intake.feedback ?? undefined,
      },
```

- [ ] **Step 5: Remove the UI input + payload.** In `src/app/(app)/training/training-quiz.tsx`:

Remove from `intakePayload` the line:
```ts
      subcommitteeInterest: (fd.get("subcommitteeInterest") as string) || null,
```

Remove the whole `<Field label="Subcommittee interest"> ... </Field>` block (the first child of the intake grid):
```tsx
          <Field label="Subcommittee interest">
            <input
              name="subcommitteeInterest"
              defaultValue={intake.subcommitteeInterest ?? ""}
              placeholder="e.g. Community Outreach"
              className={fieldInputClass}
            />
          </Field>
```

- [ ] **Step 6: Update any test references.**

Run: `grep -rn "subcommitteeInterest" src`
Expected: NO matches. If `training.test.ts` still asserts on it, remove those assertions/inputs.

- [ ] **Step 7: Typecheck + run training + submissions + subcommittee tests.**

Run: `npm run typecheck`
Expected: PASS (now fully green — the Task 1 cross-file break is resolved).

Run: `npm test -- src/modules/recruitment/services/training.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/modules/recruitment/services/training.ts "src/app/(app)/training/training-quiz.tsx" src/modules/recruitment/services/training.test.ts
git commit -m "refactor(recruitment): remove free-text training subcommittee intake (now ranked at application time)"
```

---

### Task 11: Full verification + docs

**Files:**
- Modify: `CHANGELOG.md` (if present at repo root)

- [ ] **Step 1: Run the full test suite.**

Run: `npm test`
Expected: PASS (all suites, including the new admin, engine, submissions, and subcommittees tests).

- [ ] **Step 2: Lint + typecheck + build.**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 3: Migration status sanity (pre-deploy).**

Run: `npx prisma migrate status`
Expected: "Database schema is up to date" — no pending migrations. (Reminder: previews share the prod DB; this migration must deploy with the branch.)

- [ ] **Step 4: Update CHANGELOG.** If `CHANGELOG.md` exists at the repo root, add a bullet under the current unreleased section:

```markdown
- Recruitment: applicants rank subcommittee preferences on the application form; recruitment leads assign a final subcommittee to accepted applicants. Subcommittees are managed in Admin. Replaces the free-text training subcommittee intake.
```

- [ ] **Step 5: Commit.**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for subcommittee ranking + assignment"
```

---

## Self-Review notes (coverage map)

- Spec §1 data model → Task 1.
- Spec §2 engine/field-type → Task 4.
- Spec §3 capture → Task 5.
- Spec §4 public rendering → Task 6.
- Spec §5 builder settings → Task 7.
- Spec §6 assignment service + view + detail display → Tasks 8, 9.
- Spec §7 admin CRUD → Tasks 2, 3.
- Spec §8 cleanup → Task 10.
- Verification/risks → Task 11 (migrate status, shared-DB reminder).
