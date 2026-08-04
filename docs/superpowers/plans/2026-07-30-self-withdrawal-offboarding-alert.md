# Self-withdrawal Offboarding Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member clicks "I am not volunteering this term" on `/my-info`, put them in the offboarding queue and tell the people who process offboarding.

**Architecture:** `withdrawFromTerm` keeps doing exactly what it does (soft-remove ACTIVE VOLUNTEER memberships in the active term), then calls one new platform helper that creates an `OffboardFlag` and notifies `volunteers.manage_offboarding` holders through the existing `notify()` dispatcher. The helper lives in `src/platform` because eslint forbids `modules/my-info` from importing `modules/volunteers`. No schema change.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, Vitest against a real test database, the in-house email template registry and `notify()` dispatcher.

**Spec:** `docs/superpowers/specs/2026-07-30-self-withdrawal-offboarding-alert-design.md`

## Global Constraints

- **No em-dash characters (U+2014) anywhere under `src/`.** The `local/no-em-dash` eslint rule scans raw source text, so it catches them in comments and strings too. Use " - " or a comma.
- **Lint with `npx eslint src`**, not `npm run lint`. The bare script walks a gitignored design-system directory and produces noise.
- **Tests need the test database.** Once per machine: `npm run db:up` then `npm run test:prepare`. Tests run serially against it (`fileParallelism: false`).
- **Modules may not import other modules.** `src/modules/my-info` importing `src/modules/volunteers` is an eslint error (`import/no-restricted-paths`). Shared logic goes in `src/platform`.
- **The email render engine supports only** `{{ var }}`, `{{{ raw }}}`, and `{{#if}}` / `{{else}}` / `{{/if}}`. There is no `{{#each}}`; precompute any list into a joined string.
- **Booleans in template `variables` use string sample values** (`sampleValue: "true"`).

## File Structure

**Create:**
- `src/platform/email/templates/volunteers.ts` - the `volunteers.self_withdrawal` descriptor plus its typed context builder.
- `src/platform/offboarding/self-withdrawal.ts` - creates the flag, resolves recipients, dispatches the notification.
- `src/platform/offboarding/self-withdrawal.test.ts`

**Modify:**
- `src/platform/email/templates/types.ts` - add `"volunteers"` to `TemplateGroup`.
- `src/platform/email/templates/registry.ts` - register the new descriptors.
- `src/platform/email/sender-rules.ts` - add the "Volunteers" send-from category.
- `src/platform/notifications/registry.ts` - add the `volunteers.self_withdrawal` type.
- `src/platform/notifications/registry.test.ts` - extend the exhaustive key list.
- `src/modules/my-info/services/my-info.ts` - `withdrawFromTerm` gains a reason and the two side effects.
- `src/modules/my-info/services/my-info.test.ts` - new cases.
- `src/modules/my-info/components/memberships-card.tsx` - optional reason input.
- `src/app/(app)/my-info/page.tsx` - `withdrawAction` reads the reason.

**Create (test):**
- `src/modules/my-info/components/memberships-card.test.tsx`

---

### Task 1: Email template and notification registry

Registers the new notification type and its email template so Task 2 can render and dispatch it. Nothing observable to a user yet; the deliverable is that the admin channel picker and send-from category exist and the registries stay consistent.

**Files:**
- Create: `src/platform/email/templates/volunteers.ts`
- Modify: `src/platform/email/templates/types.ts:5`
- Modify: `src/platform/email/templates/registry.ts:1-25`
- Modify: `src/platform/email/sender-rules.ts:30-39`
- Modify: `src/platform/notifications/registry.ts:15-39`
- Test: `src/platform/notifications/registry.test.ts:6-35`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Template key `"volunteers.self_withdrawal"`.
  - `export type SelfWithdrawalParams = { memberName: string; departments: string; reason: string | null; stillActive: boolean; reviewLink: string }`
  - `export function selfWithdrawalContext(p: SelfWithdrawalParams): Record<string, unknown>`
  - `export const volunteersDescriptors: TemplateDescriptor[]`

- [ ] **Step 1: Add the notification type key to the registry test**

In `src/platform/notifications/registry.test.ts`, add `"volunteers.self_withdrawal"` to the array inside the first `it(...)` block (the list is `.sort()`ed on both sides, so position does not matter):

```ts
        "incidents.strike_requested",
        "recruitment.interview_assignment",
        "recruitment.review_digest",
        "volunteers.self_withdrawal",
        "support.ticket_submitted",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/platform/notifications/registry.test.ts`
Expected: FAIL on "declares the existing notification types" - the received array is missing `volunteers.self_withdrawal`. The third test ("registers a channel select setting per type") still passes, because it iterates the code list rather than the expected one.

- [ ] **Step 3: Register the notification type**

