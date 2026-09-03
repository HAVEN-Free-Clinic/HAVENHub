# Language score unification and historical badge backfill

Date: 2026-09-03
Status: approved, ready for implementation

## Problem

Two gaps, one cause: a Spanish proficiency score only exists for people who are
active members of the interpreting department.

**1. The historical assessment list produces no badges.**
`scripts/import-spanish-assessments.ts` loaded `SpanishAssessmentRecord` back to
Spring 2012 and deliberately writes nothing to `PersonLanguage`: "verified is
decided in Hub by a reviewer, never by the import." That was the right call for
an import, but nobody has since carried those decisions across. An active
volunteer INTP scored a 5 in Fall 2024 has a history row and no badge, so the
Full Schedule roster, the RHD capacity count, and the service record all treat
them as someone who does not speak Spanish.

**2. The queue is split, and only one half gets scored.**
`listLanguageReviewQueue` stamps `isIntp` from active-term INTP membership, and
the review page splits on it into an "INTP assessment queue" that records a 1-5
score and a "General language verification queue" whose own help text reads "No
score is recorded here." Everyone outside interpreting is therefore verified as
a bare yes/no and never gets a number.

The consequence is the one ops raised: a department that would happily staff a
conversational speaker cannot, because there is no score to compare against its
bar. The machinery for that comparison already exists and is unused for most
people. `Department.minInterpreterScore`, `interpreterBarFor()` and
`meetsInterpreterBar()` are all in place, and `capability-badges.tsx` already
measures a Spanish speaker against the bar of the department staffing them. The
only missing input is the score itself.

## Non-goals

- No schema change. `PersonLanguage.score`, `SpanishAssessmentRecord` and
  `Department.minInterpreterScore` already exist and are sufficient.
- No change to recruitment routing. Routing is percentile-based per cycle and
  language is not part of it. Removing the split is what lets a director place a
  low scorer in a lower-bar department; teaching the router to do it
  automatically is separate work nobody has asked for.
- No change to `spanish_proficiency` on the application. It stays a
  self-reported intake signal and never produces a badge.
- The score stays INTERNAL. Nothing here surfaces it on `/my-info`.

## Design

### 1. Backfill badges from the assessment history

The logic lives in `src/platform/languages/badge-backfill.ts`; the script
`scripts/backfill-language-badges.ts` is a thin CLI wrapper over it, wired as
`backfill:langbadges:dry` and `backfill:langbadges:apply` in `package.json`.
Nothing in `scripts/` has a test in this repo, and this is the same mistake
`spanish-assessments.ts` was extracted to fix: logic that lives only in a
top-level entry point cannot be tested at all.

For every `Person` with `status = ACTIVE` that has at least one linked
`SpanishAssessmentRecord`, take **the most recent record that carries a score**,
by `(termRank desc, createdAt desc)` (the ordering `latestSpanishAssessment`
already uses), and write their Spanish `PersonLanguage` row.

Deliberately "most recent scored" rather than "most recent": a person scored 4 in
2018 and then assessed in 2024 with no number written down should be badged from
the 2018 number, not skipped. A scoreless later row records that an assessment
happened, not that the earlier score was withdrawn.

Outcome by score, using the floor already documented in `catalog.ts`, where 1-3
is conversational and 4 is the clinic-wide interpreting bar:

| Latest score | `verified` | `verifiedAt` | Note |
| --- | --- | --- | --- |
| 3, 4, 5 | `true` | stamped | Badge. A 3 is conversational; each department's `minInterpreterScore` decides whether it staffs one. |
| 1, 2 | `false` | stamped | A real assessment that settles the question. No badge, and they leave the queue rather than being re-reviewed forever. |
| `null` | untouched | untouched | Skipped. See below. |

`score` is written from the record in every case, including 1-2, so the number
is on file even when the outcome is "no".

**People with no scored record at all are skipped entirely.** Older list rows
often record that an assessment happened without a number. Verifying those would
manufacture exactly the population `listSpanishFlagMismatches` exists to flag
(`reason: "no-assessment"`), so the script touches nothing and reports the count
instead.

**Never reverse a human decision.** Where a `PersonLanguage` row already has
`verifiedAt` set, a reviewer has ruled and that ruling stands: the script writes
only `score`, and only where it is currently `null`. Where `verifiedAt` is null,
the script writes the full outcome above.

**Unlinked records are skipped and counted.** `SpanishAssessmentRecord.personId`
is nullable, and rows the list identified by name alone may never have matched a
Hub account. The dry run reports how many, and the existing history-tab linking
UI is how INTP resolves them. The script never guesses at a match.

Re-runnable by construction: every write is an upsert keyed on
`(personId, language)`, and the "never reverse" rule means a second run after
reviewers have worked the queue is a no-op on everything they touched.

Dry run reports, at minimum: people badged, people settled as not-verified,
scores filled into already-assessed rows, scoreless records skipped, unlinked
records skipped, and inactive people skipped.

### 2. Delete the INTP/general split

`src/platform/languages/index.ts`:

- Drop `isIntp` from `LanguageReviewRow` and from `listLanguageReviewQueue`.
- Drop the `INTP_DEPARTMENT_CODE` constant and the `memberships` sub-select with
  its active-term lookup. The queue read no longer needs `getActiveTerm` (it is
  still needed by `recordLanguageAssessment`, so the import stays).

`src/app/(app)/volunteers/spanish-review/page.tsx`:

- Replace the two sections with one queue table, rendering the score control for
  every Spanish row via `AssessForm withScore={r.language === SPANISH}`. That
  prop already exists and already does the right thing; only the caller changes.
