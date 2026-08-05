# Historical recruitment import and the applicant history view (2026-08-05)

## Problem

Ten completed recruitment cycles live in Airtable and nowhere else. HAVEN Hub has no record that
any of them happened.

The operational cost lands on reviewers. When a director opens an application today, the page shows
one cycle's answers and nothing else. It cannot tell them that this applicant also applied in Fall
2024 and was rejected at the paper screen, applied again in Spring 2025 and reached round 2, and
submitted an interest form in between. That pattern is exactly the "demonstrated interest" signal a
reviewer wants, and today it is invisible unless someone remembers the name.

The same gap shows up elsewhere. A returning alum who was offboarded cannot be recognized at
sign-in ([[returning-alum-recognition]]), and nobody can answer "how did this director first get
involved" without opening an Airtable base that is marked `[Outdated]`.

Airtable is also not a durable home for it. Bases are duplicated per cycle, renamed by hand, and
retired; three of them are already empty duplicates and one (`D-WN26`) is a clone of another
carrying the same 89 record ids.

## Source survey

Verified live against the Airtable REST API on 2026-08-05. Counts are exact.

### Volunteer cycles

| Cycle | Base | Applications | Notes |
|---|---|---|---|
| V-FA24 | `appSzCKAaB1c1v1f4` | 647 | Round-split shape, unique to this cycle |
| V-SP25 | `appWSVTqKqiwVyVio` | 504 | 399 R1 sel / 3 R2 apps / 135 R2 sel / 499 final |
| V-SU25 | `appBTfqxZSHyf1LBl` | 413 | 309 / 104 / 52 / 413 |
| V-FA25 | `app0DXgMSFvsWW4t8` | 722 | 476 / 262 / 26 / 722 |
| V-SP26 | `appsXFzmnfi5vWzrJ` | 551 | Decisions inline; R2 tables return 403 |
| V-SU26 | `appOq1yOiA1Lfzq8L` | 358 | 74 acceptances, 303 contracts; own shape |

### Director cycles

Shared tables: Applications `tbluFoybFPBjBAXyk`, Interviews `tblQ8s0fGfYVC41OK`,
Candidate Evaluations `tbloK5O8uzzyvXzCx`, Final Decisions `tblfw1kjlBc5fULrY`.

| Cycle | Base | Apps / Interviews / Evals / Final |
|---|---|---|
| D-FA24 | `appwhZqNU4zCkQ9U2` | 87 / 77 / 111 / 87 |
| D-SU25 | `app5ma8K8a1qansUu` | 84 / 42 / 74 / 82 |
| D-FA25 | `appvvlDJLmGfN0340` | 89 / 74 / 10 / 0 |
| D-SU26 | `app6MHzSA1yPej2zX` | 76 / 73 / 403 / n/a |

### Interest form

`appyZMpXNJ0rVzOT8`: Responses `tblEacqiHtqKMJphX` (347) and Responses [Old MS]
`tbl55zvZUFQgcnp04` (757).

### Excluded sources, and why

- `appX9dVg2g9FDJlMl` (D-WN26). A clone of D-FA25: it holds all 89 of that base's record ids
  (created 2025-11 and 2025-12) plus exactly one record created 2026-03-28. There was no separate
  WN26 applicant pool. Importing it would duplicate every D-FA25 applicant.
- `appJRUKtCBmg7w3Cp` (D-SP25), `app7f51P5guqc8jou` (D-SP26), `appIgxGgVKVeSNF72` (V-FA25 dup).
  All zero records.
- `appXFdgWx7syySXZ1` (V-May26). A May 2026 snapshot copy of the V-SU26 base.

### Two structural facts that shape the whole design

**Table ids are stable across a lineage.** Each cycle base was duplicated from its predecessor, so
Airtable preserved both table and record ids. Every volunteer base from SP25 on shares
`tblJPuEMyBq5c2x0W`; every director base from FA24 on shares `tbluFoybFPBjBAXyk`.

**Field ids are stable too, despite heavy field drift.** Field counts grow sharply within a lineage
(volunteer applications go 52 to 53 to 87 to 104; director 75 to 91 to 119 to 128) because each
cycle added questions, but the shared fields keep their ids. Verified across all four modern
volunteer bases:

| Field | Id (identical in SP25, SU25, FA25, SP26) |
|---|---|
| Email Address | `fldkynQt6MUSpmkhv` |
| First Name | `fldQA7KFcUNM5cUqn` |
| Last Name | `fldX0RAj3S0psMSSp` |
| Full Name | `flde5OUEUCEwYDwwF` |
| Yale NetID | `fldtAreIGp2junzjR` |

