# Strikes: person search, incident linking, expandable rows, and strike notifications

**Date:** 2026-07-22
**Status:** Approved (design)

## Problem

Five ops-reported gaps, four on the Strikes ledger (`/incidents/strikes`) and one in the
incident-report email:

1. **Emailed deep links dump you at the dashboard.** The `incidents.report_submitted` email's
   "Open the review queue" link points at `{app.baseUrl}/incidents/review`, which is the correct
   URL. But `requirePersonSession()` (`src/platform/auth/session.ts:75`) bounces a signed-out
   visitor with a bare `redirect("/login")` carrying no `callbackUrl`. The login page *fully
   supports* `callbackUrl` (`src/app/login/page.tsx:32-49`, with same-origin validation) -- nothing
   ever passes it. So the recipient signs in through SSO and lands on `/`, never reaching the
   queue. This affects **every** emailed deep link in the app, not just incidents.

2. **Strike emails never fire from the Strikes page.** The `incidents.strike_issued` template
   exists and works, but it is sent from exactly one call site: `decideStrike()`
   (`src/modules/incidents/services/report.ts:1019-1053`), i.e. only when a reviewer approves a
   strike request that arrived on an incident report. The "Record Disciplinary Action" form calls
   `issueAction()` directly and notifies nobody. That is why ops could not trigger one.

3. **The person field is a blind free-text box.** Central reviewers get a raw "NetID or email"
   `Input` resolved by an exact-match `findFirst`. A typo or a half-remembered NetID produces
   `error=person-not-found` with no way to browse.

4. **No way to link a strike to an incident report from the ledger.** `DisciplinaryAction.reportId`
   exists and is populated by `decideStrike()`, but a strike recorded directly on the Strikes page
   can never be associated with an INC -- neither at creation nor after the fact.

5. **Long descriptions are unreadable.** The Description cell is `line-clamp-2` with a `title`
   tooltip. Follow-up actions, policy reference, notes, and the linked report are stored but never
   displayed anywhere in the UI.

## Goals

- Emailed deep links survive the sign-in bounce, app-wide.
- Recording a strike notifies the subject and (when not confidential) their department directors,
  through the same `notify()` dispatcher the other incident emails use.
- Central reviewers pick a person from a searchable list instead of typing an identifier.
- A strike can be linked to an existing incident report at creation time or afterwards.
- A row can be opened to read the full description and the fields the table hides.

## Non-goals

- **No full edit form for strikes.** The only mutable field this adds is `reportId`. Changing
  category, description, or flags on an existing strike stays out of scope; the existing
  delete-and-re-record path covers it.
- **No new strike detail route.** Expansion happens in place on the ledger.
- **No schema migration.** `DisciplinaryAction.reportId` and its `@@unique([reportId, personId])`
  already exist.
- **No change to who may issue or delete a strike.** All new mutations require `incidents.manage`,
  matching the existing ledger form.
- **No change to `directorVisibility()`**, the confidential-row rule directors already live under.

## Decisions (from brainstorming)

- Strike notification recipients: **subject + their department directors**.
- Directors are **skipped when the strike is confidential**, matching `directorVisibility()`.
- The notification fires on **both** issue paths (Strikes page form and `decideStrike()`).
- Delivery moves from raw `queueEmail` to **`notify()`**, so both types get in-app inbox
  delivery, a Teams option, and an admin-configurable channel.
- The Record form gets a **"Notify by email" checkbox, checked by default**, so historical
  back-fills can be recorded quietly.
- Incident linking: **report picker on the Record form** (proactive) **plus a link/unlink control
  in the expanded row** (retroactive).
- Description opens **in place**, not in a modal or on a new page.
- The `callbackUrl` fix lands **globally in `requirePersonSession`**.

## Design

### 1. Login `callbackUrl` -- `src/platform/auth/session.ts`

`proxy.ts:19` already stamps `x-pathname` on every request that reaches a page. `enforceOnboarding`
in the same file already reads it, so the plumbing exists.

