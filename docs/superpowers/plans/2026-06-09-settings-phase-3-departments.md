# Settings Phase 3 — Departments CRUD + Delegation Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin UI to create departments, edit their name/active/capacity, soft-deactivate them, and edit delegation relationships — replacing seed/script-only management.

**Architecture:** A `departments` service (mirroring `terms.ts`: typed errors, actor-scoped, audited) plus three admin pages and two form components (mirroring `/admin/terms`). Code is immutable after creation; removal is soft (`isActive=false`); delegations are replaced as a whole set.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), Prisma, Vitest. Reuses: `recordAudit` (`@/platform/audit`), `requirePermission` (`@/platform/auth/session`), UI primitives `PageHeader`/`Table`/`Badge`/`Input`/`Field`/`Button`/`Alert`/`buttonClasses`.

**Spec:** `docs/superpowers/specs/2026-06-09-settings-phase-3-departments-design.md`

**Branch:** `feat/admin-configurable-settings` (same PR #20). Do NOT create a branch.

**Environment:** Run DB tests with plain `npx vitest run <path>` (test DB at localhost:5434 up; never set DATABASE_URL or use `--env-file`). `git add` only the files in each commit step; never `git add -A`.

---

## File Structure

- Create `src/modules/admin/services/departments.ts` (+ test) — service.
- Modify `src/platform/modules/registry.ts` — permission + nav.
- Create `src/modules/admin/components/department-form.tsx` — create/edit form.
- Create `src/modules/admin/components/delegation-editor.tsx` — delegation checklist.
- Create `src/app/admin/departments/page.tsx` — list.
- Create `src/app/admin/departments/new/page.tsx` — create.
- Create `src/app/admin/departments/[id]/page.tsx` — edit + delegations.

---

## Task 1: Departments service

**Files:**
- Create: `src/modules/admin/services/departments.ts`
- Test: `src/modules/admin/services/departments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/admin/services/departments.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listDepartments,
  createDepartment,
  updateDepartment,
  setDelegations,
  DepartmentConflictError,
  DepartmentNotFoundError,
  DepartmentValidationError,
} from "./departments";

beforeEach(resetDb);

describe("createDepartment", () => {
  it("normalizes the code to uppercase and creates", async () => {
    const d = await createDepartment("actor-1", { code: "scts", name: "Surgical Care" });
    expect(d.code).toBe("SCTS");
    expect(d.isActive).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "department.create" } });
    expect(audit).toMatchObject({ entityType: "Department", entityId: d.id });
  });

  it("rejects a duplicate code (case-insensitive)", async () => {
    await createDepartment("a", { code: "PCAR", name: "PCAR" });
    await expect(createDepartment("a", { code: "pcar", name: "again" })).rejects.toBeInstanceOf(
      DepartmentConflictError
    );
  });

  it("rejects a bad code format and an empty name", async () => {
    await expect(createDepartment("a", { code: "a b!", name: "x" })).rejects.toBeInstanceOf(
      DepartmentValidationError
    );
    await expect(createDepartment("a", { code: "OKAY", name: "  " })).rejects.toBeInstanceOf(
      DepartmentValidationError
    );
  });

  it("rejects a non-positive capacity", async () => {
    await expect(
      createDepartment("a", { code: "OKAY", name: "x", idealHeadcount: 0 })
    ).rejects.toBeInstanceOf(DepartmentValidationError);
  });
});

describe("updateDepartment", () => {
  it("updates name/active/capacity and audits before/after; does not change code", async () => {
    const d = await createDepartment("a", { code: "ITCM", name: "Old" });
    const u = await updateDepartment("actor-2", d.id, {
      name: "New",
      isActive: false,
      idealHeadcount: 5,
      patientCapacityPerProvider: null,
    });
    expect(u.code).toBe("ITCM");
    expect(u.name).toBe("New");
    expect(u.isActive).toBe(false);
    expect(u.idealHeadcount).toBe(5);
    const audit = await prisma.auditLog.findFirst({ where: { action: "department.update" } });
    expect(audit?.before).toMatchObject({ name: "Old", isActive: true });
    expect(audit?.after).toMatchObject({ name: "New", isActive: false });
  });

  it("throws DepartmentNotFoundError for a missing id", async () => {
    await expect(
      updateDepartment("a", "nope", { name: "x", isActive: true, idealHeadcount: null, patientCapacityPerProvider: null })
    ).rejects.toBeInstanceOf(DepartmentNotFoundError);
  });
});

describe("setDelegations", () => {
  it("replaces the manager's managed set, excluding self and deduping", async () => {
    const pcar = await createDepartment("a", { code: "PCAR", name: "PCAR" });
    const sctp = await createDepartment("a", { code: "SCTP", name: "SCTP" });
    const jctp = await createDepartment("a", { code: "JCTP", name: "JCTP" });

    await setDelegations("actor", pcar.id, [sctp.id, jctp.id, sctp.id, pcar.id]);
    const rows = await prisma.departmentDelegation.findMany({ where: { managerDepartmentId: pcar.id } });
    expect(rows.map((r) => r.managedDepartmentId).sort()).toEqual([jctp.id, sctp.id].sort());

    // Second call fully replaces (not appends).
    await setDelegations("actor", pcar.id, [jctp.id]);
    const rows2 = await prisma.departmentDelegation.findMany({ where: { managerDepartmentId: pcar.id } });
    expect(rows2.map((r) => r.managedDepartmentId)).toEqual([jctp.id]);
  });

  it("rejects unknown managed ids", async () => {
    const pcar = await createDepartment("a", { code: "PCAR", name: "PCAR" });
    await expect(setDelegations("a", pcar.id, ["ghost"])).rejects.toBeInstanceOf(DepartmentValidationError);
  });
});

describe("listDepartments", () => {
  it("returns active first, then by code, with membership counts and managed ids", async () => {
    const a = await createDepartment("a", { code: "AAA", name: "A" });
    const z = await createDepartment("a", { code: "ZZZ", name: "Z" });
    await updateDepartment("a", a.id, { name: "A", isActive: false, idealHeadcount: null, patientCapacityPerProvider: null });
    await setDelegations("a", z.id, [a.id]);

    const list = await listDepartments();
    expect(list[0].code).toBe("ZZZ"); // active first
    expect(list[0].managesDelegations.map((m) => m.managedDepartmentId)).toEqual([a.id]);
    expect(list[0]._count).toHaveProperty("memberships");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/admin/services/departments.test.ts`
Expected: FAIL — cannot resolve `./departments`.

- [ ] **Step 3: Write the service**

Create `src/modules/admin/services/departments.ts`:

```ts
/**
 * Departments service: create, update (name/active/capacity), delegation editing.
 * Mirrors terms.ts -- typed errors, actor-scoped mutations that audit. Permission
 * checks are the caller's job. Code is immutable after creation; removal is soft
 * (isActive=false).
 */
import type { Department, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";

const CODE_RE = /^[A-Z0-9]{2,12}$/;

export class DepartmentConflictError extends Error {
  constructor(public code: string) {
    super(`A department with code "${code}" already exists.`);
    this.name = "DepartmentConflictError";
  }
}
export class DepartmentNotFoundError extends Error {
  constructor(public id: string) {
    super(`Department ${id} not found.`);
    this.name = "DepartmentNotFoundError";
  }
}
export class DepartmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepartmentValidationError";
  }
}

export type DepartmentRow = Department & {
  _count: { memberships: number };
  managesDelegations: { managedDepartmentId: string }[];
};

/** All departments, active first then by code, with membership counts + managed ids. */
export async function listDepartments(): Promise<DepartmentRow[]> {
  return prisma.department.findMany({
    include: {
      _count: { select: { memberships: true } },
      managesDelegations: { select: { managedDepartmentId: true } },
    },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
}

function validateCapacity(label: string, v: number | null): number | null {
  if (v === null) return null;
  if (!Number.isInteger(v) || v <= 0) {
    throw new DepartmentValidationError(`${label} must be a positive whole number.`);
  }
  return v;
}

export async function createDepartment(
  actorPersonId: string,
  input: {
    code: string;
    name: string;
    isActive?: boolean;
    idealHeadcount?: number | null;
    patientCapacityPerProvider?: number | null;
  }
): Promise<Department> {
  const code = input.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new DepartmentValidationError(
      "Code must be 2-12 uppercase letters or digits (e.g. SCTS)."
    );
  }
  const name = input.name.trim();
  if (!name) throw new DepartmentValidationError("Name is required.");
  const idealHeadcount = validateCapacity("Ideal headcount", input.idealHeadcount ?? null);
  const patientCapacityPerProvider = validateCapacity(
    "Patient capacity per provider",
    input.patientCapacityPerProvider ?? null
  );

  const existing = await prisma.department.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
  });
  if (existing) throw new DepartmentConflictError(code);

  let dept: Department;
  try {
    dept = await prisma.department.create({
      data: { code, name, isActive: input.isActive ?? true, idealHeadcount, patientCapacityPerProvider },
    });
  } catch (err) {
    if (err != null && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      throw new DepartmentConflictError(code);
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "department.create",
    entityType: "Department",
    entityId: dept.id,
    after: { code: dept.code, name: dept.name, isActive: dept.isActive },
  });
  return dept;
}

export async function updateDepartment(
  actorPersonId: string,
  id: string,
  input: { name: string; isActive: boolean; idealHeadcount: number | null; patientCapacityPerProvider: number | null }
): Promise<Department> {
  const before = await prisma.department.findUnique({ where: { id } });
  if (!before) throw new DepartmentNotFoundError(id);

  const name = input.name.trim();
  if (!name) throw new DepartmentValidationError("Name is required.");
  const idealHeadcount = validateCapacity("Ideal headcount", input.idealHeadcount);
  const patientCapacityPerProvider = validateCapacity(
    "Patient capacity per provider",
    input.patientCapacityPerProvider
  );

  const dept = await prisma.department.update({
    where: { id },
    data: { name, isActive: input.isActive, idealHeadcount, patientCapacityPerProvider },
  });

  await recordAudit({
    actorPersonId,
    action: "department.update",
    entityType: "Department",
    entityId: id,
    before: {
      name: before.name,
      isActive: before.isActive,
      idealHeadcount: before.idealHeadcount,
      patientCapacityPerProvider: before.patientCapacityPerProvider,
    },
    after: {
      name: dept.name,
      isActive: dept.isActive,
      idealHeadcount: dept.idealHeadcount,
      patientCapacityPerProvider: dept.patientCapacityPerProvider,
    },
  });
  return dept;
}

/** Replace the manager's full set of managed departments (no self, deduped, validated). */
export async function setDelegations(
  actorPersonId: string,
  managerId: string,
  managedIds: string[]
): Promise<void> {
  const manager = await prisma.department.findUnique({ where: { id: managerId } });
  if (!manager) throw new DepartmentNotFoundError(managerId);

  const unique = [...new Set(managedIds)].filter((mid) => mid !== managerId);
  if (unique.length > 0) {
    const found = await prisma.department.count({ where: { id: { in: unique } } });
    if (found !== unique.length) {
      throw new DepartmentValidationError("One or more selected departments do not exist.");
    }
  }

  const beforeRows = await prisma.departmentDelegation.findMany({
    where: { managerDepartmentId: managerId },
    select: { managedDepartmentId: true },
  });

  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.departmentDelegation.deleteMany({ where: { managerDepartmentId: managerId } }),
  ];
  if (unique.length > 0) {
    ops.push(
      prisma.departmentDelegation.createMany({
        data: unique.map((managedDepartmentId) => ({ managerDepartmentId: managerId, managedDepartmentId })),
      })
    );
  }
  await prisma.$transaction(ops);

  await recordAudit({
    actorPersonId,
    action: "department.set_delegations",
    entityType: "Department",
    entityId: managerId,
    before: { managed: beforeRows.map((r) => r.managedDepartmentId).sort() },
    after: { managed: [...unique].sort() },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/admin/services/departments.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no regression in the delegation helper**

Run: `npx vitest run src/platform/departments.test.ts`
Expected: PASS (the existing `manageableDepartmentIds` behavior is unchanged).

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors.

```bash
git add src/modules/admin/services/departments.ts src/modules/admin/services/departments.test.ts
git commit -m "feat(admin): departments service (create, update, delegations) with audit"
```

---

## Task 2: Permission + nav

**Files:**
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Add the permission + nav item**

In the `admin` manifest in `src/platform/modules/registry.ts`, add `"admin.manage_departments"` to `permissions[]` (after `"admin.manage_settings"`), and add `{ label: "Departments", href: "/admin/departments" }` to `nav` (after the Roles entry):

```ts
      "admin.manage_settings",
      "admin.manage_departments",
    ],
