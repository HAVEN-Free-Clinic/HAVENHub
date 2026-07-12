# Eastern Time Display — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorming), pending implementation plan

## Problem

Every displayed instant in HAVEN Hub currently renders in **UTC** (e.g. `fmtDateTime`
produces `"2026-06-13 09:05 UTC"`). Staff at a New Haven clinic read these times and
have to mentally subtract 4-5 hours. Three `datetime-local` admin inputs are worse:
they interpret typed values as UTC or browser-local, so an admin who types `1:00 PM`
gets an instant that is silently off by the UTC offset. The campaign send-at field
literally warns *"The send time is interpreted in UTC, not your local time zone."*

## Goal

Display **every** date and time across the app in a single configured time zone,
defaulting to Eastern (`America/New_York`), with a daylight-saving-correct label
(`EDT`/`EST`). The zone is a **global, admin-controlled** setting on `/admin/settings`.
The three timezone-ambiguous inputs must interpret typed values in the configured zone.
This holds regardless of how a value is stored in the database.

### Non-goals

- **Per-user** time zones. Everyone at the clinic is effectively Eastern; per-user adds
  real complexity (SSR must know the user, client context must read a per-user pref) for
  near-zero benefit. Explicit non-goal.
- Changing how instants are **stored** (they stay UTC in Postgres) or how **calendar
  dates** are stored (noon-UTC anchor) or compared (UTC day keys). Only *display* and
  *input interpretation* change.
- Making recurring **cron expressions** evaluate in Eastern — the scheduler evaluates
  them in UTC and no app code can change that (see Edge Cases).

## Confirmed decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Scope | Full: timestamp display, `datetime-local` inputs, calendar-date relabel, emails/PDFs, cron copy. Everything renders in the configured zone regardless of storage. |
| Format | Friendly + real abbreviation: `Jun 13, 2026, 9:05 AM EDT` / `Jan 5, 2026, 9:05 AM EST`. Calendar dates stay `Jun 13, 2026`. |
| Architecture | Approach 1: central resolver + async display components + a tiny client context for the 3 client components. |
| Setting | Global, admin-controlled, `display.timeZone`, default `America/New_York`, curated US-zone dropdown. Not per-user. |
| Picker | Curated US zones (Eastern/Central/Mountain/Pacific/Alaska/Hawaii/Arizona), not the full IANA list. |
| Inputs | The 3 `datetime-local` fields parse typed values as the configured zone + show an "(Eastern Time)" hint. |
| Cron | Recurring cron expressions stay UTC-executed; copy shows an honest ET conversion instead of a misleading "ET" label. |

## Two kinds of date values (why this is safe)

The app already, deliberately, holds two distinct kinds of date value. The design keeps
them separate:

1. **Real instants** — `createdAt`, `updatedAt`, email `sentAt`, notification times,
   audit-log times, interview `scheduledAt`. These are true moments in time. **These are
   the target for zone conversion.**
2. **Calendar dates** — clinic dates, term start/end, shift dates. Stored anchored at
   **noon UTC** on purpose so they are timezone-stable, and compared by UTC day key.
   Formatting a noon-UTC value in Eastern yields **the same calendar day** (noon UTC =
   7-8 AM ET), so there is **no visible shift**. Their comparison logic (`isoDateKey`,
   availability arrays) **stays UTC** and is never routed through the display zone.

## Architecture (Approach 1)

`src/platform/dates.ts` becomes a folder `src/platform/dates/` with a clean split
between **display** (zone-aware) and **logic** (UTC-only):

