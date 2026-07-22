# ITCM Term Epic Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ITCM one screen per term that lists every roster member needing an Epic request, split into NEW / MODIFY / RENEW with onboarding-clearance flags, each group submittable as one YNHH batch that produces the PDF, spreadsheet, and cover email.

**Architecture:** Classification is derived live from the roster on every page load by a new loader (`loadTermEpicRollup`), never materialized ahead of time; `EpicRequest` rows are written only when ITCM submits a batch, through the existing `/api/support/epic/generate` route. Existing open PENDING requests raised by promotion are adopted onto the batch ticket rather than conflicting with it.

**Tech Stack:** Next.js App Router (RSC + client components), Prisma/PostgreSQL, Vitest, Tailwind via `@/platform/ui` primitives.

## Global Constraints

- **No em-dash characters (U+2014) anywhere under `src/`.** A custom eslint rule (`local/no-em-dash`) fails the build on one, in code *and* comments *and* strings. Use a comma, colon, parentheses, or hyphen.
- **No styled raw controls** in `src/app/**/*.tsx` or `src/modules/**/*.tsx`. Use `Button`, `Input`, `Select`, `Textarea`, `Checkbox` from `@/platform/ui`. A raw `<button className=...>` is an eslint error.
- **Modules never import other modules** for ids in `MODULE_IDS` (`schedule`, `my-info`, `volunteers`, `admin`, `recruitment`, `triage`, `referrals`, `patient-trackers`). `src/modules/support` and `src/modules/onboarding` are NOT in that list, so `support` importing `onboarding` and `recruitment` is legal and already done elsewhere. `src/platform/**` must never import `src/modules/**`.
- **Run `npm run lint` over the whole repo before pushing.** Typecheck and tests do not catch the eslint boundary and em-dash rules.
- Test database is the throwaway Postgres on port 5434, never Neon. `npm run test:prepare` once, then `npm test`.
- Tests use Vitest with `beforeEach(resetDb)` from `@/platform/test/db`. `fileParallelism` is off; integration tests share one database.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `src/modules/support/epic-request-types.ts` | The `EpicRequestType` union plus the two pure mappings (`epicKindForRequestType`, `requestTypeForGroup`). Module root, not `services/`, so client components can import it without pulling in `pdf-lib`. |
| `src/modules/support/epic-request-types.test.ts` | Pure tests for both mappings. |
| `src/modules/support/services/epic-rollup-classify.ts` | Pure classification: `resolveRollupNeed`, `classifyEpicKind`. No IO. |
| `src/modules/support/services/epic-rollup-classify.test.ts` | Pure unit tests, no database. |
| `src/modules/support/services/epic-rollup.ts` | `loadTermEpicRollup(termId)` and `listBatchTermOptions()`, plus the row/group types. All IO, batched. |
| `src/modules/support/services/epic-rollup.test.ts` | Database tests for the loader. |
| `src/modules/support/components/epic-generate-client.ts` | Browser-side generation helper shared by the Generate tab and the Term batch tab: `EMAIL_SUBJECTS`, `runEpicGeneration`. |
| `src/modules/support/components/term-batch-tab.tsx` | The Term batch UI. |
| `src/platform/ui/term-switcher.tsx` | Moved verbatim from `src/modules/schedule/components/term-switcher.tsx` so both the schedule builder and the Term batch tab can use it without a cross-module import. |

**Modify:**

| Path | Change |
| --- | --- |
| `src/modules/support/services/itcm-pdf.ts` | Take `RequestType` from the new shared module; add the `bulk_renew` `SECTION_IX` entry. |
| `src/app/api/support/epic/generate/route.ts` | Add `bulk_renew` to the filename/email/label maps and both switches; use `epicKindForRequestType`; accept an optional `termId`. |
| `src/modules/support/services/itcm.ts` | `submitEpicRequests` adopts a same-kind un-ticketed PENDING request instead of conflicting. |
| `src/modules/support/services/itcm.test.ts` | Replace the duplicate-open-request test with adopt / conflict cases. |
| `src/modules/support/components/epic-request-form.tsx` | Use the shared type and generation helper; offer Renew for bulk. |
| `src/modules/support/components/epic-request-tabs.tsx` | Add the `term-batch` tab. |
| `src/app/(app)/support/epic/page.tsx` | Resolve the working term, load the roll-up and term options, pass them down. |
| `src/app/(app)/schedule/builder/page.tsx` | Update the `TermSwitcher` import path. |

**Delete:**

- `src/modules/schedule/components/term-switcher.tsx` (moved to platform).

---

### Task 1: Shared request types, `bulk_renew`, and the `bulk_mod` kind fix

`bulk_mod` is labelled "Modify / Renew - Bulk" and `route.ts` maps it to `EpicRequestKind.RENEW`, so a modify batch is recorded as a renewal today. The Term batch tab needs three distinct bulk types that track honestly, so add `bulk_renew` and re-point `bulk_mod` to `MODIFY`. The mapping moves into a pure module so it is testable without auth or `pdf-lib`.

**Files:**
- Create: `src/modules/support/epic-request-types.ts`
- Test: `src/modules/support/epic-request-types.test.ts`
- Modify: `src/modules/support/services/itcm-pdf.ts:58-85`
- Modify: `src/app/api/support/epic/generate/route.ts:43-84`, `:193-200`, `:325-366`, `:427-436`
- Modify: `src/modules/support/components/epic-request-form.tsx:36-54`, `:257-296`

**Interfaces:**
- Produces: `EpicRequestType` (8-member string union), `epicKindForRequestType(t: EpicRequestType): EpicRequestKind`, `requestTypeForGroup(kind: "NEW" | "MODIFY" | "RENEW", count: number): EpicRequestType`. Tasks 6 and 7 import all three.

- [ ] **Step 1: Write the failing test**

Create `src/modules/support/epic-request-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  epicKindForRequestType,
  requestTypeForGroup,
  type EpicRequestType,
} from "./epic-request-types";

describe("epicKindForRequestType", () => {
  it("maps the new types to NEW", () => {
    expect(epicKindForRequestType("new_individual")).toBe("NEW");
    expect(epicKindForRequestType("bulk_new")).toBe("NEW");
  });

  it("maps both modify types to MODIFY, including bulk_mod", () => {
    expect(epicKindForRequestType("mod_individual")).toBe("MODIFY");
    // Regression: bulk_mod used to be tracked as RENEW, so a modify batch was
    // recorded as a renewal.
    expect(epicKindForRequestType("bulk_mod")).toBe("MODIFY");
  });

  it("maps both renew types to RENEW", () => {
    expect(epicKindForRequestType("renew_individual")).toBe("RENEW");
    expect(epicKindForRequestType("bulk_renew")).toBe("RENEW");
  });

  it("maps both deactivate types to DEACTIVATE", () => {
    expect(epicKindForRequestType("deactivate_individual")).toBe("DEACTIVATE");
    expect(epicKindForRequestType("bulk_deactivate")).toBe("DEACTIVATE");
  });

  it("covers every request type", () => {
    const all: EpicRequestType[] = [
      "new_individual", "mod_individual", "renew_individual",
      "bulk_new", "bulk_mod", "bulk_renew",
      "deactivate_individual", "bulk_deactivate",
    ];
    for (const t of all) expect(epicKindForRequestType(t)).toBeTruthy();
  });
});

describe("requestTypeForGroup", () => {
  it("uses the individual type for a single person", () => {
    expect(requestTypeForGroup("NEW", 1)).toBe("new_individual");
    expect(requestTypeForGroup("MODIFY", 1)).toBe("mod_individual");
    expect(requestTypeForGroup("RENEW", 1)).toBe("renew_individual");
  });

  it("uses the bulk type for more than one person", () => {
    expect(requestTypeForGroup("NEW", 2)).toBe("bulk_new");
    expect(requestTypeForGroup("MODIFY", 12)).toBe("bulk_mod");
    expect(requestTypeForGroup("RENEW", 41)).toBe("bulk_renew");
  });

  it("round-trips back to the group kind it was built from", () => {
    for (const kind of ["NEW", "MODIFY", "RENEW"] as const) {
      for (const count of [1, 5]) {
        expect(epicKindForRequestType(requestTypeForGroup(kind, count))).toBe(kind);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/support/epic-request-types.test.ts`
Expected: FAIL, "Failed to resolve import ./epic-request-types".

- [ ] **Step 3: Write the module**

Create `src/modules/support/epic-request-types.ts`:

```ts
import type { EpicRequestKind } from "@prisma/client";

/**
 * The YNHH service-request flavours the Epic generator can produce. Individual
 * types apply to exactly one person; bulk_* types carry a spreadsheet.
 *
 * This lives at the support module root rather than under services/ so client
 * components can import the mappings without pulling in pdf-lib (which
 * itcm-pdf.ts, the previous home of this union, depends on).
 */
export type EpicRequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "bulk_renew"
  | "deactivate_individual"
  | "bulk_deactivate";

/**
 * The EpicRequest kind a generated request is tracked as.
 *
 * bulk_mod maps to MODIFY, not RENEW. It used to map to RENEW because the single
 * "Modify / Renew - Bulk" option covered both; bulk_renew now covers renewals, so
 * a modify batch is recorded as a modification.
 */
export function epicKindForRequestType(t: EpicRequestType): EpicRequestKind {
  switch (t) {
    case "new_individual":
    case "bulk_new":
      return "NEW";
    case "mod_individual":
    case "bulk_mod":
      return "MODIFY";
    case "renew_individual":
    case "bulk_renew":
      return "RENEW";
    case "deactivate_individual":
    case "bulk_deactivate":
      return "DEACTIVATE";
  }
}

/**
 * The request type a Term batch group submits: the individual variant for one
 * person, the bulk variant (with spreadsheet) above one. The generate route
 * rejects a multi-person individual request, so the count must decide this.
 */
export function requestTypeForGroup(
  kind: "NEW" | "MODIFY" | "RENEW",
  count: number
): EpicRequestType {
  if (kind === "NEW") return count === 1 ? "new_individual" : "bulk_new";
  if (kind === "MODIFY") return count === 1 ? "mod_individual" : "bulk_mod";
  return count === 1 ? "renew_individual" : "bulk_renew";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/support/epic-request-types.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point `itcm-pdf.ts` at the shared union and add the bulk_renew narrative**

In `src/modules/support/services/itcm-pdf.ts`, replace the local union (currently lines 58-65):

```ts
export type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "deactivate_individual"
  | "bulk_deactivate";
