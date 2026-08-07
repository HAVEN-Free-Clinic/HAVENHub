# Clinic check-in: recording who actually showed up

Date: 2026-08-07

## Problem

Nothing in the schema records whether an assigned person showed up to clinic.
`ShiftAssignment` says who was *supposed* to be there. After Saturday, the row
looks identical whether the volunteer worked a full shift or never left their
apartment.

That single gap blocks a whole class of things ops wants: attendance history,
no-show rates, actual hours served, and any reliability signal that could feed
scheduling, recruitment, or disciplinary decisions. It also blocks the
clinic mission control board (a big-screen Saturday view of who is assigned, who
is actually here, which roles are unfilled right now, which Spanish speakers are
on the floor, who the RHD attending is), because its most valuable column is the
one we cannot populate.

This spec covers check-in only. Mission control is the follow-on and gets its own
spec; the data model here is shaped so the board is a read on top of it.

## Goals

- One durable record per person per clinic day of the fact that they arrived.
- Self-service check-in for scheduled volunteers and directors, gated on being
  physically near the clinic.
- A path for telehealth volunteers to check in from anywhere.
- A path for a director to record attendance when the location gate fails, so no
  legitimate volunteer is ever stranded and no unearned no-show is recorded.
- Enough evidence stored per record to tell a self-verified check-in from a
  staff-recorded one.

## Non-goals

- **Check-out and measured hours.** People leave without tapping out, so measured
  durations rot exactly for the population worth measuring. `checkedInAt` is a
  real instant, so hours and punctuality can be layered on later without
  reshaping anything.
- **Clinic session start and end times.** Nothing in the schema knows when a
  shift starts, so "late" has nothing to compare against. Deferred with hours.
- **Mission control.** Follow-on spec.
- **Reliability scoring.** This spec produces the raw attendance record. What is
  computed from it, and what it is allowed to influence, is a separate decision.
- **Offline capture.** Check-in is a write, and per the established degradation
  contract writes throw when the database is unreachable. The day proceeds on
  paper.

## Security posture

State this plainly, because the rest of the design follows from it.

Browser geolocation is a **deterrent, not enforcement**. Indoors it is typically
wifi or cell derived with `coords.accuracy` in the hundreds of metres. Many iOS
users have Location Services disabled for Safari entirely. And it is spoofable in
about thirty seconds with devtools sensor override or a mock-location app.

So the geofence raises the effort of checking in from bed from zero to
non-trivial, and that is all it does. Every design choice below assumes an
adversary can defeat it and a legitimate user can be failed by it. The value is
in the honest audit trail, not the gate.

## Data model

One enum, one model.

```prisma
enum CheckInMethod {
  /// Self check-in that passed the geofence.
  SELF_GEO
  /// Self check-in by someone whose every assignment that day is remote.
  SELF_REMOTE
  /// Recorded by a director or front-desk staffer.
  STAFF
}

/// One row per person per clinic day. Its existence IS the attendance fact;
/// absence is derived, never stored. Keyed per person rather than per
/// assignment because a person may hold assignments in two departments on one
/// clinic date and still arrives only once.
model ClinicAttendance {
  id             String        @id @default(cuid())
  termId         String
  /// Noon-UTC anchored calendar date, matching Term.clinicDates and
  /// ShiftAssignment.clinicDate. Compare by UTC day key, never raw timestamp.
  clinicDate     DateTime
  personId       String
  /// The true arrival instant, NOT date-anchored. Kept so punctuality and hours
  /// can be derived later over data collected from day one.
  checkedInAt    DateTime      @default(now())
  method         CheckInMethod
  /// Rounded metres from the configured centre. Null for SELF_REMOTE and STAFF.
  /// Raw coordinates are deliberately never persisted (see Privacy).
  distanceMeters Int?
  /// The fix's reported accuracy in metres, for tuning the thresholds later.
  accuracyMeters Int?
  /// The staff member who recorded it. Null for self check-in.
  recordedById   String?
  /// Free-text reason, used mainly on STAFF rows.
  note           String?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  /// Restrict: term deletion is blocked while attendance history references it.
  term       Term    @relation(fields: [termId], references: [id], onDelete: Restrict)
  /// Cascade: attendance belongs to the person and dies with them.
  person     Person  @relation("clinicAttendancePerson", fields: [personId], references: [id], onDelete: Cascade)
  /// SetNull: the record survives the recorder being deleted.
  recordedBy Person? @relation("clinicAttendanceRecordedBy", fields: [recordedById], references: [id], onDelete: SetNull)

  @@unique([termId, clinicDate, personId])
  @@index([termId, clinicDate])
  @@index([personId, termId])
}
```

