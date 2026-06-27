# Returning-Applicant Sign-In and Auto-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require returning applicants to sign in with Yale on the public apply page, verify they are a current volunteer, pre-fill their known info, and link the submission to their `Person`.

**Architecture:** The public apply page reads the session optionally via `auth()`. A new `renewal.ts` service computes eligibility + prefill from the person's active volunteer `TermMembership`. The form gates the Returning branch behind sign-in (a `/login?callbackUrl=` redirect) and applies prefill. The submit path re-verifies server-side, overrides the locked email with the SSO-verified address, and stamps `applicantPersonId`.

**Tech Stack:** Next.js 16 (App Router, server components + actions), React 19, Prisma/Postgres, NextAuth (Microsoft Entra ID), Vitest (node env), Tailwind v4.

## Global Constraints

- No em-dashes in user-facing copy or code comments. Use commas, parentheses, or colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay `havenhub`.
- New applicants stay anonymous and unchanged: `applicantPersonId` is `null` for them.
- The locked email is server-authoritative: for a `RENEWAL`, the server re-derives the email from the verified session and ignores the client-submitted value. Never trust `Person.contactEmail` or the client for the locked field.
- Eligibility = the person has an active (`status === "ACTIVE"`) `VOLUNTEER` `TermMembership`; their renewal departments are that membership's department `code`s from the most-recent term (by `term.startDate`).
- No new dependencies.
- Vitest runs in `environment: "node"` (no DOM): only logic + DB paths get automated tests; React components are verified by `npm run typecheck`, `npm run lint`, `npm run build`, and manual review.
- Tests use `resetDb()` from `@/platform/test/db` in `beforeEach`/`afterEach`; run a single file with `npx vitest run <path>`. After adding the migration, apply it to the test DB before running DB tests (Step in Task 1).

---

### Task 1: Schema — link Applicant to Person

**Files:**
- Modify: `prisma/schema.prisma` (`Applicant` model ~912-928; `Person` model ~66-137)
- Create: `prisma/migrations/<timestamp>_applicant_person_link/migration.sql` (generated)
- Test: `src/modules/recruitment/services/submissions.test.ts` (add one test)

**Interfaces:**
- Produces: `Applicant.applicantPersonId: string | null` with relation `applicantPerson`, `@@unique([cycleId, applicantPersonId])`, `@@index([applicantPersonId])`; `Person.applicantSubmissions Applicant[]`.

- [ ] **Step 1: Edit the `Applicant` model**

In `prisma/schema.prisma`, the `Applicant` model becomes:

```prisma
model Applicant {
  id         String   @id @default(cuid())
  cycleId    String
  applicantPersonId String?
  firstName  String
  lastName   String
  email      String
  /// Must equal lower(email); set by the submission service. Backs the (cycleId, emailLower) dedup unique.
  emailLower String
  netId      String?
  phone      String?
  createdAt  DateTime @default(now())

  cycle           RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  /// Set for signed-in renewals; null for anonymous new applicants. Links the
  /// submission to the verified HAVEN Hub account.
  applicantPerson Person?          @relation("ApplicantPerson", fields: [applicantPersonId], references: [id], onDelete: SetNull)
  applications    Application[]

  @@unique([cycleId, emailLower])
  @@unique([cycleId, applicantPersonId])
  @@index([applicantPersonId])
}
```

- [ ] **Step 2: Add the back-reference to `Person`**

In the `Person` model, add this line alongside the other relations (e.g. just after `memberships TermMembership[]` at line ~86):

```prisma
  applicantSubmissions      Applicant[]          @relation("ApplicantPerson")
```

- [ ] **Step 3: Create and apply the migration**

Run: `npx prisma migrate dev --name applicant_person_link`
Expected: a new migration folder under `prisma/migrations/`, applied to the dev DB, and `prisma generate` runs. Confirm the generated SQL adds the `applicantPersonId` column, a unique index on `(cycleId, applicantPersonId)`, and an index on `applicantPersonId`.

Then apply it to the test DB so the DB tests see the column:
Run: `DATABASE_URL="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" DATABASE_URL_UNPOOLED="${TEST_DATABASE_URL:-postgresql://haven:haven_dev@localhost:5434/havenhub_test}" npx prisma migrate deploy`
Expected: "All migrations have been successfully applied" (or "No pending migrations" if already applied).

- [ ] **Step 4: Write the failing test (constraint behavior)**

Add to `src/modules/recruitment/services/submissions.test.ts` (it already imports `prisma`, `resetDb`, and has `openVolunteerCycle`):

