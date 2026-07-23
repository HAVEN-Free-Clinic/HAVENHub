# Strikes: person search, INC linking, expandable rows, and strike notifications -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Strikes ledger usable -- searchable person picker, incident-report linking, readable descriptions -- wire strike notifications to the subject and their directors, and repair emailed deep links app-wide.

**Architecture:** Five mostly-independent slices on top of existing primitives. No schema migration: `DisciplinaryAction.reportId` and `@@unique([reportId, personId])` already exist. Notifications go through the existing `notify()` dispatcher rather than raw `queueEmail`, so both new types get inbox delivery, a Teams option, and an admin channel setting. The login fix reuses the existing `safeLoginPath` validator and the `x-pathname` header `proxy.ts` already stamps.

**Tech Stack:** Next.js 16 App Router (RSC + server actions), Prisma/Postgres, Vitest against a throwaway pg on :5434, Tailwind with the project's design tokens.

**Spec:** `docs/superpowers/specs/2026-07-22-strikes-linking-and-notifications-design.md`

## Global Constraints

- **Never use em-dashes** in code comments, UI copy, email templates, or commit messages. Use commas, colons, parentheses, or "--".
- **"HAVEN Hub"** is two words in prose and UI copy; identifiers stay `havenhub`.
- **No `tailwind-merge`.** Use the local `cx()` helper from `@/platform/ui/cx`.
- **Radii:** cards `rounded-2xl`, controls `rounded-lg`, alerts `rounded-xl`.
- **Email render engine supports only** `{{ var }}`, `{{#if}}/{{else}}/{{/if}}`, and `{{{ raw }}}`. There is **no `{{#each}}`** -- it renders empty. Precompute every list into a joined string in the context builder.
- **`react-hooks/purity` bans `Date.now()` in render.** Use `new Date()` if a timestamp is needed during render.
- **Run `npm run lint` (whole repo) before pushing.** `typecheck` and `test` miss the eslint boundary rules.
- **Test DB:** `TEST_DATABASE_URL` points at a throwaway pg on :5434, never Neon. Run `npm run test:prepare` once if migrations drifted.
- **All service mutations are audited** via `recordAudit` from `@/platform/audit`.
- **Notifications are best-effort:** a delivery failure is logged via `log.error`/`errorAttrs` and swallowed. It must never throw out of, or roll back, a committed mutation.

## File Structure

**Create:**
- `src/modules/incidents/services/strike-notifications.ts` -- the one post-commit notification helper for an issued strike. Owns recipient resolution and both `notify()` calls.
- `src/modules/incidents/services/strike-notifications.test.ts` -- recipient-rule tests.
- `src/app/(app)/incidents/strikes/strike-row.tsx` -- client component: one ledger row plus its expandable detail row and the link/unlink control.

**Modify:**
- `src/platform/auth/safe-next.ts` -- add `loginRedirectPath()`.
- `src/platform/auth/safe-next.test.ts` -- tests for it.
- `src/platform/auth/session.ts:73-87` -- use it in `requirePersonSession`.
- `src/platform/email/templates/incidents.ts` -- add the directors template + context builder.
- `src/platform/notifications/registry.ts:32-35` -- register the two strike types.
- `src/platform/notifications/registry.test.ts:8-33` -- update the asserted key list.
- `src/modules/incidents/services/disciplinary.ts` -- `deleteAction` scoping fix, `strikeablePeople()`, `linkActionToReport()`.
- `src/modules/incidents/services/disciplinary.test.ts` -- tests for the above.
- `src/modules/incidents/services/report.ts` -- `linkableReports()`; `decideStrike` delegates to the new notifier.
- `src/modules/incidents/services/report.test.ts` -- tests for `linkableReports`, updated `decideStrike` notification assertions.
- `src/app/(app)/incidents/strikes/page.tsx` -- combobox pickers, notify checkbox, `linkReportForm` action, `StrikeRow` in the table body.

---

### Task 1: Login `callbackUrl` on the signed-out bounce

**Files:**
- Modify: `src/platform/auth/safe-next.ts`
- Modify: `src/platform/auth/session.ts:73-87`
- Test: `src/platform/auth/safe-next.test.ts`

**Interfaces:**
- Consumes: existing `safeLoginPath(raw: string | null | undefined): string` from the same file.
- Produces: `loginRedirectPath(pathname: string | null | undefined): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/platform/auth/safe-next.test.ts`:

```ts
describe("loginRedirectPath", () => {
  it("carries a real destination as an encoded callbackUrl", () => {
    expect(loginRedirectPath("/incidents/review")).toBe(
      "/login?callbackUrl=%2Fincidents%2Freview"
    );
  });

  it("returns a bare /login when there is no path context (server actions)", () => {
    expect(loginRedirectPath(null)).toBe("/login");
    expect(loginRedirectPath(undefined)).toBe("/login");
    expect(loginRedirectPath("")).toBe("/login");
  });

  it("returns a bare /login for the home page, which needs no round trip", () => {
    expect(loginRedirectPath("/")).toBe("/login");
  });

  it("drops an off-origin or protocol-relative path rather than echoing it", () => {
    expect(loginRedirectPath("//evil.com")).toBe("/login");
    expect(loginRedirectPath("/\\evil.com")).toBe("/login");
    expect(loginRedirectPath("https://evil.com/x")).toBe("/login");
  });
});
```

Add `loginRedirectPath` to the existing import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/platform/auth/safe-next.test.ts`
Expected: FAIL -- `loginRedirectPath is not a function` / import error.

- [ ] **Step 3: Implement `loginRedirectPath`**

Append to `src/platform/auth/safe-next.ts`:

```ts
/**
 * The /login URL to bounce a signed-out visitor to, carrying where they were
 * headed so sign-in resumes there instead of dumping them on the dashboard.
 * Every emailed deep link (review queue, compliance master view, shift
 * reminders) depends on this.
 *
 * The destination is run through safeLoginPath first, so a hostile or malformed
 * path degrades to a bare /login rather than being echoed into the query string.
 * "/" and a missing path both yield a bare /login: there is nothing to resume.
 */
