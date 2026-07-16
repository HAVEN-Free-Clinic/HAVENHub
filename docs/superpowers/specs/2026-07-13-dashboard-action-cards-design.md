# Dashboard action cards — smart priority feed

**Date:** 2026-07-13
**Branch:** `feat/dashboard-action-cards`
**Status:** Design — awaiting review

## Problem

The strip of cards directly below the "next shift" hero on the dashboard
(`src/app/(app)/page.tsx`, the `quickAll` / `quick` block) is a mix of two
different things:

- **Personal** shortcuts with live status ("My schedule / 4 upcoming", "My Info /
  HIPAA current"), and
- **Navigational** module links with static descriptions ("Volunteers / Rosters &
  compliance", "Recruitment / Cycles & review", "Admin / People & terms").

The first four accessible entries win, so a director often sees three navigational
tiles and one personal one. The cards read as "smaller module icons," not as
things you can act on.

## Goal

Turn the strip into a **smart priority feed**: a ranked list of the things that
most need this person's attention right now — personal *and* role-based — each
with a live count/status and a verb-forward label, in the same compact card
style. When there aren't enough real actions to fill the row, backfill the
remaining slots with the person's module shortcuts (today's behaviour, demoted
below real actions) so the strip never looks empty.

Visual target (user-provided mockup): four cards like `Schedule / 4 upcoming`,
`Request a swap / Find cover`, `Training / To complete`, `My info / 1 to confirm`
— colored icon tile + bold label + muted subtitle.

## Non-goals

- **No "find cover" marketplace.** Shift changes today are two-party "Request a
  change" (drop/swap) on `/schedule`; there is no open-shift claim pool. The swap
  card links into that existing flow. Building a marketplace is a separate project.
- **No new compliance/verification workflow.** The "confirm" concept reuses the
  existing onboarding *profile* task ("Confirm your contact details").
- **Role actions in v1 = pending shift-change approvals only.** The registry is
  built so more role actions (recruitment reviews, incident/compliance approvals)
  can be added later, but v1 ships just the swap-approvals card.

## Design

### Architecture — one pure ranked builder

All selection/ranking logic lives in a single **pure, server-safe, unit-tested**
function. The page component stays thin: gather inputs, call the builder, render.

**New file `src/app/(app)/action-cards.ts`:**

```ts
import { CalendarDays, Repeat, UserRoundPen, GraduationCap, ClipboardCheck,
         type LucideIcon } from "lucide-react";
import type { ComplianceStatus } from "@/platform/compliance/rules";

export type ActionCard = {
  key: string;
  href: string;
  icon: LucideIcon;
  hue: string;        // a --mod-<hue> token key
  label: string;
  sub: string;
  priority: number;   // ranking only; not rendered
};

export type ActionCardInput = {
  hasScheduleAccess: boolean;
  hasMyInfoAccess: boolean;
  upcomingCount: number;
  nextShiftDaysAway: number | null;   // null when no upcoming shift
  pendingSwapCount: number;           // mySchedule().pendingRequests.size
  pendingApprovals: number;           // countPendingApprovals()
  compliance: ComplianceStatus;
  trainingIncomplete: number;         // # of training/directorTraining/learning tasks left
  trainingHref: string;               // "/training" or "/learning"
  profileIncomplete: boolean;         // onboarding "profile" task === INCOMPLETE
  backfill: ActionCard[];             // module shortcuts, in preference order, priority 0
  limit?: number;                     // default 4
};

export function buildActionCards(input: ActionCardInput): ActionCard[];
```

The builder:

1. Builds each applicable **personal/role** card (below).
2. Sorts them by `priority` descending (stable — ties keep insertion order).
3. Concatenates `input.backfill` (already ordered, priority 0) **after** the
   ranked real actions.
4. Returns `slice(0, limit ?? 4)`.

No href de-duplication is needed: personal hrefs (`/schedule`, `/schedule/builder`,
`/my-info`, `/training`|`/learning`) never collide with backfill hrefs
(`/volunteers`, `/recruitment`, `/recruitment/interviews`, `/admin`). Schedule and
Swap intentionally both point at `/schedule` and both remain.

### The card topics

Each topic yields at most one card. "Elevated" priorities float urgent items to
the top; "standing" priorities keep useful anchors visible when nothing is urgent.

| Topic | Shows when | Priority | Subtitle | href | hue | icon |
|---|---|---|---|---|---|---|
| **Approvals** (role) | `pendingApprovals > 0` | 95 | `${n} to review` | `/schedule/builder` | `admin` | `ClipboardCheck` |
| **My info** | `hasMyInfoAccess` (always) | see below | see below | `/my-info` | `info` | `UserRoundPen` |
| **Training** | `trainingIncomplete > 0` | 80 | `To complete` (n=1) / `${n} to complete` | `trainingHref` | `recruit` | `GraduationCap` |
| **Schedule** | `hasScheduleAccess` (always) | 60 if a shift is imminent (`nextShiftDaysAway ≤ 2`), else 30 | imminent: `Today` / `Tomorrow` / `In ${d} days`; else `${upcomingCount} upcoming` (0 → `View shifts`) | `/schedule` | `schedule` | `CalendarDays` |
| **Request a swap** | `hasScheduleAccess && upcomingCount > 0` | 40 if `pendingSwapCount > 0`, else 25 | `${n} pending` / `Find cover` | `/schedule` | `swap` (new token) | `Repeat` |

**My info** collapses HIPAA + profile into one card (both live at `/my-info`); its
priority and subtitle take the single most-pressing concern:

| Condition (first match wins) | Priority | Subtitle |
|---|---|---|
| `compliance` is `EXPIRED` or `NO_CERTIFICATE` | 90 | `Upload HIPAA certificate` |
| `profileIncomplete` | 85 | `1 to confirm` |
| `compliance` is `EXPIRING_SOON` | 70 | `Renew HIPAA soon` |
| `compliance` is `PENDING_VERIFICATION` or `UNKNOWN_DATE` | 40 | `HIPAA in review` |
| otherwise (standing) | 20 | `View & update` |

The side rail's "Your status" card is unchanged and still lists the *full*
clearance checklist (profile, HIPAA, training, learning, EHS). The action card is
the nudge; the rail is the complete list — so surfacing only the single most
urgent my-info concern in the card is intentional, not lossy.

**Backfill** cards are built in `page.tsx` from the person's accessible
navigational modules — Volunteers, Recruitment, Admin, plus "My interviews" for
panelists — mirroring today's `quickAll` navigational entries (same labels, subs,
module hues, `m.icon`). They carry `priority: 0` and fill any slots left after the
ranked real actions, up to the limit of 4.

