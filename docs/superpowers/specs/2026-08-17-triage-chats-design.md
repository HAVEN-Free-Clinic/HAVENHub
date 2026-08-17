# Weekly Teams Triage Chats

Date: 2026-08-17
Branch: its own, off `main`.

## Problem

Every clinic week, an Executive Director hand-builds two Microsoft Teams group
chats: one for the ancillary departments and one for the clinical departments.
Each is named for the clinic date (`05.30.26 Ancillary Triage Chat`), holds
roughly twenty people, and opens with a message that names the session
coordinators, the clinical advisors, and the person covering triage for each
department.

Building that by hand costs an ED real time and gets the roster wrong in the
two ways that matter:

- **Someone is missed.** The chat is how departments field triage calls for the
  upcoming clinic. A department whose triage director was left out finds out on
  clinic day.
- **Someone is stale.** The names are copied from last week, so a swapped shift
  or an offboarded volunteer carries forward. The bulleted roster in the
  opening message and the actual chat membership are maintained separately, so
  they routinely disagree with each other and with the schedule.

Every fact needed to build the chat correctly is already in the Hub. The
schedule knows who is on shift for the upcoming clinic date, which of them are
directors, and which of those carry the `triage` flag. Microsoft Graph is
already wired with the scopes to create a chat and post to it. Nothing connects
the two.

## Decision

A Schedule tool that an ED runs once a week. Pick a saved preset (Ancillary or
Clinical), review a chat name, member roster, and opening message that the Hub
filled in from this week's schedule, edit anything, and confirm. The Hub creates
the Teams group chat as the connected service account and posts the message.

One source of truth for the roster: the same resolver produces both the chat
membership and the bulleted roster block in the message, so the two cannot
disagree.

### Non-goals

- **No auto-creation cron.** A human confirms every chat before twenty-plus
  people are added to it. A schedule that changed after a cron ran, or a
  director the Hub cannot reach, would otherwise be baked in silently with
  nobody looking.
- **No per-ED Microsoft connections.** Chats are created by the single
  connected service account (`hfc.admin@yale.edu`). Teams will attribute the
  chat and the opening message to that account rather than to the ED who
  clicked Create. Accepted deliberately: the alternative is a per-person OAuth
  credential store, consent flow, and refresh path for three or four people.
- **No reuse of last week's chat.** Each clinic week gets a fresh chat, matching
  what ops does today.
- **No membership editing after creation.** Once the chat exists, it is managed
  in Teams. The Hub records who it added and stops.
- **No queueing.** This is a synchronous, human-triggered action, not a
  notification. See "Why not notify()" below.

## Placement and access

`/schedule/triage-chats`, a new tab in the Schedule module, gated on a new
`schedule.manage_triage_chats` permission. Added to the `schedule` manifest's
`permissions` array in `src/platform/modules/registry.ts` and to its `nav` array
with that permission, so it is hidden from everyone who does not hold it.

The permission is deliberately **not** added to any entry in `SYSTEM_ROLES`
(`src/platform/rbac/system-roles.ts`). Admins grant it per role or per person,
the same way `clinic.access` is handled. Three or four people need it, and
adding it to a shipped system role would require a production backfill
migration for no benefit.

The tool sits under Schedule rather than Clinic or Admin because its entire
input is schedule data. Putting it in Admin would have forced EDs to hold
`admin.access` just to run their weekly chat.

## Data model

Four new models, one of them a join table. The preset-to-department join
follows the existing `CourseDepartment` / `EhsTrainingDepartment` idiom rather
than a `String[]` of codes, so a department cannot be silently orphaned and the
FK restricts deletion the way every other department reference does.

### `TriageChatPreset`

The reusable configuration. Two rows in practice (Ancillary, Clinical), created
and edited by EDs.

- `name` (`"Ancillary"`), shown on the card.
- `nameTemplate` (`"{{clinicDate}} Ancillary Triage Chat"`), rendered into the
  Teams chat topic.