- The section copy stops saying interpreting membership decides anything. New
  framing: everyone who claims a language is assessed, Spanish carries a 1-5
  score, and departments differ on what they staff.
- The `Current score` column, previously INTP-only, applies to the whole queue.

`recordLanguageAssessment` is unchanged. Its tri-state `score` (omitted / null /
1-5) is still load-bearing: non-Spanish languages carry no score, and the
Not-verified button submits no score field.

Four tests in `src/platform/languages/index.test.ts` assert `isIntp` and go with
the split. The behaviour they guarded (a stale INTP membership must not follow
someone forever) stops existing when nothing branches on membership.

### 3. `ES` and `ES+` on the roster badge

`src/modules/schedule/components/capability-badges.tsx` renders a bare `ES`
today, appending the score only when it is below the staffing department's bar.
Add the requested tier on top, without disturbing the below-bar mark:

| Condition | Text | Tone |
| --- | --- | --- |
| Below this department's bar | `ES 3` | `warning` |
| Score 5 | `ES+` | `brand` |
| Score 3-4, or verified with no score | `ES` | `brand` |

The below-bar case wins over the tier: it already shows the exact number, so a
`+` on top would be noise. This only affects Spanish; every other language keeps
its bare code.

The accessible name follows the text. `ES+` reads "Verified: Spanish, assessed 5
(Native)", reusing `spanishProficiencyLabel`. The existing sr-only and `title`
structure is unchanged, so the audit-14 fix that made the badge meaning reachable
without a mouse stays intact.

## Measured impact

Read-only aggregates against the production Neon branch (`floral-dawn-97522801`)
on 2026-09-03. 745 people, 374 of them ACTIVE. Active term is Summer 2026.

**Today, exactly one person clinic-wide carries a verified Spanish badge**, and
their `PersonLanguage.score` is null. 51 claims sit unassessed in the queue.

Backfill, over the 69 ACTIVE people who have a linked scored record:

| Latest score | People | Outcome |
| --- | --- | --- |
| 5 | 40 | badge |
| 4 | 9 | badge |
| 3 | 12 | badge |
| 2 | 8 | settled as not-verified, score recorded |
| 1 | 0 | none |

So **61 badges granted where there is currently 1**, and 27 of the 51 queued
claims are resolved outright, leaving about 24 that genuinely need a human.

Two measurements that change the plan:

- **Every linked record carries a score.** `linked = linked_scored` in all
  fifteen years. The scoreless-row rule is correct to keep as a guard, but it
  affects nobody today.
- **1423 of 1567 records are unlinked, and matching is exhausted.** Not one of
  them matches any `Person` by email, by name, or by email local-part against
  `netId`. Linkage concentrates in 2024-2026 (29/45, 57/98, 17/67) and is
  essentially zero before 2019, which is the expected shape: the list starts in
  2012 and Hub only knows people who are still around. They are alumni, not a
  backlog. Nothing is gained by linking before the apply run.

Of the 8 people scored 1-2, none currently has a Spanish `PersonLanguage` row, so
the backfill creates one for them recording the "no". That is deliberate (it is a
real assessment result, and it keeps them out of a queue they would otherwise
re-enter), but it does mean a later self-reported claim from those 8 will not
raise them for review. Re-assessment goes through the history tab, as it does for
anyone else assessed "no".

**Those 8 people will see the change on their own `/my-info` page**, where
`languages-panel.tsx` renders "Spanish / Not confirmed" plus the row's note. That
is accurate (INTP did assess them) and it is the state the panel exists to make
visible: its docstring says hiding it "would leave someone believing a claim they
made on their application had made them a language provider when it had not." But
it is a new negative statement to 8 real people, and unlike a live assessment
through `recordLanguageAssessment` it sends no notification, by design, because a
backfill of this size must not mail hundreds of people. Tell the interpreting
directors before the apply run so nobody is surprised by a question about it.

The note the backfill writes is member-facing for the same reason: "Recorded from
your <term> assessment with the interpreting department."

Deleting the split reaches 36 of the 51 queued claims: 15 are INTP members who
are scored today, and all 36 of the rest are Spanish claims that currently get a
bare yes/no. Every one of those 36 gains a score field.

## Testing

- `src/platform/languages/index.test.ts`: delete the four `isIntp` cases; assert
  the queue returns one flat list with scores regardless of membership.
- New `src/platform/languages/badge-backfill.test.ts` against the platform test
  DB, covering the decision table: each score band, a person whose only record is
  scoreless, a person whose latest record is scoreless but an earlier one is
  scored, an unlinked record, an already-assessed row (score filled, verdict
  untouched), an inactive person, and a second run proving idempotence.
- `capability-badges.test.tsx`: `ES+` at 5, `ES` at 3 and 4, and the below-bar
  case still winning over the tier.
- Full `vitest src/platform` before any push, per the platform-guard rule, plus
  `npx eslint src e2e`.

## Rollout

1. Merge with the split removed. The queue immediately shows a score field for
   everyone, and nothing regresses because no badge changes on its own.
2. Run `backfill:langbadges:dry` against production and check the counts against
   the table above with INTP. It should badge 61 and settle 8. A material
   difference means the data moved since 2026-09-03 and is worth understanding
   before applying.
3. Run `backfill:langbadges:apply`.
4. Re-check the Flag cross-check tab. Its `no-assessment` population should
   shrink, and `below-interpreter-bar` should grow as scores land on people who
   previously carried an unscored flag. That growth is the point: those rows were
   always true, and were invisible for want of a number.
