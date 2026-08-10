# Volunteer passport: service record, certificate PDF, and wallet pass (2026-08-07)

## Problem

A HAVEN volunteer finishes four years at the clinic and has nothing to show for it. The record of
what they did exists in the Hub (terms served, department, director or volunteer track, clinic
shifts, verified Spanish, HIPAA standing) but it is scattered across roster screens built for
directors managing a term, not for a member describing their own service.

Two distinct needs fall out of that, and they want opposite artifacts.

A graduating student applying to residency needs **evidence**: something formal, dated, printable,
attachable to an application, and ideally checkable by the program reading it. A self-typed line on
a CV carries no weight; a clinic-issued document that a third party can verify does.

Every member, not only the graduating ones, wants **recognition**: something visible and carryable
that says they are part of this. That is a badge, not a document.

This spec builds one service record and renders it three ways: a certificate PDF (evidence), a
public credential page (verification and sharing), and an Apple/Google Wallet pass (recognition).

## What the data actually supports

Verified against the schema and importers on 2026-08-07. This section exists because the honest
shape of the artifact is dictated by these limits, and getting them wrong produces a document that
misrepresents a member to a residency program.

### Shift history starts at SU26

`src/platform/airtable/import/schedule.ts` is the only importer that writes `ShiftAssignment`, and
its own header describes it as a one-time SU 26 cutover. `historical-term.ts` writes `Term`,
`Department`, and `TermMembership` only (`termMembership.createMany`, line 219). No other path
backfills shifts.

Consequence: shift counts begin when the Hub took over scheduling. They are not a measure of
service length and never will be for anyone who served earlier.

### Membership history is thin

`scripts/import-historical-term.ts` has exactly one entry in `SOURCES`: SP26. Memberships therefore
cover Spring 2026 forward, plus terms the Hub has run natively since.

### Recruitment history goes back much further

`HistoricalApplication` ([[historical-recruitment-import]]) carries `cycleCode`, `termCode`,
`track`, `resultDepartment`, `furthestStage` (topping out at `ONBOARDED`) and `outcome`, across ten
imported cycles, linked to a live `Person` through `HistoricalApplicant.personId`. The importer
re-resolves that link on every run specifically so a past applicant who later joins gains their
history retroactively ([[returning-alum-recognition]]).

A row with `furthestStage: ONBOARDED` and `outcome: ACCEPTED` is defensible evidence of **when a
person joined**, years before the Hub existed. It is not evidence of how long they served.

### Attendance does not exist

`ShiftAssignment` is the published schedule after swaps and drops resolve. Nothing records who
walked in the door. A volunteer scheduled for 14 shifts who attended 9 has 14 rows.

### Offboarding preserves past terms but not the current one

`OFFBOARDABLE_TERM` (`src/platform/people.ts:39`) scopes the offboard sweep to
`term: { status: { not: "ARCHIVED" } }`. Archived terms keep their `ACTIVE` memberships, so history
survives ([[offboard-convergence]]). The current term does not: a graduating senior offboarded while
their final term is still `ACTIVE` has that membership flipped to `REMOVED`.

A record built from `status: "ACTIVE"` would silently drop the final term, which is the one the
member most wants credit for, at the exact moment they ask for the certificate. The snapshot model
below exists largely to close this.

## Decisions

| Question | Decision |
|---|---|
| Audience | Every member, not only graduating seniors. Both evidence and recognition. |
| Wallet issuance | Third-party API (walletwallet.dev) rather than owning Apple and Google issuer credentials. |
| Pass lifetime | Term-scoped with automatic expiry. Revoked on offboard, reissued each term. |
| Shift claim | Report scheduled shifts, labeled as such. Attendance capture is out of scope. |
| Format | Per-term service record table. No cumulative headline totals. |
| Credential page | Opt-in per member. Unguessable token. Not indexed. |
| Wallet tier | Free tier to start. Unbranded, `colorPreset` only. |

### Why per-term rather than totals

A headline "47 shifts" silently means "since we bought the software." It makes a fourth-year who
served six terms look thinner than a first-year who served one, which is the exact inversion to
avoid on a residency application. A per-term table makes the record-keeping boundary self-evident:
terms before SU26 carry no shift column, which reads as a data boundary rather than a claim about
the person.

### Why the vendor, and what it costs