```

with a re-export of the shared one (existing importers that do `import type { RequestType } from "./itcm-pdf"` keep working):

```ts
import type { EpicRequestType } from "@/modules/support/epic-request-types";

export type RequestType = EpicRequestType;
```

Then add a `bulk_renew` entry to `SECTION_IX`, immediately after the `bulk_mod` entry. A renewal is a MOD/REACT request at YNHH, so the narrative is identical to `bulk_mod`:

```ts
  bulk_renew:
    "These individuals already have Epic accounts, but they require extended access to the department YM HAVEN FREE CLINIC. Their accounts should also have similar functions of the aforementioned Epic ID to mirror within the department YM HAVEN FREE CLINIC. Please see the attached spreadsheet for the multiple user information.",
```

No change is needed to `isNew` or `isDeactivate` inside `generatePdf`: `bulk_renew` is neither, so it takes exactly the branches `bulk_mod` takes today.

- [ ] **Step 6: Add bulk_renew to the route and use the shared kind mapping**

In `src/app/api/support/epic/generate/route.ts`:

Add to the `EMAIL_BODIES` map, after the `bulk_new` entry:

```ts
  bulk_renew: ({ endDate, authorizerName, userCount }) =>
    `Hello,\nCould we please renew Epic access for the users in the attached spreadsheet? They already have Epic accounts in the department "YM HAVEN FREE CLINIC" and need their access extended until ${endDate}.\nThey will need the abilities of the corresponding Epic ID to mirror (included in the spreadsheet), in the department YM HAVEN FREE CLINIC.\nThey neither have YNHH privileges nor are requesting them.\nI've attached a spreadsheet containing ${userCount} users and the completed pdf request form. Please feel free to contact me with any questions or if you require more information. Thank you very much!\n\nBest,\n${authorizerName}`,
```

Add to `PDF_FILENAMES` (a renewal uses the same MOD_REACT form as a modification):

```ts
  bulk_renew: (i, d) => `${i} ${d} Multiple Users MOD_REACT Service Request Form_V5.5.pdf`,
```

In `REQUEST_TYPE_LABELS`, change the `bulk_mod` label and add `bulk_renew`:

```ts
  bulk_mod: "Modify - Bulk",
  bulk_renew: "Renew - Bulk",
```

Add a case to the `pdfFilename` switch, after the `bulk_mod` case:

```ts
    case "bulk_renew": pdfFilename = PDF_FILENAMES.bulk_renew(initials, dateStr); break;
```

Add a case to the `emailBody` switch, after the `bulk_mod` case:

```ts
    case "bulk_renew": emailBody = EMAIL_BODIES.bulk_renew(emailBodyArgs); break;
```

Replace the inline kind ternary (currently lines 427-436, the `const epicKind = ...` block and its comment) with the shared mapping:

```ts
    // kind comes from the shared mapping so the Generate tab and the Term batch
    // tab can never disagree about what a request type is tracked as. The cast is
    // safe: this branch only runs when isDeactivate is false, and the mapping
    // returns DEACTIVATE only for the two deactivate types.
    const epicKind = epicKindForRequestType(requestType) as "NEW" | "MODIFY" | "RENEW";
```

Add the import at the top of the file, next to the other `@/modules/support` imports:

```ts
import { epicKindForRequestType } from "@/modules/support/epic-request-types";
```

- [ ] **Step 7: Offer Renew for bulk in the Generate tab**

In `src/modules/support/components/epic-request-form.tsx`:

Replace the local `RequestType` union (currently lines 36-43) with the shared type:

```ts
import type { EpicRequestType as RequestType } from "@/modules/support/epic-request-types";
```

Add the `bulk_renew` subject to `EMAIL_SUBJECTS`, and make `bulk_mod`'s subject modify-only now that renewals have their own type:

```ts
  bulk_mod: (i, d) => `[HAVEN] Modify Epic Access for Multiple Users ${d} ${i}`,
  bulk_renew: (i, d) => `[HAVEN] Renew Epic Access for Multiple Users ${d} ${i}`,
```

In the "Request type" `Select` onChange (currently line 263), delete the `bulk_renew` collapse so a bulk renewal stays a bulk renewal:

```ts
              onChange={(e) => {
                const base = e.target.value as "new" | "mod" | "renew" | "deactivate";
                const raw = isBulk ? `bulk_${base}` : `${base}_individual`;
                setRequestType(raw as RequestType);
                setSelectedPeopleIds(new Set());
                setSelectedPeopleMap(new Map());
                setError(null);
                setTrackingWarning(null);
              }}
```

In the same `Select`, drop the `!isBulk` guard on the Renew option (currently line 273):

```tsx
              <option value="renew">Renew</option>
```

In the "Scope" `Select` onChange (currently line 285), delete the matching collapse:

```ts
              onChange={(e) => {
                const bulk = e.target.value === "bulk";
                const base = requestType.replace("_individual", "").replace("bulk_", "");
                const raw = bulk ? `bulk_${base}` : `${base}_individual`;
                setRequestType(raw as RequestType);
                setSelectedPeopleIds(new Set());
                setSelectedPeopleMap(new Map());
                setError(null);
                setTrackingWarning(null);
              }}
```

- [ ] **Step 8: Typecheck, lint, and run the support tests**

Run: `npm run typecheck`
Expected: no errors. If `Record<RequestType, ...>` complains about a missing `bulk_renew` key anywhere, add the entry there too.

Run: `npx eslint src/modules/support src/app/api/support`
Expected: no errors.

Run: `npx vitest run src/modules/support`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/support/epic-request-types.ts src/modules/support/epic-request-types.test.ts \
        src/modules/support/services/itcm-pdf.ts src/app/api/support/epic/generate/route.ts \
        src/modules/support/components/epic-request-form.tsx
git commit -m "feat(support): add bulk_renew and track bulk_mod as MODIFY"
```

---

### Task 2: `submitEpicRequests` adopts a matching pending request

`promotion.ts` raises a `PENDING NEW` request for every promoted volunteer who needs Epic. `submitEpicRequests` currently throws `SupportConflictError` on any open request, so submitting those people skips tracking entirely (the route returns a `trackingWarning`) and leaves the original row orphaned as PENDING while the batch goes to YNHH untracked. Adopt instead, mirroring what `reconcileDeactivationRequests` already does on the DEACTIVATE path.

**Files:**
- Modify: `src/modules/support/services/itcm.ts:604-682`
- Test: `src/modules/support/services/itcm.test.ts:352-374`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `submitEpicRequests` keeps its signature `(actorPersonId: string, kind: "NEW" | "MODIFY" | "RENEW", ticketDescription: string, requests: { personId: string; mirrorEpicId: string | null }[]) => Promise<YnhhTicket>`. Only its conflict behaviour changes.

- [ ] **Step 1: Write the failing tests**

In `src/modules/support/services/itcm.test.ts`, replace the whole existing `it("rejects a duplicate open request and creates no ticket", ...)` block (lines 352-374) with these four tests:

