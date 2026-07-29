# Task 11: Code-read the admin module

Code-read 2026-07-29, no browser or dev server. Tier 2, the narrowest population in the audit:
roughly one person uses these pages. The IA lens was weighted heavily per the brief, since the
admin nav (eleven flat items) is one decision affecting every admin page at once. Every claim
below is source-verified by reading the file(s) cited; none were confirmed by running the app, so
where a finding depends on runtime behavior that is called out explicitly in the row.

Read in full: `src/platform/modules/registry.ts` (admin nav definition), `src/app/(app)/admin/layout.tsx`,
`src/app/(app)/admin/page.tsx`, `src/app/(app)/admin/people/page.tsx`, `people/[id]/page.tsx`,
`people/new/page.tsx`, `terms/page.tsx`, `terms/[id]/page.tsx`, `terms/new/page.tsx`, `roles/page.tsx`,
`departments/page.tsx`, `departments/[id]/page.tsx`, `departments/new/page.tsx`, `subcommittees/page.tsx`,
`subcommittees/[id]/page.tsx`, `subcommittees/new/page.tsx`, `contract/page.tsx`, `contract/actions.ts`,
`audit/page.tsx`, `notifications/page.tsx`, `settings/page.tsx`, `settings/branding-image-field.tsx`,
`email/page.tsx`, `email/campaigns/page.tsx`, `email/campaigns/new/page.tsx`, `email/campaigns/[id]/page.tsx`,
`email/campaigns/[id]/review-actions.tsx`, `email/templates/page.tsx`, `email/templates/[key]/page.tsx`.
Followed into supporting source to verify specific claims (cited inline): `src/platform/settings/registry.ts`,
`src/platform/ui/command-palette.tsx`, `src/platform/ui/app-shell.tsx`, `src/platform/modules/access.ts`,
`src/platform/modules/nav.ts`, `src/platform/ui/module-nav.tsx`, `src/modules/admin/components/roster-panel.tsx`,
`src/modules/recruitment/contract/template.ts`, `src/modules/recruitment/contract/resolve.ts`,
`src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx`,
`src/app/(app)/recruitment/cycles/[id]/builder/contract/page.tsx`,
`src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx`,
`src/app/(app)/notifications/page.tsx`, `src/modules/onboarding/services/step-config.ts`.

## Findings