```ts
it("links an applicant to a person and blocks a second per cycle, but allows anonymous applicants", async () => {
  const { cycle } = await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Reed", status: "ACTIVE" } });

  await prisma.applicant.create({
    data: { cycleId: cycle.id, applicantPersonId: person.id, firstName: "Reed", lastName: "R", email: "reed@yale.edu", emailLower: "reed@yale.edu" },
  });

  // Same person, same cycle -> unique violation (P2002).
  await expect(
    prisma.applicant.create({
      data: { cycleId: cycle.id, applicantPersonId: person.id, firstName: "Reed", lastName: "R", email: "reed2@yale.edu", emailLower: "reed2@yale.edu" },
    })
  ).rejects.toMatchObject({ code: "P2002" });

  // Two anonymous applicants (null personId) in the same cycle are fine.
  await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "A", email: "a@yale.edu", emailLower: "a@yale.edu" } });
  await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "B", lastName: "B", email: "b@yale.edu", emailLower: "b@yale.edu" } });
  const anon = await prisma.applicant.count({ where: { cycleId: cycle.id, applicantPersonId: null } });
  expect(anon).toBe(2);
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "links an applicant to a person"`
Expected: PASS (the schema change + migration make it pass). If it fails with "Unknown arg `applicantPersonId`", the migration was not applied to the test DB; re-run Step 3's deploy command.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): link Applicant to Person for renewals"
```

---

### Task 2: Renewal eligibility + prefill service

**Files:**
- Create: `src/modules/recruitment/services/renewal.ts`
- Test: `src/modules/recruitment/services/renewal.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/platform/db`.
- Produces:
  - `type RenewalContext = { personId: string; name: string | null; email: string | null; netId: string | null; phone: string | null; currentDepartments: string[]; eligible: boolean }`
  - `async getRenewalContext(personId: string, sessionEmail: string | null): Promise<RenewalContext>`
  - `resolveRenewalPrefill(fields: { key: string; type: string }[], ctx: RenewalContext): { values: Record<string, string>; lockedKeys: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/modules/recruitment/services/renewal.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getRenewalContext, resolveRenewalPrefill } from "./renewal";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function volunteerIn(deptCode: string, termCode: string, termStart: Date, kind: "VOLUNTEER" | "DIRECTOR" = "VOLUNTEER", status: "ACTIVE" | "REMOVED" = "ACTIVE") {
  const person = await prisma.person.create({ data: { name: "Reed Renew", netId: "rr99", phone: "203-555-0100", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: termCode, name: termCode, startDate: termStart, endDate: termStart } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind, status } });
  return person;
}

it("is eligible with an active volunteer membership and returns its department", async () => {
  const person = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"));
  const ctx = await getRenewalContext(person.id, "reed@yale.edu");
  expect(ctx.eligible).toBe(true);
  expect(ctx.currentDepartments).toEqual(["SRHD"]);
  expect(ctx.email).toBe("reed@yale.edu"); // session email, verbatim
  expect(ctx.name).toBe("Reed Renew");
  expect(ctx.netId).toBe("rr99");
  expect(ctx.phone).toBe("203-555-0100");
});

it("is not eligible without an active volunteer membership", async () => {
  const person = await prisma.person.create({ data: { name: "No Member", status: "ACTIVE" } });
  const ctx = await getRenewalContext(person.id, "no@yale.edu");
  expect(ctx.eligible).toBe(false);
  expect(ctx.currentDepartments).toEqual([]);
});

it("ignores DIRECTOR and REMOVED memberships", async () => {
  const dir = await volunteerIn("EXEC", "FA25", new Date("2025-08-01"), "DIRECTOR");
  expect((await getRenewalContext(dir.id, "d@yale.edu")).eligible).toBe(false);
  const removed = await volunteerIn("SRHD", "FA25", new Date("2025-08-01"), "VOLUNTEER", "REMOVED");
  expect((await getRenewalContext(removed.id, "r@yale.edu")).eligible).toBe(false);
});

