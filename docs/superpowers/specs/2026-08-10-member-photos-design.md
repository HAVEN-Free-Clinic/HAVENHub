# Member photos: Yalies auto-sourcing with self-upload override (2026-08-10)

## Problem

Every surface in the Hub that shows a person shows a circle with their initials. The account menu,
the admin people list, the passport badge, and the public credential page all fall back to two
letters because `Person` has no image column.

For most of these that is a cosmetic gap. For the passport badge it is a functional one: the badge
is an identification credential, and an identification credential without a face does less of the
job it exists to do.

Yale College students already have a photograph that the Hub could reach. The Yalies API exposes it,
keyed by netId, which the Hub already stores as a unique column on `Person`. This spec sources that
photo automatically where it exists, and lets any member upload their own in every other case.

## What the external data actually supports

Verified against the Yalies API source on 2026-08-10. These limits dictate the shape of the feature.

### Photos exist for Yale College only

`app/scraper/sources/face_book.py` populates `person['image']` by scraping
`students.yale.edu/facebook`, and hardcodes `school: 'Yale College'` on that path. People sourced
from the Yale Directory instead have `image: null`.

`src/platform/affiliation.ts` lists thirteen affiliations. One is `yale_college`. The rest (YSM MD
and PA, YSN, YSPH, GSAS, Divinity, Jackson, Law, SOM, staff, other, non-Yale) will never return a
photo, no matter how many times we ask.

Consequence: auto-sourcing covers the undergraduate slice of the roster and nothing else. Self-upload
is not a fallback for edge cases, it is the primary path for most of HAVEN. The design treats it that
way.

### `image` is a URL, not bytes

`app/models.py` declares `image = db.Column(db.String)`, and `sources/s3.py` builds it as
`https://yalestudentphotos.s3.amazonaws.com/<filename>`. The object is publicly readable with no
auth. We fetch it once and re-host, rather than hotlinking a bucket we do not control.

### netId is filterable, HTTPS is mandatory

`netid` appears in `__filterable_identifiable__`, so `POST /v2/people` with
`{"filters": {"netid": [...]}}` is a supported lookup. The API docs state that a plain-HTTP request
causes immediate key revocation.

### The source is a student project with no SLA

Yalies is maintained by the Yale Computer Society, scrapes the Face Book using an administrator's
session cookie, and publishes no rate limits, terms of use, or uptime commitment. Every design
decision below assumes it can be slow, wrong, or gone, and that none of those outcomes may degrade
the Hub.

## Decisions

Settled during brainstorming on 2026-08-10.

| Question | Decision |
|---|---|
| Surfaces | Account menu, admin people views, passport badge, public credential page |
| Badge caveat | Of the passport surfaces, the public credential page ships here; the wallet badge thumbnail is deferred (see Scope) and the certificate PDF was not discussed and is out |
| Consent | Auto-apply on fetch, member may opt out at any time |
| Fetch timing | Lazily, on first view |
| Refresh | Never re-pull once a photo exists; retry with backoff while none does |
| Upload UX | Plain file input, server normalizes |
| Admin controls | Remove a photo, upload on a member's behalf |
| Removal semantics | Sticky, and a later upload clears the suppression |

Two of these carry consequences worth stating plainly.

**Auto-apply means members are published before being asked.** A Yalies photo appears on a member's
public credential page as soon as it is fetched, without their having confirmed it. This was chosen
deliberately over opt-in. The design compensates by making removal genuinely discoverable on
`/my-info` rather than buried, and by keeping the public page's photo live rather than frozen, so
removal takes effect immediately.

**Lazy fetching forgoes batching.** The Yalies API accepts an array of netIds in one call, which a
scheduled sweep would exploit. Fetching on view means one person per request. At HAVEN's roster size
this is immaterial, and the backoff below keeps repeat traffic near zero, but the tradeoff is real
and is recorded here so it is not rediscovered as a defect.

## Data model

Six additive columns on `Person`. No new table.

```prisma
photoKey        String?    // R2 object key; null = no photo
photoSource     String?    // "yalies" | "upload"
photoVersion    Int      @default(0)
photoUpdatedAt  DateTime?
photoSuppressed Boolean  @default(false)
photoSyncedAt   DateTime?  // last Yalies attempt, success or miss
photoSyncMisses Int      @default(0)
```

`photoKey` is the fixed key `people/<personId>`, so a new photo overwrites the previous object rather
than accumulating orphans. It is stored rather than derived because `null` is the signal for "no
photo," which a derived key could not express.

`photoVersion` is monotonic across set and remove cycles and is never reset.
`src/platform/branding/assets.ts` documents why: resetting the counter let a later upload reuse a
version number, so the cache-busting query parameter repeated and browsers kept serving the stale
image.

## State machine

`service.ts` is the sole writer of these six columns.

### The pull predicate

`shouldAttemptYaliesPull(person)` is true only when all five hold:

1. `photoKey` is null
2. `photoSuppressed` is false
3. `netId` is present
4. `yaleAffiliation` is not `non_yale`. A null affiliation passes: unknown is worth one attempt.
5. `photoSyncedAt` is null, or the backoff for `photoSyncMisses` has elapsed

Backoff runs 1 day, 7 days, 30 days, then every 30 days indefinitely.

Condition 5 is load-bearing. Without it, every page view for a member with no photo, which is most of
the roster, would call Yalies. The backoff turns an unbounded per-view cost into roughly one call per
person per month.

### Transitions