export function loginRedirectPath(pathname: string | null | undefined): string {
  const target = safeLoginPath(pathname);
  if (target === "/") return "/login";
  return `/login?callbackUrl=${encodeURIComponent(target)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/platform/auth/safe-next.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Wire it into `requirePersonSession`**

In `src/platform/auth/session.ts`, add to the imports:

```ts
import { loginRedirectPath } from "./safe-next";
```

Replace the bare bounce in `requirePersonSession` (currently `if (!session) redirect("/login");`):

```ts
export async function requirePersonSession(): Promise<PersonSession> {
  const session = await auth();
  if (!session) {
    // Carry the intended destination so an emailed deep link survives the SSO
    // round trip. proxy.ts stamps x-pathname on every page request; server
    // actions have no path context, so this degrades to a bare /login there.
    redirect(loginRedirectPath((await headers()).get("x-pathname")));
  }
  if (!session.personId) redirect("/welcome");
  // ... rest unchanged
```

Leave the `/welcome` and `/no-access` redirects alone: they are terminal explanation pages, not resumable destinations.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/platform/auth/safe-next.ts src/platform/auth/safe-next.test.ts src/platform/auth/session.ts
git commit -m "fix(auth): carry the intended destination through the signed-out login bounce

Emailed deep links (incident review queue, compliance master view, shift
reminders) all landed on the dashboard: requirePersonSession redirected to a
bare /login with no callbackUrl, though the login page has supported one all
along. Pass the x-pathname proxy.ts already stamps, validated through
safeLoginPath so a hostile path degrades to a bare /login."
```

---

### Task 2: Scope `deleteAction`'s subject reset to APPROVED rows

**Files:**
- Modify: `src/modules/incidents/services/disciplinary.ts:225-238`
- Test: `src/modules/incidents/services/disciplinary.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `deleteAction(actorPersonId: string, id: string): Promise<void>` is unchanged; only the internal `updateMany` predicate narrows.

**Why:** `deleteAction` resets the source `IncidentReportSubject` to `PENDING` so a deleted strike can be re-approved. That is safe only while `reportId` is set exclusively by `decideStrike()`, which always leaves the subject `APPROVED`. Task 8 lets a reviewer link a strike to any report, so a `DECLINED` subject could be resurrected by deleting an unrelated strike. Land this before linking exists.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/incidents/services/disciplinary.test.ts`, in the `deleteAction` describe block:

```ts
it("leaves a non-APPROVED subject row untouched when deleting a strike linked to its report", async () => {
  const central = await createPerson("Central", "del-scope-c");
  const subject = await createPerson("Subject", "del-scope-s");
  const reporter = await createPerson("Reporter", "del-scope-r");
  await grantPermission(central.id, "incidents.manage");

  const report = await prisma.incidentReport.create({
    data: {
      number: 9001,
      reporterId: reporter.id,
      concernTypes: ["OTHER"],
      description: "Report with a declined strike request.",
    },
  });
  // The subject's request was DECLINED -- deleting a strike must not revive it.
  const subjectRow = await prisma.incidentReportSubject.create({
    data: { reportId: report.id, personId: subject.id, strikeDecision: "DECLINED" },
  });

  const action = await issueAction(central.id, {
    personId: subject.id,
    occurredAt: new Date("2026-07-01"),
    category: "Attendance",
    description: "Separately recorded strike, later linked to the report.",
    reportId: report.id,
  });

  await deleteAction(central.id, action.id);

  const after = await prisma.incidentReportSubject.findUniqueOrThrow({
    where: { id: subjectRow.id },
  });
  expect(after.strikeDecision).toBe("DECLINED");
  expect(after.strikeDecidedById).toBeNull();
});

it("still resets an APPROVED subject row to PENDING so the strike can be re-approved", async () => {
  const central = await createPerson("Central", "del-appr-c");
  const subject = await createPerson("Subject", "del-appr-s");
  const reporter = await createPerson("Reporter", "del-appr-r");
  await grantPermission(central.id, "incidents.manage");

  const report = await prisma.incidentReport.create({
    data: {
      number: 9002,
      reporterId: reporter.id,
      concernTypes: ["OTHER"],
      description: "Report with an approved strike.",
    },
  });
  const subjectRow = await prisma.incidentReportSubject.create({
    data: {
      reportId: report.id,
      personId: subject.id,
      strikeDecision: "APPROVED",
      strikeDecidedById: central.id,
      strikeDecidedAt: new Date(),
    },
  });

  const action = await issueAction(central.id, {
    personId: subject.id,
    occurredAt: new Date("2026-07-01"),
    category: "Attendance",
    description: "Approved off the report.",
    reportId: report.id,
  });

  await deleteAction(central.id, action.id);

  const after = await prisma.incidentReportSubject.findUniqueOrThrow({
    where: { id: subjectRow.id },
  });
  expect(after.strikeDecision).toBe("PENDING");
  expect(after.strikeDecidedById).toBeNull();
  expect(after.strikeDecidedAt).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts -t "non-APPROVED subject row untouched"`
Expected: FAIL -- received `"PENDING"`, expected `"DECLINED"`.

- [ ] **Step 3: Narrow the predicate**

In `src/modules/incidents/services/disciplinary.ts`, inside `deleteAction`'s transaction, change the `updateMany` where clause and extend the comment:

```ts
    if (row.reportId) {
      await tx.incidentReportSubject.updateMany({
        // Only an APPROVED row is reverted. A strike can be linked to an
        // arbitrary report after the fact (linkActionToReport), so an
        // unqualified match would resurrect a DECLINED request, or flip a
        // PENDING one, on deleting a strike that never came from that decision.
        where: { reportId: row.reportId, personId: row.personId, strikeDecision: "APPROVED" },
        data: { strikeDecision: "PENDING", strikeDecidedById: null, strikeDecidedAt: null },
      });
    }
```

- [ ] **Step 4: Run the full disciplinary suite**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts`
Expected: PASS, including the pre-existing delete tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/disciplinary.ts src/modules/incidents/services/disciplinary.test.ts
git commit -m "fix(incidents): only revert an APPROVED subject row when deleting its strike

deleteAction reset the source IncidentReportSubject to PENDING on any reportId
match. That is safe only while reportId is set exclusively by decideStrike.
With strikes about to become linkable to any report, an unqualified match would
resurrect a DECLINED request. Scope the updateMany to strikeDecision APPROVED."
```

---

### Task 3: Directors email template and notification registry entries

**Files:**
- Modify: `src/platform/email/templates/incidents.ts`
- Modify: `src/platform/notifications/registry.ts:32-35`
- Test: `src/platform/notifications/registry.test.ts:8-33`

**Interfaces:**
- Produces:
  - `type StrikeIssuedDirectorsParams = { directorName: string; subjectName: string; category: string; issuedDate: string; issuedBy: string; strikeCount: string; ledgerLink: string }`
  - `strikeIssuedDirectorsContext(p: StrikeIssuedDirectorsParams): Record<string, unknown>`
  - Template key `incidents.strike_issued_directors`, registered in `incidentsDescriptors`.
  - Notification registry keys `incidents.strike_issued` and `incidents.strike_issued_directors`.

- [ ] **Step 1: Write the failing registry test**

In `src/platform/notifications/registry.test.ts`, add the two keys to the expected array in `"declares the existing notification types"`:

```ts
        "incidents.report_resolved",
        "incidents.report_submitted",
        "incidents.strike_decided",
        "incidents.strike_issued",
        "incidents.strike_issued_directors",
        "incidents.strike_requested",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/platform/notifications/registry.test.ts`
Expected: FAIL -- the received array is missing the two new keys.

- [ ] **Step 3: Register the notification types**

In `src/platform/notifications/registry.ts`, append after the `incidents.report_resolved` entry:

```ts
  { key: "incidents.strike_issued", label: "Incident: strike issued (subject)", defaultChannel: "email" },
  { key: "incidents.strike_issued_directors", label: "Incident: strike issued (directors)", defaultChannel: "email" },
```

No migration: the settings registry derives `notifications.<key>.channel` from this list with `envDefault: () => t.defaultChannel`, and `getSetting` falls back to the env default when no `Setting` row exists.

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `npx vitest run src/platform/notifications/registry.test.ts`
Expected: PASS -- including the existing "registers a channel select setting per type" case, which now covers both new keys.

- [ ] **Step 5: Add the params type and context builder**

In `src/platform/email/templates/incidents.ts`, after `ReportResolvedParams`:

```ts
export type StrikeIssuedDirectorsParams = {
  directorName: string;
  /** Full name of the person the strike was issued against. */
  subjectName: string;
  category: string;
  /** Preformatted date string in the configured display zone. */
  issuedDate: string;
  issuedBy: string;
  /** The subject's running strike total, preformatted. */
  strikeCount: string;
  /** Absolute link to the strikes ledger. */
  ledgerLink: string;
};
```

After `reportResolvedContext`:

```ts
/** Build the flat render-engine context for incidents.strike_issued_directors. */
export function strikeIssuedDirectorsContext(
  p: StrikeIssuedDirectorsParams
): Record<string, unknown> {
  return {
    directorName: p.directorName,
    subjectName: p.subjectName,
    category: p.category,
    issuedDate: p.issuedDate,
    issuedBy: p.issuedBy,
    strikeCount: p.strikeCount,
    ledgerLink: p.ledgerLink,
  };
}
```

- [ ] **Step 6: Add the descriptor**

Append to the `incidentsDescriptors` array in the same file, after the `incidents.strike_issued` entry:

```ts
  {
    key: "incidents.strike_issued_directors",
    name: "Incident: strike issued (directors)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "subjectName", label: "Name of the person the strike is against", sampleValue: "Alex Rivera" },
      { name: "category", label: "Strike category", sampleValue: "Attendance" },
      { name: "issuedDate", label: "Date issued", sampleValue: "July 15, 2026" },
      { name: "issuedBy", label: "Issued by name", sampleValue: "Caprice Culkin" },
      { name: "strikeCount", label: "The person's running strike total", sampleValue: "2" },
      { name: "ledgerLink", label: "Link to the strikes ledger", sampleValue: "https://hub.havenfreeclinic.org/incidents/strikes" },
    ],
    defaultSubject: "Disciplinary action recorded for {{ subjectName }}",
    defaultBody: `<p>Hello {{ directorName }},</p>
<p>A disciplinary action was recorded against {{ subjectName }}, a member of a department you direct. They now have {{ strikeCount }} on file.</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0">
  <tr><td style="font-weight:600;padding-right:12px">Category</td><td>{{ category }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Date</td><td>{{ issuedDate }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Issued by</td><td>{{ issuedBy }}</td></tr>
</table>
<p><a href="{{ ledgerLink }}">Open the strikes ledger</a></p>
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
```

The description is deliberately omitted: directors get the categorical fact and a link to the ledger, where `directorVisibility()` governs what they can actually read.

- [ ] **Step 7: Typecheck, lint, and run the email template tests**

Run: `npm run typecheck && npm run lint && npx vitest run src/platform/email`
Expected: all clean and passing.

- [ ] **Step 8: Commit**

```bash
git add src/platform/email/templates/incidents.ts src/platform/notifications/registry.ts src/platform/notifications/registry.test.ts
git commit -m "feat(incidents): add the strike-issued directors email template and register both strike types

incidents.strike_issued was never in the notification registry, so it had no
inbox delivery, no Teams option, and no admin channel setting. Register it
alongside a new incidents.strike_issued_directors template. The directors copy
carries category, date, issuer, and running total but not the description:
directorVisibility governs what they can read on the ledger."
```

---

### Task 4: `notifyStrikeIssued()` service

**Files:**
- Create: `src/modules/incidents/services/strike-notifications.ts`
- Test: `src/modules/incidents/services/strike-notifications.test.ts`

**Interfaces:**
- Consumes: `strikeIssuedDirectorsContext` and the template keys from Task 3; existing `departmentDirectorPersonIds(departmentId: string): Promise<string[]>` from `@/platform/departments`; a new `visibleStrikeCount(personId, viewerPersonId)` from `./disciplinary` (see the correction below).
- Produces: `notifyStrikeIssued(input: { action: DisciplinaryAction; actorPersonId: string }): Promise<void>`.

> **CORRECTION (applied during execution, commit `c26febbc`).** The code below originally
> used `strikeCount(action.personId)` for the directors' total and computed it once before
> the director loop. That is a confidentiality leak: `strikeCount` is documented
> "Visibility-independent: counts all records regardless of confidentiality," so a director
> could be emailed a total higher than their ledger shows them, revealing that a confidential
> row exists. Commit `963c4613` (PR #165) fixed this identical leak on the ledger's Strikes
> column. The correct form exports `visibleStrikeCount(personId, viewerPersonId)` from
> `disciplinary.ts`, reusing the module-private `directorVisibility` predicate, and computes
> it **inside** the per-director loop, since each director's visible count differs. A
> regression test with a mixed confidential/non-confidential history covers it.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/incidents/services/strike-notifications.test.ts`:

```ts
/**
 * TDD tests for notifyStrikeIssued.
 *
 * Recipients:
 *   - The subject always gets incidents.strike_issued.
 *   - Directors of the subject's ACTIVE departments in the ACTIVE term get
 *     incidents.strike_issued_directors.
 *   - A confidential strike notifies NO director (mirrors directorVisibility).
 *   - The subject is excluded from the director set.
 *   - The issuing actor is excluded from the director set.
 *   - A subject with no active membership notifies only the subject.
 *   - Delivery failure is swallowed, never thrown.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notifyStrikeIssued } from "./strike-notifications";
import { issueAction } from "./disciplinary";

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId, contactEmail: `${netId}@yale.edu` } });
}

async function createTerm(code = "SU26") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status: "ACTIVE",
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status: "ACTIVE" },
  });
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

/** Issue a strike against `subjectId` as a central actor, bypassing the UI. */
async function strike(
  actorId: string,
  subjectId: string,
  opts: { confidential?: boolean } = {}
) {
  return issueAction(actorId, {
    personId: subjectId,
    occurredAt: new Date("2026-07-01"),
    category: "Attendance",
    description: "No-show to an assigned clinic shift.",
    confidential: opts.confidential ?? false,
  });
}

beforeEach(resetDb);

describe("notifyStrikeIssued", () => {
  it("notifies the subject and the directors of their department", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTM");
    const central = await createPerson("Central", "sn-central");
    const subject = await createPerson("Subject", "sn-subject");
    const director = await createPerson("Director", "sn-director");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    const subjectNotes = await prisma.notification.findMany({
      where: { personId: subject.id, type: "incidents.strike_issued" },
    });
    expect(subjectNotes).toHaveLength(1);

    const directorNotes = await prisma.notification.findMany({
      where: { personId: director.id, type: "incidents.strike_issued_directors" },
    });
    expect(directorNotes).toHaveLength(1);
    expect(directorNotes[0].body).toContain("Subject");
    expect(directorNotes[0].link).toMatch(/\/incidents\/strikes$/);
  });

  it("notifies no director when the strike is confidential", async () => {
    const term = await createTerm();
    const dept = await createDepartment("JCTM");
    const central = await createPerson("Central", "sn-conf-c");
    const subject = await createPerson("Subject", "sn-conf-s");
    const director = await createPerson("Director", "sn-conf-d");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id, { confidential: true });
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    // The subject is still told.
    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    // The director is not: directorVisibility would hide the row from them.
    expect(await prisma.notification.count({ where: { personId: director.id } })).toBe(0);
  });

  it("excludes the subject from the director set when the subject is themselves a director", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const central = await createPerson("Central", "sn-self-c");
    const subject = await createPerson("Director Subject", "sn-self-s");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(subject.id, term.id, dept.id, "DIRECTOR");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued_directors" },
      })
    ).toBe(0);
    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
  });

  it("excludes the issuing actor from the director set", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Issuing Director", "sn-act-d");
    const subject = await createPerson("Subject", "sn-act-s");
    await grantPermission(director.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const action = await strike(director.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: director.id });

    expect(await prisma.notification.count({ where: { personId: director.id } })).toBe(0);
  });

  it("notifies only the subject when they have no active membership", async () => {
    const central = await createPerson("Central", "sn-nomem-c");
    const subject = await createPerson("Subject", "sn-nomem-s");
    await grantPermission(central.id, "incidents.manage");

    const action = await strike(central.id, subject.id);
    await notifyStrikeIssued({ action, actorPersonId: central.id });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { type: "incidents.strike_issued_directors" } })
    ).toBe(0);
  });

  it("is a no-op, not a throw, when the subject no longer exists", async () => {
    const central = await createPerson("Central", "sn-throw-c");
    const subject = await createPerson("Subject", "sn-throw-s");
    await grantPermission(central.id, "incidents.manage");
    const action = await strike(central.id, subject.id);

    await prisma.disciplinaryAction.delete({ where: { id: action.id } });
    await prisma.person.delete({ where: { id: subject.id } });

    // The stale action object still resolves without throwing into the caller.
    await expect(
      notifyStrikeIssued({ action, actorPersonId: central.id })
    ).resolves.toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });
});
```

Note this case exercises the early `if (!subject) return;` guard, not the outer
`catch`. The `catch` is defensive against a render or queue failure and has no
cheap deterministic trigger; leave it untested rather than contriving one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/incidents/services/strike-notifications.test.ts`
Expected: FAIL -- cannot resolve `./strike-notifications`.

- [ ] **Step 3: Implement the service**

Create `src/modules/incidents/services/strike-notifications.ts`:

```ts
/**
 * Post-commit notification for an issued disciplinary strike.
 *
 * Both issue paths call this after their write commits: the Strikes ledger form
 * (gated on its "Notify by email" checkbox) and decideStrike (always). It cannot
 * live inside issueAction, which decideStrike calls with a transaction client --
 * queuing a notification inside that transaction would send mail for a strike
 * that might still roll back.
 *
 * Recipients:
 *   - The subject: incidents.strike_issued.
 *   - Directors of the subject's ACTIVE departments in the ACTIVE term:
 *     incidents.strike_issued_directors, resolved through the same
 *     departmentDirectorPersonIds helper compliance uses (so a one-hop
 *     DepartmentDelegation manager counts).
 *
 * A confidential strike notifies NO director. This mirrors directorVisibility()
 * in disciplinary.ts, where a director may only see a confidential row they
 * issued themselves; mailing them about a row they cannot open would leak it.
 * decideStrike sets confidential from report.anonymous, so anonymous-report
 * strikes are covered by the same rule.
 *
 * Best-effort throughout: every failure is logged and swallowed so it can never
 * throw out of, or roll back, a committed strike.
 */

import type { DisciplinaryAction } from "@prisma/client";
import { prisma } from "@/platform/db";
import { log, errorAttrs } from "@/platform/logging";
import { notify } from "@/platform/notifications/notify";
import { renderEmail } from "@/platform/email/templates/renderEmail";
import { strikeIssuedDirectorsContext } from "@/platform/email/templates/incidents";
import { getSetting } from "@/platform/settings/service";
import { getActiveTerm } from "@/platform/terms/active-term";
import { departmentDirectorPersonIds } from "@/platform/departments";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";
import { strikeCount } from "./disciplinary";

export type StrikeNotificationInput = {
  /** The committed strike. */
  action: DisciplinaryAction;
  /** Who issued it. Excluded from the director set. */
  actorPersonId: string;
};

/** Recipient shape notify() needs. */
type Recipient = {
  id: string;
  name: string;
  entraObjectId: string | null;
  contactEmail: string | null;
};

/**
 * Directors to alert about a strike against `subjectPersonId`: the union of
 * departmentDirectorPersonIds across every department the subject is an ACTIVE
 * member of in the ACTIVE term, minus the subject and the issuing actor.
 * Returns [] when there is no active term or no membership.
 */
async function directorRecipients(
  subjectPersonId: string,
  actorPersonId: string
): Promise<Recipient[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { personId: subjectPersonId, termId: activeTerm.id, status: "ACTIVE" },
    select: { departmentId: true },
  });
  if (memberships.length === 0) return [];

  const departmentIds = [...new Set(memberships.map((m) => m.departmentId))];
  const idLists = await Promise.all(departmentIds.map((d) => departmentDirectorPersonIds(d)));

  const ids = [...new Set(idLists.flat())].filter(
    (id) => id !== subjectPersonId && id !== actorPersonId
  );
  if (ids.length === 0) return [];

  return prisma.person.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, entraObjectId: true, contactEmail: true },
  });
}

