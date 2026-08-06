# Clearance reminder split: HIPAA, onboarding, director digest

Date: 2026-07-31

## Problem

`compliance-reminder` was built as a HIPAA certificate notice. Over time EHS
training and then the remaining onboarding items (profile, volunteer training,
director training, learning courses) were grafted onto it, so one email now
carries every unmet clearance requirement under a subject line and body that
still read as a HIPAA notice.

The result is wrong on both ends. A member whose only gap is an unfinished
learning course receives an email headed "Compliance reminder" whose first
sentence is about their HIPAA certificate. A member with a genuinely expired
certificate has that buried under a bulleted list of unrelated tasks. And the
whole bundle is paced at the HIPAA cadence (7 days), which is right for a
certificate that renews annually and far too slow for onboarding tasks a new
member should finish in their first week.

Director escalation has the same problem from the other side. It fires per
member, once per streak, at a reminder threshold, and its body inherited the
same everything-bundle.

## Goals

- `compliance-reminder` returns to being purely about the HIPAA certificate.
- A separate, faster reminder covers everything else needed to get onboarded and
  cleared.
- Directors get one predictable weekly roll-up instead of per-member escalations.
- No new external cron schedule.

## Non-goals

- Changing what clearance means or which tasks gate it. `loadClearanceMap` and
  the onboarding engine are untouched.
- Changing the candidate audience. Both member streams keep today's set: ACTIVE
  persons holding at least one ACTIVE `TermMembership` in the active term.
- Changing the notification transport. Everything still goes through `notify()`
  and is delivered by the existing email drainer.

## The three streams

### 1. `compliance-reminder` (member, HIPAA only)

Existing template key and descriptor, with the grafted-on slots removed.

- Drops the `ehsMissingList`, `hasEhsGap`, `otherItemsHtml`, and `hasOtherItems`
  variables from both the descriptor and `complianceReminderContext`.
- Keeps every status branch already in `complianceReminderContext`: the
  EXPIRING_SOON renewal nudge, the EXPIRED and NO_CERTIFICATE upload CTA, and the
  non-blaming "a coordinator will handle this, no action needed from you" copy for
  UNKNOWN_DATE and PENDING_VERIFICATION.
- Removes the `COMPLIANT` branch. That case only existed because a member with a
  current certificate but an outstanding EHS item still had to receive this
  email. With the split, a COMPLIANT HIPAA leg means no HIPAA reminder at all, and
  the `default` throw covers it.
- Cadence unchanged: `compliance.reminderIntervalDays`, 7 today.
- Stops only when `status === "COMPLIANT"`. Every other status, including
  EXPIRING_SOON, keeps the reminder flowing so the renewal nudge is preserved.

  This leg must read `status` directly and must not be derived from
  `clearance.missing`. `deriveHipaaTaskState` maps EXPIRING_SOON to COMPLETE, so
  `hipaa` is absent from `missing` for a member whose certificate expires next
  week. Driving the HIPAA leg off `missing` would silently delete the renewal
  nudge, which is the one thing this stream exists to do. Today's engine reaches
  the same outcome through `isFullyCompliant`; the split keeps that call.
- Honors the per-term step config: a term with the `hipaa` step disabled produces
  no HIPAA reminder, exactly as the current `hipaaEnabled` neutralization does.

### 2. `onboarding-reminder` (member, everything else)

New template, new notification type.

Content is exactly `ClearanceSummary.missing` with `hipaa` filtered out. Because
`loadClearanceMap` already returns `missing` as a task-key list that includes
`ehs`, the split falls along a line the data already has, and the item labels
become:

| Task key | Label |
| --- | --- |
| `profile` | Confirm your contact details in your profile |
| `ehs` | Complete your required EHS training |
| `training` | Finish this term's volunteer training |
| `directorTraining` | Finish this term's director training |
| `learning` | Complete your assigned learning courses |

For `ehs` the specific missing course names from `loadEhsMissingMap` are appended,
preserving the detail today's email gives.

- Cadence: new `onboarding.reminderIntervalDays` setting, seeded to 1.
- Stops when nothing outside `hipaa` is missing.
- Per-term step config is honored for free, since disabled steps are already
  dropped from `tasks` and therefore from `missing`.
- Grace period: suppressed until the member's earliest ACTIVE `TermMembership` in
  the active term is at least `ONBOARDING_REMINDER_GRACE_DAYS` old (constant, 2).
  A member who accepted yesterday should meet the hub through their onboarding
  link, not through a list of five things they have not done. Hardcoded rather
  than made a setting; promote it if ops asks.

### 3. `clearance-digest` (director, weekly)