### Three consequences worth stating

**No-show is derived, never stored.** An assignment whose person has no
attendance row, on a clinic date strictly before today in the display timezone,
is a no-show. Nothing to backfill and nothing to keep in sync, and today's clinic
is never scored as absences at 9am.

**Unassigned attendance is free and harmless.** A `STAFF` row for someone with no
assignment that day records that they were present and simply is not in the
no-show denominator, which stays measured strictly against `ShiftAssignment`.
That is what lets "who is here" reflect reality without corrupting reliability
statistics.

**The remote waiver is conjunctive, over a non-empty set.** The geofence is
waived only if the person has *at least one* assignment that date and *every* one
of them carries `remote`. Someone holding one telehealth and one in-person
assignment still has to be in the building. The non-empty requirement is not
pedantry: "every assignment is remote" is vacuously true for a person with no
assignments, which would hand a fence-free check-in to exactly the unscheduled
people `NOT_ASSIGNED` is meant to stop. The
`remote` tag is director-set in the schedule builder, never self-declared, so a
volunteer cannot flip themselves remote to dodge the fence.

## Privacy

The server persists **rounded distance and accuracy, never raw coordinates**.

Enforcement is identical either way, because the server owns the rule. What
storing lat/lng would add is the ability to re-litigate a specific distance after
the fact, which the director override already handles better. What it would cost
is a persistent record of where student volunteers physically were on Saturday
mornings, inside a system that also holds their HIPAA compliance records and
disciplinary history. That is a retention and privacy-policy commitment a
check-in feature should not quietly take on.

The columns are additive, so this is reversible if a real need appears.

## Configuration

Four new entries in the settings registry, matching the configurable-by-default
pattern used for the org name, support email, and display timezone.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `clinic.checkInLatitude` | number | 800 Howard Ave | Fence centre |
| `clinic.checkInLongitude` | number | 800 Howard Ave | Fence centre |
| `clinic.checkInRadiusMeters` | number | `250` | How near counts as here |
| `clinic.checkInMaxAccuracyMeters` | number | `200` | Below which a fix is trustworthy |

**The seeded coordinates must be confirmed against the actual clinic entrance
before merge.** A geocode is a starting point, not a verified value, and a fence
centred fifty metres off is a fence that fails people at the door.

## The rule

A self-geo check-in passes if and only if:

```
distance <= clinic.checkInRadiusMeters
  AND accuracy <= clinic.checkInMaxAccuracyMeters
```

The accuracy half is load-bearing. `coords.accuracy` indoors is routinely 100 to
1000+ metres, and a fix meaning "somewhere in this half-kilometre" is not
evidence of anything. Rather than silently passing it or silently failing it, the
server declines to guess and routes the person to the override path with a
distinct reason.

Distance is haversine, computed server-side from the configured centre.

## Flow

`/schedule/check-in`, under the Schedule module. Reachable by anyone holding
`schedule.view`, which the baseline Volunteer system role already carries.
Placing it under Clinic was rejected: `clinic.access` is admin-granted and held by
no baseline role, so scheduled volunteers would not reach it.

Also surfaced as a card on `/schedule` and, on clinic mornings, in the home
dashboard action feed via the existing `action-cards.ts` mechanism.

1. Page loads. Server resolves the live term, whether today is one of its
   `clinicDates`, the viewer's assignments for that date, and any existing
   attendance row.