```ts
  it("adopts a same-kind un-ticketed PENDING request instead of creating a second one", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice");
    // Exactly what promotion raises for a promoted volunteer who needs Epic.
    const promoted = await prisma.epicRequest.create({
      data: { personId: person.id, kind: "NEW", status: "PENDING", requestedById: actor.id },
    });

    const ticket = await submitEpicRequests(actor.id, "NEW", "New - Individual - Alice", [
      { personId: person.id, mirrorEpicId: "MIRROR-A" },
    ]);

    // The promotion row itself moved onto the ticket: no second request exists.
    const all = await prisma.epicRequest.findMany({ where: { personId: person.id } });
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(promoted.id);
    expect(all[0].status).toBe("SUBMITTED");
    expect(all[0].ticketId).toBe(ticket.id);
    expect(all[0].mirrorEpicId).toBe("MIRROR-A");
  });

  it("rejects an open request of a different kind and creates no ticket", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice", { epicId: "E1" });
    await prisma.epicRequest.create({
      data: { personId: person.id, kind: "MODIFY", status: "PENDING", requestedById: actor.id },
    });

    const err = await submitEpicRequests(actor.id, "RENEW", "Renew - Individual - Alice", [
      { personId: person.id, mirrorEpicId: null },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(SupportConflictError);
    expect((err as SupportConflictError).personNames).toEqual(["Alice"]);

    expect(await prisma.ynhhTicket.count()).toBe(0);
    expect(await prisma.epicRequest.count({ where: { personId: person.id } })).toBe(1);
  });

  it("rejects a request already submitted onto another ticket", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const person = await createPerson("Alice");
    const oldTicket = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, status: "OPEN" },
    });
    await prisma.epicRequest.create({
      data: {
        personId: person.id, kind: "NEW", status: "SUBMITTED",
        requestedById: actor.id, ticketId: oldTicket.id,
      },
    });

    const err = await submitEpicRequests(actor.id, "NEW", "New - Individual - Alice", [
      { personId: person.id, mirrorEpicId: null },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(SupportConflictError);

    // Only the original ticket survives; the request stays on it.
    expect(await prisma.ynhhTicket.count()).toBe(1);
    const reqs = await prisma.epicRequest.findMany({ where: { personId: person.id } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].ticketId).toBe(oldTicket.id);
  });

  it("adopts one person while creating a fresh request for another in the same batch", async () => {
    const actor = await createPerson("Manager");
    await grantPermission(actor.id, "support.manage_requests");
    const a = await createPerson("Alice");
    const b = await createPerson("Bob");
    const promoted = await prisma.epicRequest.create({
      data: { personId: a.id, kind: "NEW", status: "PENDING", requestedById: actor.id },
    });

    const ticket = await submitEpicRequests(actor.id, "NEW", "New - Bulk - Alice, Bob", [
      { personId: a.id, mirrorEpicId: null },
      { personId: b.id, mirrorEpicId: null },
    ]);

    const reqs = await prisma.epicRequest.findMany({ where: { ticketId: ticket.id } });
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.status === "SUBMITTED" && r.kind === "NEW")).toBe(true);
    expect(reqs.map((r) => r.id)).toContain(promoted.id);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/support/services/itcm.test.ts -t "adopts a same-kind"`
Expected: FAIL with `SupportConflictError: An open Epic request already exists for: Alice`.

- [ ] **Step 3: Rewrite the open-request handling**

In `src/modules/support/services/itcm.ts`, replace the doc comment above `submitEpicRequests` (lines 604-623) with:

```ts
/**
 * Creates the YNHH ticket and its SUBMITTED access-granting (NEW/MODIFY/RENEW)
 * Epic requests for a batch, enforcing the same invariants createEpicRequest
 * guarantees so this bulk/PDF path cannot manufacture a NEW request for someone
 * who already has an Epic ID.
 *
 * Validation and all writes run in one transaction, so any violation throws
 * before the ticket is committed (no orphan ticket, no partially-created batch):
 *   - every person must still exist and be ACTIVE (SupportNotFoundError /
 *     SupportStateError);
 *   - NEW requires no epicId, MODIFY/RENEW requires an epicId (SupportStateError).
 *
 * Open-request handling: an existing PENDING request of the SAME kind that is not
 * yet on a ticket is ADOPTED onto this ticket rather than rejected. That row is
 * exactly what this batch is submitting (promotion raises one for every volunteer
 * who needs Epic), and rejecting it used to strand it as an orphan while the batch
 * went to YNHH untracked. The claim is an atomic updateMany scoped to
 * status PENDING + ticketId null, so a concurrent submit from the other surface
 * matches zero rows and throws instead of re-pointing a request already claimed.
 *
 * Anything else is a real conflict a human must resolve, and raises
 * SupportConflictError naming the people: a request of a DIFFERENT kind, or one
 * already SUBMITTED onto a ticket.
 *
 * Trusts its caller for permissions: the generate route gates on
 * support.manage_requests. Returns the created ticket.
 */
```

Then replace the body from the `const open = await tx.epicRequest.findMany(...)` block through `return ticket;` (lines 653-681) with:

```ts
    const open = await tx.epicRequest.findMany({
      where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      include: { person: { select: { name: true } } },
    });

    // Partition open requests into ones this batch can absorb and ones it cannot.
    const adoptable = new Map<string, string>(); // personId -> requestId
    const conflicting: string[] = [];
    for (const r of open) {
      if (r.status === "PENDING" && r.ticketId === null && r.kind === kind) {
        adoptable.set(r.personId, r.id);
      } else {
        conflicting.push(r.person.name);
      }
    }
    if (conflicting.length > 0) {
      const uniqueNames = [...new Set(conflicting)];
      throw new SupportConflictError(
        `An open Epic request already exists for: ${uniqueNames.join(", ")}. Cancel or complete it in the Tracker before submitting another.`,
        uniqueNames
      );
    }

    const ticket = await tx.ynhhTicket.create({
      data: { submittedById: actorPersonId, description: ticketDescription, status: "OPEN" },
    });

    for (const r of requests) {
      const existingId = adoptable.get(r.personId);
      if (existingId) {
        const claimed = await tx.epicRequest.updateMany({
          where: { id: existingId, status: "PENDING", ticketId: null },
          data: { status: "SUBMITTED", ticketId: ticket.id, mirrorEpicId: r.mirrorEpicId },
        });
        if (claimed.count !== 1) {
          throw new SupportStateError(
            "One or more of these requests were just submitted by a concurrent action. Refresh and try again."
          );
        }
      } else {
        await tx.epicRequest.create({
          data: {
            personId: r.personId,
            kind,
            status: "SUBMITTED",
            mirrorEpicId: r.mirrorEpicId,
            requestedById: actorPersonId,
            ticketId: ticket.id,
          },
        });
      }
    }

    return ticket;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/support/services/itcm.test.ts`
Expected: PASS, including the pre-existing happy-path, non-ACTIVE-person, wrong-kind, and missing-person tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/itcm.ts src/modules/support/services/itcm.test.ts
git commit -m "fix(support): adopt matching pending Epic requests into a batch ticket"
```

---

### Task 3: Optional `termId` on the generate route

The route resolves the term with `getActiveTerm()` for its membership lookup and its `findMirrorPerson` calls. The Term batch tab can prepare a batch for a PLANNING term before it goes active, so the route must accept the target term.

**Files:**
- Modify: `src/app/api/support/epic/generate/route.ts:193-200`, `:257-278`

**Interfaces:**
- Produces: the POST body gains an optional `termId?: string`. Task 7 sends it.

- [ ] **Step 1: Add `termId` to the body type and destructure it**

In `src/app/api/support/epic/generate/route.ts`, extend the body type:

```ts
  const body = await req.json() as {
    requestType: RequestType;
    authorizerId: string;
    personIds: string[];
    endDate: string;
    /** Target term. Omitted by the Generate tab, which always means the active term. */
    termId?: string;
  };

  const { requestType, authorizerId, personIds, endDate, termId } = body;
```

- [ ] **Step 2: Resolve the target term instead of always the active term**

Replace the `const activeTerm = await getActiveTerm();` line and its comment (currently lines 257-258) with:

```ts
  // Resolve the term this batch targets once and reuse it for the membership
  // lookup and every mirror lookup. The Term batch tab prepares a batch for a
  // term before it goes active, so honour an explicit termId; the Generate tab
  // sends none and gets the active term.
  const targetTerm = termId
    ? await prisma.term.findUnique({ where: { id: termId } })
    : await getActiveTerm();
```

Then rename the two `activeTerm` references in the mirror block below it:

```ts
  const mirrorByPersonId = new Map<string, { name: string; epicId: string } | null>();
  if (targetTerm) {
    const memberships = await prisma.termMembership.findMany({
      where: {
        personId: { in: people.map((p) => p.id) },
        termId: targetTerm.id,
        status: "ACTIVE",
      },
    });
    for (const m of memberships) {
      const mirror = await findMirrorPerson(m.departmentId, m.kind, {
        excludePersonIds: people.map((p) => p.id),
        termId: targetTerm.id,
      });
      mirrorByPersonId.set(m.personId, mirror);
    }
  }
```

Leave `listEpicAuthorizers()` alone: the person signing the YNHH form is whoever holds the ITCM director seat now, regardless of which term the batch is for.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck`
Expected: no errors. If any `activeTerm` reference remains, the compiler names the line.

Run: `npx eslint src/app/api/support/epic/generate/route.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/support/epic/generate/route.ts
git commit -m "feat(support): let the Epic generate route target a specific term"
```

---

### Task 4: Pure roll-up classifier

Decides, with no database access, whether a roster member needs an Epic request and which kind. Kept separate from the loader so every branch is testable without fixtures.

**Files:**
- Create: `src/modules/support/services/epic-rollup-classify.ts`
- Test: `src/modules/support/services/epic-rollup-classify.test.ts`

**Interfaces:**
- Consumes: `epicRequirementFor`, `resolveEpicNeeded` from `@/modules/recruitment/contract/epic-requirement`.
- Produces: `RollupMembership`, `RollupNeed`, `resolveRollupNeed(memberships, opts)`, `classifyEpicKind(input)`, `RollupGroupKind`. Task 5 imports all of them.

- [ ] **Step 1: Write the failing test**

