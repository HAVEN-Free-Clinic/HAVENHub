# Page-to-condition mapping for adaptive docs access

This table tells the docs owner which GitBook condition to paste on each page or section of the
`tHfYPT1JPCmq1ZcM0VKy` (HAVEN Hub Docs) space, so a visitor only sees documentation for the
features they can actually use in the app.

Every condition below is a `visitor.claims.can.<module>.<action>` boolean read off the signed
visitor-auth JWT. The claim shape is committed at `docs/gitbook/adaptive-schema.json`; every
path used in this table is a leaf in that schema (verified below).

Most leaves mirror a registry permission one-to-one. Two do not: `schedule.manages_any_dept`
and `schedule.manages_any_rhd_dept` are data-driven capability claims (an active directorship or
delegation is not a permission string), computed in the auth route and signed into the token
rather than derived from the permission set. They are declared in `ADAPTIVE_DERIVED_CLAIMS` in
`src/platform/gitbook/catalog.ts`. See the two sections at the end for how they were derived.

## Maintenance: keeping the schema in sync

Adding or removing a permission in `src/platform/modules/registry.ts`, or editing the data-driven
`ADAPTIVE_DERIVED_CLAIMS` list in `src/platform/gitbook/catalog.ts`, changes the shape of the
visitor-claims schema. When that happens, regenerate `docs/gitbook/adaptive-schema.json` with
`npx tsx scripts/gen-gitbook-adaptive-schema.ts` (needed to pass the drift-guard test), and then
also re-push the regenerated file to GitBook via the adaptive-schema update, not just commit it.
A derived claim also needs its value wired in `src/app/api/gitbook/auth/route.ts` (permission
leaves are filled automatically; a derived leaf with no computed value signs as `false`).
Committing without re-pushing leaves the live GitBook schema out of sync: once Adaptive content
is enabled, a signed token can carry a new `can.<module>.<action>` leaf that the live schema does
not know about and rejects, which can break docs auth for everyone until the push catches up.

## How to apply a condition in GitBook