New template, new notification type. Replaces `compliance-escalation`.

One email per director per ISO week, listing every member in their departments
who is not cleared. Directors are resolved the same way `sendEscalations` does
today: ACTIVE `TermMembership` rows with `kind: "DIRECTOR"` in the active term for
the relevant departments. A director covering several departments gets one email
spanning all of them. Directors with nothing outstanding are skipped, matching
`recruitment-review-digest`.

Each row carries the member's name, department, what is missing across both
streams, and how long they have been stalled (rendered from `stalledSince`).

Rows are sorted oldest `stalledSince` first, and anyone stalled longer than 21
days is visually flagged. Twenty-one days is where the retired escalation used to
fire: three reminders at the 7-day compliance interval. Preserving that boundary
is what keeps a six-week holdout from sitting undifferentiated next to someone who
joined on Tuesday, and it is the replacement for the urgency signal the per-streak
threshold carried. It is a constant, not a setting, since the setting it derived
from is being removed.

## Engine

`runComplianceReminders` becomes `runClearanceReminders(now)` in
`src/platform/email/reminders.ts`. One pass, three decisions per run instead of
one.

This is a rewrite of the existing loop, not a third scan. The function already
loads every input all three streams need: candidate memberships, persons,
certificate history, existing reminder rows, settings, `loadEhsMissingMap`, and
`loadClearanceMap`. The digest additionally needs a department-to-directors map,
loaded once for the whole run. That replaces the current per-member N+1 director
lookup inside `sendEscalations`, so the new engine does strictly less database
work than the one it replaces, which matters against the 300s `maxDuration`
budget the run already logs `elapsedMs` against.

Per-person order of operations:

1. Compute `status` (via `effectiveComplianceStatus` over the full cert history,
   preserving the early-renewal fallback) and `clearance`.
2. Neutralize disabled steps, as today.
3. HIPAA leg: if unsatisfied, apply the reachability guard, then the atomic claim
   on `lastRemindedAt`, then send.
4. Onboarding leg: if any non-`hipaa` key is missing and the grace period has
   elapsed, apply the reachability guard, then the atomic claim on
   `onboardingLastRemindedAt`, then send.
5. Stamp `stalledSince` if either leg is unsatisfied and it is currently null.
   Clear it, and reset both legs' counters, when neither leg is unsatisfied.

"Neither leg is unsatisfied" is the engine's own gate, not `ClearanceSummary.cleared`:
the HIPAA leg is satisfied at `status === "COMPLIANT"` only, whereas `cleared`
accepts EXPIRING_SOON. Reusing `cleared` here would reset the counters of a member
the engine is still actively nudging about an expiring certificate.

The reachability guard is unchanged in substance and applies independently per
leg: a member the resolved channel cannot reach (no `contactEmail` under the
"email" channel, no `entraObjectId` under "teams") is skipped without advancing
state, so an uncontactable member never looks reminded.

Both claims keep the existing `updateMany`-with-cutoff shape, which is atomic and
therefore safe against two overlapping cron runs.

The digest runs after the per-person loop, over the members the loop found to be
uncleared.

## Cron

Route stays `/api/cron/reminders`, daily at 13:00 UTC. No new external schedule.

Per `docs/cron-jobs.md`, all schedules live on cron-job.org and a dropped one
fails silently with no in-repo error, so a fourth schedule is a real liability.
The weekly digest instead derives its cadence from its idempotency claim:
`claimReminderDispatch("clearance-digest", directorId, <ISO week key>)`. The first
daily run of each ISO week wins the claim and sends; the remaining six lose it and
skip.

Two properties fall out of this. The digest lands Monday at 13:00 UTC with no
day-of-week branch anywhere in the code, and if Monday's run fails, Tuesday's run
claims the week instead. `shift-reminders`, on a hard Monday cron, silently skips
the entire week in the same situation.

`docs/cron-jobs.md` is updated: the `/api/cron/reminders` row's description
changes from "HIPAA compliance reminders and director escalations" to the three
streams, and the "what breaks" column notes that the weekly digest stops too.

## Data model

Rename `ComplianceReminder` to `MemberReminderState`, keeping
`@@map("ComplianceReminder")` so the physical table is untouched and the migration
carries no rename.

```prisma
model MemberReminderState {
  id                       String    @id @default(cuid())
  personId                 String    @unique
  remindersSent            Int       @default(0)
  lastRemindedAt           DateTime?
  onboardingRemindersSent  Int       @default(0)
  onboardingLastRemindedAt DateTime?
  stalledSince             DateTime?
  person                   Person    @relation(fields: [personId], references: [id], onDelete: Cascade)

  @@map("ComplianceReminder")
}
```

