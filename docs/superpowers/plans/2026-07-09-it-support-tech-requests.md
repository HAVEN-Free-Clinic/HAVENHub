# IT Support tech request ticketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an IT Support module in HAVEN Hub where any signed-in person submits and tracks tech requests (with comments and attachments), a grantable permission lets managers work a master list, and Epic access requests become one category that reuses and consolidates the existing Epic/YNHH machinery out of `/volunteers/epic` and `/admin/itcm`.

**Architecture:** A new `TechRequest` umbrella model backs a `/support` module. General categories (DUO MFA, General IT, Teams, Other) are self-contained tickets. The Epic category is manager-promoted: a manager links the ticket to a new `EpicRequest`, which flows through the unchanged Epic pipeline. Phase A builds the general helpdesk end to end; Phase B folds Epic in and retires the old surfaces.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma + PostgreSQL (Neon), Vitest (DB-backed, CI-only), Playwright e2e, Vercel Blob storage, the existing `notify()` dispatcher and editable email template engine.

## Global Constraints

Every task's requirements implicitly include this section.

- **No em-dashes** in any code, comment, copy, or commit message. Use commas, colons, parentheses, or "to". (ESLint rule enforces this.)
- **"HAVEN Hub"** is two words in prose and UI; identifiers stay `havenhub`. The module label is "IT Support".
- **Services take an explicit `actorPersonId`** first argument, enforce permission internally where the call site could bypass it, and call `recordAudit` for every mutation. Follow `src/modules/volunteers/services/epic.ts`.
- **`notify(db, input)` is per-person.** For a group (managers), resolve recipients with `peopleWithAnyPermission([...])` and call `notify` per person.
- **Email template engine subset only:** `{{#if}}`, `{{var}}`, `{{{raw}}}`. No `{{#each}}` (renders empty silently). Precompute any list as a string.
- **DB-backed Vitest cannot run in a worktree** (shared stale Prisma client). Do not run `prisma generate` here. After editing `schema.prisma`, run `npx prisma generate` is disallowed in the worktree; instead rely on CI for DB tests. Typecheck (`npx tsc --noEmit`) and `next build` are the local gates. State this in each commit that adds DB tests.
- **Neon migration safety:** previews share the prod DB. Run `npx prisma migrate status` before any deploy. Migrations must be additive and idempotent; RBAC grant changes need an explicit backfill migration (prod runs `migrate deploy`, not the seed).
- **Private Blob storage:** attachments go through `putObject/getObject` (`src/platform/storage.ts`) and are served only through an authenticated route handler with `Content-Disposition: attachment` (never inline, to avoid the stored-MIME XSS class).
- **UI:** reuse `Card`, `Badge` (neutral chip + status dot), `Alert`, `Modal`, `PageHeader`, `SectionHeader`, `ModuleNav`, `Spinner`. Neutral status styling, no tinted fills.
- **Permission strings must be declared** in the owning module's `permissions[]` in `src/platform/modules/registry.ts` or `src/modules/admin/services/rbac.ts` throws `UnknownPermissionError` on any grant write.

---

# Phase A: Foundation and general ticketing

Delivers a working IT helpdesk for the non-Epic categories: submit, track, comment, attach, master list, manager actions, notifications. No Epic code touched.

## Task 1: Data model and migration

**Files:**
- Modify: `prisma/schema.prisma` (new models, enums, Person back-relations)
- Create: `prisma/migrations/20260709120000_tech_requests/migration.sql`

**Interfaces:**
- Produces: models `TechRequest`, `TechRequestComment`, `TechRequestAttachment`; enums `TechRequestCategory`, `TechRequestPriority`, `TechRequestStatus`, `CommentVisibility`. Reuses existing `EpicRequestKind` for `TechRequest.epicSubtype`.

- [ ] **Step 1: Add enums and models to `schema.prisma`**

Add after the `YnhhTicket` model:

```prisma
enum TechRequestCategory {
  EPIC
  DUO_MFA
  GENERAL_IT
  TEAMS
  OTHER
}

enum TechRequestPriority {
  LOW
  MEDIUM
  HIGH
  CRITICAL
}

enum TechRequestStatus {
  SUBMITTED
  IN_PROGRESS
  AWAITING_REQUESTER
  AWAITING_YNHH
  RESOLVED
  CLOSED
  CANCELLED
}

enum CommentVisibility {
  PUBLIC
  INTERNAL
}

/// An IT Support ticket. The umbrella over all tech requests; the EPIC category
/// links to an EpicRequest once a manager promotes it. Cascade-deleted with the
/// requester (the subject of the request).
model TechRequest {
  id            String              @id @default(cuid())
  number        Int                 @unique @default(autoincrement())
  requesterId   String
  category      TechRequestCategory
  epicSubtype   EpicRequestKind?
  subject       String
  description   String
  priority      TechRequestPriority @default(MEDIUM)
  status        TechRequestStatus   @default(SUBMITTED)
  assignedToId  String?
  resolution    String?
  resolvedAt    DateTime?
  epicRequestId String?             @unique
  // EPIC intake fields captured at submit, used when promoting to an EpicRequest.
  epicJobTitle  String?
  epicMirrorId  String?
  epicStartDate DateTime?
  epicEndDate   DateTime?
  worksAtYnhh   Boolean?
  govId         String?
  netId         String?
  createdAt     DateTime            @default(now())
  updatedAt     DateTime            @updatedAt

  /// Subject of the request. Cascade: tickets belong to the requester.
  requester   Person       @relation("techRequestRequester", fields: [requesterId], references: [id], onDelete: Cascade)
  /// Manager assigned to work the ticket. Restrict: an assigned person cannot be deleted out from under open work.
  assignedTo  Person?      @relation("techRequestAssignee", fields: [assignedToId], references: [id], onDelete: Restrict)
  /// The Epic request this ticket was promoted into (EPIC category only). SetNull: keep the ticket if the EpicRequest is removed.
  epicRequest EpicRequest? @relation("techRequestEpic", fields: [epicRequestId], references: [id], onDelete: SetNull)

  comments    TechRequestComment[]
  attachments TechRequestAttachment[]

  @@index([status])
  @@index([requesterId])
  @@index([assignedToId])
}

/// A comment on a TechRequest. PUBLIC is visible to the requester and managers;
/// INTERNAL is manager-only. Cascade-deleted with the ticket.
model TechRequestComment {
  id         String            @id @default(cuid())
  requestId  String
  authorId   String
  body       String
  visibility CommentVisibility @default(PUBLIC)
  createdAt  DateTime          @default(now())

  request     TechRequest             @relation(fields: [requestId], references: [id], onDelete: Cascade)
  /// Author of the comment. Restrict: keep authorship stable for audit.
  author      Person                  @relation("techRequestCommentAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  attachments TechRequestAttachment[]

  @@index([requestId])
}

/// A file attached to a ticket or a comment (exactly one of requestId/commentId).
/// storageKey is the key passed to putObject/getObject; bytes live in Blob.
model TechRequestAttachment {
  id           String   @id @default(cuid())
  requestId    String?
  commentId    String?
  storageKey   String
  filename     String
  mimeType     String
  size         Int
  uploadedById String
  createdAt    DateTime @default(now())

  request    TechRequest?        @relation(fields: [requestId], references: [id], onDelete: Cascade)
  comment    TechRequestComment? @relation(fields: [commentId], references: [id], onDelete: Cascade)
  /// Uploader. Restrict: keep provenance stable for audit.
  uploadedBy Person              @relation("techRequestUploader", fields: [uploadedById], references: [id], onDelete: Restrict)

  @@index([requestId])
  @@index([commentId])
}
```

- [ ] **Step 2: Add the back-relations to `EpicRequest` and `Person`**

In `model EpicRequest`, add one field so the `epicRequest` relation resolves:

```prisma
  /// The IT Support ticket that was promoted into this request, if any.
  techRequest   TechRequest?      @relation("techRequestEpic")
```

In `model Person` (line ~70), add these relation fields alongside the other relation lists:

```prisma
  techRequests         TechRequest[]           @relation("techRequestRequester")
  assignedTechRequests TechRequest[]           @relation("techRequestAssignee")
  techRequestComments  TechRequestComment[]    @relation("techRequestCommentAuthor")
  techRequestUploads   TechRequestAttachment[] @relation("techRequestUploader")
```