In `src/platform/notifications/registry.ts`, add a final entry to `NOTIFICATION_TYPES`:

```ts
  { key: "incidents.strike_issued_directors", label: "Incident: strike issued (directors)", defaultChannel: "email" },
  { key: "volunteers.self_withdrawal", label: "Volunteers: member not returning this term (offboarding managers)", defaultChannel: "email" },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/platform/notifications/registry.test.ts`
Expected: PASS, all three tests. The settings registry derives a channel setting per type from `NOTIFICATION_TYPES`, so the admin picker at `/admin/notifications` now exists with no further work.

- [ ] **Step 5: Add the `volunteers` template group**

In `src/platform/email/templates/types.ts`, extend the `TemplateGroup` union:

```ts
export type TemplateGroup = "recruitment" | "compliance" | "epic" | "campaign" | "layout" | "support" | "shift" | "incidents" | "auth" | "volunteers";
```

In `src/platform/email/sender-rules.ts`, add a category to `SENDER_CATEGORIES` (before `campaign`, keeping module categories together):

```ts
  { group: "incidents", label: "Incident Reports" },
  { group: "volunteers", label: "Volunteers" },
  { group: "campaign", label: "Campaigns" },
```

- [ ] **Step 6: Write the failing template test**

Create `src/platform/email/templates/volunteers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selfWithdrawalContext, volunteersDescriptors } from "./volunteers";
import { renderTemplate } from "@/platform/email/render/render";

const descriptor = volunteersDescriptors[0];

function render(context: Record<string, unknown>) {
  return renderTemplate(descriptor.defaultBody, context);
}

describe("selfWithdrawalContext", () => {
  it("flattens a reason into the text plus a hasReason boolean", () => {
    const ctx = selfWithdrawalContext({
      memberName: "Jane Doe",
      departments: "MED, PCAR",
      reason: "Graduating in May.",
      stillActive: false,
      reviewLink: "https://hub.test/volunteers/offboarding",
    });

    expect(ctx.reason).toBe("Graduating in May.");
    expect(ctx.hasReason).toBe(true);
  });

  it("reports hasReason false when no reason was given", () => {
    const ctx = selfWithdrawalContext({
      memberName: "Jane Doe",
      departments: "MED",
      reason: null,
      stillActive: false,
      reviewLink: "https://hub.test/volunteers/offboarding",
    });

    expect(ctx.reason).toBe("");
    expect(ctx.hasReason).toBe(false);
  });
});

describe("volunteers.self_withdrawal template", () => {
  it("is registered under the volunteers group", () => {
    expect(descriptor.key).toBe("volunteers.self_withdrawal");
    expect(descriptor.group).toBe("volunteers");
  });

  it("names the member and departments, and says they are flagged", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED, PCAR",
        reason: null,
        stillActive: false,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("Jane Doe");
    expect(html).toContain("MED, PCAR");
    expect(html).toContain("flagged for offboarding");
    expect(html).not.toContain("Reason given");
  });

  it("includes the reason when one was given", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED",
        reason: "Graduating in May.",
        stillActive: false,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("Reason given");
    expect(html).toContain("Graduating in May.");
  });

  it("says no action is needed when the member keeps another active role", () => {
    const html = render(
      selfWithdrawalContext({
        memberName: "Jane Doe",
        departments: "MED",
        reason: null,
        stillActive: true,
        reviewLink: "https://hub.test/volunteers/offboarding",
      }),
    );

    expect(html).toContain("still hold");
    expect(html).not.toContain("flagged for offboarding");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- src/platform/email/templates/volunteers.test.ts`
Expected: FAIL - cannot resolve `./volunteers`.

- [ ] **Step 8: Write the template file**

Create `src/platform/email/templates/volunteers.ts`:

```ts
/**
 * Volunteers module email templates.
 *
 * volunteers.self_withdrawal: sent to the people who can execute an offboard
 * (volunteers.manage_offboarding holders and admins) when a member uses My Info
 * to declare they are not volunteering this term. Their volunteer memberships
 * are already removed by the time this sends; the message tells ops that the
 * person still has an ACTIVE account and Epic access until someone processes it.
 *
 * The body branches on stillActive: a member who keeps another role this term
 * (typically a director who also took clinic shifts) is deliberately NOT flagged
 * for offboarding, because executing one would strip their remaining role.
 *
 * Department codes arrive pre-joined: the render engine has no {{#each}}.
 */

import type { TemplateDescriptor } from "./types";

export type SelfWithdrawalParams = {
  /** Full name of the member who withdrew. */
  memberName: string;
  /** Comma-joined department codes they withdrew from, e.g. "MED, PCAR". */
  departments: string;
  /** Free-text reason they gave, or null. */
  reason: string | null;
  /** True when the member keeps another ACTIVE membership this term (no flag was raised). */
  stillActive: boolean;
  /** Absolute link to the offboarding queue. */
  reviewLink: string;
};

/** Build the flat render-engine context for the volunteers.self_withdrawal template. */
export function selfWithdrawalContext(p: SelfWithdrawalParams): Record<string, unknown> {
  return {
    memberName: p.memberName,
    departments: p.departments,
    reason: p.reason ?? "",
    hasReason: p.reason !== null && p.reason !== "",
    stillActive: p.stillActive,
    reviewLink: p.reviewLink,
  };
}

export const volunteersDescriptors: TemplateDescriptor[] = [
  {
    key: "volunteers.self_withdrawal",
    name: "Volunteers: not returning this term",
    category: "transactional",
    group: "volunteers",
    variables: [
      { name: "memberName", label: "Member who withdrew", sampleValue: "Jane Doe" },
      {
        name: "departments",
        label: "Departments they withdrew from (comma-joined)",
        sampleValue: "MED, PCAR",
      },
      { name: "reason", label: "Reason they gave (empty when none)", sampleValue: "Graduating in May." },
      { name: "hasReason", label: "True when a reason was given", sampleValue: "true" },
      {
        name: "stillActive",
        label: "True when they keep another active role this term",
        sampleValue: "false",
      },
      {
        name: "reviewLink",
        label: "Link to the offboarding queue",
        sampleValue: "https://hub.havenfreeclinic.org/volunteers/offboarding",
      },
    ],
    defaultSubject: "[HAVEN] {{ memberName }} is not volunteering this term",
    defaultBody: `<p>Hello,</p>

<p>{{ memberName }} used My Info to declare they are not volunteering this term. Their volunteer assignments ({{ departments }}) have been removed from the current-term roster.</p>