/**
 * Notifies the subject of a strike and, unless it is confidential, the directors
 * of their departments. Never throws.
 */
export async function notifyStrikeIssued(input: StrikeNotificationInput): Promise<void> {
  const { action, actorPersonId } = input;
  try {
    const [subject, issuer, baseUrl, zone] = await Promise.all([
      prisma.person.findUnique({
        where: { id: action.personId },
        select: { id: true, name: true, entraObjectId: true, contactEmail: true },
      }),
      prisma.person.findUnique({ where: { id: actorPersonId }, select: { name: true } }),
      getSetting<string>("app.baseUrl"),
      getDisplayTimeZone(),
    ]);
    if (!subject) return;

    const issuedBy = issuer?.name ?? "HAVEN Directors";
    const issuedDate = formatDateOnly(action.occurredAt, zone, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    // --- The subject ---
    const subjectRendered = await renderEmail("incidents.strike_issued", {
      subjectName: subject.name.split(" ")[0] || subject.name,
      category: action.category,
      description: action.description,
      issuedBy,
      issuedDate,
    });
    await notify(prisma, {
      type: "incidents.strike_issued",
      person: subject,
      email: { subject: subjectRendered.subject, html: subjectRendered.html },
      teams: {
        title: "A disciplinary action has been recorded against you",
        summary: `A ${action.category} disciplinary action dated ${issuedDate} was recorded against you by ${issuedBy}.`,
      },
      triggeredById: actorPersonId,
    });

    // --- Their directors, unless the strike is confidential ---
    if (action.confidential) return;

    const directors = await directorRecipients(action.personId, actorPersonId);
    if (directors.length === 0) return;

    const ledgerLink = `${baseUrl}/incidents/strikes`;
    const total = await strikeCount(action.personId);
    const strikeLabel = `${total} strike${total === 1 ? "" : "s"}`;

    for (const director of directors) {
      const rendered = await renderEmail(
        "incidents.strike_issued_directors",
        strikeIssuedDirectorsContext({
          directorName: director.name,
          subjectName: subject.name,
          category: action.category,
          issuedDate,
          issuedBy,
          strikeCount: strikeLabel,
          ledgerLink,
        })
      );
      await notify(prisma, {
        type: "incidents.strike_issued_directors",
        person: director,
        email: { subject: rendered.subject, html: rendered.html },
        teams: {
          title: `Disciplinary action recorded for ${subject.name}`,
          summary: `A ${action.category} disciplinary action dated ${issuedDate} was recorded against ${subject.name} by ${issuedBy}. They now have ${strikeLabel} on file.`,
          link: ledgerLink,
        },
        triggeredById: actorPersonId,
      });
    }
  } catch (err) {
    log.error(
      "[incidents] failed to notify of an issued strike",
      errorAttrs(err, { actionId: action.id, personId: action.personId })
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/incidents/services/strike-notifications.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/incidents/services/strike-notifications.ts src/modules/incidents/services/strike-notifications.test.ts
git commit -m "feat(incidents): add notifyStrikeIssued for the subject and their directors

One post-commit helper both issue paths call. It cannot live in issueAction,
which decideStrike invokes with a transaction client. A confidential strike
notifies no director, mirroring directorVisibility: mailing them about a row
they cannot open on the ledger would leak it."
```

---

### Task 5: Route `decideStrike` through the new notifier

**Files:**
- Modify: `src/modules/incidents/services/report.ts:1014-1053`
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Consumes: `notifyStrikeIssued({ action, actorPersonId })` from Task 4.
- Produces: no signature change to `decideStrike`.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/incidents/services/report.test.ts`, in the `decideStrike` describe block:

```ts
it("notifies the subject and their directors when a strike is approved", async () => {
  const term = await createTerm();
  const dept = await createDepartment("SCTM");
  const central = await createPerson("Central", "ds-notif-c");
  const director = await createPerson("Dept Director", "ds-notif-d");
  const subject = await createPerson("Struck Volunteer", "ds-notif-s");
  const reporter = await createPerson("Reporter", "ds-notif-r");
  await grantPermission(central.id, "incidents.manage");
  await createMembership(director.id, term.id, dept.id, "DIRECTOR");
  await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

  const report = await submitReport(reporter.id, {
    concernTypes: ["ATTENDANCE_RELIABILITY"],
    description: "No-call/no-show for a Saturday clinic.",
    subjects: [{ personId: subject.id }],
  });
  const row = await prisma.incidentReportSubject.findFirstOrThrow({
    where: { reportId: report.id, personId: subject.id },
  });
  await prisma.incidentReportSubject.update({
    where: { id: row.id },
    data: { strikeDecision: "PENDING" },
  });

  await decideStrike(central.id, row.id, { approve: true, category: "Attendance" });

  expect(
    await prisma.notification.count({
      where: { personId: subject.id, type: "incidents.strike_issued" },
    })
  ).toBe(1);
  expect(
    await prisma.notification.count({
      where: { personId: director.id, type: "incidents.strike_issued_directors" },
    })
  ).toBe(1);
});

it("notifies no director when the report was anonymous, since the strike is confidential", async () => {
  const term = await createTerm();
  const dept = await createDepartment("JCTM");
  const central = await createPerson("Central", "ds-anon-c");
  const director = await createPerson("Dept Director", "ds-anon-d");
  const subject = await createPerson("Struck Volunteer", "ds-anon-s");
  const reporter = await createPerson("Reporter", "ds-anon-r");
  await grantPermission(central.id, "incidents.manage");
  await createMembership(director.id, term.id, dept.id, "DIRECTOR");
  await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

  const report = await submitReport(reporter.id, {
    concernTypes: ["PROFESSIONAL_CONDUCT"],
    description: "Anonymous concern.",
    anonymous: true,
    subjects: [{ personId: subject.id }],
  });
  const row = await prisma.incidentReportSubject.findFirstOrThrow({
    where: { reportId: report.id, personId: subject.id },
  });
  await prisma.incidentReportSubject.update({
    where: { id: row.id },
    data: { strikeDecision: "PENDING" },
  });

  await decideStrike(central.id, row.id, { approve: true, category: "Professionalism" });

  expect(
    await prisma.notification.count({
      where: { personId: subject.id, type: "incidents.strike_issued" },
    })
  ).toBe(1);
  expect(
    await prisma.notification.count({ where: { type: "incidents.strike_issued_directors" } })
  ).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/incidents/services/report.test.ts -t "notifies the subject and their directors"`
Expected: FAIL -- 0 director notifications (today's code queues an email directly and creates no `Notification` row for either party).

- [ ] **Step 3: Replace the inline block**

In `src/modules/incidents/services/report.ts`, delete the whole `try { ... } catch { ... }` block that starts at the `// Notify the subject that a strike has been officially issued against them.` comment and ends just before `return approved;`, and replace it with:

```ts
  // The subject, and their directors unless the strike is confidential. Runs
  // after the transaction commits, so a rollback never mails anyone.
  await notifyStrikeIssued({ action: strikeAction, actorPersonId });

  return approved;
```

Add the import near the other local-service imports:

```ts
import { notifyStrikeIssued } from "./strike-notifications";
```

Then remove every import that block was the sole user of. Check each of these and drop the ones now unreferenced anywhere else in the file: `queueEmail`, `getDisplayTimeZone`, `formatDateOnly`. Confirm with:

```bash
grep -n "queueEmail\|getDisplayTimeZone\|formatDateOnly" src/modules/incidents/services/report.ts
```

Only lines that are import statements means the import is dead and must be deleted; `npm run lint` will fail on an unused import otherwise.

- [ ] **Step 4: Run the report suite**

Run: `npx vitest run src/modules/incidents/services/report.test.ts`
Expected: PASS, including the pre-existing `decideStrike` and notification tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "refactor(incidents): route decideStrike's strike email through notifyStrikeIssued

Replaces the inline renderEmail/queueEmail block, which bypassed notify() (no
inbox row, no Teams option, no admin channel) and swallowed errors in a bare
catch with no logging. Approving a strike now also alerts the subject's
directors, unless the report was anonymous and the strike confidential."
```

---

### Task 6: `strikeablePeople()` for the person combobox

**Files:**
- Modify: `src/modules/incidents/services/disciplinary.ts`
- Test: `src/modules/incidents/services/disciplinary.test.ts`

**Interfaces:**
- Produces: `strikeablePeople(actorPersonId: string): Promise<Array<{ id: string; name: string; hint: string | null }>>`.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/modules/incidents/services/disciplinary.test.ts`:

```ts
describe("strikeablePeople", () => {
  it("returns an empty list for a non-central actor", async () => {
    const director = await createPerson("Director", "sp-nc-d");
    expect(await strikeablePeople(director.id)).toEqual([]);
  });

  it("includes offboarded people so a strike can still be recorded against them", async () => {
    const central = await createPerson("Central", "sp-inact-c");
    await grantPermission(central.id, "incidents.manage");
    const gone = await prisma.person.create({
      data: { name: "Departed Volunteer", netId: "sp-gone", status: "OFFBOARDED" },
    });

    const people = await strikeablePeople(central.id);
    const row = people.find((p) => p.id === gone.id);
    expect(row).toBeDefined();
    expect(row!.hint).toContain("offboarded");
  });

  it("sorts active people before offboarded ones, then by name", async () => {
    const central = await createPerson("Central", "sp-sort-c");
    await grantPermission(central.id, "incidents.manage");
    await prisma.person.create({
      data: { name: "Aaron Inactive", netId: "sp-sort-a", status: "OFFBOARDED" },
    });
    const zoe = await prisma.person.create({
      data: { name: "Zoe Active", netId: "sp-sort-z", status: "ACTIVE" },
    });

    const people = await strikeablePeople(central.id);
    const zoeIdx = people.findIndex((p) => p.id === zoe.id);
    const aaronIdx = people.findIndex((p) => p.name === "Aaron Inactive");
    expect(zoeIdx).toBeLessThan(aaronIdx);
  });

  it("hints the active-term department and kind so same-named people are distinguishable", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTM");
    const central = await createPerson("Central", "sp-hint-c");
    await grantPermission(central.id, "incidents.manage");
    const vol = await createPerson("Hinted Volunteer", "sp-hint-v");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const people = await strikeablePeople(central.id);
    const row = people.find((p) => p.id === vol.id);
    expect(row!.hint).toContain("SCTM");
    expect(row!.hint).toContain("volunteer");
  });
});
```

Add `strikeablePeople` to the import list at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts -t strikeablePeople`
Expected: FAIL -- `strikeablePeople is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/modules/incidents/services/disciplinary.ts`:

```ts
/**
 * The people a central reviewer may pick in the Record Disciplinary Action
 * combobox. Central (incidents.manage) only; returns [] otherwise, since
 * directors use the scoped issuablePeople select instead.
 *
 * Returns EVERY person, not just ACTIVE ones. The free-text NetID/email lookup
 * this replaces had no status filter, so restricting to ACTIVE would silently
 * remove the ability to record a strike against someone who has since
 * offboarded. OFFBOARDED people sort last and carry an "offboarded" hint.
 *
 * `hint` mirrors listSubjectOptions' convention (active-term department codes
 * plus volunteer/director) so same-named people are distinguishable.
 */
export async function strikeablePeople(actorPersonId: string): Promise<
  Array<{ id: string; name: string; hint: string | null }>
> {
  if (!(await can(actorPersonId, "incidents.manage"))) return [];

  const activeTerm = await getActiveTerm();
  const [persons, memberships] = await Promise.all([
    prisma.person.findMany({
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    }),
    activeTerm
      ? prisma.termMembership.findMany({
          where: { termId: activeTerm.id, status: "ACTIVE" },
          select: { personId: true, kind: true, department: { select: { code: true } } },
        })
      : [],
  ]);

  const hints = new Map<string, { depts: Set<string>; kinds: Set<string> }>();
  for (const m of memberships) {
    const entry = hints.get(m.personId) ?? { depts: new Set<string>(), kinds: new Set<string>() };
    if (m.department?.code) entry.depts.add(m.department.code);
    if (m.kind) entry.kinds.add(m.kind === "DIRECTOR" ? "director" : "volunteer");
    hints.set(m.personId, entry);
  }

  return persons
    .map((p) => {
      const h = hints.get(p.id);
      const parts = h
        ? [[...h.depts].sort().join(", "), [...h.kinds].sort().join("/")].filter(Boolean)
        : [];
      // PersonStatus is ACTIVE | OFFBOARDED -- there is no INACTIVE value.
      if (p.status !== "ACTIVE") parts.push("offboarded");
      return { id: p.id, name: p.name, hint: parts.join(" ") || null, active: p.status === "ACTIVE" };
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map(({ id, name, hint }) => ({ id, name, hint }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts -t strikeablePeople`
Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/disciplinary.ts src/modules/incidents/services/disciplinary.test.ts
git commit -m "feat(incidents): add strikeablePeople for the strikes person picker

Backs a searchable combobox for central reviewers, replacing the blind
NetID/email text box. Returns every person, not just ACTIVE ones: the lookup it
replaces had no status filter, so restricting it would drop the ability to
record a strike against someone who has offboarded."
```

---

### Task 7: `linkableReports()` for the incident-report picker

**Files:**
- Modify: `src/modules/incidents/services/report.ts`
- Test: `src/modules/incidents/services/report.test.ts`

**Interfaces:**
- Produces: `linkableReports(actorPersonId: string): Promise<Array<{ id: string; label: string }>>`.
- Consumes: existing module-private `CONCERN_LABELS`, `getDisplayTimeZone`, `formatDateOnly`.

**Note:** Task 5 may have deleted the `getDisplayTimeZone` / `formatDateOnly` imports from this file. Re-add whichever this task needs.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/modules/incidents/services/report.test.ts`:

```ts
describe("linkableReports", () => {
  it("rejects an actor without incidents.manage", async () => {
    const nobody = await createPerson("Nobody", "lr-nc");
    await expect(linkableReports(nobody.id)).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("labels a report with its number, concern types, and date, newest first", async () => {
    const central = await createPerson("Central", "lr-c");
    const reporter = await createPerson("Reporter", "lr-r");
    await grantPermission(central.id, "incidents.manage");

    const older = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Older report.",
    });
    const newer = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY", "PRIVACY_HIPAA"],
      description: "Newer report.",
    });

    const rows = await linkableReports(central.id);
    expect(rows[0].id).toBe(newer.id);
    expect(rows[0].label).toContain(`#${newer.number}`);
    expect(rows[0].label).toContain("Patient Safety");
    expect(rows[1].id).toBe(older.id);
  });

  it("caps the list at 200 reports", async () => {
    const central = await createPerson("Central", "lr-cap-c");
    const reporter = await createPerson("Reporter", "lr-cap-r");
    await grantPermission(central.id, "incidents.manage");

    await prisma.incidentReport.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        number: 5000 + i,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: `Bulk report ${i}.`,
      })),
    });

    expect(await linkableReports(central.id)).toHaveLength(200);
  });
});
```

Add `linkableReports` to the import list at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/incidents/services/report.test.ts -t linkableReports`
Expected: FAIL -- `linkableReports is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/modules/incidents/services/report.ts`, near `listReviewQueue`:

```ts
/** How many reports the strike-linking picker offers. */
const LINKABLE_REPORT_LIMIT = 200;

/**
 * Reports a central reviewer may link a strike to, newest first, for the
 * Combobox on the Strikes page.
 *
 * Requires incidents.manage -> IncidentForbiddenError. Capped at
 * LINKABLE_REPORT_LIMIT: the Combobox filters client-side over whatever it is
 * given, so this deliberately does not ship the full history. Older reports are
 * linked by deleting and re-recording the strike, or by raising the cap.
 */
export async function linkableReports(
  actorPersonId: string
): Promise<Array<{ id: string; label: string }>> {
  if (!(await can(actorPersonId, "incidents.manage"))) throw new IncidentForbiddenError();

  const zone = await getDisplayTimeZone();
  const reports = await prisma.incidentReport.findMany({
    select: { id: true, number: true, concernTypes: true, createdAt: true },
    // CORRECTION (applied during execution, commit 311e9cc0): the secondary
    // `number` key was missing here. createdAt has millisecond precision, so
    // same-millisecond inserts ordered nondeterministically, and the newest-first
    // test creates two reports back to back. listReviewQueue in this same file
    // already documents and uses this tiebreaker; number is @unique autoincrement.
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
    take: LINKABLE_REPORT_LIMIT,
  });

  return reports.map((r) => {
    const concerns = r.concernTypes.map((c) => CONCERN_LABELS[c] ?? c).join(", ");
    const date = formatDateOnly(r.createdAt, zone, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return { id: r.id, label: `#${r.number} -- ${concerns} -- ${date}` };
  });
}
```

Re-add these imports if Task 5 removed them:

```ts
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/incidents/services/report.test.ts -t linkableReports`
Expected: PASS, all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/modules/incidents/services/report.ts src/modules/incidents/services/report.test.ts
git commit -m "feat(incidents): add linkableReports for the strike-to-report picker

Newest-first report options for the Strikes page, capped at 200 since the
Combobox filters client-side."
```