| File | Responsibility |
|---|---|
| `zone.ts` | `DEFAULT_TIME_ZONE = "America/New_York"`, the curated `US_TIME_ZONES` option list (`{ value, label }[]`), the `US_TIME_ZONE_IDS` tuple for the zod enum, and `getDisplayTimeZone()` — a React `cache()`-wrapped async that reads the `display.timeZone` setting once per request and falls back to the default. |
| `format.ts` | Pure, **sync** formatters, each taking an **explicit `zone` argument** (no default): `formatDateTime(d, zone)`, `formatDate(d, zone)`, `formatTime(d, zone)`, `zoneAbbrev(d, zone)`, and input helpers `formatForDateTimeInput(d, zone)` / `parseZonedInput(str, zone)`. Built on `Intl.DateTimeFormat` — no new dependency. |
| `display.tsx` | Async **server components** `<DateTime>`, `<DateOnly>`, `<TimeOnly>` that self-resolve the zone via `getDisplayTimeZone()` and render. They emit semantic `<time dateTime={iso}>…</time>` for accessibility. Props: `value: Date | null | undefined`, optional `fallback`. |
| `client.tsx` | `"use client"` `TimeZoneProvider` + `useTimeZone()` hook + a client `<DateTime>` for the 3 client components. Mirrors the existing `BreadcrumbProvider`. |
| `logic.ts` | The UTC-only, **non-display** utilities: `isoDateKey` (comparison key) and availability day math. `businessDaysSince` moves here and gains an optional `zone` parameter (see Edge Cases). Behavior for existing callers preserved. |

`index.ts` re-exports the public surface. Because `getDisplayTimeZone()` is React-cached,
a 200-row audit table resolves the zone **once per request**, not per cell.

### Explicit-zone discipline

The sync formatters in `format.ts` deliberately **require** a `zone` argument with no
default. A call site that forgets to supply the resolved zone is a **TypeScript error**,
not a silent UTC render. This closes the main weakness of a threaded-parameter approach.

### Where the zone is resolved

- **Server components / pages** use `<DateTime value={…} />` etc. — no per-page wiring;
  the component awaits the cached resolver itself.
- **Non-JSX server contexts** (emails, PDFs, CSV, `aria-label` strings) call
  `const zone = await getDisplayTimeZone()` once, then the sync `formatDateTime(d, zone)`.
- **Client components** read the zone from `TimeZoneProvider`, whose value is the
  server-resolved zone string passed into the app shell. SSR and client render the same
  string → **no hydration mismatch**. (This also fixes a latent browser-timezone bug in
  the 3 client components that render dates today.)

## Formatting details

`formatDateTime(d, zone)` uses
`Intl.DateTimeFormat("en-US", { timeZone: zone, year, month: "short", day, hour, minute, hour12: true, timeZoneName: "short" })`
→ `"Jun 13, 2026, 9:05 AM EDT"`. The `EST`/`EDT` abbreviation is produced by `Intl` and
flips with daylight saving automatically. `formatDate(d, zone)` omits the time parts →
`"Jun 13, 2026"`. `formatTime(d, zone)` → `"9:05 AM EDT"`.

### The one genuinely tricky bit: `parseZonedInput`

Reverse direction for `datetime-local` inputs — given a wall-clock string the admin means
in the configured zone, produce the correct UTC instant. Needs the zone's offset *at that
wall-clock moment* (which differs across DST). No library required:

```
parseZonedInput("2026-06-13T13:00", "America/New_York"):
  1. treat the wall-clock components as if they were UTC → provisional instant
  2. measure the zone's offset at that instant (via Intl.DateTimeFormat formatToParts)
  3. subtract the offset; re-measure once to settle DST-boundary cases, adjust if changed
```

`formatForDateTimeInput(instant, zone)` is the inverse: render the stored instant as the
zone's wall-clock `"YYYY-MM-DDTHH:mm"` for the input's default value.

## The setting

New registry entry in `src/platform/settings/registry.ts`, following the existing
`theme.default` select pattern exactly:

```ts
define<string>({
  key: "display.timeZone",
  category: "Operations",
  label: "Display time zone",
  help: "All dates and times across the app are shown in this time zone.",
  input: { type: "select", options: US_TIME_ZONES },
  schema: z.enum(US_TIME_ZONE_IDS),
  envDefault: () => config.DISPLAY_TIME_ZONE ?? "America/New_York",
  secret: false,
})
```

- Add a `DISPLAY_TIME_ZONE` env var to `src/platform/config` (default `America/New_York`)
  so `envDefault` sources from config like every other setting.