```ts
export async function requirePersonSession(): Promise<PersonSession> {
  const session = await auth();
  if (!session) {
    const path = (await headers()).get("x-pathname");
    redirect(path ? `/login?callbackUrl=${encodeURIComponent(path)}` : "/login");
  }
  // ... unchanged
}
```

Notes:

- **Only the `/login` bounce changes.** `/welcome` and `/no-access` keep their bare redirects; they
  are terminal explanation pages, not resumable ones.
- **`x-pathname` carries no query string.** `proxy.ts` stamps `nextUrl.pathname` only. Every current
  emailed link is path-only, so this is sufficient; the spec does not widen `proxy.ts`.
- **No open-redirect surface is added.** The login page re-parses `callbackUrl` against
  `config.APP_BASE_URL` and accepts only same-origin, slash-rooted paths, rejecting `//evil.com`
  and `/\evil.com`. It already had to, because the GitBook docs flow passes one.
- **Server actions have no path context.** `headers().get("x-pathname")` returns null there and the
  bare `/login` redirect is used, exactly as today.

### 2. Strike notifications -- `src/modules/incidents/services/strike-notifications.ts` (new)

The notification cannot live inside `issueAction()`: `decideStrike()` calls it with a transaction
client, and notifications must only queue after the strike commits. So it is a separate helper both
call sites invoke post-commit.

```ts
export type StrikeNotificationInput = {
  action: DisciplinaryAction;   // the committed strike
  actorPersonId: string;        // who issued it
};

/** Best-effort. Logs and swallows every failure; never throws into a committed mutation. */
export async function notifyStrikeIssued(input: StrikeNotificationInput): Promise<void>
```

Whether to notify at all is the **caller's** decision -- the helper has no opt-out parameter. The
Strikes page calls it only when the form's `notifyPeople` checkbox (labelled "Notify by email",
checked by default) was submitted; `decideStrike()` always calls it.

Recipient rules:

- **Subject** -- the person the strike is against. Always notified.
  Type `incidents.strike_issued`, using the existing template.
- **Directors** -- `departmentDirectorPersonIds()` (`src/platform/departments.ts`) unioned across the
  subject's ACTIVE department memberships in the ACTIVE term, deduped. Type
  `incidents.strike_issued_directors`, a new template.
  - **Skipped entirely when `action.confidential` is true.** This mirrors `directorVisibility()` in
    `disciplinary.ts:449`, where a director may only see a confidential row they issued themselves.
    Notifying them about a row they cannot open on the ledger would leak it. Because
    `decideStrike()` sets `confidential: report.anonymous`, this also stops anonymous-report
    strikes reaching directors.
  - **The subject is removed from the director set.** A director struck by a peer is not also sent
    the directors' copy.
  - **The issuing actor is removed from the director set.** They just recorded it.

Both notifications go through `notify(prisma, {...})` with an `email` and a `teams` form, matching
`notifyReviewersOfSubmission` in `report.ts`. Wrapped in one try/catch that logs via
`log.error`/`errorAttrs` and swallows, exactly like the other three incident notifiers.

#### Template: `incidents.strike_issued_directors` (new, in `src/platform/email/templates/incidents.ts`)

Variables: `directorName`, `subjectName` (full name, not first name), `category`, `issuedDate`,
`issuedBy`, `strikeCount` (the subject's running total, from the existing visibility-independent
`strikeCount(personId)` service in `disciplinary.ts`), `ledgerLink`
(`{app.baseUrl}/incidents/strikes`). Deliberately **omits the description** -- directors get the
categorical fact and a link to the ledger, where `directorVisibility()` governs what they can read.

Paired with a `strikeIssuedDirectorsContext()` builder, matching the file's existing convention that
every derived display string is precomputed so bodies stay pure interpolation.

#### Existing `incidents.strike_issued` template

Body and variables are unchanged. Only the delivery path changes: `renderEmail` +
`queueEmail` becomes `renderEmail` + `notify`. Since `notify()` calls `queueEmail` under the hood
with `template: input.type`, the `EmailLog` rows keep the same template key.

