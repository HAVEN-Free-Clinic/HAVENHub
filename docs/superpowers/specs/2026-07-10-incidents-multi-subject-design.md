# Incident Reports: link multiple people involved, with per-person strike requests

Status: approved design, ready for implementation planning
Date: 2026-07-10
Author: Jack C (with Claude)

## 1. Summary

Today an incident report links at most **one** person (`IncidentReport.subjectPersonId`), even though the form section is already labelled "individual(s) of concern". This change lets a reporter link **any number of people involved**, and — because strikes only ever apply to volunteers a director manages — carries an **independent, per-person strike request** for each linked person a reviewer decides separately.

The mechanism: a new join row, `IncidentReportSubject` (one per linked person), that also holds that person's strike-request state (`strikeDecision` PENDING / APPROVED / DECLINED, plus who decided and when). The report-level strike fields move onto this row. The free-text `subjectDescription` box stays as the fallback for people not in the system. Everything else about the module — intake, review queue, resolution, notifications, the strikes ledger — is preserved and generalised from "the subject" to "each linked person".

Nothing about strike-count semantics changes: an approved request still creates one `DisciplinaryAction`, and a person's strike total is still a count of those rows.

## 2. Background and current state (as implemented, PR #196)

- **`IncidentReport`** (`prisma/schema.prisma`): single optional `subjectPersonId` -> Person (relation `incidentReportSubject`, `onDelete: SetNull`) plus free-text `subjectDescription`. Report-level strike bridge lives directly on the report: `strikeDecision StrikeDecision?` (null = none requested), `strikeDecidedById` -> Person? (Restrict), `strikeDecidedAt`, and a 1:1 `strikeAction DisciplinaryAction? @relation("incidentReportStrikeAction")`. Index `@@index([subjectPersonId])`.
- **`DisciplinaryAction`**: `reportId String? @unique` + `report IncidentReport? @relation("incidentReportStrikeAction", ..., onDelete: SetNull)`. The `@unique` enforces **one strike per report** and is what the concurrent-double-approve guard relies on (`isUniqueConstraintError`). `personId` (Cascade), `issuedById` (Restrict), plus the category/description/confidential/patientInvolved fields.
- **Service `report.ts`**: `SubmitReportInput` carries `subjectPersonId?` + `requestStrike?`. `submitReport` validates the one subject exists, checks `canRequestStrikeAgainst(actor, subjectPersonId)` when a strike is requested, and writes `strikeDecision = PENDING` on the report. `listSubjectOptions` returns every ACTIVE person plus the `strikeEligibleIds` subset (managed volunteers). `decideStrike(actor, reportId, input)` approves (issues a `DisciplinaryAction` against `report.subjectPersonId`, links via `reportId`) or declines the single request. `listMyReports` / `listReviewQueue` include `subject { name }` and expose `subjectName: string | null`; the queue's `q` searches `subject.name`, and `strikePending` filters `strikeDecision === PENDING`.
- **Service `disciplinary.ts`**: `issueAction` accepts `reportId?` and writes it onto the new `DisciplinaryAction`. `strikeCount` / `loadStrikeCounts` count rows per person, unchanged.
- **UI**: `subject-picker.tsx` is a single `Combobox` (hidden `subjectPersonId`) plus one "Request a strike" `Checkbox` (`requestStrike`) shown only when the picked person is strike-eligible. `page.tsx` renders the free-text box + `SubjectPicker`. `[id]/page.tsx` renders `report.subject?.name ?? report.subjectDescription` and one approve/decline form pair when `strikeDecision === PENDING`. `mine/page.tsx` and `review/page.tsx` render a single `subjectName` and a report-level "Strike" column.
- **`Person`** relations: `incidentReportsAbout` (`incidentReportSubject`) and `incidentStrikeDecisions` (`incidentReportStrikeDecidedBy`).

## 3. Decisions (locked)

1. **Multiple linked people.** A report links zero-to-many people via `IncidentReportSubject`, one row per person, `@@unique([reportId, personId])` so a person is linked at most once per report. Free-text `subjectDescription` stays for unlisted/described people.
2. **Per-person strikes (chosen).** Each linked person carries its own strike-request state on its join row. A reviewer approves or declines each independently; approving one person's strike does not touch another's. A single report can therefore produce several `DisciplinaryAction` rows (one per approved person).
3. **Strike state moves onto the join row.** `IncidentReport.strikeDecision` / `strikeDecidedById` / `strikeDecidedAt` / the 1:1 `strikeAction` are removed from the report and re-created on `IncidentReportSubject`. There is no report-level strike field any more.
4. **`DisciplinaryAction` link generalised.** `reportId` loses `@unique`; a composite `@@unique([reportId, personId])` replaces it. That preserves "at most one strike per person per report", keeps the concurrent-double-approve guard working, and — because Postgres treats NULLs as distinct — never constrains directly-issued strikes (`reportId = null`). `reportId` and its `report` relation stay; the strike for a given join row is the `DisciplinaryAction` matching `(reportId, personId)`.
5. **Strike eligibility unchanged, applied per person.** The "Request a strike" affordance still appears only for a linked person who is an ACTIVE volunteer in a department the reporter manages (`strikeEligibleIds`). `submitReport` re-checks `canRequestStrikeAgainst` per flagged person server-side (tamper guard).
6. **Person deletion of a join row cascades.** `IncidentReportSubject.person` uses `onDelete: Cascade` (a join row is meaningless without its person). This differs from the report's old `SetNull`, but hard person-deletion is rare (offboarding flips status, it does not delete), and `subjectDescription` still preserves textual context. Not snapshotting the name.
7. **No new permissions, no registry/nav changes.** Purely a data-model + intake + review generalisation within the existing `incidents` module.