- [ ] **Step 3: Write the migration SQL**

Create `prisma/migrations/20260709120000_tech_requests/migration.sql`. Generate the exact statements by diffing locally against a throwaway DB, but the content is additive: `CREATE TYPE` for the four enums, `CREATE TABLE "TechRequest"`, `"TechRequestComment"`, `"TechRequestAttachment"`, their foreign keys, the unique index on `TechRequest.number` and `TechRequest.epicRequestId`, and the `@@index` indexes. No data changes, no drops. Example head:

```sql
-- CreateEnum
CREATE TYPE "TechRequestCategory" AS ENUM ('EPIC', 'DUO_MFA', 'GENERAL_IT', 'TEAMS', 'OTHER');
CREATE TYPE "TechRequestPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "TechRequestStatus" AS ENUM ('SUBMITTED', 'IN_PROGRESS', 'AWAITING_REQUESTER', 'AWAITING_YNHH', 'RESOLVED', 'CLOSED', 'CANCELLED');
CREATE TYPE "CommentVisibility" AS ENUM ('PUBLIC', 'INTERNAL');
-- CreateTable TechRequest, TechRequestComment, TechRequestAttachment, FKs, indexes follow.
```

- [ ] **Step 4: Verify the schema compiles**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid."
(Do not run `prisma generate` or `migrate` in the worktree; CI applies the migration against the test DB.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260709120000_tech_requests
git commit -m "feat(support): TechRequest data model and migration"
```

## Task 2: Support module registration and route scaffold

**Files:**
- Modify: `src/platform/modules/registry.ts` (add the `support` module)
- Create: `src/app/(app)/support/layout.tsx`
- Create: `src/app/(app)/support/page.tsx` (placeholder, replaced in Task 5)
- Test: `src/platform/modules/registry.test.ts` (if one exists; else assert via the access test)

**Interfaces:**
- Produces: module id `support`, permission `support.manage_requests`, routes `/support`, `/support/new`, `/support/all`, `/support/epic`.

- [ ] **Step 1: Add the module manifest**

In `MODULES`, add (import `LifeBuoy` from `lucide-react`):

```ts
{
  id: "support",
  title: "IT Support",
  description: "Submit and track IT and Epic access requests",
  icon: LifeBuoy,
  // No accessPermission: open to any signed-in matched person (like my-info),
  // so anyone can submit. Manager tabs gate on support.manage_requests.
  permissions: ["support.manage_requests"],
  status: "active",
  nav: [
    { label: "My requests", href: "/support" },
    { label: "Submit a request", href: "/support/new" },
    { label: "All requests", href: "/support/all", permission: "support.manage_requests" },
    { label: "Epic / YNHH tools", href: "/support/epic", permission: "support.manage_requests" },
  ],
},
```

- [ ] **Step 2: Create the module layout**

`src/app/(app)/support/layout.tsx` (mirror an existing module layout such as `src/app/(app)/learning/layout.tsx`):

```tsx
import { requireModuleAccess } from "@/platform/auth/session";
import { getEffectivePermissions } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { filterNavItems } from "@/platform/modules/access";
import { ModuleNav } from "@/platform/ui/module-nav";

export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  const session = await requireModuleAccess("support");
  const perms = await getEffectivePermissions(session.personId);
  const mod = getModule("support")!;
  return (
    <>
      <ModuleNav items={filterNavItems(mod.nav, perms)} />
      {children}
    </>
  );
}
```

Match the exact import names and shapes to the reference layout you copy; adjust if `getEffectivePermissions` is accessed differently there.

- [ ] **Step 3: Placeholder page**

`src/app/(app)/support/page.tsx`:

```tsx
import { PageHeader } from "@/platform/ui/page-header";
export default function SupportHome() {
  return <PageHeader title="My requests" description="Your submitted IT Support requests." />;
}
```

- [ ] **Step 4: Verify build and access wiring**

Run: `npx tsc --noEmit`
Expected: no errors.
Run the access unit test if present: `npx vitest run src/platform/modules/access.test.ts`
Expected: PASS (the new module with no `accessPermission` is visible to everyone; manager tabs filtered).

- [ ] **Step 5: Commit**

```bash
git add src/platform/modules/registry.ts src/app/\(app\)/support
git commit -m "feat(support): register IT Support module and route scaffold"
```

## Task 3: TechRequest service core

**Files:**
- Create: `src/modules/support/services/tech-request.ts`
- Test: `src/modules/support/services/tech-request.test.ts`

**Interfaces:**
- Consumes: `prisma`, `recordAudit`, `can` (`@/platform/rbac/engine`), `peopleWithAnyPermission` (`@/platform/rbac/holders`).
- Produces:
  - `class SupportForbiddenError`, `class SupportNotFoundError`, `class SupportStateError`
  - `const MANAGE = "support.manage_requests"`
  - `createTechRequest(actorPersonId, input: CreateTechRequestInput): Promise<TechRequest>`
  - `listMyRequests(personId): Promise<TechRequestListRow[]>`
  - `listAllRequests(actorPersonId, filter: RequestFilter): Promise<{ rows: TechRequestListRow[]; total: number; counts: Record<TechRequestStatus, number> }>`
  - `getTechRequest(actorPersonId, id): Promise<TechRequestDetail>` (throws `SupportNotFoundError` if the actor is neither requester nor a manager)
  - `isManager(personId): Promise<boolean>`
  - Types `CreateTechRequestInput`, `RequestFilter`, `TechRequestListRow`, `TechRequestDetail`

`CreateTechRequestInput`:
```ts
export type CreateTechRequestInput = {
  category: TechRequestCategory;
  subject: string;
  description: string;
  // EPIC-only; ignored for other categories.
  epicSubtype?: EpicRequestKind | null;
  epicJobTitle?: string | null;
  epicMirrorId?: string | null;
  epicStartDate?: Date | null;
  epicEndDate?: Date | null;
  worksAtYnhh?: boolean | null;
  govId?: string | null;
  netId?: string | null;
};
```

- [ ] **Step 1: Write failing tests for create + access-scoped reads**

`src/modules/support/services/tech-request.test.ts` (DB-backed, runs in CI). Use the repo's existing test harness/fixtures for creating a Person and granting a permission (copy the setup from `src/modules/volunteers/services/epic.test.ts`).

```ts
import { describe, it, expect } from "vitest";
import { prisma } from "@/platform/db";
import {
  createTechRequest,
  listMyRequests,
  getTechRequest,
  listAllRequests,
  SupportNotFoundError,
} from "./tech-request";
// import test helpers: makePerson(), grant(personId, permission)

describe("createTechRequest", () => {
  it("creates a SUBMITTED ticket owned by the requester", async () => {
    const p = await makePerson();
    const req = await createTechRequest(p.id, {
      category: "GENERAL_IT",
      subject: "Laptop won't connect",
      description: "Wifi drops on the clinic floor.",
    });
    expect(req.status).toBe("SUBMITTED");
    expect(req.requesterId).toBe(p.id);
    expect(req.priority).toBe("MEDIUM");
    expect(req.number).toBeGreaterThan(0);
  });

  it("rejects a blank subject", async () => {
    const p = await makePerson();
    await expect(
      createTechRequest(p.id, { category: "OTHER", subject: "  ", description: "x" })
    ).rejects.toThrow(/subject/i);
  });
});

