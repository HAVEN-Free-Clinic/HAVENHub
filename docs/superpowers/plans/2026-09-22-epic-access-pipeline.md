# Epic Access Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an Epic request record whether it was actually sent, give a returned YNHH batch a page where it can be reconciled and the members told in bulk, and add the first scheduled job that chases any of it.

**Architecture:** Two pure modules carry the risky logic (`epic-batch-stage.ts` derives a batch's stage from facts rather than a stored status; `epic-return-match.ts` matches returned spreadsheet rows to requests with no database access). A service module wraps them with the database writes, a new page at `/support/epic/batch/[ticketId]` is the surface, and a cron digest reports what is stuck. Additive schema only.

**Tech Stack:** Next.js App Router (server components + server actions), Prisma/Postgres, vitest, exceljs, Tailwind, the existing `@/platform/clearance` and `@/platform/notifications` facades.

**Spec:** `docs/superpowers/specs/2026-09-22-epic-access-pipeline-design.md`

## Global Constraints

- **No em-dashes anywhere.** CI enforces `local/no-em-dash` and a violation fails lint. Use `--` in prose.
- **Lint command is `npx eslint src e2e`.** A bare `eslint` walks the gitignored design-system directory and reports noise.
- **Run the full lint before pushing.** Typecheck and tests both miss the eslint boundary rules (`src/platform` may not import `src/modules`).
- **Run `npx vitest run src/platform` before any push.** Platform guard tests fire regardless of what you touched.
- **Test database:** Postgres on port 5434. Export `TEST_DATABASE_URL` for the worktree before running DB tests, and pass it through to `git push` if the pre-push hook runs.
- **Prisma migrations:** `prisma migrate dev` folds any pre-existing drift into the new migration. Open the generated SQL and trim it to only the intended changes before committing. Once pushed, the migration file is immutable: a correction ships as a new migration, because rewriting one on an open PR breaks the Neon preview database with `P3018 / 42P07`.
- **`Person.name` is derived.** Never split it to get parts. Legal name fields (`legalFirstName`, `legalMiddleName`, `lastName`) are what goes to YNHH.
- **Phase 1 (Tasks 1-7) is independently mergeable.** Stop and ship there if you want value before the batch page exists.

---

# Phase 1: The honest request

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma:748-763` (enum), `prisma/schema.prisma:913-941` (EpicRequest), `prisma/schema.prisma:943-965` (YnhhTicket)
- Create: `prisma/migrations/<timestamp>_epic_pipeline_honesty/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `EpicRequestStatus.REJECTED`; `EpicRequest.accessStartDate`, `.accessEndDate`, `.outcomeNote`, `.memberEmailedAt`, `.memberEmailTemplate`; `YnhhTicket.sentAt`, `.sentById`, `.sentBy`.

- [ ] **Step 1: Add `REJECTED` to the status enum**

In `prisma/schema.prisma`, replace the `EpicRequestStatus` enum:

```prisma
enum EpicRequestStatus {
  PENDING
  SUBMITTED
  COMPLETED
  /// YNHH declined this request. Distinct from CANCELLED, which means WE
  /// withdrew it: conflating them loses whether a re-raise is warranted.
  REJECTED
  CANCELLED
}
```

- [ ] **Step 2: Add the `EpicRequest` columns**

Insert after the `completedAt` line in `model EpicRequest`:

```prisma
  /// What we asked YNHH for. Printed on the PDF, the spreadsheet and the cover
  /// email, and until now persisted nowhere -- so the system could not answer
  /// "whose Epic access expires this month" and inferred renewals from roster
  /// diffs instead.
  accessStartDate     DateTime?
  accessEndDate       DateTime?
  /// Why YNHH refused, or any note recorded at resolution. Paired with REJECTED.
  outcomeNote         String?
  /// When the member was told their account is ready, and with which template.
  /// Null on a COMPLETED request is a real defect the Epic cron reports: the
  /// account exists and nobody told them.
  memberEmailedAt     DateTime?
  memberEmailTemplate String?
```

- [ ] **Step 3: Add the `YnhhTicket` columns and relation**

Insert after the `closedAt` line in `model YnhhTicket`:

```prisma
  /// When an admin confirmed they sent this batch to YNHH. Null means the
  /// artifacts were generated but the email may never have left: the send is a
  /// manual copy-paste, so this is the only signal separating a batch YNHH is
  /// working from one that was generated and forgotten.
  sentAt               DateTime?
  sentById             String?
  /// Person who confirmed the send. Restrict: matches submittedBy.
  sentBy               Person?                 @relation("ynhhTicketSentBy", fields: [sentById], references: [id], onDelete: Restrict)
```

- [ ] **Step 4: Add the back-relation on `Person`**

Find the `Person` model's existing `ynhhTicketSubmittedBy` back-relation and add beside it:

```prisma
  ynhhTicketsSent      YnhhTicket[]            @relation("ynhhTicketSentBy")
```

- [ ] **Step 5: Generate the migration**

Run: `npx prisma migrate dev --name epic_pipeline_honesty --create-only`

- [ ] **Step 6: Trim the generated SQL**

Open `prisma/migrations/<timestamp>_epic_pipeline_honesty/migration.sql`. It must contain **only** an `ALTER TYPE ... ADD VALUE 'REJECTED'`, the `ALTER TABLE "EpicRequest" ADD COLUMN` lines, the `ALTER TABLE "YnhhTicket" ADD COLUMN` lines, and the foreign key for `sentById`. Delete anything else: `migrate dev` folds unrelated drift in and shipping it silently applies someone else's half-finished change.

Expected shape:

```sql
ALTER TYPE "EpicRequestStatus" ADD VALUE 'REJECTED';

ALTER TABLE "EpicRequest" ADD COLUMN "accessStartDate" TIMESTAMP(3),
                          ADD COLUMN "accessEndDate" TIMESTAMP(3),
                          ADD COLUMN "outcomeNote" TEXT,
                          ADD COLUMN "memberEmailedAt" TIMESTAMP(3),
                          ADD COLUMN "memberEmailTemplate" TEXT;

ALTER TABLE "YnhhTicket" ADD COLUMN "sentAt" TIMESTAMP(3),
                         ADD COLUMN "sentById" TEXT;

ALTER TABLE "YnhhTicket" ADD CONSTRAINT "YnhhTicket_sentById_fkey"
  FOREIGN KEY ("sentById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 7: Apply and regenerate**

Run: `npx prisma migrate dev && npx prisma generate`
Expected: migration applies, client regenerates with no error.

- [ ] **Step 8: Verify the enum value is usable**

Run: `npx tsc --noEmit`
Expected: PASS. (If `REJECTED` is unknown, the client did not regenerate.)

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(epic): persist access dates, send confirmation, and a REJECTED outcome"
```

---

## Task 2: Teach the three `REJECTED` call sites

Adding an enum value is inert until the code that reasons about "resolved" knows about it. Missing any one of these is the likely bug: a batch containing a refusal becomes uncloseable, or a linked support ticket hangs in `AWAITING_YNHH` forever.

**Files:**
- Modify: `src/modules/support/services/itcm.ts` (`closeTicket`, ~line 428)
- Modify: `src/modules/support/services/epic-ticket-sync.ts` (`onEpicResolved`, ~line 182)
- Modify: `src/modules/support/services/epic.ts` (add `rejectRequest`)
- Test: `src/modules/support/services/epic.test.ts`, `src/modules/support/services/itcm.test.ts`

**Interfaces:**
- Consumes: `EpicRequestStatus.REJECTED` from Task 1.
- Produces: `rejectRequest(actorPersonId: string, requestId: string, outcomeNote: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/support/services/epic.test.ts`:

```ts
describe("rejectRequest", () => {
  it("records YNHH's refusal with its reason and leaves epicId untouched", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera");
    const req = await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "SUBMITTED", requestedById: actor.id },
    });

    await rejectRequest(actor.id, req.id, "Name does not match YNHH records");

    const after = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("REJECTED");
    expect(after.outcomeNote).toBe("Name does not match YNHH records");
    const person = await prisma.person.findUniqueOrThrow({ where: { id: sam.id } });
    expect(person.epicId).toBeNull();
  });

  it("refuses a request that is already resolved", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera");
    const req = await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "CANCELLED", requestedById: actor.id },
    });

    await expect(rejectRequest(actor.id, req.id, "too late")).rejects.toThrow(EpicStateError);
  });

  it("requires a reason", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera");
    const req = await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "SUBMITTED", requestedById: actor.id },
    });

    await expect(rejectRequest(actor.id, req.id, "   ")).rejects.toThrow(EpicStateError);
  });
});
```

Append to `src/modules/support/services/itcm.test.ts` inside the existing `closeTicket` describe block:

```ts
it("closes a ticket whose only unresolved request was rejected by YNHH", async () => {
  const actor = await createPerson("Admin");
  await grantPermission(actor.id, "support.manage_requests");
  const sam = await createPerson("Sam Rivera");
  const ticket = await prisma.ynhhTicket.create({
    data: { submittedById: actor.id, description: "NEW - Sam Rivera" },
  });
  await prisma.epicRequest.create({
    data: {
      personId: sam.id, kind: "NEW", status: "REJECTED",
      requestedById: actor.id, ticketId: ticket.id,
      outcomeNote: "Already has an account",
    },
  });

  await closeTicket(actor.id, ticket.id);

  const after = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  expect(after.status).toBe("CLOSED");
});
```

Add `rejectRequest` to the import list at the top of `epic.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/support/services/epic.test.ts -t rejectRequest`
Expected: FAIL with `rejectRequest is not a function`.

- [ ] **Step 3: Implement `rejectRequest`**

Add to `src/modules/support/services/epic.ts`, directly after `completeRequest`:

```ts
/**
 * Records that YNHH declined a request, with their reason.
 *
 * Distinct from cancelEpicRequest, and the distinction is the point: CANCELLED
 * means we withdrew the request, REJECTED means YNHH said no. Before this the
 * only way to record a refusal was to cancel, which discarded the reason and
 * made YNHH's decision read as our own withdrawal -- so a person's history
 * could not tell you whether re-raising was warranted.
 *
 * Never touches Person.epicId. Claimed atomically, the same shape as
 * completeRequest, so a concurrent cancel cannot be silently reverted.
 * Audits "epic.reject".
 */
export async function rejectRequest(
  actorPersonId: string,
  requestId: string,
  outcomeNote: string
): Promise<void> {
  await requireManageEpic(actorPersonId);

  const reason = outcomeNote.trim();
  if (!reason) {
    throw new EpicStateError("A rejection needs a reason: it is the only record of why YNHH declined.");
  }

  const req = await prisma.epicRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new EpicNotFoundError(`EpicRequest not found: ${requestId}`);
  if (req.status !== "PENDING" && req.status !== "SUBMITTED") {
    throw new EpicStateError(
      `Cannot reject a request with status ${req.status}. Must be PENDING or SUBMITTED.`
    );
  }

  const claimed = await prisma.epicRequest.updateMany({
    where: { id: requestId, status: { in: ["PENDING", "SUBMITTED"] } },
    data: { status: "REJECTED", outcomeNote: reason, completedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new EpicStateError("This request was resolved by someone else. Reload and try again.");
  }

  await recordAudit({
    actorPersonId,
    action: "epic.reject",
    entityType: "EpicRequest",
    entityId: requestId,
    after: { status: "REJECTED", outcomeNote: reason },
  });

  await onEpicResolved(actorPersonId, requestId, "REJECTED");
}
```

- [ ] **Step 4: Widen `onEpicResolved` to accept REJECTED**

In `src/modules/support/services/epic-ticket-sync.ts`, change the signature at ~line 182:

```ts
export async function onEpicResolved(
  actorPersonId: string,
  epicRequestId: string,
  outcome: "COMPLETED" | "CANCELLED" | "REJECTED"
): Promise<void> {
```

Its `stillOutstanding` count already queries `status: "SUBMITTED"`, so a REJECTED sibling correctly reads as settled. No other change is needed there.

Update the module doc comment at the top of the function to name the third caller:

```
 * CANCELLED or REJECTED (epic.ts's completeRequest, cancelEpicRequest and
 * rejectRequest call this once their own atomic claim has succeeded).
```

- [ ] **Step 5: Confirm `closeTicket` needs no change**

Read `src/modules/support/services/itcm.ts:435-437`. The guard counts `status: { in: ["PENDING", "SUBMITTED"] }`, so REJECTED already reads as resolved. Do not widen it. Extend the comment above it instead:

```ts
  // Refuse to close while any request on the ticket is still open. A CLOSED
  // ticket vanishes from the Tracker (OPEN-only) and the Pending tab
  // (ticketId: null only), and the History tab renders its requests read-only,
  // so a still-PENDING/SUBMITTED request would be stranded with no surface that
  // can complete or cancel it, permanently blocking Epic provisioning for that
  // person. Resolve the requests first. COMPLETED, CANCELLED and REJECTED all
  // count as resolved: a batch YNHH partly refused must still be closeable.
```

- [ ] **Step 6: Stop a REJECTED request blocking a re-raise**

In `src/modules/support/services/epic.ts`, find the open-request guard inside `createEpicRequest` (~line 151) and confirm it scopes to `status: { in: ["PENDING", "SUBMITTED"] }`. If it uses `notIn: ["COMPLETED", "CANCELLED"]`, change it to the positive form so REJECTED does not block:

```ts
    const openReq = await prisma.epicRequest.findFirst({
      where: { personId: input.personId, status: { in: ["PENDING", "SUBMITTED"] } },
    });
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/modules/support/services/epic.test.ts src/modules/support/services/itcm.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/support/services/epic.ts src/modules/support/services/epic-ticket-sync.ts src/modules/support/services/itcm.ts src/modules/support/services/epic.test.ts src/modules/support/services/itcm.test.ts
git commit -m "feat(epic): record a YNHH refusal as its own outcome, with the reason"
```

---

## Task 3: Make the start date real, and persist both access dates

The start date is collected into React state, rendered, and never sent. It is absent from the `runEpicGeneration` payload, absent from the route's destructure, and absent from the PDF. Meanwhile the PDF's "New Hire start date" field is hardcoded to today and the end date reaches three documents and is stored nowhere.

**Files:**
- Modify: `src/modules/support/components/epic-generate-client.ts:48-70`
- Modify: `src/app/api/support/epic/generate/route.ts` (body type ~line 210, `generateSpreadsheet` ~line 124, `generatePdf` call ~line 330)
- Modify: `src/modules/support/services/itcm-pdf.ts:325`
- Modify: `src/modules/support/services/itcm.ts` (`submitEpicRequests`, `reconcileDeactivationRequests`)
- Modify: `src/modules/support/components/epic-request-form.tsx:142`, `src/modules/support/components/term-batch-tab.tsx`
- Test: `src/modules/support/services/itcm-pdf.test.ts`

**Interfaces:**
- Consumes: `EpicRequest.accessStartDate` / `.accessEndDate` from Task 1.
- Produces: `runEpicGeneration` gains a required `startDate: string` (ISO `YYYY-MM-DD`); `generatePdf` gains `startDate: string` (MM/DD/YYYY); `submitEpicRequests` gains an `accessDates` argument.

- [ ] **Step 1: Write the failing PDF test**

Append to `src/modules/support/services/itcm-pdf.test.ts`:

```ts
it("writes the admin's start date into the New Hire start date field", async () => {
  const bytes = await generatePdf({
    requestType: "new_individual",
    authorizer: AUTHORIZER_FIXTURE,
    person: PERSON_FIXTURE,
    startDate: "09/01/2026",
    endDate: "12/20/2026",
    mirrorPerson: null,
    templateBytes: await loadTemplate(),
  });

  const fields = await readTextFields(bytes);
  expect(fields.Text75).toBe("09/01/2026");
});

it("falls back to today when no start date is given", async () => {
  const bytes = await generatePdf({
    requestType: "new_individual",
    authorizer: AUTHORIZER_FIXTURE,
    person: PERSON_FIXTURE,
    startDate: "",
    endDate: "12/20/2026",
    mirrorPerson: null,
    templateBytes: await loadTemplate(),
  });

  const fields = await readTextFields(bytes);
  expect(fields.Text75).not.toBe("");
});
```

Reuse whatever fixture and `readTextFields` helper the file already defines. If it has none, add:

```ts
async function readTextFields(bytes: Uint8Array): Promise<Record<string, string>> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const out: Record<string, string> = {};
  for (const f of doc.getForm().fields) {
    const name = f.getName();
    try {
      out[name] = doc.getForm().getTextField(name).getText() ?? "";
    } catch {
      // Not a text field (checkbox); skip.
    }
  }
  return out;
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/itcm-pdf.test.ts -t "New Hire start date"`
Expected: FAIL, because `generatePdf` has no `startDate` parameter.

- [ ] **Step 3: Thread `startDate` into the PDF**

In `src/modules/support/services/itcm-pdf.ts`, add `startDate: string` to the `generatePdf` argument type, then replace line 325:

```ts
  if (isNew) {
    checkBox(form, "Check Box49");
    // The admin's chosen access start date. Falls back to today so a blank
    // field never reaches YNHH as an empty New Hire start date. There is no
    // end-date field on the PDF for New; the cover email carries it.
    fillText(form, "Text75", startDate || today);
  } else if (isDeactivate) {
```

- [ ] **Step 4: Thread it through the client helper**

In `src/modules/support/components/epic-generate-client.ts`, add to the `runEpicGeneration` input type and body:

```ts
export async function runEpicGeneration(input: {
  requestType: EpicRequestType;
  authorizer: { id: string; initials: string };
  personIds: string[];
  /** ISO YYYY-MM-DD, straight off a date input. Empty string when not applicable. */
  startDate: string;
  /** ISO YYYY-MM-DD, straight off a date input. */
  endDate: string;
  termId?: string;
}): Promise<EpicGenerationResult> {
  // The server and PDF expect MM/DD/YYYY. Convert by slicing rather than via Date
  // so the calendar day the admin picked survives regardless of timezone.
  const toUs = (iso: string) =>
    iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "";
  const startDateFormatted = toUs(input.startDate);
  const endDateFormatted = toUs(input.endDate);

  const res = await fetch("/api/support/epic/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestType: input.requestType,
      authorizerId: input.authorizer.id,
      personIds: input.personIds,
      startDate: startDateFormatted,
      endDate: endDateFormatted,
      termId: input.termId,
    }),
  });
```

Leave the rest of the function unchanged.

- [ ] **Step 5: Accept and validate it in the route**

In `src/app/api/support/epic/generate/route.ts`, add `startDate: string;` to the body type and to the destructure, then add a range guard beside the existing `endDate` guard:

```ts
  // Every request type requires an access/effective date from the admin so a
  // blank date never reaches YNHH.
  if (!endDate?.trim()) {
    return NextResponse.json(
      { error: "An end date is required for this request" },
      { status: 400 }
    );
  }

  // An inverted range would print a start after its own end on the PDF and the
  // spreadsheet. Compared as MM/DD/YYYY reordered to sortable YYYYMMDD rather
  // than via Date, so no timezone can shift the calendar day the admin picked.
  const sortable = (us: string) => `${us.slice(6, 10)}${us.slice(0, 2)}${us.slice(3, 5)}`;
  if (startDate?.trim() && sortable(startDate) > sortable(endDate)) {
    return NextResponse.json(
      { error: "The access start date is after the end date." },
      { status: 400 }
    );
  }
```

- [ ] **Step 6: Pass it to the PDF and the spreadsheet**

In the same file, add `startDate` to the `generatePdf` call:

```ts
  const pdfBytes = await generatePdf({
    requestType,
    authorizer,
    person: personArg,
    startDate: startDate ?? "",
    endDate: effectiveEndDate,
    mirrorPerson: isBulk ? null : singleMirrorPerson,
    templateBytes,
  });
```

Then give `generateSpreadsheet` a `startDate` argument and use it for the Start Date column. Change its signature to take `startDate: string`, and replace the `today` usage in the data row and the width calculation:

```ts
  const { requestType, people, startDate, endDate } = args;
  const zone = await getDisplayTimeZone();
  const today = formatDateOnly(new Date(), zone, { month: "2-digit", day: "2-digit", year: "numeric" });
  // The admin's chosen start date; today only when they left it blank.
  const startCell = startDate || today;
```

and in both the `ws.addRow([...])` call and the `vals` array inside the width loop, replace the `today` element in the "Start Date" position with `startCell`. Update the call site to pass `startDate: startDate ?? ""`.

- [ ] **Step 7: Persist both dates on the request**

In `src/modules/support/services/itcm.ts`, give `submitEpicRequests` an extra parameter and write the dates on both the adopt and the create paths:

```ts
export async function submitEpicRequests(
  actorPersonId: string,
  kind: "NEW" | "MODIFY" | "RENEW",
  ticketDescription: string,
  people: Array<{ personId: string; mirrorEpicId: string | null }>,
  accessDates: { start: Date | null; end: Date | null } = { start: null, end: null },
)
```

Add `accessStartDate: accessDates.start, accessEndDate: accessDates.end` to the `data` of every `create` and to the `data` of the adopting `updateMany` inside that function. Do the same in `reconcileDeactivationRequests` for `accessEndDate` only (a deactivation has no start).

In the route, parse the MM/DD/YYYY strings back to dates without a timezone shift and pass them:

```ts
  // MM/DD/YYYY to a UTC midnight Date. Built from parts rather than parsed, so
  // the stored day is the day the admin picked in every server timezone.
  const toDate = (us: string): Date | null =>
    us ? new Date(`${us.slice(6, 10)}-${us.slice(0, 2)}-${us.slice(3, 5)}T00:00:00.000Z`) : null;

  const accessDates = { start: toDate(startDate ?? ""), end: toDate(effectiveEndDate) };
```

- [ ] **Step 8: Send it from both tabs**

In `src/modules/support/components/epic-request-form.tsx:142`, add `startDate` to the `runEpicGeneration` call:

```ts
      const result = await runEpicGeneration({
        requestType,
        authorizer: selectedAuthorizer,
        personIds: [...selectedPeopleIds],
        startDate,
        endDate,
      });
```

In `src/modules/support/components/term-batch-tab.tsx`, add a start-date state seeded from `rollup.term.startDateIso` beside the existing `endDate` state, render it as its own `Field`, and pass `startDate` in that tab's `runEpicGeneration` call. Add `startDateIso: isoDay(term.startDate)` to the term object built in `src/modules/support/services/epic-rollup.ts:295`.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/modules/support/services/itcm-pdf.test.ts src/modules/support/services/itcm.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/modules/support src/app/api/support/epic/generate/route.ts
git commit -m "feat(epic): send the access start date to YNHH and keep both dates on the request"
```

---

## Task 4: Mark a batch as sent

**Files:**
- Modify: `src/modules/support/services/itcm.ts` (add `markBatchSent`)
- Modify: `src/app/(app)/support/epic/page.tsx` (add the server action)
- Modify: `src/modules/support/components/epic-request-form.tsx` (result panel), `src/modules/support/components/term-batch-tab.tsx` (result panel)
- Test: `src/modules/support/services/itcm.test.ts`

**Interfaces:**
- Consumes: `YnhhTicket.sentAt` / `.sentById` from Task 1.
- Produces: `markBatchSent(actorPersonId: string, ticketId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/support/services/itcm.test.ts`:

```ts
describe("markBatchSent", () => {
  it("stamps who confirmed the send and when", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const ticket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, description: "NEW - Sam Rivera" },
    });

    await markBatchSent(actor.id, ticket.id);

    const after = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.sentAt).toBeInstanceOf(Date);
    expect(after.sentById).toBe(actor.id);
  });

  it("is idempotent: a second confirmation keeps the first timestamp", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const ticket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, description: "NEW - Sam Rivera" },
    });

    await markBatchSent(actor.id, ticket.id);
    const first = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    await markBatchSent(actor.id, ticket.id);
    const second = await prisma.ynhhTicket.findUniqueOrThrow({ where: { id: ticket.id } });

    expect(second.sentAt?.getTime()).toBe(first.sentAt?.getTime());
  });

  it("refuses without the permission", async () => {
    const actor = await createPerson("Nobody");
    const ticket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, description: "x" },
    });
    await expect(markBatchSent(actor.id, ticket.id)).rejects.toThrow(SupportForbiddenError);
  });
});
```

Add `markBatchSent` to the import list at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/itcm.test.ts -t markBatchSent`
Expected: FAIL with `markBatchSent is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/modules/support/services/itcm.ts`, next to `closeTicket`:

```ts
/**
 * Records that an admin sent this batch to YNHH.
 *
 * The send is a manual copy-paste: the app generates a PDF and a spreadsheet,
 * the admin attaches them in their own mail client. So EpicRequest.status
 * flipping to SUBMITTED at generation time says nothing about whether YNHH ever
 * heard of the batch. This is the only fact that does, which is why the
 * days-open counter and the Epic cron both read it rather than submittedAt.
 *
 * Idempotent: a repeat confirmation keeps the original timestamp, because the
 * first one is the honest answer to "when did this go out". Audits
 * "epic.batch_sent".
 */
export async function markBatchSent(actorPersonId: string, ticketId: string): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError("You do not have permission to manage Epic requests.");
  }

  const ticket = await prisma.ynhhTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new SupportNotFoundError(`YnhhTicket not found: ${ticketId}`);
  if (ticket.sentAt) return;

  await prisma.ynhhTicket.updateMany({
    where: { id: ticketId, sentAt: null },
    data: { sentAt: new Date(), sentById: actorPersonId },
  });

  await recordAudit({
    actorPersonId,
    action: "epic.batch_sent",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { sentAt: new Date().toISOString() },
  });
}
```

- [ ] **Step 4: Count days open from `sentAt`**

In `src/modules/support/components/epic-request-tabs.tsx`, the Tracker row computes business days from `ticket.submittedAt`. Change it to prefer `sentAt`, and say so when it cannot:

```tsx
{ticket.sentAt ? (
  <span className={`ml-2 font-medium ${days > 5 ? "text-critical-foreground" : "text-warning-foreground"}`}>
    · {days} business day{days !== 1 ? "s" : ""} since sent
  </span>
) : (
  <Badge tone="warning">Not yet marked sent to YNHH</Badge>
)}
```

Compute `days` from `ticket.sentAt` when present. Add `sentAt` to whatever select feeds the Tracker rows in `getEpicRequestHistory` and the open-ticket loader.

- [ ] **Step 5: Add the server action**

In `src/app/(app)/support/epic/page.tsx`, beside the existing `closeTicketAction`:

```ts
  async function markBatchSentAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("support.manage_requests");
    await markBatchSent(actor.personId, String(formData.get("ticketId")));
    revalidatePath("/support/epic");
  }
```

Pass it down through `EpicRequestTabs` the same way `closeTicketAction` is passed.

- [ ] **Step 6: Put the confirmation in the generate result panel**

In `epic-request-form.tsx`'s result panel (the block rendering the email draft, ~line 454), add below the `CopyButton`:

```tsx
{generatedTicketId ? (
  <form action={markBatchSentAction} className="mt-4">
    <input type="hidden" name="ticketId" value={generatedTicketId} />
    <Alert tone="warning">
      Downloading the files does not send them. Attach the PDF
      {isBulk ? " and spreadsheet" : ""} to an email to helpdesk@ynhh.org, then
      confirm below so this batch starts its clock.
    </Alert>
    <Button type="submit" className="mt-2">I have sent this to YNHH</Button>
  </form>
) : null}
```