---

### Task 8: `linkActionToReport()`

**Files:**
- Modify: `src/modules/incidents/services/disciplinary.ts`
- Test: `src/modules/incidents/services/disciplinary.test.ts`

**Interfaces:**
- Produces: `linkActionToReport(actorPersonId: string, actionId: string, reportId: string | null): Promise<DisciplinaryAction>`.
- Consumes: existing `isUniqueConstraintError` from `@/platform/db`.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/modules/incidents/services/disciplinary.test.ts`:

```ts
describe("linkActionToReport", () => {
  async function setup(prefix: string) {
    const central = await createPerson("Central", `${prefix}-c`);
    const subject = await createPerson("Subject", `${prefix}-s`);
    const reporter = await createPerson("Reporter", `${prefix}-r`);
    await grantPermission(central.id, "incidents.manage");
    const report = await prisma.incidentReport.create({
      data: {
        number: Math.floor(Math.random() * 100000) + 10000,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: "A report to link against.",
      },
    });
    const action = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-01"),
      category: "Attendance",
      description: "Recorded directly on the ledger.",
    });
    return { central, subject, report, action };
  }

  it("links a strike to a report", async () => {
    const { central, report, action } = await setup("lat-ok");

    const linked = await linkActionToReport(central.id, action.id, report.id);
    expect(linked.reportId).toBe(report.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "disciplinary.link_report", entityId: action.id },
    });
    expect(audit).not.toBeNull();
  });

  it("unlinks when passed null", async () => {
    const { central, report, action } = await setup("lat-unlink");
    await linkActionToReport(central.id, action.id, report.id);

    const unlinked = await linkActionToReport(central.id, action.id, null);
    expect(unlinked.reportId).toBeNull();
  });

  it("rejects an actor without incidents.manage", async () => {
    const { report, action } = await setup("lat-forbid");
    const director = await createPerson("Director", "lat-forbid-d");

    await expect(
      linkActionToReport(director.id, action.id, report.id)
    ).rejects.toBeInstanceOf(DisciplinaryForbiddenError);
  });

  it("rejects an unknown action or report", async () => {
    const { central, action } = await setup("lat-404");

    await expect(
      linkActionToReport(central.id, "no-such-action", null)
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
    await expect(
      linkActionToReport(central.id, action.id, "no-such-report")
    ).rejects.toBeInstanceOf(DisciplinaryNotFoundError);
  });

  it("translates the composite-unique collision into a readable validation error", async () => {
    const { central, subject, report, action } = await setup("lat-dup");
    await linkActionToReport(central.id, action.id, report.id);

    // A second strike against the SAME person cannot also claim that report.
    const second = await issueAction(central.id, {
      personId: subject.id,
      occurredAt: new Date("2026-07-02"),
      category: "Professionalism",
      description: "A second strike for the same person.",
    });

    await expect(
      linkActionToReport(central.id, second.id, report.id)
    ).rejects.toBeInstanceOf(DisciplinaryValidationError);
  });
});
```

Add `linkActionToReport` to the import list at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts -t linkActionToReport`
Expected: FAIL -- `linkActionToReport is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/modules/incidents/services/disciplinary.ts`, and add `isUniqueConstraintError` to the existing `@/platform/db` import:

```ts
/**
 * Attaches a strike to an incident report, or detaches it when reportId is null.
 * The only field on an existing strike this module lets a reviewer change.
 *
 * Requires incidents.manage -> DisciplinaryForbiddenError. Directors may not
 * relink, mirroring deleteAction.
 *
 * DisciplinaryAction is unique per (reportId, personId), so a report that
 * already carries a strike for this person surfaces as a readable
 * DisciplinaryValidationError rather than a raw 500.
 *
 * Audits disciplinary.link_report with the before/after reportId.
 */
export async function linkActionToReport(
  actorPersonId: string,
  actionId: string,
  reportId: string | null
): Promise<DisciplinaryAction> {
  if (!(await can(actorPersonId, "incidents.manage"))) {
    throw new DisciplinaryForbiddenError(
      "incidents.manage is required to link a disciplinary action to a report."
    );
  }

  const row = await prisma.disciplinaryAction.findUnique({ where: { id: actionId } });
  if (!row) throw new DisciplinaryNotFoundError();

  if (reportId) {
    const report = await prisma.incidentReport.findUnique({
      where: { id: reportId },
      select: { id: true },
    });
    if (!report) throw new DisciplinaryNotFoundError(`Incident report ${reportId} not found.`);
  }

  let updated: DisciplinaryAction;
  try {
    updated = await prisma.disciplinaryAction.update({
      where: { id: actionId },
      data: { reportId },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DisciplinaryValidationError(
        "That incident report already has a strike for this person."
      );
    }
    throw err;
  }

  await recordAudit({
    actorPersonId,
    action: "disciplinary.link_report",
    entityType: "DisciplinaryAction",
    entityId: actionId,
    before: { reportId: row.reportId },
    after: { reportId },
  });

  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/incidents/services/disciplinary.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/incidents/services/disciplinary.ts src/modules/incidents/services/disciplinary.test.ts
git commit -m "feat(incidents): add linkActionToReport for retroactive strike-to-INC linking

incidents.manage only, audited, with the (reportId, personId) composite-unique
collision translated into a readable validation error instead of a 500."
```