it("resolveRenewalPrefill splits name, locks email by type, maps phone/netid, skips off-convention keys", async () => {
  const ctx = { personId: "p1", name: "Mary Jane Watson", email: "mjw@yale.edu", netId: "mjw1", phone: "555", currentDepartments: ["SRHD"], eligible: true };
  const { values, lockedKeys } = resolveRenewalPrefill(
    [{ key: "first_name", type: "SHORT_TEXT" }, { key: "last_name", type: "SHORT_TEXT" }, { key: "email", type: "EMAIL" }, { key: "phone", type: "PHONE" }, { key: "netid", type: "SHORT_TEXT" }, { key: "favorite_color", type: "SHORT_TEXT" }],
    ctx,
  );
  expect(values.first_name).toBe("Mary");
  expect(values.last_name).toBe("Jane Watson");
  expect(values.email).toBe("mjw@yale.edu");
  expect(values.phone).toBe("555");
  expect(values.netid).toBe("mjw1");
  expect(values.favorite_color).toBeUndefined();
  expect(lockedKeys).toEqual(["email"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/renewal.test.ts`
Expected: FAIL (cannot find module `./renewal`).

- [ ] **Step 3: Implement `renewal.ts`**

```ts
// src/modules/recruitment/services/renewal.ts
import { prisma } from "@/platform/db";

export type RenewalContext = {
  personId: string;
  name: string | null;
  email: string | null;
  netId: string | null;
  phone: string | null;
  currentDepartments: string[];
  eligible: boolean;
};

/**
 * Eligibility + identity for a returning applicant. `email` is the verified
 * session (Entra) address, returned verbatim, never read from Person.contactEmail.
 * Departments are the codes from the person's active VOLUNTEER memberships in
 * their most-recent term (by term.startDate).
 */
export async function getRenewalContext(personId: string, sessionEmail: string | null): Promise<RenewalContext> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    include: {
      memberships: {
        where: { kind: "VOLUNTEER", status: "ACTIVE" },
        include: { term: { select: { startDate: true } }, department: { select: { code: true } } },
      },
    },
  });
  if (!person) {
    return { personId, name: null, email: sessionEmail, netId: null, phone: null, currentDepartments: [], eligible: false };
  }
  let latest = 0;
  for (const m of person.memberships) latest = Math.max(latest, m.term.startDate.getTime());
  const currentDepartments = latest
    ? Array.from(new Set(person.memberships.filter((m) => m.term.startDate.getTime() === latest).map((m) => m.department.code)))
    : [];
  return {
    personId,
    name: person.name,
    email: sessionEmail,
    netId: person.netId,
    phone: person.phone,
    currentDepartments,
    eligible: currentDepartments.length > 0,
  };
}

/**
 * Maps a renewal context onto a cycle's field keys. Uses the guaranteed identity
 * keys plus field semantics (the same conventions submissions.ts relies on).
 * Fields that match nothing are left unset (off-convention forms simply do not
 * prefill). Department is handled by the form's renewal-department control.
 */
export function resolveRenewalPrefill(
  fields: { key: string; type: string }[],
  ctx: RenewalContext,
): { values: Record<string, string>; lockedKeys: string[] } {
  const values: Record<string, string> = {};
  const lockedKeys: string[] = [];

  const name = (ctx.name ?? "").trim();
  if (name) {
    const sp = name.indexOf(" ");
    values.first_name = sp === -1 ? name : name.slice(0, sp);
    values.last_name = sp === -1 ? "" : name.slice(sp + 1).trim();
  }

  for (const f of fields) {
    if ((f.type === "EMAIL" || f.key === "email") && ctx.email) {
      values[f.key] = ctx.email;
      lockedKeys.push(f.key);
    } else if ((f.type === "PHONE" || f.key === "phone") && ctx.phone) {
      values[f.key] = ctx.phone;
    } else if (f.key === "netid" && ctx.netId) {
      values[f.key] = ctx.netId;
    }
  }
  return { values, lockedKeys };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/renewal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/renewal.ts src/modules/recruitment/services/renewal.test.ts
git commit -m "feat(recruitment): renewal eligibility + prefill service"
```

---

### Task 3: Submit verification — session gate, email override, person link

**Files:**
- Modify: `src/modules/recruitment/services/submissions.ts`
- Test: `src/modules/recruitment/services/submissions.test.ts`

**Interfaces:**
- Consumes: `getRenewalContext` from `./renewal`.
- Produces: `SubmitInput` gains `sessionPersonId?: string | null` and `sessionEmail?: string | null`. `submitApplication` enforces the renewal gate, overrides the email for renewals, and sets `applicantPersonId`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/recruitment/services/submissions.test.ts`:

```ts
async function makeVolunteer(deptCode: string) {
  const person = await prisma.person.create({ data: { name: "Reed Renew", contactEmail: "reed-old@yale.edu", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01") } });
  const dept = await prisma.department.create({ data: { code: deptCode, name: deptCode } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  return person;
}

const RENEWAL_ANSWERS = { first_name: "Reed", last_name: "Renew", email: "tampered@evil.com", continue_reason: "I want to keep volunteering." };

it("rejects a renewal submit with no session", async () => {
  await openVolunteerCycle();
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {} })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});

it("links an eligible renewal to the person and stores the verified email (not the tampered one)", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const app = await submitApplication("apply-v", {
    applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {},
    sessionPersonId: person.id, sessionEmail: "reed@yale.edu",
  });
  const applicant = await prisma.applicant.findFirstOrThrow({ where: { id: app.applicantId } });
  expect(applicant.applicantPersonId).toBe(person.id);
  expect(applicant.email).toBe("reed@yale.edu");
  expect(app.applicantType).toBe("RENEWAL");
  expect(app.departmentChoices).toEqual(["SRHD"]);
});

it("rejects a second renewal by the same person", async () => {
  await openVolunteerCycle();
  const person = await makeVolunteer("SRHD");
  const args = { applicantType: "RENEWAL" as const, renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {}, sessionPersonId: person.id, sessionEmail: "reed@yale.edu" };
  await submitApplication("apply-v", args);
  await expect(submitApplication("apply-v", args)).rejects.toBeInstanceOf(DuplicateApplicationError);
});

it("rejects a renewal when the signed-in person has no active volunteer membership", async () => {
  await openVolunteerCycle();
  const person = await prisma.person.create({ data: { name: "Lapsed", status: "ACTIVE" } });
  await expect(
    submitApplication("apply-v", { applicantType: "RENEWAL", renewalDepartment: "SRHD", answers: RENEWAL_ANSWERS, files: {}, sessionPersonId: person.id, sessionEmail: "lapsed@yale.edu" })
  ).rejects.toBeInstanceOf(SubmissionValidationError);
});
```

Also confirm the existing NEW test still implies `applicantPersonId` stays null (no change needed; the new constraint allows multiple nulls).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts -t "renewal"`
Expected: FAIL (the renewal session gate / link not implemented; the no-session test does not yet throw `SubmissionValidationError`, the link test finds `applicantPersonId === null`).

- [ ] **Step 3: Extend `SubmitInput`**

In `src/modules/recruitment/services/submissions.ts`, update the type:

```ts
export type SubmitInput = {
  applicantType: ApplicantType;
  renewalDepartment?: string;
  answers: Record<string, unknown>;
  files: Record<string, UploadedFile>;
  sessionPersonId?: string | null;
  sessionEmail?: string | null;
};
```

- [ ] **Step 4: Add the import**

At the top of `submissions.ts`, alongside the other local imports:

```ts
import { getRenewalContext } from "./renewal";
```

- [ ] **Step 5: Add the renewal session gate**

In `submitApplication`, immediately after the existing line
`if (input.applicantType === "RENEWAL" && !cycle.acceptsRenewals) throw new CycleNotOpenError("This cycle does not accept renewals.");`
insert:

```ts
  // Renewals must be signed in and a current volunteer. The server re-verifies
  // here regardless of the client UI, and links the submission to the person.
  let applicantPersonId: string | null = null;
  if (input.applicantType === "RENEWAL") {
    if (!input.sessionPersonId || !input.sessionEmail) {
      throw new SubmissionValidationError("Please sign in with Yale to apply as a returning volunteer.");
    }
    const renewalCtx = await getRenewalContext(input.sessionPersonId, input.sessionEmail);
    if (!renewalCtx.eligible) {
      throw new SubmissionValidationError("We do not see a current volunteer membership for your account.");
    }
    applicantPersonId = renewalCtx.personId;
  }
```

- [ ] **Step 6: Override the email for renewals**

Find the line `const email = String(input.answers.email ?? "").trim();` and replace it with:

```ts
  // For renewals the email is the verified session address (also the dedup key);
  // the client-submitted value is ignored so it cannot be spoofed.
  const email = (input.applicantType === "RENEWAL" ? input.sessionEmail! : String(input.answers.email ?? "")).trim();
```

- [ ] **Step 7: Set `applicantPersonId` on the created Applicant**

In the `tx.applicant.create` call inside the transaction, add `applicantPersonId` to `data`:

```ts
      const applicant = await tx.applicant.create({
        data: { cycleId: cycle.id, applicantPersonId, firstName, lastName, email, emailLower, netId: typeof input.answers.netid === "string" ? input.answers.netid : null, phone: typeof input.answers.phone === "string" ? input.answers.phone : null },
      });
```

(The existing `catch` already maps a `P2002` unique violation to `DuplicateApplicationError`, which now also covers the `(cycleId, applicantPersonId)` constraint.)

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/modules/recruitment/services/submissions.test.ts`
Expected: PASS (all existing tests plus the 4 new renewal tests).

- [ ] **Step 9: Commit**

```bash
git add src/modules/recruitment/services/submissions.ts src/modules/recruitment/services/submissions.test.ts
git commit -m "feat(recruitment): verify + link renewals at submit"
```

---

### Task 4: Shared renderer — prefill + locked props

**Files:**
- Modify: `src/modules/recruitment/components/field-preview.tsx`

**Interfaces:**
- Produces: `FieldPreview` accepts optional `prefill?: string` and `locked?: boolean`. When `locked`, text controls render `value={prefill}` + `readOnly`; otherwise `defaultValue={prefill}` when provided. The builder passes neither, so it is unaffected.

- [ ] **Step 1: Add the props and apply them to text controls**

In `field-preview.tsx`, change the component signature to add the two props, compute a `textProps` object, and spread it into the text-like controls. The full updated file:

```tsx
import { Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Checkbox } from "@/platform/ui/checkbox";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type PreviewFieldDef = {
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { value: string; label: string }[] | null;
  validation: Record<string, unknown> | null;
};

export function FieldPreview({
  f, departments, fieldError, onDeptChoice, disabled = false, prefill, locked = false,
}: {
  f: PreviewFieldDef;
  departments: string[];
  fieldError?: string;
  onDeptChoice?: (v: string) => void;
  disabled?: boolean;
  prefill?: string;
  locked?: boolean;
}) {
  const required = f.required;
  const invalid = fieldError ? true : undefined;
  const req = required ? <span className="text-critical"> *</span> : null;
  const help = f.helpText ? <span className="mt-1 block text-xs text-muted-foreground">{f.helpText}</span> : null;
  const err = fieldError ? <span className="mt-1 block text-xs text-critical">{fieldError}</span> : null;

  // Prefill: a locked field is read-only (verified value); otherwise it seeds an
  // editable default. Read-only controlled inputs do not trigger React warnings.
  const textProps = prefill === undefined ? {} : locked ? { value: prefill, readOnly: true } : { defaultValue: prefill };
  const lockedCls = prefill !== undefined && locked ? "bg-muted text-muted-foreground" : null;

  if (f.type === "CHECKBOX") {
    return (
      <div>
        <label className={cx("flex min-h-[44px] items-start gap-2.5 py-1", disabled ? "cursor-default" : "cursor-pointer")}>
          <Checkbox name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-0.5" />
          <span className="text-sm text-foreground">{f.label}{req}</span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  const labelEl = <span className="block text-sm font-medium text-foreground">{f.label}{req}</span>;
  let control: React.ReactNode;
  switch (f.type) {
    case "LONG_TEXT": control = <Textarea name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} rows={4} {...textProps} />; break;
    case "NUMBER": control = <Input type="number" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "DATE": control = <Input type="date" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "EMAIL": control = <Input type="email" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "PHONE": control = <Input type="tel" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />; break;
    case "FILE": {
      const accept = Array.isArray(f.validation?.acceptedTypes) ? (f.validation!.acceptedTypes as string[]).join(",") : undefined;
      control = <Input type="file" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} accept={accept} className="mt-1.5 cursor-pointer" />;
      break;
    }
    case "DEPARTMENT_CHOICE":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" onChange={(e) => onDeptChoice?.(e.target.value)} defaultValue=""><option value="" disabled>Select…</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>;
      break;
    case "SINGLE_SELECT":
      control = <Select name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className="mt-1.5" defaultValue=""><option value="" disabled>Select…</option>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
      break;
    case "MULTI_SELECT":
      control = (
        <span className="mt-1 flex flex-col">
          {(f.options ?? []).map((o) => (
            <label key={o.value} className={cx("flex min-h-[44px] items-center gap-2.5 py-1 text-sm text-foreground", disabled ? "cursor-default" : "cursor-pointer")}>
              <Checkbox name={f.key} value={o.value} disabled={disabled} /> {o.label}
            </label>
          ))}
        </span>
      );
      break;
    default: control = <Input type="text" name={f.key} required={required} disabled={disabled} aria-invalid={invalid} className={cx("mt-1.5", lockedCls)} {...textProps} />;
  }
  return <label className="block">{labelEl}{help}{control}{err}</label>;
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (Builder usage passes no `prefill`/`locked`, so it is unchanged.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/recruitment/components/field-preview.tsx
git commit -m "feat(recruitment): FieldPreview prefill + locked props"
```

---

### Task 5: Apply form — sign-in gate, prefill, three states

**Files:**
- Modify: `src/app/apply/[slug]/apply-form.tsx`

**Interfaces:**
- Consumes: `FieldPreview` (`prefill`/`locked`), `buttonClasses` from `@/platform/ui/button`.
- Produces: `ApplyForm` accepts new OPTIONAL props (so the not-yet-updated page still compiles): `signedIn?: boolean`, `signedInName?: string | null`, `eligible?: boolean`, `prefill?: { values: Record<string,string>; lockedKeys: string[] }`, `currentDepartments?: string[]`, `initialApplicantType?: "NEW" | "RENEWAL"`.

- [ ] **Step 1: Rewrite `apply-form.tsx`**

```tsx
"use client";
import { useMemo, useState } from "react";
import { submitPublicApplication, type SubmitResult } from "./actions";
import { isSectionVisible } from "@/modules/recruitment/engine/visibility";
import { Alert } from "@/platform/ui/alert";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { FieldPreview } from "@/modules/recruitment/components/field-preview";

function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

const APPLICANT_OPTIONS = [
  { value: "NEW" as const, label: "New applicant", desc: "First time applying to volunteer" },
  { value: "RENEWAL" as const, label: "Returning volunteer", desc: "Renewing in my current department" },
];

type FieldDef = { key: string; label: string; helpText: string | null; type: string; required: boolean; options: { value: string; label: string }[] | null; validation: Record<string, unknown> | null };
type SectionDef = { id: string; title: string; description: string | null; appliesTo: "NEW" | "RENEWAL" | "BOTH"; departmentCode: string | null; fields: FieldDef[] };
type Def = { slug: string; title: string; acceptsRenewals: boolean; departments: string[]; sections: SectionDef[] };
type Prefill = { values: Record<string, string>; lockedKeys: string[] };

export function ApplyForm({
  def, signedIn = false, signedInName = null, eligible = false, prefill, currentDepartments = [], initialApplicantType = "NEW",
}: {
  def: Def;
  signedIn?: boolean;
  signedInName?: string | null;
  eligible?: boolean;
  prefill?: Prefill;
  currentDepartments?: string[];
  initialApplicantType?: "NEW" | "RENEWAL";
}) {
  // A returning visitor whose account has no current membership is moved to the
  // New flow on arrival, with a note.
  const autoIneligible = initialApplicantType === "RENEWAL" && signedIn && !eligible;
  const [applicantType, setApplicantType] = useState<"NEW" | "RENEWAL">(autoIneligible ? "NEW" : initialApplicantType);
  const [ineligibleNote, setIneligibleNote] = useState(autoIneligible);
  const [renewalDept, setRenewalDept] = useState<string>(currentDepartments[0] ?? def.departments[0] ?? "");
  const [deptChoice, setDeptChoice] = useState<string>("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const lockedKeys = useMemo(() => new Set(prefill?.lockedKeys ?? []), [prefill]);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/apply/${def.slug}?type=renewal`)}`;
  const renewalGate = applicantType === "RENEWAL" && !signedIn;

  function chooseType(v: "NEW" | "RENEWAL") {
    if (v === "RENEWAL" && signedIn && !eligible) {
      setApplicantType("NEW");
      setIneligibleNote(true);
      return;
    }
    setIneligibleNote(false);
    setApplicantType(v);
  }

  const selectedDepartmentCodes = useMemo(
    () => applicantType === "RENEWAL" ? (renewalDept ? [renewalDept] : []) : (deptChoice ? [deptChoice] : []),
    [applicantType, renewalDept, deptChoice]
  );
  const visible = useMemo(
    () => def.sections.filter((s) => isSectionVisible({ id: s.id, appliesTo: s.appliesTo, departmentCode: s.departmentCode }, { applicantType, selectedDepartmentCodes })),
    [def.sections, applicantType, selectedDepartmentCodes]
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    fd.set("__applicantType", applicantType);
    if (applicantType === "RENEWAL") fd.set("__renewalDepartment", renewalDept);
    const res = await submitPublicApplication(def.slug, fd);
    setResult(res);
    setSubmitting(false);
  }

  if (result?.ok) {
    return <Alert tone="success" className="mt-8">Thanks, your application was received. Check your email for a confirmation.</Alert>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-8">
      {result && !result.ok && <Alert tone="error">{result.message}</Alert>}

      {def.acceptsRenewals && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">Are you a new or returning volunteer?</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {APPLICANT_OPTIONS.map((opt) => {
              const active = applicantType === opt.value;
              return (
                <label
                  key={opt.value}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                    "[&:has(:focus-visible)]:ring-2 [&:has(:focus-visible)]:ring-brand/30",
                    active ? "border-brand bg-brand-faint" : "border-border-strong hover:bg-muted",
                  )}
                >
                  <input type="radio" name="__type_ui" className="sr-only" checked={active} onChange={() => chooseType(opt.value)} />
                  <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", active ? "border-brand" : "border-border-strong")} aria-hidden>
                    {active && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span>
                    <span className={cx("block text-sm font-medium", active ? "text-brand-fg" : "text-foreground")}>{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {ineligibleNote && (
            <Alert tone="warning">We do not see a current volunteer membership for your account, so we have set you up as a new applicant. Your name and email are filled in below.</Alert>
          )}

          {applicantType === "RENEWAL" && signedIn && eligible && (
            <label className="flex flex-col gap-1.5 pt-1">
              <span className="text-sm font-medium text-foreground">Current department</span>
              <Select value={renewalDept} onChange={(e) => setRenewalDept(e.target.value)} className="sm:max-w-xs">{def.departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
            </label>
          )}
        </fieldset>
      )}

      {renewalGate ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-foreground">Returning volunteers sign in with Yale so we can verify your renewal and fill in your information.</p>
          <a href={loginHref} className={cx(buttonClasses("primary", "md"), "mt-3")}>Sign in with Yale</a>
        </div>
      ) : (
        <>
          {signedIn && applicantType === "RENEWAL" && eligible && signedInName && (
            <p className="text-sm text-muted-foreground">Signed in as {signedInName}.</p>
          )}

          {visible.map((section) => (
            <fieldset key={section.id} className="space-y-3">
              <legend className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</legend>
              {section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}
              {section.fields.map((f) => (
                <FieldPreview key={f.key} f={f} departments={def.departments}
                  fieldError={result && !result.ok ? result.fieldErrors?.[f.key] : undefined}
                  onDeptChoice={f.type === "DEPARTMENT_CHOICE" ? setDeptChoice : undefined}
                  prefill={prefill?.values[f.key]} locked={lockedKeys.has(f.key)} />
              ))}
            </fieldset>
          ))}

          <Button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}</Button>
        </>
      )}
    </form>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (The new props are optional, so the not-yet-updated `page.tsx` still compiles.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/apply/[slug]/apply-form.tsx"
git commit -m "feat(recruitment): apply form sign-in gate + prefill states"
```