Added: `onboardingRemindersSent`, `onboardingLastRemindedAt`, `stalledSince`.

Dropped: `escalatedAt` (the threshold escalation it guarded is gone) and
`lastStatus` (written but never read outside `reminders.test.ts`).

### Backfill

The migration sets `onboardingLastRemindedAt = lastRemindedAt` and
`stalledSince = lastRemindedAt` for every existing row.

Without it, the first run after deploy sees a null `onboardingLastRemindedAt` on
every row and sends an onboarding email to every uncleared member regardless of
when they last heard from the HIPAA stream, a one-time double-tap on exactly the
population already receiving the most email. The backfill also gives the first
digest a real `stalledSince` per member instead of showing everyone as newly
stalled.

## Retirements

- `compliance-escalation`: template descriptor, `complianceEscalationContext`,
  `ComplianceEscalationParams`, notification registry entry, golden test, and the
  `sendEscalations` helper.
- `compliance.escalationThreshold`: settings registry entry and the
  `COMPLIANCE_ESCALATION_THRESHOLD` env var in `src/platform/config.ts`.

Historical escalation emails stay visible in `/admin/email` because that filter
derives from distinct `EmailLog.template` values, not from the registry. An admin
who had customized the escalation body keeps an orphaned `EmailTemplate` row that
the admin UI no longer lists; harmless, and no other code reads it.

## New configuration

- `onboarding.reminderIntervalDays`: settings registry entry, category
  "Operations", positive integer, `envDefault: () => config.ONBOARDING_REMINDER_INTERVAL_DAYS`.
- `ONBOARDING_REMINDER_INTERVAL_DAYS`: env var in `src/platform/config.ts`,
  default `"1"`, validated positive and finite, matching the shape of
  `COMPLIANCE_REMINDER_INTERVAL_DAYS`.

## New registry entries

Notification types (`src/platform/notifications/registry.ts`), both
`defaultChannel: "email"` with Teams card copy:

- `onboarding-reminder`, label "Onboarding reminder"
- `clearance-digest`, label "Clearance digest (directors)"

Template descriptors, both `category: "transactional"`. `onboarding-reminder`
joins `group: "compliance"` alongside the HIPAA templates; `clearance-digest`
does too, so all clearance mail stays grouped in the admin UI.

Note that `clearance-digest` is a per-director roll-up whose body needs to iterate
member rows, and the template engine supports only `{{#if}}`, `{{var}}`, and
`{{{raw}}}` with no `{{#each}}`. The rows are therefore pre-rendered into a
`{{{ memberRowsHtml }}}` slot by the context builder, the same technique
`otherItemsHtml` uses today.

## Testing

`src/platform/email/reminders.test.ts` is restructured around the three streams:

- HIPAA reminder body contains the certificate copy and no EHS or onboarding
  items.
- Onboarding reminder body contains exactly the non-`hipaa` missing keys, with
  EHS course names appended.
- A member missing only `hipaa` receives one email, not two. A member missing only
  `learning` likewise.
- Disabled `hipaa` and `ehs` steps neutralize their legs in both streams.
- The reachability guard skips per leg without advancing state.
- The grace period suppresses a member whose earliest ACTIVE membership is younger
  than the constant, and releases them once it is not.
- Repeated same-day runs send one of each (both claims hold).
- Repeated daily runs across a week send exactly one digest per director, and the
  following ISO week sends a second.
- A director in two departments gets one digest covering both.
- A fully cleared member has both counters and `stalledSince` reset.

Golden tests for `onboarding-reminder` and `clearance-digest` follow the existing
`compliance.golden.test.ts` pattern. `compliance.golden.test.ts` loses its
`compliance-escalation` cases and its HIPAA cases are updated for the removed
slots.

`src/platform/settings/service.test.ts` drops its `compliance.escalationThreshold`
assertion and gains one for `onboarding.reminderIntervalDays`.
`src/platform/notifications/registry.test.ts` is updated for the retired and added
types.

No e2e coverage: cron routes are not exercised by the Playwright suite.

## Consequences

Email volume rises for the persistently stalled. A member missing three things
receives roughly one email a week today and roughly seven after this change, plus
a weekly line in their director's digest. That is the intent of the split, and
`onboarding.reminderIntervalDays` is the dial if production says otherwise.

Directors trade immediacy for predictability. They no longer learn within a day
that a specific member crossed a threshold; they learn every Monday who is
outstanding and for how long. The `stalledSince` sort and the flag are what carry
the urgency the threshold used to.