- `messageTemplate`, the opening message body.
- `isActive`, `order`, `createdAt`, `updatedAt`.
- `departments`: `TriageChatPresetDepartment[]`.

Soft-delete via `isActive` rather than a hard delete, so a `TriageChat` created
from a retired preset still resolves to a name.

### `TriageChatPresetDepartment`

`presetId` + `departmentId`, unique on the pair. FK to `Department` with the
same `Restrict` posture as the other department join tables.

### `TriageChat` and `TriageChatMember`

One `TriageChat` row per chat actually created:

- `presetId`, `termId`, `clinicDate` (anchored at 12:00 UTC like every other
  clinic date in the schema; compare by UTC day key, never by raw timestamp).
- `topic`, the rendered chat name.
- `graphChatId`, `webUrl`, from Graph's create response.
- `createdById` (the ED), `createdAt`.
- `messagePostedAt`, null until the opening message actually posts.
- `members`: `TriageChatMember[]`.

**Unique on `(presetId, clinicDate)`.** This constraint is the idempotency
guard, not a nicety: a double-click, a re-submitted form, or a retry after a
partial failure must never produce two chats for the same week. The server
action inserts the row and lets the unique violation reject the duplicate,
rather than checking-then-inserting, which races.

`TriageChatMember` is a snapshot, not a live join: `personId`, `personName`,
`departmentName`, `addedOk`, `error`. It records who was in the chat that week
independent of a schedule that changes afterward, and it is what the
confirmation screen reads back to name anyone Graph refused.

## Roster resolution

`src/modules/schedule/services/triage-chats.ts`, built around a pure function
so every rule below is a unit test with no database.

```
resolveTriageRoster({ assignments, selectedDepartmentIds, alwaysIncludeDepartmentIds })
  -> { members: RosterMember[], rosterBlock: string, unreachable: RosterMember[] }
```

The rules:

1. **Selected departments** contribute assignments where `role = DIRECTOR` and
   `triage = true`. The `triage` flag already exists on `ShiftAssignment`
   ("Triage on Shift", imported from Airtable) and is exactly the question the
   chat is asking.
2. **Always-include departments** (EXEC, PCAR, PATS) contribute every director
   on shift, not just triage-flagged ones. Those are small leadership and
   coordination groups where "who is on triage" is not the right question:
   Executive Directors are the session coordinators, PCAR are the clinical
   advisors, and Patient Services fields the calls.
3. **Active membership filter.** Only people with an `ACTIVE` `TermMembership`
   in the department they are assigned to. This is not optional. Offboarding
   flips `Person.status` and removes the membership but leaves future
   assignments in place until a director clears them, so without this filter an
   offboarded volunteer gets added to a twenty-person chat. `runShiftReminders`
   carries the same guard for the same reason.
4. **Dedupe by person, group by department.** One entry per person even when
   they hold shifts in several selected departments. Grouped and sorted by
   department name for the roster block.
5. **Classify reachability.** Each member carries the bind the Graph layer will
   use: `entraObjectId` when present, otherwise `netId@yale.edu`. A person with
   neither is `unreachable`: they appear in the roster block (they are on
   shift, and hiding that would be worse) but cannot be added to the chat, and
   the review screen says so.

The function returns the member list and the rendered roster block together.
That is the point: they are the same data, so the bulleted list in the message
cannot name someone who is not in the chat.

The caller loads the term, resolves the clinic date, and reads assignments:

- Active term via `getActiveTerm()` (`@/platform/terms/active-term`).
- Clinic date via `selectCurrentClinicDate()`
  (`@/platform/teams/channel-link`), the same selector the clinic channel link
  and the shift reminders use, so all three agree on which Saturday is "this
  week".
- A closed clinic date is surfaced as a warning on the review screen rather
  than a hard block. `resolveOpenClinicDate` already answers this;
  an ED creating a chat for a cancelled clinic is more likely a mistake than an
  intention, but it is theirs to make.

### Always-include configuration