- Auto-renders on `/admin/settings` — **no page changes needed**.
- `getDisplayTimeZone()` reads it through the existing `getSetting<string>()` service.

## Inputs — the 3 `datetime-local` fields

Interview time (`recruitment/interviews/[interviewId]`), recruitment open/close window
(`recruitment/cycles/[id]`), campaign send-at (`admin/email/campaigns/[id]`):

- **Default value** via `formatForDateTimeInput(instant, zone)` so the widget shows the
  stored instant as configured-zone wall-clock. (Fixes the recruitment field, which today
  shows UTC via `getTimezoneOffset()` on the UTC server.)
- **On submit**, the server action reads the value with `parseZonedInput(value, zone)`
  instead of `new Date(value)`.
- A small **"(Eastern Time)"** hint beside each field, label derived from the live zone
  abbreviation.

## Migration scope

Mechanical but broad — roughly **45 display call sites across ~30 files**. Categories:

- **Server pages** using `fmtDate` / `fmtDateTime` / ad-hoc `toLocaleDateString(…, timeZone:"UTC")`
  → `<DateOnly>` / `<DateTime>` / `<TimeOnly>`.
- **3 client components** (`my-info/components/certificate-viewer`,
  `support/components/request-filters`, `support/components/epic-request-tabs`) →
  wrapped by `TimeZoneProvider`, formatting via `useTimeZone()`.
- **3 `datetime-local` inputs** (see above).
- **Non-JSX string renders**: emails (`platform/email/shift-reminders` + any timestamped
  mail), PDFs (`modules/support/services/itcm-pdf`, `modules/clinic/avs/build-summary`) —
  resolve the zone once, call the sync `formatDateTime(d, zone)`.
- **Cron / copy** updates (see Edge Cases).

The old `fmtDate` / `fmtDateTime` names are removed after migration; call sites move to the
components or the explicit-zone sync functions.

## Edge cases & honest limits

- **Calendar dates** (noon-UTC): format in the zone → same calendar day, no visible shift.
  Comparison logic (`isoDateKey`, availability) stays UTC and never touches the display zone.
- **Relative "days pending"** (`businessDaysSince`): today it counts UTC day boundaries.
  Since everything should be Eastern, it gains a `zone` parameter and computes day
  boundaries against the configured zone's midnights, so "pending 3 days" matches what a
  clinic user perceives. In scope, small.
- **Cron expressions** (campaign recurring schedule): evaluated by the scheduler in **UTC**;
  no app code can change that. We do **not** mislabel them "ET." The copy becomes honest and
  helpful: `0 13 * * 1` shows "= Mondays 9:00 AM EDT". A one-time `sendAt` datetime, by
  contrast, becomes fully zone-aware via `parseZonedInput`.
- **`<html>` no-flash**: the timezone provider value is a plain string prop, so unlike the
  theme system it needs no pre-paint class trick.

## Testing

- **New unit tests** for `format.ts`: fixed instants formatted across DST (abbrev
  correctness for both `EST` and `EDT` dates); `parseZonedInput` ↔ `formatForDateTimeInput`
  round-trips at DST boundaries (spring-forward gap, fall-back overlap).
- **Existing** `dates.test.ts` (now `logic.test.ts`) stays green — `isoDateKey` and
  `businessDaysSince` (default/UTC behavior) preserved.
- **Guard test** asserting display code no longer calls raw `toLocaleDateString` /
  `toLocaleTimeString` / `toLocaleString` (forces future dates through the helpers),
  matching this repo's guard-test culture (e.g. the AppShell single-importer guard).
- Full CI: typecheck, lint (including the no-em-dash rule), comprehensive Playwright e2e.
  Shipped as a **CI-gated PR** per repo convention.

## Net effect

Every displayed date/time renders in the configured zone (Eastern by default) with a
DST-correct label; admins change it from `/admin/settings`; the three timezone-ambiguous
inputs finally mean Eastern; and the calendar-date storage and comparison logic is provably
untouched.
