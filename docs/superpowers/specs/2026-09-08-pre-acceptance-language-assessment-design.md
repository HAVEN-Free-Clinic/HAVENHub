# Pre-acceptance language assessment

Date: 2026-09-08

## The problem

The interpreting department (INTP) assesses language proficiency BEFORE an
applicant to Patient Services (PATS) or Interpreting (INTP) is accepted. The
assessment is what tells the department whether the applicant can actually do
the job. Hub cannot support that today.

The language review queue is fed from exactly one place: `promotion.ts` calls
`claimLanguage()`, which writes a `PersonLanguage` row. Promotion is the LAST
step of recruitment, converting a signed onboarding contract into a `Person`.
An applicant has no `Person` row until then, and `PersonLanguage.personId` is a
required FK, so nobody can enter the queue before they have already been
accepted and onboarded.

The application form already promises otherwise. The `spanish_proficiency`
help text in `field-groups.ts` reads "Everyone selecting Conversational or
above will be invited to this assessment." The applicant-facing promise exists;
the Hub side never surfaced applicants.

Secondary gap: the queue shows a name, a language, and a NetID. A reviewer
cannot tell which cycle or department a row belongs to.

## Decisions taken

Confirmed with the requester before design:

1. Every applicant to a flagged department enters the pre-acceptance queue,
   whether or not they claimed a language. The point of the lane is to confirm
   Spanish, so Spanish is assessed regardless of what they claimed.
2. The assessment is ADVISORY. It never blocks an ACCEPT decision.
3. Any language the applicant claimed is assessed pre-acceptance, not Spanish
   alone. INTP interprets in other languages too.
4. An applicant who ticked the INTP dual-role option is in the lane as well,
   even though their primary department is elsewhere.
5. An assessment already on file is never redone. An applicant with a prior
   human verdict on a language does not appear in the queue for it. The verdict
   is still SHOWN to the deciding department; it is the reviewer's work that is
   skipped, not the information.

Everything outside the lane keeps today's behavior: claims become
`PersonLanguage` rows at promotion and are assessed afterwards.

## Where a pre-acceptance verdict lives

New model `ApplicationLanguageAssessment`, anchored on `applicationId`.
`Application` is already `@@unique([cycleId, applicantId])`, so this gives one
row per applicant per cycle per language, cascading with the application.

```prisma
model ApplicationLanguageAssessment {
  id            String      @id @default(cuid())
  applicationId String
  language      String
  verified      Boolean
  verifiedAt    DateTime    @default(now())
  verifiedById  String
  note          String?
  score         Int?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  @@unique([applicationId, language])
  @@index([language])
}
```

Rejected alternatives:

- Reuse `SpanishAssessmentRecord` keyed on email. It already supports
  `personId = null` plus an email, for alumni. But it is Spanish only, and
  decision 3 needs any language. Its `@@unique([personId, term])` does not
  constrain null-person rows, so two reviewers race into duplicate history
  rows, and no `(email, term)` unique can be added because imported rows carry
  `email = ""` in bulk.
- Create the `Person` at acceptance instead of promotion. Person creation at
  promotion is load-bearing for identity dedup, offboard convergence, and
  membership kind-swapping. Far too invasive for a queue change.

## Which departments are in the lane

`Department.assessLanguageBeforeAcceptance Boolean @default(false)`, seeded
true for PATS and INTP in `prisma/department-catalog.ts` and editable at
`/admin/departments/[id]`.

A flag, not two hardcoded codes, because departments are configurable data in
this app and `Department` already carries exactly this kind of per-department
behavior switch (`autoRouteApplicants`, `minInterpreterScore`). Defaulting
false means no other department is dragged in.

## The queue gains a second source, derived not written

No rows are created at submit. `listLanguageReviewQueue()` returns two kinds of
row:

- Member rows, unchanged: `PersonLanguage` with `verifiedAt IS NULL` and person
  `ACTIVE`.
- Applicant rows, new: applications that are IN the lane, still UNDECIDED, and
  have no verdict ON FILE, crossed with `{es}` union `languagesClaimed`.

IN the lane: `departmentChoices` union `dualRoleDepartments` union
`routedDepartmentCode` intersects a flagged department, and the cycle is not
ARCHIVED.

UNDECIDED: `status = SUBMITTED`, `withdrawnAt IS NULL`, no `Acceptance` row,
`decision = PENDING`, and no `Interview` with a decision other than PENDING.
The last two clauses are both needed and neither is redundant.
`Application.decision` carries the routed department's verdict on a VOLUNTEER
application, but a DIRECTOR-track application is decided on
`Interview.decision` instead and its `Application.decision` stays PENDING
forever. Testing only the former would leave every decided director applicant
in the queue permanently.

ON FILE: see the next section.

Deriving rather than writing rows at submit means a withdrawal, a rejection, a
reopen, or a deleted application drops out of the queue on its own, with no
cleanup path to maintain. It also means no backfill: applicants in cycles that
are already open appear the moment this ships.

## What counts as a verdict already on file

Per decision 5, an applicant is suppressed from the queue for a language when a
human has already assessed THAT PERSON on THAT LANGUAGE, whatever the outcome.
A recorded "no" settles the question exactly as it does in the member lane,
where a "no" stamps `verifiedAt` and removes the row for good.

Identity is resolved the way `getApplicantHistory` already resolves it:
`Applicant.applicantPersonId` when the applicant signed in, and
`Applicant.emailLower` otherwise. One helper,
`priorLanguageVerdicts(applicantIds)`, returns a map of
`applicantId -> language -> verdict`, reading three sources:

1. `PersonLanguage` with `verifiedAt IS NOT NULL` for the resolved `Person`.
   Deliberately NOT filtered on `Person.status`: an offboarded alum reapplying
   still has their assessment on file, and `languageReviewWhere()`'s ACTIVE
   filter is about whose worklist a MEMBER belongs on, which is a different
   question.