This requires the generate route to return the created ticket id. Add `ynhhTicketId` to the route's JSON response (it already creates the ticket) and carry it through `EpicGenerationResult` in `epic-generate-client.ts` as `ynhhTicketId: string | null`, then store it in form state as `generatedTicketId`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/modules/support/services/itcm.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/support src/app/\(app\)/support/epic/page.tsx src/app/api/support/epic/generate/route.ts
git commit -m "feat(epic): record when a batch was actually sent to YNHH"
```

---

## Task 5: Fix the date fields on the generate form

Three review findings, one file. The end date doubles as the effective deactivation date, so prefilling it with the term end dates a mid-term offboarding months out and kills the guard that forced a deliberate choice. Two inputs share one `Field` label, leaving the required input with no accessible name. And nothing bounds the range.

**Files:**
- Modify: `src/modules/support/components/epic-request-form.tsx:16-18, 40-58, 123-147, 219-245`

**Interfaces:**
- Consumes: `runEpicGeneration`'s `startDate` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Never prefill the date for a deactivation**

Replace the state block at lines 52-58:

```tsx
export function EpicRequestForm({ departments, pendingDeactivations, authorizers, termStart, termEnd }: Props) {
  // Step 1: configuration. The authorizer is identified by person id; default
  // to the first ITCM director (empty string when there are none).
  const [authorizerId, setAuthorizerId] = useState<string>(authorizers[0]?.id ?? "");
  const [requestType, setRequestType] = useState<RequestType>("new_individual");
  const [startDate, setStartDate] = useState(termStart ?? "");
  const [endDate, setEndDate] = useState(termEnd ?? "");
  // Whether the admin has touched the end date. useState seeds once at mount,
  // so switching to a deactivate type later cannot re-seed it; this is what
  // lets the displayed value depend on the request type without losing an edit.
  const [endDateEdited, setEndDateEdited] = useState(false);
```

Then, after `isDeactivate` is computed at line 80, derive the displayed value:

```tsx
  // On a deactivation this field is the EFFECTIVE DEACTIVATION DATE, not an
  // access end date, so it is never prefilled with the term end: that would
  // date a mid-term offboarding months out AND make the "set a date" guard
  // unreachable, removing the forcing function entirely.
  const endDateValue = isDeactivate && !endDateEdited ? "" : endDate;
  const endDateLabel = isDeactivate ? "Effective deactivation date" : "Access end date";
```

- [ ] **Step 2: Validate the range before generating**

Replace the guard at lines 132-135:

```tsx
    if (!endDateValue) {
      setError(
        isDeactivate
          ? "Set the effective deactivation date before generating this request."
          : "Set the access end date before generating this request."
      );
      return;
    }
    if (!isDeactivate && startDate && startDate > endDateValue) {
      setError("The access start date is after the end date.");
      return;
    }
```

ISO `YYYY-MM-DD` strings compare correctly with `>`, which is why the inputs hold ISO and not a display format.

Then use `endDateValue` in the `runEpicGeneration` call instead of `endDate`, and pass `startDate: isDeactivate ? "" : startDate`.

- [ ] **Step 3: Split the one Field into two**

Replace the whole `<Field label="Access date range">` block (lines 224-240) with:

```tsx
          {!isDeactivate ? (
            <Field label="Access start date">
              <Input
                type="date"
                max={endDateValue || undefined}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
          ) : null}

          <Field label={endDateLabel}>
            <Input
              type="date"
              required
              min={!isDeactivate && startDate ? startDate : undefined}
              value={endDateValue}
              onChange={(e) => {
                setEndDateEdited(true);
                setEndDate(e.target.value);
              }}
            />
          </Field>
```

Two separate `Field`s, because `Field` wraps a single control and binds its label to the first labelable descendant: two inputs inside one leaves the required one with no accessible name and sends any aria plumbing to a wrapping div. This also removes the `placeholder` props, which never render on `<input type="date">` in any browser, and puts each input in its own grid cell so the `sm:grid-cols-3` row stops overflowing.

- [ ] **Step 4: Fix the module and prop docs**

At line 16, replace the stale sentence:

```
 * The access start and end dates are configurable via date inputs. On a
 * deactivation the second field is the effective deactivation date and is
 * never prefilled: it must be a deliberate choice.
```

In the `Props` block, restore the comment #941 deleted and document the two new props:

```tsx
type Props = {
  departments: DepartmentWithMembers[];
  pendingDeactivations: PendingDeactivation[];
  /** Current term's ITCM directors, the people who can authorize a request. */
  authorizers: EpicAuthorizer[];
  /** Live term start as ISO YYYY-MM-DD, prefilling the access start date. */
  termStart: string | null;
  /** Live term end as ISO YYYY-MM-DD. Never used to prefill a deactivation. */
  termEnd: string | null;
};
```

- [ ] **Step 5: Use the platform's ISO helper**

In `src/app/(app)/support/epic/page.tsx:372`, replace the hand-rolled conversion:

```tsx
        liveTermStart={liveTerm ? isoDateKey(liveTerm.startDate) : null}
        liveTermEnd={liveTerm ? isoDateKey(liveTerm.endDate) : null}
```

Import it: `import { isoDateKey } from "@/platform/dates";`

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint src e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/support/components/epic-request-form.tsx src/app/\(app\)/support/epic/page.tsx
git commit -m "fix(epic): never prefill a deactivation date, and give each date input its own label"
```

---

## Task 6: Fix the person picker's term scope

#941 widened the picker to the *previous* term. The people actually missing are the incoming class, whose memberships sit on the *next* (PLANNING) term. The dedup also has no term key in its ordering, so a member promoted this term can be listed under last term's role, which then drives a director's request to mirror volunteer-level Epic access.

**Files:**
- Modify: `src/modules/support/services/itcm.ts:41-54` (`MemberLite`), `:151-215` (`listDepartmentsWithMembers`)
- Modify: `src/modules/support/components/epic-request-form.tsx` (member row), `src/modules/support/components/epic-person-picker.tsx` (member row)
- Test: `src/modules/support/services/itcm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MemberLite` gains `termCode: string | null` (null means the live term).

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/support/services/itcm.test.ts`:

```ts
describe("listDepartmentsWithMembers term scope", () => {
  it("includes next-term members and badges them with their term code", async () => {
    const { live, next, dept } = await threeTermFixture();
    const sam = await createPerson("Sam Rivera");
    await prisma.termMembership.create({
      data: { personId: sam.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const depts = await listDepartmentsWithMembers();
    const row = depts[0].volunteers.find((v) => v.id === sam.id);
    expect(row?.termCode).toBe(next.code);
  });

  it("prefers the live term's role when a person holds two memberships", async () => {
    const { live, prev, dept } = await threeTermFixture();
    const sam = await createPerson("Sam Rivera");
    await prisma.termMembership.create({
      data: { personId: sam.id, termId: prev.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: sam.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
    });

    const depts = await listDepartmentsWithMembers();
    expect(depts[0].directors.map((d) => d.id)).toContain(sam.id);
    expect(depts[0].volunteers.map((v) => v.id)).not.toContain(sam.id);
    expect(depts[0].directors.find((d) => d.id === sam.id)?.termCode).toBeNull();
  });

  it("lists a department-switcher once, under the department they are in now", async () => {
    const { live, prev } = await threeTermFixture();
    const pcar = await prisma.department.create({ data: { code: "PCAR", name: "Patient Care" } });
    const vadm = await prisma.department.create({ data: { code: "VADM", name: "Volunteer Admin" } });
    const sam = await createPerson("Sam Rivera");
    await prisma.termMembership.create({
      data: { personId: sam.id, termId: prev.id, departmentId: pcar.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: sam.id, termId: live.id, departmentId: vadm.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    const depts = await listDepartmentsWithMembers();
    const appearances = depts.flatMap((d) => [...d.directors, ...d.volunteers]).filter((m) => m.id === sam.id);
    expect(appearances).toHaveLength(1);
    expect(depts.find((d) => d.department.code === "VADM")?.volunteers.map((v) => v.id)).toContain(sam.id);
  });
});
```

Add the fixture helper near the other helpers in that file:

```ts
async function threeTermFixture() {
  const prev = await prisma.term.create({
    data: { code: "SP26", name: "Spring 2026", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" },
  });
  const live = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-15"), endDate: new Date("2026-08-15"), status: "ACTIVE" },
  });
  const next = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-20"), status: "PLANNING" },
  });
  const dept = await prisma.department.create({ data: { code: "PCAR", name: "Patient Care" } });
  return { prev, live, next, dept };
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/support/services/itcm.test.ts -t "term scope"`
Expected: FAIL. The next-term member is absent and `termCode` does not exist.

- [ ] **Step 3: Add `termCode` to `MemberLite`**

```ts
export type MemberLite = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  kind: "DIRECTOR" | "VOLUNTEER";
  /**
   * The term this person's membership came from, when it is NOT the live one.
   * Null for a live-term member. Drives the badge that tells an admin they are
   * raising a request for someone not on the current roster.
   */
  termCode: string | null;
};
```

- [ ] **Step 4: Rewrite the loader**

Replace `listDepartmentsWithMembers` in full:

```ts
/**
 * Returns all active departments with their selectable members.
 *
 * Epic accounts are provisioned around the term flip, not inside it, so the
 * picker spans three rosters: the LIVE term; the NEXT term, where the incoming
 * class onboarded ahead of the flip already holds its memberships and has no
 * live-term row yet; and the PREVIOUS term, for a returner whose renewal has
 * not been promoted. Anyone outside the live term carries their term code so an
 * admin can see they are not on the current roster.
 *
 * Members are sorted by name within each role group.
 */
export async function listDepartmentsWithMembers(): Promise<DepartmentWithMembers[]> {
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return [];

  const [nextTerm, previousTerm] = await Promise.all([
    getNextTerm(),
    prisma.term.findFirst({
      where: { startDate: { lt: activeTerm.startDate } },
      orderBy: { startDate: "desc" },
      select: { id: true, code: true },
    }),
  ]);

  // Lower rank wins when a person holds ACTIVE memberships in more than one of
  // the three. The live term wins deliberately: it is their CURRENT role, and a
  // future director who is a volunteer today should mirror volunteer-level Epic
  // access, never the other way round.
  const termMeta = new Map<string, { rank: number; code: string }>();
  termMeta.set(activeTerm.id, { rank: 0, code: activeTerm.code });
  if (nextTerm) termMeta.set(nextTerm.id, { rank: 1, code: nextTerm.code });
  if (previousTerm) termMeta.set(previousTerm.id, { rank: 2, code: previousTerm.code });

  const memberships = await prisma.termMembership.findMany({
    where: { termId: { in: [...termMeta.keys()] }, status: "ACTIVE" },
    select: {
      kind: true,
      termId: true,
      departmentId: true,
      department: true,
      // Narrowed from `person: true`. This loader is already named in
      // page.tsx's standing comment as a payload problem, and it now spans
      // three terms, so it reads only the six fields MemberLite needs.
      person: {
        select: { id: true, name: true, netId: true, contactEmail: true, epicId: true },
      },
    },
    orderBy: [{ department: { code: "asc" } }, ...personNameOrderVia("person")],
  });

  // A person can legitimately hold two ACTIVE memberships in ONE term (DIRECTOR
  // in one department, VOLUNTEER in another), so the dedup cannot be a flat
  // person-id Set: that would silently drop the second department. Instead keep
  // every row from the person's BEST-ranked term and discard the rest, so a
  // member who changed departments between terms is listed under the department
  // they are in now rather than under both.
  const bestRank = new Map<string, number>();
  for (const m of memberships) {
    const rank = termMeta.get(m.termId)?.rank ?? 2;
    const seen = bestRank.get(m.person.id);
    if (seen === undefined || rank < seen) bestRank.set(m.person.id, rank);
  }

  const byDept = new Map<string, DepartmentWithMembers>();
  const seenByDept = new Map<string, Set<string>>();

  for (const m of memberships) {
    const meta = termMeta.get(m.termId);
    const rank = meta?.rank ?? 2;
    if (rank !== bestRank.get(m.person.id)) continue;

    if (!byDept.has(m.departmentId)) {
      byDept.set(m.departmentId, { department: m.department, directors: [], volunteers: [] });
      seenByDept.set(m.departmentId, new Set());
    }
    const seen = seenByDept.get(m.departmentId)!;
    if (seen.has(m.person.id)) continue;
    seen.add(m.person.id);

    const member: MemberLite = {
      id: m.person.id,
      name: m.person.name,
      netId: m.person.netId,
      contactEmail: m.person.contactEmail,
      epicId: m.person.epicId,
      kind: m.kind,
      termCode: rank === 0 ? null : (meta?.code ?? null),
    };

    const entry = byDept.get(m.departmentId)!;
    if (m.kind === "DIRECTOR") entry.directors.push(member);
    else entry.volunteers.push(member);
  }

  return [...byDept.values()];
}
```

Add the import: `import { getNextTerm } from "@/platform/terms/next-term";`

- [ ] **Step 5: Fix the two stale docstrings**

At the top of `itcm.ts`, replace the `listDepartmentsWithMembers` bullet:

```
 *   - listDepartmentsWithMembers: all active departments with the members of
 *     the live term and its two neighbours (directors and volunteers), used to
 *     populate the person selector and find Epic ID mirror candidates.
```

- [ ] **Step 6: Render the badge in both pickers**

In `epic-request-form.tsx`'s `PersonRow` and in `epic-person-picker.tsx`'s equivalent, beside the person's name:

```tsx
{person.termCode ? (
  <Badge tone="warning">{person.termCode}</Badge>
) : null}
```

Both pickers need it: `listDepartmentsWithMembers` feeds the attach-Epic picker on `/support/[id]` too, and a previous-term holdover who was never offboarded is still `Person.status: ACTIVE`, so nothing downstream would otherwise flag them.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/modules/support/services/itcm.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/support
git commit -m "fix(epic): show the incoming class in the person picker, badged by term"
```

---

## Task 7: Surface a deactivation for someone who came back

A `PENDING` `DEACTIVATE` for a person whose status is `ACTIVE` appears on no surface. `listPendingEpicRequests` filters `kind: { not: "DEACTIVATE" }`; `listPendingDeactivations` filters `person.status != ACTIVE`. It cannot be cancelled and still counts against the one-open-request-per-person guard, which is the same shape as the bug `itcm.ts:1019-1025` records having already shipped once.

**Files:**
- Modify: `src/modules/support/services/itcm.ts` (add `listStrandedDeactivations`)
- Modify: `src/modules/support/components/epic-request-tabs.tsx` (`PendingTab`)
- Test: `src/modules/support/services/itcm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `listStrandedDeactivations(): Promise<StrandedDeactivationRow[]>` where `StrandedDeactivationRow = { requestId: string; personId: string; personName: string; createdAt: Date }`.

- [ ] **Step 1: Write the failing test**

```ts
describe("listStrandedDeactivations", () => {
  it("finds a pending deactivation for a person who is active again", async () => {
    const actor = await createPerson("Admin");
    const sam = await createPerson("Sam Rivera", { epicId: "EP1", status: "ACTIVE" });
    const req = await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    const rows = await listStrandedDeactivations();
    expect(rows.map((r) => r.requestId)).toEqual([req.id]);
  });

  it("ignores a deactivation for someone who is still offboarded", async () => {
    const actor = await createPerson("Admin");
    const sam = await createPerson("Sam Rivera", { epicId: "EP1", status: "OFFBOARDED" });
    await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    expect(await listStrandedDeactivations()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/itcm.test.ts -t listStrandedDeactivations`
Expected: FAIL with `listStrandedDeactivations is not a function`.

- [ ] **Step 3: Implement it**

```ts
export type StrandedDeactivationRow = {
  requestId: string;
  personId: string;
  personName: string;
  createdAt: Date;
};

/**
 * Pending deactivations for people who are ACTIVE again.
 *
 * These are invisible everywhere else: listPendingEpicRequests excludes
 * DEACTIVATE, and listPendingDeactivations requires a non-active person. So the
 * row cannot be seen or cancelled from any surface, while still counting
 * against the one-open-request-per-person guard and blocking a fresh grant.
 * Normally cancelOpenDeactivationRequestsTx clears these on reactivation; this
 * finds the ones it missed.
 */
export async function listStrandedDeactivations(): Promise<StrandedDeactivationRow[]> {
  const rows = await prisma.epicRequest.findMany({
    where: { kind: "DEACTIVATE", status: "PENDING", person: { status: "ACTIVE" } },
    select: { id: true, personId: true, createdAt: true, person: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    requestId: r.id,
    personId: r.personId,
    personName: r.person.name,
    createdAt: r.createdAt,
  }));
}
```

- [ ] **Step 4: Render the bucket on the Pending tab**

In `epic-request-tabs.tsx`'s `PendingTab`, beside the existing `EpicTicketsWithoutRequest` card, add a card that lists the rows and offers the fix inline. The cancel action is the existing `cancelEpicRequest`, wired the same way the Tracker's Cancel button already is:

```tsx
{strandedDeactivations.length > 0 ? (
  <Card>
    <SectionHeader title="Deactivations for people who are active again" />
    <Alert tone="warning">
      These people were offboarded, had an Epic deactivation queued, and then
      came back. The request is on no other surface and still blocks a new Epic
      request for them. Cancel it unless their access really should be revoked.
    </Alert>
    <ul>
      {strandedDeactivations.map((r) => (
        <li key={r.requestId} className="flex items-center justify-between gap-2 py-2">
          <span>{r.personName}</span>
          <form action={cancelRequestAction}>
            <input type="hidden" name="requestId" value={r.requestId} />
            <Button type="submit" variant="secondary">Cancel deactivation</Button>
          </form>
        </li>
      ))}
    </ul>
  </Card>
) : null}
```

Load it in `page.tsx` inside the existing `needsPending` conditional block, alongside `listEpicTicketsWithoutRequest()`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/support/services/itcm.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Run the full check and commit**

```bash
npx eslint src e2e && npx vitest run src/platform
git add src/modules/support src/app/\(app\)/support/epic/page.tsx
git commit -m "fix(epic): surface a pending deactivation for someone who came back"
```

**Phase 1 is complete and mergeable here.** The request records whether it was sent, both access dates persist, a YNHH refusal has its own outcome, and four review findings are closed.

---

# Phase 2: The closeable batch

## Task 8: Derive a batch's stage

**Files:**
- Create: `src/modules/support/services/epic-batch-stage.ts`
- Test: `src/modules/support/services/epic-batch-stage.test.ts`

**Interfaces:**
- Consumes: nothing. Pure module, no imports beyond types.
- Produces: `BatchStage`, `BatchFacts`, `BatchRequestFacts`, `deriveBatchStage(batch: BatchFacts): BatchStage`, `NEXT_ACTION: Record<BatchStage, string | null>`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/support/services/epic-batch-stage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveBatchStage, NEXT_ACTION, type BatchFacts } from "./epic-batch-stage";

function batch(over: Partial<BatchFacts> = {}): BatchFacts {
  return {
    status: "OPEN",
    sentAt: null,
    serviceRequestNumber: null,
    requests: [],
    ...over,
  };
}

describe("deriveBatchStage", () => {
  it("is GENERATED until someone confirms the send", () => {
    expect(deriveBatchStage(batch())).toBe("GENERATED");
  });

  it("is SENT once confirmed but before YNHH issues a number", () => {
    expect(deriveBatchStage(batch({ sentAt: new Date() }))).toBe("SENT");
  });

  it("treats a whitespace-only service request number as absent", () => {
    expect(deriveBatchStage(batch({ sentAt: new Date(), serviceRequestNumber: "   " }))).toBe("SENT");
  });

  it("is ACKNOWLEDGED when the number is in and nothing has come back", () => {
    const b = batch({
      sentAt: new Date(),
      serviceRequestNumber: "RITM0123",
      requests: [{ status: "SUBMITTED", memberEmailedAt: null }],
    });
    expect(deriveBatchStage(b)).toBe("ACKNOWLEDGED");
  });

  it("is RETURNED on a partial response", () => {
    const b = batch({
      sentAt: new Date(),
      serviceRequestNumber: "RITM0123",
      requests: [
        { status: "COMPLETED", memberEmailedAt: null },
        { status: "SUBMITTED", memberEmailedAt: null },
      ],
    });
    expect(deriveBatchStage(b)).toBe("RETURNED");
  });

  it("is RECONCILED when everything resolved but members are untold", () => {
    const b = batch({
      sentAt: new Date(),
      serviceRequestNumber: "RITM0123",
      requests: [{ status: "COMPLETED", memberEmailedAt: null }],
    });
    expect(deriveBatchStage(b)).toBe("RECONCILED");
  });

  it("is DONE once every completed member has been emailed", () => {
    const b = batch({
      sentAt: new Date(),
      serviceRequestNumber: "RITM0123",
      requests: [
        { status: "COMPLETED", memberEmailedAt: new Date() },
        { status: "REJECTED", memberEmailedAt: null },
      ],
    });
    expect(deriveBatchStage(b)).toBe("DONE");
  });

  it("does not wait on an email for a rejected or cancelled request", () => {
    const b = batch({
      sentAt: new Date(),
      serviceRequestNumber: "RITM0123",
      requests: [
        { status: "REJECTED", memberEmailedAt: null },
        { status: "CANCELLED", memberEmailedAt: null },
      ],
    });
    expect(deriveBatchStage(b)).toBe("DONE");
  });

  it("reports a closed ticket as CLOSED even with no sentAt", () => {
    // Every ticket predating this feature has a null sentAt. Any other ordering
    // renders closed history as "never sent".
    expect(deriveBatchStage(batch({ status: "CLOSED" }))).toBe("CLOSED");
  });

  it("gives every stage a next action except CLOSED", () => {
    expect(NEXT_ACTION.CLOSED).toBeNull();
    for (const stage of ["GENERATED", "SENT", "ACKNOWLEDGED", "RETURNED", "RECONCILED", "DONE"] as const) {
      expect(NEXT_ACTION[stage]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/support/services/epic-batch-stage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module**

Create `src/modules/support/services/epic-batch-stage.ts`:

```ts
/**
 * Derives what stage a YNHH batch is at, and the single next action it needs.
 *
 * Pure: no database, no clock. The stage is DERIVED rather than stored because
 * a status column a human must remember to advance is exactly the failure this
 * exists to fix. EpicRequest.status flips to SUBMITTED the moment a PDF is
 * generated and nothing ever corrects it, so "SUBMITTED" cannot distinguish a
 * batch YNHH is working from one that was generated and forgotten. Every fact
 * read here is instead written as a side effect of real work: confirming a
 * send, typing the service request number, resolving a request, emailing a
 * member.
 */

export type BatchStage =
  | "CLOSED"
  | "GENERATED"
  | "SENT"
  | "ACKNOWLEDGED"
  | "RETURNED"
  | "RECONCILED"
  | "DONE";

export type BatchRequestFacts = {
  status: "PENDING" | "SUBMITTED" | "COMPLETED" | "REJECTED" | "CANCELLED";
  memberEmailedAt: Date | null;
};

export type BatchFacts = {
  status: "OPEN" | "CLOSED";
  sentAt: Date | null;
  serviceRequestNumber: string | null;
  requests: BatchRequestFacts[];
};

/** The one thing to do next. Drives the batch page's lead action. */
export const NEXT_ACTION: Record<BatchStage, string | null> = {
  CLOSED: null,
  GENERATED: "Mark as sent to YNHH",
  SENT: "Record the service request number when YNHH issues it",
  ACKNOWLEDGED: "Upload the spreadsheet YNHH returned",
  RETURNED: "Finish reconciling the returned rows",
  RECONCILED: "Email the members whose accounts are ready",
  DONE: "Close the batch",
};

function isOpen(r: BatchRequestFacts): boolean {
  return r.status === "PENDING" || r.status === "SUBMITTED";
}

export function deriveBatchStage(batch: BatchFacts): BatchStage {
  // CLOSED first, and deliberately: see the null-sentAt note in the test.
  if (batch.status === "CLOSED") return "CLOSED";
  if (!batch.sentAt) return "GENERATED";
  if (!batch.serviceRequestNumber?.trim()) return "SENT";

  const open = batch.requests.filter(isOpen).length;
  if (open > 0) {
    // Nothing back yet, versus a partial return.
    return open === batch.requests.length ? "ACKNOWLEDGED" : "RETURNED";
  }

  // Only a COMPLETED request owes the member an email. A rejection or a
  // cancellation has nothing to announce.
  const owed = batch.requests.filter(
    (r) => r.status === "COMPLETED" && r.memberEmailedAt === null
  ).length;
  return owed > 0 ? "RECONCILED" : "DONE";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-batch-stage.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/epic-batch-stage.ts src/modules/support/services/epic-batch-stage.test.ts
git commit -m "feat(epic): derive a batch's stage from what actually happened to it"
```

---

## Task 9: Match the returned spreadsheet

All the parsing and matching risk lives here, with no database access, so it is fully testable.

**Files:**
- Create: `src/modules/support/services/epic-return-match.ts`
- Test: `src/modules/support/services/epic-return-match.test.ts`

**Interfaces:**
- Consumes: nothing. Pure module.
- Produces: `SheetRow`, `BatchRequestCandidate`, `MatchVia`, `MatchResult`, `matchReturnedRows(rows, candidates): MatchResult`, `parseReturnedSheet(buffer: ArrayBuffer): Promise<SheetRow[]>`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/support/services/epic-return-match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  matchReturnedRows,
  type BatchRequestCandidate,
  type SheetRow,
} from "./epic-return-match";

function candidate(over: Partial<BatchRequestCandidate> = {}): BatchRequestCandidate {
  return {
    requestId: "r1",
    personId: "p1",
    legalFirstName: "Samuel",
    lastName: "Rivera",
    netId: "sr123",
    contactEmail: "sam.rivera@yale.edu",
    ...over,
  };
}

function row(over: Partial<SheetRow> = {}): SheetRow {
  return {
    rowNumber: 2,
    firstName: "Samuel",
    lastName: "Rivera",
    email: "sam.rivera@yale.edu",
    yaleId: "sr123",
    epicId: "EP44821",
    ...over,
  };
}

describe("matchReturnedRows", () => {
  it("matches on Yale ID first", () => {
    const res = matchReturnedRows([row()], [candidate()]);
    expect(res.matched).toEqual([
      { requestId: "r1", epicId: "EP44821", via: "yaleId", rowNumber: 2 },
    ]);
    expect(res.missing).toEqual([]);
  });

  it("falls back to email when the Yale ID is blank", () => {
    const res = matchReturnedRows([row({ yaleId: "" })], [candidate()]);
    expect(res.matched[0]?.via).toBe("email");
  });

  it("falls back to name when both ids are blank", () => {
    const res = matchReturnedRows([row({ yaleId: "", email: "" })], [candidate()]);
    expect(res.matched[0]?.via).toBe("name");
  });

  it("matches a name even though the sheet joins first and middle names", () => {
    // generateSpreadsheet writes "legalFirstName legalMiddleName" into First Name.
    const res = matchReturnedRows(
      [row({ yaleId: "", email: "", firstName: "Samuel Jose" })],
      [candidate()]
    );
    expect(res.matched[0]?.via).toBe("name");
  });

  it("is case and whitespace insensitive", () => {
    const res = matchReturnedRows([row({ yaleId: "  SR123 " })], [candidate()]);
    expect(res.matched[0]?.via).toBe("yaleId");
  });

  it("reports two same-name candidates as ambiguous rather than guessing", () => {
    const res = matchReturnedRows(
      [row({ yaleId: "", email: "" })],
      [candidate({ requestId: "r1", netId: null, contactEmail: null }),
       candidate({ requestId: "r2", personId: "p2", netId: null, contactEmail: null })]
    );
    expect(res.matched).toEqual([]);
    expect(res.ambiguous).toHaveLength(1);
    expect(res.ambiguous[0].candidateRequestIds.sort()).toEqual(["r1", "r2"]);
  });

  it("reports a row matching nobody as unmatched", () => {
    const res = matchReturnedRows([row({ yaleId: "zz999", email: "", firstName: "Nobody", lastName: "Here" })], [candidate()]);
    expect(res.unmatched).toHaveLength(1);
    expect(res.matched).toEqual([]);
  });

  it("reports a candidate with no row as missing", () => {
    const res = matchReturnedRows([], [candidate()]);
    expect(res.missing.map((c) => c.requestId)).toEqual(["r1"]);
  });

  it("treats a row with a blank Epic ID as not returned", () => {
    // YNHH returns the whole sheet; an un-filled row means they did not action
    // that person, which is a missing candidate, not a match to empty string.
    const res = matchReturnedRows([row({ epicId: "  " })], [candidate()]);
    expect(res.matched).toEqual([]);
    expect(res.missing.map((c) => c.requestId)).toEqual(["r1"]);
  });

  it("never matches one candidate twice", () => {
    const res = matchReturnedRows(
      [row({ rowNumber: 2 }), row({ rowNumber: 3, epicId: "EP99999" })],
      [candidate()]
    );
    expect(res.matched).toHaveLength(1);
    expect(res.unmatched).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/support/services/epic-return-match.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module**

Create `src/modules/support/services/epic-return-match.ts`:

```ts
/**
 * Matches the rows of a returned YNHH spreadsheet back to the Epic requests the
 * batch was built from.
 *
 * Pure: no database, no filesystem beyond the parse helper. All of this
 * feature's fuzzy-matching risk lives here so that it is exhaustively testable.
 *
 * Matching is layered over columns the sheet ALREADY carries: Yale University
 * ID, then E-Mail Address, then normalised legal name. We deliberately do NOT
 * embed a correlation id in the outgoing sheet, which would make this trivial:
 * that document is YNHH's own Service Request Form V5.5 template, an unexpected
 * column risks a bounce from a process we neither control nor can test against,
 * and a bounced batch costs more than a hand-resolved row.
 */

export type SheetRow = {
  /** 1-based row number in the sheet, so an error can name the row. */
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  yaleId: string;
  epicId: string;
};

export type BatchRequestCandidate = {
  requestId: string;
  personId: string;
  legalFirstName: string;
  lastName: string;
  netId: string | null;
  contactEmail: string | null;
};

export type MatchVia = "yaleId" | "email" | "name";

export type MatchResult = {
  matched: Array<{ requestId: string; epicId: string; via: MatchVia; rowNumber: number }>;
  ambiguous: Array<{ row: SheetRow; candidateRequestIds: string[] }>;
  unmatched: SheetRow[];
  /** Asked for, but absent from the return (or returned with a blank Epic ID). */
  missing: BatchRequestCandidate[];
};

function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * The name key. Uses only the FIRST token of the first-name field because
 * generateSpreadsheet writes "legalFirstName legalMiddleName" into First Name,
 * so both sides must be reduced the same way for a middle name not to break it.
 */
function nameKey(firstName: string, lastName: string): string {
  const first = norm(firstName).split(/\s+/)[0] ?? "";
  return `${norm(lastName)}|${first}`;
}

function index<T>(items: T[], key: (i: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (!k || k === "|") continue;
    const bucket = m.get(k);
    if (bucket) bucket.push(i);
    else m.set(k, [i]);
  }
  return m;
}

export function matchReturnedRows(
  rows: SheetRow[],
  candidates: BatchRequestCandidate[]
): MatchResult {
  const byYaleId = index(candidates, (c) => norm(c.netId));
  const byEmail = index(candidates, (c) => norm(c.contactEmail));
  const byName = index(candidates, (c) => nameKey(c.legalFirstName, c.lastName));

  const matched: MatchResult["matched"] = [];
  const ambiguous: MatchResult["ambiguous"] = [];
  const unmatched: SheetRow[] = [];
  const claimed = new Set<string>();

  for (const row of rows) {
    // A blank Epic ID means YNHH did not action this person. That is a missing
    // candidate, never a match to an empty string.
    if (!row.epicId.trim()) continue;

    const attempts: Array<[MatchVia, BatchRequestCandidate[] | undefined]> = [
      ["yaleId", byYaleId.get(norm(row.yaleId))],
      ["email", byEmail.get(norm(row.email))],
      ["name", byName.get(nameKey(row.firstName, row.lastName))],
    ];

    let settled = false;
    for (const [via, hits] of attempts) {
      if (!hits || hits.length === 0) continue;
      const free = hits.filter((c) => !claimed.has(c.requestId));
      if (free.length === 0) continue;
      if (free.length > 1) {
        ambiguous.push({ row, candidateRequestIds: free.map((c) => c.requestId) });
        settled = true;
        break;
      }
      claimed.add(free[0].requestId);
      matched.push({
        requestId: free[0].requestId,
        epicId: row.epicId.trim(),
        via,
        rowNumber: row.rowNumber,
      });
      settled = true;
      break;
    }

    if (!settled) unmatched.push(row);
  }

  const missing = candidates.filter((c) => !claimed.has(c.requestId));
  return { matched, ambiguous, unmatched, missing };
}
```

- [ ] **Step 4: Add the sheet parser**

Append to the same file:

```ts
/**
 * Reads a returned YNHH spreadsheet into rows.
 *
 * Column positions mirror generateSpreadsheet's header order exactly, since
 * that is the sheet we sent. Reads by position rather than by header text so a
 * YNHH-side header tweak does not silently produce empty rows.
 */
export async function parseReturnedSheet(buffer: ArrayBuffer): Promise<SheetRow[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("That file has no worksheets.");

  const cell = (r: import("exceljs").Row, i: number): string => {
    const v = r.getCell(i).value;
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && "text" in v) return String(v.text);
    return String(v);
  };

  const rows: SheetRow[] = [];
  ws.eachRow((r, rowNumber) => {
    if (rowNumber === 1) return; // header
    rows.push({
      rowNumber,
      lastName: cell(r, 1),
      firstName: cell(r, 2),
      email: cell(r, 4),
      yaleId: cell(r, 11),
      epicId: cell(r, 13),
    });
  });
  return rows;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-return-match.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/support/services/epic-return-match.ts src/modules/support/services/epic-return-match.test.ts
git commit -m "feat(epic): match a returned YNHH spreadsheet back to its requests"
```

---

## Task 10: The batch loader

**Files:**
- Create: `src/modules/support/services/epic-batch.ts`
- Test: `src/modules/support/services/epic-batch.test.ts`

**Interfaces:**
- Consumes: `deriveBatchStage` (Task 8), `BatchRequestCandidate` (Task 9), `loadClearanceMap` from `@/platform/clearance`.
- Produces: `BatchRow`, `LoadedBatch`, `loadBatch(actorPersonId: string, ticketId: string): Promise<LoadedBatch>`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/support/services/epic-batch.test.ts` with the same `createPerson` / `grantPermission` helpers used by `itcm.test.ts`, then:

```ts
describe("loadBatch", () => {
  it("returns the batch's stage and one row per request", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera", { contactEmail: "sam@yale.edu" });
    const ticket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, description: "NEW - Sam Rivera", sentAt: new Date(), serviceRequestNumber: "RITM1" },
    });
    await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "SUBMITTED", requestedById: actor.id, ticketId: ticket.id },
    });

    const batch = await loadBatch(actor.id, ticket.id);

    expect(batch.stage).toBe("ACKNOWLEDGED");
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0].name).toBe("Sam Rivera");
    expect(batch.rows[0].blockedReason).toBeNull();
  });

  it("blocks a row whose person has no email on file", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera", { contactEmail: undefined });
    const ticket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, description: "x" },
    });
    await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "COMPLETED", requestedById: actor.id, ticketId: ticket.id },
    });

    const batch = await loadBatch(actor.id, ticket.id);
    expect(batch.rows[0].blockedReason).toBe("No email address on file");
  });

  it("refuses without the permission", async () => {
    const actor = await createPerson("Nobody");
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, description: "x" } });
    await expect(loadBatch(actor.id, ticket.id)).rejects.toThrow(SupportForbiddenError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the loader**

Create `src/modules/support/services/epic-batch.ts`:

```ts
/**
 * The batch workspace: everything /support/epic/batch/[ticketId] needs, and the
 * writes it performs.
 *
 * A "batch" is a YnhhTicket plus the EpicRequests grouped under it. This module
 * owns reconciling YNHH's response and telling the members; the pure logic it
 * leans on lives in epic-batch-stage.ts and epic-return-match.ts.
 */

import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { getActiveTerm } from "@/platform/terms/active-term";
import { loadClearanceMap } from "@/platform/clearance";
import { loadEffectiveSteps } from "@/modules/onboarding/services/step-config";
import { MANAGE, SupportForbiddenError, SupportNotFoundError } from "./tech-request";
import { deriveBatchStage, NEXT_ACTION, type BatchStage } from "./epic-batch-stage";
import type { BatchRequestCandidate } from "./epic-return-match";

export type BatchRow = {
  requestId: string;
  personId: string;
  name: string;
  kind: "NEW" | "MODIFY" | "RENEW" | "DEACTIVATE";
  status: "PENDING" | "SUBMITTED" | "COMPLETED" | "REJECTED" | "CANCELLED";
  epicId: string | null;
  contactEmail: string | null;
  outcomeNote: string | null;
  memberEmailedAt: Date | null;
  /** Full six-step clearance. Drives the warning badge, never a refusal. */
  cleared: boolean;
  missingLabels: string[];
  /**
   * Set only when the row genuinely cannot be emailed by anyone. Disables the
   * checkbox. Missing clearance is NOT a blocked reason: it is a warning an
   * ITCM director is entitled to override.
   */
  blockedReason: string | null;
};

export type LoadedBatch = {
  ticketId: string;
  description: string | null;
  serviceRequestNumber: string | null;
  sentAt: Date | null;
  status: "OPEN" | "CLOSED";
  stage: BatchStage;
  nextAction: string | null;
  rows: BatchRow[];
};

async function requireManage(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, MANAGE))) {
    throw new SupportForbiddenError("You do not have permission to manage Epic requests.");
  }
}

export async function loadBatch(actorPersonId: string, ticketId: string): Promise<LoadedBatch> {
  await requireManage(actorPersonId);

  const ticket = await prisma.ynhhTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true, description: true, serviceRequestNumber: true, sentAt: true, status: true,
      requests: {
        select: {
          id: true, kind: true, status: true, outcomeNote: true, memberEmailedAt: true,
          person: { select: { id: true, name: true, contactEmail: true, epicId: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!ticket) throw new SupportNotFoundError(`YnhhTicket not found: ${ticketId}`);

  // One clearance read for the whole batch, never per person. The step map
  // turns ClearanceSummary.missing (raw OnboardingTaskKeys like "hipaa") into
  // the per-term labels an admin recognises, exactly as epic-rollup.ts:249 does.
  const activeTerm = await getActiveTerm();
  const personIds = ticket.requests.map((r) => r.person.id);
  const [clearance, steps] = activeTerm
    ? await Promise.all([
        loadClearanceMap(personIds, activeTerm.id),
        loadEffectiveSteps(activeTerm.id),
      ])
    : [new Map(), new Map()];

  const rows: BatchRow[] = ticket.requests.map((r) => {
    const c = clearance.get(r.person.id);
    return {
      requestId: r.id,
      personId: r.person.id,
      name: r.person.name,
      kind: r.kind,
      status: r.status,
      epicId: r.person.epicId,
      contactEmail: r.person.contactEmail,
      outcomeNote: r.outcomeNote,
      memberEmailedAt: r.memberEmailedAt,
      cleared: c?.cleared ?? false,
      missingLabels: (c?.missing ?? []).map((k) => steps.get(k)?.label ?? k),
      blockedReason: r.person.contactEmail ? null : "No email address on file",
    };
  });

  const stage = deriveBatchStage({
    status: ticket.status,
    sentAt: ticket.sentAt,
    serviceRequestNumber: ticket.serviceRequestNumber,
    requests: ticket.requests.map((r) => ({ status: r.status, memberEmailedAt: r.memberEmailedAt })),
  });

  return {
    ticketId: ticket.id,
    description: ticket.description,
    serviceRequestNumber: ticket.serviceRequestNumber,
    sentAt: ticket.sentAt,
    status: ticket.status,
    stage,
    nextAction: NEXT_ACTION[stage],
    rows,
  };
}

/** The batch's open requests, shaped for epic-return-match. */
export async function loadBatchCandidates(ticketId: string): Promise<BatchRequestCandidate[]> {
  const rows = await prisma.epicRequest.findMany({
    where: { ticketId, status: "SUBMITTED" },
    select: {
      id: true,
      person: { select: { id: true, legalFirstName: true, lastName: true, netId: true, contactEmail: true } },
    },
  });
  return rows.map((r) => ({
    requestId: r.id,
    personId: r.person.id,
    legalFirstName: r.person.legalFirstName,
    lastName: r.person.lastName,
    netId: r.person.netId,
    contactEmail: r.person.contactEmail,
  }));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts && npx eslint src e2e`
Expected: PASS. The eslint run matters here: `src/modules` importing `@/platform/clearance` is the sanctioned facade, but a direct `@/modules/onboarding/...` import would be a boundary violation only eslint catches.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/epic-batch.ts src/modules/support/services/epic-batch.test.ts
git commit -m "feat(epic): load a batch with its stage and per-person clearance"
```

---

## Task 11: Apply the returned sheet

**Files:**
- Modify: `src/modules/support/services/epic-batch.ts`
- Test: `src/modules/support/services/epic-batch.test.ts`

**Interfaces:**
- Consumes: `completeRequest`, `rejectRequest` (Task 2), `matchReturnedRows` (Task 9), `loadBatchCandidates` (Task 10).
- Produces: `ApplyResult = { completed: number; failed: Array<{ name: string; reason: string }> }`, `applyReturnedSheet(actorPersonId, ticketId, decisions): Promise<ApplyResult>` where `decisions: Array<{ requestId: string; epicId: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("applyReturnedSheet", () => {
  it("completes each matched request and stamps the Epic ID on the person", async () => {
    const { actor, ticket, sam, req } = await submittedBatchFixture();

    const res = await applyReturnedSheet(actor.id, ticket.id, [
      { requestId: req.id, epicId: "EP44821" },
    ]);

    expect(res.completed).toBe(1);
    expect(res.failed).toEqual([]);
    const person = await prisma.person.findUniqueOrThrow({ where: { id: sam.id } });
    expect(person.epicId).toBe("EP44821");
  });

  it("does not let one bad row roll back the good ones", async () => {
    const { actor, ticket, req } = await submittedBatchFixture();
    const res = await applyReturnedSheet(actor.id, ticket.id, [
      { requestId: req.id, epicId: "EP44821" },
      { requestId: "does-not-exist", epicId: "EP00000" },
    ]);

    expect(res.completed).toBe(1);
    expect(res.failed).toHaveLength(1);
  });

  it("refuses an Epic ID that already belongs to someone else", async () => {
    const { actor, ticket, req } = await submittedBatchFixture();
    await createPerson("Other Person", { epicId: "EP44821" });

    const res = await applyReturnedSheet(actor.id, ticket.id, [
      { requestId: req.id, epicId: "EP44821" },
    ]);

    expect(res.completed).toBe(0);
    expect(res.failed[0].reason).toMatch(/already belongs/i);
  });

  it("skips a request that was cancelled while the sheet sat in an inbox", async () => {
    const { actor, ticket, req } = await submittedBatchFixture();
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "CANCELLED" } });

    const res = await applyReturnedSheet(actor.id, ticket.id, [
      { requestId: req.id, epicId: "EP44821" },
    ]);

    expect(res.completed).toBe(0);
    expect(res.failed[0].reason).toMatch(/no longer awaiting/i);
  });
});
```

Add the fixture helper:

```ts
async function submittedBatchFixture() {
  const actor = await createPerson("Admin");
  await grantPermission(actor.id, "support.manage_requests");
  const sam = await createPerson("Sam Rivera", { contactEmail: "sam@yale.edu", netId: "sr123" });
  const ticket = await prisma.ynhhTicket.create({
    data: { submittedById: actor.id, description: "NEW - Sam Rivera", sentAt: new Date(), serviceRequestNumber: "RITM1" },
  });
  const req = await prisma.epicRequest.create({
    data: { personId: sam.id, kind: "NEW", status: "SUBMITTED", requestedById: actor.id, ticketId: ticket.id },
  });
  return { actor, ticket, sam, req };
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts -t applyReturnedSheet`
Expected: FAIL with `applyReturnedSheet is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/modules/support/services/epic-batch.ts`:

```ts
export type ApplyResult = {
  completed: number;
  failed: Array<{ name: string; reason: string }>;
};

/**
 * Applies a reviewed match from a returned YNHH sheet.
 *
 * ALL-OR-NOTHING PER ROW, NOT PER BATCH. One unparseable Epic ID must not roll
 * back thirty-nine good completions, so each row is its own attempt with its
 * own try/catch, following the sequential per-row shape attending-access.ts
 * uses for the same reason. Sequential rather than Promise.all: completeRequest
 * claims atomically and then writes Person.epicId through its own transaction,
 * and concurrent writers against shared rows race.
 *
 * Audits "epic.batch_reconcile" with the counts and the failure reasons.
 */
export async function applyReturnedSheet(
  actorPersonId: string,
  ticketId: string,
  decisions: Array<{ requestId: string; epicId: string }>
): Promise<ApplyResult> {
  await requireManage(actorPersonId);

  const { completeRequest } = await import("./epic");
  const failed: ApplyResult["failed"] = [];
  let completed = 0;

  for (const d of decisions) {
    const req = await prisma.epicRequest.findUnique({
      where: { id: d.requestId },
      select: { id: true, ticketId: true, status: true, personId: true, person: { select: { name: true } } },
    });
    const label = req?.person.name ?? d.requestId;

    if (!req || req.ticketId !== ticketId) {
      failed.push({ name: label, reason: "That request is not part of this batch." });
      continue;
    }
    if (req.status !== "SUBMITTED" && req.status !== "PENDING") {
      failed.push({ name: label, reason: `No longer awaiting YNHH (status ${req.status}).` });
      continue;
    }

    const epicId = d.epicId.trim();
    if (epicId) {
      // Reassigning an Epic ID silently would corrupt every future mirror
      // lookup in that person's department, so this is refused, not resolved.
      const owner = await prisma.person.findFirst({
        where: { epicId, id: { not: req.personId } },
        select: { name: true },
      });
      if (owner) {
        failed.push({ name: label, reason: `Epic ID ${epicId} already belongs to ${owner.name}.` });
        continue;
      }
    }

    try {
      await completeRequest(actorPersonId, req.id, epicId || undefined);
      completed++;
    } catch (err) {
      failed.push({ name: label, reason: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "epic.batch_reconcile",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { completed, failed },
  });

  return { completed, failed };
}
```

The dynamic `import("./epic")` breaks a require cycle: `epic.ts` imports from `epic-ticket-sync.ts`, which this module's siblings already import.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/epic-batch.ts src/modules/support/services/epic-batch.test.ts
git commit -m "feat(epic): apply a returned YNHH sheet row by row"
```

---

## Task 12: Email the members in bulk

**Files:**
- Modify: `src/modules/support/services/epic-batch.ts`
- Test: `src/modules/support/services/epic-batch.test.ts`

**Interfaces:**
- Consumes: `sendEpicEmail` from `./epic`, `EpicTemplateKey`.
- Produces: `BulkEmailResult = { sent: number; skipped: Array<{ name: string; reason: string }> }`, `sendBatchMemberEmails(actorPersonId, ticketId, requestIds, template): Promise<BulkEmailResult>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("sendBatchMemberEmails", () => {
  it("emails each completed member and records that it happened", async () => {
    const { actor, ticket, req } = await completedBatchFixture();

    const res = await sendBatchMemberEmails(actor.id, ticket.id, [req.id], "epic-activation");

    expect(res.sent).toBe(1);
    expect(res.skipped).toEqual([]);
    const after = await prisma.epicRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.memberEmailedAt).toBeInstanceOf(Date);
    expect(after.memberEmailTemplate).toBe("epic-activation");
  });

  it("does not email the same member twice", async () => {
    const { actor, ticket, req } = await completedBatchFixture();
    await sendBatchMemberEmails(actor.id, ticket.id, [req.id], "epic-activation");

    const second = await sendBatchMemberEmails(actor.id, ticket.id, [req.id], "epic-activation");

    expect(second.sent).toBe(0);
    expect(second.skipped[0].reason).toMatch(/already been emailed/i);
  });

  it("names who was skipped for having no email address", async () => {
    const actor = await createPerson("Admin");
    await grantPermission(actor.id, "support.manage_requests");
    const sam = await createPerson("Sam Rivera");
    const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, description: "x" } });
    const req = await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "NEW", status: "COMPLETED", requestedById: actor.id, ticketId: ticket.id },
    });

    const res = await sendBatchMemberEmails(actor.id, ticket.id, [req.id], "epic-activation");

    expect(res.sent).toBe(0);
    expect(res.skipped).toEqual([{ name: "Sam Rivera", reason: "No email address on file" }]);
  });

  it("skips a request that is not completed", async () => {
    const { actor, ticket, req } = await completedBatchFixture();
    await prisma.epicRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });

    const res = await sendBatchMemberEmails(actor.id, ticket.id, [req.id], "epic-activation");
    expect(res.sent).toBe(0);
  });
});
```

Add the fixture:

```ts
async function completedBatchFixture() {
  const actor = await createPerson("Admin");
  await grantPermission(actor.id, "support.manage_requests");
  const sam = await createPerson("Sam Rivera", { contactEmail: "sam@yale.edu", epicId: "EP44821" });
  const ticket = await prisma.ynhhTicket.create({ data: { submittedById: actor.id, description: "x" } });
  const req = await prisma.epicRequest.create({
    data: { personId: sam.id, kind: "NEW", status: "COMPLETED", requestedById: actor.id, ticketId: ticket.id },
  });
  return { actor, ticket, sam, req };
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts -t sendBatchMemberEmails`
Expected: FAIL with `sendBatchMemberEmails is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/modules/support/services/epic-batch.ts`:

```ts
export type BulkEmailResult = {
  sent: number;
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * Tells a batch's members their Epic accounts are ready.
 *
 * Goes through notify() per person rather than queueEmails, deliberately.
 * queueEmails is the purpose-built chunked fan-out but writes only an EmailLog
 * row: notify() additionally writes the Notification inbox row and honours the
 * admin-configured per-type channel routing including the Teams path. Ignoring
 * that routing on the module's highest-volume send would make the setting a
 * lie. Clinic batches run 60 to 150 people; queueEmails becomes the right
 * trade only in the thousands.
 *
 * This cannot be a campaign: campaign bodies are validated against exactly
 * firstName and name, so an Epic ID or a temporary password cannot ride in one.
 *
 * Each row is claimed atomically BEFORE its mail is built, so a double-submitted
 * form claims nothing the second time. A send failure releases the claim, the
 * same discipline completeRequest uses, so the row stays retryable.
 *
 * Audits "epic.batch_member_email" with the counts and the named skips. Naming
 * them is intentional and differs from campaigns, which report an unnamed
 * count: there the names would leak directory existence to a delegated sender,
 * whereas this actor already sees the whole roster and "three people were not
 * told" without saying which three is not actionable.
 */
export async function sendBatchMemberEmails(
  actorPersonId: string,
  ticketId: string,
  requestIds: string[],
  template: "epic-onboarding" | "epic-activation" | "epic-password-reset"
): Promise<BulkEmailResult> {
  await requireManage(actorPersonId);

  const { sendEpicEmail } = await import("./epic");
  const skipped: BulkEmailResult["skipped"] = [];
  let sent = 0;

  const rows = await prisma.epicRequest.findMany({
    where: { id: { in: requestIds }, ticketId },
    select: { id: true, status: true, memberEmailedAt: true, person: { select: { name: true, contactEmail: true } } },
    orderBy: { createdAt: "asc" },
  });

  for (const row of rows) {
    const name = row.person.name;

    if (!row.person.contactEmail) {
      skipped.push({ name, reason: "No email address on file" });
      continue;
    }

    const claim = await prisma.epicRequest.updateMany({
      where: { id: row.id, status: "COMPLETED", memberEmailedAt: null },
      data: { memberEmailedAt: new Date(), memberEmailTemplate: template },
    });
    if (claim.count === 0) {
      skipped.push({
        name,
        reason: row.memberEmailedAt
          ? "Has already been emailed"
          : `Request is ${row.status}, not completed`,
      });
      continue;
    }

    try {
      await sendEpicEmail(actorPersonId, row.id, template);
      sent++;
    } catch (err) {
      // Release the claim so the row stays retryable.
      await prisma.epicRequest.updateMany({
        where: { id: row.id },
        data: { memberEmailedAt: null, memberEmailTemplate: null },
      });
      skipped.push({ name, reason: err instanceof Error ? err.message : "Send failed" });
    }
  }

  await recordAudit({
    actorPersonId,
    action: "epic.batch_member_email",
    entityType: "YnhhTicket",
    entityId: ticketId,
    after: { template, sent, skipped },
  });

  return { sent, skipped };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/epic-batch.ts src/modules/support/services/epic-batch.test.ts
git commit -m "feat(epic): tell a whole batch's members their accounts are ready"
```

---

## Task 13: The batch page

**Files:**
- Create: `src/app/(app)/support/epic/batch/[ticketId]/page.tsx`
- Create: `src/app/(app)/support/epic/batch/[ticketId]/actions.ts`
- Create: `src/modules/support/components/batch-reconcile.tsx`
- Create: `src/modules/support/components/batch-member-email.tsx`

**Interfaces:**
- Consumes: `loadBatch`, `loadBatchCandidates`, `applyReturnedSheet`, `sendBatchMemberEmails` (Tasks 10-12); `parseReturnedSheet`, `matchReturnedRows` (Task 9); `markBatchSent` (Task 4).
- Produces: the route. No exports other tasks depend on.

- [ ] **Step 1: Write the server actions**

Create `src/app/(app)/support/epic/batch/[ticketId]/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { markBatchSent, closeTicket, updateServiceRequestNumber } from "@/modules/support/services/itcm";
import { applyReturnedSheet, sendBatchMemberEmails, loadBatchCandidates } from "@/modules/support/services/epic-batch";
import { parseReturnedSheet, matchReturnedRows, type MatchResult } from "@/modules/support/services/epic-return-match";

export async function markSentAction(ticketId: string): Promise<void> {
  const actor = await requirePermission("support.manage_requests");
  await markBatchSent(actor.personId, ticketId);
  revalidatePath(`/support/epic/batch/${ticketId}`);
}

/**
 * Parses an uploaded sheet and returns the match for review. Writes NOTHING:
 * the admin sees every bucket before any completion happens.
 */
export async function previewReturnAction(ticketId: string, formData: FormData): Promise<MatchResult> {
  await requirePermission("support.manage_requests");
  const file = formData.get("sheet");
  if (!(file instanceof File)) throw new Error("Choose the spreadsheet YNHH returned.");
  const rows = await parseReturnedSheet(await file.arrayBuffer());
  const candidates = await loadBatchCandidates(ticketId);
  return matchReturnedRows(rows, candidates);
}

export async function applyReturnAction(
  ticketId: string,
  decisions: Array<{ requestId: string; epicId: string }>
) {
  const actor = await requirePermission("support.manage_requests");
  const result = await applyReturnedSheet(actor.personId, ticketId, decisions);
  revalidatePath(`/support/epic/batch/${ticketId}`);
  return result;
}

export async function sendMemberEmailsAction(
  ticketId: string,
  requestIds: string[],
  template: "epic-onboarding" | "epic-activation" | "epic-password-reset"
) {
  const actor = await requirePermission("support.manage_requests");
  const result = await sendBatchMemberEmails(actor.personId, ticketId, requestIds, template);
  revalidatePath(`/support/epic/batch/${ticketId}`);
  return result;
}
```

`previewReturnAction` and `applyReturnAction` **return** their results rather than redirecting, because the global `FlashReader` strips action-feedback params from the URL before a server render could read them.

- [ ] **Step 2: Write the page**

Create `src/app/(app)/support/epic/batch/[ticketId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { loadBatch } from "@/modules/support/services/epic-batch";
import { SupportNotFoundError } from "@/modules/support/services/tech-request";
import { buildPageMetadata } from "@/platform/metadata";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { SectionHeader } from "@/platform/ui/section-header";
import { TextLink } from "@/platform/ui/text-link";
import { BatchReconcile } from "@/modules/support/components/batch-reconcile";
import { BatchMemberEmail } from "@/modules/support/components/batch-member-email";
import { markSentAction, previewReturnAction, applyReturnAction, sendMemberEmailsAction } from "./actions";

export const metadata = buildPageMetadata({
  title: "Epic batch",
  description: "Reconcile a YNHH Epic batch and tell its members.",
});

export default async function EpicBatchPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const actor = await requirePermission("support.manage_requests");

  let batch;
  try {
    batch = await loadBatch(actor.personId, ticketId);
  } catch (err) {
    if (err instanceof SupportNotFoundError) notFound();
    throw err;
  }

  return (
    <div className="space-y-6">
      <div>
        <TextLink href="/support/epic?tab=tracker">Back to the tracker</TextLink>
        <SectionHeader title={batch.description ?? "Epic batch"} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={batch.stage === "DONE" ? "success" : "neutral"}>{batch.stage}</Badge>
          {batch.serviceRequestNumber ? <Badge tone="neutral">{batch.serviceRequestNumber}</Badge> : null}
          {batch.sentAt ? null : <Badge tone="warning">Not yet marked sent</Badge>}
        </div>
      </div>

      {batch.nextAction ? (
        <Alert tone="warning">Next: {batch.nextAction}</Alert>
      ) : null}

      {batch.stage === "GENERATED" ? (
        <Card>
          <SectionHeader title="Send it to YNHH" />
          <p className="text-sm text-muted-foreground">
            Downloading the files does not send them. Attach them to an email to
            helpdesk@ynhh.org, then confirm here so this batch starts its clock.
          </p>
          <form action={markSentAction.bind(null, ticketId)}>
            <button type="submit" className="mt-2">I have sent this to YNHH</button>
          </form>
        </Card>
      ) : null}

      <BatchReconcile
        ticketId={ticketId}
        rows={batch.rows}
        previewAction={previewReturnAction}
        applyAction={applyReturnAction}
      />

      <BatchMemberEmail
        ticketId={ticketId}
        rows={batch.rows}
        sendAction={sendMemberEmailsAction}
      />
    </div>
  );
}
```

- [ ] **Step 3: Write the member-email component with the soft block**

Create `src/modules/support/components/batch-member-email.tsx`. The selection uses `useBulkSelection`, whose `initial` predicate runs at MOUNT only, which is exactly the default-on-cleared behaviour wanted here:

```tsx
"use client";

/**
 * Selects which of a batch's members to tell, and sends.
 *
 * Clearance is a warning, never a block: a row that is not fully cleared shows
 * its missing steps and starts UNCHECKED so sending to them is deliberate. Only
 * a row that genuinely cannot be emailed by anyone (no address on file) is
 * non-selectable, which is why tone="critical" is reserved for that case.
 */

import { useState } from "react";
import type { BatchRow } from "@/modules/support/services/epic-batch";
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Checkbox } from "@/platform/ui/checkbox";
import { Select } from "@/platform/ui/select";
import { SectionHeader } from "@/platform/ui/section-header";
import { ConfirmButton } from "@/platform/ui/confirm-button";

type Props = {
  ticketId: string;
  rows: BatchRow[];
  sendAction: (
    ticketId: string,
    requestIds: string[],
    template: "epic-onboarding" | "epic-activation" | "epic-password-reset"
  ) => Promise<{ sent: number; skipped: Array<{ name: string; reason: string }> }>;
};

export function BatchMemberEmail({ ticketId, rows, sendAction }: Props) {
  const emailable = rows.filter((r) => r.status === "COMPLETED" && r.memberEmailedAt === null);
  // `selectable` excludes a row from selection AND from every count, which is
  // exactly right for someone with no address. `initial` runs at MOUNT only,
  // which is what makes "cleared starts ticked, not-cleared starts unticked"
  // a default rather than a rule the admin cannot override.
  const selection = useBulkSelection({
    rows: emailable,
    idOf: (r) => r.requestId,
    selectable: (r) => r.blockedReason === null,
    initial: (r) => r.blockedReason === null && r.cleared,
  });
  const [template, setTemplate] = useState<"epic-onboarding" | "epic-activation" | "epic-password-reset">("epic-activation");
  const [result, setResult] = useState<{ sent: number; skipped: Array<{ name: string; reason: string }> } | null>(null);
  // Required: with onConfirm (rather than a form submit) ConfirmButton's
  // useFormStatus reports pending:false forever, so the caller's own flag is
  // the only thing that knows the send is in flight.
  const [busy, setBusy] = useState(false);

  if (emailable.length === 0) return null;

  const notCleared = emailable.filter((r) => !r.cleared && r.blockedReason === null).length;

  return (
    <Card>
      <SectionHeader title="Tell the members" />

      {notCleared > 0 ? (
        <Alert tone="warning">
          {notCleared} {notCleared === 1 ? "person is" : "people are"} not fully
          cleared and start unchecked. You can still send to them.
        </Alert>
      ) : null}

      <ul>
        {emailable.map((r) => (
          <li key={r.requestId} className="flex items-center gap-2 py-2">
            <Checkbox
              checked={selection.has(r.requestId)}
              disabled={r.blockedReason !== null}
              onChange={() => selection.toggle(r.requestId)}
              aria-label={`Email ${r.name}`}
            />
            <span className="flex-1">{r.name}</span>
            {r.blockedReason ? (
              <Badge tone="critical">{r.blockedReason}</Badge>
            ) : r.cleared ? null : (
              <Badge tone="warning">Missing: {r.missingLabels.join(", ")}</Badge>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-2">
        <Select value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
          <option value="epic-activation">Activation</option>
          <option value="epic-onboarding">Onboarding</option>
          <option value="epic-password-reset">Password reset</option>
        </Select>
        <ConfirmButton
          disabled={selection.ids.length === 0}
          busy={busy}
          label={`Email ${selection.ids.length} ${selection.ids.length === 1 ? "member" : "members"}`}
          confirmLabel={`Send to ${selection.ids.length}`}
          onConfirm={async () => {
            setBusy(true);
            try {
              setResult(await sendAction(ticketId, [...selection.ids], template));
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>

      {result ? (
        <Alert tone={result.skipped.length > 0 ? "warning" : "success"}>
          Sent {result.sent}.
          {result.skipped.length > 0
            ? ` Skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`
            : ""}
        </Alert>
      ) : null}
    </Card>
  );
}
```

`ConfirmButton` must render as one element across both its states: swapping component types unmounts the focused node and drops keyboard users to `<body>`.

- [ ] **Step 4: Write the reconcile component**

Create `src/modules/support/components/batch-reconcile.tsx` with an upload form calling `previewAction`, a review panel rendering the four `MatchResult` buckets (matched with its `via`, ambiguous with a person picker, unmatched, missing), and an Apply button calling `applyAction` with the confirmed decisions. Per-row Epic ID inputs let an admin fix or add a value before applying. Follow `batch-member-email.tsx` above for the result-panel and Alert conventions.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx eslint src e2e`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/support/epic/batch src/modules/support/components/batch-reconcile.tsx src/modules/support/components/batch-member-email.tsx
git commit -m "feat(epic): a batch page that reconciles YNHH's return and tells the members"
```

---

## Task 14: Link the tracker into the batch page

**Files:**
- Modify: `src/modules/support/components/epic-request-tabs.tsx` (`TrackerTable`)

**Interfaces:**
- Consumes: the route from Task 13.
- Produces: nothing.

- [ ] **Step 1: Add the link and the stage badge**

In each Tracker ticket row header, add:

```tsx
<TextLink href={`/support/epic/batch/${ticket.id}`}>Open batch</TextLink>
```

- [ ] **Step 2: Move the per-request controls**

Remove the per-request Complete, Cancel and three email buttons from the Tracker row, since the batch page now owns them with more room and better guards. Keep the ticket-level `TicketNumberField` and "Mark complete" so the common case still needs no navigation.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npx eslint src e2e
git add src/modules/support/components/epic-request-tabs.tsx
git commit -m "refactor(epic): make the tracker an index into the batch pages"
```

---

## Task 15: The Epic cron

**Files:**
- Create: `src/app/api/cron/epic/route.ts`
- Create: `src/modules/support/services/epic-digest.ts`
- Test: `src/modules/support/services/epic-digest.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond the schema.
- Produces: `EpicDigest`, `buildEpicDigest(now: Date): Promise<EpicDigest>`.

- [ ] **Step 1: Write the failing test**

```ts
describe("buildEpicDigest", () => {
  it("reports a batch generated yesterday and never marked sent", async () => {
    const actor = await createPerson("Admin");
    await prisma.ynhhTicket.create({
      data: {
        submittedById: actor.id, description: "NEW - Sam",
        submittedAt: new Date("2026-09-20T00:00:00Z"), sentAt: null,
      },
    });

    const digest = await buildEpicDigest(new Date("2026-09-22T00:00:00Z"));
    expect(digest.neverSent).toHaveLength(1);
  });

  it("reports a completed request whose member was never told", async () => {
    const actor = await createPerson("Admin");
    const sam = await createPerson("Sam Rivera", { contactEmail: "sam@yale.edu" });
    await prisma.epicRequest.create({
      data: {
        personId: sam.id, kind: "NEW", status: "COMPLETED", requestedById: actor.id,
        completedAt: new Date("2026-09-20T00:00:00Z"), memberEmailedAt: null,
      },
    });

    const digest = await buildEpicDigest(new Date("2026-09-22T00:00:00Z"));
    expect(digest.completedButUntold).toHaveLength(1);
  });

  it("reports a pending deactivation for someone active again", async () => {
    const actor = await createPerson("Admin");
    const sam = await createPerson("Sam Rivera", { status: "ACTIVE" });
    await prisma.epicRequest.create({
      data: { personId: sam.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    const digest = await buildEpicDigest(new Date("2026-09-22T00:00:00Z"));
    expect(digest.strandedDeactivations).toHaveLength(1);
  });

  it("is empty when nothing is stuck", async () => {
    const digest = await buildEpicDigest(new Date("2026-09-22T00:00:00Z"));
    expect(digest.isEmpty).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/support/services/epic-digest.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the digest**

Create `src/modules/support/services/epic-digest.ts` exporting:

```ts
export type EpicDigest = {
  neverSent: Array<{ ticketId: string; description: string | null; days: number }>;
  noServiceRequestNumber: Array<{ ticketId: string; description: string | null; days: number }>;
  stalled: Array<{ ticketId: string; description: string | null; days: number }>;
  completedButUntold: Array<{ requestId: string; personName: string }>;
  agingPending: Array<{ requestId: string; personName: string; days: number }>;
  expiringSoon: Array<{ requestId: string; personName: string; endDate: Date }>;
  strandedDeactivations: Array<{ requestId: string; personName: string }>;
  isEmpty: boolean;
};
```

Thresholds, matching the spec: 24h never sent, 48h no RITM, 5 business days stalled, 24h completed-but-untold, 7 days aging pending, 30 days expiring. `isEmpty` is true when every array is empty.

- [ ] **Step 4: Write the route**

Create `src/app/api/cron/epic/route.ts`, copying the auth and structure of `src/app/api/cron/email/route.ts`: bearer `CRON_SECRET` compared with `timingSafeEqual`, `maxDuration = 300`, each step wrapped so one failure cannot take down the heartbeat. On a non-empty digest, `notify()` the current ITCM directors from `listEpicAuthorizers()`. Always record the heartbeat:

```ts
await setSetting("cron.lastSuccess.epic", new Date().toISOString());
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/support/services/epic-digest.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Document the schedule requirement**

Add to `docs/DEPLOY.md` under the cron section: `/api/cron/epic`, daily at 08:00 ET, bearer `CRON_SECRET`. Note in the PR description that the external scheduler entry must be created by hand, and that `cron.lastSuccess.epic` in the `Setting` table is how to confirm it ran. A cron that is merged but never scheduled is worse than none, because the digest's silence reads as "nothing to report."

- [ ] **Step 7: Commit**

```bash
git add src/app/api/cron/epic src/modules/support/services/epic-digest.ts src/modules/support/services/epic-digest.test.ts docs/DEPLOY.md
git commit -m "feat(epic): a daily digest of every batch and request that is stuck"
```

---

## Task 16: End-to-end coverage

e2e is the only check in this repo that actually server-renders a page, so it is the only thing that catches an RSC-level break on the new route.

**Files:**
- Create: `e2e/epic-batch.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from "@playwright/test";
import { signInAs, seedEpicBatch } from "./helpers";

test("an admin can open a batch and see the soft block", async ({ page }) => {
  const { ticketId } = await seedEpicBatch({
    people: [
      { name: "Dana Wu", contactEmail: "dana@yale.edu", cleared: true, status: "COMPLETED" },
      { name: "Eli Brooks", contactEmail: "eli@yale.edu", cleared: false, status: "COMPLETED" },
    ],
  });
  await signInAs(page, "itcm-director");

  await page.goto(`/support/epic/batch/${ticketId}`);

  await expect(page.getByRole("checkbox", { name: "Email Dana Wu" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Email Eli Brooks" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Email Eli Brooks" })).toBeEnabled();
});

test("a member with no address cannot be selected at all", async ({ page }) => {
  const { ticketId } = await seedEpicBatch({
    people: [{ name: "Grace Lin", contactEmail: null, cleared: true, status: "COMPLETED" }],
  });
  await signInAs(page, "itcm-director");

  await page.goto(`/support/epic/batch/${ticketId}`);

  await expect(page.getByRole("checkbox", { name: "Email Grace Lin" })).toBeDisabled();
  await expect(page.getByText("No email address on file")).toBeVisible();
});
```

Add `seedEpicBatch` to `e2e/helpers.ts` following the existing seed helpers. Do not assert on copy that is likely to change; assert on roles and state.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/epic-batch.spec.ts`
Expected: PASS. The e2e database is separate from the unit-test one; if the run fails on missing tables, apply migrations to it first.

- [ ] **Step 3: Full check and commit**

```bash
npx eslint src e2e && npx vitest run && npx tsc --noEmit
git add e2e/epic-batch.spec.ts e2e/helpers.ts
git commit -m "test(epic): cover the batch page and its clearance soft block end to end"
```

---

## Self-review notes

**Spec coverage.** Every section of the design maps to a task: send gap (4), data model (1), REJECTED call sites (2), derived stage (8), matching (9), apply (11), bulk email (12), soft block (10 + 13), cron (15), surfaces (13 + 14 + 7), review findings (3, 5, 6), testing (every task plus 16).

**Known gaps for the implementer.** Task 13 Step 4 describes the reconcile component rather than giving its full source: it is the largest UI surface and its shape depends on how Steps 1-3 land. Build it last, and mirror the conventions in `batch-member-email.tsx` above. Task 15 Step 3 gives the `EpicDigest` type and the thresholds but not each query; they are mechanical and the tests pin the behaviour.

**Type consistency check.** `BatchRow` (Task 10) is consumed unchanged by Tasks 12 and 13. `BatchRequestCandidate` (Task 9) is produced by `loadBatchCandidates` (Task 10). `MatchResult` (Task 9) is returned by `previewReturnAction` (Task 13). The three template keys are spelled identically in Tasks 12 and 13 and match `EpicTemplateKey` in `epic.ts`.

**Platform APIs verified against source while writing this plan.** Four were wrong on the first pass and are corrected above; if you hit a fifth, trust the source over this document.

- `useBulkSelection` takes a single object `{ rows, idOf, selectable?, initial? }` and returns `{ ids, has, toggle, setMany, toggleAll, allSelected, someSelected, allOf, someOf, clear }`. There is no `selected` or `isSelected`. `selectable` excludes a row from selection and from every count, which is what the no-address case wants.
- `ConfirmButton` takes a `label` prop, not children, and with `onConfirm` (rather than a form submit) its internal `useFormStatus` reports `pending: false` forever, so the caller MUST pass its own `busy` flag.
- `requirePermission` returns a `PersonSession` keyed `personId`, not `id`. Test fixtures built by `createPerson` are Person rows and do use `.id`.
- `ClearanceSummary.missing` is `OnboardingTaskKey[]`, raw keys like `"hipaa"`, not display strings. Map them through `loadEffectiveSteps(termId)` as `epic-rollup.ts:249` does, or the badge renders lowercase keys.

**Still unverified, so check before copying:** `Checkbox`'s exact prop name for its change handler, `setSetting`'s signature in `src/platform/settings/service.ts:203`, and `buildPageMetadata`'s required fields.
