# Weekly Shift Reminders — Design

**Date:** 2026-07-09
**Status:** Approved design, ready for implementation plan

## Summary

A weekly email that reminds every volunteer, director, and shadow scheduled for the
upcoming Saturday clinic day that they are on the schedule, with their role,
department, the clinic date, the leadership on shift, and the standard pre-shift
links. It sends **Monday morning** for that same week's Saturday. The email body is an
**editable template** managed from `/admin/email/templates`, following the existing
descriptor + `EmailTemplate` override pattern. Content is generated **per person** from
the schedule builder's source of truth (`ShiftAssignment`), so campaigns (which can only
personalize `firstName`/`name`) are not usable; instead this mirrors the proven
`runComplianceReminders()` → `/api/cron/reminders` reminder-job pattern.

## Goals

- Remind everyone with a shift on the coming Saturday, personalized with their role,
  department, and the date.
- Name the **Executive Directors on shift**, the recipient's **department directors on
  shift**, and the **Clinical Advisors on shift** — derived from who is actually placed
  on the schedule for that date.
- Link to this week's Teams channel (where the morning-meeting Zoom link lives), plus the
  standard HIPAA/compliance, shift-swap, and master-schedule destinations.
- Let an admin edit the wording and static links without a deploy.

## Non-goals

- No storing of a raw Zoom URL. The email links to *this week's Teams channel* (matching
  the source template's own wording); the Zoom link lives inside that channel.
- No per-department or per-cycle template overrides. One global editable template.
- No new per-day data-entry surface. All dynamic values come from data already in the Hub
  (`ShiftAssignment`, `Term.clinicDates`, `EXEC`/`PCAR` departments, the live Teams
  channel lookup).
- No changes to the schedule builder itself.

## Data sources (all already in the Hub)

| Email field | Source |
|---|---|
| `firstName` | recipient `Person.firstName` |
| role (Director / Volunteer / Shadow) | `ShiftAssignment.role` (`ShiftRole` enum) for the recipient |
| department | recipient's assignment `Department.name` |
| clinic date | upcoming Saturday from `Term.clinicDates` (noon-UTC anchored, compared by `isoDateKey`) |
| EDs on shift | `ShiftAssignment` rows for that date where `department.code = "EXEC"` (seeded "Executive Directors") |
| department directors on shift | `ShiftAssignment` rows for that date where `role = DIRECTOR`, scoped to the recipient's department(s) |
| Clinical Advisors on shift | `ShiftAssignment` rows for that date where `department.code = "PCAR"` (seeded "Primary Care Clinical Advisors") |
| this week's Teams channel link | `getCurrentClinicChannelLink()` in `src/platform/teams/channel-link.ts` (live Microsoft Graph lookup; Team id from Setting `teams.clinicGroupId`) |
| Time / Location / Epic help desk / Resource Guide | static text and links in the **editable template body** |
| HIPAA & compliance / shift-swap / master schedule | absolute in-app URLs passed as variables |

**"On shift" is literal:** leadership lists are derived from who is actually placed on the
schedule (`ShiftAssignment`) for that exact clinic date. A section with nobody scheduled is
omitted entirely (see the template `{{#if}}` guards). Dates are selected from
`Term.clinicDates` by UTC day key and the stored date object is reused for the
`ShiftAssignment` query — never construct a new `Date` for comparison.

## Components

### 1. Template descriptor: `shift-reminder`

- New descriptor module under `src/platform/email/templates/` (e.g. `shift.ts`), registered
  in `src/platform/email/templates/registry.ts` alongside `compliance` / `epic` /
  `recruitment`. Category/group is a new `"shift"` group (or reuse an existing sensible
  group — decide during implementation; a distinct group lets sender rules target it).
- Rendered through the existing `renderEmail(key, context)` → shared `layout` wrapper. No
  engine changes; the engine supports `{{ var }}`, `{{{ raw }}}`, and `{{#if}}/{{else}}/{{/if}}`
  only (no `{{#each}}`), which is sufficient here.