| Action | Effect |
|---|---|
| Pull succeeds | `photoKey` set, `photoSource = "yalies"`, version + 1, `photoSyncMisses = 0` |
| Pull misses or times out | `photoSyncedAt = now`, `photoSyncMisses + 1`, nothing else |
| Upload (member or admin) | `photoKey` set, `photoSource = "upload"`, version + 1, `photoSuppressed = false` |
| Remove, `photoSource = "yalies"` | photo cleared, version + 1, `photoSuppressed = true` |
| Remove, `photoSource = "upload"` | photo cleared, version + 1, suppression untouched |

The asymmetry in the last two rows is the definition of suppression: it means specifically "do not
use my Yale photo." Deleting a self-uploaded photo says nothing about the Yale one, so backfill may
refill it.

## Architecture

### Module placement

`src/platform/photos/`, not a module under `src/modules/`. `/my-info`, admin, passport, and the
account menu all consume it, and eslint forbids modules from importing each other. This is the same
reasoning `src/platform/affiliation.ts` records for its own placement.

| File | Responsibility |
|---|---|
| `yalies.ts` | netId to image bytes. 2s timeout via `AbortSignal`, no retries, no DB access. |
| `normalize.ts` | sharp: center-crop square, resize to 512, strip EXIF, encode WebP. |
| `service.ts` | The state machine. Sole writer of the six columns. |
| `initials.ts` | Deterministic initials SVG, reusing the existing `toInitials`. |
| `index.ts` | Public surface: `resolvePhoto`, `setPhotoFromUpload`, `removePhoto`, `photoUrl`. |

Each is testable alone: `yalies.ts` against a stubbed fetch, `normalize.ts` against fixture bytes,
`service.ts` against the test database with `yalies.ts` stubbed.

### Two routes, deliberately asymmetric

**`GET /api/people/[personId]/photo?v=<n>`** serves in-app surfaces. A session is required, and the
caller must either be that person or hold `admin.manage_people`. This is the only route that triggers
a lazy pull.

**`GET /credential/[token]/photo?v=<n>`** serves the public credential page. It resolves `publicToken`
to a published, non-revoked `ServiceCredential`, serves stored bytes or 404, and never triggers a
pull. Keying on the existing unguessable token means the public surface never exposes a `personId`
and inherits publish, unpublish, and revoke gating unchanged.

The asymmetry is the point. An unauthenticated route that can cause outbound third-party fetches is
an abuse vector.

### Caching

A real photo returns `max-age=31536000, immutable`, which is safe because both URLs carry
`?v=<photoVersion>`. The initials fallback returns `no-store`, otherwise a member would stay pinned
to initials after their photo lands.

### The photo is live, not frozen

`ServiceCredential.record` is frozen at issue and never recomputed on read, because it is a
past-tense claim about service. The photo is deliberately excluded from that treatment and is
resolved from `Person` at render time.

A frozen photo would make removal cosmetic: a member could delete their photo and it would remain on
their public page. Given that photos are auto-applied without prior consent, opt-out has to actually
work.

### Surfaces

One shared `<PersonPhoto person size />` in `src/platform/ui/`. Because the route falls back to
initials server-side, the component has no branching and no client-side fallback logic. It replaces
the initials div at `src/platform/ui/account-menu.tsx:81` and drops into the admin people list and
detail, `/my-info`, and the public credential page.

Write controls are a preview, a file input, and a remove button, appearing on `/my-info` for the
member and on the admin person detail behind `admin.manage_people`. They follow the shape of
`saveBrandingAsset` and `BrandingAssetError`. Accepted types are PNG, JPEG, and WebP, bounded by the
existing `uploads.maxMb` setting.

## Error handling

Every Yalies failure mode collapses to a miss: timeout, 401, 500, unreachable, person found with
`image: null`, or their S3 object 404. Each stamps `photoSyncedAt`, increments `photoSyncMisses`, and
serves initials. The route never throws at the caller, never surfaces a Yalies error to a member, and
never logs the API key.

When `YALIES_API_KEY` is unset the feature is inert: the predicate returns false, nothing
auto-sources, and uploads still work. This mirrors how `isWalletEnabled()` gates the wallet section,
so local dev and CI need no new secret.

Write ordering follows `saveBrandingAsset`: bytes to R2 first, then the `Person` row, and delete the
object if the row update fails. `src/platform/airtable/import/certificates.ts` documents at length
why the reverse order is wrong.

On a database read failure the route serves initials rather than erroring, consistent with the
project's read-degradation posture.

## Testing

- **The pull predicate**, exhaustively. Five conditions, table-driven.
- **The five transitions**, especially the suppression asymmetry.
- **The backoff schedule**, table-driven.
- **`normalize.ts`** against fixtures: portrait, landscape, EXIF-rotated, oversized, corrupt.
- **In-app route authz**: self, another member (denied), admin, unauthenticated.
- **Public route**: published, unpublished, revoked, no photo, plus an explicit assertion that it
  never calls Yalies.

Two project hazards to respect during implementation. The `/my-info` e2e spec may carry selectors
that a new photo card disturbs. The migration must land with its deploy rather than after it, because
preview deploys share the production database and a branch running new code against an unmigrated
schema crashes with P2021.

Verification before push: `npx eslint src e2e` (the full walk), typecheck, and the test suite read by
counts rather than by exit code.

## Scope

**In:** the six columns and their migration, `src/platform/photos/`, the two routes, the shared
component, write controls on `/my-info` and admin person detail, and the public credential page.

**Out:**

- **Wallet badge thumbnail.** `wallet-pass.ts` currently wires logo, icon, and strip only.
  `wallet-branding.ts` documents a 1MB vendor ceiling that a 512px WebP clears comfortably, but
  whether the vendor accepts a per-member thumbnail on our pass style is unverified. Deferred pending
  vendor documentation rather than specified on an assumption.
- **Batch sync**, a consequence of the lazy fetch decision.
- **Admin force-refresh** and a **block-photos flag**, both declined during brainstorming.
