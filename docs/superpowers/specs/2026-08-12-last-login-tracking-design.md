# Last login tracking on the person profile

Date: 2026-08-12
Branch: its own, off `main`. Deliberately NOT part of the content blocker work
(PR #581), which is unrelated and already stacked on PR #579.

## Problem

Nothing records a successful sign-in for most users.

`src/platform/auth/auth.ts` audits exactly two login paths: `auth.member_login`
for a magic-link sign-in, and `auth.applicant_login` for a Yale account with no
matching Person. A matched Person signing in with Yale SSO, which is nearly
everyone, leaves no trace at all. There is no `lastLoginAt`, no user agent, and
no location anywhere in the schema.

That costs the admins three specific things:

- No way to tell a dormant account from an active one, which matters at
  offboarding and when auditing the roster.
- No way to confirm someone actually got in after an access problem was fixed,
  which today means asking them and waiting.
- No way to answer "what browser are they on" when triaging a support ticket,
  on an app where the GitBook embed and the Intercom Messenger each fail
  differently per browser.

## Decision

Record the most recent sign-in on the Person: when, what browser, and a coarse
location. Show it to admins only.

### Non-goals

- **No login history.** Last value only. A per-login event table would be more
  useful for forensics and would also accumulate a movement log of a student
  volunteer, which is not a thing this organization needs to hold.
- **No IP address.** Considered and rejected. City and country answer "was this
  from somewhere unexpected" without keeping the identifier that makes it
  precise.
- **No visibility for directors or the member.** Admin only, gated on the
  permission the page already requires.
- **No blocking behavior.** Nothing here may ever prevent a sign-in.

### The disclosure question, stated rather than buried

Admins-only means this is collection the volunteers are not told about. That is
a defensible choice for operational data and it is the organization's call, not
a technical one. If HAVEN has a privacy notice or volunteer agreement, this
belongs in it. Nothing in the code can settle that, so it is recorded here so
the decision is visible rather than implicit.

## Schema

Four nullable columns on `Person`:

```prisma
lastLoginAt        DateTime?
lastLoginUserAgent String?
lastLoginCity      String?
lastLoginCountry   String?
```

All nullable, all overwritten on each sign-in. Nullable is the honest shape:
every one of these is genuinely absent in local development, and a person who
has not signed in since the feature shipped has no value rather than a
misleading default.

Last-value-only also means the feature needs no retention policy, because it
cannot grow.

## Capture

One place: the `jwt` callback in `src/platform/auth/auth.ts`, inside the
existing `if (account)` block that already runs only on initial sign-in, and
only once a `personId` has resolved.

It sits alongside the department enrichment already in that block and follows
the same contract, which that code states explicitly: best-effort, and a hiccup
must never block sign-in. That is the load-bearing property here. A volunteer
locked out because a geo header was malformed would be a far worse bug than a
missing timestamp, so the whole capture is wrapped and its failure is swallowed
and logged, never propagated.

### Sources

| Column | Header |
| --- | --- |
| `lastLoginAt` | `new Date()` at capture time |
| `lastLoginUserAgent` | `user-agent`, stored raw |
| `lastLoginCity` | `x-vercel-ip-city` |
| `lastLoginCountry` | `x-vercel-ip-country` |

Read straight from request headers. No new dependency: `@vercel/functions` is
not currently installed and is not worth adding for two header reads.

### Two gotchas that must be handled

1. **Vercel URL-encodes the city.** `x-vercel-ip-city` arrives as `New%20Haven`,
   so it needs `decodeURIComponent`. Storing it raw would put percent-escapes in
   front of an admin.
2. **Every one of these headers is absent locally.** There is no Vercel edge in
   `next dev`, so all four must tolerate absence and write null rather than
   `"unknown"` or an empty string, both of which read as data that was captured
   and found to be empty.

## Display

Read-only block on `/admin/people/[id]`, which already calls
`requirePermission("admin.manage_people")`, so the gating is inherited rather
than reinvented. Nothing renders on the member's own page and nothing for
directors.

A person with no `lastLoginAt` shows a plain "No sign-in recorded" rather than
an empty row, because absence here has a real meaning (never signed in, or has
not signed in since this shipped) and a blank cell reads like a bug.

The stored user agent is rendered through a pure `describeUserAgent(ua: string)`
helper producing something like `Safari 18 on iPhone`, covering Chrome, Safari,
Firefox, Edge, iOS, Android, macOS, and Windows.

The raw string is what is stored, and the parse happens at display, on purpose:
user agent strings change constantly, and a bad parse is then a display bug that
can be fixed later against data already captured, rather than data lost at write
time. An unrecognized agent falls back to showing the raw string, which is more
useful to an admin triaging a ticket than the word "Unknown".

## Testing

- `describeUserAgent`: one case per supported browser and platform combination,
  plus an unrecognized string (falls back to raw) and an empty string.
- Capture: reads all four values correctly; decodes a percent-encoded city;
  writes null for each header when it is absent; writes nothing at all when no
  `personId` resolved.
- The contract that matters most: a capture that throws does not propagate. A
  test that forces the write to reject and asserts the sign-in path still
  completes.
- Display: renders the parsed agent, and renders "No sign-in recorded" when
  `lastLoginAt` is null.
