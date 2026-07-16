# Recruitment Speed Route: Design Spec

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Builds on:** the committee-scoring pipeline (PR #292), speed-scoring (PR #295), conditional questions / default templates (PR #293)

## Goal

Give a recruitment lead (SRR) a fast way to move a whole cycle of scored volunteer applicants forward: auto-route the strongest applicants to a department for that department's review, auto-reject the weakest, and speed through the grey-area middle one applicant at a time. Which applicants land in each tier is driven by per-cycle percentile thresholds the lead can configure.

## Architecture

A per-cycle threshold config (two integer fields on `RecruitmentCycle`), a pure bucketing engine that partitions scored applicants into top / middle / bottom / unscored by committee average, a board service that assembles the per-applicant view, immediate-write routing and rejection services (single-row plus batch), and a Speed Route screen with a keyboard queue modal. Every write is immediate and reversible; nothing sends an outward-facing email (decision release stays a separate step).

## Tech Stack

Next.js App Router (RSC + server actions), Prisma, TypeScript, vitest (unit + service/DB), Playwright (e2e). UI primitives in `src/platform/ui/*`.

## Global Constraints

Every task inherits these.

- No em-dashes anywhere (prose, comments, copy). Use colons, parentheses, or restructure.
- `cx` helper only for class composition; there is NO tailwind-merge, so later classes do not override earlier ones. Do not rely on class order to override.
- ESLint `no-restricted-syntax` bans raw `className` on native `button`/`input`/`select`/`textarea`. Use the `src/platform/ui` primitives (`Button`, `Input`, `Select`, `Checkbox`, `Modal`, `Alert`, `Badge`, `Card`, `Table`, `SubmitButton`, `Field`, `Spinner`).
- React Compiler lint rules are on (`react-hooks/refs`, `react-hooks/set-state-in-effect`, `react-hooks/preserve-manual-memoization`). Follow the patterns already used in `speed-score-modal.tsx`: lazy `useState` snapshot instead of a render-time ref read; refs mutated only outside render; narrowly-scoped `eslint-disable-next-line` with a one-line reason only where genuinely required.
- Shared constants/types that cross the RSC boundary (server component importing a value out of a `"use client"` module) must live in a non-directive module, or they arrive as client-ref proxies and array methods throw.
- All timestamps render through the app's Eastern-Time display helpers (`@/platform/dates/display`, e.g. `DateTime`), never raw `toLocaleString`.
- Speed Route is VOLUNTEER-track only (director-track cycles have no routing stage) and gated on `recruitment.review_all` throughout.
- Recording routes and rejections sends NO email. Applicant notification remains the separate `releaseDecisions` step.
- Modal uses the shipped `size="large"` prop (`modal-size.ts`).

## Current pipeline (recap)

For a VOLUNTEER cycle today:

1. Committee members score each SUBMITTED application 1 to 5 (`CommitteeScore`, one per scorer). `committeeScoreSummary` gives the average and count.
2. An SRR (`recruitment.review_all`) routes each application to a best-fit department via `routeApplication`, which sets `Application.routedDepartmentCode` (off-choice routing is allowed and flagged). Re-routing to a different department clears a stale non-emailed acceptance and resets `decision`.
3. The routed department's director (or SRR) records ACCEPT / REJECT / WAITLIST via `decideRoutedApplication`, which mints an `Acceptance` on ACCEPT and stores the outcome on `Application.decision`. This path REQUIRES a routed department, so there is no reject-without-routing today.
4. Later and separately, `releaseDecisions` emails acceptances and stamps `decisionsReleasedAt`; the applicant portal surfaces not-selected / waitlist status only after that stamp.

The derived `applicationStage` is AWAITING_SCORING -> SCORING -> ROUTED -> INTERVIEWING (director track) -> DECIDED, computed from score count, routed department, and decisions.

## Feature overview and flow

Entry point: a **Speed route** button on the applicants list (`recruitment/cycles/[id]/applicants`), shown next to Speed score when the viewer has `scope.all`, the cycle is VOLUNTEER track, and at least one applicant is scored. It links to a dedicated Speed Route screen.

On the Speed Route screen:

1. A **threshold editor** shows the cycle's saved top and bottom percentages with live tier counts. Editing saves to the cycle.
2. Scored applicants are partitioned into **Top / Middle / Bottom**, with **Unscored** listed separately ("score these first", not actionable here).
3. Each row shows name, committee average and count, ranked department choices, current stage / routed department / decision, and a proposed action:
   - **Top -> Route to first choice** (`departmentChoices[0]` when it is a department in the cycle; otherwise the row shows "Needs department" and the dept select must be set before applying). The department is an editable select so the lead can override per applicant.
   - **Middle -> undecided.** The lead routes to a department, rejects, or leaves it for later.
   - **Bottom -> Reject** (editable; can be flipped to route or left).
4. **Apply top tier** and **Apply bottom tier** buttons each sit behind a confirm dialog and fire their batch immediately (routes for top, rejects for bottom). Rows the batch cannot apply (for example an already-emailed acceptance) are skipped and reported, not aborted.
5. **Route the middle** opens the keyboard queue modal over the undecided applicants. Per applicant: number keys pick one of the ranked departments (route immediately), `R` rejects, `->` skips, auto-advance. A "show decided" toggle and a done summary mirror the speed-score modal.

Every action writes immediately and the board reflects new stages on refresh. All actions are reversible before `releaseDecisions`: re-route via `routeApplication`, and reopen a reject via `reopenDecision`.

## Data model

Add two fields to `RecruitmentCycle`:

```prisma
routeTopPercent    Int @default(20)
routeBottomPercent Int @default(30)
```

One additive migration. Middle is the remainder (`100 - top - bottom`). Defaults 20 / 30. Existing rows get the defaults.

## Bucketing engine (pure)

New file `src/modules/recruitment/engine/route-buckets.ts`.

```ts
export type RouteBucketItem = { applicationId: string; average: number | null };
export type RouteBuckets = {
  top: string[];
  middle: string[];
  bottom: string[];
  unscored: string[]; // average == null, excluded from ranking
};
export function bucketByPercentile(input: {
  items: RouteBucketItem[];
  topPercent: number;
  bottomPercent: number;
}): RouteBuckets;
```

Normative rules:

1. `unscored` = items with `average == null`. The rest are `scored`; `N = scored.length`. If `N == 0`, all buckets except `unscored` are empty.
2. Sort `scored` by `average` descending; break ties by `applicationId` ascending (stable, deterministic display order only; tie-break never affects tier membership because membership is defined by average value, below).
3. `topCount = round(topPercent / 100 * N)`, `bottomCount = round(bottomPercent / 100 * N)`. Clamp `topCount` to `[0, N]`, then clamp `bottomCount` to `[0, N - topCount]` so the two never overlap.
4. **Ties are never split; when a cut lands inside a tie, the whole tie resolves in the applicant's favor (into the higher tier).**
   - Top: if `topCount == 0`, top is empty. Else `topThreshold = average at sorted index (topCount - 1)`; `top = { avg >= topThreshold }`. A boundary tie grows top (more applicants advance).
   - Bottom: if `bottomCount == 0`, bottom is empty. Else `boundaryVal = average at sorted index (N - bottomCount)`. Let `aboveVal = average at index (N - bottomCount - 1)` when that index is still below the top set, else none. If `aboveVal` equals `boundaryVal`, the boundary tie straddles the reject line, so spare the whole tie: `bottom = { avg < boundaryVal }`. Otherwise the tie is clean: `bottom = { avg <= boundaryVal }`. Exclude any applicant already in top.
   - Middle = scored applicants in neither top nor bottom.

Worked examples (become test cases):

- `[4.5,4.5,4.0,3.5,3.0,3.0,2.5,2.0,2.0,2.0]`, top 20 / bottom 30 (N=10, topCount 2, bottomCount 3): top = the two 4.5s; boundaryVal = 2.0, aboveVal = 2.5 (clean), bottom = the three 2.0s; middle = the middle five.
- `[3,3,3,3,3,1]`, top 20 / bottom 30 (N=6, topCount 1, bottomCount 2): topThreshold = 3 so top grows to all five 3s; boundaryVal = 3, aboveVal = 3 (straddle) so bottom = `{ avg < 3 }` = just the 1; middle empty.
- `[5,4,3,2,2,2]`, top 20 / bottom 30 (N=6, bottomCount 2): the bottom cut lands inside the 2.0 tie, which reaches the minimum, so the whole tie is spared into the middle and bottom is empty. A straddling tie is always spared in the applicant's favor, even when it is the lowest group, so with clustered integer scores the bottom tier can come up empty and the board shows the real count.
- All-equal `[3,3,3,3]`: top grows to all four; bottom empty; nobody rejected on a total tie.
- Small N `[5,1]`, top 50 / bottom 50: topCount 1, bottomCount clamped to 1; top = the 5, bottom = the 1, middle empty.
- Unscored mixed in: `average == null` rows go to `unscored` and never affect N or the cuts.

Because ties are never split, a tier can exceed its nominal percentage when the boundary lands inside a tie. The board shows actual counts so the lead sees this and can adjust the percentages or override rows.

## Board service and view model

New file `src/modules/recruitment/services/speed-route.ts`.

```ts
export type SpeedRouteRow = {
  applicationId: string;
  name: string;
  average: number | null;
  scoreCount: number;
  departmentChoices: string[];
  proposedDepartmentCode: string | null; // departmentChoices[0] if it is a cycle department, else null
  routedDepartmentCode: string | null;
  decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST";
  stage: ApplicationStage;
  acceptanceEmailed: boolean; // true when an emailed acceptance exists (guards apply)
};
export type SpeedRouteBoard = {
  cycleId: string;
  track: string;
  departments: string[];       // cycle departments, for the dept selects
  topPercent: number;
  bottomPercent: number;
  top: SpeedRouteRow[];
  middle: SpeedRouteRow[];
  bottom: SpeedRouteRow[];
  unscored: SpeedRouteRow[];
};
export function loadSpeedRouteBoard(cycleId: string, viewerId: string): Promise<SpeedRouteBoard>;
```

`loadSpeedRouteBoard` re-checks `recruitment.review_all` and that the cycle is VOLUNTEER track (throws `RecruitmentAuthError` / `RoutingError` otherwise), loads SUBMITTED applications with committee scores and applicant names, computes each average via `scoreAverage`, buckets ids with `bucketByPercentile`, and assembles rows sorted within each tier by average descending. Already-routed / already-decided applicants keep their real state so re-running is safe and idempotent-friendly.

## Services and server actions

Reused as-is:
- `routeApplication(applicationId, departmentCode, actorId)` for single-row routing (keyboard queue "route to dept", and any row-level route).

New in `src/modules/recruitment/services/routing.ts` (or a sibling), reusing shared guard helpers so single-row and batch cannot drift:

- `rejectApplication(applicationId, actorId, notes?)`: reject without routing. Guards: `review_all`; application exists and is SUBMITTED; cycle is VOLUNTEER; separation of duties (a signed-in applicant may not reject their own); refuse if an emailed acceptance exists. Writes `decision = REJECT`, `decidedById`, `decidedAt`, `decisionNotes`; creates no acceptance; leaves `routedDepartmentCode` untouched (null for a pure bottom-tier reject). Audits `recruitment.application_reject`.
- `reopenDecision(applicationId, actorId)`: inverse of a decision. Tears down any not-emailed acceptance in the same transaction (so reopening a routed ACCEPT cannot leave a live acceptance for `releaseDecisions` to email), then sets `decision = PENDING` and clears `decidedBy*`, `decidedAt`, `decisionNotes`. Guards: `review_all`; SUBMITTED and VOLUNTEER only; refuse when the application still has no decision, when `decisionsReleasedAt` is set, or when an acceptance is emailed or has an onboarding contract (nothing to safely reopen once the applicant was told or onboarding started). Audits `recruitment.application_reopen`. The board only offers Reopen on a REJECT row; ACCEPT/WAITLIST are decided from the detail page.
- `applyTierRoutes(cycleId, entries: { applicationId: string; departmentCode: string }[], actorId)`: batch route. Checks `review_all` once, loads the target applications once, applies each with the same per-row guards as `routeApplication`, skipping (not aborting) any row that fails a guard. Returns `{ applied: number; skipped: { applicationId: string; reason: string }[] }`. Per-row audits.
- `applyTierRejects(cycleId, applicationIds: string[], actorId, notes?)`: batch reject with the same shape and guard reuse as above.
- `setRouteThresholds(cycleId, topPercent, bottomPercent, actorId)`: `review_all`-gated; validates each integer in `0..100` and `topPercent + bottomPercent <= 100`; writes the two cycle fields. Audits `recruitment.route_thresholds`.

Server actions live in the cycle route (`recruitment/cycles/[id]/speed-route/actions.ts`) and wrap the services without redirecting (they return results so the client can update in place): `speedRouteRouteAction`, `speedRouteRejectAction`, `speedRouteReopenAction`, `applyTopTierAction`, `applyBottomTierAction`, `setRouteThresholdsAction`.

## UI

- **`SpeedRouteLauncher`** (`components/speed-route-launcher.tsx`): a `Link`/button rendered on the applicants page under the `scope.all && track === "VOLUNTEER" && scoredCount > 0` gate. Navigates to the Speed Route screen. (A `Link` is enough; no modal launcher needed since the screen is a page.)
- **Speed Route screen** (`app/(app)/recruitment/cycles/[id]/speed-route/page.tsx`): server component. Guards `review_all` + volunteer track (else `notFound`). Loads the board and renders the threshold editor (small form calling `setRouteThresholdsAction`), the three tier `Table`s with per-row dept `Select` (top and any row being routed) and inline Apply/Reject/Reopen controls, the two batch buttons behind confirm dialogs, and the "Route the middle" button that opens the modal. Breadcrumb via `cycleTrail`.
- **`SpeedRouteModal`** (`components/speed-route-modal.tsx`, `"use client"`): keyboard queue over the undecided middle (or a chosen tier). Per applicant shows name, average, ranked departments as numbered options, and the condensed context. Keys: `1..k` route to the k-th ranked department (immediate `routeApplication` via the passed action), `R` reject (immediate), `->`/`<-` navigate, `Esc` close. A "show decided" toggle and a done summary. Reuses the speed-score modal's proven patterns (lazy `useState` snapshot, `loadedRef`-style guards, immediate write then advance, `router.refresh()` from the launcher/host on close so the board reflects new stages).
- **Detail page change** (`app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx`): the "Department decision" card currently shows "Awaiting committee routing" whenever `routedDepartmentCode` is null, which now misrepresents a bottom-tier applicant rejected without routing. Update it so a not-routed applicant with `decision !== PENDING` shows the decision (for example "Rejected") and, for `review_all`, a reopen control calling `reopenDecision`. Routed applicants keep today's behavior.

## Permissions and safety

- All Speed Route reads and writes require `recruitment.review_all` and a VOLUNTEER cycle. Threshold editing is `review_all` too (it is a routing control).
- Separation of duties: a signed-in applicant who also reviews cannot reject their own application (mirrors scoring / acceptance / interview guards).
- Batch actions never abort on one bad row; they skip with a reason and report a summary, so one already-emailed acceptance cannot block routing the rest.
- No outward-facing email fires. Everything is reversible before `releaseDecisions`.
- Confirm dialogs guard the two batch applies (routing or rejecting many at once).

## Testing

- **Engine unit tests** (`route-buckets.test.ts`): every worked example above, plus empty input, all-unscored, `topPercent + bottomPercent == 100`, rounding edges, single applicant, and the overlap clamp.
- **Service / DB tests** (native pg, isolated per-worktree test DB): `rejectApplication` (auth, SUBMITTED / volunteer guards, self-reject block, emailed-acceptance refusal, writes REJECT with no acceptance); `reopenDecision` (revert, refusal after release / email); `applyTierRoutes` and `applyTierRejects` (batch apply, skip-with-reason, per-row audit, permission checked once); `setRouteThresholds` (validation bounds and sum rule); `loadSpeedRouteBoard` (bucketing wired to real scores, auth, track guard, proposed department resolution).
- **E2E** (`e2e/recruitment-speed-routing.spec.ts`): build a VOLUNTEER cycle, submit several applicants, score them into a spread that yields all three tiers, open Speed Route, apply the top tier (assert routed stages), apply the bottom tier (assert rejected / DECIDED stages), route the middle by keyboard, and assert the applicants roster reflects the new stages and decisions.

## Non-goals and deferred

- No auto-accept: the top tier routes for the department's own decision; Speed Route never mints an acceptance.
- No new applicant-facing status or email; notification stays with `releaseDecisions`.
- No director-track support (director cycles use interviews, not routing).
- No confidence weighting by score count; ranking is by raw average with the count shown. A future refinement could weight or gate low-count averages.
- No persisted "needs second review" flag on the middle tier; the middle is simply whatever is left undecided.

## Resolved decisions

- UX model: bulk preview board plus a keyboard queue for the middle (a mix of both), immediate writes.
- Top tier routes to a department for the department's review, never auto-accepts.
- Route target defaults to the applicant's first ranked choice; rows whose first choice is not a cycle department are flagged "Needs department"; the lead can override any row's department.
- Thresholds are saved per cycle (schema fields, defaults 20 / 30, editable).
- Commit model: immediate writes (keyboard queue routes / rejects per keypress; batch tier applies fire on confirm), matching the speed-score pattern.
