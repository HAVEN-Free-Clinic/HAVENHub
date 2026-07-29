# Task 2: Seeded-state baseline and fixture gap table

Recorded 2026-07-28 against `havenhub_uxaudit` (localhost:5434). Verified
`DATABASE_URL`/`DATABASE_URL_UNPOOLED` pointed at `localhost:5434/havenhub_uxaudit` before
running anything (Prisma CLI does not auto-load `.env.local`, per Task 1).

## Row counts (actual output)

```json
{
  "person": 3,
  "termMembership": 3,
  "hipaaCertificate": 3,
  "recruitmentCycle": 0,
  "applicant": 0,
  "application": 0,
  "acceptance": 0,
  "course": 0,
  "courseProgress": 0,
  "shiftAssignment": 0,
  "shiftRequest": 0,
  "incidentReport": 0,
  "techRequest": 0,
  "notification": 0,
  "training": 0,
  "onboardingContract": 0
}
```

Matches the brief's expectation exactly: `person: 3`, `hipaaCertificate: 3`, everything from
`recruitmentCycle` on is zero. Term SU26 is ACTIVE with 18 Saturday clinic dates (confirmed in
Task 1, not re-queried here). Seed departments exist, including `VADM` (Vaccine Administration,
`requiresEpicVolunteer: "ALL"`) and `ITCM`. `dev.volunteer@yale.edu` is a VOLUNTEER-kind member of
VADM in SU26; `dev.director@yale.edu` is a DIRECTOR-kind member of VADM.

## Gap table: ten tier-1 journeys