1. Open the page (or the section's landing page) in the GitBook editor.
2. Open the page/section actions menu (the `...` in the page tree, or the in-page menu).
3. Choose **Add condition**.
4. Paste the expression from the Condition column, for example:
   `visitor.claims.can.recruitment.access == true`
5. Save. Pages with no condition are left as-is (visible to everyone, including signed-out
   visitors).

Setting a condition on a section's landing page does not automatically apply it to that
section's child pages; each child page needing protection is listed as its own row below and
needs the condition applied separately.

## Mapping table

| Section | Page | GitBook page id | Condition |
| --- | --- | --- | --- |
| Getting Started | *(landing)* | `etM9WKLUmPHMPPwLaPrs` | none (always visible) |
| Getting Started | Signing in | `29kx6L2EYuTHwOKV0uFZ` | none (always visible) |
| Getting Started | Your dashboard | `wrj2pmY1zVvf0b5eprBn` | none (always visible) |
| Getting Started | Notifications | `EL45gNHPGwlpPycToU8g` | none (always visible) |
| Applying to HAVEN | *(landing)* | `b6SD1burWbiXGo4P9ihA` | none (always visible) |
| Applying to HAVEN | Starting an application | `OmNKvVAbBw4gGxYZWipo` | none (always visible) |
| Applying to HAVEN | The application wizard | `jtiur1v0ZSxf7yrYzk4C` | none (always visible) |
| Applying to HAVEN | Checking your status | `BT9zXDs9BMclOB5ueP9b` | none (always visible) |
| Applying to HAVEN | Accepting your offer | `bv5OddUHuRNZvxERCiei` | none (always visible) |
| Applying to HAVEN | New-volunteer setup | `7Lw6aN14siu0ABvSgBQ7` | none (always visible) |
| My Info & Compliance | *(landing)* | `jl41m9LMFckMtiSS9a6d` | none (always visible) |
| My Info & Compliance | Updating your contact info | `jpLsdJ1UuDNO55OZ07fB` | none (always visible) |
| My Info & Compliance | HIPAA compliance & your certificate | `0nQMahExPq7HOhFe6C04` | none (always visible) |
| My Info & Compliance | Getting cleared for the term | `C4EEVF76uuM7RUdzZc4k` | none (always visible) |
| Clinic Schedule | *(landing)* | `UgcnVL76IeZLd87xyTcf` | `visitor.claims.can.schedule.view == true` |
| Clinic Schedule | Viewing your shifts & setting availability | `EhN56UyDlWJBOUuJBOkI` | `visitor.claims.can.schedule.view == true` |
| Clinic Schedule | Requesting a swap or drop | `soyJ8T4LpGQzXPPJdSqb` | `visitor.claims.can.schedule.view == true` |
| Clinic Schedule | Building the schedule | `734zBb0ciwqmMetJGOfg` | `visitor.claims.can.schedule.manages_any_dept == true` |
| Clinic Schedule | Capacity & clinic readiness | `qxa613ZdLEJc8kXpqvdX` | `visitor.claims.can.schedule.manages_any_dept == true` |
| Clinic Schedule | Attendings & reproductive-health readiness | `qYdK7gK8kqImHQ976Hzu` | `visitor.claims.can.schedule.manages_any_rhd_dept == true` |
| Learning | *(landing)* | `hU35XDBNX1dvSXar5qZC` | `visitor.claims.can.learning.access == true` |
| Learning | Taking your courses | `REBLPvWFKzbj6Nwgcn7x` | `visitor.claims.can.learning.access == true` |
| Learning | Managing courses | `TInlyYfJVFSTaVoWnLqJ` | `visitor.claims.can.learning.manage_courses == true` |
| Learning | Tracking completion | `0B69VX5EuB6PeoTTZGgb` | `visitor.claims.can.learning.view_progress == true` |
| IT Support | *(landing)* | `dpOIoidRERe9dHQ7Xw9W` | none (always visible) |
| IT Support | Submitting a request | `3gi0PiqhgVAGxkBztq9K` | none (always visible) |
| IT Support | Tracking your requests | `OBrzt1M5F0XFguyzW1OI` | none (always visible) |
| IT Support | Managing requests | `cOQBGryoWwyvOTz4OC46` | `visitor.claims.can.support.manage_requests == true` |
| IT Support | Epic & YNHH access | `gnHsmupxun4iVuYmeTmp` | `visitor.claims.can.support.manage_requests == true` |
| Incident Reports | *(landing)* | `RLhGEIHP5xR9m2MdT8sS` | none (always visible) |
| Incident Reports | Reporting a concern | `33RJwPMkQdlaqVee0aSh` | none (always visible) |
| Incident Reports | Your reports | `W4eFKjaIDNnSpch2TqBR` | none (always visible) |
| Incident Reports | Reviewing reports | `MjXdobmoTPxPf8UBzS4o` | `visitor.claims.can.incidents.manage == true` |
| Incident Reports | Strikes | `xO8JnAITITezn4jD6Fgs` | `visitor.claims.can.incidents.view_strikes == true` |
| Volunteer Management | *(landing)* | `oN0nVnooTkTxhu2M4FDf` | `visitor.claims.can.volunteers.view == true` |
| Volunteer Management | Compliance overview | `IjUP0dHJYOvAe6w1i6Di` | `visitor.claims.can.volunteers.view == true` |
| Volunteer Management | Master view | `NPUzhjC6USm6UhpqvKx1` | `visitor.claims.can.volunteers.view_compliance == true or visitor.claims.can.volunteers.manage_compliance == true` |
| Volunteer Management | EHS training | `58TjuGedA6VfVpRBW6Zj` | `visitor.claims.can.volunteers.view_compliance == true or visitor.claims.can.volunteers.manage_compliance == true` |
| Volunteer Management | Spanish verification | `OVS68MjE9bwO9xWToIT2` | `visitor.claims.can.volunteers.verify_spanish == true` |
| Volunteer Management | Offboarding | `sKZj4M7EkUy9N06gXtXC` | `visitor.claims.can.volunteers.view == true` |
| Recruitment | *(landing)* | `wE2OL6Zx7fCucbhiXoW4` | `visitor.claims.can.recruitment.access == true` |
| Recruitment | Running a cycle | `lYCaW2ryvEpXvgcMxANj` | `visitor.claims.can.recruitment.manage_cycles == true` |
| Recruitment | Building the application | `spzcXrEV3BxvLZgyORCE` | `visitor.claims.can.recruitment.manage_cycles == true` |
| Recruitment | Reviewing applicants | `6f45jaeddDMnVxLcm6yz` | `visitor.claims.can.recruitment.access == true` |
| Recruitment | Interviews | `q3deTJsTW78Wr0CpLdUy` | none (always visible; panelist carve-out, see note below) |
| Recruitment | Making decisions | `gdvvRd8UtBYm7SBUNbPr` | `visitor.claims.can.recruitment.review_all == true` |
| Recruitment | Onboarding new members | `5bzPYfOBwzTdp5uCoGT4` | `visitor.claims.can.recruitment.review_all == true` |
| Recruitment | Subcommittees & training | `yvgmh1ecxzpaSPcPjTRH` | `visitor.claims.can.recruitment.access == true` |
| Recruitment | Recruitment emails | `AV3rGJTPJePnitISh60c` | `visitor.claims.can.recruitment.manage_cycles == true` |
| Clinic Tools | *(landing)* | `N5aBTYs3DEzrFi1820HO` | `visitor.claims.can.clinic.access == true` |
| Clinic Tools | After Visit Summary | `OlvC8I3QU3DQ4cvEbzQ6` | `visitor.claims.can.clinic.access == true` |
| Admin & Settings | *(landing)* | `E9pudzgkYd3bte4bGjOS` | `visitor.claims.can.admin.access == true` |
| Admin & Settings | Managing people | `HScT0EeHOcekGRYhggJx` | `visitor.claims.can.admin.manage_people == true` |
| Admin & Settings | Terms | `UWhcX8EFzxZbe2MLXvJj` | `visitor.claims.can.admin.manage_terms == true` |
| Admin & Settings | Roles & permissions | `XUyVDi8ZfCrFgCq9T0ho` | `visitor.claims.can.admin.manage_roles == true` |
| Admin & Settings | Departments | `BcNuUnYAjhtHDTTqM3bt` | `visitor.claims.can.admin.manage_departments == true` |
| Admin & Settings | Subcommittees | `2FCvLd4Ri3KWqZuK2ugY` | `visitor.claims.can.admin.manage_subcommittees == true` |
| Admin & Settings | Email templates & campaigns | `ARviQjiHQtZmAf05iZpm` | `visitor.claims.can.admin.manage_sync == true` |
| Admin & Settings | Notification settings | `vSBH6krsT6FFDI6TaZ83` | `visitor.claims.can.admin.manage_sync == true` |
| Admin & Settings | Audit log | `wO7phMTD1uoKjKVeBaIJ` | `visitor.claims.can.admin.view_audit == true` |
| Admin & Settings | General settings & branding | `ubE2gyjEAE7QG1T7kboo` | `visitor.claims.can.admin.manage_settings == true` |

## Always visible (no condition)

These pages carry no condition, either because the module has no `accessPermission` (open to
any signed-in matched person, per the registry), because the section is applicant-facing and
runs before a person ever gets a HAVEN Hub account, or (Recruitment > Interviews) because the
page is written for interview panelists who deliberately hold no permission at all:

- Getting Started (landing, Signing in, Your dashboard, Notifications)
- Applying to HAVEN (landing, Starting an application, The application wizard, Checking your
  status, Accepting your offer, New-volunteer setup)
- My Info & Compliance (landing, Updating your contact info, HIPAA compliance & your
  certificate, Getting cleared for the term)
- IT Support (landing, Submitting a request, Tracking your requests)
- Incident Reports (landing, Reporting a concern, Your reports)
- Recruitment (Interviews only; panelist carve-out, see note below)

## Notes on how conditions were derived

**Recruitment sub-pages.** The registry's `recruitment` module has a single nav entry
(`Cycles`, no `permission` field), so it does not directly name a finer permission for each doc
page the way Learning, Volunteers, Incidents, Support, and Admin do. Rather than defaulting
every Recruitment child page to `recruitment.access` (the landing condition), the actual
page-level gates were checked in the app (`src/app/(app)/recruitment/**`):

- `cycles/[id]/builder/page.tsx`, `cycles/[id]/builder/contract/page.tsx`,
  `cycles/[id]/builder/quiz/page.tsx`, `cycles/[id]/emails/page.tsx`,
  `cycles/[id]/emails/[key]/page.tsx`, and `cycles/new/page.tsx` all call
  `requirePermission("recruitment.manage_cycles")`, backing **Running a cycle**,
  **Building the application**, and **Recruitment emails**.
- `cycles/[id]/decisions/page.tsx` and `cycles/[id]/onboarding/page.tsx` both call
  `requirePermission("recruitment.review_all")`, backing **Making decisions** and
  **Onboarding new members**.
- `cycles/[id]/applicants/page.tsx`, `cycles/[id]/interviews/page.tsx`,
  `cycles/[id]/subcommittees/page.tsx`, and `cycles/[id]/training/page.tsx` have no page-level
  `requirePermission` call beyond the module's own `recruitment.access` gate (scoping to a
  reviewer's own departments happens in data, not in a permission check), backing
  **Reviewing applicants** and **Subcommittees & training** staying at `recruitment.access`.

Both `recruitment.manage_cycles` and `recruitment.review_all` are already declared on the
`recruitment` module in the registry and are present as leaves in the schema, so this is not a
new or invented permission, just a more precise read of an already-approved permission set than
the nav array alone provides.

**Interviews carve-out.** `recruitment/interviews/page.tsx` (the panelist-facing route backing
the **Interviews** doc page) is a different case: it is reached through the panelist branch of
`recruitment/layout.tsx`, a permission-less branch kept open on a bare session precisely so
panelists without `recruitment.access` can reach it, so it is not gated by `recruitment.access`
at all. See the resolution note below.

## Resolved: Clinic Schedule manager pages (data-driven claims)

**Building the schedule**, **Capacity & clinic readiness**, and
**Attendings & reproductive-health readiness** document the Builder and Attendings tools. Unlike
every other gated page in this table, their real-app access check is not a single
`can.schedule.<action>` boolean. `src/app/(app)/schedule/layout.tsx` says so directly:

> Builder and Attendings are management tools. Unlike the other schedule sub-tabs (which gate on
> `schedule.view` = module access), their access is a data-driven capability, managing a
> schedule department (Builder) or an RHD-family department (Attendings), so it can't be a
> registry permission string.

Concretely, `canManageAnyScheduleDept()` in `src/modules/schedule/services/builder.ts` is true
for: an active director of the department this term (including departments delegated to that
director), OR a holder of `schedule.edit_own_dept` (scoped to their own memberships), OR a
holder of `schedule.edit_all` (every department). None of `schedule.view`,
`schedule.edit_own_dept`, or `schedule.edit_all` alone reproduces this gate correctly as a
single boolean: `schedule.view` is far too broad (every scheduled volunteer has it),
`schedule.edit_all` is too narrow (excludes ordinary department directors, who are the primary
audience for these pages), and `schedule.edit_own_dept` alone misses directors whose access
comes purely from a directorship/delegation rather than that permission grant. `Attendings` is
gated the same way, by `canManageAnyRhdDept()`, and `Capacity & clinic readiness` documents a
sidebar panel that only appears inside Builder, so it inherits the same gate.

Leaving these three pages unconditioned would show director/manager-only workflow docs to every
volunteer with `schedule.view`. Gating them on `schedule.edit_all` would hide them from the
department directors who are their actual primary audience.

**Resolution (applied).** Rather than under-match with an existing permission, the visitor-claims
schema was extended with two data-driven leaves that reproduce the real gates exactly:

- `schedule.manages_any_dept` mirrors `canManageAnyScheduleDept()`, and backs **Building the
  schedule** and **Capacity & clinic readiness** (the Capacity panel lives inside Builder, so it
  shares Builder's gate).
- `schedule.manages_any_rhd_dept` mirrors `canManageAnyRhdDept()`, and backs
  **Attendings & reproductive-health readiness**. A single `manages_any_dept` claim would not do
  here: RHD management is the subset that intersects reproductive-health departments, so
  `manages_any_dept` would over-show the Attendings docs to a schedule manager who directs only
  non-RHD departments.

Both leaves are declared in `ADAPTIVE_DERIVED_CLAIMS` in `src/platform/gitbook/catalog.ts`,
published into `adaptive-schema.json`, and computed in the auth route
(`src/app/api/gitbook/auth/route.ts`) from the same two service functions the app itself gates
on, then signed into the token. No registry permission was invented.

## Resolved: Recruitment Interviews page (panelists, always visible)

**Interviews** documents `src/app/(app)/recruitment/interviews/page.tsx`, the "My interview
assignments" page shown to interview panelists. Panelists are not recruitment staff and hold no
`recruitment.access` claim; `src/app/(app)/recruitment/layout.tsx` says so directly ("panelists
... are not recruitment staff and hold no recruitment.access"), and the page itself only calls
`requirePersonSession()`, no `requirePermission` check of any kind. Panel membership is a
dynamic, data-driven assignment (is this person on this interview's panel), not a permission
grant, so no `can.recruitment.*` leaf in the schema captures the panelist audience the same way
`can.schedule.manages_any_dept` would need to for Builder/Attendings above.

Gating this row on `recruitment.access` (as it previously was) would hide the page from the
panelists it is written for, while showing it to recruitment staff who are not necessarily
panelists.

**Resolution (applied).** This page carries no condition (always visible), so panelists keep
access. A signed-in non-panelist who lands here only sees an empty assignments table, so the
residual exposure is a blank page, not sensitive content. A data-driven claim like the schedule
ones above was considered and rejected: panel membership is per-interview assignment data with no
stable person-level "is a panelist" capability to reduce to a single boolean, and the empty-table
fallback makes one unnecessary. If that residual exposure to non-panelist staff ever becomes
unacceptable, the fallback is to split the page into a panelist-only view (left unconditioned)
and move any staff-only portions to a separately conditioned page.

## Schema cross-check

Every distinct `visitor.claims.can.<module>.<action>` path used above is a leaf under `can` in
`docs/gitbook/adaptive-schema.json`:

- `admin.access`, `admin.manage_people`, `admin.manage_terms`, `admin.manage_roles`,
  `admin.manage_departments`, `admin.manage_subcommittees`, `admin.manage_sync`,
  `admin.view_audit`, `admin.manage_settings`
- `clinic.access`
- `incidents.manage`, `incidents.view_strikes`
- `learning.access`, `learning.manage_courses`, `learning.view_progress`
- `recruitment.access`, `recruitment.manage_cycles`, `recruitment.review_all`, `recruitment.score`
- `schedule.view`, `schedule.manages_any_dept`, `schedule.manages_any_rhd_dept`
- `support.manage_requests`, `support.view_all_requests`
- `volunteers.view`, `volunteers.view_compliance`, `volunteers.manage_compliance`,
  `volunteers.verify_spanish`

All confirmed present as `boolean` leaves in the schema. `schedule.manages_any_dept` and
`schedule.manages_any_rhd_dept` are the two data-driven leaves (`ADAPTIVE_DERIVED_CLAIMS`); every
other path mirrors a registry permission. The `schema-artifact.test.ts` drift guard asserts the
committed `adaptive-schema.json` still equals `buildAdaptiveSchema()`, so the schedule leaves stay
in the file as long as they stay in the catalog.

Note the direction of that containment: this list is the paths **used above**, not every leaf in
the schema. The schema is derived from the whole of `MODULES[].permissions`, so it also carries
leaves no docs condition references yet — `volunteers.view_directory` (the people directory, added
2026-09-01), `volunteers.view_directory_own_dept` (its department-scoped half, held by the
Director baseline, added 2026-09-02) and `recruitment.record_attendance` (event check-in at a
door, added 2026-09-03) are three, alongside longer-standing ones like
`volunteers.manage_offboarding` and `admin.manage_roster`. That is expected and is not drift.

`volunteers.view_compliance` (added 2026-09-01) is the opposite case: it IS used, in the two
Volunteer Management rows above, whose conditions were widened from `manage_compliance` alone when
the clinic-wide compliance read was split out of it. **Those two conditions must be edited in the
GitBook site itself as well** — this table records what is configured there, it does not configure
it, so a view-only holder keeps getting a 404 on those pages until someone makes the matching edit.

What *is* drift, and what nothing in CI
can catch, is the LIVE site schema falling behind this file: every `can.<module>` object is
`additionalProperties: false`, so a token carrying a leaf the live schema lacks is rejected outright
once Adaptive content is enabled. Push this file with `updateSiteAdaptiveSchema` whenever a
permission is added.