walletwallet.dev signs passes with its own Pass Type ID, so HAVEN skips the Apple Developer
membership, the annually-expiring signing certificate, and Google issuer approval. One `POST`
issues to both wallets; `PUT` pushes updates to installed devices; `DELETE` revokes. Free tier is
1,000 passes per month counting creations and updates, far above a clinic of a few hundred members
refreshed once a term.

The trade is lock-in. A `.pkpass` cannot be re-signed under a different certificate and keep
updating in place, because the signature is the identity. If the service fails or repricing makes it
untenable, passes are reissued from scratch and every member re-adds. This is mitigated
architecturally, not contractually: the pass is a disposable rendering of data the Hub owns, the
vendor sits behind three methods, and passes expire on their own each term.

Two costs to record explicitly:

- Volunteer roster data (name, department, role, term) goes to a third-party processor with no DPA.
  Not PHI, so not a HIPAA question, but an explicit decision rather than a silent one.
- **Custom color and custom logo are Pro-only ($39/month, $468/year).** The free tier is a generic
  `colorPreset` card with no logo. For a recognition artifact the branding matters, and this inverts
  the cost comparison: branded via Pro is $468/year against $99/year for HAVEN's own Apple Developer
  account plus the certificate chore. Starting free is a deliberate bet that an unbranded badge is
  worth carrying for one term while we learn whether anyone minds.

## Design

### The record is issued, not computed on demand

`src/modules/passport/services/service-record.ts` computes a `ServiceRecord`. Nothing renders that
live value. Issuing a credential snapshots it:

```prisma
model ServiceCredential {
  id          String    @id @default(cuid())
  personId    String
  /// Unguessable public token. Null until the member opts into publishing.
  publicToken String?   @unique
  /// The full rendered record at issuance. Never recomputed.
  record      Json
  issuedAt    DateTime  @default(now())
  revokedAt   DateTime?
  person      Person    @relation(fields: [personId], references: [id], onDelete: Cascade)

  @@index([personId])
}
```

Three reasons for a snapshot rather than a live query:

1. **The public page stays safe.** A public URL that recomputes on every request will eventually
   render something the member never agreed to publish: a department they left, a corrected term, a
   shift count that moved.
2. **The artifacts agree by construction.** PDF and page read the same frozen JSON and cannot drift.
   A shared function alone does not deliver this, because it is still called at two different times.
3. **It closes the offboarding hole.** Offboarding auto-issues a final snapshot before memberships
   flip, inside the existing transaction in `setPersonStatusField`. The senior's last term is
   captured while it is still true, with no ops ritual about archiving terms first and no rule about
   which `REMOVED` rows to forgive.

The computed shape:

```ts
type ServiceTermRow = {
  termCode: string;
  termName: string;
  startDate: string;      // ISO, JSON-safe
  departmentName: string;
  track: "VOLUNTEER" | "DIRECTOR";
  shifts: number | null;  // null = term predates shift records entirely
  /// MEMBERSHIP = a roster row exists. RECRUITMENT = reconstructed from an
  /// onboarded recruitment outcome, for terms predating the Hub's rosters.
  source: "MEMBERSHIP" | "RECRUITMENT";
};

type ServiceRecord = {
  name: string;
  memberSince: { label: string; source: "MEMBERSHIP" | "RECRUITMENT" };
  terms: ServiceTermRow[];             // ascending by startDate
  capabilities: { spanishVerified: boolean; licensedRN: boolean };
  basis: "SCHEDULED";                  // upgrades to "ATTENDED" if attendance ever lands
  generatedAt: string;                 // ISO
};
```

Rules that carry the honesty requirements:

- **`shifts: null` and `shifts: 0` must never render the same.** Null means the term has no shift
  data at all. Zero means it does and this person had none.
- **Whether a term has shift data is probed, not hardcoded.** Ask whether any `ShiftAssignment`
  exists for the term. The SU26 boundary then moves on its own if anyone ever backfills.
- **`memberSince` takes the earlier** of the first `TermMembership` term start and the first
  `HistoricalApplication` with `furthestStage: ONBOARDED` and `outcome: ACCEPTED`, recording which
  source won so the PDF phrases it accurately instead of implying roster records that do not exist.