## 4. Data model

### IncidentReportSubject (new)

```prisma
/// Links an incident report to one person involved (one row per person) and
/// carries that person's per-report strike-request state, so a single report
/// can hold independent strike requests against multiple people.
model IncidentReportSubject {
  id                String          @id @default(cuid())
  reportId          String
  personId          String
  /// null = linked for context only. PENDING/APPROVED/DECLINED = strike request state.
  strikeDecision    StrikeDecision?
  strikeDecidedById String?
  strikeDecidedAt   DateTime?
  createdAt         DateTime        @default(now())
  /// Cascade: the link belongs to the report.
  report            IncidentReport  @relation(fields: [reportId], references: [id], onDelete: Cascade)
  /// Cascade: the link is meaningless without the person (see Decision 6).
  person            Person          @relation("incidentReportSubjectPerson", fields: [personId], references: [id], onDelete: Cascade)
  /// The reviewer who decided this person's strike request. SetNull: keep the row if they are deleted.
  strikeDecidedBy   Person?         @relation("incidentReportSubjectStrikeDecidedBy", fields: [strikeDecidedById], references: [id], onDelete: SetNull)
  @@unique([reportId, personId])
  @@index([reportId])
  @@index([personId])
}
```

### IncidentReport (changed)

- **Remove**: `subjectPersonId`, the `subject` relation, `strikeDecision`, `strikeDecidedById`, `strikeDecidedAt`, the `strikeDecidedBy` relation, the 1:1 `strikeAction` relation, and `@@index([subjectPersonId])`.
- **Keep**: `subjectDescription` and everything else.
- **Add**: `subjects IncidentReportSubject[]` and a `strikeActions DisciplinaryAction[] @relation("incidentReportStrikeAction")` back-relation (a report can now have several linked strikes).

### DisciplinaryAction (changed)

- `reportId String?` loses `@unique`; keep the `report IncidentReport? @relation("incidentReportStrikeAction", ..., onDelete: SetNull)`.
- Add `@@unique([reportId, personId])`. Keep `@@index([personId])`.
- No other field changes; `issueAction` still writes `reportId`.

### Person (changed relations)

- Replace `incidentReportsAbout IncidentReport[] @relation("incidentReportSubject")` with `incidentSubjectLinks IncidentReportSubject[] @relation("incidentReportSubjectPerson")`.
- Replace `incidentStrikeDecisions IncidentReport[] @relation("incidentReportStrikeDecidedBy")` with `incidentSubjectStrikeDecisions IncidentReportSubject[] @relation("incidentReportSubjectStrikeDecidedBy")`.

## 5. Migration and backfill

