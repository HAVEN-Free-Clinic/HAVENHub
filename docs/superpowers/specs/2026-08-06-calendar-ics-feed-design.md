# Calendar feed: subscribe to your shifts from Google Calendar

Date: 2026-08-06

## Problem

A member's shifts live only in the Hub. To know when they are working, they open
`/schedule` and read it. Nothing pushes those dates into the calendar they
actually run their life from, and at Yale that is overwhelmingly Google
Calendar.

The cost is quiet but constant: shifts get double-booked against class and
clinical obligations because nothing blocks the time, and members re-check the
Hub because they have no local copy. Every other commitment on their calendar
competes for that slot with full visibility. HAVEN shifts do not.

## Goals

- A member can subscribe to their own shifts from Google Calendar (or Apple
  Calendar, or Outlook) with a URL, and it keeps itself up to date.
- Shifts occupy real time on the calendar grid and mark the member busy.
- The feed can never expose a schedule the Hub itself would not show that
  member, including unpublished next-term schedules.
- Nothing about the feed requires a session, because calendar clients cannot
  authenticate.

## Non-goals

- Per-department clinic hours. One global window covers every department.
- Director or department-wide feeds. Personal shifts only.
- A Google Calendar API integration. No OAuth, no consent screen, no per-user
  sync state. The refresh latency that comes with plain ICS subscription is
  accepted and disclosed in the UI.
- `LOCATION` on events. No clinic address exists anywhere in the schema today.
- `VALARM` reminders. Google ignores them on subscribed calendars.
- Changing anything about how shifts are assigned, published, or displayed.

## The shape of the problem

Two facts from the existing schema drive most of the design.

**Shifts are date-only.** `ShiftAssignment.clinicDate` is a calendar date
anchored at noon UTC, matching `Term.clinicDates` and the availability arrays.
There is no start time, no end time, and no duration anywhere in the schema or
in settings. A calendar event needs a time, so the system has to acquire one it
does not currently have.

**Calendar clients cannot log in.** Google fetches a subscribed URL from its own
servers on its own schedule, unauthenticated. Whatever protects the feed has to
live in the URL itself.

## Clinic hours as configuration

Two new settings in `registry.ts`, in the Operations category alongside
`display.timeZone`:

- `schedule.clinicStartTime`, default `08:00`
- `schedule.clinicEndTime`, default `13:00`

Both are `HH:MM` strings validated by a zod regex, interpreted in the zone
returned by `getDisplayTimeZone()`. The registry is declarative and the admin
settings page renders from it, so this costs two entries and no new UI.

A single global window is deliberate. Per-department hours would need a
migration plus admin surface on every department, to encode a distinction the
clinic does not currently record anywhere. If departments turn out to need
genuinely different hours, the setting becomes a per-department override with
this value as the fallback, and no event-generation code changes.

## Data model

```prisma
model CalendarFeedToken {
  id            String    @id @default(cuid())
  personId      String    @unique
  tokenHash     String    @unique
  createdAt     DateTime  @default(now())
  lastFetchedAt DateTime?
  person        Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```

Token generation follows `member-magic-link.ts` exactly:
`randomBytes(32).toString("base64url")` returned once to the caller, only the
sha256 hash persisted. Two deliberate departures from `MemberLoginToken`:

- **No `expiresAt`.** A subscription that silently stops working months later,
  in a client the member rarely looks at directly, is a worse failure than one
  they can reset on demand. Revocation is explicit, not scheduled.
- **No `usedAt`.** The token is polled indefinitely, not consumed once.

`personId` is unique, so a member has exactly one feed. The row is created
lazily the first time they ask for a link, so members who never subscribe never
hold a dormant secret. Rotation deletes the row and creates a new one, which
invalidates the old URL immediately.

`lastFetchedAt` records when a client last pulled the feed. This exists to
answer the only support question this feature will ever generate, "why is my
calendar not updating," by showing the member whether Google has actually come
to fetch. To keep an unauthenticated endpoint from becoming a write amplifier,
it is only written when the stored value is more than an hour old.

## ICS generation

`src/modules/schedule/calendar/ics.ts` holds pure functions with no database
access, so every fiddly correctness concern is unit-testable in isolation.

RFC 5545 mechanics the module owns:

- CRLF line endings throughout.
- Content lines folded at 75 octets, counting bytes rather than characters so a
  multi-byte name cannot be split mid-codepoint.
- TEXT escaping for backslash, semicolon, comma, and newline. Department names
  and person names are user-editable and will eventually contain a comma.

### Times

`DTSTART` and `DTEND` are emitted as UTC instants (`20260208T130000Z`), not as
zoned local times. Each shift's date is combined with the configured clinic
window and converted through the display zone to an absolute instant at
generation time.