```

```ts
      { label: "Roles", href: "/admin/roles" },
      { label: "Departments", href: "/admin/departments" },
```

- [ ] **Step 2: Verify + commit**

Run: `npx vitest run src/platform/modules` → PASS (the permission is namespaced by `admin.`; nav is unconstrained). Run: `npm run typecheck` → clean.

```bash
git add src/platform/modules/registry.ts
git commit -m "feat(admin): register admin.manage_departments permission and Departments nav"
```

---

## Task 3: Form + delegation-editor components

**Files:**
- Create: `src/modules/admin/components/department-form.tsx`
- Create: `src/modules/admin/components/delegation-editor.tsx`

- [ ] **Step 1: Create the department form**

Create `src/modules/admin/components/department-form.tsx`:

```tsx
import type { Department } from "@prisma/client";
import { Input, Field } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";

type DepartmentFormProps = {
  action: (formData: FormData) => Promise<void>;
  mode: "create" | "edit";
  department?: Pick<Department, "code" | "name" | "isActive" | "idealHeadcount" | "patientCapacityPerProvider">;
  error?: string;
  saved?: string;
};

/** Create/edit form for a Department. Code is editable on create, read-only on edit. */
export function DepartmentForm({ action, mode, department, error, saved }: DepartmentFormProps) {
  return (
    <form action={action} className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">{saved}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Code"
          hint={mode === "edit" ? "Code cannot be changed after creation." : "2-12 letters/digits, e.g. SCTS. Uppercased automatically."}
        >
          <Input
            name="code"
            defaultValue={department?.code ?? ""}
            required={mode === "create"}
            disabled={mode === "edit"}
            placeholder="SCTS"
          />
        </Field>

        <Field label="Name">
          <Input name="name" defaultValue={department?.name ?? ""} required placeholder="Surgical Care Team" />
        </Field>

        <Field label="Ideal headcount" hint="Optional.">
          <Input name="idealHeadcount" type="number" min="1" defaultValue={department?.idealHeadcount ?? ""} />
        </Field>

        <Field label="Patient capacity per provider" hint="Optional.">
          <Input
            name="patientCapacityPerProvider"
            type="number"
            min="1"
            defaultValue={department?.patientCapacityPerProvider ?? ""}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={department?.isActive ?? true} />
        Active
      </label>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" variant="primary">
          {mode === "create" ? "Create department" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Create the delegation editor**

Create `src/modules/admin/components/delegation-editor.tsx`:

```tsx
import { Button } from "@/platform/ui/button";

type Candidate = { id: string; code: string; name: string };

/**
 * Checklist of departments a given (manager) department oversees. Checked = managed.
 * Submitting replaces the whole set via the passed server action.
 */
export function DelegationEditor({
  action,
  candidates,
  selectedIds,
}: {
  action: (formData: FormData) => Promise<void>;
  candidates: Candidate[];
  selectedIds: string[];
}) {
  const selected = new Set(selectedIds);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-gray-600">
        Departments this one manages. A director here also oversees these (one hop).
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm text-gray-400">No other active departments to delegate to.</p>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="managed" value={c.id} defaultChecked={selected.has(c.id)} />
              <span className="font-medium">{c.code}</span>
              <span className="text-gray-500">{c.name}</span>
            </label>
          ))}
        </div>
      )}
      <Button type="submit" variant="outline">Save delegations</Button>
    </form>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors.

```bash
git add src/modules/admin/components/department-form.tsx src/modules/admin/components/delegation-editor.tsx
git commit -m "feat(admin): department form and delegation editor components"
```

---

## Task 4: List + create pages

**Files:**
- Create: `src/app/admin/departments/page.tsx`
- Create: `src/app/admin/departments/new/page.tsx`

- [ ] **Step 1: Create the list page**

Create `src/app/admin/departments/page.tsx`:

```tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listDepartments } from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { buttonClasses } from "@/platform/ui/button";

export default async function DepartmentsListPage() {
  await requirePermission("admin.manage_departments");
  const departments = await listDepartments();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description="Manage departments, their capacity, and delegation (who oversees whom)."
        action={
          <Link href="/admin/departments/new" className={buttonClasses("primary", "sm")}>
            Create department
          </Link>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Code</TH>
            <TH>Name</TH>
            <TH>Status</TH>
            <TH>Manages</TH>
            <TH>Members</TH>
            <TH></TH>
          </TR>
        </THead>
        <tbody>
          {departments.map((d) => (
            <TR key={d.id} className={d.isActive ? "" : "opacity-60"}>
              <TD className="font-medium">{d.code}</TD>
              <TD>{d.name}</TD>
              <TD>
                {d.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Inactive</Badge>}
              </TD>
              <TD>{d.managesDelegations.length}</TD>
              <TD>{d._count.memberships}</TD>
              <TD>
                <Link href={`/admin/departments/${d.id}`} className={buttonClasses("outline", "sm")}>
                  Edit
                </Link>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Create the create page**

Create `src/app/admin/departments/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  createDepartment,
  DepartmentConflictError,
  DepartmentValidationError,
} from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { DepartmentForm } from "@/modules/admin/components/department-form";

function optionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  return Number(raw);
}

type PageProps = { searchParams: Promise<{ error?: string }> };

export default async function NewDepartmentPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_departments");
  const { error } = await searchParams;

  async function createAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    try {
      const dept = await createDepartment(session.personId, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        idealHeadcount: optionalInt(formData.get("idealHeadcount")),
        patientCapacityPerProvider: optionalInt(formData.get("patientCapacityPerProvider")),
      });
      redirect(`/admin/departments/${dept.id}?saved=1`);
    } catch (err) {
      if (err instanceof DepartmentConflictError || err instanceof DepartmentValidationError) {
        redirect(`/admin/departments/new?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Create department" description="Code is permanent once set; the name can change later." />
      <DepartmentForm action={createAction} mode="create" error={error} />
    </div>
  );
}
```

Note: `redirect()` throws, so the success `redirect` must be OUTSIDE the try OR be the last statement after the await — here it is placed inside `try` after the awaited create, which is fine because the only thing that can throw before it is `createDepartment` (caught) and `redirect` itself (its NEXT_REDIRECT is not a DepartmentError, so the `catch` re-throws it). The `instanceof` checks ensure only real validation/conflict errors are caught.

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean. Run: `npm run lint` → no new errors. Run: `npm run build` → succeeds; `/admin/departments` + `/admin/departments/new` in the route manifest.

```bash
git add src/app/admin/departments/page.tsx src/app/admin/departments/new/page.tsx
git commit -m "feat(admin): departments list and create pages"
```

---

## Task 5: Edit page (form + delegation editor)

**Files:**
- Create: `src/app/admin/departments/[id]/page.tsx`

- [ ] **Step 1: Create the edit page**

Create `src/app/admin/departments/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import {
  updateDepartment,
  setDelegations,
  DepartmentNotFoundError,
  DepartmentValidationError,
} from "@/modules/admin/services/departments";
import { PageHeader } from "@/platform/ui/page-header";
import { DepartmentForm } from "@/modules/admin/components/department-form";
import { DelegationEditor } from "@/modules/admin/components/delegation-editor";

function optionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  return Number(raw);
}

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function EditDepartmentPage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_departments");
  const { id } = await params;
  const { error, saved } = await searchParams;

  const department = await prisma.department.findUnique({
    where: { id },
    include: { managesDelegations: { select: { managedDepartmentId: true } } },
  });
  if (!department) notFound();

  // Candidates = all other active departments (delegation targets).
  const candidates = await prisma.department.findMany({
    where: { isActive: true, id: { not: id } },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const selectedIds = department.managesDelegations.map((m) => m.managedDepartmentId);

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    try {
      await updateDepartment(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        idealHeadcount: optionalInt(formData.get("idealHeadcount")),
        patientCapacityPerProvider: optionalInt(formData.get("patientCapacityPerProvider")),
      });
    } catch (err) {
      if (err instanceof DepartmentValidationError || err instanceof DepartmentNotFoundError) {
        redirect(`/admin/departments/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/departments/${id}?saved=1`);
  }

  async function setDelegationsAction(formData: FormData) {
    "use server";
    const session = await requirePermission("admin.manage_departments");
    const managed = formData.getAll("managed").map(String);
    try {
      await setDelegations(session.personId, id, managed);
    } catch (err) {
      if (err instanceof DepartmentValidationError || err instanceof DepartmentNotFoundError) {
        redirect(`/admin/departments/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/departments/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={`Edit ${department.code}`} description="Code is permanent. Toggle Active to deactivate (soft remove)." />
      <DepartmentForm action={updateAction} mode="edit" department={department} error={error} saved={saved} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Delegations</h2>
        <DelegationEditor action={setDelegationsAction} candidates={candidates} selectedIds={selectedIds} />
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` → clean.
Run: `npm run lint` → no new errors.
Run: `npm run build` → succeeds; `/admin/departments/[id]` in the route manifest.

- [ ] **Step 3: Commit**

```bash
git add "src/app/admin/departments/[id]/page.tsx"
git commit -m "feat(admin): department edit page with delegation editor"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (incl. the new departments service tests; existing `manageableDepartmentIds` tests still green).

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck clean; lint clean (no new errors).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds; `/admin/departments`, `/admin/departments/new`, `/admin/departments/[id]` in the manifest.

- [ ] **Step 4: Manual smoke (optional)**

`npm run dev`, sign in as Platform Admin, open `/admin/departments`. Create a department (lowercase code → uppercased); it lands on the edit page. Toggle Active off → it shows Inactive and de-emphasized in the list. On a department's edit page, check some delegations and Save → re-open and confirm they persist. Try a duplicate code → inline error.

- [ ] **Step 5: Final commit (if anything uncommitted)**

```bash
git add -A
git commit -m "chore(admin): Phase 3 departments verification" || echo "nothing to commit"
```

---

## Notes for the implementer

- **Code immutability:** `updateDepartment` has no `code` field; the edit form's code input is `disabled` (so it is not submitted). Do not add code editing.
- **Soft remove:** there is no delete path; the Active checkbox is the only removal mechanism.
- **Delegations are a full replace:** `setDelegations` deletes the manager's edges and recreates the submitted set. Unchecking everything (no `managed` values) clears them.
- **`redirect()` throws:** keep the success `redirect` outside the `try` (or as the final statement) and only catch the typed `Department*Error`s, re-throwing everything else (including Next's `NEXT_REDIRECT`).
- **Audit actions:** `department.create`, `department.update`, `department.set_delegations`.