- **Terms come from `ACTIVE` memberships.** Withdrawn and roster-corrected terms are excluded, which
  is the honest behavior; the offboard snapshot hook is what keeps a graduating member's final term.
- **Terms predating the rosters are reconstructed from recruitment outcomes.** A
  `HistoricalApplication` with `furthestStage: ONBOARDED` and `outcome: ACCEPTED` yields a row with
  `source: "RECRUITMENT"`, using its `termCode` (falling back to `cycleLabel` when absent),
  `resultDepartment`, and `track`, always with `shifts: null`. Without this, a member who joined in
  2023 renders "member since Fall 2023" above a table that starts in Spring 2026, which reads as a
  bug rather than as a record-keeping boundary.
- **Membership wins on collision.** If both a membership row and a recruitment outcome resolve to the
  same term, the membership row is kept and the recruitment row dropped, so no term appears twice.
- **Provenance is rendered, not hidden.** Recruitment-sourced rows are visibly marked (for example
  "joined via recruitment") so the reader can tell a reconstructed row from a roster row.

### Certificate PDF

`src/modules/passport/components/passport-pdf.tsx`, following `avs-pdf.tsx` ([[avs-generator]]):
`Document` / `Page` / `StyleSheet`, rendered client-side, ephemeral, no bytes stored. Brand color
and org name come from resolved settings ([[org-name-configurable]], [[brand-color-pdf-email]]) so a
rebrand flows without touching this file.

Entry point is a "Service record" card on `/my-info`. The member clicks, a server action issues the
`ServiceCredential`, and the client renders the PDF from the returned snapshot.

The snapshot crosses the server/client boundary, so the server action returns JSON-safe primitives
only: dates as ISO strings, no `Date` objects, no Prisma model instances
([[use-client-plain-data-proxy]]). The client component renders the payload and never re-derives it.

A QR code pointing at the credential page renders only when the member has published. An unpublished
certificate is still valid; it simply is not third-party verifiable, which is the member's choice.

### Public credential page

`src/app/credential/[token]/page.tsx`, deliberately **outside** the `(app)` route group. That is
what keeps it clear of `requirePersonSession` and the onboarding gate without anyone adding an
allowlist entry, matching the structural choice `/apply`, `/login`, and `/welcome` already make
([[onboarding-gate]]).

- Token is 32 random bytes, base64url, stored on the credential row, null until the member opts in.
  Unguessable and non-enumerable.
- Page is `noindex`. Metadata goes through `buildPageMetadata` ([[open-graph-metadata]]).
- Publishing and unpublishing are member actions on the `/my-info` card.

**The token rides in a URL path, so it lands in PostHog capture.** It must be added to the same
scrub list the ICS feed token uses, in the PR that mints it ([[calendar-ics-feed]]). A token
published to the analytics vendor is not unguessable.

**Revocation is deliberately asymmetric between artifacts.** The wallet pass dies on offboard
because it asserts present standing. The credential page and PDF are past-tense claims, and a person
who graduates normally did serve those terms; auto-revoking would destroy the artifact exactly when
it becomes useful. Offboarding therefore revokes the pass and leaves the credential standing.
Revoking a credential is a separate deliberate admin action for falsified service or a record issued
in error.

### Wallet pass

`src/modules/passport/services/wallet-pass.ts` wraps the vendor behind `issue`, `refresh`, and
`revoke`. No other code knows the vendor exists.

```prisma
model WalletPass {
  id           String    @id @default(cuid())
  personId     String
  termId       String
  /// Vendor serial, the handle for update and revoke.
  serialNumber String    @unique
  issuedAt     DateTime  @default(now())
  revokedAt    DateTime?
  person       Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
  term         Term      @relation(fields: [termId], references: [id], onDelete: Restrict)

  @@unique([personId, termId])
  @@index([personId])
}
```

Pass contents: org name, track (Volunteer or Director), department, current term, member-since year.
Nothing cumulative, since the pass is a present-tense badge and the cumulative story lives on the
PDF and credential page. Barcode is a QR to the credential page, present only when published.

API mapping:

| Need | Vendor field or call |
|---|---|
| Term expiry | `expirationDays` (1 to 3650), computed from now to `term.endDate` |
| Revoke | `DELETE /api/passes/{serial}`, greys out on Apple, expired on Google, repeat calls are no-ops |
| Update | `PUT /api/passes/{serial}`, unchanged bodies push nothing and consume no quota |
| Styling | `colorPreset` on the free tier; `color` and `logoURL` require Pro |
| Privacy | `sharingProhibited`, defaults true |