---

### Task 9: Strikes page -- comboboxes, report picker, notify checkbox

**Files:**
- Modify: `src/app/(app)/incidents/strikes/page.tsx`

**Interfaces:**
- Consumes: `strikeablePeople` (Task 6), `linkableReports` (Task 7), `notifyStrikeIssued` (Task 4), existing `Combobox` from `@/platform/ui/combobox`.
- Produces: nothing consumed by later tasks except the `linkReportForm` server action, which Task 10 receives as a prop with signature `(formData: FormData) => Promise<void>` reading `actionId` and `reportId` (empty string means unlink).

- [ ] **Step 1: Add the imports and load the new option lists**

At the top of `src/app/(app)/incidents/strikes/page.tsx`, add:

```ts
import { Combobox } from "@/platform/ui/combobox";
import { linkableReports } from "@/modules/incidents/services/report";
```

and extend the existing `@/modules/incidents/services/disciplinary` import with `strikeablePeople` and `linkActionToReport`.

Replace the single `issuablePeople` load with a parallel load, right after `const viewer = await requirePermission(...)` and the searchParams parsing:

```ts
  // Load the pickers for the issue form. strikeablePeople and linkableReports
  // are central-only and return empty / throw for directors, so only fetch them
  // when the viewer actually holds incidents.manage.
  const isCentral = await can(viewer.personId, "incidents.manage");
  const [issuable, searchablePeople, reportOptions] = await Promise.all([
    issuablePeople(viewer.personId),
    isCentral ? strikeablePeople(viewer.personId) : Promise.resolve([]),
    isCentral ? linkableReports(viewer.personId) : Promise.resolve([]),
  ]);
```