So the importer needs **one field map per lineage, not one per base**. That is what makes ten
cycles tractable instead of ten bespoke integrations.

## Decisions

Jack ruled on these on 2026-08-05. They are settled and not re-litigated here.

- **Outcome trail only, not verbatim answers.** Per applicant per cycle: identity, departments
  wanted, how far they got, and the decision. No essays, no scores, no evaluations. This is what
  makes the import survive the field drift, since it only reads the handful of fields every cycle
  shares. Full-archive and answers-included variants were both rejected as more surface than the
  reviewing use case needs.
- **All three surfaces.** Reviewer card, person profile section, and a searchable history browser.
- **Scope is every real cycle.** Including V-FA24 despite its bespoke shape, because it is roughly
  20% of all volunteer applications and the oldest evidence of interest.
- **SU26 is imported too.** SU26 recruitment ran in Airtable, not in the Hub, so it is history like
  the rest. SU26 is the last Airtable cycle; everything after it runs in the Hub.
- **The interest form is included as its own row type**, rendered distinctly and never confused
  with an application.
- **Separate historical models, unioned at read time** (approach C below).

## Goals

Give reviewers, on the page where they decide, the full record of an applicant's prior contact with
HAVEN, spanning both the Airtable years and every future Hub cycle, without putting archived rows
anywhere the live recruitment module can trip over them.

## Non-goals

- Importing answers, essays, committee scores, IA scores, or interview evaluations.
- A manual merge or split UI for identities that resolve wrongly. The history detail page exposes
  every known email so a bad merge is diagnosable; fixing one is a follow-up.
- Any change to how live recruitment works. No existing recruitment query is modified.
- Backfilling `Person` rows for past applicants who never joined.

## Design

### 1. Why separate models rather than reusing the live ones

`historical-term.ts` writes past rosters as real `TermMembership` rows against ARCHIVED terms, and
gets away with it because every roster, permission, schedule, and compliance query in the app scopes
its lookups to the ACTIVE term. An ARCHIVED membership is therefore inert by construction.

Recruitment has no equivalent invariant. Its queries scope by `cycleId`, not by cycle status.
Writing 3,531 phantom applications into `Application` would put them in reach of the applicant
queues, speed-scoring, speed-routing, waitlist, decisions, and email surfaces unless every one of
those queries learns a new exclusion rule, and a missed one is a silent correctness bug in a working
module.

The schema fights it as well. `RecruitmentCycle` requires a real `termId` (`onDelete: Restrict`) and
a `createdById`; `Application.answers` is required when we have deliberately chosen not to import
answers; and `Acceptance.approvedById` is `onDelete: Restrict` against an approver who acted in
Airtable and may have no `Person` row.

So: separate tables, never touched by live recruitment queries, unioned only in the read layer.

### 2. Schema

```prisma
enum HistoricalStage   { APPLIED ADVANCED FINAL_ROUND ACCEPTED ONBOARDED }
enum HistoricalOutcome { ACCEPTED REJECTED WAITLISTED WITHDRAWN INELIGIBLE NO_DECISION UNKNOWN }

model HistoricalApplicant {
  id           String  @id @default(cuid())
  /// Lowercased, and only when the source value passes isNetIdShaped(). The
  /// strongest join key available: stable across a student's whole Yale career.
  netId        String? @unique
  /// Display only. Matching goes through the emails relation, never this column.
  primaryEmail String
  firstName    String
  lastName     String
  /// Resolved at import and re-resolved on every re-run, so a 2024 reject who
  /// joins in 2026 retroactively gains their history. Never load-bearing: the
  /// reviewer card matches on netId/email directly, because most past applicants
  /// have no Person row at all.
  personId     String?
  person       Person? @relation("historicalApplicantPerson", fields: [personId], references: [id], onDelete: SetNull)

  emails       HistoricalApplicantEmail[]
  applications HistoricalApplication[]
  interests    HistoricalInterest[]
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([personId])
  @@index([lastName, firstName])
}

model HistoricalApplicantEmail {
  id          String @id @default(cuid())
  applicantId String
  /// Lowercased and unique ACROSS ALL applicants. The database enforces what the
  /// identity pass computes: a merge bug fails loudly on insert instead of
  /// silently splitting one person into two half-timelines.
  email       String @unique

  applicant HistoricalApplicant @relation(fields: [applicantId], references: [id], onDelete: Cascade)

  @@index([applicantId])
}

model HistoricalApplication {
  id             String @id @default(cuid())
  applicantId    String
  /// Provenance and idempotency key. Re-running the import updates in place.
  sourceBaseId   String
  sourceTableId  String
  sourceRecordId String

  cycleCode  String  // "V-FA25"
  cycleLabel String  // "Fall 2025 Volunteer Recruitment"
  track      Track
  /// Plain string, no FK. History must outlive a Term being renamed or absent.
  termCode   String?

  applicantType     ApplicantType?
  /// Hub department CODES, resolved at import. Strings rather than FKs: BVHD,
  /// SCTP, SCTS and INTP appear across the old bases and may since have been
  /// renamed or retired. A FK would either block the import or silently rewrite
  /// history when a department row is edited.
  departmentChoices String[]
  resultDepartment  String?

  furthestStage HistoricalStage
  outcome       HistoricalOutcome
  submittedAt   DateTime?
  decidedAt     DateTime?
  /// Source values no adapter could map, kept verbatim for auditing. Never rendered.
  unmappedNotes Json?

  applicant HistoricalApplicant @relation(fields: [applicantId], references: [id], onDelete: Cascade)

  @@unique([sourceBaseId, sourceTableId, sourceRecordId])
  @@index([applicantId, submittedAt])
  @@index([cycleCode])
}

model HistoricalInterest {
  id             String @id @default(cuid())
  applicantId    String
  sourceBaseId   String
  sourceTableId  String
  sourceRecordId String
  submittedAt    DateTime?

  applicant HistoricalApplicant @relation(fields: [applicantId], references: [id], onDelete: Cascade)

  @@unique([sourceBaseId, sourceTableId, sourceRecordId])
  @@index([applicantId])
}
```