---

### Task 6: Server wiring — page session + submit session

**Files:**
- Modify: `src/app/apply/[slug]/page.tsx`
- Modify: `src/app/apply/[slug]/actions.ts`

**Interfaces:**
- Consumes: `auth` from `@/platform/auth/auth`; `getRenewalContext`, `resolveRenewalPrefill` from `@/modules/recruitment/services/renewal`; the new `ApplyForm` props; the extended `SubmitInput`.

- [ ] **Step 1: Update the apply page**

Replace the body of `src/app/apply/[slug]/page.tsx` from the imports through the final `return` with:

```tsx
import { prisma } from "@/platform/db";
import { auth } from "@/platform/auth/auth";
import { getRenewalContext, resolveRenewalPrefill } from "@/modules/recruitment/services/renewal";
import { ApplyForm } from "./apply-form";

export default async function ApplyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ type?: string }> }) {
  const { slug } = await params;
  const { type } = await searchParams;
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    include: { sections: { where: { purpose: "APPLICATION" }, include: { fields: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } } },
  });

  const now = new Date();
  const open = cycle && cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);

  if (!cycle || !open) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold">Applications are closed</h1>
        <p className="mt-2 text-muted-foreground">This recruitment form is not currently accepting submissions.</p>
      </main>
    );
  }

  const def = {
    slug: cycle.publicSlug,
    title: cycle.title,
    acceptsRenewals: cycle.acceptsRenewals,
    departments: cycle.departments,
    sections: cycle.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, appliesTo: s.appliesTo, departmentCode: s.departmentCode,
      fields: s.fields.map((f) => ({ key: f.key, label: f.label, helpText: f.helpText, type: f.type, required: f.required, options: (f.options as { value: string; label: string }[] | null) ?? null, validation: (f.validation as Record<string, unknown> | null) ?? null })),
    })),
  };

  const session = await auth();
  let signedIn = false;
  let signedInName: string | null = null;
  let eligible = false;
  let currentDepartments: string[] = [];
  let prefill: { values: Record<string, string>; lockedKeys: string[] } | undefined;
  if (session?.personId) {
    signedIn = true;
    signedInName = session.user?.name ?? null;
    const ctx = await getRenewalContext(session.personId, session.user?.email ?? null);
    eligible = ctx.eligible;
    currentDepartments = ctx.currentDepartments.filter((d) => cycle.departments.includes(d));
    const fields = cycle.sections.flatMap((s) => s.fields).map((f) => ({ key: f.key, type: f.type }));
    prefill = resolveRenewalPrefill(fields, ctx);
  }
  const initialApplicantType: "NEW" | "RENEWAL" = type === "renewal" ? "RENEWAL" : "NEW";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">{def.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Complete the fields below to submit your application. Required fields are marked with{" "}
        <span className="font-medium text-critical">*</span>.
      </p>
      <ApplyForm def={def} signedIn={signedIn} signedInName={signedInName} eligible={eligible} prefill={prefill} currentDepartments={currentDepartments} initialApplicantType={initialApplicantType} />
    </main>
  );
}
```