Create `src/modules/support/services/epic-rollup-classify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  classifyEpicKind,
  resolveRollupNeed,
  type RollupMembership,
} from "./epic-rollup-classify";

function membership(over: Partial<RollupMembership> = {}): RollupMembership {
  return {
    departmentId: "d1",
    kind: "VOLUNTEER",
    requiresEpicDirector: "NONE",
    requiresEpicVolunteer: "NONE",
    ...over,
  };
}

describe("resolveRollupNeed", () => {
  it("needs Epic when any membership's department requires it for ALL", () => {
    const m = [membership({ requiresEpicVolunteer: "ALL" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("reads the director column for a director membership", () => {
    const m = [membership({ kind: "DIRECTOR", requiresEpicDirector: "ALL", requiresEpicVolunteer: "NONE" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("does not need Epic when every department requires NONE", () => {
    const m = [membership(), membership({ departmentId: "d2" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: true, hasEpicId: true }))
      .toEqual({ needed: false, optional: false });
  });

  it("needs Epic when one of several departments requires ALL", () => {
    const m = [membership(), membership({ departmentId: "d2", requiresEpicVolunteer: "ALL" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("treats SOME as decided when the onboarding contract said Epic was needed", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: true, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("treats SOME as decided when the person already has an Epic ID", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: true }))
      .toEqual({ needed: true, optional: false });
  });

  it("marks SOME with no signal as optional rather than dropping the person", () => {
    const m = [membership({ requiresEpicVolunteer: "SOME" })];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: true });
  });

  it("prefers ALL over SOME when the person holds both", () => {
    const m = [
      membership({ requiresEpicVolunteer: "SOME" }),
      membership({ departmentId: "d2", requiresEpicVolunteer: "ALL" }),
    ];
    expect(resolveRollupNeed(m, { contractEpicNeeded: false, hasEpicId: false }))
      .toEqual({ needed: true, optional: false });
  });

  it("does not need Epic with no memberships at all", () => {
    expect(resolveRollupNeed([], { contractEpicNeeded: true, hasEpicId: true }))
      .toEqual({ needed: false, optional: false });
  });
});

describe("classifyEpicKind", () => {
  it("is NEW with no Epic ID", () => {
    expect(classifyEpicKind({ hasEpicId: false, termDepartmentIds: ["a"], priorDepartmentIds: ["a"] }))
      .toBe("NEW");
  });

  it("is NEW with no Epic ID even for a first-time member", () => {
    expect(classifyEpicKind({ hasEpicId: false, termDepartmentIds: ["a"], priorDepartmentIds: null }))
      .toBe("NEW");
  });

  it("is MODIFY for an existing Epic ID with no prior HAVEN term", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: null }))
      .toBe("MODIFY");
  });

  it("is MODIFY when a department was added", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a", "b"], priorDepartmentIds: ["a"] }))
      .toBe("MODIFY");
  });

  it("is MODIFY when a department was dropped", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: ["a", "b"] }))
      .toBe("MODIFY");
  });

  it("is MODIFY when the department was swapped", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["b"], priorDepartmentIds: ["a"] }))
      .toBe("MODIFY");
  });

  it("is RENEW when the department set is unchanged", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["a"], priorDepartmentIds: ["a"] }))
      .toBe("RENEW");
  });

  it("is RENEW when the same departments are listed in a different order", () => {
    expect(classifyEpicKind({ hasEpicId: true, termDepartmentIds: ["b", "a"], priorDepartmentIds: ["a", "b"] }))
      .toBe("RENEW");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/support/services/epic-rollup-classify.test.ts`
Expected: FAIL, "Failed to resolve import ./epic-rollup-classify".

- [ ] **Step 3: Write the classifier**

Create `src/modules/support/services/epic-rollup-classify.ts`:

```ts
import type { EpicRequirement, Track } from "@prisma/client";
import {
  epicRequirementFor,
  resolveEpicNeeded,
} from "@/modules/recruitment/contract/epic-requirement";

/** The three access-granting groups the term roll-up splits people into. */
export type RollupGroupKind = "NEW" | "MODIFY" | "RENEW";

/** One ACTIVE membership in the target term, flattened with its department's
 *  Epic requirement columns so classification needs no further lookups. */
export type RollupMembership = {
  departmentId: string;
  kind: Track;
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

export type RollupNeed = {
  /** Whether this person belongs on the roll-up at all. */
  needed: boolean;
  /** True when the only signal is a SOME department with nothing to decide it:
   *  the person is shown but starts unchecked so ITCM opts them in explicitly. */
  optional: boolean;
};

/**
 * Whether a roster member needs an Epic request this term.
 *
 * ALL from any department decides it outright. SOME is decided by the person's
 * onboarding contract for this term, or by their already having an Epic ID (they
 * were provisioned before, so the answer was yes). A SOME department with neither
 * signal yields needed with optional set, rather than dropping the person: a
 * roster carry-forward has no contract, and silently omitting them would hide
 * someone who does need access.
 */
export function resolveRollupNeed(
  memberships: RollupMembership[],
  opts: { contractEpicNeeded: boolean; hasEpicId: boolean }
): RollupNeed {
  const requirements = memberships.map((m) =>
    epicRequirementFor(
      {
        requiresEpicDirector: m.requiresEpicDirector,
        requiresEpicVolunteer: m.requiresEpicVolunteer,
      },
      m.kind
    )
  );
  if (requirements.some((r) => r === "ALL")) return { needed: true, optional: false };
  if (!requirements.some((r) => r === "SOME")) return { needed: false, optional: false };

  const selfReported = opts.contractEpicNeeded || opts.hasEpicId;
  return { needed: true, optional: !resolveEpicNeeded("SOME", selfReported) };
}

/**
 * Which kind of request a roster member needs.
 *
 * No Epic ID means a brand new account. An existing Epic ID with no prior HAVEN
 * term means an account that exists at YNHH but has never carried the
 * YM HAVEN FREE CLINIC department, which is a MODIFY. Otherwise the department
 * set decides: any change (added, dropped, or swapped) is a MODIFY, an identical
 * set is a straight RENEW for the new term.
 *
 * priorDepartmentIds is null when the person held no ACTIVE membership in any
 * earlier term. That covers first-time members and, deliberately, people who were
 * offboarded (offboarding flips ALL their memberships to REMOVED, so their history
 * reads as absent). A returning offboarded member had their Epic access
 * deactivated on the way out, so MODIFY, which YNHH reads as reactivate-and-extend,
 * is the correct request for them.
 *
 * Comparison is on department ids only, not on Track: a volunteer promoted to
 * director in the same department is a RENEW.
 */
export function classifyEpicKind(input: {
  hasEpicId: boolean;
  termDepartmentIds: string[];
  priorDepartmentIds: string[] | null;
}): RollupGroupKind {
  if (!input.hasEpicId) return "NEW";
  if (input.priorDepartmentIds === null) return "MODIFY";

  const prior = new Set(input.priorDepartmentIds);
  const current = new Set(input.termDepartmentIds);
  if (current.size !== prior.size) return "MODIFY";
  for (const id of current) {
    if (!prior.has(id)) return "MODIFY";
  }
  return "RENEW";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/support/services/epic-rollup-classify.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/support/services/epic-rollup-classify.ts src/modules/support/services/epic-rollup-classify.test.ts
git commit -m "feat(support): add the pure Epic roll-up classifier"
```

---

### Task 5: `loadTermEpicRollup`

The batched loader that turns a term id into three groups of rows with clearance, existing-request, and blocked state attached.

**Files:**
- Create: `src/modules/support/services/epic-rollup.ts`
- Test: `src/modules/support/services/epic-rollup.test.ts`

**Interfaces:**
- Consumes: `classifyEpicKind`, `resolveRollupNeed`, `RollupMembership`, `RollupGroupKind` from Task 4. `loadClearanceMap` from `@/modules/onboarding/services/clearance`. `loadEffectiveSteps` from `@/modules/onboarding/services/step-config`. `SupportNotFoundError` from `./tech-request`. `buildTermOptions` from `@/platform/terms/term-options`.
- Produces: `EpicRollupRow`, `EpicRollup`, `loadTermEpicRollup(termId: string): Promise<EpicRollup>`, `listBatchTermOptions(): Promise<TermOption[]>`. Task 7 imports all of them.

- [ ] **Step 1: Write the failing test**