One migration, run in order. Given the module is new (PR #196) production incident data is likely near-zero, but the backfill is written to be correct regardless.

1. `CREATE TABLE "IncidentReportSubject"` with the unique constraint + two indexes.
2. **Backfill subjects**: for every `IncidentReport` with a non-null `subjectPersonId`, insert one join row carrying `reportId`, `personId = subjectPersonId`, and the report's `strikeDecision` / `strikeDecidedById` / `strikeDecidedAt` (and `createdAt`). The `id` is generated in SQL (e.g. `gen_random_uuid()::text`; a plain string PK, cuid-shape not required for backfilled rows).
3. **Swap the `DisciplinaryAction` unique**: drop the unique index on `reportId`; add the composite unique on `(reportId, personId)`. Existing rows satisfy it (each old `reportId` was unique, so no `(reportId, personId)` pair collides). Existing directly-issued strikes have `reportId = null` and are unaffected.
4. **Drop old report columns / constraints**: the `subjectPersonId` FK + column, the `strikeDecision` / `strikeDecidedById` / `strikeDecidedAt` columns, the `strikeDecidedBy` FK, and `@@index([subjectPersonId])`.

Constraints to honour (from prior migrations in this repo): trim the generated migration of any pre-existing drift so it contains only these statements; verify with `prisma migrate status` before the Neon deploy (previews share the prod DB, so a branch behind a migration crashes P2021). The shared, symlinked `node_modules` means regenerating the Prisma client affects every worktree — expected and additive here.

## 6. Service changes (`report.ts`, `disciplinary.ts`)

- **`SubmitReportInput`**: replace `subjectPersonId?` + `requestStrike?` with `subjects: Array<{ personId: string; requestStrike?: boolean }>` (order-insensitive; `subjectDescription` unchanged). `submitReport`:
  - dedupe by `personId`; validate each person exists (`IncidentNotFoundError` otherwise);
  - for each `requestStrike` person, re-check `canRequestStrikeAgainst(actor, personId)` (`IncidentValidationError` if not eligible — the UI only offers it for eligible people, so this is a tamper guard);
  - create the report, then the `IncidentReportSubject` rows (strike-flagged ones at `strikeDecision = PENDING`, the rest null), inside the same flow as attachments.
- **`listSubjectOptions`**: unchanged shape (`people` + `strikeEligibleIds`); the client picker now consumes it to build a multi-add list.
- **`decideStrike(actor, reportSubjectId, input)`**: keyed on the **join row id** instead of the report. Loads the row (+ its report + person); requires its `strikeDecision === PENDING`; approve issues a `DisciplinaryAction` for `row.personId` (linked via `reportId = row.reportId`, `confidential = report.anonymous`, `patientInvolved = report.patientImpact === "YES"`) and sets the row APPROVED; decline sets it DECLINED. The `isUniqueConstraintError` guard still catches a concurrent double-approve (now via the composite unique). Audit `incident.strike_decided` gains `reportSubjectId` + `personId`.
- **Reads**: `getReport` includes `subjects: { include: { person: { select: { name } } } }`. `listMyReports` / `listReviewQueue` return `subjectNames: string[]` and a small strike summary per report (e.g. counts of PENDING / APPROVED among the subjects) instead of the single `subjectName` + report-level `strikeDecision`. The queue's `q` matches any linked subject (`subjects: { some: { person: { name: { contains, insensitive } } } }` OR reporter name OR number); `strikePending` filter becomes `subjects: { some: { strikeDecision: "PENDING" } }`.
- **Notifications**: `notifyReviewersOfSubmission` fires `incidents.strike_requested` once when **any** subject is PENDING, naming the flagged people (precomputed comma string; the template engine has no `{{#each}}`). `notifyReporterOfStrikeDecision` fires per `decideStrike` call (unchanged, one decision at a time).

## 7. UI changes

- **`subject-picker.tsx` -> multi-person**: a `Combobox` to pick a person plus an "Add" affordance that appends to an on-page list; each list row shows the name/hint, a remove control, and — for strike-eligible people only — a per-row "Request a strike" checkbox. Submits repeated hidden inputs: `subjectPersonIds` (one per row) and `strikePersonIds` (one per checked row). Free-text `subjectDescription` box stays above it, relabelled to the plural.
- **`actions.ts` `submitReportAction`**: read `formData.getAll("subjectPersonIds")` and `getAll("strikePersonIds")`; build the `subjects` array (`requestStrike = strikePersonIds.includes(personId)`). `decideStrikeAction` reads a `reportSubjectId` hidden field and passes it to `decideStrike`.
- **`[id]/page.tsx`**: "Individual(s) of concern" renders the list of linked people, each with a per-person strike badge (Requested / Issued / Declined) alongside the free-text description. Reviewer controls render **one approve/decline form per subject whose `strikeDecision === PENDING`**, each carrying that row's `reportSubjectId` and naming the person.
- **`mine/page.tsx` + `review/page.tsx`**: the "Subject" column shows the linked names (comma-joined, "+N more" past a couple); the "Strike" column shows an aggregate badge derived from the subjects' decisions (e.g. "Strike pending" if any PENDING). Filter labels/search copy unchanged.

## 8. Testing

DB-backed service tests are the gate (CI, per the shared-Prisma constraint). Update the existing `report.test.ts` expectations from the single-subject shape to the join-row shape, and add:

- multiple subjects persist as distinct `IncidentReportSubject` rows; dedupe collapses a repeated `personId`;
- a non-existent linked person -> `IncidentNotFoundError`; a strike requested for a non-eligible person -> `IncidentValidationError`;
- per-person strike requests land the right rows at PENDING; deciding one subject's strike (approve) issues exactly one `DisciplinaryAction` for that person and leaves the other subject's request PENDING; declining sets DECLINED with no action;
- an anonymous report yields a `confidential` strike (unchanged), now per subject;
- `listReviewQueue` `q` matches a report by **any** linked subject's name; `strikePending` filter matches a report with any PENDING subject;
- concurrent double-approve of the same subject row hits the composite unique and surfaces as `IncidentValidationError`.

E2e (existing incidents spec): file a report linking two people, request a strike against one -> reviewer sees both, approves the one strike -> it appears/counts on the ledger and the other person carries no strike.

## 9. Out of scope

- Roles/classification among linked people (witness vs. subject); the per-person strike checkbox already distinguishes "actionable" from "context".
- Editing a report's linked people after submission (submission-time only, matching the current form-only flow).
- Any change to registry, nav, permissions, the strikes ledger page, or strike-count semantics.
- Snapshotting a linked person's name against future deletion (Decision 6).

## 10. Open questions

None blocking. To confirm during planning: the exact "+N more" truncation threshold in the list/queue columns, and whether the aggregate "Strike" column should distinguish "pending" from "issued" or simply show "pending" while any request is open.