- [ ] **Step 2: Update the submit action**

In `src/app/apply/[slug]/actions.ts`, add the `auth` import and pass the session through:

Add to the imports:
```ts
import { auth } from "@/platform/auth/auth";
```

In `submitPublicApplication`, after the `files`/`answers` loop and before the `try`, read the session, and add the two fields to the `submitApplication` call:

```ts
  const session = await auth();

  try {
    await submitApplication(slug, {
      applicantType, renewalDepartment, answers, files,
      sessionPersonId: session?.personId ?? null,
      sessionEmail: session?.user?.email ?? null,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SubmissionValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof DuplicateApplicationError) return { ok: false, message: err.message };
    if (err instanceof CycleNotOpenError) return { ok: false, message: err.message };
    throw err;
  }
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean.

Manual render check (run skill or `npm run dev`): on an OPEN cycle with `acceptsRenewals`, open `/apply/<slug>` (signed out): picking "Returning volunteer" shows the "Sign in with Yale" gate; the rest of the form is hidden. Sign in as a person with an active volunteer membership and revisit `/apply/<slug>?type=renewal`: identity is prefilled (email locked/greyed), the department defaults to your current one and is selectable, the form shows, and submitting links the `Applicant` to your `Person`. Sign in as a person with no membership and pick Returning: the not-eligible note appears and you are moved to the New flow.

- [ ] **Step 4: Commit**

```bash
git add "src/app/apply/[slug]/page.tsx" "src/app/apply/[slug]/actions.ts"
git commit -m "feat(recruitment): wire session into apply page + submit"
```

---

### Task 7: Full verification pass

**Files:** none (verification + any small fixes).

- [ ] **Step 1: Run the suite**

Run: `npm run test`
Expected: PASS, including the new `renewal` tests and the renewal additions to `submissions.test.ts`. The only acceptable failures are the pre-existing `/tmp` cert-upload flakes in `certificates.test.ts` / `my-info.test.ts` (unrelated; this branch does not touch them).

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean (lint errors confined to the pre-existing `HAVEN Free Clinic Design System/` reference folder are not introduced by this work).

- [ ] **Step 3: End-to-end manual walkthrough (run skill or `npm run dev`)**

- Signed out, OPEN renewal cycle: New flow unchanged; Returning shows the sign-in gate.
- Signed in + active volunteer membership: prefill (email locked), department defaulted + switchable, submit creates an `Applicant` with `applicantPersonId` set and the verified email; a second attempt shows the friendly already-applied error.
- Signed in + no membership, pick Returning: note + auto-switch to New, identity kept.
- Confirm a NEW submission still stores `applicantPersonId = null`.

- [ ] **Step 4: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "chore(recruitment): verification fixes for renewal autofill"
```