2. If an attendance row exists, the page shows "checked in at 8:52am" and stops.
3. If the viewer has no assignment that date, self-serve stops here with
   `NOT_ASSIGNED`. This check runs **before** the remote waiver, so the vacuous
   all-remote case above cannot be reached.
4. If they have at least one assignment and every one is `remote`, the page
   offers a one-tap check-in that writes `SELF_REMOTE` with no geolocation call
   at all.
5. Otherwise the client calls `navigator.geolocation.getCurrentPosition()` and
   posts `{ latitude, longitude, accuracy }` to a server action.
5. The server loads the fence config, computes haversine distance, applies the
   rule, and either writes a `SELF_GEO` row or returns a typed failure.

The client never decides. It reports a position; the server owns the rule, the
verdict, and the write. A client can lie about where it is, but it cannot move
the fence or forge a verdict.

### Failure taxonomy

Seven outcomes, each with its own copy. "Check-in failed" at 8:55am on a clinic
morning is useless to a volunteer.

| Reason | Cause | Message ends with |
|---|---|---|
| `PERMISSION_DENIED` | Browser or OS refused | Ask a director |
| `POSITION_UNAVAILABLE` | No fix available, or no geolocation API / insecure context | Ask a director |
| `TIMEOUT` | Fix took too long | Ask a director |
| `TOO_IMPRECISE` | `accuracy > maxAccuracy` | Ask a director |
| `OUT_OF_RANGE` | `distance > radius` | Ask a director |
| `NOT_ASSIGNED` | No assignment that date, self-serve blocked | Ask a director |
| `NOT_A_CLINIC_DAY` | Date is not in the term's `clinicDates` | Nothing to do |

Everything except `NOT_A_CLINIC_DAY` routes to the override path, `OUT_OF_RANGE`
included. Wifi-derived geolocation puts genuinely present people hundreds of
metres away often enough that treating distance as proof of absence would be
wrong.

### Idempotency

The unique constraint on `(termId, clinicDate, personId)` is the guard. A second
tap returns the existing row and displays the original arrival time rather than
erroring or duplicating.

### Window

The whole clinic date, in the display timezone. No new configuration, and nobody
is locked out for arriving at 7:40 or staying past a cutoff.

## Staff override

A new permission, `schedule.manage_attendance`, **unscoped**.

The codebase supports department-scoped permissions via `permissionDepartmentIds()`,
and scoping would be the more orthodox choice. It is deliberately not used here:
the operational reality is one person at a front desk marking whoever walks in,
across every department, and department-scoping turns that into a fight. This is
a conscious loosening, not an oversight.

The override surface **extends `/schedule/full`** rather than adding a tab. That
page is already the per-date roster grouped by department, which is exactly the
shape the override needs, and it is what mission control later becomes a
big-screen rendering of.

- The attendance column and "mark present" controls render **only** for
  `schedule.manage_attendance` holders. Members see the page unchanged.
- The same view gets an "add someone not assigned" person picker, writing a
  `STAFF` row with no matching assignment.
- Staff can also undo a row, to correct a misclick.

Two reasons this beats a new `/schedule/attendance` tab. Schedule already carries
five tabs and the row's only real guard is the 1280px e2e check, so a sixth is a
width risk for no gain. And a peer-visible attendance column effectively
broadcasts who did not show up, which is a larger social change than this feature
should make by accident.

## Morning-of email

A new template in the schedule template family, enqueued by a new
`/api/cron/clinic-checkin-invites` route.

- Triggered by the external scheduler (cron-job.org) with
  `Authorization: Bearer $CRON_SECRET`, consistent with every other cron in the
  app. Absent from `vercel.json`, per `docs/cron-jobs.md`.
- Runs **daily** and no-ops unless today is in the active term's `clinicDates`,
  rather than assuming Saturday. A rescheduled or midweek clinic still gets its
  email.
- **Enqueues only.** Delivery is the per-minute `/api/cron/email` drainer's job.
  Draining here would run concurrently with that route and double-send.
- Recipients: every person with a `ShiftAssignment` on that clinic date.
- The link points at `app.baseUrl + /schedule/check-in`. No new token type: the
  normal auth wall handles identity, and members already reach the hub by Yale
  SSO or the existing member magic link.
