# Page-to-condition mapping for adaptive docs access

This table tells the docs owner which GitBook condition to paste on each page or section of the
`tHfYPT1JPCmq1ZcM0VKy` (HAVEN Hub Docs) space, so a visitor only sees documentation for the
features they can actually use in the app.

Every condition below is a `visitor.claims.can.<module>.<action>` boolean read off the signed
visitor-auth JWT. The claim shape is committed at `docs/gitbook/adaptive-schema.json`; every
path used in this table is a leaf in that schema (verified below).

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
| Clinic Schedule | Building the schedule | `734zBb0ciwqmMetJGOfg` | NEEDS REVIEW (see note below) |
| Clinic Schedule | Capacity & clinic readiness | `qxa613ZdLEJc8kXpqvdX` | NEEDS REVIEW (see note below) |
| Clinic Schedule | Attendings & reproductive-health readiness | `qYdK7gK8kqImHQ976Hzu` | NEEDS REVIEW (see note below) |
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
| Volunteer Management | Master view | `NPUzhjC6USm6UhpqvKx1` | `visitor.claims.can.volunteers.manage_compliance == true` |
| Volunteer Management | EHS training | `58TjuGedA6VfVpRBW6Zj` | `visitor.claims.can.volunteers.manage_compliance == true` |
| Volunteer Management | Spanish verification | `OVS68MjE9bwO9xWToIT2` | `visitor.claims.can.volunteers.verify_spanish == true` |
| Volunteer Management | Offboarding | `sKZj4M7EkUy9N06gXtXC` | `visitor.claims.can.volunteers.manage_offboarding == true` |
| Recruitment | *(landing)* | `wE2OL6Zx7fCucbhiXoW4` | `visitor.claims.can.recruitment.access == true` |
| Recruitment | Running a cycle | `lYCaW2ryvEpXvgcMxANj` | `visitor.claims.can.recruitment.manage_cycles == true` |
| Recruitment | Building the application | `spzcXrEV3BxvLZgyORCE` | `visitor.claims.can.recruitment.manage_cycles == true` |
| Recruitment | Reviewing applicants | `6f45jaeddDMnVxLcm6yz` | `visitor.claims.can.recruitment.access == true` |
| Recruitment | Interviews | `q3deTJsTW78Wr0CpLdUy` | `visitor.claims.can.recruitment.access == true` |
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
any signed-in matched person, per the registry) or because the section is applicant-facing and
runs before a person ever gets a HAVEN Hub account:

- Getting Started (landing, Signing in, Your dashboard, Notifications)
- Applying to HAVEN (landing, Starting an application, The application wizard, Checking your
  status, Accepting your offer, New-volunteer setup)
- My Info & Compliance (landing, Updating your contact info, HIPAA compliance & your
  certificate, Getting cleared for the term)
- IT Support (landing, Submitting a request, Tracking your requests)
- Incident Reports (landing, Reporting a concern, Your reports)

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
  `recruitment/interviews/page.tsx`, `cycles/[id]/subcommittees/page.tsx`, and
  `cycles/[id]/training/page.tsx` have no page-level `requirePermission` call beyond the
  module's own `recruitment.access` gate (scoping to a reviewer's own departments happens in
  data, not in a permission check), backing **Reviewing applicants**, **Interviews**, and
  **Subcommittees & training** staying at `recruitment.access`.

Both `recruitment.manage_cycles` and `recruitment.review_all` are already declared on the
`recruitment` module in the registry and are present as leaves in the schema, so this is not a
new or invented permission, just a more precise read of an already-approved permission set than
the nav array alone provides.

## NEEDS REVIEW: Clinic Schedule manager pages

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
department directors who are their actual primary audience. Per the task instructions, no new
permission was invented and no existing permission was guessed at to paper over this; these
three rows are marked `NEEDS REVIEW` for a human decision, for example: extend the visitor-claims
schema with a data-driven `can.schedule.manages_any_dept` claim, or accept the
`schedule.edit_all` under-match as good enough for documentation purposes.

## Schema cross-check

Every distinct `visitor.claims.can.<module>.<action>` path used above is a leaf under `can` in
`docs/gitbook/adaptive-schema.json`:

- `admin.access`, `admin.manage_people`, `admin.manage_terms`, `admin.manage_roles`,
  `admin.manage_departments`, `admin.manage_subcommittees`, `admin.manage_sync`,
  `admin.view_audit`, `admin.manage_settings`
- `clinic.access`
- `incidents.manage`, `incidents.view_strikes`
- `learning.access`, `learning.manage_courses`, `learning.view_progress`
- `recruitment.access`, `recruitment.manage_cycles`, `recruitment.review_all`
- `schedule.view`
- `support.manage_requests`
- `volunteers.view`, `volunteers.manage_compliance`, `volunteers.manage_offboarding`,
  `volunteers.verify_spanish`

All confirmed present as `boolean` leaves in the schema.