---

## Self-Review Notes

- **Spec coverage:** data-model link (Task 1); eligibility + prefill service (Task 2); submit session gate + email override + person link + dedup (Task 3); `FieldPreview` prefill/locked (Task 4); three-state Returning branch + sign-in gate + department default (Task 5); page `auth()` + context + props and submit session wiring (Task 6); verification (Task 7). Every spec section maps to a task.
- **Auth mechanism:** the spec mentioned `signIn(...)`; the plan uses the codebase's hardened `/login?callbackUrl=` redirect instead (same intent, reuses the open-redirect-safe login page). This is an intentional refinement.
- **Type consistency:** `RenewalContext`, `getRenewalContext(personId, sessionEmail)`, and `resolveRenewalPrefill(fields, ctx) -> { values, lockedKeys }` are defined in Task 2 and consumed unchanged in Tasks 3 and 6; `SubmitInput`'s `sessionPersonId`/`sessionEmail` (Task 3) are supplied in Task 6; `FieldPreview`'s `prefill`/`locked` (Task 4) are passed in Task 5; `ApplyForm`'s new optional props (Task 5) are passed in Task 6.
- **Task independence / green builds:** Task 3's new `SubmitInput` fields are optional, so `actions.ts` keeps compiling until Task 6. Task 5's new `ApplyForm` props are optional, so `page.tsx` keeps compiling until Task 6. Task 6 closes the loop and is the first full `build` gate.
- **Risk to confirm during execution:** the exact `TermMembership` "active" predicate (`status === "ACTIVE"`, kind `VOLUNTEER`) and the `term`/`department` relation names are taken from `prisma/schema.prisma` (confirmed: `status MembershipStatus @default(ACTIVE)`, `kind MembershipKind`, relations `term` and `department`). If a future schema rename occurs, update `renewal.ts`'s `include`/`where`.