#### Registry -- `src/platform/notifications/registry.ts`

Two entries appended, both `defaultChannel: "email"`:

```ts
{ key: "incidents.strike_issued", label: "Incident: strike issued (subject)", defaultChannel: "email" },
{ key: "incidents.strike_issued_directors", label: "Incident: strike issued (directors)", defaultChannel: "email" },
```

`registry.test.ts` asserts the full key list and is updated. No migration: the settings registry
derives `notifications.<key>.channel` from this list with `envDefault: () => t.defaultChannel`, and
`getSetting` falls back to the env default when no `Setting` row exists.

#### Call sites

- **`decideStrike()`** -- the inline `try { ... } catch {}` block at `report.ts:1019-1053` is deleted
  and replaced with `await notifyStrikeIssued({ action: strikeAction, actorPersonId })`. This
  removes the duplicated `renderEmail`/`queueEmail`/date-formatting logic and the bare `catch {}`
  that currently swallows errors without logging.
- **`issueActionForm`** on the Strikes page -- after `issueAction()` returns, calls
  `notifyStrikeIssued` when the form's `notifyPeople` checkbox was submitted.

### 3. Person search -- `strikeablePeople()` in `disciplinary.ts`

New service beside `issuablePeople()`, for the central (`incidents.manage`) branch only:

```ts
export async function strikeablePeople(actorPersonId: string): Promise<
  Array<{ id: string; name: string; hint: string | null }>
>
```

- Requires `incidents.manage`; returns `[]` otherwise (the page only renders the combobox on the
  `issuable.all` branch, so directors never reach it).
- Returns **all** people, not just ACTIVE. Today's `findFirst` lookup has no status filter, so
  restricting to ACTIVE would regress the ability to record a strike against someone who has since
  offboarded. `PersonStatus` is `ACTIVE | OFFBOARDED` (there is no `INACTIVE` value); OFFBOARDED
  people sort last and their hint is suffixed `offboarded`.
- `hint` follows `listSubjectOptions`' convention: active-term department codes plus
  `volunteer`/`director`, so same-named people are distinguishable.
- Sort: ACTIVE first, then by name.

The page's central branch replaces the `personKey` `Input` with `<Combobox name="personId" ...>`.
`issueActionForm` then always reads `personId` and the `personKey` fallback branch
(`page.tsx:172-191`) is deleted along with the now-unreachable `person-not-found` lookup. The
`person-not-found` error code stays in `ERROR_MESSAGES` -- `issueAction` still throws
`DisciplinaryNotFoundError` for a stale id.

Director users keep their existing scoped `<Select>` unchanged.

### 4. Incident report linking

#### `linkableReports()` in `report.ts` (new)

```ts
export async function linkableReports(actorPersonId: string): Promise<
  Array<{ id: string; label: string }>
>
```

Requires `incidents.manage` (throws `IncidentForbiddenError` otherwise). Returns the 200 most
recent reports, newest first, labelled `#12 -- Professional Conduct, Patient Safety -- Jul 1, 2026`
using the existing `CONCERN_LABELS` map and the configured display time zone. The 200 cap is
explicit and documented in the JSDoc, since the `Combobox` filters client-side over whatever it is
given.

#### `linkActionToReport()` in `disciplinary.ts` (new)

```ts
export async function linkActionToReport(
  actorPersonId: string,
  actionId: string,
  reportId: string | null,   // null unlinks
): Promise<DisciplinaryAction>
```

- Requires `incidents.manage` → `DisciplinaryForbiddenError`.
- Missing action or missing report → `DisciplinaryNotFoundError`.
- A unique-constraint violation on `@@unique([reportId, personId])` is caught and rethrown as
  `DisciplinaryValidationError("That incident report already has a strike for this person.")`
  rather than surfacing as a raw 500.
- Audited as `disciplinary.link_report`, entityType `DisciplinaryAction`, with
  `before: { reportId }` and `after: { reportId }`.