2. `ApplicationLanguageAssessment` on any OTHER application belonging to the
   same identity, in this or a prior cycle. This is what stops a rejected
   applicant from being re-assessed when they reapply next year.
3. `SpanishAssessmentRecord` linked to the resolved `Person`, for Spanish only.
   Assessments back to Spring 2012 live here, and `backfill-language-badges`
   only carried them onto `PersonLanguage` for ACTIVE people, so an alum's
   score exists in source 3 and nowhere else.

The 1423 unlinked historical records are NOT matched by email here. Matching
them is documented as exhausted: not one matches any Person by email, name, or
NetID. They are alumni, not a lookup source.

## Recording an applicant assessment

New `recordApplicationLanguageAssessment(actorPersonId, input)` in
`platform/languages`, beside `recordLanguageAssessment`. Same validation rules
(language code known, score an integer 1 to 5, a score only on Spanish), same
`volunteers.verify_spanish` permission, audited as
`application.language_assess`.

It does NOT notify the assessed person. `recordLanguageAssessment` emails the
member and links them to `/my-info`; an applicant has neither a `Person` nor a
`/my-info` page. The outcome reaches them through the acceptance decision.

It does NOT write `SpanishAssessmentRecord`. That table is the per-term
assessment history of PEOPLE, and an applicant may never become one. Source 2
of the on-file lookup already makes an applicant assessment durable across
cycles, so nothing is lost by leaving history alone until promotion.

## Carry-forward at promotion

`promotion.ts` already loops the union of `application.languagesClaimed` and
the contract's Spanish checkbox, calling `claimLanguage()` per code. It gains a
prior step: read the application's `ApplicationLanguageAssessment` rows, and
for each assessed language write the verdict directly onto `PersonLanguage`
(`verified`, `verifiedAt`, `verifiedById`, `note`, `score` preserved from the
original assessment) rather than an unassessed claim.

Consequences, all intended:

- An accepted PATS or INTP member is never re-queued for a language INTP
  already assessed.
- Those languages are absent from the post-promotion reviewer digest, which
  only reports newly created claims.
- Languages with no pre-acceptance assessment behave exactly as today.

The Spanish history mirror (`upsertSpanishAssessmentForTerm`) runs AFTER the
promotion transaction commits, alongside the existing notification digest, for
the same reason that digest sits outside it: the transaction must not stretch
across work that can fail independently.

## Advisory surface

A "Language assessment" `Card` on
`recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`, rendered when the
application is in the lane. Per language, one of:

- the verdict recorded for this application, with the 1 to 5 Spanish score
  rendered via `spanishScoreTone`, the assessor, and the date;
- a verdict already on file, labelled with where it came from and when, so the
  department sees the fact that spared INTP the work;
- "Awaiting assessment" when INTP has not reached it yet.

Nothing gates the ACCEPT control. Per decision 2 the department decides with
the score in front of them.

The card carries an "Assess anyway" action for a language suppressed by an
on-file verdict, gated on `volunteers.verify_spanish`. An applicant whose only
verdict is a "no" from three years ago, now claiming fluency, is exactly the
case decision 5 should not turn into a dead end. It writes an
`ApplicationLanguageAssessment` for this application, which then takes
precedence over the older verdict everywhere above.

## Cycle and department in the queue

`LanguageReviewRow` gains a `source` discriminator and a context field carrying
a cycle or term label plus department codes.

- Applicant rows: cycle title, and department choices with the routed
  department first when one is set. A dual-role offer renders as "INTP (dual)"
  so a reviewer can tell it from a primary choice.
- Member rows: the active term name and the person's `ACTIVE` TermMembership
  department codes.

One table, not two. Applicant rows sort first behind an "Applicant" badge,
because they are the ones holding up a decision. A new Cycle / Department
column carries the context for both kinds.

## Testing

- Queue composition: an applicant to a flagged department appears; one to an
  unflagged department does not; withdrawn, ARCHIVED-cycle, and accepted
  applications do not; a VOLUNTEER application with a non-PENDING
  `Application.decision` does not; a DIRECTOR application with a non-PENDING
  `Interview.decision` does not (the regression the two clauses exist for);
  an already-assessed pair does not; Spanish appears with no claim at all;
  other claimed languages appear alongside it; a dual-role INTP offer from an
  unflagged primary department appears.
- On-file suppression, one test per source: a linked Person with a verified
  `PersonLanguage`; the same with `verified = false` (a "no" also suppresses);
  an OFFBOARDED person (status must not filter it out); a prior cycle's
  `ApplicationLanguageAssessment` matched by `emailLower` with no Person at
  all; a `SpanishAssessmentRecord` for the resolved Person. And the negative:
  a `PersonLanguage` row with `verifiedAt IS NULL` is a claim, not a verdict,
  and does NOT suppress.
- `recordApplicationLanguageAssessment`: rejects an unknown language, rejects a
  score outside 1 to 5, rejects a score on a non-Spanish language, writes the
  audit row, and sends no notification.
- Promotion carry-forward: an assessed application yields a VERIFIED
  `PersonLanguage` carrying the original assessor id, timestamp, and score; it
  is absent from the reviewer digest; an unassessed language still produces a
  plain claim and still appears in the digest.
- `Department.assessLanguageBeforeAcceptance` defaults false, so an existing
  department is unaffected until someone sets it.

## Deliberately out of scope

- Notifying INTP when the pre-acceptance queue fills. Reviewers are told at
  promotion today. A digest when the application window closes would match how
  an assessment session actually gets scheduled, but the requester has not
  confirmed that is their process.
- A score chip on the decisions page as well as the application detail page.