`furthestStage` and `outcome` are deliberately separate columns. "Reached the final round, then
rejected" and "rejected at the paper screen" share an outcome but are very different signals, and
collapsing them loses precisely the thing this feature exists to show.

The stage ladder is `APPLIED -> ADVANCED -> FINAL_ROUND -> ACCEPTED -> ONBOARDED`. There is no
`DECIDED` stage because `outcome != NO_DECISION` already carries that. `FINAL_ROUND` is named
neutrally because it means an interview on director cycles and a second written application on
volunteer cycles; the UI labels it per track. `ACCEPTED` appearing in both stage and outcome is
mildly redundant and is what lets "accepted but never onboarded" be expressible.

Data minimization is a consequence of the outcome-trail decision and worth stating explicitly: the
import stores name, email, and NetID only. No phone numbers. Most of the people in these records
applied once and were never admitted, and they get a deliberately thin footprint.

### 3. Import pipeline

```
src/platform/airtable/import/history/
  sources.ts     Registry of the 11 sources: base id, table ids, field map, cycle
                 code/label/track/term, adapter name. Data, not code.
  types.ts       RawHistoryRow, the single shape every adapter emits.
  adapters/
    volunteer-modern.ts   SP25 SU25 FA25 SP26
    volunteer-fa24.ts     The round-split shape
    volunteer-su26.ts     Applicants / Acceptances / Contracts
    director.ts           FA24 SU25 FA25 SU26
    interest-form.ts
  departments.ts Airtable department name -> Hub department code. Pure.
  identity.ts    Union-find over netId and email edges. Pure.
  stages.ts      The stage/outcome ladder, shared with the live-era mapper. Pure.
  load.ts        Idempotent upsert keyed on (sourceBaseId, sourceTableId, sourceRecordId).
  report.ts      Dry-run report shape.
scripts/import-history.ts   --dry (default) / --apply, mirroring import-historical-term.ts
```

Package scripts `import:history:dry` and `import:history:apply`, matching the existing convention.

**Every adapter emits the same `RawHistoryRow`.** Five very different Airtable shapes collapse to
one type at the boundary, and identity, department resolution, loading, and reporting are then
written once. Adapters are pure functions from `AirtableRecord[]` to rows, so they test against
fixtures with no network and no database.

Stage derivation falls out of table membership for the modern volunteer lineage: appearing in Round
1 Selections means ADVANCED, in Round 2 Applications means FINAL_ROUND, in Final Decisions with
`ACCEPTED?` set means ACCEPTED. The director lineage derives the same ladder from its Interviews and
Final Decisions tables.

Two cycles need a documented deviation inside their adapter rather than a separate adapter:

- **V-SP26** has an empty Final Decisions table; its outcome lives inline on Round 1 Applications
  (`ACCEPTED?` checkbox, `Department`, `FD Decision` lookup).
- **D-SU26** has no Final Decisions or Candidate Evaluations table. It carries Acceptances
  (`tblqM7b0f5srEmbBw`) and Director Contracts (`tblLLg179HDssV8Of`) instead, so ACCEPTED comes from
  the Acceptances table and ONBOARDED from Contracts, mirroring how the V-SU26 adapter reads its own
  Acceptances and Contracts tables.