#### Creation path

The Record form gains an optional "Related incident report" `Combobox` (`name="reportId"`), fed by
`linkableReports()`. `issueActionForm` passes it through to `issueAction`'s existing `reportId`
input field. A collision on the composite unique surfaces the same validation message.

#### Correctness fix this forces -- `deleteAction()` (`disciplinary.ts:233`)

`deleteAction` resets the source `IncidentReportSubject` to `PENDING` so a deleted strike can be
re-approved. Today that is safe because `reportId` is only ever set by `decideStrike()`, which
always leaves the subject `APPROVED`. Once a strike can be linked to an *arbitrary* report, a
subject sitting at `DECLINED` (or a `PENDING` row on a different subject) could be flipped by
deleting an unrelated strike. The `updateMany` is scoped:

```ts
where: { reportId: row.reportId, personId: row.personId, strikeDecision: "APPROVED" }
```

`StrikeDecision` is `PENDING | APPROVED | DECLINED`. Rows that were never approved are left alone.

### 5. Expandable rows -- `src/app/(app)/incidents/strikes/strike-row.tsx` (new, client)

The ledger's `<tbody>` maps to a client `StrikeRow` per action instead of an inline `<TR>`.

- Collapsed: the current seven columns, unchanged, plus a chevron toggle button on the Description
  cell (`aria-expanded`, `aria-controls`).
- Expanded: a second `<TR>` with a `colSpan` cell containing the full description and the fields the
  table hides -- follow-up actions, policy reference, notes, and the linked report -- each rendered
  only when present. Notes are labelled as internal.
- The linked-report control lives here: a `Combobox` + "Link" submit, or the current report's label
  with an "Unlink" button, both posting to a `linkReportForm` server action. Rendered only when
  `canManageAll`.
- Props are plain serializable data. Dates are **preformatted to strings on the server** rather than
  passed as `Date` objects. The `deleteActionForm` and `linkReportForm` server actions pass through
  as props, which RSC supports.
- No module-level plain-data exports from this client file, per the `"use client"` plain-data proxy
  hazard.

## Testing

Service-level (Vitest, throwaway pg on :5434), mirroring `disciplinary.test.ts` /
`report.test.ts` conventions:

- `notifyStrikeIssued`: notifies the subject; notifies their department directors; **skips all
  directors when `confidential`**; excludes the subject from the director set; excludes the issuing
  actor; is a no-op for a subject with no active membership; swallows a delivery failure.
- `decideStrike` still notifies the subject after the refactor, and an anonymous report's strike
  reaches no director.
- `linkActionToReport`: links; unlinks; rejects a non-`incidents.manage` actor; rejects an unknown
  action or report; translates the composite-unique collision to a validation error; writes the
  audit row.
- `deleteAction`: resets an `APPROVED` subject to `PENDING` (existing behaviour holds); **leaves a
  `DECLINED` subject untouched** (the new scoping).
- `strikeablePeople`: includes OFFBOARDED people; sorts active first; hints department and kind;
  returns `[]` (not a throw) for a non-central actor, since the page only renders the combobox on
  the central branch.
- `linkableReports`: rejects a non-central actor; caps at 200; labels correctly.
- `requirePersonSession`: redirects to `/login?callbackUrl=<path>` when `x-pathname` is present and
  to bare `/login` when it is not.

`src/platform/notifications/registry.test.ts` (which asserts the full key list) updated for the two
new keys. `src/platform/settings/registry.test.ts` needs no change -- it walks the derived list
generically rather than hardcoding keys.

## Risks

- **Two new notification types start sending on deploy.** Strikes recorded on the ledger have never
  emailed anyone; after this, they email the subject and their directors by default. The opt-out
  checkbox and the per-type admin channel setting are the mitigations. Worth telling ops before the
  first post-deploy strike.
- **The `callbackUrl` change touches every gated page in the app.** It is additive (a query
  parameter on a redirect that already happens) and the destination is validated by code that
  already exists, but it is the widest blast radius here.