This choice avoids shipping a `VTIMEZONE` component, which is the single most
error-prone part of hand-written ICS. It also stays correct across DST: because
the conversion happens per date rather than through one cached offset, a
February clinic day and a July clinic day resolve to different UTC hours
automatically.

### Event fields

- `UID`: `shift-<assignmentId>@<host>`. Stable across regenerations, so an
  edited shift updates in place instead of duplicating.
- `SUMMARY`: the configured `branding.orgName` followed by the department name.
- `DESCRIPTION`: role (Director, Volunteer, Shadow), any of the triage,
  walk-in, CC, and remote tags that are set, the term name, and a link back to
  the schedule page.
- `TRANSP:OPAQUE` and `STATUS:CONFIRMED`, so the shift reads as busy.
- `DTSTAMP` at generation time.

Calendar-level: `METHOD:PUBLISH`, `X-WR-CALNAME` from `branding.orgName`,
`X-WR-TIMEZONE`, and `REFRESH-INTERVAL;VALUE=DURATION:PT12H` alongside
`X-PUBLISHED-TTL:PT12H`. The refresh hints are honored by Apple Calendar and
ignored by Google, and cost nothing to emit.

### Removal

Cancelled and reassigned shifts need no special handling. The feed is a full
statement of current state on every fetch, so a shift the member no longer holds
is simply absent, and subscribing clients drop it. No tombstones, no
`STATUS:CANCELLED` bookkeeping, no deleted-shift table.

## Route

`src/app/api/calendar/[token]/route.ts`, `GET`, Node runtime, force-dynamic.

Two routing hazards were checked and are clear. The proxy matcher in
`proxy.ts` already excludes `api`, so the apply-subdomain rewrite will not
touch this path. Living outside the `(app)` tree keeps it clear of the
onboarding gate, which must never have paths allowlisted into it.

Request handling:

1. Hash the path token, look up `CalendarFeedToken` by `tokenHash`.
2. No match: 404 with a plain-text body.
3. Match, but the bound `Person` is not `ACTIVE`: return a valid but empty
   `VCALENDAR`.
4. Otherwise call `mySchedule(personId)` and render its shifts.

Reusing `mySchedule` is the central decision of this design. Term selection and
the publication gating that hides an unpublished next-term schedule already live
there and are already tested. Reimplementing that query for the feed would
create a second place for the rule to be stated and a way for the feed to
disagree with the web view, and a disagreement in that direction leaks an
unpublished schedule.

The empty-calendar response for a non-`ACTIVE` person is chosen over a 404 so
that an offboarded member's calendar goes quiet rather than surfacing a
persistent broken-calendar error in a client they may not check for months.
Access stops either way.

Response headers: `Content-Type: text/calendar; charset=utf-8`,
`Content-Disposition: inline; filename="haven-shifts.ics"`, and
`Cache-Control: no-store`. The feed is a per-person secret and must never land
in a shared cache.

A best-effort per-IP sliding-window rate limit reuses the in-memory pattern from
`member-magic-link.ts`, sized loosely because Google fetches from a wide pool of
addresses. It is a flood backstop, not an access control.

The payload contains no patient data of any kind.

## UI

A card on My Info, `calendar-subscribe-card.tsx`, rendered beside the existing
clearance and membership cards.

Before a token exists, the card shows a short explanation and a Generate link
button. After, it shows the URL in a read-only input with a Copy button, an Add
to Google Calendar button pointing at
`google.com/calendar/render?cid=<encoded url>`, and a Reset link button.

The card carries the refresh-latency disclosure directly:

> Google refreshes subscribed calendars on its own timing, usually within a
> day. Check the Hub for the latest.

When `lastFetchedAt` is set, the card also reports when a client last fetched
the feed.

Both generation and reset are server actions that go through `recordAudit`, so
issuing and revoking a long-lived credential leaves a trail like every other
sensitive action in the app.

## Testing

Unit, on the ICS module:

- Folding at exactly 75 octets, including a multi-byte name that must not split
  mid-codepoint.
- Escaping of comma, semicolon, backslash, and newline in a department name.
- DST correctness in both directions: a clinic date in February and one in July
  produce different UTC hours from the same configured local window.
- UID stability across two generations of the same assignment.
- A member with no shifts produces a valid, parseable, empty `VCALENDAR`.

Unit, on the token service: issue returns a raw token whose plaintext never
appears in the row, lookup matches on hash, rotation invalidates the prior
token, and `lastFetchedAt` is not rewritten within the hour window.

Route: 404 on an unknown token, empty calendar for a non-`ACTIVE` person,
correct content type and cache headers on success.

Integration: a member with an assignment in an unpublished department of a
non-live term does not see that shift in the feed, mirroring the existing
`mySchedule` publication-gating test.

## Follow-ups this deliberately leaves open

- Clinic address as a third setting, feeding `LOCATION`.
- Per-department hours, as an override layered over the global window.
- A department-wide feed for directors, which needs scope encoded in the token.