Create `src/modules/support/services/epic-rollup.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { loadTermEpicRollup } from "./epic-rollup";
import { SupportNotFoundError } from "./tech-request";

async function makeTerm(code: string, startYear: number) {
  return prisma.term.create({
    data: {
      code,
      name: code,
      startDate: new Date(`${startYear}-01-01T00:00:00Z`),
      endDate: new Date(`${startYear}-06-01T00:00:00Z`),
      status: "ACTIVE",
    },
  });
}

async function makeDept(code: string, requiresEpicVolunteer: "ALL" | "SOME" | "NONE") {
  return prisma.department.create({
    data: { code, name: code, requiresEpicVolunteer, requiresEpicDirector: "NONE" },
  });
}

async function makePerson(name: string, opts: { epicId?: string; status?: "ACTIVE" | "OFFBOARDED" } = {}) {
  return prisma.person.create({
    data: { name, epicId: opts.epicId ?? null, status: opts.status ?? "ACTIVE" },
  });
}

async function join(personId: string, termId: string, departmentId: string) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
}

beforeEach(resetDb);

describe("loadTermEpicRollup", () => {
  it("throws when the term does not exist", async () => {
    await expect(loadTermEpicRollup("no-such-term")).rejects.toBeInstanceOf(SupportNotFoundError);
  });

  it("omits members whose departments never require Epic", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("NOEPIC", "NONE");
    const p = await makePerson("Nora");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(0);
    expect(rollup.groups.MODIFY).toHaveLength(0);
    expect(rollup.groups.RENEW).toHaveLength(0);
  });

  it("puts a first-time member with no Epic ID in NEW", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ada");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW.map((r) => r.name)).toEqual(["Ada"]);
    expect(rollup.groups.NEW[0].kindSource).toBe("derived");
    expect(rollup.groups.NEW[0].optional).toBe(false);
    expect(rollup.groups.NEW[0].selectable).toBe(true);
  });

  it("puts a returning member in the same department in RENEW", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Fay", { epicId: "E-FAY" });
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.RENEW.map((r) => r.name)).toEqual(["Fay"]);
  });

  it("puts a returning member who changed department in MODIFY", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const from = await makeDept("SCTP", "ALL");
    const to = await makeDept("JCTP", "ALL");
    const p = await makePerson("Eli", { epicId: "E-ELI" });
    await join(p.id, prior.id, from.id);
    await join(p.id, term.id, to.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.MODIFY.map((r) => r.name)).toEqual(["Eli"]);
    expect(rollup.groups.MODIFY[0].priorDepartmentNames).toEqual(["SCTP"]);
  });

  it("resolves the prior term as the most recent one, not the oldest", async () => {
    const oldest = await makeTerm("FA24", 2024);
    const recent = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const a = await makeDept("AAA", "ALL");
    const b = await makeDept("BBB", "ALL");
    const p = await makePerson("Gil", { epicId: "E-GIL" });
    await join(p.id, oldest.id, b.id);   // long ago: department B
    await join(p.id, recent.id, a.id);   // most recent prior: department A
    await join(p.id, term.id, a.id);     // this term: department A, unchanged

    const rollup = await loadTermEpicRollup(term.id);
    // Compared against FA25 (A -> A) this is a RENEW. Compared against FA24 it
    // would wrongly be a MODIFY.
    expect(rollup.groups.RENEW.map((r) => r.name)).toEqual(["Gil"]);
  });

  it("marks a SOME-department member with no signal as optional in NEW", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("MAYBE", "SOME");
    const p = await makePerson("Cyd");
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(1);
    expect(rollup.groups.NEW[0].optional).toBe(true);
  });

  it("lets a ticket-origin request override the derived kind", async () => {
    const prior = await makeTerm("FA25", 2025);
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Dee", { epicId: "E-DEE" });
    const actor = await makePerson("Manager");
    await join(p.id, prior.id, dept.id);
    await join(p.id, term.id, dept.id); // derived kind would be RENEW

    const ticket = await prisma.techRequest.create({
      data: {
        requesterId: p.id, category: "EPIC", subject: "Access change",
        description: "New role", status: "SUBMITTED",
      },
    });
    await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "MODIFY", status: "PENDING",
        requestedById: actor.id, techRequestId: ticket.id,
      },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.RENEW).toHaveLength(0);
    expect(rollup.groups.MODIFY).toHaveLength(1);
    expect(rollup.groups.MODIFY[0].kindSource).toBe("ticket");
    expect(rollup.groups.MODIFY[0].existingRequest?.techRequestNumber).toBe(ticket.number);
  });

  it("marks a person with a submitted request as not selectable", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ben");
    const actor = await makePerson("Manager");
    const ynhh = await prisma.ynhhTicket.create({
      data: { submittedById: actor.id, status: "OPEN" },
    });
    await join(p.id, term.id, dept.id);
    await prisma.epicRequest.create({
      data: {
        personId: p.id, kind: "NEW", status: "SUBMITTED",
        requestedById: actor.id, ticketId: ynhh.id,
      },
    });

    const rollup = await loadTermEpicRollup(term.id);
    expect(rollup.groups.NEW).toHaveLength(1);
    expect(rollup.groups.NEW[0].selectable).toBe(false);
    expect(rollup.groups.NEW[0].existingRequest?.status).toBe("SUBMITTED");
  });

  it("blocks a person with an open deactivation request", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Hal", { epicId: "E-HAL" });
    const actor = await makePerson("Manager");
    await join(p.id, term.id, dept.id);
    await prisma.epicRequest.create({
      data: { personId: p.id, kind: "DEACTIVATE", status: "PENDING", requestedById: actor.id },
    });

    const rollup = await loadTermEpicRollup(term.id);
    const row = rollup.groups.MODIFY[0];
    expect(row.selectable).toBe(false);
    expect(row.blockedReason).toContain("deactivation");
  });

  it("reports the missing onboarding steps for an uncleared member", async () => {
    const term = await makeTerm("SU26", 2026);
    const dept = await makeDept("SRR", "ALL");
    const p = await makePerson("Ivy"); // no contactEmail or phone: profile step incomplete
    await join(p.id, term.id, dept.id);

    const rollup = await loadTermEpicRollup(term.id);
    const row = rollup.groups.NEW[0];
    expect(row.cleared).toBe(false);
    expect(row.missingLabels).toContain("Profile & agreements");
    // Warn only: an uncleared person is still selectable.
    expect(row.selectable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:prepare` (once per worktree), then
`npx vitest run src/modules/support/services/epic-rollup.test.ts`
Expected: FAIL, "Failed to resolve import ./epic-rollup".

- [ ] **Step 3: Write the loader**

Create `src/modules/support/services/epic-rollup.ts`:

```ts
/**
 * Term Epic roll-up: who on a term's roster needs an Epic request, and of which
 * kind, derived live from the roster rather than materialized ahead of time.
 *
 * Nothing here writes. EpicRequest rows are created only when ITCM submits a
 * batch, through the generate route and submitEpicRequests.
 *
 * Trusts its caller for permissions: /support/epic gates on
 * support.manage_requests.
 */

import type { Track } from "@prisma/client";
import { prisma } from "@/platform/db";
import { buildTermOptions, type TermOption } from "@/platform/terms/term-options";
import { loadClearanceMap } from "@/modules/onboarding/services/clearance";
import { loadEffectiveSteps } from "@/modules/onboarding/services/step-config";
import { SupportNotFoundError } from "./tech-request";
import {
  classifyEpicKind,
  resolveRollupNeed,
  type RollupGroupKind,
  type RollupMembership,
} from "./epic-rollup-classify";

export type { RollupGroupKind } from "./epic-rollup-classify";

export type EpicRollupRow = {
  personId: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  /** ACTIVE memberships in the target term. */
  departments: { id: string; name: string; kind: Track }[];
  /** Department names from the person's most recent prior term, for a MODIFY diff. */
  priorDepartmentNames: string[];
  kind: RollupGroupKind;
  /** "ticket" when an explicitly-raised request set the kind, "derived" otherwise. */
  kindSource: "derived" | "ticket";
  /** SOME-department member with no deciding signal: shown but unchecked. */
  optional: boolean;
  /** Every onboarding step satisfied (blocking and non-blocking alike). */
  cleared: boolean;
  /** Labels of the unsatisfied steps, for the amber chip. Empty when cleared. */
  missingLabels: string[];
  existingRequest: {
    id: string;
    status: "PENDING" | "SUBMITTED";
    ticketId: string | null;
    techRequestNumber: number | null;
  } | null;
  /** Non-null when submitting this person would be refused. */
  blockedReason: string | null;
  /** False when blocked, or already SUBMITTED onto a YNHH ticket. */
  selectable: boolean;
};

export type EpicRollup = {
  term: {
    id: string;
    code: string;
    name: string;
    /** Term end date as YYYY-MM-DD, the default access end date for a batch. */
    endDateIso: string;
  };
  groups: Record<RollupGroupKind, EpicRollupRow[]>;
};

/** Terms offerable in the Term batch switcher, newest first, archived omitted. */
export async function listBatchTermOptions(): Promise<TermOption[]> {
  const terms = await prisma.term.findMany({
    orderBy: { startDate: "desc" },
    select: { id: true, code: true, status: true },
  });
  // buildTermOptions leads with a "Global" (empty value) entry for RBAC pickers;
  // a batch always targets a concrete term, so drop it.
  return buildTermOptions(terms).filter((o) => o.value !== "");
}

export async function loadTermEpicRollup(termId: string): Promise<EpicRollup> {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) throw new SupportNotFoundError(`Term not found: ${termId}`);

  const memberships = await prisma.termMembership.findMany({
    where: { termId, status: "ACTIVE" },
    include: {
      person: { select: { id: true, name: true, netId: true, contactEmail: true, epicId: true, status: true } },
      department: {
        select: { id: true, name: true, requiresEpicDirector: true, requiresEpicVolunteer: true },
      },
    },
  });

  const personIds = [...new Set(memberships.map((m) => m.personId))];
  if (personIds.length === 0) {
    return {
      term: { id: term.id, code: term.code, name: term.name, endDateIso: isoDay(term.endDate) },
      groups: { NEW: [], MODIFY: [], RENEW: [] },
    };
  }

  const [priorMemberships, contracts, openRequests, clearance, steps] = await Promise.all([
    // ACTIVE only: offboarding flips every membership a person holds to REMOVED,
    // so an offboarded-and-returning member correctly reads as having no prior
    // term and lands in MODIFY (reactivate) rather than RENEW.
    prisma.termMembership.findMany({
      where: {
        personId: { in: personIds },
        status: "ACTIVE",
        term: { startDate: { lt: term.startDate } },
      },
      select: {
        personId: true,
        departmentId: true,
        termId: true,
        department: { select: { name: true } },
        term: { select: { startDate: true } },
      },
    }),
    prisma.onboardingContract.findMany({
      where: {
        status: "PROMOTED",
        promotedPersonId: { in: personIds },
        acceptance: { application: { cycle: { termId } } },
      },
      select: { promotedPersonId: true, epicNeeded: true },
    }),
    prisma.epicRequest.findMany({
      where: { personId: { in: personIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      orderBy: { createdAt: "asc" },
      include: { techRequest: { select: { number: true } } },
    }),
    loadClearanceMap(personIds, termId),
    loadEffectiveSteps(termId),
  ]);

  // Per person, the department ids and names of their MOST RECENT prior term.
  const priorByPerson = new Map<string, { startDate: Date; ids: string[]; names: string[] }>();
  for (const m of priorMemberships) {
    const current = priorByPerson.get(m.personId);
    if (!current || m.term.startDate > current.startDate) {
      priorByPerson.set(m.personId, {
        startDate: m.term.startDate,
        ids: [m.departmentId],
        names: [m.department.name],
      });
    } else if (m.term.startDate.getTime() === current.startDate.getTime()) {
      current.ids.push(m.departmentId);
      current.names.push(m.department.name);
    }
  }

  const contractByPerson = new Map(
    contracts
      .filter((c): c is typeof c & { promotedPersonId: string } => c.promotedPersonId !== null)
      .map((c) => [c.promotedPersonId, c.epicNeeded])
  );

  // Group open requests by person. Oldest first (the query orders by createdAt),
  // so the row shown is the one a human raised first.
  const requestsByPerson = new Map<string, typeof openRequests>();
  for (const r of openRequests) {
    const list = requestsByPerson.get(r.personId) ?? [];
    list.push(r);
    requestsByPerson.set(r.personId, list);
  }

  const membershipsByPerson = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const list = membershipsByPerson.get(m.personId) ?? [];
    list.push(m);
    membershipsByPerson.set(m.personId, list);
  }

  const groups: Record<RollupGroupKind, EpicRollupRow[]> = { NEW: [], MODIFY: [], RENEW: [] };

  for (const personId of personIds) {
    const personMemberships = membershipsByPerson.get(personId) ?? [];
    if (personMemberships.length === 0) continue;
    const person = personMemberships[0].person;

    const rollupMemberships: RollupMembership[] = personMemberships.map((m) => ({
      departmentId: m.departmentId,
      kind: m.kind,
      requiresEpicDirector: m.department.requiresEpicDirector,
      requiresEpicVolunteer: m.department.requiresEpicVolunteer,
    }));

    const need = resolveRollupNeed(rollupMemberships, {
      contractEpicNeeded: contractByPerson.get(personId) ?? false,
      hasEpicId: person.epicId !== null,
    });
    if (!need.needed) continue;

    const prior = priorByPerson.get(personId) ?? null;
    const derivedKind = classifyEpicKind({
      hasEpicId: person.epicId !== null,
      termDepartmentIds: personMemberships.map((m) => m.departmentId),
      priorDepartmentIds: prior ? prior.ids : null,
    });

    const personRequests = requestsByPerson.get(personId) ?? [];
    const deactivation = personRequests.find((r) => r.kind === "DEACTIVATE") ?? null;
    // DEACTIVATE never places a row; the grant-side request (if any) does.
    const grantRequest = personRequests.find((r) => r.kind !== "DEACTIVATE") ?? null;
    // A request raised from a support ticket carries a kind a human chose
    // deliberately, so it overrides the derived one.
    const ticketKind =
      grantRequest && grantRequest.techRequestId !== null
        ? (grantRequest.kind as RollupGroupKind)
        : null;
    const kind = ticketKind ?? derivedKind;

    let blockedReason: string | null = null;
    if (person.status !== "ACTIVE") {
      blockedReason = `Person is not active (${person.status.toLowerCase()}).`;
    } else if (deactivation) {
      blockedReason = "Has an open deactivation request; resolve it before granting access.";
    } else if (kind === "NEW" && person.epicId) {
      blockedReason = "Already has an Epic ID, so a new-account request would be refused.";
    } else if (kind !== "NEW" && !person.epicId) {
      blockedReason = `Has no Epic ID on file, so a ${kind.toLowerCase()} request would be refused.`;
    }

    const summary = clearance.get(personId);
    const missingLabels = (summary?.missing ?? []).map((k) => steps.get(k)?.label ?? k);

    groups[kind].push({
      personId,
      name: person.name,
      netId: person.netId,
      contactEmail: person.contactEmail,
      epicId: person.epicId,
      departments: personMemberships.map((m) => ({
        id: m.department.id,
        name: m.department.name,
        kind: m.kind,
      })),
      priorDepartmentNames: prior ? [...new Set(prior.names)].sort() : [],
      kind,
      kindSource: ticketKind ? "ticket" : "derived",
      optional: need.optional,
      cleared: summary?.cleared ?? false,
      missingLabels,
      existingRequest: grantRequest
        ? {
            id: grantRequest.id,
            status: grantRequest.status as "PENDING" | "SUBMITTED",
            ticketId: grantRequest.ticketId,
            techRequestNumber: grantRequest.techRequest?.number ?? null,
          }
        : null,
      blockedReason,
      selectable: blockedReason === null && grantRequest?.status !== "SUBMITTED",
    });
  }

  for (const key of ["NEW", "MODIFY", "RENEW"] as RollupGroupKind[]) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    term: { id: term.id, code: term.code, name: term.name, endDateIso: isoDay(term.endDate) },
    groups,
  };
}

/** A stored calendar date rendered as YYYY-MM-DD. Term dates are stored at UTC
 *  midnight, so slicing the ISO string preserves the calendar day. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/support/services/epic-rollup.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Lint the new files**

Run: `npx eslint src/modules/support/services/epic-rollup.ts src/modules/support/services/epic-rollup-classify.ts`
Expected: no errors. In particular no em-dash and no cross-module violation (`support` is not in `MODULE_IDS`, so importing `onboarding` and `recruitment` is allowed).

- [ ] **Step 6: Commit**

```bash
git add src/modules/support/services/epic-rollup.ts src/modules/support/services/epic-rollup.test.ts
git commit -m "feat(support): derive the term Epic roll-up from the roster"
```

---

### Task 6: Shared client generation helper

Both the Generate tab and the Term batch tab POST to the same route, download the same artifacts, and build the same email subject. Extract that once so the new tab does not copy it.

**Files:**
- Create: `src/modules/support/components/epic-generate-client.ts`
- Modify: `src/modules/support/components/epic-request-form.tsx:45-54`, `:142-216`, `:599-615`

**Interfaces:**
- Consumes: `EpicRequestType` from Task 1.
- Produces: `EMAIL_SUBJECTS: Record<EpicRequestType, (initials: string, date: string) => string>` and
  `runEpicGeneration(input: { requestType: EpicRequestType; authorizer: { id: string; initials: string }; personIds: string[]; endDate: string; termId?: string }): Promise<{ subject: string; body: string; trackingWarning: string | null }>`.
  Task 7 imports both.

- [ ] **Step 1: Write the helper**

Create `src/modules/support/components/epic-generate-client.ts`:

```ts
/**
 * Browser-side Epic generation: POST the batch, download the PDF (and the
 * spreadsheet for bulk requests), and hand back the cover-email draft.
 *
 * Shared by the Generate tab and the Term batch tab so the two cannot drift on
 * request shape, date formatting, or subject lines. Browser-only (uses atob,
 * Blob, and document), so only "use client" modules may import it.
 */

import type { EpicRequestType } from "@/modules/support/epic-request-types";

export const EMAIL_SUBJECTS: Record<EpicRequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `[HAVEN] New Epic Account Request ${i} ${d}`,
  mod_individual: (i, d) => `[HAVEN] Modify Epic Access for One User ${d} ${i}`,
  renew_individual: (i, d) => `[HAVEN] Renew Epic Access for One User ${d} ${i}`,
  bulk_new: (i, d) => `[HAVEN] Multiple New Epic Account Request ${d} ${i}`,
  bulk_mod: (i, d) => `[HAVEN] Modify Epic Access for Multiple Users ${d} ${i}`,
  bulk_renew: (i, d) => `[HAVEN] Renew Epic Access for Multiple Users ${d} ${i}`,
  deactivate_individual: (i, d) => `[HAVEN] Deactivate Epic Access for One User ${d} ${i}`,
  bulk_deactivate: (i, d) => `[HAVEN] Deactivate Epic Access for Multiple Users ${d} ${i}`,
};