| # | Journey | DB state needed | Exists now | Creatable locally | Recommended fixture |
|---|---|---|---|---|---|
| 1 | Applicant applies (`/apply`, sign-in, wizard, submit, status tracker) | An OPEN `RecruitmentCycle` with a rendering form; a DRAFT `Application` for the resume-draft sub-path | No (`recruitmentCycle`, `applicant`, `application` all 0) | Yes | Cycle slug `ux-audit-cycle` (matches contract) + `ux.applicant@yale.edu` with a saved draft (matches contract). Cold-walk sign-in step genuinely needs the magic-link workaround below (see "Blocked items verified"). |
| 2 | Accepted applicant onboards (contract blocks, agreements, signature, Epic provisioning, completion) | An `Acceptance` row and its 1:1 `OnboardingContract` (token, PENDING) for the applicant | No (`acceptance`, `onboardingContract` both 0) | Yes | `ux.accepted@yale.edu` (matches contract). See "Fixture-contract notes" below: the real entry points are `decideInterview` (`src/modules/recruitment/services/interview-decisions.ts`) to mint the `Acceptance`, then `createOrResendContract` (`src/modules/recruitment/services/onboarding.ts:114`) to mint the `OnboardingContract` -- neither is in Task 3's own Step-1 reading list. Route the acceptance into VADM (not ITCM) so Epic provisioning is actually observable (VADM `requiresEpicVolunteer: "ALL"`; ITCM requires none). |
| 3 | New volunteer first login (`/get-started` gate, dashboard, clearance card, action feed) | A Person with no verified HIPAA cert and no phone, so the onboarding gate fires | No (all 3 seeded people are cert-verified; director/volunteer also have phones) | Yes | `ux.fresh@yale.edu` (matches contract) |
| 4 | Volunteer clears compliance (cert upload, completion-date entry, verification-pending state) | One person with nothing on file (to walk the upload) and one with an unverified cert (to see the pending state) | No | Yes | `ux.fresh@yale.edu` for the upload walk, `ux.pending@yale.edu` for the pending state (both match contract). Cert upload goes through `putObject` (`src/modules/my-info/services/my-info.ts`), which falls back to local disk with no `BLOB_READ_WRITE_TOKEN` -- not a blocked path, confirmed by reading `src/platform/storage.ts`. |
| 5 | Learning and training (`/learning` list, SCORM player, completion; `/training` quiz, makeup gating) | A `Course` assigned to VADM with an actually-ingested SCORM package (`scormEntryHref` set); a `RecruitmentCycle` designated as SU26's VOLUNTEER training cycle with quiz questions and an `inPersonTrainingDate` | No (`course` 0, `recruitmentCycle` 0, so no term-training cycle exists for any track) | Yes, more fully than the brief implies -- see "Blocked items verified" | `UX Audit Course` (matches contract) **but must include a real ingested SCORM 1.2 package**, not just a bare `Course` row -- `coursesForMember` (`src/modules/learning/engine/assignment.ts:51`) hard-excludes any course where `hasPackage` is false, so a package-less course is invisible on `/learning`, not just missing its player. **Gap the contract does not cover:** the `/training` quiz walk needs `ux-audit-cycle` (or another cycle) marked `isTermTraining=true` for `(SU26, VOLUNTEER)` via `setTrainingCycle`, plus `updateQuizSettings` with a past `inPersonTrainingDate` so `makeupOpen` is true. Without this, `/training` renders "Training opens soon" and the quiz never appears, for every existing person including `dev.volunteer@yale.edu`. Quiz questions themselves are already covered: `createCycle(..., seedDefaultForm=true)` seeds the QUIZ-purpose section from `src/modules/recruitment/templates/quiz.ts`. |
| 6 | Schedule (`/schedule`, `/schedule/full`, `/schedule/requests`) | Published `ShiftAssignment` rows for `dev.volunteer@yale.edu` across SU26 Saturdays | No (`shiftAssignment` 0) | Yes | Matches contract exactly. Minor observation, not a blocker: a single volunteer's assignments make `/schedule/full`'s "can I find my own row" test close to trivial since there is only one row per date. Worth noting in Task 7's findings if the table reads as more scannable than it would with realistic multi-volunteer density, but not worth a second fixture for this audit. |
| 7 | Reports a concern (`/incidents`, `/incidents/mine`) | One existing `IncidentReport` for `dev.volunteer@yale.edu`, to evaluate an existing report's legibility (filing a fresh one needs no pre-existing state) | No (`incidentReport` 0) | Yes | Matches contract |
| 8 | Tech request (`/support/new`, `/support`) | One existing `TechRequest` for `dev.volunteer@yale.edu` | No (`techRequest` 0) | Yes | Matches contract |
| 9 | Clinic tools (`/clinic/avs`, EN/ES) | None. AVS is a client-side, ephemeral, zero-PHI PDF generator with no stored state. | N/A | N/A | No fixture needed. The 8-item contract correctly has no entry for this journey; confirmed by reading the AVS generator's design (memory: "ephemeral client PDF, zero PHI"). Walkable today with any existing persona. |
| 10 | Notifications (bell, `/notifications`) | Three `Notification` rows for `dev.volunteer@yale.edu`, read/unread mixed | No (`notification` 0) | Yes | Matches contract |

## Blocked items verified (not just copied from the brief)

### Magic-link email delivery -- corrected, not fully blocked

The brief says the token "can be read from `MemberLoginToken` or `ApplicantPortalToken`
directly instead." **That is not quite right and would not work as stated.** Both models
(`prisma/schema.prisma:1729` and `:1744`) store only `tokenHash` (SHA-256), never the raw
token -- confirmed by reading `issueMagicToken`/`issueMemberToken`
(`src/modules/recruitment/services/portal-auth.ts`, `src/platform/auth/member-magic-link.ts`).
The raw token exists only in the URL embedded in the rendered email body.

Two corrections:

1. **Delivery is not actually gated on `/api/cron/email` locally.** `queueEmail` schedules an
   immediate post-response drain via Next's `after()` (`src/platform/flush-on-enqueue.ts`), so
   inside the real dev server a queued email drains to `SENT` (via `LogTransport`, since
   `EMAIL_TRANSPORT` is unset and defaults to `"log"`) within about a second of the request that
   enqueued it. `/api/cron/email` is a 30-minute safety-net backstop, not the primary path, and
   is bearer-token gated (`CRON_SECRET` is unset in this `.env.local`, so hitting it manually
   would need that set first) -- but it should not be needed at all for a manual walk.