- [ ] **Step 2: Replace the free-text person input with a combobox**

Swap the `issuable.all` branch of the person picker (currently an `<Input name="personKey">`) for:

```tsx
              {issuable.all ? (
                <div className="w-72">
                  <Field label="Person" required>
                    <Combobox
                      name="personId"
                      ariaLabel="Person"
                      placeholder="Search by name..."
                      options={searchablePeople.map((p) => ({
                        value: p.id,
                        label: p.hint ? `${p.name} (${p.hint})` : p.name,
                      }))}
                    />
                  </Field>
                </div>
              ) : (
```

Leave the director `<Select name="personId">` branch untouched.

- [ ] **Step 3: Add the report picker and the notify checkbox**

After the Category field, add:

```tsx
              {/* Optional link to the incident report this strike relates to. */}
              <div className="w-72">
                <Field label="Related incident report">
                  <Combobox
                    name="reportId"
                    ariaLabel="Related incident report"
                    placeholder="Search reports..."
                    emptyLabel="No matching reports"
                    options={reportOptions.map((r) => ({ value: r.id, label: r.label }))}
                  />
                </Field>
              </div>
```

Add to the existing checkbox row, as the first item:

```tsx
                <label className="flex items-center gap-2 text-sm text-foreground-soft cursor-pointer">
                  <Checkbox name="notifyPeople" defaultChecked />
                  Notify by email
                </label>
```

- [ ] **Step 4: Update `issueActionForm`**

Delete the `personKey` fallback branch entirely (the `if (!personId) { ... }` block that does the `findFirst` lookup) and replace the person resolution with:

```ts
    const personId = (formData.get("personId") as string | null) || null;
    if (!personId) {
      redirect("/incidents/strikes?error=person-not-found");
    }
```

Read the two new fields alongside the existing ones:

```ts
    const reportId = (formData.get("reportId") as string | null) || null;
    const notifyPeople = formData.get("notifyPeople") === "on";
```

Pass `reportId` into the `issueAction` call, capture its return, and notify after it resolves:

```ts
    let action;
    try {
      action = await issueAction(actor.personId, {
        personId,
        occurredAt: occurredAt!,
        category,
        description,
        followUpActions,
        policyReference,
        notes,
        confidential,
        patientInvolved,
        reportId,
      });
    } catch (err) {
      // ... existing catch block unchanged
    }

    // After the write commits, never inside it: a rollback must not mail anyone.
    if (notifyPeople) {
      await notifyStrikeIssued({ action, actorPersonId: actor.personId });
    }

    revalidatePath("/incidents/strikes");
    redirect("/incidents/strikes");
```

Add the import:

```ts
import { notifyStrikeIssued } from "@/modules/incidents/services/strike-notifications";
```

Note the existing `personId!` non-null assertions in the `issueAction` call can now be dropped, since `personId` is narrowed by the `redirect` above (`redirect` returns `never`).

- [ ] **Step 5: Add the `linkReportForm` server action**

Beside `deleteActionForm`, add:

```ts
  async function linkReportForm(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.manage");
    const actionId = (formData.get("actionId") as string | null) ?? "";
    // An empty value means unlink.
    const reportId = (formData.get("reportId") as string | null) || null;
    try {
      await linkActionToReport(actor.personId, actionId, reportId);
    } catch (err) {
      if (err instanceof DisciplinaryForbiddenError) {
        redirect("/incidents/strikes?error=forbidden");
      }
      if (err instanceof DisciplinaryNotFoundError) {
        redirect("/incidents/strikes?error=not-found");
      }
      if (err instanceof DisciplinaryValidationError) {
        redirect(
          `/incidents/strikes?error=validation&message=${encodeURIComponent(err.message)}`
        );
      }
      throw err;
    }
    revalidatePath("/incidents/strikes");
    redirect("/incidents/strikes");
  }
```

- [ ] **Step 6: Typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean. The build catches RSC boundary errors the other two miss.

- [ ] **Step 7: Verify in the running app**

Run `npm run dev`, sign in as a user with `incidents.manage`, and open `/incidents/strikes`. Confirm:
- The Person field is a search box that filters as you type.
- "Related incident report" lists reports as `#N -- Concerns -- Date`.
- "Notify by email" is checked by default.
- Recording a strike succeeds and redirects cleanly.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/incidents/strikes/page.tsx"
git commit -m "feat(incidents): searchable person picker, report link, and notify toggle on the strikes form

Replaces the blind NetID/email box with a combobox, adds an optional related
incident report, and gates the new subject/director notification on a
'Notify by email' checkbox so historical back-fills stay quiet."
```

---

### Task 10: Expandable strike rows with the link/unlink control

**Files:**
- Create: `src/app/(app)/incidents/strikes/strike-row.tsx`
- Modify: `src/app/(app)/incidents/strikes/page.tsx`

**Interfaces:**
- Consumes: `linkReportForm` and `deleteActionForm` from Task 9, both `(formData: FormData) => Promise<void>`.
- Produces: the `StrikeRow` client component.

- [ ] **Step 1: Create the client component**

Create `src/app/(app)/incidents/strikes/strike-row.tsx`:

```tsx
"use client";

import { useId, useState } from "react";
import { TR, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Combobox } from "@/platform/ui/combobox";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";

/**
 * One row of the strikes ledger, with an expandable detail row.
 *
 * The collapsed row is the ledger's seven columns; the Description cell doubles
 * as the expand toggle, since a clamped description is the reason ops asked for
 * this. Expanding reveals the full description plus the fields the table has no
 * room for (follow-up actions, policy reference, internal notes) and, for
 * central reviewers, the control that links this strike to an incident report.
 *
 * Every prop is plain serialized data: dates arrive preformatted from the server
 * so no Date instance crosses the RSC boundary. The two server actions pass
 * through as props, which RSC supports.
 */