export type EpicGenerationResult = {
  subject: string;
  body: string;
  /** Set when the artifacts were produced but tracking was skipped. */
  trackingWarning: string | null;
};

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function runEpicGeneration(input: {
  requestType: EpicRequestType;
  authorizer: { id: string; initials: string };
  personIds: string[];
  /** ISO YYYY-MM-DD, straight off a date input. */
  endDate: string;
  /** Target term; omit to use the active term. */
  termId?: string;
}): Promise<EpicGenerationResult> {
  // The server and PDF expect MM/DD/YYYY. Convert by slicing rather than via Date
  // so the calendar day the admin picked survives regardless of timezone.
  const endDateFormatted = `${input.endDate.slice(5, 7)}/${input.endDate.slice(8, 10)}/${input.endDate.slice(0, 4)}`;

  const res = await fetch("/api/support/epic/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestType: input.requestType,
      authorizerId: input.authorizer.id,
      personIds: input.personIds,
      endDate: endDateFormatted,
      termId: input.termId,
    }),
  });

  if (!res.ok) {
    const { error: msg } = await res.json();
    throw new Error(msg ?? "Generation failed");
  }

  const data = await res.json();

  triggerDownload(base64ToBlob(data.pdfBase64, "application/pdf"), data.pdfFilename);
  if (data.xlsxBase64) {
    triggerDownload(
      base64ToBlob(
        data.xlsxBase64,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
      data.xlsxFilename
    );
  }

  // The subject uses the server's ET-formatted date, so it agrees with the PDF
  // filename instead of the browser's local clock (which can be a day ahead late
  // in the evening Eastern).
  return {
    subject: EMAIL_SUBJECTS[input.requestType](input.authorizer.initials, data.date),
    body: data.emailBody,
    trackingWarning: data.trackingWarning ?? null,
  };
}
```

- [ ] **Step 2: Point the Generate tab at it**

In `src/modules/support/components/epic-request-form.tsx`:

Delete the local `EMAIL_SUBJECTS` map (the whole `const EMAIL_SUBJECTS: Record<RequestType, ...> = { ... };` block) and the two helper functions `base64ToBlob` and `triggerDownload` at the bottom of the file. Add the import:

```ts
import { runEpicGeneration } from "./epic-generate-client";
```

Replace the body of `handleGenerate` from the `try {` through the `catch`/`finally` with:

```ts
    try {
      const result = await runEpicGeneration({
        requestType,
        authorizer: selectedAuthorizer,
        personIds: [...selectedPeopleIds],
        endDate,
      });
      setEmailDraft({ subject: result.subject, body: result.body });
      // Generation can succeed while tracking is skipped because a conflicting
      // request already exists. The artifacts are still valid, so surface the
      // warning (with its Tracker link, rendered below) rather than dropping it.
      if (result.trackingWarning) setTrackingWarning(result.trackingWarning);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
```

The guards above the `try` (no authorizer, no people selected, no end date) and the `setError(null) / setTrackingWarning(null) / setLoading(true) / setEmailDraft(null)` preamble stay exactly as they are.

- [ ] **Step 3: Typecheck, lint, and run the tests**

Run: `npm run typecheck`
Expected: no errors. An unused-import error for `RequestType` or a leftover reference to the deleted helpers names the line.

Run: `npx eslint src/modules/support`
Expected: no errors.

Run: `npx vitest run src/modules/support`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/support/components/epic-generate-client.ts src/modules/support/components/epic-request-form.tsx
git commit -m "refactor(support): share the Epic generation client between tabs"
```

---

### Task 7: The Term batch tab

**Files:**
- Create: `src/platform/ui/term-switcher.tsx`
- Delete: `src/modules/schedule/components/term-switcher.tsx`
- Create: `src/modules/support/components/term-batch-tab.tsx`
- Modify: `src/app/(app)/schedule/builder/page.tsx` (import path only)
- Modify: `src/modules/support/components/epic-request-tabs.tsx:51`, `:88-100`, `:556-600`
- Modify: `src/app/(app)/support/epic/page.tsx:211-259`

**Interfaces:**
- Consumes: `EpicRollup`, `EpicRollupRow`, `RollupGroupKind`, `loadTermEpicRollup`, `listBatchTermOptions` (Task 5); `requestTypeForGroup` (Task 1); `runEpicGeneration` (Task 6); `EpicAuthorizer` from `@/modules/support/services/itcm`; `TermOption` from `@/platform/terms/term-options`; `getWorkingTerm` from `@/platform/terms/working-term`; `getActiveTerm` from `@/platform/terms/active-term`.

- [ ] **Step 1: Move `TermSwitcher` to platform**

`TermSwitcher` depends only on `next/link` and `@/platform/terms/term-options`, so it can live in platform without violating the "platform must not import modules" rule. Moving it lets the support module use it without a cross-module import.

Run:

```bash
git mv src/modules/schedule/components/term-switcher.tsx src/platform/ui/term-switcher.tsx
```

Then edit the doc comment in the moved file so it no longer claims to be schedule-specific:

```tsx
/**
 * Term switcher: renders working-term options as links. The caller supplies
 * hrefForTerm so each page owns its own URL params. The "" (Global) option from
 * buildTermOptions is dropped here: a switcher always selects a concrete term.
 */
```

In `src/app/(app)/schedule/builder/page.tsx`, change the import:

```ts
import { TermSwitcher } from "@/platform/ui/term-switcher";
```

- [ ] **Step 2: Verify the move compiles**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx eslint src/platform/ui/term-switcher.tsx src/app/\(app\)/schedule/builder/page.tsx`
Expected: no errors.

- [ ] **Step 3: Commit the move**

```bash
git add -A src/platform/ui/term-switcher.tsx src/modules/schedule/components/term-switcher.tsx "src/app/(app)/schedule/builder/page.tsx"
git commit -m "refactor(ui): move TermSwitcher into platform"
```

- [ ] **Step 4: Write the Term batch tab**

Create `src/modules/support/components/term-batch-tab.tsx`:

```tsx
"use client";

/**
 * TermBatchTab: the ITCM term roll-up.
 *
 * Shows every roster member on the selected term who needs an Epic request,
 * split into NEW / MODIFY / RENEW by kind derived from the roster (see
 * loadTermEpicRollup). Each group submits as one YNHH batch: the request rows and
 * the ticket are written by the generate route, which returns the service-request
 * PDF, the bulk spreadsheet, and the cover-email draft.
 *
 * Clearance is a warning, never a block. A row that is not fully cleared shows
 * the missing steps and starts unchecked so submitting it is deliberate. Rows the
 * service layer would refuse (non-active person, open deactivation, Epic ID that
 * contradicts the kind) and rows already submitted onto a ticket are not
 * selectable at all.
 */

import { useState } from "react";
import Link from "next/link";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Checkbox } from "@/platform/ui/checkbox";
import { Field, Input } from "@/platform/ui/input";
import { SectionHeader } from "@/platform/ui/section-header";
import { Select } from "@/platform/ui/select";
import { TermSwitcher } from "@/platform/ui/term-switcher";
import type { TermOption } from "@/platform/terms/term-options";
import { EPIC_KIND_LABELS } from "@/modules/support/labels";
import { requestTypeForGroup } from "@/modules/support/epic-request-types";
import type { EpicAuthorizer } from "@/modules/support/services/itcm";
import type {
  EpicRollup,
  EpicRollupRow,
  RollupGroupKind,
} from "@/modules/support/services/epic-rollup";
import { runEpicGeneration } from "./epic-generate-client";

const GROUPS: RollupGroupKind[] = ["NEW", "MODIFY", "RENEW"];

const GROUP_BLURB: Record<RollupGroupKind, string> = {
  NEW: "No Epic account on file. YNHH creates one mirroring a same-role account in their department.",
  MODIFY: "Has an Epic account that needs the HAVEN department added or changed.",
  RENEW: "Same departments as last term. Access is extended to the new end date.",
};

type Selection = Record<RollupGroupKind, Set<string>>;

function defaultSelection(rollup: EpicRollup): Selection {
  const out: Selection = { NEW: new Set(), MODIFY: new Set(), RENEW: new Set() };
  for (const group of GROUPS) {
    for (const row of rollup.groups[group]) {
      if (row.selectable && row.cleared && !row.optional) out[group].add(row.personId);
    }
  }
  return out;
}

export function TermBatchTab({
  rollup,
  authorizers,
  termOptions,
  liveTermId,
}: {
  rollup: EpicRollup;
  authorizers: EpicAuthorizer[];
  termOptions: TermOption[];
  liveTermId: string | null;
}) {
  const [authorizerId, setAuthorizerId] = useState(authorizers[0]?.id ?? "");
  const [endDate, setEndDate] = useState(rollup.term.endDateIso);
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(rollup));
  const [busyGroup, setBusyGroup] = useState<RollupGroupKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ group: RollupGroupKind; subject: string; body: string } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  function toggle(group: RollupGroupKind, personId: string) {
    setError(null);
    setWarning(null);
    setSelection((prev) => {
      const next = new Set(prev[group]);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return { ...prev, [group]: next };
    });
  }

  async function submitGroup(group: RollupGroupKind) {
    const authorizer = authorizers.find((a) => a.id === authorizerId);
    if (!authorizer) {
      setError("No ITCM director is available to authorize this request.");
      return;
    }
    const personIds = [...selection[group]];
    if (personIds.length === 0) {
      setError(`Select at least one person in the ${EPIC_KIND_LABELS[group]} group.`);
      return;
    }
    if (!endDate) {
      setError("Set the access end date before submitting a batch.");
      return;
    }
    setError(null);
    setWarning(null);
    setDraft(null);
    setBusyGroup(group);
    try {
      const result = await runEpicGeneration({
        requestType: requestTypeForGroup(group, personIds.length),
        authorizer,
        personIds,
        endDate,
        termId: rollup.term.id,
      });
      setDraft({ group, subject: result.subject, body: result.body });
      if (result.trackingWarning) setWarning(result.trackingWarning);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyGroup(null);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    const text = `To: helpdesk@ynhh.org\nSubject: ${draft.subject}\n\n${draft.body}`;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 4000);
    }
  }

  const total = GROUPS.reduce((n, g) => n + rollup.groups[g].length, 0);

  return (
    <div className="space-y-6">
      <TermSwitcher
        options={termOptions}
        selectedId={rollup.term.id}
        liveTermId={liveTermId}
        hrefForTerm={(termId) =>
          termId ? `/support/epic?tab=term-batch&term=${termId}` : "/support/epic?tab=term-batch"
        }
      />

      <Card className="space-y-4">
        <SectionHeader level="title">Batch settings</SectionHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Authorizer">
            <Select
              value={authorizerId}
              onChange={(e) => setAuthorizerId(e.target.value)}
              disabled={authorizers.length === 0}
            >
              {authorizers.length === 0 ? (
                <option value="">No ITCM directors</option>
              ) : (
                authorizers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              )}
            </Select>
          </Field>
          <Field label="Access end date">
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {warning && (
        <Alert tone="warning">
          {warning}{" "}
          <Link href="/support/epic?tab=tracker" className="underline underline-offset-2">
            Open the Tracker
          </Link>
        </Alert>
      )}

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody on the {rollup.term.code} roster needs an Epic request. Members appear here once
          their department requires Epic access and they hold an active membership in this term.
        </p>
      ) : (
        GROUPS.map((group) => (
          <GroupCard
            key={group}
            group={group}
            rows={rollup.groups[group]}
            selected={selection[group]}
            busy={busyGroup === group}
            disabled={busyGroup !== null}
            onToggle={(personId) => toggle(group, personId)}
            onSubmit={() => submitGroup(group)}
          />
        ))
      )}

      {draft && (
        <Card className="space-y-3">
          <SectionHeader level="title">
            {EPIC_KIND_LABELS[draft.group]} email draft
          </SectionHeader>
          <p className="text-xs text-subtle-foreground">
            The PDF (and spreadsheet, for a multi-person batch) already downloaded. Send this to
            helpdesk@ynhh.org with them attached.
          </p>
          <p className="text-sm font-medium text-foreground">{draft.subject}</p>
          <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-xs text-foreground-soft">
            {draft.body}
          </pre>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={copyDraft}>
              Copy email
            </Button>
            <span
              aria-live="polite"
              className={`text-xs font-medium ${
                copyState === "copied"
                  ? "text-success-foreground"
                  : copyState === "error"
                    ? "text-critical"
                    : "text-muted-foreground"
              }`}
            >
              {copyState === "copied"
                ? "Copied to clipboard"
                : copyState === "error"
                  ? "Copy failed. Select the text above and copy manually."
                  : ""}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}

function GroupCard({
  group,
  rows,
  selected,
  busy,
  disabled,
  onToggle,
  onSubmit,
}: {
  group: RollupGroupKind;
  rows: EpicRollupRow[];
  selected: Set<string>;
  busy: boolean;
  disabled: boolean;
  onToggle: (personId: string) => void;
  onSubmit: () => void;
}) {
  const clearedCount = rows.filter((r) => r.cleared).length;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionHeader level="title">{EPIC_KIND_LABELS[group]}</SectionHeader>
        <span className="text-xs text-subtle-foreground">
          {rows.length} {rows.length === 1 ? "person" : "people"}, {clearedCount} cleared
        </span>
      </div>
      <p className="text-xs text-subtle-foreground">{GROUP_BLURB[group]}</p>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody in this group.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <RollupRow
              key={row.personId}
              row={row}
              checked={selected.has(row.personId)}
              onToggle={() => onToggle(row.personId)}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={disabled || selected.size === 0}
          onClick={onSubmit}
        >
          {busy ? "Submitting..." : `Submit ${EPIC_KIND_LABELS[group].toLowerCase()} batch`}
        </Button>
        <span className="text-xs text-subtle-foreground">{selected.size} selected</span>
      </div>
    </Card>
  );
}