{{#if hasReason}}<p>Reason given: {{ reason }}</p>{{/if}}

{{#if stillActive}}<p>They still hold another active role this term, so they have not been added to the offboarding queue. No action is needed unless you decide otherwise.</p>{{else}}<p>They are now flagged in the offboarding queue. Their account status and Epic access stay unchanged until someone processes the offboard.</p>{{/if}}

<p><a href="{{ reviewLink }}">Open the offboarding queue</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
```

- [ ] **Step 9: Register the descriptors**

In `src/platform/email/templates/registry.ts`, add the import beside the others and spread it into `ALL`:

```ts
import { authDescriptors } from "./auth";
import { volunteersDescriptors } from "./volunteers";

export const LAYOUT_KEY = "layout";

const ALL: TemplateDescriptor[] = [
  layoutDescriptor,
  ...complianceDescriptors,
  ...epicDescriptors,
  ...recruitmentDescriptors,
  ...supportDescriptors,
  ...shiftDescriptors,
  ...scheduleDescriptors,
  ...incidentsDescriptors,
  ...authDescriptors,
  ...volunteersDescriptors,
];
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -- src/platform/email/templates/ src/platform/email/sender-rules.test.ts src/platform/notifications/registry.test.ts`
Expected: PASS. Watch for the registry test's "lists descriptors with unique keys" case, which catches a duplicate key.

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src
git add src/platform/email src/platform/notifications
git commit -m "feat(volunteers): register self-withdrawal notification type and email template"
```

---

### Task 2: The flag-and-notify helper

The whole side effect, isolated behind one function so the my-info service stays a one-line call site and the behaviour is testable without going through a server action.

**Files:**
- Create: `src/platform/offboarding/self-withdrawal.ts`
- Test: `src/platform/offboarding/self-withdrawal.test.ts`

**Interfaces:**
- Consumes: `selfWithdrawalContext` and the `"volunteers.self_withdrawal"` key from Task 1.
- Produces:
  - `export async function recordSelfWithdrawal(db: Db, member: { id: string; name: string }, detail: { departmentCodes: string[]; reason: string | null }): Promise<number>` - returns the number of people notified.
  - `export function buildSelfWithdrawalNote(departments: string, reason: string | null): string`

- [ ] **Step 1: Write the failing test**

Create `src/platform/offboarding/self-withdrawal.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { recordSelfWithdrawal, buildSelfWithdrawalNote } from "./self-withdrawal";

beforeEach(resetDb);

/** A person who globally holds volunteers.manage_offboarding. */
async function createOffboardingManager(name: string, contactEmail: string) {
  const person = await prisma.person.create({ data: { name, contactEmail } });
  const role = await prisma.role.create({
    data: {
      name: `Offboarding ${name}`,
      grants: { create: [{ permission: "volunteers.manage_offboarding" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: person.id, termId: null } });
  return person;
}

async function createActiveTerm() {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-08-31"),
      status: "ACTIVE",
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

describe("buildSelfWithdrawalNote", () => {
  it("names the departments", () => {
    expect(buildSelfWithdrawalNote("MED, PCAR", null)).toBe(
      "Not volunteering this term (MED, PCAR)",
    );
  });

  it("appends a quoted reason when one was given", () => {
    expect(buildSelfWithdrawalNote("MED", "Graduating in May.")).toBe(
      'Not volunteering this term (MED) - "Graduating in May."',
    );
  });

  it("omits the parenthetical when there are no departments", () => {
    expect(buildSelfWithdrawalNote("", null)).toBe("Not volunteering this term");
  });
});

describe("recordSelfWithdrawal", () => {
  it("flags the member and notifies every offboarding manager", async () => {
    const term = await createActiveTerm();
    const m1 = await createOffboardingManager("Olive Ops", "olive@x.org");
    const m2 = await createOffboardingManager("Omar Ops", "omar@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED", "PCAR"], reason: "Graduating in May." },
    );

    expect(count).toBe(2);

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).not.toBeNull();
    expect(flag!.flaggedById).toBe(member.id);
    expect(flag!.note).toBe('Not volunteering this term (MED, PCAR) - "Graduating in May."');

    const notes = await prisma.notification.findMany({
      where: { type: "volunteers.self_withdrawal" },
    });
    expect(notes.map((n) => n.personId).sort()).toEqual([m1.id, m2.id].sort());
    for (const note of notes) {
      expect(note.body).toContain("Jane Doe");
      expect(note.link).toMatch(/\/volunteers\/offboarding$/);
    }
  });

  it("audits the flag it raises", async () => {
    const term = await createActiveTerm();
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: "offboard.flag", actorPersonId: member.id },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.termId).toBe(term.id);
    expect(after.self).toBe(true);
  });

  it("does NOT flag a member who keeps another active membership, but still notifies", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment("SRR");
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Dana Director" } });
    // A directorship they keep: offboarding them would strip it.
    await prisma.termMembership.create({
      data: { personId: member.id, termId: term.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(1);
    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).toBeNull();

    const note = await prisma.notification.findFirst({ where: { type: "volunteers.self_withdrawal" } });
    expect(note!.body).toContain("still");
  });

  it("keeps an existing flag and its note rather than overwriting it", async () => {
    const term = await createActiveTerm();
    const director = await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });
    await prisma.offboardFlag.create({
      data: { personId: member.id, termId: term.id, flaggedById: director.id, note: "Raised by their director." },
    });

    await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag!.flaggedById).toBe(director.id);
    expect(flag!.note).toBe("Raised by their director.");
  });

  it("returns 0 and writes nothing when there is no active term", async () => {
    await createOffboardingManager("Olive Ops", "olive@x.org");
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(0);
    expect(await prisma.offboardFlag.findMany()).toEqual([]);
    expect(await prisma.notification.findMany({ where: { type: "volunteers.self_withdrawal" } })).toEqual([]);
  });

  it("flags the member but returns 0 when nobody can process an offboard", async () => {
    const term = await createActiveTerm();
    const member = await prisma.person.create({ data: { name: "Jane Doe" } });

    const count = await recordSelfWithdrawal(
      prisma,
      { id: member.id, name: member.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(0);
    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: member.id, termId: term.id } },
    });
    expect(flag).not.toBeNull();
  });

  it("does not notify the member even when they are themselves an offboarding manager", async () => {
    await createActiveTerm();
    const other = await createOffboardingManager("Olive Ops", "olive@x.org");
    const selfManager = await createOffboardingManager("Sam Self", "sam@x.org");

    const count = await recordSelfWithdrawal(
      prisma,
      { id: selfManager.id, name: selfManager.name! },
      { departmentCodes: ["MED"], reason: null },
    );

    expect(count).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "volunteers.self_withdrawal" } });
    expect(notes.map((n) => n.personId)).toEqual([other.id]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/platform/offboarding/self-withdrawal.test.ts`
Expected: FAIL - cannot resolve `./self-withdrawal`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/offboarding/self-withdrawal.ts`:

```ts
/**
 * Side effects of a member declaring they are not volunteering this term.
 *
 * withdrawFromTerm (my-info) soft-removes their ACTIVE VOLUNTEER memberships and
 * stops. That leaves them half-offboarded: Person.status is still ACTIVE, so Epic
 * access, compliance reminders, and every status-keyed roster still treat them as
 * present, while they have vanished from the department cards on
 * /volunteers/offboarding (those list ACTIVE memberships only). Nobody was told.
 *
 * This module closes both gaps: it puts the member in the offboarding queue and
 * alerts the people who can actually execute an offboard.
 *
 * Lives in platform rather than the volunteers module because eslint forbids
 * src/modules/my-info from importing src/modules/volunteers. It deliberately does
 * not reuse offboarding.flagForOffboarding: that function's actorCanManageTarget
 * scope check is meaningless when the actor is the subject, and would reject a
 * regular volunteer flagging themselves.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { isUniqueConstraintError } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { notify } from "@/platform/notifications/notify";
import { recordAudit } from "@/platform/audit";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { selfWithdrawalContext } from "@/platform/email/templates/volunteers";
import { log } from "@/platform/logging";

type Db = PrismaClient | Prisma.TransactionClient;

/** Permissions that let a person execute an offboard (see offboarding.executeOffboard). */
const CAN_OFFBOARD = ["volunteers.manage_offboarding", "admin.access"];

/**
 * Build the flag note. The department codes go IN the note because the flagged
 * table's Departments column derives from ACTIVE memberships, which are REMOVED
 * by the time this runs, so it would otherwise render "-" for exactly the rows
 * that need the context most.
 */
export function buildSelfWithdrawalNote(departments: string, reason: string | null): string {
  const base = departments
    ? `Not volunteering this term (${departments})`
    : "Not volunteering this term";
  return reason ? `${base} - "${reason}"` : base;
}

/**
 * Flag the member for offboarding (unless they keep another active role) and
 * notify everyone who can execute an offboard. Returns the number notified.
 *
 * Returns 0 with no writes when there is no ACTIVE term: without one there is no
 * flag to raise and nothing for ops to process.
 */
export async function recordSelfWithdrawal(
  db: Db,
  member: { id: string; name: string },
  detail: { departmentCodes: string[]; reason: string | null },
): Promise<number> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return 0;

  // Director guard: executeOffboard strips EVERY membership and sets
  // Person.status to OFFBOARDED, so flagging someone who still holds another role
  // this term (typically a director who also took clinic shifts) puts a one-click
  // path to revoking that role in front of ops. The queue means "should be fully
  // offboarded", and they should not be. They still get the alert, worded as FYI.
  const remaining = await db.termMembership.count({
    where: { personId: member.id, termId: activeTerm.id, status: "ACTIVE" },
  });
  const stillActive = remaining > 0;

  const departments = detail.departmentCodes.join(", ");

  if (!stillActive) {
    await ensureSelfFlag(db, member.id, activeTerm.id, departments, detail.reason);
  }

  const recipients = (await peopleWithAnyPermission(CAN_OFFBOARD)).filter((p) => p.id !== member.id);
  if (recipients.length === 0) {
    log.warn(
      `[offboarding] ${member.name} (${member.id}) declared they are not volunteering this term, but nobody holds volunteers.manage_offboarding to process it.`,
      { personId: member.id },
    );
    return 0;
  }

  const baseUrl = await getSetting<string>("app.baseUrl");
  const reviewLink = `${baseUrl}/volunteers/offboarding`;
  const rendered = await renderEmail(
    "volunteers.self_withdrawal",
    selfWithdrawalContext({
      memberName: member.name,
      departments,
      reason: detail.reason,
      stillActive,
      reviewLink,
    }),
  );

  const summary = stillActive
    ? `${member.name} withdrew from ${departments} but still holds another active role, so they were not added to the offboarding queue.`
    : `${member.name} withdrew from ${departments} and is now flagged in the offboarding queue.`;

  for (const recipient of recipients) {
    await notify(db, {
      type: "volunteers.self_withdrawal",
      person: {
        id: recipient.id,
        entraObjectId: recipient.entraObjectId,
        contactEmail: recipient.contactEmail,
      },
      email: { subject: rendered.subject, html: rendered.html },
      teams: {
        title: `${member.name} is not volunteering this term`,
        summary,
        link: reviewLink,
      },
      triggeredById: member.id,
    });
  }

  return recipients.length;
}

/**
 * Create the member's own OffboardFlag, or leave an existing one alone.
 *
 * Upsert-safe on @@unique([personId, termId]), matching flagForOffboarding: a flag
 * a director already raised keeps its note and its flaggedById, and no second audit
 * row is written. flaggedById is the member themselves, so the flagged table reads
 * "Flagged by: <their own name>".
 */
async function ensureSelfFlag(
  db: Db,
  personId: string,
  termId: string,
  departments: string,
  reason: string | null,
): Promise<void> {
  const existing = await db.offboardFlag.findUnique({
    where: { personId_termId: { personId, termId } },
  });
  if (existing) return;

  const note = buildSelfWithdrawalNote(departments, reason);

  let flagId: string;
  try {
    const flag = await db.offboardFlag.create({
      data: { personId, termId, flaggedById: personId, note },
    });
    flagId = flag.id;
  } catch (err) {
    // Raced with a director flagging them between the read and the write. The
    // winner's row stands, exactly as in flagForOffboarding.
    if (isUniqueConstraintError(err)) return;
    throw err;
  }

  await recordAudit({
    actorPersonId: personId,
    action: "offboard.flag",
    entityType: "OffboardFlag",
    entityId: flagId,
    after: { personId, termId, note, self: true },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/platform/offboarding/self-withdrawal.test.ts`
Expected: PASS, all nine cases.

If `db.termMembership.count` or `db.offboardFlag` produces a TypeScript error about the union type, that means `Prisma.TransactionClient` and `PrismaClient` disagree on the delegate shape; check how `src/platform/compliance/review-notifications.ts` types its `Db` and match it exactly.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src
git add src/platform/offboarding
git commit -m "feat(offboarding): flag and alert ops when a member self-withdraws"
```

---

### Task 3: Wire it into `withdrawFromTerm`

The behaviour change users care about. After this task the feature works end to end for anyone hitting the service; only the reason input is missing.

**Files:**
- Modify: `src/modules/my-info/services/my-info.ts:168-221`
- Test: `src/modules/my-info/services/my-info.test.ts:214-325`

**Interfaces:**
- Consumes: `recordSelfWithdrawal` from Task 2.
- Produces: `withdrawFromTerm(personId: string, reason?: string | null): Promise<number>` - the second parameter is optional, so every existing call site keeps compiling.

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe("withdrawFromTerm", ...)` block in `src/modules/my-info/services/my-info.test.ts`, after the last `it(...)`:

```ts
  it("flags the withdrawing member for offboarding with the departments in the note", async () => {
    const person = await createPerson({ name: "Jane Doe" });
    const term = await createTerm({ status: "ACTIVE" });
    const dept1 = await createDepartment("MED");
    const dept2 = await createDepartment("PCAR");
    await createMembership(person.id, term.id, dept1.id, "VOLUNTEER", "ACTIVE");
    await createMembership(person.id, term.id, dept2.id, "VOLUNTEER", "ACTIVE");

    await withdrawFromTerm(person.id, "Graduating in May.");

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(flag).not.toBeNull();
    expect(flag!.flaggedById).toBe(person.id);
    // Departments come from the memberships as they were BEFORE removal.
    expect(flag!.note).toBe('Not volunteering this term (MED, PCAR) - "Graduating in May."');
  });

  it("records the reason on the audit row", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("MED");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    await withdrawFromTerm(person.id, "  Graduating in May.  ");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.withdraw", actorPersonId: person.id },
    });
    const after = audit!.after as Record<string, unknown>;
    expect(after.reason).toBe("Graduating in May.");
  });

  it("stores a blank reason as null", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("MED");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    await withdrawFromTerm(person.id, "   ");

    const flag = await prisma.offboardFlag.findUnique({
      where: { personId_termId: { personId: person.id, termId: term.id } },
    });
    expect(flag!.note).toBe("Not volunteering this term (MED)");
  });

  it("truncates a very long reason to 300 characters", async () => {
    const person = await createPerson();
    const term = await createTerm({ status: "ACTIVE" });
    const dept = await createDepartment("MED");
    await createMembership(person.id, term.id, dept.id, "VOLUNTEER", "ACTIVE");

    await withdrawFromTerm(person.id, "x".repeat(500));

    const audit = await prisma.auditLog.findFirst({
      where: { action: "my-info.withdraw", actorPersonId: person.id },
    });
    const after = audit!.after as Record<string, unknown>;
    expect((after.reason as string).length).toBe(300);
  });

  it("does NOT flag or notify when there was nothing to withdraw from", async () => {
    const person = await createPerson();
    await createTerm({ status: "ACTIVE" });

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(0);
    expect(await prisma.offboardFlag.findMany()).toEqual([]);
    expect(
      await prisma.notification.findMany({ where: { type: "volunteers.self_withdrawal" } }),
    ).toEqual([]);
  });

  it("does not flag a member who keeps a directorship, but still removes the volunteer rows", async () => {
    const person = await createPerson({ name: "Dana Director" });
    const term = await createTerm({ status: "ACTIVE" });
    const volunteerDept = await createDepartment("MED");
    const directorDept = await createDepartment("SRR");
    const volunteerRow = await createMembership(person.id, term.id, volunteerDept.id, "VOLUNTEER", "ACTIVE");
    await createMembership(person.id, term.id, directorDept.id, "DIRECTOR", "ACTIVE");

    const count = await withdrawFromTerm(person.id);

    expect(count).toBe(1);
    expect((await prisma.termMembership.findUnique({ where: { id: volunteerRow.id } }))?.status).toBe("REMOVED");
    expect(await prisma.offboardFlag.findMany()).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/modules/my-info/services/my-info.test.ts -t withdrawFromTerm`
Expected: FAIL. The reason-argument cases fail on the extra argument (or a `null` reason in the audit); the flag cases fail because no `OffboardFlag` row is created.

- [ ] **Step 3: Add the reason normalizer and the departments read**

In `src/modules/my-info/services/my-info.ts`, add the import beside the other platform imports:

```ts
import { recordSelfWithdrawal } from "@/platform/offboarding/self-withdrawal";
```

Add this helper just above `withdrawFromTerm`:

```ts
/**
 * Trim, blank-to-null, and cap a self-reported withdrawal reason.
 *
 * Normalized here rather than in the page action so it cannot be bypassed by a
 * direct service call, matching how updateMyInfo whitelists fields at the service
 * level rather than trusting the form.
 */
const MAX_REASON_LENGTH = 300;

function normalizeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_REASON_LENGTH);
}
```

- [ ] **Step 4: Rewrite `withdrawFromTerm`**

Replace the body of `withdrawFromTerm` in `src/modules/my-info/services/my-info.ts` with this. The doc comment above it also gains the new paragraph:

```ts
/**
 * Set the person's own ACTIVE VOLUNTEER memberships in the active term to
 * REMOVED. Returns the count of memberships withdrawn. When there are none,
 * returns 0 and does NOT write an audit row.
 *
 * DIRECTOR memberships are deliberately untouched: stepping down as a director
 * is a decision that goes through the executive directors.
 *
 * Removing the memberships is only half an offboard (Person.status stays ACTIVE,
 * so Epic access and compliance reminders continue), and it makes the person
 * disappear from the department cards on /volunteers/offboarding. So after the
 * removal commits, recordSelfWithdrawal puts them in the offboarding queue and
 * alerts the people who can process it. That call is best-effort: the withdrawal
 * is already committed and audited, so a notification failure must not surface to
 * the member as a failed action (same treatment as saveCertificate's alerts).
 */
export async function withdrawFromTerm(personId: string, reason?: string | null): Promise<number> {
  const activeTerm = await getActiveTerm();

  if (!activeTerm) return 0;

  const where = {
    personId,
    termId: activeTerm.id,
    kind: "VOLUNTEER" as const,
    status: "ACTIVE" as const,
  };

  // Read the departments BEFORE the update: the offboarding alert names them, and
  // once the rows are REMOVED there is no way to tell which ones they were.
  const leaving = await prisma.termMembership.findMany({
    where,
    select: { department: { select: { code: true } } },
  });
  const departmentCodes = [...new Set(leaving.map((m) => m.department.code))].sort();

  const cleanReason = normalizeReason(reason);

  // Last-admin guard (#97): dept/kind-scoped admin grants resolve through ACTIVE
  // memberships, so a self-leave can strip the last admin path exactly like an
  // admin-initiated removeMembership -- which guards this and self-leave did not,
  // letting the last admin lock everyone out of the admin module with one click.
  // Fast-path non-admins; for an effective admin, remove and recompute inside one
  // Serializable tx so the withdrawal rolls back (LastAdminError) if it would leave
  // zero effective admins (mirrors roster.ts removeMembership).
  let count: number;
  if (await isEffectiveActiveAdmin(personId)) {
    count = await prisma.$transaction(
      async (tx) => {
        const removed = await tx.termMembership.updateMany({ where, data: { status: "REMOVED" } });
        await assertActiveAdminRemainsTx(tx);
        return removed.count;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } else {
    const removed = await prisma.termMembership.updateMany({ where, data: { status: "REMOVED" } });
    count = removed.count;
  }

  if (count === 0) return 0;

  await recordAudit({
    actorPersonId: personId,
    action: "my-info.withdraw",
    entityType: "Person",
    entityId: personId,
    after: { termId: activeTerm.id, count, reason: cleanReason },
  });

  try {
    const me = await prisma.person.findUnique({
      where: { id: personId },
      select: { name: true },
    });
    await recordSelfWithdrawal(
      prisma,
      { id: personId, name: me?.name ?? "A volunteer" },
      { departmentCodes, reason: cleanReason },
    );
  } catch (err) {
    log.error(
      "[my-info] failed to flag and alert on self-withdrawal",
      errorAttrs(err, { personId, termId: activeTerm.id }),
    );
  }

  return count;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/modules/my-info/services/my-info.test.ts`
Expected: PASS, the whole file. The pre-existing cases (DIRECTOR untouched, non-active terms, last-admin rollback) must still pass unchanged; the new parameter is optional.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src
git add src/modules/my-info/services
git commit -m "feat(my-info): flag and alert offboarding managers on self-withdrawal"
```

---

### Task 4: The optional reason input

Gives the member somewhere to type the reason the service already accepts.

**Files:**
- Modify: `src/modules/my-info/components/memberships-card.tsx:63-73`
- Modify: `src/app/(app)/my-info/page.tsx:71-76`
- Test: `src/modules/my-info/components/memberships-card.test.tsx` (create)

**Interfaces:**
- Consumes: `withdrawFromTerm(personId, reason)` from Task 3.
- Produces: a form field named `reason` in the withdraw form. `MembershipsCard`'s prop type is already `withdrawAction: (formData: FormData) => Promise<void>`, so it does not change.

- [ ] **Step 1: Write the failing test**

Create `src/modules/my-info/components/memberships-card.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Department, Term, TermMembership } from "@prisma/client";

// ConfirmButton is a client component that reads useFormStatus(); stub it so the
// card can render through renderToStaticMarkup in the node test environment.
vi.mock("@/platform/ui/confirm-button", () => ({
  ConfirmButton: ({ label }: { label: string }) => <button type="submit">{label}</button>,
}));

const { MembershipsCard } = await import("./memberships-card");

const term = { id: "t1", code: "SU26" } as Term;
const department = { id: "d1", code: "MED", name: "Medicine" } as Department;

function membership(kind: "VOLUNTEER" | "DIRECTOR"): TermMembership & { department: Department; term: Term } {
  return { id: `m-${kind}`, personId: "p1", termId: "t1", departmentId: "d1", kind, status: "ACTIVE", department, term } as TermMembership & { department: Department; term: Term };
}

const noop = async () => {};

describe("MembershipsCard", () => {
  it("offers an optional reason field beside the withdraw button", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard memberships={[membership("VOLUNTEER")]} withdrawAction={noop} />,
    );

    expect(html).toContain('name="reason"');
    expect(html).toContain("I am not volunteering this term");
  });

  it("shows no reason field when the member has no volunteer assignment", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard memberships={[membership("DIRECTOR")]} withdrawAction={noop} />,
    );

    expect(html).not.toContain('name="reason"');
    expect(html).toContain("contact the executive directors");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/modules/my-info/components/memberships-card.test.tsx`
Expected: FAIL on the first case - the rendered markup has no `name="reason"`.

- [ ] **Step 3: Add the input to the card**

In `src/modules/my-info/components/memberships-card.tsx`, add the import:

```tsx
import { Input } from "@/platform/ui/input";
```

and replace the volunteer withdraw block:

```tsx
      {/* Volunteer withdraw button, with an optional reason for the offboarding alert */}
      {hasVolunteer && (
        <form action={withdrawAction} className="mt-4">
          <FormActions>
            <Input
              name="reason"
              placeholder="Reason (optional)"
              aria-label="Reason for not volunteering (optional)"
              maxLength={300}
              className="w-56"
            />
            <ConfirmButton
              label="I am not volunteering this term"
              confirmLabel="Confirm withdrawal?"
            />
          </FormActions>
        </form>
      )}
```

Also update the component's doc comment, second bullet:

```tsx
 * - Volunteers (ACTIVE VOLUNTEER kind) get an optional reason field and an
 *   "I am not volunteering this term" ConfirmButton that submits a server action.
 *   The reason rides along to the offboarding managers who get alerted.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/modules/my-info/components/memberships-card.test.tsx`
Expected: PASS, both cases.

- [ ] **Step 5: Pass the reason through the page action**

In `src/app/(app)/my-info/page.tsx`, `withdrawAction` currently takes no parameter. Give it the form data:

```tsx
  async function withdrawAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const reason = (formData.get("reason") as string | null) ?? null;
    const count = await withdrawFromTerm(session.personId, reason);
    redirect(`/my-info?withdrawn=${count}`);
  }
```

Trimming and the length cap happen in the service (`normalizeReason`), so the action stays a pass-through.

- [ ] **Step 6: Verify the whole suite, typecheck, lint**

```bash
npm test && npm run typecheck && npx eslint src
```

Expected: all green. `npm test` runs the full suite because the my-info service tests and the new platform tests share the test database.

- [ ] **Step 7: Manual check**

```bash
npm run dev
```

Sign in as a member with an ACTIVE VOLUNTEER membership in the active term, open `/my-info`, confirm the reason field sits beside the button and the two-click confirm still works. Withdraw, then sign in as someone holding `volunteers.manage_offboarding` and confirm the person appears in "Flagged for offboarding" with the departments in the Note column, and that the bell shows the notification.

- [ ] **Step 8: Commit**

```bash
git add src/modules/my-info/components src/app/\(app\)/my-info/page.tsx
git commit -m "feat(my-info): optional reason on the not-volunteering confirmation"
```

---

## Notes for the reviewer

- **Why `recordSelfWithdrawal` takes `db`:** so a future caller can join it to a transaction, matching `notify()` and the compliance helpers. `withdrawFromTerm` passes the plain `prisma` client because it calls after its transaction has committed, deliberately.
- **Why the departments are read before the update:** after `updateMany` sets the rows to `REMOVED`, `where` no longer matches them, and the flagged table's Departments column would show `-`.
- **Why not `flagForOffboarding`:** its `actorCanManageTarget` check rejects a volunteer flagging themselves, and importing it from my-info is an eslint error anyway.