`triageChats.alwaysIncludeDepartmentCodes`, a settings-registry entry of input
type `text` holding a comma-separated list of department codes, defaulting to
`"EXEC,PCAR,PATS"`. The registry has no multi-select input type, so a validated
text field is the honest shape. The zod schema rejects unknown codes at save
time rather than failing silently at chat-creation time.

Configurable rather than hardcoded because department structure changes between
years and an ED should not need a deploy to add one.

## The Graph layer

New `src/platform/teams/group-chat.ts`, following `channel-link.ts`: injectable
`fetch` and token so tests never touch the network, bounded per-request
timeouts, no internal retry, and errors that carry Graph's response body.

That last point is a lesson already paid for in `channel-link.ts`. A bare status
code makes the two failures an operator actually has to tell apart look
identical: a 403 for a missing scope and a 403 for an account that is not
permitted to chat with a recipient carry completely different fixes, and Graph
explains which in the body every time.

Three functions:

- `createGroupChat({ topic, memberBinds })` posts to `/v1.0/chats` with
  `chatType: "group"`, the topic, and one
  `#microsoft.graph.aadUserConversationMember` per member with
  `roles: ["owner"]`. Returns the chat id and `webUrl`.
- `addChatMember(chatId, bind)` posts to `/v1.0/chats/{id}/members`.
- `postChatMessage(chatId, bodyHtml)` posts to `/v1.0/chats/{id}/messages`,
  the same call `GraphTeamsTransport.send` already makes for 1:1 DMs.

### Binding members, and the one thing we do not know

Graph's `user@odata.bind` accepts an Entra object id or a **user principal
name**. It does not accept an arbitrary mail attribute. UPN and email are the
same string in many tenants, but Yale is demonstrably not uniformly so: the
service account this feature runs as is `hfc.admin@yale.edu` by mail and
`hfc.admin@yu.yale.edu` by UPN.

Rather than bet a twenty-person chat on that assumption holding for every
director:

1. **Create the chat with everyone who has an `entraObjectId`.** Those binds
   are known-valid. In practice this is nearly everyone, because a person gets
   an `entraObjectId` the first time they sign into the Hub and being on the
   schedule generally means having signed in.
2. **Add anyone else individually**, binding `netId@yale.edu`, via
   `addChatMember`. One call per person, so a bad bind fails that person rather
   than the whole create.
3. **Report per-person failures.** Each one is written to `TriageChatMember`
   with `addedOk = false` and Graph's error, and the confirmation screen lists
   them with a copyable set of names to add by hand in Teams.

If UPN-equals-email does hold at Yale, nothing about this changes; the failure
list is simply always empty. If it does not, an ED gets a named list instead of
a create call that fails with everyone's chat on the line.

**Scope change:** step 2 requires `ChatMember.ReadWrite` added to the `SCOPES`
string in `src/platform/email/oauth.ts`. `Chat.Create` and `ChatMessage.Send`
are already granted. Growing the scope string requires one admin reconnect;
`needsReconnect()` in that same module already exists for exactly this and must
be extended to check for the new scope so the admin UI prompts.

## The opening message

Rendered with `renderTemplate` from `src/platform/email/render/render.ts`, the
engine the email templates already use.

That engine has **no `{{#each}}`**. Lists are precomputed by the caller, which
is why `resolveTriageRoster` returns `rosterBlock` as a finished string rather
than an array. Variables available to a preset's `messageTemplate`:

- `{{clinicDate}}`, formatted long ("Saturday, May 30, 2026").
- `{{clinicDateShort}}`, `MM.DD.YY`, for the chat name template.
- `{{sessionCoordinators}}`, EXEC directors on shift, comma-joined.
- `{{clinicalAdvisors}}`, PCAR directors on shift, comma-joined.
- `{{rosterBlock}}`, the per-department bulleted list.
- `{{teamsChannelUrl}}`, the week's clinic Teams channel, resolved by
  `getCurrentClinicChannelLink()` and empty when it cannot be resolved.