- Editable at `/admin/email/templates/shift-reminder` with live preview and
  `validateTemplate` — free, because it is just another descriptor. Global override stored in
  `EmailTemplate` (keyed by descriptor key). No new override table.
- The user's provided copy becomes `defaultBody` / `defaultSubject`. Static content (8 AM–2 PM,
  the Yale Physicians Building address, the Epic help-desk form link, the Resource Guide link)
  lives as literal text/links in the body so an admin can edit them without a deploy.

**Declared variables (allow-list):**

- `firstName` — string
- `roleLabel` — "Director" | "Volunteer" | "Shadow" (from `ShiftRole`)
- `departmentName` — recipient's (primary) assignment department name
- `clinicDateLabel` — formatted date, e.g. "Saturday, July 12, 2026" (reuse the shared
  `fmtDate` helper)
- `additionalShifts` — **raw**, appended only when a person has more than one assignment
  that day (usually empty); pre-rendered HTML string since the engine has no loops
- `edsOnShift` — comma-joined names (may be empty; `{{#if}}` guarded)
- `deptDirectorsOnShift` — comma-joined names across the recipient's department(s) that day
  (may be empty; `{{#if}}` guarded)
- `clinicalAdvisorsOnShift` — comma-joined PCAR names (may be empty; `{{#if}}` guarded)
- `teamsChannelUrl` — this week's Teams channel deep-link (may be empty; `{{#if}}` guarded —
  when empty, the morning-meeting "here" link / line is hidden)
- `hipaaComplianceUrl`, `shiftSwapUrl`, `masterScheduleUrl` — absolute in-app URLs (reuse the
  existing base-URL/config helper used by other transactional emails, e.g. the recruitment
  portal-link builder)

### 2. Reminder job: `runShiftReminders(now)`

New module `src/platform/email/shift-reminders.ts`, structured like
`src/platform/email/reminders.ts` (`runComplianceReminders`).

Steps:

1. Resolve the active term (shared active-term helper). If none, no-op.
2. Select the target clinic date: the upcoming Saturday from `Term.clinicDates` for the week
   of `now` (the next clinic date `>= now` by day key). **If there is no clinic that week,
   no-op** — no reminders when there is no clinic.
3. Single query: load all `ShiftAssignment` rows for `(termId, clinicDate = target)` with
   `person` and `department` included.
4. Precompute leadership lists from those same rows:
   - `edsOnShift` = names where `department.code === "EXEC"`
   - `clinicalAdvisorsOnShift` = names where `department.code === "PCAR"`
   - directors-by-department map = names where `role === "DIRECTOR"`, keyed by department
5. Resolve `teamsChannelUrl` once for the target date. Prefer composing the pure exported
   helpers (`formatClinicDate` + `matchChannel` + the Graph channel list) against the **target
   clinic date** so the linked channel matches the email's stated date. `getCurrentClinicChannelLink()`
   resolves the current week directly and is an acceptable fallback (on a Monday it selects that
   same Saturday). Any failure / unset `teams.clinicGroupId` → empty string → the link is hidden.
6. Group rows by person. For each person build the context (role/department from the primary
   assignment; `additionalShifts` raw block for any extras; that person's department directors;
   the shared EDs/CAs/date/links) and send via `notify()`.
7. **Idempotency:** before sending to a person, skip if an `EmailLog` with
   `template = "shift-reminder"`, `personId = X`, and `createdAt >= start of the current week`
   already exists. This makes a duplicate cron hit a no-op without a new table.

Recipients: every distinct person with a `ShiftAssignment` on the target date (all roles).

### 3. Notification type

Register `shift-reminder` in `src/platform/notifications/registry.ts` and send through
`notify(db, { type: "shift-reminder", person, email: { subject, html }, teams? })`, so it
honors each user's email/Teams channel preference and lands in the in-app notification inbox
— consistent with compliance reminders. Email HTML is produced by
`renderEmail("shift-reminder", context)`.

### 4. Cron trigger