| id | surface | lens | severity | reach | what is wrong | concrete fix | effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-11-1 | `src/platform/modules/registry.ts:147` (Subcommittees nav item), vs. `src/app/(app)/recruitment/cycles/[id]/subcommittees/page.tsx:35-83` | ia | costs-time | recruitment cycle leads who need a new subcommittee, a handful of times a year, and only the subset of them who also hold `admin.manage_subcommittees` plus `admin.access`; anyone on the recruitment team without both cannot do it from anywhere they work | Subcommittees are entirely a recruitment concept (applicants rank them, the recruitment team assigns accepted applicants to them, per the description text on both `subcommittees/page.tsx:17` and `recruitment/cycles/[id]/subcommittees/page.tsx:46`), but creating or editing one only exists at `/admin/subcommittees`, gated on `admin.manage_subcommittees` and the module-level `admin.access`, both distinct from `recruitment.access`. The per-cycle "Assign subcommittees" page under Recruitment (`recruitment/cycles/[id]/subcommittees/page.tsx:35,80-83`) reads the list via `listAssignableSubcommittees()` into a plain `<Select>` with no create option, no link to `/admin/subcommittees`, and no text anywhere on the page hinting where subcommittees themselves come from. This is the clearest instance in this module of a nav item that mirrors the database schema (one table, `Subcommittee`, one flat admin CRUD page) rather than the workflow it serves (which lives entirely inside a different top-level module with its own permission set). A recruitment lead standing on the one page built for this exact task, adding a new subcommittee before assigning applicants to it, has no path forward without already knowing Admin has a page for it and separately holding the permission to reach it. | Add a "Manage subcommittees" link from `recruitment/cycles/[id]/subcommittees/page.tsx` to `/admin/subcommittees` (rendered only when the viewer holds `admin.manage_subcommittees`, mirroring the permission-aware link pattern already used on `/admin/email:293-308`), or move subcommittee CRUD into the Recruitment module's own nav where cycles, forms, and scoring already live. | S |
| F-11-2 | `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:250`, resolved by `src/modules/recruitment/contract/resolve.ts:34-40`; vs. `src/app/(app)/admin/contract/page.tsx:34-61` | ia | blocks | recruitment directors resetting a cycle's contract override, specifically once an admin has ever customized the master template at `/admin/contract`; the reset click is director-facing, the precondition is admin-only | The per-cycle contract editor's reset button reads "Reset to built-in default" (`contract-editor.tsx:250`), but `resetCycleContractLayout` (`template.ts:65-68`) only deletes the cycle's own override row; the next read (`getContractLayoutForEdit`, `template.ts:35-41`) falls through to `resolveContractLayout`, whose documented precedence is "cycle override -> global default -> code default" (`resolve.ts:34-40`). So a director who clicks that button while the org's Admin has ever saved a custom master template on `/admin/contract` (its own hasOverride copy at `admin/contract/page.tsx:58-61` confirms this is a real, expected state, not an edge case) does not get the original built-in text back; they silently get whatever the admin's master template currently says. Nothing on the per-cycle page acknowledges that a master-template layer even exists between "this cycle's edits" and "the code default" the button names, and nothing on `/admin/contract` links to any specific cycle either, so a director cannot even go check what the master template currently contains before clicking reset. The two editors share the same component (`contract-editor.tsx:11` imports `saveGlobalContractAction`/`resetGlobalContractAction` straight from `admin/contract/actions.ts`) and the same underlying setting (`onboarding.contractTemplate`), so this is one feature rendered on two disconnected pages in two different modules, and the disconnect leaves the director wrong about what their own click just did. Not confirmed by running the app; the precedence chain and button copy are read directly from source. | Rename the per-cycle button to "Reset to master template" (or "Reset to org default") when a master template exists for the cycle's track, and add a one-line link from the per-cycle editor to `/admin/contract?track=...` so a director can see what the fallback actually contains before resetting into it. | S |
| F-11-3 | `src/app/(app)/admin/email/page.tsx:291-311`, vs. `src/platform/modules/registry.ts:150` and `src/platform/ui/command-palette.tsx:70-72,162-186` | ia | costs-time | `admin.send_email_campaign` / `admin.manage_email_templates` holders, a population that need not overlap with `admin.manage_sync` (the permission that actually gates the one path in) | `/admin/email/campaigns` (compose and send bulk email) and `/admin/email/templates` (edit the copy of every platform email) are full features, but neither is registered in the admin module's `nav` array in `registry.ts:138-153`. The command palette's page index is built from exactly that array: `app-shell.tsx` passes the same `navModules` (from `getAccessibleModules`, which builds each module's `nav` via `filterNavItems(m.nav, perms)` in `access.ts:92`) to both `GlobalNav` and `CommandPalette` (`app-shell.tsx:87,91`), and `CommandPalette`'s `pageIndex(items)` (`command-palette.tsx:70-72`) only appends a hardcoded personal-pages block, never anything module-specific. So Cmd+K, built specifically to solve "a page findable only by someone who already knows it exists," cannot find either page. The sole path in is landing on `/admin/email` first and noticing two small underlined text links in the page header (`email/page.tsx:293-308`), rendered only when the viewer holds the target page's own permission. A person who holds `admin.send_email_campaign` but not `admin.manage_sync` would not even see the "Email" tab that hosts those links, since the nav item itself gates on `admin.manage_sync` (registry.ts:150, confirmed by its own comment at :141: "Email and Notifications enforce admin.manage_sync, not the email perms"). Not confirmed by running the app; the specific case of a person holding one permission but not the other depends on how roles are actually assigned, which was not verified against seeded system roles. | Register "Campaigns" and "Templates" as their own sub-items in the admin module's `nav` array (each already permission-gated on its own page), so both surface in the tab row and the command palette the same way every other admin page does. | S |
| F-11-4 | `src/platform/modules/registry.ts:151` (nav label "Notifications"), vs. `src/platform/settings/registry.ts:288-306` (settings category "Notifications") and `src/app/(app)/notifications/page.tsx:54` (personal inbox titled "Notifications") | ia | costs-time | the small population of `admin.manage_sync` / `admin.manage_settings` holders trying to find the actual channel-routing controls, layered on top of every signed-in user who already carries a different meaning for "Notifications" from the bell icon in the toolbar | Three unrelated surfaces in this app are named "Notifications." The personal inbox at `/notifications` (`PageHeader title="Notifications"`, page.tsx:54) is what every signed-in user already associates with the word. The admin nav tab "Notifications" (registry.ts:151) opens `/admin/notifications`, which its own file comment describes as "Teams message monitoring dashboard" (notifications/page.tsx:2) - a delivery log with per-row Retry, nothing about preferences. The actual per-notification-type channel routing (Email / Teams DM / Both) is a settings category also named "Notifications" (`category: "Notifications"`, settings/registry.ts:291), rendered as its own section on `/admin/settings`. The admin notifications page is self-aware enough to paper over the second collision in prose - "Choose Email, Teams, or Both per notification type in Settings > Notifications" (notifications/page.tsx:168-177) - but the fix was a sentence, not a rename, so an admin who clicks the "Notifications" tab looking for that exact control lands on a Teams log instead, and has to read a hint to learn the real answer is a same-named section one page over. | Rename the admin nav tab to something that names what it actually is, e.g. "Message log" or "Teams delivery," freeing "Notifications" for the settings category that actually controls notification behavior and matching the meaning the word already has everywhere else in the app. | S |
| F-11-5 | `src/app/(app)/admin/settings/page.tsx:45-69,142-210` | flow | costs-time | the admin.manage_settings holder(s) doing a multi-field settings pass, most acutely the one-time setup of the 23 notification-channel selects (`settings/registry.ts:288-306`) alongside the ~21 other registered settings | Every one of the roughly 44 settings on this one page (six categories, rendered by looping `listCategories()` at settings/page.tsx:127-130) is its own `<form>` with its own Save button (:156-197); there is no batch save. `updateAction` and `resetAction` both redirect to a bare `/admin/settings?saved=1` (:68,84) with no hash or anchor, so saving any single field reloads the page at the very top, and the lone "Saved." banner (:140) gives no indication of which field it refers to. An admin working through a long section (Notifications, the very last category, is 23 fields deep) has to scroll back down past every earlier category after each individual save to find their place and confirm the field they just changed actually stuck, once per field. | Give each `<section>` an `id={category}` and redirect `updateAction`/`resetAction` to `/admin/settings?saved=1#${encodeURIComponent(category)}` (the category is already in scope at both call sites via `def.category`), so a save returns the admin to the section they were editing instead of the top of the page. | S |

## Needs its own brainstorm

None. Every finding above is S effort (a link, a button label plus a link, a nav-array entry, a
rename, or an anchor/id change); none require a design pass before implementation.

## Coverage notes

- **Pure code read, no runtime verification.** No dev server or browser was used for this task,
  per its brief. Every row above is traced from source; where a finding depends on a permission
  combination or rendered state I could not observe live, that is called out inline in the row.
- **The IA lens dominated this task's budget, per the brief's instruction to weight it heavily.**
  All five filed findings are IA or IA-adjacent (a naming collision, a mislabeled cross-module
  fallback, and a settings-flow issue that only bites because the settings page is itself a flat,
  ungrouped list of everything). I read every page under `src/app/(app)/admin/` end to end looking
  specifically for dead-end reachability, mismatched groupings, and multi-page sequences with no
  connecting link, per the brief's exact prompts; the two strongest instances (Subcommittees,
  Onboarding contract) both cross a module boundary the admin nav alone cannot fix, which is why
  each finding cites the Recruitment-side file it connects to as well.