export type StrikeRowProps = {
  action: {
    id: string;
    occurredLabel: string;
    category: string;
    description: string;
    followUpActions: string | null;
    policyReference: string | null;
    notes: string | null;
    confidential: boolean;
    patientInvolved: boolean;
    reportId: string | null;
    reportLabel: string | null;
  };
  personName: string;
  issuedByName: string;
  strikes: number;
  canManageAll: boolean;
  /** Report options for the link control. Empty for non-central viewers. */
  reportOptions: Array<{ value: string; label: string }>;
  deleteAction: (formData: FormData) => Promise<void>;
  linkReport: (formData: FormData) => Promise<void>;
};

export function StrikeRow({
  action,
  personName,
  issuedByName,
  strikes,
  canManageAll,
  reportOptions,
  deleteAction,
  linkReport,
}: StrikeRowProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  // Seven data columns, plus the actions column for central reviewers.
  const columnCount = canManageAll ? 8 : 7;

  return (
    <>
      <TR>
        <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
          {action.occurredLabel}
        </TD>
        <TD className="font-medium">{personName}</TD>
        <TD>
          <Badge tone="default">{action.category}</Badge>
        </TD>
        <TD className="max-w-xs text-sm text-foreground-soft">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            className="w-full text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 rounded-lg"
          >
            <span className={open ? undefined : "line-clamp-2"}>{action.description}</span>
            <span className="mt-0.5 block text-xs text-subtle-foreground">
              {open ? "Hide details" : "Show details"}
            </span>
          </button>
        </TD>
        <TD className="text-sm text-foreground-soft">{issuedByName}</TD>
        <TD>
          <div className="flex items-center gap-1.5 flex-wrap">
            {action.confidential && <Badge tone="warning">Confidential</Badge>}
            {action.patientInvolved && <Badge tone="critical">Patient</Badge>}
          </div>
        </TD>
        <TD className="tabular-nums text-sm font-medium text-foreground-soft">{strikes}</TD>
        {canManageAll && (
          <TD>
            <form action={deleteAction}>
              <input type="hidden" name="actionId" value={action.id} />
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this disciplinary action? This cannot be undone."
              />
            </form>
          </TD>
        )}
      </TR>

      {open && (
        <TR id={detailId}>
          <TD colSpan={columnCount} className="bg-muted/40">
            <dl className="grid gap-4 py-2 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="font-medium text-foreground">Description</dt>
                <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">
                  {action.description}
                </dd>
              </div>

              {action.followUpActions && (
                <div>
                  <dt className="font-medium text-foreground">Follow-up actions</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">
                    {action.followUpActions}
                  </dd>
                </div>
              )}

              {action.policyReference && (
                <div>
                  <dt className="font-medium text-foreground">Policy reference</dt>
                  <dd className="mt-1 text-foreground-soft">{action.policyReference}</dd>
                </div>
              )}

              {action.notes && (
                <div className="sm:col-span-2">
                  <dt className="font-medium text-foreground">Internal notes</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-foreground-soft">{action.notes}</dd>
                </div>
              )}

              <div className="sm:col-span-2">
                <dt className="font-medium text-foreground">Incident report</dt>
                <dd className="mt-1 text-foreground-soft">
                  {action.reportLabel ?? "Not linked to a report."}
                </dd>

                {canManageAll && (
                  <dd className="mt-2">
                    {action.reportId ? (
                      <form action={linkReport}>
                        <input type="hidden" name="actionId" value={action.id} />
                        <input type="hidden" name="reportId" value="" />
                        <Button type="submit" variant="outline" size="sm">
                          Unlink report
                        </Button>
                      </form>
                    ) : (
                      <form action={linkReport} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="actionId" value={action.id} />
                        <div className="w-72">
                          <Combobox
                            name="reportId"
                            ariaLabel={`Link ${personName}'s strike to an incident report`}
                            placeholder="Search reports..."
                            emptyLabel="No matching reports"
                            options={reportOptions}
                          />
                        </div>
                        <Button type="submit" variant="outline" size="sm">
                          Link report
                        </Button>
                      </form>
                    )}
                  </dd>
                )}
              </div>
            </dl>
          </TD>
        </TR>
      )}
    </>
  );
}
```

- [ ] **Step 2: Load the report label for each row**

In `page.tsx`, after `listActions` returns, resolve a label for any linked report so the detail row can name it. Add after the `rows` / `total` / `canManageAll` destructuring:

```ts
  // Label any report a visible strike is linked to. One query, no N+1.
  const linkedReportIds = [...new Set(rows.map((r) => r.action.reportId).filter(Boolean))] as string[];
  const linkedReports = linkedReportIds.length
    ? await prisma.incidentReport.findMany({
        where: { id: { in: linkedReportIds } },
        select: { id: true, number: true },
      })
    : [];
  const reportLabelById = new Map(linkedReports.map((r) => [r.id, `Incident report #${r.number}`]));
```

- [ ] **Step 3: Render `StrikeRow` in the table body**

Replace the whole `rows.map(...)` block inside `<tbody>` with:

```tsx
                {rows.map(({ action, personName, issuedByName, strikes }) => (
                  <StrikeRow
                    key={action.id}
                    action={{
                      id: action.id,
                      occurredLabel: formatDateOnly(action.occurredAt, displayZone, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      }),
                      category: action.category,
                      description: action.description,
                      followUpActions: action.followUpActions,
                      policyReference: action.policyReference,
                      notes: action.notes,
                      confidential: action.confidential,
                      patientInvolved: action.patientInvolved,
                      reportId: action.reportId,
                      reportLabel: action.reportId
                        ? (reportLabelById.get(action.reportId) ?? null)
                        : null,
                    }}
                    personName={personName}
                    issuedByName={issuedByName}
                    strikes={strikes}
                    canManageAll={canManageAll}
                    reportOptions={reportOptions.map((r) => ({ value: r.id, label: r.label }))}
                    deleteAction={deleteActionForm}
                    linkReport={linkReportForm}
                  />
                ))}
```

Add the imports and resolve the display zone near the other page-level loads:

```ts
import { StrikeRow } from "./strike-row";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";
```

```ts
  const displayZone = await getDisplayTimeZone();
```

The `CalendarDate` import becomes unused once the row moves into `StrikeRow`; remove it. Confirm with `grep -n "CalendarDate" "src/app/(app)/incidents/strikes/page.tsx"`.

- [ ] **Step 4: Typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean. The build is the gate that catches an RSC boundary violation (for example a non-serializable prop crossing into the client component).

- [ ] **Step 5: Verify in the running app**

Run `npm run dev` and open `/incidents/strikes` as a user with `incidents.manage`. Confirm:
- "Show details" expands a full-width row under the strike with the complete description.
- Follow-up actions, policy reference, and notes appear only when the strike has them.
- An unlinked strike offers a report search plus "Link report"; linking succeeds and the row then offers "Unlink report".
- Linking a second strike for the same person to the same report shows the "already has a strike for this person" alert rather than a crash.
- Delete still works.
- Sign in as a director (holds `incidents.view_strikes` but not `incidents.manage`): rows expand and read, but no link control and no delete button appear.

- [ ] **Step 6: Run the whole suite**

Run: `npm run test && npm run lint`
Expected: all green. Note `inbox.test.ts` has a known `createdAt`-tie ordering flake that is not a regression.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/incidents/strikes/strike-row.tsx" "src/app/(app)/incidents/strikes/page.tsx"
git commit -m "feat(incidents): expandable strike rows with report link/unlink

The Description cell now toggles a detail row exposing the full text plus
follow-up actions, policy reference, internal notes, and the linked incident
report. Central reviewers get link and unlink controls there; directors get the
read-only view."
```

---

## Wrap-up

- [ ] **Run the full gate**

```bash
npm run lint && npm run typecheck && npm run test
```

- [ ] **Tell ops before this reaches production.** Ledger-recorded strikes have never notified anyone. After this ships, the first strike recorded on `/incidents/strikes` emails the subject and their department directors by default. The per-strike "Notify by email" checkbox and the per-type channel settings under `/admin` are the controls.
