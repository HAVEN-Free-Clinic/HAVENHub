# Outreach: delegated, scope-bounded email campaigns

Date: 2026-08-31
Status: approved design, not yet planned

## Problem

Email campaigns today are an admin-only feature with an all-or-nothing gate
(`admin.send_email_campaign`) and an unbounded audience: anyone holding the
permission can mail every Person in the database. That is why it has stayed
admin-only. Handing it to a department lead is not a matter of granting the
permission more widely, because nothing constrains who a grantee can reach.

Three consequences follow:

1. **Outreach bottlenecks on admins.** Every department that wants to mail its
   own people files a request instead of sending.
2. **The audience engine cannot express time.** It has 23 fields and *zero*
   date fields. "Certificates expiring in the next 30 days", "joined before
   January", "hasn't logged in since spring" are not expressible, which rules
   out most recurring outreach anyone actually wants.
3. **Recurring campaigns re-mail everyone, every run.** `@@unique([campaignRunId,
   toEmail])` dedups *within* a run, not across runs. A weekly reminder nags the
   same person indefinitely unless the audience conditions themselves happen to
   stop matching.

## Goals

- Delegate sending to non-admins, bounded by an explicit, admin-defined audience.
- Bring the targeting surface to parity with what an Airtable filter can express:
  dates, numbers, many more fields, and a manual include/exclude escape hatch.
- Make recurring campaigns able to mail each person once.
- Replace the single-page editor with a builder that stays legible at 50 fields
  and a nested condition tree.

## Non-goals

Explicitly out of scope, decided during brainstorming:

- **No trigger/workflow engine.** No event triggers ("when a person is
  offboarded"), no multi-step sequences with waits and branches, no non-email
  actions. Timing stays now / scheduled / cron.
- **No new audience record types.** `PERSON` only; the `APPLICANT` recordType
  seam stays unused.
- **Templates, the email monitor, and sender rules stay in Admin.** They are
  platform plumbing, not outreach.

## Architecture

### The module

A new top-level module `outreach`, because `src/platform/modules/registry.test.ts`
enforces that every permission is prefixed by its module id. A delegated
permission therefore *cannot* remain `admin.*` without also granting the Admin
module tile and everything gated on module access.

| Permission | Holder | Grants |
| --- | --- | --- |
| `outreach.access` | any delegated sender | module tile and nav |
| `outreach.send` | department leads, coordinators | compose and send, **only within granted scopes** |
| `outreach.send_unrestricted` | admins | send with no scope constraint (today's behavior) |
| `outreach.manage_scopes` | admins | define scopes and grant them |

Routes move `/admin/email/campaigns/*` to `/outreach/campaigns/*`. The audience
engine stays where it is (`src/platform/email/audience/`) because scopes reuse
it; only routes and permission strings move.

`admin.send_email_campaign` appears in no entry of `SYSTEM_ROLES`. Platform
Admin reaches it through the `*` wildcard. So the wildcard holders need no
migration, and only hand-made custom roles carrying the string explicitly do.

### Audience scopes

A scope **is an audience tree**: the same `Audience` type, built with the same
builder, saved under a name. One engine, one mental model, and scopes double as
reusable segments.

```prisma
model AudienceScope {
  id           String   @id @default(cuid())
  name         String
  description  String?
  audienceJson Json
  /// Sending identity for campaigns sent under this scope (Phase 4).
  fromEmail    String?
  fromName     String?
  createdById  String?
  grants       AudienceScopeGrant[]
  campaigns    EmailCampaign[]
}

model AudienceScopeGrant {
  id       String  @id @default(cuid())
  scopeId  String
  /// Exactly one of personId / roleId is set.
  personId String?
  roleId   String?

  @@index([scopeId])
  @@index([personId])
  @@index([roleId])
}
```

The scopes a person may send under are those granted to them directly plus those
granted to any role they hold. `EmailCampaign` gains a nullable `scopeId`;
`outreach.send_unrestricted` senders leave it null.

`outreach.send_unrestricted` is strictly stronger and does not require
`outreach.send`. A person holding both may choose a scope or send unscoped, so
the two are resolved as: a null `scopeId` is permitted only for
`outreach.send_unrestricted`, and a non-null `scopeId` is permitted only if that
scope is granted to the sender or the sender is unrestricted.

**Every INTERACTIVE send re-checks both**, because a campaign can be scheduled
under one permission set and dispatched after it changes. Cron dispatch is
deliberately weaker, and Phase 1 ships it that way: `executeRun` resolves
recipients through the same scope intersection, so a scheduled campaign still
cannot exceed its scope and a scope narrowed after scheduling narrows the
campaign, but it does not re-check that the creator still holds their permission
or their grant. The residual exposure is a recurring campaign that keeps mailing
*within its scope* after its author's access is revoked, which an admin can
cancel.

This is a product decision, not a technical limit. An earlier draft justified it
by pointing at `EmailCampaign.createdById` being SetNull on person delete, as
though a fail-closed re-check would cancel campaigns whose author was offboarded.
That reasoning is wrong: a null `createdById` is fully distinguishable from "the
creator still exists and no longer qualifies", so a re-check that skips the null
case was always available. The open question is what revocation *should* do to
already-scheduled campaigns, and that is deferred rather than blocked.

### Enforcement seam

The effective audience is `AND(scope.audienceJson, campaign.audienceJson)`,
applied **at resolve time in the service**, never in the UI and never by storing
a pre-merged tree. `resolveAudience` takes an optional scope audience and
intersects it at the root.

Storing `scopeId` rather than a merged tree means narrowing a scope retroactively
narrows every campaign already scheduled under it.

Three failure modes this must be designed against, each a send-all in disguise:

**The AND must be applied to the compiled `where`, not to the conditions array.**
A campaign whose root `match` is `ANY` would OR the scope straight back out if the
scope were appended as a sibling condition. It has to be
`{ AND: [scopeWhere, campaignWhere] }` with each side compiled independently.

**The manual list is a bypass unless it is also intersected.** Individually added
people and pasted email addresses must be intersected with the scope, or "add
anyone by email" defeats delegation entirely.

**No granted scope must resolve to nobody, not everybody.** This is the same
hazard `operators.ts` guards at the condition level, one level up: a person
holding `outreach.send` with zero granted scopes resolves to `MATCH_NOBODY`.
Absent scope must never mean absent constraint.

### Audience depth

**Date conditions.** A new `kind: "date"` with operators `before`, `after`,
`onOrBefore`, `onOrAfter`, `between`, `withinNextDays`, `withinLastDays`,
`isEmpty`, `isNotEmpty`.

Two properties make this a change to the engine rather than a batch of new fields:

- Relative operators must compile **against `now` at resolve time**, not be
  frozen to an absolute date at save time. That is the entire point for a
  recurring campaign: "certificates expiring in the next 30 days" has to mean
  something different on each run. This threads a `now` parameter through
  `compilePersonWhere` and every field's `compile` function, a signature change
  across `compile.ts` and `person-fields.ts`.
- A calendar date means a day *in the clinic's configured display zone*, so day
  boundaries convert to UTC instants through that setting. Treating a date as a
  naive UTC midnight puts "expires today" off by up to a day.

**Number and count conditions.** Operators `eq`, `notEq`, `lt`, `lte`, `gt`,
`gte`, `between`. Prisma cannot filter on relation counts inside `where`, so
count-shaped conditions ("attended fewer than 3 shifts", "2 or more strikes")
resolve through the **precompute-to-id-set** seam `resolve.ts` already uses for
`loadAppliedByCycle`, producing `{ id: { in: [...] } }`. Reuse that pattern
rather than introducing a second one.

**Field expansion.** Roughly 25 further fields across Schedule (upcoming shifts,
no-shows), Learning (a specific course, not only "all assigned"), Subcommittee,
any language via `PersonLanguage` (not only Spanish), membership kind, track,
recruitment outcome, info-session attendance, support ticket counts, and
passport. Grouped in the picker by domain.

**Manual list.** `includePersonIds`, `excludePersonIds`, and `pastedEmails` on
the campaign. Resolution order is `(matched ∪ include) ∩ scope − exclude`.
Exclusion always wins; inclusion never escapes the scope.

**Send-once.** A per-campaign `sendOncePerPerson` boolean, default false. When
set, dispatch excludes anyone already holding an `EmailLog` on any prior run of
the same campaign, so a recurring campaign catches only newly-matching people.
Left false, the current every-run behavior is preserved, which is correct for a
digest.

### Builder UI

A two-pane editor: the condition tree on the left, a **live recipient preview**
on the right showing the matched count and a scrollable list of who, with the
values that caused each match.

- **Searchable, grouped field picker.** Fifty fields is well past what a `<select>`
  can carry.
- **Per-node match counts** on every condition and every group. This is the
  property that makes a nested filter tree legible, and the main thing the current
  builder lacks. One batched, debounced server action compiles each subtree and
  counts.
- **Visual nesting** with indent rails and an ALL/ANY/NONE pill per group.
- **Tabbed editor** (Compose / Audience / Review), replacing the single
  474-line scrolling server component, with its eight inline server actions
  extracted to a co-located `actions.ts`.

### Sender identity (Phase 4)

`MailerooTransport` currently pins the From address and demotes any per-message
override to Reply-To, because Maileroo can only sign for domains verified in the
account. The pin becomes a **verified-domain allowlist**: a message whose From is
on an allowlisted domain sends as itself; anything else falls back to today's
pin-plus-Reply-To behavior. Each `AudienceScope` carries the sending identity
used by campaigns sent under it.

This design is correct regardless of which domains are verified: a newly
verified domain simply joins the allowlist.

**Prerequisite, not an assumption.** As of 2026-08-31, DNS still shows yale.edu
unverified for Maileroo: SPF is Valimail-only with no `_spf.maileroo.com`
include, and DMARC remains `p=quarantine` (`havenfreeclinic.org`, by contrast,
does include `_spf.maileroo.com`). No Maileroo DKIM selector was found at the
documented `maileroo._domainkey` name on either domain, so DKIM alignment could
not be ruled out from DNS alone. Confirm the domain list in the Maileroo
dashboard, or re-run the API probe described in the `maileroo-yale-domain-disabled`
note, before Phase 4 begins. If yale.edu is not verified, delegated senders use
issued `@havenfreeclinic.org` identities, which work today.

## Error handling

- A campaign whose scope was revoked or deleted between scheduling and dispatch
  resolves to `MATCH_NOBODY` and records the run as zero-recipient with a reason,
  rather than falling back to unscoped.
- A stored condition naming a field that no longer exists is skipped, matching
  the existing tolerance for stale enum members and department codes.
- A relative date condition with a non-numeric or negative day count compiles to
  `MATCH_NOBODY`, per the operator invariant.
- Count precomputes that return no rows yield an empty id set, which is
  `MATCH_NOBODY`, never a dropped filter.

## Testing

The engine work is pure and unit-testable, which is where the weight belongs:

- **Operators.** Each new date and number operator against fixed clocks,
  including the zone boundary cases and every negative/empty form compiling to
  `MATCH_NOBODY`.
- **Scope intersection.** Property-shaped cases proving a scope cannot be widened
  by any campaign audience, most importantly a root-`ANY` campaign, and a manual
  include list naming someone outside the scope.
- **Zero-scope guard.** `outreach.send` with no grants resolves to nobody.
- **Send-once.** A campaign run twice over an audience that still matches enqueues
  each person exactly once.
- **Permission migration.** Custom roles holding `admin.send_email_campaign` end
  up holding `outreach.send_unrestricted`, and wildcard holders are untouched.

Per project convention, DB-backed email tests run in CI; pure render and compile
tests run in the worktree.

## Phasing

Each phase ships on its own.

1. **Module and delegation.** New `outreach` module, route move, permission split,
   `AudienceScope` + grants, the enforcement seam, scope admin UI, and the backfill
   migration.
2. **Audience depth.** Date kind, number kind, `now` threading, ~25 new fields,
   manual list, send-once.
3. **Builder UI.** Two-pane builder, searchable picker, per-node counts, recipient
   preview, tabbed editor, action extraction.
4. **Sender identity.** Verified-domain allowlist, per-scope from-address, Maileroo
   as default transport with Graph as an admin option.

Phase 4 is independent of 1-3 and can move earlier if sender identity turns out
to be the urgent half.

## Open questions

- Whether yale.edu is verified in Maileroo today (see Phase 4 prerequisite above).
  Does not block phases 1-3.