Deliberately no clinic-prep-document variable. The Hub does not hold that
document, so there is nothing to substitute; an ED pastes the link into the
message body like they do today.

The rendered body is fully editable on the review screen before anything is
sent. The template is a starting point, not a constraint.

## Flow

**Index** (`/schedule/triage-chats`). One card per active preset showing the
upcoming clinic date, the department count, and either a Create button or, when
a `TriageChat` already exists for `(preset, clinicDate)`, a deep link into the
existing chat. Presets are managed from here (create, edit, deactivate).

**Review** (`/schedule/triage-chats/[presetId]/new`). Server-rendered from the
resolver:

- Chat name, editable, prefilled from `nameTemplate`.
- Member list grouped by department, each person with a checkbox so the ED can
  drop someone, and each unreachable person clearly marked with why.
- Opening message, editable, prefilled from `messageTemplate`.
- Warnings: closed clinic date, empty roster, a selected department with no
  triage-flagged director on shift.

**Confirm.** A server action that:

1. Re-resolves the roster server-side. The form's checkbox state selects from
   that set; it never supplies member identities. A form field must not be able
   to name an arbitrary person into a chat.
2. Inserts the `TriageChat` row, taking the `(presetId, clinicDate)` unique
   constraint as the claim.
3. Creates the chat via Graph, then adds the fallback-bound members
   individually, then posts the message.
4. Writes `TriageChatMember` rows and `messagePostedAt`.
5. Records an audit entry via `recordAudit`
   (`triage_chat.create`, entityType `TriageChat`), because adding twenty
   people to a chat deserves a trail.

**Confirmation.** Chat name, deep link into Teams, who was added, and who was
not, with the reason.

## Failure handling

- **Create fails.** The `TriageChat` row is rolled back, an error carrying
  Graph's message is shown, and retry is safe because nothing was recorded.
- **Chat created, message post fails.** The row is **kept**, with
  `graphChatId` and `webUrl` set and `messagePostedAt` null. This is the
  important case: keeping the row is what makes a retry post the message rather
  than create a second chat. The page shows "chat created, message not posted"
  with a Retry that posts to the recorded `graphChatId`.
- **Individual member adds fail.** Recorded per member and named on the
  confirmation. Never silently dropped.
- **Mailer not connected.** The page refuses up front with a link to
  Admin > Email, rather than failing at the moment of creation.

### Why not notify()

The Teams queue (`notify()` plus `drainTeamsQueue`) is built for person-
addressed notifications: retry with a fixed interval, then fall back to email
after an attempt budget. Both halves are wrong here. Retrying a create that
partly succeeded produces duplicate chats, and there is no sensible email
fallback for "create a group chat". A human is watching this action and can be
told what happened, which is strictly better than a queue guessing.

## Testing

- **Roster resolution** (unit, pure): triage-flag filtering, always-include
  departments contributing all directors, the ACTIVE-membership filter dropping
  an offboarded person with a stale assignment, dedupe across departments,
  grouping and ordering of the roster block, and that `members` and
  `rosterBlock` name the same people.
- **Name and message rendering** (unit): every variable substitutes; an unknown
  variable renders empty rather than throwing.
- **Graph client** (unit, injected `fetch`): create/add/post success shapes,
  error-body propagation, timeout behavior, and that one failing
  `addChatMember` does not abort the others.
- **Server action** (DB): double submit yields exactly one chat; a failed
  message post still records the chat with `messagePostedAt` null; retry posts
  rather than re-creates; a checkbox naming a person outside the resolved
  roster is ignored.
- **Permission gating** (DB/unit): the page and action reject without
  `schedule.manage_triage_chats`.
- **e2e**: nav gating only, tab present with the permission and absent without.
  Graph cannot be driven from a real browser run, so the creation path is
  covered by the layers above.

## Open questions

None blocking. One fact to confirm against the live tenant during
implementation: whether `netId@yale.edu` is a valid UPN bind for Yale student
accounts. The design does not depend on the answer, and the fallback path
reports the truth either way.
