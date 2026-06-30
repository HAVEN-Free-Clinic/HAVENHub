# Recruitment cycle lifecycle: reopen + archive transitions

**Date:** 2026-06-30
**Issues:** [#104](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/104) (CLOSED is a dead end), [#105](https://github.com/HAVEN-Free-Clinic/HAVENHub/issues/105) (ARCHIVED unreachable)
**Area:** recruitment

## Problem

The recruitment cycle state machine is incomplete. Today the only transitions that
production code can perform are:

```
DRAFT ──publishCycle──> OPEN ──closeCycle──> CLOSED ──> (dead end)
```

Two gaps fall out of this:

- **#104 — CLOSED is irreversible from the UI.** `publishCycle` requires `DRAFT`
  and `closeCycle` requires `OPEN`. There is no `CLOSED → OPEN` transition. If an
  admin closes a cycle prematurely (e.g. to pause applications) the only way back
  is a manual DB edit.
- **#105 — ARCHIVED is defined and guarded but never set.** `CycleStatus.ARCHIVED`
  exists and four code paths defend against it — `listCycles` filters it out
  (`cycles.ts:69`), `setCycleDepartments` throws on it (`cycles.ts:170`),
  `releaseDecisions` blocks it (`decisions.ts:59`), and `submitOnboarding`/onboarding
  blocks it (`onboarding.ts:53`) — but no production path ever writes `ARCHIVED`.
  All four guards are dead code, and there is no way to retire an old cycle out of
  the active list. The overview page's `statusTone` map also omits `ARCHIVED`.

There is a direct precedent in the codebase: **Terms** already have a full
`ARCHIVED` lifecycle (`admin/services/terms.ts` `archiveTerm`) surfaced with a
two-click `ConfirmButton`. Cycles should match that shape.

## Approach

Complete the state machine by adding the two missing transitions. ARCHIVED becomes
a reachable terminal state; CLOSED gains a way back to OPEN.

```
DRAFT ──publish──> OPEN ⇄ CLOSED ──archive──> ARCHIVED (terminal)
                   └─reopen─┘
```

Both new transitions are gated on `recruitment.manage_cycles` (same permission as
publish/close), both write an audit record, and both are surfaced on the cycle
overview page only when the cycle is `CLOSED`.

### Service layer — `src/modules/recruitment/services/cycles.ts`

**`reopenCycle(id, actorId): Promise<RecruitmentCycle>`**
- Loads the cycle; throws `CyclePublishError("Cycle not found.")` if missing.
- Requires `status === "CLOSED"`; otherwise throws
  `CyclePublishError("Only a CLOSED cycle can be reopened.")`.
- Sets `status = "OPEN"`.
- **Stale-window handling (per design decision):** if `closesAt` is non-null and in
  the past (`closesAt < now`), clear it (`closesAt = null`) in the same update so the
  reopened cycle actually accepts applications again. `opensAt` and any future
  `closesAt` are left untouched. Rationale: the application window is a live soft gate
  inside the OPEN status, so reopening without clearing an expired `closesAt` would
  leave the public form gated shut and make Reopen appear to do nothing.
- Audit `recruitment.cycle_reopen`, recording `before/after` for `closesAt` when it is
  cleared (so the mutation is traceable).
- Does **not** re-run `publishCycle`'s validation: the cycle was valid when first
  published, and the only post-publish mutation (`setCycleDepartments`) does not
  affect publish validity. Keeping reopen a pure status flip avoids surprising an
  admin with a publish-time rejection on a cycle that already ran.

**`archiveCycle(id, actorId): Promise<RecruitmentCycle>`**
- Loads the cycle; throws `CyclePublishError("Cycle not found.")` if missing.
- Requires `status === "CLOSED"`; otherwise throws
  `CyclePublishError("Only a CLOSED cycle can be archived.")`.
- Sets `status = "ARCHIVED"`.
- Audit `recruitment.cycle_archive`.

Archive scope is **CLOSED only** (per design decision) — the terminal retire step.
DRAFT cycles are not archivable in this change.

### Actions — `src/app/(app)/recruitment/actions.ts`

Add `reopenCycleAction(cycleId)` and `archiveCycleAction(cycleId)`, each:
- `await requirePermission("recruitment.manage_cycles")`,
- call the service, catch `CyclePublishError` → `redirect(...?error=...)`,
- `revalidatePath(\`/recruitment/cycles/${cycleId}\`)` on success.

These mirror the existing `publishCycleAction` / `closeCycleAction` exactly.

### UI — `src/app/(app)/recruitment/cycles/[id]/page.tsx`

- Add `ARCHIVED: "default"` to the `statusTone` map (currently `{ DRAFT, OPEN, CLOSED }`),
  so an archived cycle's badge renders with a neutral tone instead of falling through
  to the `?? "default"` fallback. (Functionally a no-op given the fallback, but makes
  the map complete and self-documenting.)
- In the lifecycle action row:
  - `DRAFT` → Publish (unchanged)
  - `OPEN` → Close (unchanged)
  - `CLOSED` → **Reopen** (`SubmitButton`, outline) + **Archive**
    (`ConfirmButton label="Archive" confirmLabel="Archive this cycle?"`, which renders
    danger styling on the second click).
- Archived cycles are filtered out of `listCycles`, so they no longer appear in the
  cycle index. The detail page is still reachable by direct URL. For an `ARCHIVED`
  cycle, suppress the **Departments** editing form (its service explicitly rejects
  archived, so the form would only ever error) and render the department list
  read-only, with a short muted "This cycle is archived." note in the lifecycle row.
  The application-window form and renewals toggle are already gated to DRAFT/OPEN, so
  they need no change.

## Data model

No schema change. `CycleStatus.ARCHIVED` already exists in `prisma/schema.prisma`.
No migration required.

## Testing

Extend `src/modules/recruitment/services/cycles.test.ts` (TDD — tests written first):

`reopenCycle`:
- reopens a CLOSED cycle → status OPEN, writes `recruitment.cycle_reopen` audit
- clears a `closesAt` that is in the past on reopen
- leaves a future `closesAt` untouched on reopen
- leaves `opensAt` untouched on reopen
- throws when the cycle is not CLOSED (DRAFT and OPEN cases)
- throws when the cycle does not exist

`archiveCycle`:
- archives a CLOSED cycle → status ARCHIVED, writes `recruitment.cycle_archive` audit
- archived cycle is excluded from `listCycles`
- throws when the cycle is not CLOSED (DRAFT, OPEN cases)
- throws when the cycle does not exist

## Out of scope

- Archiving DRAFT cycles (abandoned drafts).
- Re-validating the form on reopen.
- Any change to the builder's edit-while-closed behavior.
- Auto opens/closes scheduling (the window remains a live soft gate, unchanged).
