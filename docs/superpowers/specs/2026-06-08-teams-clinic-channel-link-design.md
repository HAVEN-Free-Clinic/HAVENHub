# Teams Clinic Channel Link — Design

**Date:** 2026-06-08
**Branch:** `worktree-teams-clinic-channel-link`
**Status:** Draft for review

## Summary

Display a link to the current clinic week's Microsoft Teams channel on the HAVEN
Hub home dashboard. The link is resolved automatically each week from Microsoft
Graph, reusing the existing delegated OAuth token used by the HAVEN Hub Mailer —
no manual copy/paste of channel URLs.

The clinic Team contains one channel per clinic week, each named by its clinic
date, e.g. `06-13-26 Clinic`. We compute the current clinic date from the active
term's schedule, list the Team's channels via Graph, find the channel whose name
matches that date, and surface its `webUrl` (Graph returns the exact
`https://teams.microsoft.com/l/channel/...` deeplink — we do not construct URLs by
hand).

## Goals

- Show a "This week's Teams channel" link on the home dashboard to every
  signed-in user.
- Resolve the correct channel automatically each week, with no manual updates.
- Reuse the existing Mailer OAuth infrastructure (delegated token for
  `hfc.it@yale.edu`); add no new token-acquisition code path.

## Non-Goals

- Posting to Teams, reading messages, or any write operations.
- Creating channels (channels are created outside HAVEN Hub).
- Per-department or per-shift channel links — one link for the clinic week.
- Surfacing links for past clinic weeks or an archive view.

## Background: existing Graph/OAuth integration (reused)

From `src/platform/email/oauth.ts`:

- Delegated OAuth, singleton `MailCredential` row (`id = "mailer"`) holding the
  rotating refresh token for `hfc.it@yale.edu`.
- `getAccessToken(fetchImpl?)` returns a valid access token, using a module-level
  in-memory cache (60s safety window) and redeeming the refresh token on a miss.
- The `SCOPES` constant (line 26-27) is used by **both** the authorize URL
  (`buildAuthorizeUrl`) and the refresh redemption (`getAccessToken`). Adding a
  scope there means the next admin re-consent mints a refresh token carrying the
  new scope, and every subsequent `getAccessToken()` redeems with it.
- Env: `GRAPH_OAUTH_TENANT_ID`, `GRAPH_OAUTH_CLIENT_ID`,
  `GRAPH_OAUTH_CLIENT_SECRET`, `GRAPH_OAUTH_REDIRECT_URI`, `EMAIL_SENDER`
  (validated in `src/platform/config.ts`).

## Design decisions (from brainstorming)

1. **Teams structure:** one fixed Team, one channel per clinic week, named
   `MM-DD-YY Clinic`.
2. **Source of truth for "current week":** the codebase clinic schedule (the
   active `Term.clinicDates` array — see Open Question 1).
3. **Auth:** reuse the delegated Mailer token; add `Channel.ReadBasic.All` scope.
4. **Display:** home dashboard (`src/app/page.tsx`), all signed-in users.
5. **Rollover:** show a clinic date's channel through that clinic day; at midnight
   into Sunday (America/New_York) roll to the next clinic date.

## Architecture

### Auth / scope change

- Append `https://graph.microsoft.com/Channel.ReadBasic.All` to the `SCOPES`
  constant in `src/platform/email/oauth.ts`. No other token code changes; the
  single cached token serves both Mail.Send and channel reads.
- **Operational prerequisites (documented, not enforced in code):**
  - An admin re-connects the mailbox at `/admin/email` to grant the added scope.
    `Channel.ReadBasic.All` requires **admin consent**.
  - `hfc.it@yale.edu` must be a **member of the clinic Team** — delegated channel
    reads only see teams the signed-in user belongs to.
  - If neither holds, channel resolution fails gracefully (card hidden); the
    Mailer is unaffected.

### New module: `src/platform/teams/channel-link.ts`

Kept separate from `email/` (distinct concern) but imports `getAccessToken` from
`email/oauth.ts`.

```ts
export interface ClinicChannelLink {
  webUrl: string;        // Graph-provided deeplink
  displayName: string;   // e.g. "06-13-26 Clinic"
  clinicDate: Date;      // the matched clinic date
}

export async function getCurrentClinicChannelLink(
  fetchImpl?: typeof fetch
): Promise<ClinicChannelLink | null>;
```

Behavior:

1. **Compute current clinic date.** Load the active `Term`
   (`status: "ACTIVE"`, latest `startDate`). From `term.clinicDates`, pick the
   earliest date whose **America/New_York calendar date ≥ today's New_York
   calendar date**. This yields the rollover rule: a Saturday clinic shows
   through Saturday; once it is Sunday in New_York the Saturday is "past" and the
   next clinic date is selected. Return `null` if no active term or no upcoming
   clinic date.
2. **Format the date** as `MM-DD-YY` (zero-padded month/day, 2-digit year), in
   America/New_York, matching the channel naming convention.
3. **Cache check.** Module-level in-memory cache keyed by the formatted date
   string, TTL ~30 min. On hit, return cached value (including a cached `null`
   miss, to avoid hammering Graph when the channel does not exist yet).