describe("read access", () => {
  it("listMyRequests returns only the caller's tickets", async () => {
    const a = await makePerson();
    const b = await makePerson();
    await createTechRequest(a.id, { category: "TEAMS", subject: "A", description: "x" });
    await createTechRequest(b.id, { category: "TEAMS", subject: "B", description: "y" });
    const rows = await listMyRequests(a.id);
    expect(rows.map((r) => r.subject)).toEqual(["A"]);
  });

  it("getTechRequest hides another person's ticket from a non-manager", async () => {
    const owner = await makePerson();
    const stranger = await makePerson();
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(getTechRequest(stranger.id, req.id)).rejects.toThrow(SupportNotFoundError);
  });

  it("getTechRequest lets a manager read any ticket", async () => {
    const owner = await makePerson();
    const mgr = await makePerson();
    await grant(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const detail = await getTechRequest(mgr.id, req.id);
    expect(detail.id).toBe(req.id);
  });

  it("listAllRequests requires the manage permission", async () => {
    const p = await makePerson();
    await expect(listAllRequests(p.id, {})).rejects.toThrow(/permission/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/support/services/tech-request.test.ts`
Expected: FAIL (module not found / functions undefined). If DB tests cannot run locally in the worktree, note that and rely on CI; still verify the file typechecks with `npx tsc --noEmit`.

- [ ] **Step 3: Implement the service**

`src/modules/support/services/tech-request.ts`:

```ts
import type {
  TechRequest,
  TechRequestCategory,
  TechRequestStatus,
  EpicRequestKind,
} from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";

export const MANAGE = "support.manage_requests";
const PAGE_SIZE = 25;

export class SupportForbiddenError extends Error {
  constructor(message = "You do not have permission for this support action.") {
    super(message);
    this.name = "SupportForbiddenError";
  }
}
export class SupportNotFoundError extends Error {
  constructor(message = "Support request not found.") {
    super(message);
    this.name = "SupportNotFoundError";
  }
}
export class SupportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportStateError";
  }
}

export async function isManager(personId: string): Promise<boolean> {
  return can(personId, MANAGE);
}

export type CreateTechRequestInput = {
  category: TechRequestCategory;
  subject: string;
  description: string;
  epicSubtype?: EpicRequestKind | null;
  epicJobTitle?: string | null;
  epicMirrorId?: string | null;
  epicStartDate?: Date | null;
  epicEndDate?: Date | null;
  worksAtYnhh?: boolean | null;
  govId?: string | null;
  netId?: string | null;
};

export async function createTechRequest(
  actorPersonId: string,
  input: CreateTechRequestInput
): Promise<TechRequest> {
  const subject = input.subject?.trim();
  const description = input.description?.trim();
  if (!subject) throw new SupportStateError("A subject is required.");
  if (!description) throw new SupportStateError("A description is required.");

  const isEpic = input.category === "EPIC";
  const epicSubtype = isEpic ? input.epicSubtype ?? null : null;
  if (isEpic && !(epicSubtype && ["NEW", "MODIFY", "RENEW"].includes(epicSubtype))) {
    throw new SupportStateError("Epic requests need a subtype of New, Modification, or Renewal.");
  }

  const req = await prisma.techRequest.create({
    data: {
      requesterId: actorPersonId,
      category: input.category,
      subject,
      description,
      status: "SUBMITTED",
      epicSubtype,
      epicJobTitle: isEpic ? input.epicJobTitle?.trim() || null : null,
      epicMirrorId: isEpic ? input.epicMirrorId?.trim() || null : null,
      epicStartDate: isEpic ? input.epicStartDate ?? null : null,
      epicEndDate: isEpic ? input.epicEndDate ?? null : null,
      worksAtYnhh: isEpic ? input.worksAtYnhh ?? null : null,
      govId: isEpic ? input.govId?.trim() || null : null,
      netId: isEpic ? input.netId?.trim() || null : null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "support.request_create",
    entityType: "TechRequest",
    entityId: req.id,
    after: { category: req.category, number: req.number },
  });

  return req;
}

const LIST_SELECT = {
  id: true,
  number: true,
  category: true,
  epicSubtype: true,
  subject: true,
  priority: true,
  status: true,
  assignedToId: true,
  createdAt: true,
  updatedAt: true,
  requester: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

export type TechRequestListRow = {
  id: string;
  number: number;
  category: TechRequestCategory;
  epicSubtype: EpicRequestKind | null;
  subject: string;
  priority: TechRequest["priority"];
  status: TechRequestStatus;
  assignedToId: string | null;
  createdAt: Date;
  updatedAt: Date;
  requester: { id: string; name: string | null };
  assignedTo: { id: string; name: string | null } | null;
};

export async function listMyRequests(personId: string): Promise<TechRequestListRow[]> {
  return prisma.techRequest.findMany({
    where: { requesterId: personId },
    orderBy: { updatedAt: "desc" },
    select: LIST_SELECT,
  }) as unknown as Promise<TechRequestListRow[]>;
}

export type RequestFilter = {
  status?: TechRequestStatus;
  category?: TechRequestCategory;
  priority?: TechRequest["priority"];
  assignedToId?: string;
  q?: string;
  page?: number;
};

export async function listAllRequests(actorPersonId: string, filter: RequestFilter) {
  if (!(await can(actorPersonId, MANAGE))) throw new SupportForbiddenError(`${MANAGE} is required.`);
  const page = filter.page ?? 1;
  const where: Record<string, unknown> = {};
  if (filter.status) where.status = filter.status;
  if (filter.category) where.category = filter.category;
  if (filter.priority) where.priority = filter.priority;
  if (filter.assignedToId) where.assignedToId = filter.assignedToId;
  if (filter.q?.trim()) {
    const q = filter.q.trim();
    const asNum = Number.parseInt(q, 10);
    where.OR = [
      { subject: { contains: q, mode: "insensitive" } },
      { requester: { name: { contains: q, mode: "insensitive" } } },
      ...(Number.isFinite(asNum) ? [{ number: asNum }] : []),
    ];
  }
  const [rows, total, groupBy] = await Promise.all([
    prisma.techRequest.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: LIST_SELECT,
    }),
    prisma.techRequest.count({ where }),
    prisma.techRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts = {
    SUBMITTED: 0, IN_PROGRESS: 0, AWAITING_REQUESTER: 0, AWAITING_YNHH: 0,
    RESOLVED: 0, CLOSED: 0, CANCELLED: 0,
  } as Record<TechRequestStatus, number>;
  for (const g of groupBy) counts[g.status] = g._count._all;
  return { rows: rows as unknown as TechRequestListRow[], total, counts };
}

export type TechRequestDetail = Awaited<ReturnType<typeof loadDetail>>;

async function loadDetail(id: string) {
  return prisma.techRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, name: true, netId: true, contactEmail: true } },
      assignedTo: { select: { id: true, name: true } },
      epicRequest: true,
      attachments: true,
    },
  });
}

export async function getTechRequest(actorPersonId: string, id: string) {
  const detail = await loadDetail(id);
  if (!detail) throw new SupportNotFoundError();
  const manager = await can(actorPersonId, MANAGE);
  if (!manager && detail.requesterId !== actorPersonId) {
    // Do not leak existence to strangers.
    throw new SupportNotFoundError();
  }
  return detail;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/support/services/tech-request.test.ts` (or confirm in CI)
Expected: PASS. Also `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/tech-request.ts src/modules/support/services/tech-request.test.ts
git commit -m "feat(support): TechRequest service (create, access-scoped reads, master list)"
```

## Task 4: Submit form, submit action, and submission notifications

**Files:**
- Create: `src/modules/support/services/notifications.ts` (support notification helpers)
- Create: `src/modules/support/components/submit-form.tsx` (client, category-conditional fields)
- Create: `src/app/(app)/support/new/page.tsx` (server component + submit action)
- Modify: `src/platform/notifications/registry.ts` (register `support.*` types)
- Test: `src/modules/support/services/notifications.test.ts`

**Interfaces:**
- Consumes: `createTechRequest`, `peopleWithAnyPermission`, `notify`, `renderEmail`, `getSetting`.
- Produces: `notifyTicketSubmitted(db, req, requester)`, plus the notification-type keys `support.ticket_submitted`, `support.request_assigned`, `support.status_changed`, `support.comment_added`, `support.request_resolved`.

- [ ] **Step 1: Register the notification types**

Add to `NOTIFICATION_TYPES` in `src/platform/notifications/registry.ts`:

```ts
  { key: "support.ticket_submitted", label: "IT Support: ticket submitted", defaultChannel: "email" },
  { key: "support.request_assigned", label: "IT Support: request assigned", defaultChannel: "email" },
  { key: "support.status_changed", label: "IT Support: status changed", defaultChannel: "email" },
  { key: "support.comment_added", label: "IT Support: new comment", defaultChannel: "email" },
  { key: "support.request_resolved", label: "IT Support: request resolved", defaultChannel: "email" },
```

- [ ] **Step 2: Write the failing notification test**

`src/modules/support/services/notifications.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { prisma } from "@/platform/db";
import { notifyTicketSubmitted } from "./notifications";
// helpers: makePerson(), grant(), and a way to read queued EmailLog / inbox rows

describe("notifyTicketSubmitted", () => {
  it("confirms to the requester and alerts every manager", async () => {
    const requester = await makePerson({ contactEmail: "req@example.com" });
    const mgr = await makePerson({ contactEmail: "mgr@example.com" });
    await grant(mgr.id, "support.manage_requests");
    const req = await prisma.techRequest.create({
      data: { requesterId: requester.id, category: "GENERAL_IT", subject: "S", description: "d", status: "SUBMITTED" },
    });
    await notifyTicketSubmitted(prisma, req, requester);
    const logs = await prisma.emailLog.findMany({ where: { template: "support.ticket_submitted" } });
    const recipients = logs.map((l) => l.to).sort();
    expect(recipients).toContain("req@example.com");
    expect(recipients).toContain("mgr@example.com");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/notifications.test.ts`
Expected: FAIL (notifyTicketSubmitted undefined).

- [ ] **Step 4: Implement `notifications.ts`**

Use `renderEmail` with a template descriptor for each type (the email template engine reads editable templates; register default template bodies alongside the existing epic templates, following `src/platform/email/templates/`). Keep bodies simple and free of `{{#each}}`.

```ts
import type { Prisma, PrismaClient, TechRequest, Person } from "@prisma/client";
import { notify, type NotifyPerson } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { MANAGE } from "./tech-request";

type Db = PrismaClient | Prisma.TransactionClient;

function ticketLink(baseUrl: string, id: string) {
  return `${baseUrl}/support/${id}`;
}

async function baseUrl() {
  return (await getSetting<string>("app.baseUrl")) ?? "";
}

export async function notifyTicketSubmitted(
  db: Db,
  req: TechRequest,
  requester: Pick<Person, "id" | "name" | "entraObjectId" | "contactEmail">
): Promise<void> {
  const url = await baseUrl();
  const link = ticketLink(url, req.id);

  // Confirmation to the requester.
  const conf = await renderEmail("support.ticket_submitted", {
    ticketNumber: req.number,
    subject: req.subject,
    link,
    recipientRole: "requester",
  });
  await notify(db, {
    type: "support.ticket_submitted",
    person: requester as NotifyPerson,
    email: { subject: conf.subject, html: conf.html },
    teams: { title: `IT Support #${req.number} received`, summary: req.subject, link },
    triggeredById: requester.id,
  });

  // Alert every manager (per-person fan-out).
  const managers = await peopleWithAnyPermission([MANAGE]);
  for (const m of managers) {
    if (m.id === requester.id) continue;
    const mgr = await renderEmail("support.ticket_submitted", {
      ticketNumber: req.number,
      subject: req.subject,
      link,
      recipientRole: "manager",
      requesterName: requester.name ?? "A volunteer",
    });
    await notify(db, {
      type: "support.ticket_submitted",
      person: m as NotifyPerson,
      email: { subject: mgr.subject, html: mgr.html },
      teams: { title: `New IT Support #${req.number}`, summary: req.subject, link },
      triggeredById: requester.id,
    });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/modules/support/services/notifications.test.ts` (or CI). Expected: PASS.

- [ ] **Step 6: Build the submit form component**

`src/modules/support/components/submit-form.tsx` (client component). Category select drives conditional Epic fields; no priority field (manager-owned). Use existing form primitives. The Epic block shows: subtype (New/Modification/Renewal), job title, Epic ID to mirror, start/end dates, "currently works at YNHHS?" (checkbox), government ID / NPI, NetID. Submit posts to the page's server action.

- [ ] **Step 7: Wire the submit page + action**

`src/app/(app)/support/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { prisma } from "@/platform/db";
import { createTechRequest } from "@/modules/support/services/tech-request";
import { notifyTicketSubmitted } from "@/modules/support/services/notifications";
import { SubmitForm } from "@/modules/support/components/submit-form";
import type { TechRequestCategory, EpicRequestKind } from "@prisma/client";

export default async function SubmitPage() {
  await requireModuleAccess("support");

  async function submitAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("support");
    const category = formData.get("category") as TechRequestCategory;
    const req = await createTechRequest(session.personId, {
      category,
      subject: (formData.get("subject") as string) ?? "",
      description: (formData.get("description") as string) ?? "",
      epicSubtype: (formData.get("epicSubtype") as EpicRequestKind) || null,
      epicJobTitle: (formData.get("epicJobTitle") as string) || null,
      epicMirrorId: (formData.get("epicMirrorId") as string) || null,
      worksAtYnhh: formData.get("worksAtYnhh") === "on",
      govId: (formData.get("govId") as string) || null,
      netId: (formData.get("netId") as string) || null,
      // dates parsed from formData when present
    });
    const requester = await prisma.person.findUniqueOrThrow({
      where: { id: session.personId },
      select: { id: true, name: true, entraObjectId: true, contactEmail: true },
    });
    await notifyTicketSubmitted(prisma, req, requester);
    redirect(`/support/${req.id}?submitted=1`);
  }

  return (
    <>
      <PageHeader title="Submit a request" description="Tell IT what you need. You can track it under My requests." />
      <SubmitForm action={submitAction} />
    </>
  );
}
```

Handle `SupportStateError` by redirecting back with an `error` param (mirror the My Info pattern).

- [ ] **Step 8: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean.

```bash
git add src/modules/support src/app/\(app\)/support/new src/platform/notifications/registry.ts
git commit -m "feat(support): submit form, create action, submission notifications"
```

## Task 5: My requests list and ticket detail (owner view)

**Files:**
- Create: `src/modules/support/components/request-list.tsx` (shared list table)
- Create: `src/modules/support/components/status-badge.tsx` (neutral Badge + status dot)
- Create: `src/modules/support/components/ticket-detail.tsx` (renders detail; `canManage` prop toggles manager controls)
- Modify: `src/app/(app)/support/page.tsx` (My requests)
- Create: `src/app/(app)/support/[id]/page.tsx` (detail)

**Interfaces:**
- Consumes: `listMyRequests`, `getTechRequest`, `isManager`.
- Produces: `RequestList`, `SupportStatusBadge`, `TicketDetail` components.

- [ ] **Step 1: My requests page**

`src/app/(app)/support/page.tsx`:

```tsx
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listMyRequests } from "@/modules/support/services/tech-request";
import { RequestList } from "@/modules/support/components/request-list";

export default async function MyRequestsPage() {
  const session = await requireModuleAccess("support");
  const rows = await listMyRequests(session.personId);
  return (
    <>
      <PageHeader title="My requests" description="Requests you have submitted to IT Support." />
      <RequestList rows={rows} hrefBase="/support" showRequester={false} />
    </>
  );
}
```

- [ ] **Step 2: Status badge**

`src/modules/support/components/status-badge.tsx`: map each `TechRequestStatus` to a neutral label + dot color, using the `Badge` primitive (no tinted fills). Provide a `STATUS_LABELS` map (`SUBMITTED -> "Submitted"`, `AWAITING_REQUESTER -> "Awaiting you"`, `AWAITING_YNHH -> "Awaiting YNHH"`, etc.).

- [ ] **Step 3: Request list component**

`src/modules/support/components/request-list.tsx`: a table of number, subject, category, status badge, updated. `showRequester` adds a requester column for the manager view. Row links to `${hrefBase}/${id}`.

- [ ] **Step 4: Ticket detail (owner-facing parts)**

`src/modules/support/components/ticket-detail.tsx`: renders header (number, subject, category, status), the description, the resolution when present, and slots for the comment thread and attachments (added in Tasks 6 and 7). A `canManage` prop (default false) gates manager-only sections; keep it false here.

`src/app/(app)/support/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { getTechRequest, isManager, SupportNotFoundError } from "@/modules/support/services/tech-request";
import { TicketDetail } from "@/modules/support/components/ticket-detail";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireModuleAccess("support");
  const { id } = await params;
  let detail;
  try {
    detail = await getTechRequest(session.personId, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) notFound();
    throw e;
  }
  const canManage = await isManager(session.personId);
  return <TicketDetail detail={detail} canManage={canManage} />;
}
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit`. Expected: clean.

```bash
git add src/modules/support/components src/app/\(app\)/support/page.tsx src/app/\(app\)/support/\[id\]
git commit -m "feat(support): my requests list and ticket detail (owner view)"
```

## Task 6: Comments (public + internal) with notifications

**Files:**
- Create: `src/modules/support/services/comments.ts`
- Create: `src/modules/support/components/comment-thread.tsx`
- Modify: `src/modules/support/components/ticket-detail.tsx` (render the thread + reply form)
- Modify: `src/app/(app)/support/[id]/page.tsx` (add comment server action)
- Test: `src/modules/support/services/comments.test.ts`

**Interfaces:**
- Produces:
  - `addComment(actorPersonId, requestId, input: { body: string; visibility: CommentVisibility }): Promise<TechRequestComment>` (INTERNAL requires MANAGE; a non-manager may only post PUBLIC and only on their own ticket)
  - `listComments(actorPersonId, requestId): Promise<CommentRow[]>` (INTERNAL rows filtered out for non-managers)
  - `notifyCommentAdded(db, req, comment, author)` (routes to the other side; INTERNAL notifies no one)

- [ ] **Step 1: Failing tests for visibility rules**

```ts
describe("comments visibility", () => {
  it("hides INTERNAL comments from the requester", async () => {
    const owner = await makePerson();
    const mgr = await makePerson();
    await grant(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await addComment(mgr.id, req.id, { body: "internal triage", visibility: "INTERNAL" });
    await addComment(mgr.id, req.id, { body: "hello requester", visibility: "PUBLIC" });
    const ownerView = await listComments(owner.id, req.id);
    expect(ownerView.map((c) => c.body)).toEqual(["hello requester"]);
    const mgrView = await listComments(mgr.id, req.id);
    expect(mgrView).toHaveLength(2);
  });

  it("forbids a non-manager from posting INTERNAL", async () => {
    const owner = await makePerson();
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(addComment(owner.id, req.id, { body: "x", visibility: "INTERNAL" })).rejects.toThrow();
  });

  it("forbids commenting on someone else's ticket as a non-manager", async () => {
    const owner = await makePerson();
    const stranger = await makePerson();
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(addComment(stranger.id, req.id, { body: "x", visibility: "PUBLIC" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/modules/support/services/comments.test.ts` -> FAIL.

- [ ] **Step 3: Implement `comments.ts`**

```ts
import type { Prisma, PrismaClient, TechRequest, TechRequestComment, CommentVisibility, Person } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { notify, type NotifyPerson } from "@/platform/notifications/notify";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { getSetting } from "@/platform/settings/service";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { MANAGE, SupportForbiddenError, SupportNotFoundError } from "./tech-request";

export async function addComment(
  actorPersonId: string,
  requestId: string,
  input: { body: string; visibility: CommentVisibility }
): Promise<TechRequestComment> {
  const body = input.body?.trim();
  if (!body) throw new SupportForbiddenError("A comment body is required.");
  const req = await prisma.techRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new SupportNotFoundError();

  const manager = await can(actorPersonId, MANAGE);
  if (!manager) {
    if (req.requesterId !== actorPersonId) throw new SupportNotFoundError();
    if (input.visibility === "INTERNAL") throw new SupportForbiddenError("Only managers can post internal notes.");
  }

  const comment = await prisma.techRequestComment.create({
    data: { requestId, authorId: actorPersonId, body, visibility: input.visibility },
  });
  await prisma.techRequest.update({ where: { id: requestId }, data: { updatedAt: new Date() } });
  await recordAudit({
    actorPersonId, action: "support.comment_add", entityType: "TechRequest",
    entityId: requestId, after: { visibility: input.visibility },
  });
  return comment;
}

export type CommentRow = TechRequestComment & { author: { id: string; name: string | null } };

export async function listComments(actorPersonId: string, requestId: string): Promise<CommentRow[]> {
  const req = await prisma.techRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new SupportNotFoundError();
  const manager = await can(actorPersonId, MANAGE);
  if (!manager && req.requesterId !== actorPersonId) throw new SupportNotFoundError();
  return prisma.techRequestComment.findMany({
    where: { requestId, ...(manager ? {} : { visibility: "PUBLIC" }) },
    orderBy: { createdAt: "asc" },
    include: { author: { select: { id: true, name: true } } },
  }) as unknown as Promise<CommentRow[]>;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function notifyCommentAdded(
  db: Db, req: TechRequest, comment: TechRequestComment,
  author: Pick<Person, "id" | "name">
): Promise<void> {
  if (comment.visibility === "INTERNAL") return; // internal notes notify no one submitter-side
  const url = (await getSetting<string>("app.baseUrl")) ?? "";
  const link = `${url}/support/${req.id}`;
  const authorIsRequester = author.id === req.requesterId;

  const recipients: NotifyPerson[] = [];
  if (authorIsRequester) {
    // Notify the assignee if set, else all managers.
    if (req.assignedToId) {
      const a = await prisma.person.findUnique({
        where: { id: req.assignedToId },
        select: { id: true, entraObjectId: true, contactEmail: true },
      });
      if (a) recipients.push(a);
    } else {
      const managers = await peopleWithAnyPermission([MANAGE]);
      recipients.push(...managers.map((m) => ({ id: m.id, entraObjectId: m.entraObjectId, contactEmail: m.contactEmail })));
    }
  } else {
    // A manager's PUBLIC comment notifies the requester.
    const r = await prisma.person.findUnique({
      where: { id: req.requesterId },
      select: { id: true, entraObjectId: true, contactEmail: true },
    });
    if (r) recipients.push(r);
  }

  const rendered = await renderEmail("support.comment_added", {
    ticketNumber: req.number, subject: req.subject, link,
    authorName: author.name ?? "Someone",
  });
  for (const p of recipients) {
    if (p.id === author.id) continue;
    await notify(db, {
      type: "support.comment_added",
      person: p,
      email: { subject: rendered.subject, html: rendered.html },
      teams: { title: `IT Support #${req.number}: new reply`, summary: req.subject, link },
      triggeredById: author.id,
    });
  }
}
```

- [ ] **Step 4: Run tests -> PASS** (or CI). `npx tsc --noEmit` clean.

- [ ] **Step 5: Comment thread UI + reply action**

Add `comment-thread.tsx` (renders PUBLIC conversation for everyone, plus an INTERNAL notes section shown only when `canManage`). Add a reply form. In `[id]/page.tsx`, add a `commentAction` server action that calls `addComment` then `notifyCommentAdded` and redirects back to the ticket. Managers get a visibility toggle (Public reply / Internal note); requesters get PUBLIC only.

- [ ] **Step 6: Commit**

```bash
git add src/modules/support/services/comments.ts src/modules/support/services/comments.test.ts src/modules/support/components/comment-thread.tsx src/modules/support/components/ticket-detail.tsx "src/app/(app)/support/[id]/page.tsx"
git commit -m "feat(support): public/internal comments with routed notifications"
```

## Task 7: Attachments (upload on ticket + comment, authenticated download)

**Files:**
- Create: `src/modules/support/services/attachments.ts` (validate + persist + list + authorize)
- Create: `src/app/(app)/support/attachment/[id]/route.ts` (authenticated download)
- Modify: submit action, comment action, and `submit-form` / `comment-thread` to accept files
- Modify: `ticket-detail.tsx` (render attachment links)
- Test: `src/modules/support/services/attachments.test.ts`

**Interfaces:**
- Produces:
  - `validateSupportUpload(file: { fileName: string; mimeType: string; size: number }): string | null` (returns an error message or null)
  - `persistAttachment(actorPersonId, target: { requestId?: string; commentId?: string }, file: { fileName: string; mimeType: string; bytes: Buffer }): Promise<TechRequestAttachment>`
  - `getAttachmentForDownload(actorPersonId, attachmentId): Promise<{ bytes: Buffer; filename: string; mimeType: string }>` (enforces requester-or-manager, INTERNAL-comment attachments manager-only)

- [ ] **Step 1: Failing test for the MIME/size guard and download authorization**

```ts
describe("validateSupportUpload", () => {
  it("rejects an executable and oversize file, accepts a png", () => {
    expect(validateSupportUpload({ fileName: "x.exe", mimeType: "application/x-msdownload", size: 10 })).toMatch(/type/i);
    expect(validateSupportUpload({ fileName: "big.png", mimeType: "image/png", size: 999 * 1024 * 1024 })).toMatch(/large/i);
    expect(validateSupportUpload({ fileName: "shot.png", mimeType: "image/png", size: 1024 })).toBeNull();
  });
});

describe("getAttachmentForDownload", () => {
  it("denies a stranger", async () => {
    const owner = await makePerson();
    const stranger = await makePerson();
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    const att = await persistAttachment(owner.id, { requestId: req.id }, { fileName: "a.png", mimeType: "image/png", bytes: Buffer.from("x") });
    await expect(getAttachmentForDownload(stranger.id, att.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement `attachments.ts`**

Allowlist safe types (images, pdf, plain text, common office docs); cap size at `getSetting<number>("uploads.maxMb")` (fallback 10). Store bytes with `putObject(key, bytes, mimeType)` using key `support/<requestId|commentId>/<uuid><ext>`. Authorization for download resolves the parent ticket (directly or via the comment), then requires requester-or-manager; if the attachment hangs off an INTERNAL comment, require MANAGE.

```ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TechRequestAttachment } from "@prisma/client";
import { prisma } from "@/platform/db";
import { putObject, getObject } from "@/platform/storage";
import { getSetting } from "@/platform/settings/service";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { MANAGE, SupportForbiddenError, SupportNotFoundError } from "./tech-request";

const ALLOWED = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function validateSupportUpload(file: { fileName: string; mimeType: string; size: number }, maxMb = 10): string | null {
  if (!ALLOWED.has(file.mimeType)) return "File type not allowed. Attach an image, PDF, text, or Office document.";
  if (file.size > maxMb * 1024 * 1024) return `File is too large (max ${maxMb} MB).`;
  return null;
}

export async function persistAttachment(
  actorPersonId: string,
  target: { requestId?: string; commentId?: string },
  file: { fileName: string; mimeType: string; bytes: Buffer }
): Promise<TechRequestAttachment> {
  const maxMb = (await getSetting<number>("uploads.maxMb")) ?? 10;
  const err = validateSupportUpload({ fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.length }, maxMb);
  if (err) throw new SupportForbiddenError(err);

  const scope = target.requestId ?? target.commentId!;
  const ext = path.extname(file.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  const key = `support/${scope}/${randomUUID()}${ext}`;
  await putObject(key, file.bytes, file.mimeType);

  const att = await prisma.techRequestAttachment.create({
    data: {
      requestId: target.requestId ?? null,
      commentId: target.commentId ?? null,
      storageKey: key,
      filename: file.fileName,
      mimeType: file.mimeType,
      size: file.bytes.length,
      uploadedById: actorPersonId,
    },
  });
  await recordAudit({ actorPersonId, action: "support.attachment_add", entityType: "TechRequestAttachment", entityId: att.id });
  return att;
}

export async function getAttachmentForDownload(actorPersonId: string, attachmentId: string) {
  const att = await prisma.techRequestAttachment.findUnique({
    where: { id: attachmentId },
    include: { request: true, comment: { include: { request: true } } },
  });
  if (!att) throw new SupportNotFoundError();
  const req = att.request ?? att.comment?.request;
  if (!req) throw new SupportNotFoundError();
  const manager = await can(actorPersonId, MANAGE);
  if (!manager && req.requesterId !== actorPersonId) throw new SupportNotFoundError();
  if (!manager && att.comment?.visibility === "INTERNAL") throw new SupportNotFoundError();
  const bytes = await getObject(att.storageKey);
  if (!bytes) throw new SupportNotFoundError();
  return { bytes, filename: att.filename, mimeType: att.mimeType };
}
```

- [ ] **Step 4: Download route (force attachment disposition)**

`src/app/(app)/support/attachment/[id]/route.ts`:

```ts
import { requirePersonSession } from "@/platform/auth/session";
import { getAttachmentForDownload, SupportNotFoundError } from "@/modules/support/services/attachments";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePersonSession();
  const { id } = await params;
  try {
    const { bytes, filename, mimeType } = await getAttachmentForDownload(session.personId, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mimeType,
        // Force download; never render inline (stored-MIME XSS guard).
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  } catch (e) {
    if (e instanceof SupportNotFoundError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
```

Confirm `requirePersonSession` is the correct import for a route handler (mirror `src/app/(app)/my-info/certificate/[id]/route.ts`).

- [ ] **Step 5: Wire uploads into the submit and comment actions**

Parse files from `formData.getAll("attachments")`, convert to Buffer, and call `persistAttachment` after creating the ticket/comment. Render attachment lists in `ticket-detail.tsx` / `comment-thread.tsx` as links to `/support/attachment/<id>`.

- [ ] **Step 6: Run tests -> PASS. tsc clean. Commit.**

```bash
git add src/modules/support/services/attachments.ts src/modules/support/services/attachments.test.ts "src/app/(app)/support/attachment/[id]/route.ts" src/modules/support/components src/app/\(app\)/support
git commit -m "feat(support): ticket and comment attachments with authenticated download"
```

## Task 8: Master list (All requests) for managers

**Files:**
- Create: `src/app/(app)/support/all/page.tsx`
- Create: `src/modules/support/components/request-filters.tsx` (client filter bar)

**Interfaces:**
- Consumes: `listAllRequests`, `RequestList`.

- [ ] **Step 1: Page with filters**

`src/app/(app)/support/all/page.tsx` gates on the permission and reads filters from `searchParams`:

```tsx
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listAllRequests } from "@/modules/support/services/tech-request";
import { RequestList } from "@/modules/support/components/request-list";
import { RequestFilters } from "@/modules/support/components/request-filters";

export default async function AllRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const session = await requirePermission("support.manage_requests");
  const sp = await searchParams;
  const { rows, total, counts } = await listAllRequests(session.personId, {
    status: sp.status as never, category: sp.category as never,
    priority: sp.priority as never, assignedToId: sp.assignee, q: sp.q,
    page: sp.page ? Number(sp.page) : 1,
  });
  return (
    <>
      <PageHeader title="All requests" description="Every IT Support request across the clinic." />
      <RequestFilters counts={counts} total={total} />
      <RequestList rows={rows} hrefBase="/support" showRequester />
    </>
  );
}
```

- [ ] **Step 2: Filter bar** renders status/category/priority selects + a search box that update the query string (follow the Epic queue's status-filter pattern).

- [ ] **Step 3: tsc clean. Commit.**

```bash
git add src/app/\(app\)/support/all src/modules/support/components/request-filters.tsx
git commit -m "feat(support): manager master list with filters"
```

## Task 9: Manager ticket actions (assign, status, priority, resolve, cancel)

**Files:**
- Create: `src/modules/support/services/manage.ts`
- Modify: `ticket-detail.tsx` (manager control panel when `canManage`)
- Modify: `src/app/(app)/support/[id]/page.tsx` (manager server actions)
- Test: `src/modules/support/services/manage.test.ts`

**Interfaces:**
- Produces (all require MANAGE, all audit, all notify where noted):
  - `assignRequest(actor, id, assigneeId | null)` -> notifies the new assignee (`support.request_assigned`)
  - `setStatus(actor, id, status)` -> notifies the requester on `AWAITING_REQUESTER` (`support.status_changed`)
  - `setPriority(actor, id, priority)`
  - `resolveRequest(actor, id, resolution)` -> sets `RESOLVED` + `resolvedAt`, notifies requester (`support.request_resolved`)
  - `cancelRequest(actor, id, reason)` (manager) and `cancelOwnRequest(requester, id)` (owner, only while open)

- [ ] **Step 1: Failing tests**

```ts
describe("manage", () => {
  it("assign requires the manage permission", async () => {
    const p = await makePerson();
    const req = await createTechRequest(p.id, { category: "OTHER", subject: "S", description: "d" });
    await expect(assignRequest(p.id, req.id, p.id)).rejects.toThrow(/permission/i);
  });

  it("resolveRequest sets RESOLVED with resolvedAt and a resolution", async () => {
    const owner = await makePerson();
    const mgr = await makePerson();
    await grant(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await resolveRequest(mgr.id, req.id, "Reset the account.");
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("Reset the account.");
  });

  it("owner can cancel their own open ticket", async () => {
    const owner = await makePerson();
    const req = await createTechRequest(owner.id, { category: "OTHER", subject: "S", description: "d" });
    await cancelOwnRequest(owner.id, req.id);
    const after = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("CANCELLED");
  });
});
```

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement `manage.ts`** following the epic service conventions (guard with `can(actor, MANAGE)`, load-or-throw `SupportNotFoundError`, block transitions out of terminal states with `SupportStateError`, audit each). For notifications reuse `renderEmail` + `notify` per-person; `resolveRequest` and `setStatus(AWAITING_REQUESTER)` target the requester, `assignRequest` targets the assignee. `cancelOwnRequest` checks `req.requesterId === actor` and `status` is a non-terminal value.

- [ ] **Step 4: Manager control panel UI** in `ticket-detail.tsx` behind `canManage`: assignee select (managers list via `peopleWithAnyPermission`), status select, priority select, resolve form (textarea + button), cancel button. Owner-facing cancel button appears for the requester while the ticket is open. Wire each to a server action in `[id]/page.tsx`.

- [ ] **Step 5: Run -> PASS. tsc clean. Commit.**

```bash
git add src/modules/support/services/manage.ts src/modules/support/services/manage.test.ts src/modules/support/components/ticket-detail.tsx "src/app/(app)/support/[id]/page.tsx"
git commit -m "feat(support): manager actions (assign, status, priority, resolve, cancel) + notifications"
```

## Task 10: Email templates for the support notification types

**Files:**
- Create/seed the editable email templates for the five `support.*` descriptors (follow `src/platform/email/templates/epic.ts` and the template registry the render engine reads).
- Test: golden render test if the repo has one for email templates (mirror the epic email test).

- [ ] **Step 1:** Add each `support.*` template with a subject and an HTML body wrapped by the shared email layout, using only `{{#if}}`/`{{var}}`/`{{{raw}}}`. Include the `link`, `ticketNumber`, `subject`, and role-specific copy (requester vs manager). No `{{#each}}`.

- [ ] **Step 2:** Verify the render test passes (or add one asserting the subject/body render for a sample context). `npx tsc --noEmit` clean.

- [ ] **Step 3: Commit.**

```bash
git add src/platform/email/templates
git commit -m "feat(support): email templates for support notification types"
```

---

# Phase B: Epic consolidation

Folds Epic into the module, migrates the permission, and retires the old surfaces. After this phase, `/volunteers/epic`, `/admin/itcm`, and the My Info Epic panel are gone.

## Task 11: Move Epic + ITCM services under `support` and re-gate

**Files:**
- Move: `src/modules/volunteers/services/epic.ts` -> `src/modules/support/services/epic.ts` (and its test)
- Move: `src/modules/admin/services/itcm.ts`, `itcm-pdf.ts` -> `src/modules/support/services/`
- Modify: all importers (`src/platform/people.ts`, `src/modules/volunteers/services/offboarding.ts`, My Info page, admin pages, generate route, tests)

**Interfaces:** unchanged function signatures; only the internal permission string changes.

- [ ] **Step 1:** Move the files and update every import path (use a repo-wide search for `services/epic` and `services/itcm`). Keep function names identical.

- [ ] **Step 2:** In the moved `epic.ts`, change `requireManageEpic` (and the inline `can(..., "volunteers.manage_epic")` in `createEpicRequest`) to check `"support.manage_requests"`. Update the doc comment block accordingly.

- [ ] **Step 3:** In the moved `itcm` generate logic, change the `can(actor.id, "admin.access")` gate to `"support.manage_requests"`.

- [ ] **Step 4:** Run `npx tsc --noEmit` and fix all broken imports. Run the moved unit tests in CI. Commit.

```bash
git add -A
git commit -m "refactor(support): relocate Epic + ITCM services into the support module, re-gate to support.manage_requests"
```

## Task 12: Permission migration and backfill

**Files:**
- Modify: `src/platform/modules/registry.ts` (remove `volunteers.manage_epic` from the Volunteers `permissions[]` and its nav entry; the `support.manage_requests` is already declared)
- Modify: `src/platform/rbac/system-roles.ts` (swap the grant on "Volunteer Operations Manager")
- Create: `prisma/migrations/20260709130000_support_manage_requests_grant/migration.sql`

- [ ] **Step 1:** In `system-roles.ts`, change the "Volunteer Operations Manager" grants: replace `"volunteers.manage_epic"` with `"support.manage_requests"`.

- [ ] **Step 2:** Remove `"volunteers.manage_epic"` from the Volunteers module `permissions[]` and delete the `{ label: "Epic requests", ... }` nav item (that route is retired in Task 15).

- [ ] **Step 3:** Write the backfill migration (idempotent, copy the `20260629160000_grant_manage_roster_permission` pattern). Grant `support.manage_requests` to every role that currently grants `volunteers.manage_epic`, then delete the old grants:

```sql
-- Migrate Epic management onto the unified support permission.
-- 1. Every role granting volunteers.manage_epic now grants support.manage_requests.
INSERT INTO "RoleGrant" ("id", "roleId", "permission")
SELECT gen_random_uuid()::text, rg."roleId", 'support.manage_requests'
FROM "RoleGrant" rg
WHERE rg."permission" = 'volunteers.manage_epic'
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 2. Remove the retired permission so the roles UI (which validates against the
--    registry on write) and effective-permission reads stay consistent.
DELETE FROM "RoleGrant" WHERE "permission" = 'volunteers.manage_epic';
```

- [ ] **Step 4:** `npx prisma validate`; `npx tsc --noEmit`. Verify `src/modules/admin/services/rbac.ts` VALID_PERMISSIONS no longer needs `volunteers.manage_epic` (it derives from the registry, so removing it there is sufficient). Commit.

```bash
git add src/platform/modules/registry.ts src/platform/rbac/system-roles.ts prisma/migrations/20260709130000_support_manage_requests_grant
git commit -m "feat(support): migrate volunteers.manage_epic to support.manage_requests with backfill"
```

## Task 13: Epic promotion and inline Epic pipeline on the ticket

**Files:**
- Create: `src/modules/support/services/epic-link.ts` (`promoteToEpic`)
- Modify: `ticket-detail.tsx` (Epic category section: intake fields, "Create Epic request", and, once linked, the Epic pipeline controls)
- Modify: `src/app/(app)/support/[id]/page.tsx` (promotion + Epic pipeline server actions)
- Test: `src/modules/support/services/epic-link.test.ts`

**Interfaces:**
- Produces: `promoteToEpic(actorPersonId, techRequestId): Promise<EpicRequest>` (requires MANAGE; ticket must be EPIC category with a valid subtype and not already linked; creates an `EpicRequest` from the intake fields via `createEpicRequest`, links it via `TechRequest.epicRequestId`, sets ticket status `IN_PROGRESS`).

- [ ] **Step 1: Failing test**

```ts
describe("promoteToEpic", () => {
  it("links a new EpicRequest carrying the intake fields", async () => {
    const owner = await makePerson({ status: "ACTIVE" });
    const mgr = await makePerson();
    await grant(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, {
      category: "EPIC", epicSubtype: "NEW", subject: "Need Epic", description: "New volunteer",
      epicJobTitle: "Scribe", epicMirrorId: "EPIC123",
    });
    const epic = await promoteToEpic(mgr.id, req.id);
    expect(epic.kind).toBe("NEW");
    expect(epic.jobTitle).toBe("Scribe");
    const linked = await prisma.techRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(linked.epicRequestId).toBe(epic.id);
    expect(linked.status).toBe("IN_PROGRESS");
  });

  it("refuses to promote a non-Epic ticket", async () => {
    const owner = await makePerson();
    const mgr = await makePerson();
    await grant(mgr.id, "support.manage_requests");
    const req = await createTechRequest(owner.id, { category: "GENERAL_IT", subject: "S", description: "d" });
    await expect(promoteToEpic(mgr.id, req.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement `epic-link.ts`**

```ts
import type { EpicRequest } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { can } from "@/platform/rbac/engine";
import { createEpicRequest } from "./epic";
import { MANAGE, SupportForbiddenError, SupportNotFoundError, SupportStateError } from "./tech-request";

export async function promoteToEpic(actorPersonId: string, techRequestId: string): Promise<EpicRequest> {
  if (!(await can(actorPersonId, MANAGE))) throw new SupportForbiddenError(`${MANAGE} is required.`);
  const t = await prisma.techRequest.findUnique({ where: { id: techRequestId } });
  if (!t) throw new SupportNotFoundError();
  if (t.category !== "EPIC" || !t.epicSubtype) throw new SupportStateError("Only an Epic-category ticket can be promoted.");
  if (t.epicRequestId) throw new SupportStateError("This ticket is already linked to an Epic request.");

  // Reuse the unchanged Epic service. createEpicRequest enforces person-ACTIVE,
  // no-open-request, and kind-vs-epicId rules and audits epic.request.
  const epic = await createEpicRequest(actorPersonId, {
    personId: t.requesterId,
    kind: t.epicSubtype,
    jobTitle: t.epicJobTitle,
    mirrorEpicId: t.epicMirrorId,
    notes: `Promoted from IT Support #${t.number}: ${t.subject}`,
  });

  await prisma.techRequest.update({
    where: { id: techRequestId },
    data: { epicRequestId: epic.id, status: "IN_PROGRESS" },
  });
  await recordAudit({
    actorPersonId, action: "support.epic_promote", entityType: "TechRequest",
    entityId: techRequestId, after: { epicRequestId: epic.id },
  });
  return epic;
}
```

- [ ] **Step 4:** In `ticket-detail.tsx`, for an EPIC-category ticket show the intake fields; if `epicRequestId` is null and `canManage`, show "Create Epic request"; once linked, render the linked `EpicRequest`/`YnhhTicket` status + SR number and manager actions that call the existing epic service (`completeRequest`, `createTicket`, `setTicketServiceRequestNumber`, `sendEpicEmail`) via server actions. Reuse the Epic queue action code moved in Task 11.

- [ ] **Step 5:** Run -> PASS. tsc clean. Commit.

```bash
git add src/modules/support/services/epic-link.ts src/modules/support/services/epic-link.test.ts src/modules/support/components/ticket-detail.tsx "src/app/(app)/support/[id]/page.tsx"
git commit -m "feat(support): manager Epic promotion links the ticket to the Epic pipeline"
```

## Task 14: Relocate the ITCM generator to /support/epic and retire /admin/itcm

**Files:**
- Move: `src/modules/admin/components/epic-request-tabs.tsx` -> `src/modules/support/components/epic-request-tabs.tsx`
- Move: `src/app/api/admin/itcm/generate/route.ts` -> `src/app/api/support/epic/generate/route.ts` (re-gate to `support.manage_requests`; update the client fetch URL in the tabs component)
- Create: `src/app/(app)/support/epic/page.tsx` (hosts the tabs + the Epic queue + pending deactivations)
- Delete: `src/app/(app)/admin/itcm/` (page + epic-requests page)
- Modify: `src/platform/modules/registry.ts` (remove the `{ label: "ITCM", href: "/admin/itcm" }` nav entry)

- [ ] **Step 1:** Create `/support/epic/page.tsx` gating on `support.manage_requests`; render the relocated `EpicRequestTabs` and the Epic queue (listEpicRequests/listTickets, all moved to the support epic service). Load `listDepartmentsWithMembers`, `getEpicRequestHistory`, `listPendingDeactivations`, `listEpicAuthorizers` from the moved itcm service.

- [ ] **Step 2:** Move the generate route; change its auth check to `can(actor.id, "support.manage_requests")`; update the fetch URL inside the tabs component to `/api/support/epic/generate`.

- [ ] **Step 3:** Delete `src/app/(app)/admin/itcm` and remove the Admin nav ITCM entry.

- [ ] **Step 4:** `npx tsc --noEmit`; grep for any remaining `/admin/itcm` references and fix. Commit.

```bash
git add -A
git commit -m "feat(support): move ITCM Epic tools to /support/epic, retire /admin/itcm"
```

## Task 15: Retire /volunteers/epic

**Files:**
- Delete: `src/app/(app)/volunteers/epic/` (page + select-all-checkbox)
- Modify: `src/platform/modules/registry.ts` (Volunteers nav "Epic requests" entry already removed in Task 12; confirm)

- [ ] **Step 1:** Delete the route folder. Grep for `/volunteers/epic` references (nav, links, tests) and remove or repoint to `/support/epic`.

- [ ] **Step 2:** `npx tsc --noEmit`; run the volunteers layout guard test. Commit.

```bash
git add -A
git commit -m "feat(support): retire /volunteers/epic (folded into /support)"
```

## Task 16: Remove Epic self-service from My Info

**Files:**
- Modify: `src/app/(app)/my-info/page.tsx` (remove the Epic Access section, `epicRequestAction`, `myEpicPanel` import + fetch, and the `epicError`/`epicSaved` searchParams)
- Delete: `src/modules/my-info/components/epic-panel.tsx`
- Modify: `src/modules/my-info/services/my-info.ts` if it re-exports anything Epic-related

- [ ] **Step 1:** Remove the `<section>` for Epic Access, the `EpicPanel` import, the `myEpicPanel` entry from the `Promise.all`, the `epicRequestAction` server action, and the two searchParams fields. Delete `epic-panel.tsx`.

- [ ] **Step 2:** `npx tsc --noEmit`; run the my-info service test. Commit.

```bash
git add -A
git commit -m "feat(support): remove Epic self-service from My Info (moved to IT Support)"
```

## Task 17: End-to-end tests and final verification

**Files:**
- Create: `e2e/support-tech-requests.spec.ts` (Playwright, follow the existing suite's auth + Prisma fixtures)

- [ ] **Step 1:** Write specs: (a) a volunteer submits a General IT request, sees it under My requests, opens it; (b) a manager sees it under All requests, posts a public reply and an internal note, the volunteer sees only the public reply; (c) manager assigns, sets status to Awaiting you, then resolves with a resolution the volunteer can read; (d) Epic path: volunteer submits an Epic New request, manager promotes it, the linked Epic pipeline appears.

- [ ] **Step 2:** Run the suite locally against the dev DB if possible, else rely on CI. Confirm `npx tsc --noEmit` and `next build` succeed.

- [ ] **Step 3:** Run `npx prisma migrate status` and confirm both new migrations are listed and pending-then-applied cleanly against a fresh DB.

- [ ] **Step 4:** Commit.

```bash
git add e2e/support-tech-requests.spec.ts
git commit -m "test(support): e2e coverage for submit, track, comment, resolve, and Epic promotion"
```

---

## Self-review notes (author checklist, resolved)

- **Spec coverage:** data model (Task 1), module+permission (Tasks 2, 12), submit+track (Tasks 4, 5), comments public/internal (Task 6), attachments (Task 7), master list (Task 8), manager actions (Task 9), notifications+email (Tasks 4, 6, 9, 10), Epic manager-promotion (Task 13), ITCM relocation + retire /admin/itcm (Task 14), retire /volunteers/epic (Task 15), remove My Info Epic (Task 16), offboard unchanged (no task needed; Task 11 only re-gates, preserving `setPersonStatusField`), tests (throughout + Task 17). All spec sections map to a task.
- **Type consistency:** `MANAGE = "support.manage_requests"` and the error classes are defined in `tech-request.ts` (Task 3) and imported everywhere else. `createTechRequest` input shape is reused by the submit action and the Epic promotion reads the same persisted fields.
- **Open items from the spec (non-blocking):** module icon defaulted to `LifeBuoy` (Task 2); `AWAITING_YNHH` is set by the manager (via `setStatus`) rather than auto-set on Epic ticket batching, to keep Phase B's linkage simple. Revisit auto-set as a follow-up if desired.
```