**Identity resolution is a pure in-memory pass before any write.** Extract every row from all
sources, union-find over the netId and email edges, then write. The incremental alternative has a
real bug: row 1 arrives with email A and no NetID, row 2 with email B and NetID X, row 3 with email
A and NetID X, and rows 1 and 2 must now retroactively merge. Batch union-find over the ~4,635
extracted rows (3,531 applications plus 1,104 interest responses) is cheap and, more usefully, is a
pure function testable with no database. How many distinct identities those rows collapse to is not
known until the dry run reports it.

NetID extraction reuses `isNetIdShaped` from `src/platform/auth/match-person.ts`, the single
definition already shared by the login path and the other importers.

**The dry run is the safety artifact.** Per source: counts by stage and outcome, every unmapped
department name, every unmapped status value, rejected NetIDs, and the identity summary of N rows
collapsing to M people with the multi-cycle ones listed. Nothing is written until that report has
been read. The import never deletes, and re-running upserts.

### 4. Read model

`src/modules/recruitment/services/history.ts` exposes
`getApplicantHistory({ netId, emails, personId })`, returning one timeline that unions two eras:

- **archive entries** from `HistoricalApplication` and `HistoricalInterest`
- **live entries** derived from `Application` / `Interview` / `Acceptance` / `OnboardingContract`
  for cycles that ran in the Hub

Both eras pass through the same `toStage()` mapper in `stages.ts`, so an FA25 Airtable row and a
future FA27 Hub row render identically and sort into one list. That is what makes the feature age
well: as cycles move into the Hub they join the timeline automatically, with no second import and
no code change. Live entries carry an `href` to the real application; archive entries do not,
because there is nothing deeper to open.

### 5. Surfaces

One component, `<ApplicantHistory />`, mounted three times.

**Reviewer card**, on `/recruitment/cycles/[id]/applicants/[applicationId]`, under the header and
above the form sections, because it is context for reading the answers rather than a footnote to
them.

```
Past applications
3rd application. Furthest: Round 2 (Fall 2025).

Fall 2025     Volunteer   BVHD, SCTP      Round 2 · Rejected
Spring 2025   Volunteer   SCTS            Applied · Rejected
Sep 2024                  Interest form
```

The summary line carries most of the value. The card renders even when empty ("First application,
no earlier record"): a missing card is ambiguous between "new applicant" and "something failed to
load", and confirming a genuine first-timer is itself useful. Badges stay neutral per
[[status-toast-label-restyle]]. The current application is excluded from its own history.

Access follows the page's existing gate (`reviewScope` plus `canViewApplication`). No new
permission, and no path by which the card is visible to someone who cannot already open the
application.

**Person profile**, on `/admin/people/[id]`, same component fed by `personId`, titled "Recruitment
history". Gated by that page's existing `admin.manage_people`.

**History browser**, at `/recruitment/history`, searching name, email, and NetID across every
imported identity, with a detail page at `/recruitment/history/[applicantId]` showing the full timeline and
every known email so a wrong merge is visible and diagnosable. Gated on the existing
`recruitment.access` rather than a new permission: the audience is the recruitment staff who already
hold it, and a new permission would require a GitBook adaptive-access schema change
([[gitbook]]). Added to the recruitment `ModuleNav`, which the 1280px e2e nav width guard covers
([[nav-width-guard-is-e2e]]).

## Testing

Pure units, no network and no database: adapters against hand-written fixtures (synthetic and
modeled on the real shapes, never copied from Airtable, so no real applicant PII lands in the repo);
the identity union-find including the three-row retroactive merge case; the stage and outcome mapper
for both eras; department name resolution including the unmapped path.

Against the test database: `load.ts` idempotency (run twice, assert identical counts), and the
history service's union across both eras.

E2E: the reviewer card rendering past applications, and history browser search. The full Playwright
suite is the only thing that really guards UI flows here ([[e2e-covered-flows-not-run-locally]]).

## Rollout

1. Migration and models. The `String[]` columns need the `ARRAY[]::TEXT[]` default fix-up
   ([[prisma-migrate-dev-drift]]).
2. Import module with adapters, plus the script.
3. Dry run, reviewed with ops before anything is written.
4. `--apply`.
5. The three surfaces.

The migration lands before the UI branch, because preview deploys share the production database and
a branch behind a migration crashes with P2021 ([[preview-deploys-share-prod-db]]).

## Open item

The Airtable PAT returns 403 on V-SP26's Round 2 tables and D-SU26's Candidate Evaluations. Those
two cycles will import with their applications and final outcomes but without mid-funnel stage
detail until that access is granted. This does not block the build; it should be resolved before the
production `--apply` run.