4. **Fetch channels.** `GET https://graph.microsoft.com/v1.0/teams/{TEAMS_CLINIC_GROUP_ID}/channels`
   with `Authorization: Bearer <getAccessToken()>`. Each channel object includes
   `id`, `displayName`, and `webUrl`.
5. **Match.** Find the channel whose `displayName` starts with the formatted
   date string (trim + case-insensitive, tolerant of trailing " Clinic" wording).
   Return `{ webUrl, displayName, clinicDate }`, or `null` if no match.
6. **Failure handling.** Any thrown error (token unavailable / `MailNotConnectedError`,
   non-2xx Graph response, network error) is caught, logged, and returns `null`.
   This function never throws to the page. A `null` result hides the UI card.

### Config

- New env var `TEAMS_CLINIC_GROUP_ID` — the clinic Team's `groupId`
  (e.g. `4796e633-27e4-4053-8631-d3b4fe64ebe6`).
- Add to the Zod schema in `src/platform/config.ts` as **optional** (the feature
  degrades to "no card" when unset, so it must not break boot for environments
  that do not use it).
- Add to `.env.example` with an explanatory comment.
- `tenantId` already exists as `GRAPH_OAUTH_TENANT_ID` and is not needed for the
  Graph call (the `webUrl` from Graph already embeds tenant/group/channel ids).

### UI: home dashboard

- In `src/app/page.tsx` (`HubPage`, a server component), call
  `getCurrentClinicChannelLink()` alongside the existing `activeTerm` fetch.
- When non-null, render a compact card/link above the "Modules" section:
  "This week's clinic Teams channel →" linking to `webUrl`
  (`target="_blank" rel="noopener noreferrer"`), labeled with the channel's
  date / display name.
- When null, render nothing (no error, no empty state).

## Data flow

```
HubPage (server) ──> getCurrentClinicChannelLink()
                        ├─ prisma.term.findFirst({ ACTIVE })  → clinicDates
                        ├─ compute current clinic date (NY tz) → "MM-DD-YY"
                        ├─ in-memory cache[dateStr]?  ── hit ─> return
                        ├─ getAccessToken()  (reuses Mailer refresh token)
                        ├─ GET /teams/{groupId}/channels
                        ├─ match channel by displayName prefix
                        └─ cache + return { webUrl, displayName, clinicDate } | null
                     └─> render card when non-null
```

## Error handling

| Condition | Behavior |
|-----------|----------|
| `TEAMS_CLINIC_GROUP_ID` unset | Return `null` (card hidden). |
| Mail not connected / no scope granted | `getAccessToken` throws → caught → `null`. |
| `hfc.it@yale.edu` not a Team member | Graph 403/empty → no match → `null`. |
| No active term / no upcoming clinic date | Return `null` before any Graph call. |
| Channel for the week not created yet | No match → `null` (cached briefly). |
| Graph network error / non-2xx | Caught → logged → `null`. |

The Mailer is never affected by channel-read failures, and vice versa.

## Testing

Unit tests (Vitest, injected `fetchImpl`, mirroring existing oauth/transport
tests):

- **Date selection / rollover:** given a fixed "today" and a `clinicDates` array,
  the correct date is chosen — Sun–Fri picks the upcoming Saturday; Saturday picks
  that Saturday; Sunday rolls to the next. Cross-check the New_York timezone
  boundary explicitly (a UTC instant that is Sat 23:00 ET vs Sun 01:00 ET).
- **Date formatting:** `MM-DD-YY` zero-padding and 2-digit year.
- **Channel matching:** matches `"06-13-26 Clinic"`; ignores other channels;
  returns `webUrl` from the matched object; returns `null` on no match.
- **Caching:** second call within TTL does not re-fetch; cached `null` honored.
- **Failure paths:** token error, non-2xx, network throw → `null`, never throws.
- A reset hook for the module cache (test-only), mirroring `__resetTokenCache`.

No new e2e is required; manual verification is gated on the admin re-consent +
Team membership prerequisites being satisfied in the live tenant.

## Files

- **Modify** `src/platform/email/oauth.ts` — add scope to `SCOPES`.
- **Create** `src/platform/teams/channel-link.ts` — resolver + cache.
- **Create** `src/platform/teams/channel-link.test.ts` — unit tests.
- **Modify** `src/platform/config.ts` — add optional `TEAMS_CLINIC_GROUP_ID`.
- **Modify** `.env.example` — document `TEAMS_CLINIC_GROUP_ID`.
- **Modify** `src/app/page.tsx` — render the channel-link card.
- **Modify** admin docs / `/admin/email` copy (optional) — note the added scope
  requires re-consent. (Decide during planning; may be out of scope.)

## Open questions (confirm during spec review)

1. **Clinic date source:** spec assumes the active `Term.clinicDates` array holds
   the Saturday clinic dates that map to channel names. If the canonical dates
   live in `RhdClinic.clinicDate` rows instead, swap the query — same matching
   logic. (Example `06-13-26` is a Saturday, consistent with the RHD cadence.)
2. **Channel name exactness:** assumed format is `MM-DD-YY` prefix (optionally
   followed by " Clinic"). Confirm zero-padding and 2-digit year are always used
   in channel names; if naming varies, broaden the parser.