function RollupRow({
  row,
  checked,
  onToggle,
}: {
  row: EpicRollupRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const deptLabel =
    row.kind === "MODIFY" && row.priorDepartmentNames.length > 0
      ? `${row.priorDepartmentNames.join(", ")} -> ${row.departments.map((d) => d.name).join(", ")}`
      : row.departments.map((d) => d.name).join(", ");

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
      <Checkbox checked={checked} onChange={onToggle} disabled={!row.selectable} />
      <span className="font-medium text-foreground">{row.name}</span>
      <span className="text-xs text-subtle-foreground">{deptLabel}</span>

      {row.cleared ? (
        <Badge tone="success">Cleared</Badge>
      ) : (
        <Badge tone="warning">
          {row.missingLabels.length > 0 ? `Missing: ${row.missingLabels.join(", ")}` : "Not cleared"}
        </Badge>
      )}

      {row.optional && <Badge>Optional</Badge>}
      {row.kindSource === "ticket" && row.existingRequest?.techRequestNumber != null && (
        <Badge tone="brand">From ticket #{row.existingRequest.techRequestNumber}</Badge>
      )}
      {row.kindSource === "derived" && row.existingRequest?.status === "PENDING" && (
        <Badge>Queued</Badge>
      )}
      {row.existingRequest?.status === "SUBMITTED" && <Badge tone="brand">Already submitted</Badge>}
      {row.blockedReason && <Badge tone="critical">{row.blockedReason}</Badge>}
    </li>
  );
}
```

- [ ] **Step 5: Register the tab**

In `src/modules/support/components/epic-request-tabs.tsx`:

Extend the `Tab` union (line 51):

```ts
type Tab = "generate" | "term-batch" | "pending" | "tracker" | "history";
```

Add the label in the `TabNav` label map (near line 91) and the tab list (near line 98):

```ts
    "term-batch": "Term batch",
```

```tsx
      {(["generate", "term-batch", "pending", "tracker", "history"] as Tab[]).map((tab) => (
```

Add these to the `Props` type:

```ts
  rollup: EpicRollup | null;
  termOptions: TermOption[];
  liveTermId: string | null;
```

Add the imports:

```ts
import { TermBatchTab } from "./term-batch-tab";
import type { EpicRollup } from "@/modules/support/services/epic-rollup";
import type { TermOption } from "@/platform/terms/term-options";
```

In the tab body switch (near line 586), add the branch before the `pending` branch:

```tsx
      ) : activeTab === "term-batch" ? (
        rollup ? (
          <TermBatchTab
            rollup={rollup}
            authorizers={authorizers}
            termOptions={termOptions}
            liveTermId={liveTermId}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No term is active yet. Activate a term, or create one in planning, to build a batch.
          </p>
        )
```

Destructure the three new props in the component signature alongside the existing ones.

- [ ] **Step 6: Wire the page**

In `src/app/(app)/support/epic/page.tsx`:

Add the imports:

```ts
import { getActiveTerm } from "@/platform/terms/active-term";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { listBatchTermOptions, loadTermEpicRollup } from "@/modules/support/services/epic-rollup";
```

Extend the `PageProps` search params:

```ts
type PageProps = {
  searchParams: Promise<{ tab?: string; error?: string; term?: string }>;
};
```

Replace the destructure and `activeTab` resolution:

```ts
  const { tab, error, term } = await searchParams;
  const activeTab =
    tab === "pending"
      ? "pending"
      : tab === "tracker"
        ? "tracker"
        : tab === "history"
          ? "history"
          : tab === "term-batch"
            ? "term-batch"
            : "generate";
```

Add the roll-up loads after the existing `Promise.all` block:

```ts
  // The Term batch tab can target a term before it goes active, so resolve the
  // working term from ?term= (falling back to the live term) rather than assuming
  // the active one.
  const [workingTerm, liveTerm, termOptions] = await Promise.all([
    getWorkingTerm(term),
    getActiveTerm(),
    listBatchTermOptions(),
  ]);
  const rollup = workingTerm ? await loadTermEpicRollup(workingTerm.id) : null;
```

Pass the new props to `<EpicRequestTabs>`:

```tsx
        rollup={rollup}
        termOptions={termOptions}
        liveTermId={liveTerm?.id ?? null}
```

- [ ] **Step 7: Typecheck, lint, and run the suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors across the whole repo. This is the run that catches em-dashes and module-boundary violations.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Check it in the browser**

Run: `npm run dev`

Sign in as a `support.manage_requests` holder, open `http://localhost:3000/support/epic?tab=term-batch`, and confirm:
- the three groups render with counts and clearance badges;
- switching terms via the switcher reloads the roll-up and preserves the tab;
- an uncleared row starts unchecked and can still be ticked;
- a blocked row's checkbox is disabled;
- submitting a group downloads the PDF (plus XLSX above one person) and shows the email draft;
- after submitting, the people move to the Tracker tab under one new YNHH ticket.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/support/epic/page.tsx" src/modules/support/components/term-batch-tab.tsx \
        src/modules/support/components/epic-request-tabs.tsx
git commit -m "feat(support): add the ITCM term Epic batch tab"
```

---

## Self-Review Notes

Spec coverage check, section by section:

| Spec section | Task |
| --- | --- |
| Placement (new tab, selectable term) | 7 |
| Classification: needs-Epic resolution | 4 |
| Classification: NEW / MODIFY / RENEW | 4 |
| Overrides: explicit ticket kind | 5 |
| Overrides: already in flight | 5 (`selectable`) |
| Overrides: adopted | 2 and 5 |
| Overrides: open deactivation blocks | 5 |
| Loader (batched IO) | 5 |
| Clearance, warn only | 5 (data) and 7 (UI) |
| Hard invariants surfaced as `blockedReason` | 5 |
| Submit, group to request type | 1 (`requestTypeForGroup`) and 7 |
| Change 1: `bulk_renew` and `bulk_mod` kind | 1 |
| Change 2: adoption | 2 |
| Change 3: optional `termId` | 3 |
| Two queues coexisting (atomic claim) | 2 |
| Permissions | inherited, no code change |
| Testing | 1, 2, 4, 5 |

Two refinements were folded back into the spec while writing this plan, so the two documents agree: the loader returns a computed `selectable` boolean (keeping the "who can be submitted" rule in one place instead of making the UI recombine `blockedReason` and `existingRequest.status`), and `term.endDateIso` is a `YYYY-MM-DD` string rather than a `Date` so the client can seed the date input with no timezone handling at the RSC boundary.

Note for the implementer: the pure classifier lives in `epic-rollup-classify.ts`, separate from the loader in `epic-rollup.ts`. Task 4 must land before Task 5.