- Records a heartbeat via `recordCronHeartbeat`, like its siblings.

## Error handling

**Unconfigured fence.** If the coordinate settings are unset, self-geo check-in
**fails closed** with an admin-facing message. Failing open would mean a geofence
that silently passes everyone, which is worse than having none because it would
be trusted.

**Database unreachable.** Check-in is a write, so it throws rather than degrading,
as does the override. Both surface a plain "cannot record check-in right now".

**Offboarded person or wrong term.** The write re-validates that the person is
`ACTIVE` and the term is live at the moment of the write, mirroring how
magic-link verification re-checks active status rather than trusting a
previously-issued artifact.

**Insecure context or missing geolocation API.** Folded into
`POSITION_UNAVAILABLE`, which routes to the override like every other failure.

## Observability

PostHog capture on every check-in outcome, tagged with the method or failure
reason, grouped by term.

This is how the thresholds get tuned from data rather than anecdote. If
`TOO_IMPRECISE` fires on a third of attempts in week one, that is the signal to
widen `clinic.checkInMaxAccuracyMeters`, and it will be visible rather than
arriving as a complaint.

## Testing

**Unit**
- Haversine distance against known coordinate pairs.
- The pass rule, including the accuracy threshold, at and across both boundaries.
- The conjunctive remote waiver: all-remote waives, mixed does not.
- No-show derivation across the today boundary in the display timezone.
- Idempotent re-tap returns the existing row.

**Service** (against the per-worktree test database on `:5434`)
- Each failure reason produces its typed outcome and writes nothing.
- Fails closed when the fence settings are unset.
- Staff override writes a `STAFF` row, including for an unassigned person.
- Re-validation rejects an offboarded person and a non-live term.

**Email**
- A golden test for the new template, matching the existing `.golden.test.ts`
  convention.

**Cron**
- No-ops on a non-clinic date.
- Enqueues exactly the people assigned on a clinic date.
- Never drains.

**E2E**
- Playwright grants the geolocation permission and sets a fixed position per
  browser context, so the happy path, the out-of-range rejection, and the staff
  override are coverable end to end rather than mocked at the unit boundary.

## Migration and rollout

- One additive migration: the enum, the table, and the three relation
  back-references it requires (two on `Person`, one on `Term`). No changes to
  existing columns.
- `schedule.manage_attendance` is a new permission string. Per the system-role
  convention, granting it in production needs a backfill migration, not just a
  registry edit.
- **The fence is live the moment this deploys, using the seeded default centre.**
  An earlier draft of this spec claimed the feature would be inert until an
  admin set the coordinates. That was wrong, and the error is worth recording
  because it inverts the rollout order. Every settings-registry entry resolves
  through `getSetting`, which falls back to its `envDefault()` whenever the
  stored value is missing, invalid, or unreadable because the database is down.
  The coordinates therefore always resolve to a valid finite number, so the
  fail-closed guard cannot fire in production and the fence begins enforcing
  against the geocoded default on the first request.
- That makes confirming the coordinates a **pre-deploy** step, not a
  pre-announcement one. Shipping with an unverified centre means rejecting
  on-site volunteers from the first clinic, and the director override becomes
  the only way anyone gets checked in.
- The fail-closed guard in `resolveFence` is kept as defensive depth for a
  future in which settings resolution can yield nothing, and it is honest about
  being unreachable today. It is covered by a test that stubs the resolver.

## Follow-on: mission control

Recorded here so the board is not re-litigated from scratch.

Everything the board needs beyond attendance already exists: assignments by
department, `Person.spanishVerified`, `RhdClinic.attending`, and a capacity engine
whose `computeDayMetrics` already defines unfilled as an `idealHeadcount`
shortfall plus `triage` / `walkin` / `cc` quota `missing`.

The board is then largely `computeDayMetrics` run over *present* people rather
than *assigned* people, rendered big. Two open questions for that spec: its own
view permission, and refresh strategy given that polls return 503 when the
database is unreachable.