- **Checked for overlap with the pending nav IA program (stages 3-4).** Per project memory, that
  program covers dropdowns, the account menu, and the command palette mechanism itself (already
  shipped in stages 1-2, PR #465). The findings filed here are about missing entries in the admin
  module's own `nav` array and missing cross-links between specific pages in two different
  modules, not the top-nav mechanism, so I judged them in scope for this task rather than
  duplicating the pending program. Flagging for the ranking pass to confirm.
- **Did not re-file the "Copy email" clipboard finding.** Per the brief, that was already fixed in
  commit `f007277b` and verified by Task 10; not re-examined here since it lives in the Support
  module, outside this task's assigned surface.
- **Email campaign sub-components read for structure, not line-by-line.** `audience-builder.tsx`,
  `cron-presets.tsx`, `timing-actions.tsx`, `use-form-dirty.ts`, and `templates/[key]/preview.tsx`
  were not opened; `campaigns/[id]/page.tsx` and `review-actions.tsx` were read in full and show
  heavy prior iteration (a dirty-form guard remounted by `key={campaign.updatedAt}` specifically to
  fix a stale-guard bug per #14, an arm-then-confirm send flow, a typed-count confirmation above a
  threshold) with no new gaps worth filing.
- **`src/app/(app)/admin/email/oauth/callback/route.ts` and `src/app/(app)/admin/loading.tsx` not
  read.** An OAuth callback route and a loading skeleton are not navigation surfaces and outside
  this task's IA-first scope.
- **Roster and membership components read for the specific claim cited, not end to end.**
  `roster-panel.tsx` was read in full (referenced from both `terms/[id]/page.tsx` and indirectly
  `people/[id]/page.tsx` via `person-memberships-panel.tsx`, which was not opened); it shows
  careful handling of edge cases (inactive departments retaining visible members, director-shift
  guards before removal, last-admin protection) and no findings worth filing.
- **RBAC-gate edge case noted but not filed.** The admin module's manifest in `registry.ts` has no
  `additionalAccessPermissions` (unlike volunteers, recruitment, and learning, which each admit
  narrow permission-holders past the module gate for exactly this reason, per their own comments).
  This raises the theoretical possibility that a role holding only `admin.send_email_campaign` (or
  `admin.manage_email_templates`, `admin.manage_roster`, etc.) without `admin.access` would be
  blocked by `AdminLayout`'s `requireModuleAccess("admin")` before ever reaching its own page's
  permission check, which would make F-11-3's reachability problem total rather than partial for
  that person. This reads as a genuine possibility from the registry alone, but confirming it
  requires checking whether any real seeded role is actually shaped that way, which is an RBAC
  correctness question outside this task's UX scope. Left here rather than filed as a finding.
- **No application code was changed.** `git status --short` was clean before this fragment was
  written and shows only this file after.