2. **`LogTransport.send()` only logs `from`/`to`/`subject`, never the HTML body**
   (`src/platform/email/transport.ts:71-76`), so the raw link is not recoverable from server
   logs either. The correct place to read it is `EmailLog.html` (or `EmailLog.subject`), the
   rendered body persisted at enqueue time regardless of transport, filtered by
   `template: "recruitment.portal_link"` (applicant) or `template: "auth.member_login_link"`
   (member), most-recent row for the target email. Task 4 should extract the token from the URL
   query string in that HTML with a regex, not query the token tables.

Net effect: Journey 1's cold-walk sign-in step is walkable, just not the way the brief
describes. No fixture is needed for this -- it is a read-workaround for Task 4 to apply live
against whatever cycle/draft fixtures exist.

### SCORM package upload -- Blob storage is NOT a blocker locally; corrected

The brief says SCORM upload "depends on Blob storage plus a real package zip." **Blob storage
specifically is not required anywhere in this environment**, confirmed by reading
`src/platform/storage.ts`: `usingBlobStorage = Boolean(process.env.BLOB_READ_WRITE_TOKEN)`,
which is `false` here (`.env.local` sets no such var, and `.env.example` does not even mention
one), and every general upload path (`putObject`/`getObject`, used by HIPAA certs, application
files, incident/support attachments, and SCORM file storage after ingestion) falls back
transparently to local disk under `config.UPLOAD_DIR`.

The one path that hardcodes real Vercel Blob is the *direct-to-Blob client upload* route
(`src/app/api/learning/blob-upload/route.ts`, using `@vercel/blob/client`'s `handleUpload`),
used only to get large SCORM zips around the 4.5 MB serverless body limit on Vercel. But
`UploadPackageForm.tsx` (`src/app/(app)/learning/manage/[courseId]/UploadPackageForm.tsx:44-50`)
branches on `usingBlobStorage` and renders a plain `ServerActionUploadForm` instead when it is
false -- a normal multipart server-action upload with no Blob involvement and no body-size limit
locally. That form calls `uploadPackageAction` -> the SCORM ingestion service
(`src/modules/learning/services/packages.ts`), which unzips the package and writes every file
via `putObject` (disk fallback). The read-back route
(`src/app/(app)/learning/play/[courseId]/[...path]/route.ts`) uses `getObject`, same fallback.

Net effect: the SCORM upload-and-play loop is fully walkable locally through the real UI,
end to end, once signed in as someone holding `learning.manage_courses` (e.g.
`dev.director@yale.edu`, who should be checked for that permission) with a real SCORM 1.2 `.zip`
in hand. **The only genuine local blocker is sourcing that zip file itself** -- a test asset, not
an infrastructure gap. Recommend Task 3 build or source a minimal valid SCORM 1.2 package
(`imsmanifest.xml` + one HTML page is enough) and ingest it through the real upload path (either
driving the UI once, or calling the ingestion service directly) so `scormEntryHref` gets set --
required regardless, per the `hasPackage` gate noted in the journey-5 row above.

### Yale SSO -- confirmed genuinely absent locally, as claimed

Verified by reading `src/platform/auth/auth.ts:63-66`: the `MicrosoftEntraID` NextAuth provider
is only added when `config.AZURE_AD_CLIENT_ID` is truthy (`...(config.AZURE_AD_CLIENT_ID ? [...]
: [])`). `.env.local` sets none of `AZURE_AD_CLIENT_ID`/`AZURE_AD_CLIENT_SECRET`/
`AZURE_AD_TENANT_ID`, so the provider is entirely absent from the auth config -- there is no
Entra redirect to fail, the "Sign in with Yale" button (present in `src/app/apply/page.tsx` and
elsewhere) would call `signIn("microsoft-entra-id")` against a provider that does not exist.
This matches Task 1's own observation that only the "Local development" dev-sign-in form
appeared on `/login`. Credential/dev-sign-in login substitutes for every fixture persona, all of
which are `@yale.edu` addresses reachable through it. No further action needed; this one is
correctly described in the brief.

## Fixture-contract notes (Task 3 will follow this table)

The plan's 8-item fixture contract (`docs/superpowers/plans/2026-07-28-ux-audit-flow-friction.md`,
Task 3 section) is **mostly right and should stand as-is for 6 of 8 rows.** Two corrections and
one addition:

1. **Agree, no change:** `ux.fresh@yale.edu`, `ux.pending@yale.edu`, cycle `ux-audit-cycle`,
   `ux.applicant@yale.edu`, `ux.accepted@yale.edu`, and the incident/tech-request/notification
   trio for `dev.volunteer@yale.edu` are all correctly scoped and are the minimum needed for
   their journeys.
2. **`UX Audit Course` needs one more requirement than stated:** it must ship with an actually
   ingested SCORM package, not just exist as a `Course` row assigned to VADM, or it is invisible
   on `/learning` (see journey 5 above). This is not a new fixture, just a stricter definition of
   the existing one.
3. **Missing fixture: a designated training cycle for `(SU26, VOLUNTEER)`.** Nothing in the
   8-item list wires up `isTermTraining`/`inPersonTrainingDate`, so `/training` cannot be walked
   by anyone, including the already-seeded `dev.volunteer@yale.edu`, without it. Recommend
   reusing `ux-audit-cycle` for double duty (mark it the training cycle after creating it for
   Journey 1) rather than adding a ninth named fixture -- it already gets the quiz template for
   free via `seedDefaultForm=true`.
4. **Task 3's Step-1 reading list omits the files needed for the `ux.accepted@yale.edu`
   fixture.** It lists `cycles.ts`, `submissions.ts`, `drafts.ts`, `courses.ts`,
   `builder.ts`/`publication.ts`, but the real entry points for minting an `Acceptance` and its
   `OnboardingContract` are `decideInterview`
   (`src/modules/recruitment/services/interview-decisions.ts`) and `createOrResendContract`
   (`src/modules/recruitment/services/onboarding.ts:114`). Recommend Task 3 add these two files
   to its own reading list.
5. **Plan defect, not a fixture gap: Task 8 Step 5 cannot use `ux.fresh@yale.edu` for the
   empty-state check.** The plan says "Sign in as `ux.fresh@yale.edu` and visit
   `/incidents/mine`, `/support`, and `/notifications` with no rows." But `ux.fresh@yale.edu` is
   deliberately uncleared (no cert, no phone), and the onboarding gate
   (`src/platform/auth/session.ts:33-67`, `enforceOnboarding`) redirects every non-allowlisted
   `(app)` path to `/get-started` for an uncleared person -- confirmed these three paths are
   ordinary module pages, not allowlisted, and per existing project memory the gate is never
   supposed to allowlist an `(app)` path. `ux.fresh@yale.edu` can never reach any of those three
   pages. **Recommend Task 8 use `dev.director@yale.edu` instead**: already onboarded (cert +
   phone from the base seed), and -- because Task 3's fixture plan only adds the incident/tech
   request/notification trio to `dev.volunteer@yale.edu`, not the director -- `dev.director@yale.edu`
   naturally stays at zero rows for all three models after fixtures run. No new fixture required,
   just a persona swap in Task 8's own steps.

## Self-review

- All ten journeys covered, including the two (9, none needed; 6, contract already correct)
  that did not need a correction.
- Row counts above are real `tsx` output against `havenhub_uxaudit`, not estimated. Command run
  from the worktree root with `DATABASE_URL`/`DATABASE_URL_UNPOOLED` exported to
  `postgresql://haven:haven_dev@localhost:5434/havenhub_uxaudit` (verified before running).
- Every "needs a fixture" row names a concrete identifier Task 3 can use, and every correction
  above cites the exact file(s) read to verify it, not a heuristic guess.
- All three named "known-blocked" items were independently verified by reading the actual code
  paths (env resolution, transport, storage abstraction, auth provider wiring) rather than
  copied as given. Two of the three turned out to be less blocked, or blocked for a different
  reason, than stated; the corrections above are load-bearing for Tasks 4-8.
- No em-dashes used anywhere in this file.