Two hard rules:

1. **No vendor HTTP call inside a Prisma transaction.** Offboarding revokes after its transaction
   commits, so a vendor timeout can never roll back an offboard or hold a DB connection open across
   a network round-trip.
2. **We own reconciliation.** The vendor documents no webhooks and no status endpoint beyond
   `GET /api/auth/usage`. A cron sweep ([[cron-auth-worker-cleanup]]) revokes passes whose term has
   ended or whose person is offboarded, idempotently.

Issuance is best-effort throughout. A vendor outage or a 429 degrades the badge and must never break
`/my-info` or offboarding ([[db-unreachable-degradation]]).

Config: `WALLETWALLET_API_KEY` in env. The feature is off when the key is absent, so the first three
PRs ship with the wallet path dark.

## Failure modes

| Failure | Behavior |
|---|---|
| Vendor down or timing out at issuance | Log, leave `WalletPass` unissued, sweep retries. Page renders without a pass. |
| Vendor 429 (quota) | Same path as a timeout. |
| Vendor down at offboard revoke | Offboard completes. Row marked, sweep revokes on next run. |
| Credential token leaked | Member unpublishes; token is nulled and the page 404s. |
| Person deleted | `ServiceCredential` and `WalletPass` cascade. Vendor pass expires on its own at term end. |
| Term extended after issuance | Pass expires early. Reissue via `refresh`, which is a `PUT`. |

## Testing

Concentrated where this can actually be wrong, which is the record rather than the rendering.

Unit (`service-record.test.ts`):

- `shifts: null` versus `shifts: 0` are distinguishable in the output.
- The "does this term have shift data" probe derives the boundary from data, not a hardcoded SU26.
- `memberSince` picks the earlier of the membership and recruitment anchors and records the source.
- Withdrawn and roster-corrected terms are excluded.
- A recruitment-sourced term and a membership for the same term collapse to one row, membership wins.
- A recruitment outcome that is not `ONBOARDED` plus `ACCEPTED` produces no row at all, so an
  applicant who was rejected or withdrew never appears as having served.

Unit (offboard integration): offboard a person holding a current-term membership and assert the
snapshot still contains that term. This is a sequencing bug that only appears under the real
transaction, so it needs a test that exercises `setPersonStatusField` rather than the record
function alone.

Unit (`wallet-pass.test.ts`): the three calls against a mocked fetch, plus 429 and timeout handling,
plus the assertion that revoke is not called inside a transaction.

E2E: member generates a record, publishes it, and the public credential page loads unauthenticated.
The unauthenticated load is the case that breaks when someone later touches the route group, and
only an e2e catches it ([[e2e-covered-flows-not-run-locally]]).

## Out of scope

- **Attendance capture.** The schema is shaped for it (`basis`), but the director workflow, backfill
  policy, and compliance question are their own project.
- **LinkedIn integration.**
- **Any door-access, check-in, or identity use of the pass.** It is a badge, not a credential that
  opens anything.
- **Backfilling shift history for pre-SU26 terms.**

## PR sequence

1. Service record, `ServiceCredential` model, offboard snapshot hook.
2. Certificate PDF and the `/my-info` service record card.
3. Credential page, token, publish and unpublish, PostHog scrub entry.
4. Wallet pass, `WalletPass` model, reconciliation cron.

The first three have no external dependency. If the vendor does not work out, the project loses a
feature rather than a foundation.

## Open risks

- **Unbranded badge may land flat.** The free tier cannot carry the HAVEN mark or Yale Blue. If
  members find a generic card underwhelming, the choice is $468/year (Pro) or $99/year plus
  certificate rotation (own account). Reversible by design; revisit after one term.
- **Vendor durability is unverified.** No self-hosting or open-source escape hatch is documented.
  Acceptable for a badge, unacceptable for anything load-bearing, which is why nothing load-bearing
  depends on it.
- **Scheduled is not attended.** The certificate says "scheduled," which is true and weaker than
  members may expect. If a program ever challenges a number, the answer is that HAVEN attests to
  assignment, not attendance, until attendance capture exists.