### Ranking examples

- **New volunteer** (no cert, training incomplete, no shifts, no approvals):
  My info (90, "Upload HIPAA certificate"), Training (80), Schedule (30, "View
  shifts"). → 3 cards (no accessible backfill modules).
- **Cleared volunteer, 4 upcoming shifts:** Schedule (30, "4 upcoming"), Request a
  swap (25, "Find cover"), My info (20, "View & update"). → 3 cards.
- **Director, 2 pending approvals, cleared, shift in 2 days, 4 upcoming:**
  Approvals (95), Schedule (60, "In 2 days"), Request a swap (25), My info (20). →
  4 cards.

### New data — `countPendingApprovals`

Only one input isn't already on the dashboard. Add to
`src/modules/schedule/services/requests.ts`, reusing the existing scope resolver:

```ts
export async function countPendingApprovals(personId: string): Promise<number> {
  const term = await getActiveTerm();
  if (!term) return 0;
  const deptIds = await manageableRequestDepartmentIds(personId);
  if (deptIds.length === 0) return 0;
  return prisma.shiftRequest.count({
    where: { termId: term.id, departmentId: { in: deptIds }, status: "PENDING" },
  });
}
```

`getActiveTerm`, `manageableRequestDepartmentIds`, and `prisma` are already
imported in that file. One count query; added to the dashboard's existing
`Promise.all`.

### `page.tsx` changes

- Add `countPendingApprovals(person.personId)` to the `Promise.all`.
- Derive builder inputs (all from data already fetched, except the count above):
  - `upcomingCount = upcoming.length`
  - `nextShiftDaysAway = next ? daysAway : null`
  - `pendingSwapCount = schedule.pendingRequests.size`
  - `compliance = status`
  - `trainingIncomplete` / `trainingHref` from `onboarding.tasks`: tasks with
    `key ∈ {training, directorTraining, learning}` and `state` not `COMPLETE` /
    `NOT_REQUIRED`; count them, and pick `href` = `/learning` if the first
    incomplete one is `learning`, else `/training`.
  - `profileIncomplete` = the `profile` task's `state === "INCOMPLETE"`.
  - `backfill` = accessible navigational modules mapped to `ActionCard`s.
- Replace the `quickAll` / `quick` block **and** the `{quick.length > 0 && ...}`
  render with `const cards = buildActionCards({...})` and a map over `cards`
  reusing the existing compact-card markup.
- Presentation stays identical to today's compact card: `cardClasses({ size:
  "compact", interactive: true, pad: false })`, a `h-9 w-9` hue-tile with
  `card.icon`, bold `card.label`, muted `card.sub`. The count lives **in the
  subtitle text** — no tinted card backgrounds — consistent with the neutral
  Alert/Badge direction the design system already moved to.
- Refactor the hue helper: extract `hueVars(hue: string): CSSProperties` returning
  the `--mh`/`--mhbg` vars; `ModuleTile` calls `hueVars(HUE_BY_MODULE[m.id] ??
  "schedule")` and action cards call `hueVars(card.hue)`.
- Remove now-unused imports (`Users`, `ClipboardList`, `Settings`, `UserRoundPen`,
  `LucideIcon` if no longer referenced in `page.tsx`).

### New hue token

Add `--mod-swap` (amber-orange) to `src/app/globals.css`, in both the light and
dark blocks, following the existing `--mod-*` OKLCH pattern:

```css
/* light block (near line 65) */
--mod-swap:    oklch(0.55 0.11 55);
--mod-swap-bg: oklch(0.96 0.035 60);
/* dark block (near line 84) */
--mod-swap:    oklch(0.82 0.10 60);
--mod-swap-bg: oklch(0.30 0.05 60);
```

Training reuses the existing `recruit` (violet, hue 300) token — training lives in
the recruitment module, so this is semantically apt and needs no new token.

## Testing

`src/app/(app)/action-cards.test.ts` — pure, no DB (safe re: the shared-Neon
`TEST_DATABASE_URL` hazard; run just this file with vitest). Cases:

1. **Ranking order** — approvals outrank an imminent schedule which outranks swap.
2. **Applicability** — no schedule access ⇒ no Schedule/Swap cards; swap requires
   `upcomingCount > 0`.
3. **My-info urgency selection** — EXPIRED beats profileIncomplete; standing
   ("View & update") when compliant + profile complete.
4. **Backfill** — fills remaining slots after real actions and only after them.
5. **Limit** — never returns more than `limit` (default 4).

## Files touched

- **New** `src/app/(app)/action-cards.ts` — pure builder + types.
- **New** `src/app/(app)/action-cards.test.ts` — unit test.
- **Edit** `src/modules/schedule/services/requests.ts` — `countPendingApprovals`.
- **Edit** `src/app/(app)/page.tsx` — assemble inputs, render `buildActionCards`
  output, `hueVars` refactor, import cleanup.
- **Edit** `src/app/globals.css` — `--mod-swap` token (light + dark).
