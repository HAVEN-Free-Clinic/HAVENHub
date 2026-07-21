# Scheduling Term-Awareness — Spec 2: Publish Gate + Member Next-Term Self-Service

Date: 2026-07-21
Status: Approved design, ready for implementation planning
Branch: `feat/next-term-scheduling-publish` (stacked on `feat/next-term-scheduling` / PR #344, which is stacked on the cross-term foundation / PR #343)
Depends on: Spec 1 (the term-aware builder: `getWorkingTerm`, `builderView`/write services take `termId`, the archived read-only guard) and the cross-term foundation (`getPersonTerms`).

## 1. Goal and shape

Spec 1 made the schedule *builder* term-aware so staff can build the next term ahead. But members, requests, and the reminder crons still resolve the active term, and there is no way to release a built next-term schedule to members — the only thing hiding an unfinished next-term schedule today is that member reads accidentally filter by the active term. Spec 2 adds:

1. A **per-department publish gate** so directors deliberately release a built next-term schedule to members (reversible; the live term is never gated).
2. **Member next-term self-service**: edit next-term availability before publish (input to the build), and — once published — view the next-term schedule and request swaps/drops on it.
3. The **request-approval + reminder routing** made term-aware, fixing the latent wrong-term-routing bug Spec 1 deferred.

This is **Spec 2 of the two-spec next-term-scheduling sequence** the product owner approved. Spec 1 is the staff build-ahead foundation; this spec completes member participation and the safety gate that makes it non-leaky.

### 1.1 Design decisions (locked)

- **Per-department publish (Q1=A):** each department director publishes their own next-term schedule when ready; a member sees their next-term assignments for a department only once that department has published.
- **Full member next-term self-service (Q2=B):** view + swaps (post-publish) AND next-term availability editing (pre-publish, as input to the build).
- **Publish = a reversible visibility toggle; post-publish edits are live (Q3=A):** publishing flips visibility on; later director edits show immediately (like the live term); un-publish hides it again. No snapshots.
- **One term-grouped `/schedule` page (Q4=A):** mirrors the training/onboarding multi-term pattern. Live term renders as today; the next term is its own section (availability now, schedule once published).

### 1.2 In scope

- New `SchedulePublication` model + additive migration; publish/unpublish service; a builder publish control (next-term only).
- Term-aware `updateMyAvailability`; term-grouped `/schedule` page with a pre-publish next-term section.
- Publish-gated `mySchedule` spanning live + published-next-term; term-aware `createRequest` / `eligibleSwapPartners`.
- Term-aware `requestApproverRecipients` / `listDepartmentRequests`; the builder requests panel un-gated to the working term; the `schedule-reminders` cron term-routing fix.

### 1.3 Out of scope (deferred, not this spec)

- Incoming-only-director department scope (the shared `departments.ts`/RBAC term-awareness) — still deferred.
- `shift-reminders` cron stays live-term (correct: it is about the running term).
- Learning/EHS multi-term (a cross-term follow-up unrelated to scheduling).

## 2. The publish model (schema change)

The one schema change in this spec.

### 2.1 Model

```
model SchedulePublication {
  id            String   @id @default(cuid())
  termId        String
  departmentId  String
  publishedAt   DateTime @default(now())
  publishedById String?
  term          Term       @relation(...)
  department    Department @relation(...)
  publishedBy   Person?    @relation(...)
  @@unique([termId, departmentId])
  @@index([termId])
}
```

**The row exists iff that department's schedule for that term is currently published.** Publish = create the row; un-publish = delete it. Both are audited via `recordAudit` (the current publish/who is on the row; full history lives in the audit log). This is the reversible toggle with no nullable-state ambiguity. Re-publish after un-publish creates a fresh row.

### 2.2 The gate applies only to non-live terms

The `ACTIVE` (live) term's schedule is **always visible** to members, with no publication row required — current-term behavior is byte-identical. The publish gate governs only the next (`PLANNING`) term. A helper resolves the published set for a term:

```
publishedDepartmentIds(termId: string): Promise<Set<string>>  // department ids with a SchedulePublication row for termId
```

Member views consult it only when spanning a non-live term.

### 2.3 Publish/unpublish service

```
publishSchedule(actorId, { termId, departmentId }): Promise<void>    // create the row, audited
unpublishSchedule(actorId, { termId, departmentId }): Promise<void>  // delete the row, audited
```

Both are scope-guarded by `manageableScheduleDepartmentIds` (the same scope that builds). Both reject a `termId` that is the live (`ACTIVE`) term or an `ARCHIVED` term via a typed error (publishing the live term is meaningless; archived is read-only) — publishing only makes sense for the next (`PLANNING`) term.

### 2.4 Builder control

The builder page (already term-aware from Spec 1) gains a "Publish this department's {term} schedule" / "Unpublish" control, rendered **only when the working term is the next term** and the department is in scope. Live term: no control (always visible). Archived: read-only (no control).

## 3. Member next-term availability (pre-publish)

### 3.1 Term-grouped `/schedule`

`/schedule` iterates `getPersonTerms(personId)` (live + next terms the member is an active member of) and renders one section per term, mirroring training/onboarding. The live section renders exactly as today. A returning member sees live + next; a brand-new next-term recruit sees only the next section.

### 3.2 Term-aware availability

`updateMyAvailability` stops resolving the active term and takes an explicit term:

```
updateMyAvailability(actorPersonId, { termId, dates, now? }): Promise<void>
```

It validates `termId` is one of the member's live/next terms (they hold an active membership in it), writes against that term's membership, and validates dates against that term's `clinicDates`. So a promoted next-term member edits their next-term availability while a different term is live — the input directors build against. Availability editing is **open pre-publish** (it does not depend on the publish gate; it requires only an active membership in the term).

### 3.3 Acknowledgement reuse

The member's edit stamps `availabilityUpdatedAt` on their next-term membership; directors see it flagged in the next-term builder and acknowledge there via the existing `acknowledgeAvailability` (already term-safe, derives the term from the membership). No new race machinery.

### 3.4 Pre-publish next-term section

Before the department publishes, the next-term section shows the availability editor (open) plus a "Your {term} schedule isn't published yet — it'll show here once it's ready" placeholder where the grid will go. No assignments render, because none are visible until publish (4).

## 4. Published next-term view + swaps (the no-leak invariant)

### 4.1 Publish-gated `mySchedule`

`mySchedule` becomes term-aware and returns, per term:
- **Live term:** all the member's assignments, exactly as today (no gate).
- **Next term:** the member's assignments **only for departments in `publishedDepartmentIds(nextTermId)`**. An unpublished department contributes nothing — not a redacted row, nothing.

This single rule is the core safety invariant. Once `mySchedule` spans the next term, the accidental active-term protection is gone and the publish gate is the sole control, so it gets dedicated, mutation-minded tests (see 6).

### 4.2 Term-aware swaps (naturally post-publish)

A member can only act on an assignment they can see, and next-term assignments are visible only after publish, so next-term requests exist only for published departments. The request services become term-aware:
- `createRequest` stamps the request with the *assignment's* term (not the active term); for a next-term request it re-checks the department is published (defense in depth against a stale/crafted request after un-publish).
- `eligibleSwapPartners` finds partners within the assignment's term.
- The swap UI renders on the published next-term grid exactly like the live grid.

### 4.3 Live post-publish edits + un-publish

Post-publish, a director's edits flow straight to members through the same `mySchedule` read (no re-publish). Un-publishing removes the department from `publishedDepartmentIds`, so its next-term assignments instantly vanish from member views again (the escape hatch), and new next-term swap requests against it are refused (4.2).

## 5. Request routing + reminder crons

### 5.1 Term-aware approver routing (fixes the latent bug)

`requestApproverRecipients` takes the request's term:

```
requestApproverRecipients(departmentId, termId): Promise<Person[]>  // that term's department directors
```

The current version hard-resolves the active term — the documented wrong-term-routing bug (a next-term request's reminder would go to the current term's directors). `approveRequest`/`denyRequest` are already term-safe (they use the request's own term). `listDepartmentRequests` gains the working term so the builder shows the correct term's pending requests.

**Builder requests panel — un-gates from Spec 1.** Spec 1 rendered the builder's pending-requests / approve / deny panel only for the live term (there were no next-term requests then). Spec 2 makes it render for the *working* term (live shows live requests, next shows next-term requests via the now-term-aware `listDepartmentRequests`), since next-term swap requests can now exist post-publish. Archived remains read-only (no panel).

**`countPendingApprovals` (dashboard widget) stays live-term** in this spec. The dashboard "Approvals" card is a running-term operational view; next-term pending requests surface in the next-term builder's requests panel (above), not the dashboard count. Keeping the widget live-term avoids scope creep and a second, differently-scoped surface for the same data.

### 5.2 `schedule-reminders` cron fix

The `schedule-reminders` cron (nudges directors about stale pending requests) currently routes via the active term's directors. Fix it to route each pending request via its own `termId` (through the term-aware `requestApproverRecipients`). This bug was unreachable in Spec 1 (no next-term requests existed); Spec 2 makes it reachable, so Spec 2 fixes it.

### 5.3 `shift-reminders` stays live-term

The weekly "you're on this Saturday" email is about the running term. It keeps resolving the active term, unchanged — you do not remind someone about a shift in a term that has not started.

## 6. Migration, backward-compat, edge cases

- **Migration:** one additive `SchedulePublication` table, no backfill (no existing schedule is "published" under the new model; the live term needs no row).
- **Backward-compat:** with no next term (the steady state), members have only a live-term section and every path collapses to today's behavior. The live term is never publish-gated, so current-term scheduling is byte-identical.
- **Edge cases:**
  - A member promoted to the next term with no published department yet: an availability-only next-term section (no schedule).
  - Un-publish mid-flight: the department's next-term assignments vanish from member views immediately; existing next-term requests survive (they reference a real assignment) and are still routed/approved via their own term; new next-term requests against the now-unpublished department are refused.
  - A member with no next-term membership: no next-term section at all.
  - No active term (between archive and activate): members see only next-term sections (availability + any published schedule); no live section.

## 7. Testing

- **The publish gate (headline):** `mySchedule` returns next-term assignments ONLY for published departments; an unpublished department yields nothing; un-publish makes a previously-visible next-term assignment vanish; the live term is never gated.
- **Availability:** `updateMyAvailability` writes to the passed term and rejects a term the member is not an active member of; a next-term availability edit stamps the next-term membership and is visible to the next-term builder's acknowledge flow.
- **Swaps/requests:** `createRequest` stamps the assignment's term and refuses a next-term request whose department is not published; `eligibleSwapPartners` scopes to the assignment's term.
- **Routing (regression for the fixed bug):** `requestApproverRecipients` returns the request term's directors, not the active term's; a next-term pending request's `schedule-reminders` nudge routes to that term's directors.
- **Publish service:** scope-guarded; rejects publishing the live (`ACTIVE`) or an `ARCHIVED` term; publish then unpublish leaves no row.
- **Backward-compat:** with a single active term, `mySchedule`/`updateMyAvailability` behave exactly as before.
- **Page wiring** (RSC): `tsc` + full `npm run lint`; e2e is Playwright/manual (cannot run locally here).

## 8. Done criteria

- A director can publish/unpublish their department's next-term schedule from the builder (next-term only; live/archived rejected).
- A promoted next-term member can edit their next-term availability while a different term is live, and directors see it in the next-term builder.
- A member sees their next-term assignments only for departments that have published, and can request swaps on them; un-publishing hides them again immediately.
- No unpublished next-term schedule is ever visible to any member (the no-leak invariant), verified by dedicated tests.
- Next-term requests are approved and their reminders routed via the request's own term.
- With a single term in flight, member scheduling behaves byte-identically to today.
- Existing tests pass; new tests cover the publish gate, term-aware availability/requests, and the routing fix.
