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
same `Cascade` posture as the other department join tables (`CourseDepartment`
and `EhsTrainingDepartment` both cascade). An earlier draft of this spec said
`Restrict`, which is not what those siblings do; the code follows the real
idiom.

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
  -> { members: RosterMember[], rosterBlock: string }
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
5. **Carry the lookup candidates.** Each member carries their
   `entraObjectId` (may be null), `netId`, and `contactEmail`, which is
   everything the Graph layer needs to resolve them. The resolver itself stays
   pure and does no network work: reachability is decided at creation time, by
   the layer that can actually ask the directory.

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
text field is the honest shape.

The zod schema validates **format only** (comma-separated, non-empty,
uppercase-alphanumeric codes). It cannot check that the codes name real
departments: `SettingValidateCtx` carries `config` and `getSetting` and no
database handle, and `registry.ts` is imported widely enough that reaching for
prisma there is not worth an import cycle. So the loader resolves codes to
departments and reports any that did not match as a warning on the review
screen, where the ED is already reading the roster. A typo shows up as a named
warning next to the members it failed to add rather than as a silently short
roster.

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

Four functions:

- `lookupUserId(bind)` gets
  `/v1.0/users?$filter=userPrincipalName eq '{bind}' or mail eq '{bind}'` with
  `$select=id,displayName,userPrincipalName`. Returns the Entra object id, or
  null when the directory has no match.
- `createGroupChat({ topic, memberIds })` posts to `/v1.0/chats` with
  `chatType: "group"`, the topic, and one
  `#microsoft.graph.aadUserConversationMember` per member with
  `roles: ["owner"]`. Returns the chat id and `webUrl`.
- `addChatMember(chatId, userId)` posts to `/v1.0/chats/{id}/members`.
- `postChatMessage(chatId, bodyHtml)` posts to `/v1.0/chats/{id}/messages`,
  the same call `GraphTeamsTransport.send` already makes for 1:1 DMs.

### Binding members

Graph's `user@odata.bind` accepts an Entra object id or a user principal name,
not an arbitrary mail attribute. UPN and email are the same string in many
tenants but demonstrably not uniformly at Yale: the service account this
feature runs as is `hfc.admin@yale.edu` by mail and `hfc.admin@yu.yale.edu` by
UPN. So the Hub never guesses at the format. It asks the directory.

Resolution order per roster member:

1. **`Person.entraObjectId`** when set. This is the real object id, captured
   from the token claim at sign-in, and needs no lookup.
2. **Directory lookup** otherwise: `lookupUserId` against `netId@yale.edu`,
   then against `contactEmail` if that misses. The filter matches on
   `userPrincipalName` OR `mail`, so it does not matter which one Yale uses.
   Lookups run with bounded parallelism (five at a time) since a roster is
   about twenty people once a week.
3. **Unresolved.** No stored id and no directory match. The person appears in
   the roster block, because they are genuinely on shift, but cannot be added.
   They are named on the review screen and the confirmation.

The resolved ids are **not written back to `Person.entraObjectId`**. That
column is the SSO identity link `match-person.ts` uses to bind a login to a
person, and it is `@unique`; a lookup that matched the wrong Ellen Smith would
turn a display bug into an account takeover. The lookup runs fresh each time
instead, which costs twenty cheap directory reads a week.

### Creating and adding

Because a create call is atomic, one bad member id fails the chat for everyone.
So the two classes of id are used differently:

1. **Create the chat with the service account plus every member whose id came
   from `Person.entraObjectId`.** Those ids came from a real sign-in, so they
   cannot be wrong. In practice this is nearly everyone. If that set is empty,
   promote one directory-resolved member into the create so the chat is valid.
2. **Add the directory-resolved members individually** via `addChatMember`. One
   call per person, so a bad id fails that person rather than the whole chat.
3. **Report per-person failures.** Each is written to `TriageChatMember` with
   `addedOk = false` and Graph's error, and the confirmation lists them with a
   copyable set of names to add by hand in Teams.

**Scopes.** `Chat.ReadWrite` (for `addChatMember`) and `User.ReadBasic.All`
(for `lookupUserId`) are added to the `SCOPES` string in
`src/platform/email/oauth.ts`. Both have already been added to the app
registration, and both are user-consentable in this tenant, so the cost is one
reconnect by the service account rather than an ITS request.
`ChatMember.ReadWrite` is the least-privileged permission Microsoft documents
for adding a chat member and would have been the obvious choice, but it
requires tenant admin consent; `Chat.ReadWrite` is the documented
higher-privileged alternative for the same call and does not.

`teamsScopesGranted(scope)` in the oauth module already exists for exactly this
(it gates the reconnect prompt on `/admin/email`) and must be extended to
require the two new scopes, so an admin is told to reconnect rather than
finding out from a failed lookup.

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
resolver, with member ids resolved (including the directory lookups) so the ED
sees reachability **before** committing rather than after:

- Chat name, editable, prefilled from `nameTemplate`.
- Member list grouped by department, each person with a checkbox so the ED can
  drop someone, and anyone the directory could not resolve clearly marked as
  "cannot be added automatically".
- Opening message, editable, prefilled from `messageTemplate`.
- Warnings: closed clinic date, empty roster, a selected department with no
  triage-flagged director on shift, an always-include code in the setting that
  matches no department.

**Confirm.** A server action that:

1. Re-resolves the roster server-side, including the directory lookups. The
   form's checkbox state selects from that set; it never supplies member
   identities or Entra ids. A form field must not be able to name an arbitrary
   person into a chat.
2. Inserts the `TriageChat` row, taking the `(presetId, clinicDate)` unique
   constraint as the claim.
3. Creates the chat via Graph with the stored-id members, then adds the
   directory-resolved members individually, then posts the message.
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
- **Graph client** (unit, injected `fetch`): lookup/create/add/post success
  shapes, error-body propagation, timeout behavior, a lookup returning no match
  yielding null rather than throwing, and that one failing `addChatMember` does
  not abort the others.
- **Member id resolution** (unit, injected lookup): a stored `entraObjectId`
  short-circuits the directory call entirely; a miss on `netId@yale.edu` falls
  through to `contactEmail`; a person matched by neither is reported unresolved;
  no resolved id is ever written back to `Person`.
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

None. The one that was open, whether `netId@yale.edu` is a valid UPN bind for
Yale accounts, is answered by not needing to know: `lookupUserId` filters on
`userPrincipalName` OR `mail` and uses whichever the directory returns.