- New route `src/app/api/cron/shift-reminders/route.ts`, `GET`, first line `authorizeCron(req)`
  (bearer `CRON_SECRET`, constant-time, fails closed). Calls `runShiftReminders(new Date())`.
- **Enqueue-only.** Delivery rides the existing per-minute `/api/cron/email` drain — this route
  must not call the drainer, and must **not** be added to `vercel.json` (would double-fire
  against the external scheduler).
- Registered as an external cron-job.org job at **Monday 13:00 UTC (~9 AM ET)** — adjustable —
  and added to the `docs/cron-jobs.md` manifest (path / trigger / cadence / UTC schedule /
  purpose).

## Data flow

```
Monday 13:00 UTC (cron-job.org)
  → GET /api/cron/shift-reminders  (authorizeCron)
    → runShiftReminders(now)
        active term? ── no ─▶ done
        upcoming Saturday in Term.clinicDates this week? ── no ─▶ done
        load ShiftAssignment[date]  (person + department)
        precompute EDs (EXEC), CAs (PCAR), directors-by-dept
        resolve teamsChannelUrl for date  (Graph; may be empty)
        for each person (dedup via EmailLog week-window):
            build context → renderEmail("shift-reminder") → notify()  → EmailLog QUEUED
  (separately) per-minute GET /api/cron/email → drainEmailQueue → sent
```

## Error handling & edge cases

- **No active term / no clinic that week:** clean no-op.
- **Teams lookup unavailable** (`teams.clinicGroupId` unset, Graph error, no matching channel):
  `teamsChannelUrl` empty → the morning-meeting link/line is hidden via `{{#if}}`; the rest of
  the email still sends.
- **Empty leadership section** (nobody EXEC/PCAR/DIRECTOR scheduled that date): that section is
  hidden via `{{#if}}`.
- **Person with multiple same-day assignments:** one email; headline uses the primary assignment;
  extras render in the `additionalShifts` raw block; `deptDirectorsOnShift` spans all of that
  person's departments that day.
- **Duplicate cron hit:** idempotency window (EmailLog, current week) makes the second run a
  no-op.
- **Notification preference:** `notify()` routes to email/Teams per the user's setting and always
  records the inbox item.

## Testing

DB-backed tests run in **CI only** (worktrees share a stale Prisma client / test DB; this is a
known constraint). Plan:

- `runShiftReminders` (DB-backed): seed a term with clinic dates, and `ShiftAssignment` rows
  across EXEC, PCAR, a normal department, and all three roles for the target Saturday. Assert:
  correct recipient set; correct EDs/CAs/dept-director lists; empty sections omitted; a second
  run sends nothing (idempotency); no-clinic-that-week sends nothing.
- Template: `validateTemplate(defaultBody, descriptor.variables)` passes; `renderEmail(
  "shift-reminder", sampleContext)` renders expected sections and hides empty `{{#if}}` blocks.
  (Full `renderEmail` is DB-backed via the layout/override/branding reads → CI.)
- Cron route: unauthorized request (missing/bad bearer) is rejected by `authorizeCron`.

## Files (anticipated)

New:

- `src/platform/email/templates/shift.ts` — `shift-reminder` descriptor (default subject/body +
  variable allow-list)
- `src/platform/email/shift-reminders.ts` — `runShiftReminders(now)`
- `src/app/api/cron/shift-reminders/route.ts` — cron entry
- tests alongside the above

Modified:

- `src/platform/email/templates/registry.ts` — register the descriptor (and a `"shift"` group in
  `types.ts` if adding one)
- `src/platform/notifications/registry.ts` — register the `shift-reminder` notification type
- `docs/cron-jobs.md` — document the new Monday job

## Open implementation details (decide while building, not blocking)

- Exact `clinicDateLabel` format and the `fmtDate` variant to reuse.
- Which existing helper provides the absolute app base URL for the in-app links.
- Whether `"shift"` warrants its own template group / sender category or reuses an existing one.
- Precise phrasing of `roleLabel` and the `additionalShifts` block markup.
