# HAVEN Hub whole-app UI cohesion audit, 2026-09-05

15th whole-app audit; the 5th with a UI/UX focus. Scope was cohesion of surfaces and general
UI/UX quality, not correctness. Run as a 278-agent workflow: 14 mapping agents built a surface
inventory, 10 lenses hunted drift over it, and every finding faced two opposing verifiers (a
skeptic told to refute it and a staff engineer told to reject the proposal as unbuildable).

## Numbers

| | |
|---|---|
| Surfaces inventoried | 271 across 14 slices |
| Raw findings | 126 |
| Confirmed by BOTH verifiers | 96 |
| Refuted | 30 |
| Filed but unverified (session limit) | 21 |
| Severity of confirmed | 6 high, 74 medium, 16 low |
| Effort of confirmed | 47 S, 44 M, 5 L |

The two final lenses (`data-display`, `hierarchy-density`) hit the session limit mid-verification,
so 21 of their findings are recorded below as **unverified**. They were produced by the same
finder prompt as the rest and cite file:line, but no verifier has tried to refute them. Treat
them as leads, not conclusions.

## The headline

The design system is not the problem. `Card` is imported by 116 files and `PageHeader` by 101,
so the primitives that exist are genuinely adopted. The problem is the layer above them: **there
is no agreed shape for a screen.** Everything a page does beyond drawing a card, that is filtering,
escaping, confirming, naming a status, reporting a result, is decided per page. So the app reads
as many small products sharing a paint job.

Three numbers make the case. `TabRow` is imported by 5 files while 8 more surfaces hand-roll a tab
bar. `Pagination` takes an `hrefFor` callback and 12 pages hand-write their own. `SortableTH` ships
with keyboard state and `aria-sort`, and exactly 1 of 48 tables uses it.

The most user-visible consequence is not visual. It is that **the app uses different words for the
same fact depending on who is looking.** One `OnboardingTaskState` value is rendered in five
vocabularies; a volunteer reads "Action needed" on /get-started, "Not started" on /my-info, and
their director reads a third word for the same row. `ComplianceStatus` has four label sets and one
roster prints the raw enum. That is a product defect wearing a styling costume.

## Themes

### T1. One state, many vocabularies

The same database enum is given different words, tones and severities on surfaces a member and their director read at the same time.

*7 confirmed, 4 unverified*

- **One OnboardingTaskState enum, five label vocabularies and two severities, three of them visible to one member in one session**  
  `data-display/task-state-five-vocabularies` · medium · effort M · 8 surfaces across 4 modules: /get-started, /my-info, / (dashboard), /volunteers, /volunteers/master, /volunteers/ehs, /v  
  Sites: `src/modules/onboarding/engine/status.ts:8`, `src/app/(app)/volunteers/page.tsx:59-72`, `src/app/(app)/volunteers/master/page.tsx:115-128`, `src/modules/my-info/components/clearance-card.tsx:76-88`, `src/app/get-started/onboarding-checklist.tsx:38-47` and more  
  Impact: A volunteer opens /get-started and their HIPAA step says "Action needed"; on /my-info the same step says "Not started"; their director opens /volunteers and the same row says "Incomplete" in red. The member's own dashboard calls them "Not yet cleared" in amber while the director sees "Not cleared" in red for the identical state, so the two audiences disagree on how bad it is. On /volunteers/ehs a   
  Fix: Add src/platform/clearance/display.tsx (platform, so both modules and app routes may import it) exporting `TASK_STATE_LABEL`/`TASK_STATE_TONE` as the single Record pair, a `<TaskStateBadge state actionable? />` that keeps the one genuinely audience-specific branch (checklist's actionable-vs-not "Pending") as a prop, and a `<ClearedBadge cleared />` fixing one severity for not-cleared (warning, mat

- **One OnboardingTaskState is rendered by four components in four vocabularies**  
  `duplicate-surfaces/clearance-state-four-vocabularies` · medium · effort M · Every member on four surfaces (dashboard, My Info, /get-started, /training) plus every director on two compliance roster  
  Sites: `src/modules/my-info/components/clearance-card.tsx:78`, `src/app/get-started/onboarding-checklist.tsx:37`, `src/app/(app)/page.tsx:129`, `src/app/(app)/volunteers/page.tsx:59`, `src/app/(app)/volunteers/master/page.tsx:115`  
  Impact: A member sees the same unfinished HIPAA step called "Not started" on the dashboard, "Not started" on My Info, "Action needed" on /get-started, and their director sees it as "Incomplete" on the compliance roster. Four names for one fact, and none is wrong on its own page, so nobody notices until a member asks which one is real.  
  Fix: One src/platform/ui/task-status-badge.tsx exporting TASK_STATE_LABEL, TASK_STATE_TONE and <TaskStatusBadge state actionable />, modelled on the shape src/modules/support/components/status-badge.tsx already proves works ("Short, friendly status text (never the raw enum)"). Keep get-started's actionable split as a prop on that one component rather than a separate vocabulary. Then one <ChecklistRow i

- **One OnboardingTaskState renders as four different word sets, two of them on /my-info**  
  `copy-terminology/onboarding-task-state-four-vocabularies` · medium · effort S · /get-started, /my-info, the hub dashboard status rail, and /volunteers/compliance/[personId] via ClearanceCard. Every me  
  Sites: `src/app/get-started/onboarding-checklist.tsx:39-47`, `src/modules/my-info/components/clearance-card.tsx:74-84`, `src/app/(app)/page.tsx:126-133`, `src/modules/my-info/components/ehs-panel.tsx:57-61`, `src/app/(app)/my-info/page.tsx:354` and more  
  Impact: A volunteer chasing their EHS requirement is told "Action needed" on /get-started, "Not started" in the clearance card on /my-info, and "Needed" in the EHS list a scroll below it on that same page. Three phrasings for one outstanding item read as three separate obligations, which is exactly the confusion the onboarding gate exists to remove.  
  Fix: Export one `taskStateLabel(state, opts?: { actionable?: boolean })` from `src/modules/onboarding/` returning Complete / In progress / Not started / Not required, with the single documented exception that an unactionable INCOMPLETE returns "Pending" (the reason is already written in the onboarding-checklist comment). Call it from `StatusPill` in onboarding-checklist.tsx, from `taskRequirement` in c

- **One ComplianceStatus enum gets three different word sets, two of them on the same page**  
  `copy-terminology/compliance-status-three-vocabularies` · medium · effort S · Three surfaces (/volunteers, /volunteers/master, /volunteers/compliance/[personId]) plus /my-info and /get-started/hipaa  
  Sites: `src/app/(app)/volunteers/page.tsx:31-38`, `src/app/(app)/volunteers/page.tsx:77-86`, `src/app/(app)/volunteers/master/page.tsx:79-84`, `src/modules/my-info/components/clearance-card.tsx:56-71`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:127-128` and more  
  Impact: A department director reads a chip saying "3 expiring", scans a table cell saying "Expiring Soon", clicks the person and reads "Valid" (EXPIRING_SOON is met:true in the member map). They cannot tell whether these are three states or one, so the compliance roster stops being a reliable answer to "who can work Saturday". The member reading /my-info sees "Not uploaded" and asks their director about i  
  Fix: Add `src/modules/volunteers/compliance-labels.ts` exporting one `COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string>` plus `COMPLIANCE_STATUS_TONE`, sentence case throughout, one word per state: Compliant / Expiring soon / Expired / Needs verification / Needs completion date / No certificate. Import it in `volunteers/page.tsx` (both the STATUS_LABEL map and the CountChip labels; chips render

- **ComplianceStatus is labelled four different ways and printed raw on one roster, with a comment claiming the maps are shared** `[unverified]`  
  `data-display/compliance-status-four-vocabularies` · - · effort S · 4 surfaces: /volunteers, /volunteers/master, /my-info + /volunteers/compliance/[personId] (ClearanceCard), /recruitment/  
  Sites: `src/platform/compliance/rules.ts:41`, `src/app/(app)/volunteers/master/page.tsx:74-96`, `src/app/(app)/volunteers/page.tsx:31-49`, `src/modules/my-info/components/clearance-card.tsx:57-73`, `src/app/(app)/recruitment/cycles/[id]/training/page.tsx:60`  
  Impact: A member reads "Awaiting verification" on /my-info, emails their director, who is looking at "Needs verification" on /volunteers, while the recruitment lead running the training roster sees `PENDING_VERIFICATION`. Three names plus a database identifier for one state, in a conversation between three people about the same certificate. The Title Case labels also make the compliance roster the only pl  
  Fix: Add `COMPLIANCE_STATUS_LABEL` / `COMPLIANCE_STATUS_TONE` and a `<ComplianceStatusBadge status />` next to the rules that produce the enum (src/platform/compliance/display.tsx, importing only Badge). Pick one sentence-case vocabulary: Compliant / Expiring soon / Expired / Needs verification / Date unknown / No certificate. Delete both duplicated Records, have clearance-card's certRequirement pull `

- **The recruitment Decision enum has three private label maps and two tone maps while its own engine already returns a label and tone** `[unverified]`  
  `data-display/decision-enum-no-shared-badge` · - · effort S · 4 surfaces: /recruitment/cycles/[id]/applicants (roster), /recruitment/cycles/[id]/applicants/[applicationId], /recruitm  
  Sites: `src/modules/recruitment/engine/decision-summary.ts:1`, `src/modules/recruitment/engine/decision-summary.ts:19-32`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:28-29`, `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:35`, `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:15-23`  
  Impact: A pending interview reads as a neutral grey chip on the interview detail page and an amber warning chip on the cycle interview list, so a lead scanning the list sees rows demanding attention that the detail page says are fine. Renaming "Waitlisted" is a three-file edit that will get missed in one.  
  Fix: Add `DECISION_LABEL` / `DECISION_TONE` and `<DecisionBadge decision />` to src/modules/recruitment/engine/decision-summary.ts (or a components/decision-badge.tsx beside it), have `rosterDecision` build its non-acceptance labels from that map so the roster and the per-interview view cannot drift, and delete the three local copies. Fix PENDING to one tone.

- **Director vs Volunteer is drawn five ways, and two sub-views of the same builder page disagree on its colour** `[unverified]`  
  `data-display/membership-kind-five-shapes` · - · effort S · 8 sites across schedule, volunteers and admin: /schedule/builder (both sub-views), /volunteers, /volunteers/directory, /  
  Sites: `src/modules/schedule/components/builder-day-view.tsx:189-191`, `src/modules/schedule/components/builder-availability-view.tsx:91`, `src/app/(app)/volunteers/page.tsx:249-251`, `src/modules/admin/components/person-memberships-panel.tsx:163`, `src/modules/admin/components/roster-panel.tsx:74-75` and more  
  Impact: A director toggles /schedule/builder from Day view to Availability view to see who is free, and every Director chip loses its brand colour, which reads as though the roster changed. Someone scanning the directory for a department's directors gets a grey parenthetical in one column and a coloured chip on the next page. The dashboard tells a member they are a "Shift director" for a shift the schedul  
  Fix: Export `<MembershipKindBadge kind />` from src/platform/ui (or src/modules/schedule/components if the Shadow role must ride along as `<ShiftRoleBadge role />` covering DIRECTOR/VOLUNTEER/SHADOW, which schedule/page.tsx:436 already tones brand/default/warning). One tone pair, one label pair. Replace the six Badge sites; for the two parenthetical sites in directory and the compliance profile, render

- **Six surfaces ship the raw database enum as user-facing status text, against a convention the support module already wrote down** `[unverified]`  
  `data-display/raw-enums-as-ui-text` · - · effort S · 6 surfaces, 3 modules: /recruitment, /recruitment/cycles/[id], /recruitment/cycles/[id]/training, /admin/email, /admin/n  
  Sites: `src/app/(app)/recruitment/page.tsx:73`, `src/app/(app)/recruitment/page.tsx:115`, `src/app/(app)/recruitment/cycles/[id]/page.tsx:150`, `src/app/(app)/admin/email/page.tsx:495`, `src/app/(app)/admin/notifications/page.tsx:279` and more  
  Impact: A director's first screen in Recruitment says the cycle is "OPEN" in shouting caps, and "FALLBACK" in the admin notification log tells an admin nothing about what actually happened (delivered by email instead of Teams). Board attendance renders as lowercase "present", the only lowercase status chip in the product. Anyone reading these has to learn the schema to read the screen.  
  Fix: Give each enum the shape support already has: a label Record plus a one-line badge component exported beside the service that owns it. `RecruitmentStatusBadge` in src/modules/recruitment/components/ (Draft / Open / Closed / Archived) replaces both statusTone copies and the three `{c.status}` bodies. `DeliveryStatusBadge` in src/platform/email (Queued / Sent / Failed / Sent by email / Logged) is sh

- **Recruitment prints raw DB enums in Badges and keeps three copies of the decision map**  
  `duplicate-surfaces/recruitment-status-badges-raw-enums` · medium · effort S · Every recruitment director, reviewer and panelist; six surfaces across the module.  
  Sites: `src/app/(app)/recruitment/page.tsx:11`, `src/app/(app)/recruitment/cycles/[id]/page.tsx:30`, `src/app/(app)/recruitment/page.tsx:73`, `src/app/(app)/recruitment/cycles/[id]/page.tsx:150`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:28` and more  
  Impact: The recruitment module landing page, the first thing a director sees on entering the module, labels cycles with shouty database constants while every other list in the app uses sentence case. And the same interview decision can carry different tones on the applicant page, the cycle interview list and the interview detail, because three files own three tables.  
  Fix: Two components in src/modules/recruitment/components/, both built like SupportStatusBadge: <CycleStatusBadge status /> exporting CYCLE_STATUS_LABELS (Draft / Open / Closed / Archived) with its tone map, and <DecisionBadge decision /> exporting DECISION_LABELS beside the Decision type that already lives in src/modules/recruitment/engine/decision-summary.ts. Delete the five local maps and the two ra

- **Clinical capability badges: the hardened primitive runs on one page, three surfaces hand-roll a weaker copy**  
  `data-display/capability-badges-four-renderings` · medium · effort M · 4 surfaces: /schedule/full, /schedule/builder (day view), /admin/people, /volunteers/compliance/[personId]. Roles: shift  
  Sites: `src/modules/schedule/components/capability-badges.tsx:66-100`, `src/app/(app)/schedule/full/page.tsx:268`, `src/modules/schedule/components/builder-day-view.tsx:156-166`, `src/modules/admin/components/people-table.tsx:66-71`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:252-270`  
  Impact: On /schedule/builder a director picks who interprets for a Spanish-speaking patient. That is the exact surface where CapabilityBadges' warning tone ("assessed 3, below this department's bar of 4") would change the decision, and it is the one surface that shows a flat grey ES chip with no score. Screen-reader users on three of four surfaces hear "E S" spelled out with no indication it means a verif  
  Fix: Move capability-badges.tsx to src/platform/ui/capability-badges.tsx (it already imports only Badge and @/platform/languages/catalog, both platform) and make `department` optional as it already is. Replace builder-day-view.tsx's local flagBadges, people-table.tsx's inline span, and the compliance profile's Clinical-flags block with <CapabilityBadges person={...} department={...} />. Feed spanishSco

- **Eleven different strings mean "there is no value here", including two for one interview field**  
  `copy-terminology/absent-value-markers` · low · effort M · Schedule attending grids and coverage viewer, recruitment interviews and signed contracts, outreach identities, admin as  
  Sites: `src/platform/dates/format.ts:15`, `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:80`, `src/app/(app)/recruitment/interviews/page.tsx:42`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:142`, `src/modules/schedule/components/attending-coverage-view.tsx:110` and more  
  Impact: A Faculty Relations lead reading the attending grid sees an em-dash in one column and "Not set" in the next for the same fact, and cannot tell whether one of them means "deliberately blank". A panelist checking when their interview is gets "TBD" on the list and "To be determined" on the detail, which reads like two different scheduling states.  
  Fix: Standardise on two markers and document them in docs/ui-house-style.md section 2. In a table cell or grid where absence is expected and not actionable, use the plain `"-"` that `src/platform/dates/format.ts` already defaults to, and replace every `&mdash;` in `attending-coverage-view.tsx` and `attending-cell.tsx` with it. In a label/value row where absence is actionable, use "Not set". Collapse "N


### T2. Missing primitives, so every surface invents one

A pattern with no primitive gets rebuilt per page, and the copies drift apart and lose accessibility on the way.

*14 confirmed*

- **NavForm ships the behaviour but no layout, so 11 filter bars each invent their own row**  
  `primitives/filter-bar-primitive` · high · effort L · 11 filter bars plus 4 toolbars across admin, volunteers, incidents, recruitment, support and schedule. Touches every rol  
  Sites: `src/platform/ui/nav-form.tsx:15`, `src/app/(app)/admin/people/page.tsx:98`, `src/app/(app)/admin/audit/page.tsx:47`, `src/app/(app)/admin/email/page.tsx:421`, `src/app/(app)/admin/notifications/page.tsx:205` and more  
  Impact: A compliance manager who learns the filter row on /volunteers/master then opens /admin/people finds the labels gone, the button relabelled Search, the primary button turned into an outline button, and no way to clear filters. On /support/all , the busiest triage queue in the clinic , changing a Status filter leaves the previous results rendered as though current while the server re-queries, becaus  
  Fix: Add `src/platform/ui/filter-bar.tsx` exporting `FilterBar({ action, children, submitLabel = "Filter", clearHref, count })` (wraps NavForm, owns `flex flex-wrap items-end gap-3`, renders the primary submit, the conditional Clear link and the trailing count span) and `FilterField({ label, width = "md", children })` (owns the `w-*` wrapper and always renders a visible Field label , width is a token, 

- **Twelve list pages each hand-build the same filter row; there is no FilterBar primitive**  
  `list-surfaces/filter-bar-built-twelve-times` · medium · effort L · 12 list surfaces across admin, volunteers, incidents, support, recruitment and learning; every staff role that filters a  
  Sites: `src/app/(app)/admin/people/page.tsx:98`, `src/app/(app)/admin/audit/page.tsx:47`, `src/app/(app)/admin/email/page.tsx:421`, `src/app/(app)/admin/notifications/page.tsx:~230`, `src/app/(app)/volunteers/master/page.tsx:337` and more  
  Impact: A director who learns the filter row on /volunteers/master and then opens /admin/people finds the Clear button gone, the labels gone, and the button renamed from Filter to Search sitting in a different colour. Clearing filters on eight of these twelve pages means hand-editing the URL or navigating away and back.  
  Fix: Add `src/platform/ui/filter-bar.tsx` exporting `<FilterBar action clearHref? resultCount?>` (wraps NavForm, owns the `flex flex-wrap items-end gap-3` row, renders a `Filter` primary submit, and renders the Clear link automatically whenever `clearHref` is passed and any field is set) plus `<FilterField label width="sm"|"md"|"lg">` for a labelled control slot with fixed width tokens. Migrate the 12 

- **No TextLink primitive: 41 inline links in 14 recipes, three on a brand token that never lifts in dark mode**  
  `primitives/text-link-primitive` · high · effort M · 41 links across recruitment, volunteers, admin, schedule and the public contract renderer. The dark-mode failures hit an  
  Sites: `src/app/(app)/recruitment/events/page.tsx:106`, `src/app/(app)/recruitment/events/[id]/check-in/page.tsx:72`, `src/modules/recruitment/contract/prose.tsx:183`, `src/app/globals.css:231`, `src/app/(app)/volunteers/directory/page.tsx:202` and more  
  Impact: In dark mode the 'Check in' action on /recruitment/events is close to invisible against the dark surface, and so is the only back link out of the check-in kiosk and every link inside an onboarding contract's prose , the last of which is a document people are agreeing to. Everywhere else links look different page to page: underlined on the volunteers directory, not underlined on board meetings, one  
  Fix: Add `src/platform/ui/text-link.tsx` exporting `TextLink({ href, size = "inherit", external, children })` , one recipe (`text-brand-fg underline underline-offset-2 hover:text-brand-hover` plus the house-style focus ring `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`), rendering next/link internally and an `<a target="_blank" rel="noopener noreferrer">` with the

- **Radio ships a `label` prop, Checkbox does not, so 58 checkbox rows are hand-built in 23 class strings**  
  `primitives/checkbox-has-no-label-prop` · high · effort M · 58 rows across admin, volunteers, incidents, learning, recruitment, schedule and the public /onboard contract. Every for  
  Sites: `src/platform/ui/checkbox.tsx:8`, `src/platform/ui/radio.tsx:14`, `src/modules/admin/components/person-form.tsx:106`, `src/modules/admin/components/person-form.tsx:122`, `src/modules/admin/components/department-form.tsx:138` and more  
  Impact: Checkbox rows sit at three different type weights and two different ink tokens across settings screens a director moves through in one session (/admin/people/[id], /admin/departments/[id], /volunteers/ehs/manage/[trainingId]). Screen-reader users get no explanatory text for any checkbox whose meaning is carried by a hint paragraph, including the Epic-access and committee-scoring switches on depart  
  Fix: Add `label?: ReactNode` and `hint?: ReactNode` to Checkbox in src/platform/ui/checkbox.tsx, mirroring Radio exactly: wrap in `<label className="flex items-start gap-2 text-sm text-foreground-soft">`, render the hint as a `<span className="mt-0.5 block text-xs text-subtle-foreground">` inside the label with an id threaded to `aria-describedby` (same derive-from-label trick Field uses at input.tsx:5

- **55 hand-rolled checkbox rows: no group name, no minimum row height, two force multi-column at phone width**  
  `a11y-responsive/checkbox-groups-unnamed-untappable` · medium · effort M · 55 call sites across admin, volunteers, learning, recruitment, incidents, outreach, support and the public onboarding co  
  Sites: `src/platform/ui/checkbox.tsx:8`, `src/platform/ui/radio.tsx:40`, `src/modules/admin/components/delegation-editor.tsx:37`, `src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx:78`, `src/app/(app)/learning/manage/[courseId]/page.tsx:105` and more  
  Impact: A screen-reader user tabbing into the EHS department scope hears 'Emergency, checkbox, not checked' with nothing saying these 20 checkboxes are one question about department scope; the RadioGroup on the apply portal announces as an unnamed radio group. On a phone the department picker in /volunteers/ehs/manage/[trainingId] and the copy-roster picker in /admin/terms/[id] squeeze two and three colum  
  Fix: Give Checkbox the `label` prop Radio already has, with `min-h-[44px]` baked into the row, and add a `CheckboxGroup` beside RadioGroup that renders a real `<fieldset><legend>` (the shape FormSection already ships at src/platform/ui/form.tsx) or avs-tool's `role="group" + aria-labelledby` pair. Fix RadioGroup at radio.tsx:40 in the same change: give the legend span a useId and point `aria-labelledby

- **No detail-row primitive: 37 dt/dd pairs across 16 layouts, 4 label styles and 15 value styles**  
  `primitives/description-list-primitive` · medium · effort M · Every detail page in the app , incidents, recruitment applicants and contracts, interviews, compliance profiles, admin s  
  Sites: `src/app/(app)/incidents/[id]/page.tsx:223`, `src/app/(app)/incidents/[id]/page.tsx:225`, `src/app/(app)/incidents/strikes/strike-row.tsx:144`, `src/app/(app)/incidents/strikes/strike-row.tsx:146`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:68` and more  
  Impact: An incident reviewer reads report #42 where the field name is small grey and the value is dark, then expands the linked strike row where the field name is dark bold and the value is grey , the visual hierarchy inverts between two views of the same case. Absent values are rendered five ways ('Not set', an italic 'Not provided', a bare em-space, nothing at all), so a director cannot tell a missing p  
  Fix: Add `src/platform/ui/description-list.tsx` exporting `DescriptionList({ columns = 2, children })` (owns the `grid gap-3 sm:grid-cols-N` and the `divide-y` stacked variant) and `DetailRow({ label, value, empty = "Not set" })` (owns `<dt className="text-xs text-subtle-foreground">` over `<dd className="mt-0.5 text-sm text-foreground">` and the empty fallback, lifted verbatim from the InfoRow at volu

- **No Popover primitive: five copies of trigger+panel, two materials and three anchor offsets in one 56px toolbar**  
  `primitives/popover-primitive` · medium · effort M · Every authenticated page (the three toolbar popovers) plus the recruitment form builder and the outreach audience builde  
  Sites: `src/platform/ui/global-nav.tsx:175`, `src/platform/ui/global-nav.tsx:248`, `src/platform/ui/account-menu.tsx:35`, `src/platform/ui/account-menu.tsx:72`, `src/platform/ui/notification-bell.tsx:60` and more  
  Impact: The three toolbar menus a member uses every day hang at different heights and are made of different material , the modules dropdown is opaque, the bell and account menus are glass , so the toolbar reads as three unrelated widgets. Any future fix to outside-click or focus restoration has to be applied in five files, and prior audits have already caught one of the copies (type-picker) forgetting foc  
  Fix: Add `src/platform/ui/popover.tsx` exporting `usePopover()` (returns `{ open, setOpen, rootRef, triggerRef }` and owns the pointerdown-outside close, the Escape-plus-focus-restore, and `aria-expanded`/`aria-haspopup` props for the trigger) plus `PopoverPanel({ align = "end", children, className })` owning the one canonical panel surface (glass-panel, rounded-xl, one z-index, one offset). Migrate gl

- **Five clipboard implementations, three feedback shapes, and the one guarding a show-once invite link lies about success**  
  `primitives/copy-button-primitive` · medium · effort S · Five surfaces: recruitment invites, personal calendar subscription (rendered on both /schedule and /my-info), clinic ema  
  Sites: `src/app/(app)/recruitment/cycles/[id]/invite-panel.tsx:77`, `src/modules/schedule/calendar/feed-url-field.tsx:35`, `src/platform/ui/email-list.tsx:67`, `src/modules/support/components/epic-request-form.tsx:158`, `src/modules/support/components/term-batch-tab.tsx:146`  
  Impact: A recruitment manager issues a single-use applicant invite link on /recruitment/cycles/[id], clicks Copy, reads 'Copied', navigates away , and if the clipboard write was refused (a non-secure context, a permissions prompt, a locked-down browser) the link is gone for good, because the panel states it is never shown again. On /my-info a volunteer clicking Copy on their calendar feed URL sees nothing  
  Fix: Add `src/platform/ui/copy-button.tsx` exporting `CopyButton({ value, label = "Copy", size = "sm", variant = "outline" })`: awaits the write inside try/catch, drives a three-state `idle|copied|error` machine, renders the label swap on the Button itself and an `aria-live="polite"` sr-only status carrying the two canonical sentences already agreed on in epic-request-form.tsx:487-490. Migrate invite-p

- **Three independent bulk-select implementations; only one has an indeterminate header or shift-range**  
  `primitives/bulk-selection-primitive` · medium · effort M · Three bulk surfaces: the offboarding transition and flagged tabs (department directors and offboarding executors) and th  
  Sites: `src/modules/recruitment/components/onboarding-table.tsx:55`, `src/modules/recruitment/components/onboarding-table.tsx:78`, `src/modules/recruitment/components/onboarding-table.tsx:89`, `src/modules/volunteers/components/transition-tab.tsx:55`, `src/modules/volunteers/components/transition-tab.tsx:82` and more  
  Impact: An executor offboarding a cohort on /volunteers/offboarding cannot shift-click a range and cannot tell from the header checkbox whether a partial selection exists; a recruitment lead one module over gets both on the onboarding table. Selecting twenty people to offboard is twenty individual clicks on the tab where the stakes are highest.  
  Fix: Extract `src/platform/ui/use-bulk-selection.ts` exporting `useBulkSelection<T>({ rows, idOf, selectable, initial })` returning `{ selectedIds, isSelected, toggle(id, shiftKey), toggleAll, allSelected, headerRef, clear }` , lift the implementation from onboarding-table.tsx:55-114 verbatim, since it is the superset (visible-scope reconciliation, indeterminate ref, shift anchor). Pair it with `BulkSe

- **Bulk row selection is implemented five times, twice with the explanatory comment copied verbatim**  
  `list-surfaces/bulk-select-five-independent-copies` · medium · effort M · 5 bulk surfaces across volunteers offboarding, recruitment onboarding and the Epic tools; department directors, recruitm  
  Sites: `src/modules/volunteers/components/transition-tab.tsx:76`, `src/modules/volunteers/components/flagged-tab.tsx:66`, `src/modules/recruitment/components/onboarding-table.tsx:125`, `src/modules/support/components/epic-request-tabs.tsx:673`, `src/modules/support/components/term-batch-tab.tsx:51`  
  Impact: On /volunteers/offboarding a director can select-all a bucket and sees an indeterminate header checkbox; switching to the Flagged tab of the same page they get a different select-all with a different reconciliation rule; on /support/epic?tab=pending, where they are opening a real YNHH ticket, there is no select-all and no count of what is selected, so they check boxes and submit blind.  
  Fix: Extract `useRowSelection<T>({ rows, id, selectable })` into src/platform/ui returning `{ selectedIds, toggle(id, shiftKey), toggleAll, allSelected, headerProps }` with the indeterminate ref, the shift-click anchor and the visible-scope reconciliation from onboarding-table (the most complete copy), plus a `<SelectionFooter count onClear>` for the `N selected` + Clear row. Migrate all five; the two 

- **One empty-state string is copy-pasted 13 times verbatim because there is no card-wrapped EmptyState recipe**  
  `primitives/card-wrapped-empty-state` · medium · effort S · 13 card empties across schedule attendings, coverage, board meetings, language review, admin people and support requests  
  Sites: `src/platform/ui/empty-state.tsx:28`, `src/platform/ui/empty-state.tsx:73`, `src/app/(app)/schedule/attendings/credentialing/page.tsx:122`, `src/app/(app)/schedule/attendings/credentialing/page.tsx:209`, `src/app/(app)/schedule/attendings/credentialing/page.tsx:262` and more  
  Impact: A Faculty Relations coordinator sees three different empty panels on /schedule/attendings/credentialing rendered as flat grey sentences with no title/detail hierarchy, then hits an EmptyState elsewhere in the same module with a bold title, an icon and a next step. The thirteen never say what would make rows appear, which docs/ui-house-style.md asks for.  
  Fix: Two small additions, both inside existing primitives. (1) Give EmptyState a `card?: boolean` prop that wraps the block variant in `cardClasses({ pad: false })` , it composes rather than fights, so there is no override problem , and migrate all thirteen sites plus spanish-review's local EmptyCard, splitting each one-line sentence into `title` + `description`. (2) Add `TableEmpty({ colSpan, children

- **SectionHeader ships two levels but the app needs three, so 21 headings are hand-rolled and 9 are byte-identical to a level that exists**  
  `primitives/section-header-missing-level` · medium · effort S · 21 headings across the whole outreach module and the four densest admin panels (roles, term roster, person memberships,   
  Sites: `src/platform/ui/section-header.tsx:6`, `src/app/(app)/outreach/campaigns/[id]/page.tsx:226`, `src/app/(app)/outreach/campaigns/[id]/page.tsx:253`, `src/app/(app)/outreach/campaigns/[id]/page.tsx:338`, `src/app/(app)/outreach/identities/page.tsx:268` and more  
  Impact: On /admin/roles the section heading 'Roles' is one size and 'Create new role' one line below it is another, with two different greys used for headings of equal rank in the same panel. Across the outreach module every heading is hand-written, so campaign, scope and identity screens are one repaint away from drifting from the rest of the app.  
  Fix: Add a third level to src/platform/ui/section-header.tsx: `card: "text-sm font-semibold text-foreground-soft"` (the 8-site majority token), keeping eyebrow and title as they are. Then migrate: the nine outreach `<h2 className="text-base font-semibold text-foreground">` to `<SectionHeader level="title">`, and the eleven `text-sm font-semibold` headings in admin (assignment-form.tsx:292/369/400, pers

- **Field has no error slot, so four field-error conventions exist and the public contract form announces none of them**  
  `primitives/field-has-no-error-slot` · medium · effort M · Every validated form in the app, including the two highest-stakes unauthenticated ones (/apply/[slug] and /onboard/[toke  
  Sites: `src/platform/ui/input.tsx:34`, `src/app/onboard/[token]/contract-field.tsx:93`, `src/app/onboard/[token]/contract-field.tsx:177`, `src/app/onboard/[token]/contract-field.tsx:202`, `src/app/onboard/[token]/contract-field.tsx:255` and more  
  Impact: A newly accepted volunteer submitting the onboarding contract at /onboard/[token] with a bad HIPAA date or a missing Epic ID gets errors that are never announced , the page just re-renders and nothing speaks. The identical form rendered through FieldPreview in the /apply wizard does announce them, so the same person gets different behaviour in the two halves of the same recruitment flow.  
  Fix: Add `error?: ReactNode` to Field in src/platform/ui/input.tsx: when set, render `<p id={errorId} role="alert" className="text-xs text-critical-foreground">` in place of the bottom hint, and extend the existing cloneElement block (:58-65) to add `aria-invalid` and thread errorId into aria-describedby the same way hintId already is. Migrate contract-field.tsx's eight paragraphs and its local errorId

- **Six hand-rolled segmented controls, none of them TabRow's segmented variant, and one paints with an undefined token**  
  `primitives/segmented-control-six-copies` · medium · effort M · Six surfaces across schedule, admin, outreach and volunteers. Schedule builders and Faculty Relations hit two of them pe  
  Sites: `src/platform/ui/tab-row.tsx:66`, `src/modules/schedule/components/builder-toolbar.tsx:118`, `src/modules/schedule/components/attending-toolbar.tsx:98`, `src/app/(app)/schedule/builder/page.tsx:589`, `src/app/(app)/admin/contract/page.tsx:41` and more  
  Impact: A director moving between /schedule/builder and /schedule/attendings sees two identical-looking view switchers, then on /schedule/builder a second switcher two inches away where 'selected' is amber instead of navy. A language reviewer on /volunteers/spanish-review cannot see how many people are in the queue at all: the count chip paints transparent because its colour tokens do not exist.  
  Fix: Migrate the four Link-based rows to `<TabRow variant="segmented" label=... items=... isActive=... />` (builder-toolbar.tsx:118, attending-toolbar.tsx:98, schedule/builder/page.tsx:589, admin/contract/page.tsx:41), which also removes the divergent Shadow and brand/10 active styles. Convert spanish-review's TabLink (page.tsx:612) to `TabRow` with `items[].badge`, deleting the undefined-token chip at


### T3. Primitives that exist but are bypassed

The shared component already solves the problem, including bugs it documents fixing, and the hand-rolled copy reintroduces them.

*13 confirmed, 1 unverified*

- **ConfirmButton's arm/confirm logic is rebuilt four times, twice reintroducing bugs it documents fixing**  
  `feedback/confirm-arm-state-reimplemented-four-ways` · high · effort M · 4 surfaces: outreach campaign send (outreach admins), AVS handout reset (every clinic volunteer on shift), contract buil  
  Sites: `src/platform/ui/confirm-button.tsx:20-49`, `src/app/(app)/outreach/campaigns/[id]/review-actions.tsx:82-104`, `src/modules/clinic/avs/avs-tool.tsx:51-63`, `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:133-139`, `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:243-251` and more  
  Impact: A keyboard or screen-reader user cannot complete the campaign live send: pressing "Send now" swaps in a different element, focus lands on <body>, and there is nothing to activate. In the AVS tool a clinician reading the "Clear everything?" prompt with a screen reader is disarmed after three seconds, so the reset is unreachable to them and a hurried second click three seconds later re-arms instead   
  Fix: Extract ConfirmButton's state machine into `useArmedConfirm()` in src/platform/ui/confirm-button.tsx, exporting `{armed, label, buttonProps}` with the single-element, aria-live, blur-disarm, no-timer contract already proven there, and re-implement ConfirmButton on top of it. Then: review-actions.tsx swaps to plain `<ConfirmButton label="Send now" confirmLabel="Confirm send , this cannot be undone"

- **Five hand-rolled arm/confirm controls re-introduce the two accessibility bugs ConfirmButton was built to fix**  
  `primitives/confirm-button-bypassed` · high · effort M · Five destructive controls: campaign send (outreach managers), shift unassign (every department director), AVS reset (cli  
  Sites: `src/platform/ui/confirm-button.tsx:16`, `src/app/(app)/outreach/campaigns/[id]/review-actions.tsx:83`, `src/modules/clinic/avs/avs-tool.tsx:36`, `src/modules/schedule/components/builder-cell.tsx:78`, `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:133` and more  
  Impact: A screen-reader or keyboard user cannot complete these confirmations. On /outreach/campaigns/[id]?tab=review, pressing Send now unmounts the focused button and drops focus to <body>; the user must Tab back through the page to find Confirm send, with no spinner or aria-busy telling them the send is running. On /schedule/builder, a director reading slowly finds the Remove? cell silently disarmed aft  
  Fix: Replace all five with `<ConfirmButton label=... confirmLabel=... />` inside their existing forms. review-actions.tsx:83 becomes `<ConfirmButton label="Send now" confirmLabel="Confirm send to N recipients" disabled={dirty} />` (it already sits in a `<form>`, so useFormStatus works and the standalone `armed && <Alert>` at :100 goes away). For avs-tool.tsx:36 and builder-cell.tsx:78, which are not fo

- **Three hand-rolled arm-then-confirm buttons reintroduce the two defects ConfirmButton documents fixing**  
  `a11y-responsive/arm-confirm-reinvented` · medium · effort M · 3 surfaces, 3 roles: outreach senders (irreversible mass email), clinic volunteers on the AVS tool, recruitment director  
  Sites: `src/platform/ui/confirm-button.tsx:22`, `src/platform/ui/confirm-button.tsx:35`, `src/app/(app)/outreach/campaigns/[id]/review-actions.tsx:83`, `src/modules/clinic/avs/avs-tool.tsx:52`, `src/modules/clinic/avs/avs-tool.tsx:117` and more  
  Impact: A keyboard or screen-reader user cannot complete the outreach live send: pressing 'Send now' unmounts the focused button and drops focus to <body>, so 'Confirm send' is never reachable from where they are. On /clinic/avs, a screen-reader user who arms 'Clear / New summary' has the confirm step expire under them after 3 seconds, the exact failure audit 14 removed from every destructive control in t  
  Fix: Delete all three and use ConfirmButton (49 consumer files already do). review-actions.tsx and contract-editor.tsx already sit inside a <form>, which is ConfirmButton's only requirement; avs-tool's reset is not a form submit, so give ConfirmButton an optional `onConfirm` callback for non-form use (it already owns the click branch at confirm-button.tsx:90-99, so this is a prop, not a rewrite) rather

- **The two tab rows that skip TabRow both break their semantics, in different ways**  
  `a11y-responsive/hand-rolled-tabrows-broken-semantics` · medium · effort S · 2 surfaces: the language-review queue (volunteers.verify_spanish holders) and the master onboarding contract (admins). S  
  Sites: `src/app/(app)/volunteers/spanish-review/page.tsx:245`, `src/app/(app)/volunteers/spanish-review/page.tsx:612`, `src/app/(app)/admin/contract/page.tsx:37`, `src/app/(app)/admin/contract/page.tsx:44`, `src/platform/ui/tab-row.tsx:68` and more  
  Impact: On /volunteers/spanish-review a screen-reader user gets an unnamed navigation landmark alongside the module's named one, and no announcement of which of Queue / History / Crosscheck is current. On /admin/contract the row announces as 'tab, selected, 1 of 2' and sets the expectation that arrow keys move between tabs and that a panel updates in place; arrow keys do nothing and activating a tab is a   
  Fix: Both are `TabRow variant="segmented"` verbatim. spanish-review already drives tabs off `?tab=`, which is exactly the isActive shape epic-request-tabs.tsx uses, and TabRow's `badge` prop (tab-row.tsx:88-92) replaces its local count chip, which is a bonus since that chip is painted with `bg-primary` / `text-primary-foreground`, tokens that exist nowhere in src/app/globals.css. admin/contract's two l

- **Two tab bars bypass TabRow; one drops aria-current and paints its count badge with tokens that do not exist**  
  `nav-ia/hand-rolled-tab-bars` · medium · effort S · Two module pages: the language-verification queue (interpreting reviewers) and the master onboarding-contract editor (se  
  Sites: `src/app/(app)/volunteers/spanish-review/page.tsx:245`, `src/app/(app)/volunteers/spanish-review/page.tsx:612`, `src/app/(app)/volunteers/spanish-review/page.tsx:636`, `src/app/(app)/admin/contract/page.tsx:37`, `src/platform/ui/tab-row.tsx:100` and more  
  Impact: Two of the app's tab rows look and behave unlike the other six. On /volunteers/spanish-review the active tab is underlined in near-black rather than brand, the pending-review count is an unstyled number because its colors resolve to nothing, and a screen-reader user is never told which tab is current. On /admin/contract the tabs are role="tab" links inside a tablist with no tabpanel, which is a wo  
  Fix: Replace both with TabRow, which needs no new primitive work. spanish-review: build `const items: TabItem[] = [{ label: "Review queue", href: tabHref("queue"), badge: queueRows.length }, { label: "Assessment history", href: tabHref("history") }, { label: "Flag cross-check", href: tabHref("crosscheck") }]` and render `<TabRow variant="underline" label="Language review sections" items={items} isActiv

- **Schedule builds the same "pick a view" control three times, none of them TabRow's segmented variant**  
  `nav-ia/five-row-of-links-visuals` · medium · effort M · /schedule/builder and /schedule/attendings, the two tools department directors and Faculty Relations spend the most time  
  Sites: `src/modules/schedule/components/builder-toolbar.tsx:118`, `src/modules/schedule/components/attending-toolbar.tsx:97`, `src/app/(app)/schedule/builder/page.tsx:589`, `src/platform/ui/tab-row.tsx:66`, `src/platform/ui/term-switcher.tsx:22` and more  
  Impact: A director on /schedule/builder sees a brand-filled segmented control for the view, a brand-outlined chip row for the term, and an underlined tab row for the module , three answers to "this is a row of choices, one is current" stacked on one screen. Moving to /schedule/attendings they get a fourth copy of the first shape, and /recruitment/cycles uses the muted-tray segmented pills instead. Nothing  
  Fix: Route all three through TabRow's existing segmented variant, which already renders Links with aria-current and needs only `items` + `isActive` , the same call shape cycle-nav-tabs.tsx already uses. In builder-toolbar.tsx and attending-toolbar.tsx replace the hand-built nav with `<TabRow variant="segmented" label="View" items={VIEW_LABELS.map(({ value, label }) => ({ label, href: builderViewHref(ba

- **SortableTH ships with sorting, keyboard state and aria-sort, and exactly one of 48 tables uses it**  
  `list-surfaces/sort-exists-on-exactly-one-list` · medium · effort M · 4 lists that every admin, compliance manager and IT manager works daily; ~48 Table consumers set the precedent.  
  Sites: `src/platform/ui/table.tsx:68`, `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:175`, `src/app/(app)/admin/people/page.tsx:123`, `src/app/(app)/volunteers/master/page.tsx:400`, `src/app/(app)/support/all/page.tsx:96` and more  
  Impact: A compliance manager scanning /volunteers/master for who expires soonest cannot sort by Expires; they page through 25 rows at a time in whatever order the service returned. An IT manager cannot sort /support/all by Updated or Status even though the primitive that would do it is already in the file's import line.  
  Fix: Adopt SortableTH on the four high-traffic lists (admin/people, volunteers/master, support/all, admin/audit) using the applicants roster as the exact template: a `parseSort`/`nextSortDirection` pair per module and a `sortHref` that reuses the FilterBar params object from the pagination finding above. No new primitive is required, only the shape that already exists being applied four more times.

- **Pagination takes an hrefFor callback, so twelve pages re-serialize their own filter params by hand**  
  `list-surfaces/pagination-hreffor-hand-written-twelve-times` · low · effort M · All 13 paginated lists; every staff role that pages a filtered roster.  
  Sites: `src/app/(app)/admin/people/page.tsx:70`, `src/app/(app)/admin/audit/page.tsx:31`, `src/app/(app)/admin/email/page.tsx:153`, `src/app/(app)/admin/notifications/page.tsx:110`, `src/app/(app)/volunteers/master/page.tsx:285` and more  
  Impact: Paginating past page 1 on a filtered list can silently lose a filter, so a manager sees a different (wider) result set on page 2 than on page 1 without any indication that anything changed. It is a class of bug the shape guarantees will recur every time a filter is added.  
  Fix: Change Pagination to accept `basePath: string` plus `params: Record<string, string | undefined>` and build the href itself (keeping `hrefFor` as an optional escape hatch for the two non-search-param cases). Pair it with the FilterBar primitive so the filter row and the pager read one `params` object owned by the server page; for /support/all that means RequestFilters receives the same object as pr

- **A local function named Pagination shadows the primitive with different labels, format and no dim**  
  `list-surfaces/spanish-review-shadows-pagination` · low · effort S · 1 tab today, but it is the precedent for shadowing the primitive; language reviewers.  
  Sites: `src/app/(app)/volunteers/spanish-review/page.tsx:735`, `src/platform/ui/pagination.tsx:6`, `src/app/(app)/volunteers/master/page.tsx:527`, `src/app/(app)/admin/audit/page.tsx:77`  
  Impact: A language reviewer paging the assessment history gets small underlined text where every other list in the app gives them a bordered button, loses the disabled-edge cue at the ends of the list, and gets no feedback at all that a page change is loading, on a tab whose page size is 50 rows.  
  Fix: Delete the local function and call `<Pagination page pageCount hrefFor={(p) => tabHref("history", { term, q: search, page: String(p) })}/>`. If the `1-25 of 300` range is genuinely wanted, add an optional `total` + `pageSize` prop to the primitive and render the range in place of `Page X of Y` for every consumer, so there is one answer rather than two.

- **Four rosters that all link to the same profile summarise a person four different ways** `[unverified]`  
  `data-display/person-identity-cell-four-shapes` · - · effort M · 6 surfaces across volunteers and admin: /volunteers, /volunteers/master, /volunteers/directory, /admin/people, /admin/te  
  Sites: `src/app/(app)/volunteers/page.tsx:238-247`, `src/app/(app)/volunteers/master/page.tsx:433-445`, `src/app/(app)/volunteers/directory/page.tsx:366-381`, `src/modules/admin/components/people-table.tsx:46-62`, `src/modules/admin/components/roster-panel.tsx:324-329` and more  
  Impact: PersonPhoto ships and only /admin/people uses it in a list, so the four surfaces where someone actually looks a volunteer up are faceless. A director who learns to find the email under the name on /volunteers finds it in its own column on /admin/people and missing entirely in the roster picker. On the directory a person with no details reads "No contact details on file"; on master the same person'  
  Fix: Add `<PersonCell person={{id,name,netId,contactEmail,phone,photoVersion}} href? photo? fields? cleared? />` to src/platform/ui. It renders the avatar (default on, sized 28), the name as a link when href is given (using PersonName so the cleared seal composes), and the joined subline with one agreed missing-value string. Migrate the three volunteers rosters (identical markup already), people-table 

- **Auto-submitting filter selects bypass NavForm, so the table dims on Next but not on filter change**  
  `list-surfaces/auto-submit-filters-skip-pending` · medium · effort S · 3 filter components on 2 of the app's busiest lists (IT triage queue, applicant roster); any future auto-submit filter.  
  Sites: `src/modules/support/components/request-filters.tsx:58`, `src/modules/recruitment/components/decision-filter.tsx:36`, `src/modules/recruitment/components/department-filter.tsx:31`, `src/app/(app)/support/all/page.tsx:106`, `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:270` and more  
  Impact: A manager changes Status to Failed on /support/all, the old rows sit there unchanged for a second, and they read the stale list as the answer. The same page dims correctly one click away on pagination, so the feedback is not just missing, it is inconsistent within one screen.  
  Fix: Export `useNavFilter()` from `src/platform/ui/nav-form.tsx`: it returns a `setParams(mutate: (p: URLSearchParams) => void)` that deletes `page`, wraps `router.push` in `startTransition`, and calls `useReportListPending(isPending)` exactly as NavForm already does. Replace the three hand-written `setParam`/`onChange` bodies with it. Roughly 15 lines added, ~30 deleted, and every auto-submit filter i

- **The command palette's inline focus trap is the pre-audit-14 selector, in a file whose own comment forbids the copy**  
  `a11y-responsive/stale-focus-trap-copy` · low · effort S · One file, but it is mounted by AppShell on every authenticated route for every user; keyboard and screen-reader users of  
  Sites: `src/platform/ui/command-palette.tsx:243`, `src/platform/ui/use-focus-trap.ts:17`, `src/platform/ui/use-focus-trap.ts:64`, `src/platform/ui/modal.tsx:65`, `src/platform/intercom/blocker-gate.tsx:182`  
  Impact: Shift+Tab from the palette's search input can wrap onto a control that cannot take focus, leaving focus where it was so the trap reads as broken. When the panel momentarily has no enabled focusable (the empty-result state renders only a `<p role="status">` at command-palette.tsx:477), Tab escapes into the scroll-locked page behind the scrim, which is precisely the failure audit 14 fixed everywhere  
  Fix: Delete command-palette.tsx:230-268's inline trap and call `useFocusTrap(panelRef, open)`, keeping the palette's own Escape and scroll-lock (the hook's doc at use-focus-trap.ts:38-40 says Escape and scroll locking deliberately stay with the caller, and the palette needs `inputRef.current?.focus()` to run after, exactly as modal.tsx:60-65 orders its two effects). The palette's four stated reasons fo

- **Five record forms submit with a plain Button, so a slow save has no pending state**  
  `detail-and-form/submit-primitive-split` · medium · effort S · Every create/edit form in admin, schedule, volunteers, learning, incidents and outreach; ~90 `Button type="submit"` site  
  Sites: `src/modules/admin/components/person-form.tsx:140`, `src/modules/admin/components/term-form.tsx:69`, `src/modules/admin/components/department-form.tsx:168`, `src/modules/admin/components/subcommittee-form.tsx:34`, `src/modules/schedule/components/attending-form.tsx:119` and more  
  Impact: On the SCORM-heavy and roster-heavy saves this actually matters: a slow server action leaves the button live and unlabelled, so a second click double-fires it. A screen-reader user gets no `aria-busy` announcement that anything is happening. And a person moving between /admin/departments/[id] and /schedule/specialties/[id], two pages one nav hop apart, gets a spinner on one and a dead button on th  
  Fix: One shape: every `<form action={serverAction}>` submits through `SubmitButton` from `@/platform/ui/submit-button`. Replace the five `<Button type="submit">` calls in the record forms and the two quick-add forms, delete `src/app/(app)/outreach/campaigns/[id]/submit-button.tsx` and point its four importers at the platform one (it takes the same `pendingLabel`/`variant`/`disabled` props, so the edit 

- **Identical form pairs behave differently on pending: same page, same feature, plain Button vs SubmitButton**  
  `feedback/pending-state-drift-inside-one-surface` · medium · effort S · 3 confirmed surfaces plus a systemic split: 90 plain `<Button type="submit">` against 96 `<SubmitButton>` across src/app  
  Sites: `src/app/(app)/incidents/[id]/page.tsx:482-484`, `src/app/(app)/incidents/[id]/page.tsx:431-433`, `src/app/(app)/incidents/[id]/page.tsx:546-548`, `src/app/(app)/admin/email/page.tsx:380-385`, `src/app/(app)/admin/email/templates/[key]/page.tsx:185-186` and more  
  Impact: "Send test" on /admin/email dispatches real mail through Graph and takes seconds; with no disable and no spinner an admin clicks it two or three times and sends duplicate test mail. On an incident report the reviewer's most-used control gives no sign the status save is in flight, so a second click re-posts the decision. Across the campaign editor, every pending state is silent to a screen reader b  
  Fix: One rule: every `<form action={serverAction}>` submit is `SubmitButton` (or `ConfirmButton` for destructive), never a bare `<Button type="submit">`. Delete src/app/(app)/outreach/campaigns/[id]/submit-button.tsx and point its four importers at `@/platform/ui/submit-button` (the props are a strict subset, so the swap is import-only). Convert the three sites above. Then extend the existing raw-contr


### T4. No way out of a record

Navigation into a record works; navigation back out was never given one shape.

*12 confirmed*

- **Breadcrumbs strip the href from the last crumb, killing the escape link on ~20 detail pages**  
  `nav-ia/dead-escape-crumb` · medium · effort S · ~20 detail routes across admin, support, incidents, schedule, outreach, volunteers, learning and recruitment/cycles/[id]  
  Sites: `src/platform/ui/breadcrumbs.tsx:25`, `src/platform/ui/breadcrumbs.tsx:28`, `src/platform/ui/breadcrumb-trail.ts:50`, `src/platform/ui/breadcrumb-trail.ts:59`, `src/platform/ui/breadcrumb-trail.test.ts:41` and more  
  Impact: On roughly twenty detail routes (every /admin/*/[id], /support/[id], /incidents/[id], /schedule/attendings/[id], /outreach/campaigns/[id], /volunteers/board-meetings/[id], /learning/manage/[courseId], /recruitment/cycles/[id]/emails …) the breadcrumb looks like a working trail and is not. A reviewer who opens incident report #42 from the queue sees "Hub › Incidents", clicks "Incidents", and nothin  
  Fix: Change ONE line in src/platform/ui/breadcrumbs.tsx: render a crumb as a Link whenever `crumb.href` is present, and reserve the aria-current="page"/font-medium treatment for the last crumb only when it has no href. Concretely, split the two concerns: `const current = i === crumbs.length - 1 && !crumb.href;` then `{crumb.href ? <Link …> : <span aria-current={current ? "page" : undefined} …>}`, keepi

- **SetBreadcrumb is used by one module; the other eight hand-roll four different back links or none**  
  `nav-ia/detail-leaf-and-back-link` · high · effort M · ~20 detail routes in eight modules; every staff role that opens a record. Also fixes a dark-mode contrast defect on the   
  Sites: `src/modules/recruitment/breadcrumbs.ts:52`, `src/platform/ui/breadcrumb-context.tsx:43`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:191`, `src/app/(app)/volunteers/board-meetings/[id]/page.tsx:81`, `src/app/(app)/schedule/triage-chats/[presetId]/created/page.tsx:127` and more  
  Impact: Getting out of a record is a different gesture on every screen, and on eight of them there is no gesture at all. A compliance manager on a member profile gets a link above the title; a board admin on a meeting gets one below it; an IT manager on a ticket gets nothing. The one back link in the events kiosk is close to invisible in dark mode. Nobody outside recruitment ever sees the name of the reco  
  Fix: Make the leaf crumb the single shape and delete the four bespoke links. Every detail page already loads its record, so it can render `<SetBreadcrumb trail={buildTrail(...)} />` the way recruitment does. Give each module a tiny trail helper modelled on src/modules/recruitment/breadcrumbs.ts (`recruitmentTrail(...tail)` / `cycleTrail`) , e.g. `adminTrail({ section, leaf })`, `supportTrail({ leaf })`

- **Detail pages give no breadcrumb leaf, then hand-roll four different back links**  
  `detail-and-form/detail-breadcrumb-leaf-and-back-links` · medium · effort M · Roughly 20 detail pages outside recruitment, in admin, schedule, volunteers, learning and outreach. Every staff role tha  
  Sites: `src/platform/ui/breadcrumb-trail.ts:56`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:191`, `src/app/(app)/volunteers/board-meetings/[id]/page.tsx:82`, `src/app/(app)/schedule/triage-chats/[presetId]/created/page.tsx:127`, `src/app/(app)/recruitment/events/[id]/check-in/page.tsx:70` and more  
  Impact: Open a person, a course, an EHS training or an attending and the breadcrumb reads 'Hub > Admin > People' with no sign of who you are looking at, so a second tab is indistinguishable from the first. Four pages do give a way back, but each puts it somewhere else, so the affordance is never where the last page taught you to look, and one of them is invisible in dark mode.  
  Fix: Adopt the leaf everywhere instead of the back links. `SetBreadcrumb` and `buildBreadcrumbs(…, leafLabel)` already exist and are proven on 19 recruitment pages; add one `<SetBreadcrumb …>` call per detail page naming the record (`person.name`, `course.title`, `training.name`, `attending.scheduleName`, `scope.name`, `department.code`). Then delete the four hand-rolled back links, since the parent cr

- **Five real pages sit outside the module registry, so they lose the tab row, the dropdown, Cmd+K and the breadcrumb together**  
  `nav-ia/registry-orphan-surfaces` · medium · effort M · Five surfaces across admin, volunteers, schedule, outreach and the personal inbox; every signed-in member (notifications  
  Sites: `src/platform/modules/registry.ts:253`, `src/app/(app)/admin/email/page.tsx:296`, `src/app/(app)/volunteers/ehs/page.tsx:56`, `src/app/(app)/schedule/attendings/page.tsx:478`, `src/platform/ui/notification-bell.tsx:171` and more  
  Impact: A compliance manager who wants to add an EHS training must remember that the button lives on /volunteers/ehs; there is no tab, no dropdown entry and no search hit for "manage trainings". Faculty Relations cannot search for "credentialing". A member cannot search for "notifications" and cannot reach their inbox except by opening the bell. These are not edge pages: credentialing tracks every new att  
  Fix: Adopt one rule: a page a person navigates TO is a registry nav item; a page reached only from a record is not. Add the four navigational ones as registry entries with their real permissions , `{ label: "Email templates", href: "/admin/email/templates", permission: "admin.manage_email_templates" }` under admin, `{ label: "Manage trainings", href: "/volunteers/ehs/manage", permission: "volunteers.ma

- **/training has no registry entry, so it loses tabs, breadcrumbs and search at once, and shares Learning's icon**  
  `nav-ia/training-not-a-module` · medium · effort M · Every volunteer and director who must clear training each term; /training is linked from the dashboard action feed, both  
  Sites: `src/platform/modules/registry.ts:346`, `src/platform/modules/registry.ts:357`, `src/platform/ui/account-menu.tsx:83`, `src/platform/ui/command-palette.tsx:62`, `src/platform/ui/breadcrumb-trail.ts:27` and more  
  Impact: Term clearance , the thing that decides whether a volunteer may work a shift , lives on a page with no tab row, no breadcrumb and no module chip. A member who navigates away from /training has no way back except reopening the avatar menu, and the icon there is the same one the Learning chip uses, so "the graduation cap" points at two different products depending on which corner of the toolbar you   
  Fix: Fold /training into the Learning module rather than inventing a tenth module: it is already the same subject, and src/modules/learning has no components/ directory pulling the other way. Add `{ label: "Term clearance", href: "/training" }` (no permission , it gates on requirePersonSession) to the learning nav array at registry.ts:355-360, add a src/app/(app)/training/layout.tsx that renders `<Modu

- **Six nav tabs are hidden from BOTH the global dropdown and Cmd+K, including the schedule Builder**  
  `nav-ia/dynamicgate-invisible-to-search` · medium · effort M · Every schedule module tab except three, plus recruitment Events; the directors, Faculty Relations managers and front-des  
  Sites: `src/platform/modules/access.ts:99`, `src/platform/modules/registry.ts:48`, `src/platform/modules/registry.ts:56`, `src/platform/modules/registry.ts:65`, `src/platform/modules/registry.ts:67` and more  
  Impact: Typing "builder" into Cmd+K finds nothing, and hovering the Schedule chip lists four sub-pages while the Schedule page itself shows nine tabs. A department director whose entire job is /schedule/builder cannot reach it from anywhere in the toolbar: they must first land on /schedule and then find the tab row. Same for Approvals (where their queue lives), Attendings, Coverage and the clinic-day Chec  
  Fix: Resolve the dynamic gates once per request and thread them through the channel that already exists. `extraNavItems` is already plumbed AppShell -> getAccessibleModules -> GlobalNav + CommandPalette (access.ts:110-116), and recruitment already uses it for its panelist tab via `recruitmentGlobalNav({ isReviewer, isPanelist })` (nav.ts:49-57, called at src/app/(app)/layout.tsx:62). Add the mirror: a 

- **The Incidents module root is a blank report form, so every up-link in the module lands on a create screen**  
  `nav-ia/incidents-root-is-a-form` · medium · effort M · The whole incidents module: every signed-in member (reporting) plus incidents.manage reviewers and incidents.view_strike  
  Sites: `src/platform/modules/registry.ts:213`, `src/app/(app)/incidents/page.tsx:65`, `src/platform/ui/breadcrumb-trail.ts:36`, `src/app/(app)/incidents/review/page.tsx:86`, `src/app/(app)/incidents/mine/page.tsx:63` and more  
  Impact: An incident reviewer working a report has no in-chrome way back to the queue at all, and the one up-link the module offers on its list pages drops them into a half-built concern form , the single most alarming place to land by accident in this product, since abandoning it looks like a half-filed report. It is also the module whose users are most likely to be moving carefully.  
  Fix: Move the create form off the module root and give incidents a reading landing page, matching the other eight modules. Route the form to /incidents/new and make /incidents the reviewer-or-reporter landing: redirect to /incidents/review for `incidents.manage` holders and to /incidents/mine otherwise (the branching-redirect pattern outreach/page.tsx:14-23 already establishes), then set `rootHref` per

- **/schedule is offered under six different labels, twice in the same four-tile action grid**  
  `nav-ia/one-url-six-labels` · medium · effort S · Every volunteer with a shift: the hub action feed, the schedule hero, the module chip, the tab row and the weekly remind  
  Sites: `src/app/(app)/action-cards.ts:76`, `src/app/(app)/action-cards.ts:87`, `src/app/(app)/action-cards.ts:138`, `src/app/(app)/action-cards.ts:140`, `src/app/(app)/page.tsx:557` and more  
  Impact: A volunteer with an upcoming shift sees a four-tile action feed where two tiles, different icons and different labels, go to the same URL , so half the feed is redundant on the app's most-visited page. Worse, both "Request a swap" and the email's "submitted here" promise an action and deliver the top of a list where the request form is folded shut inside a disclosure, with nothing on screen naming  
  Fix: Pick one name and one destination per job. Keep "My schedule" (the registry label) for the list, and make the swap affordance land on the thing it names: give the request disclosure a stable anchor (`id="request-a-change"` plus `scroll-mt-8`, matching the existing `#calendar-subscription` pattern at schedule/page.tsx:786) and open it when the URL hash matches. Point swapCard's href and shift-remin

- **Eleven nav tabs open a page with a different name at the top**  
  `nav-ia/nav-label-vs-page-title` · medium · effort S · Six module tabs plus five cycle tabs; directors, compliance managers, IT managers and every member following an emailed   
  Sites: `src/platform/modules/registry.ts:357`, `src/app/(app)/learning/page.tsx:18`, `src/platform/modules/registry.ts:359`, `src/app/(app)/learning/dashboard/page.tsx:59`, `src/platform/modules/registry.ts:379` and more  
  Impact: Scanning a thirteen-tab cycle row, a director cannot map the tab they remember to the page title they remember: they look for "Onboarding contract" and the tab says "Contract". Support has it in both directions , the nav promises a form and delivers a chat button labelled "Get help", while the volunteer who follows the IT-help-desk link in a shift reminder lands on the same page under the same mis  
  Fix: Make the nav label the canonical name and let PageHeader repeat it verbatim; put the extra words in the description, which PageHeader already renders. Concretely: learning/page.tsx:18 title becomes "My courses"; learning/dashboard title "Completion" with the current sentence as description; recruitment/events title "Events"; volunteers/master title "Master view"; support/epic title "Epic / YNHH to

- **Sixteen nav tabs open a page whose H1 is a different name**  
  `copy-terminology/nav-label-vs-page-title` · medium · effort M · Every module tab row, the global nav dropdowns, the Cmd+K palette and the breadcrumb trail. All roles.  
  Sites: `src/platform/modules/registry.ts:56`, `src/app/(app)/schedule/builder/page.tsx:510`, `src/platform/modules/registry.ts:58`, `src/app/(app)/schedule/requests/page.tsx:155`, `src/platform/modules/registry.ts:81` and more  
  Impact: The Cmd+K palette and the global-nav dropdowns index `NavModule.nav` labels, so a director who remembers the page as "Course completion" cannot find it by typing that; the palette only knows "Completion". On a 13-tab cycle row a reviewer scanning for "Onboarding contract" has to guess that "Contract" is it. People end up navigating by tab position instead of by name, which is what makes a growing   
  Fix: Make the nav label the canonical short name and the H1 equal to it, moving any qualifier into the PageHeader `description` slot that most of these pages already use. Rename the H1s to match the tabs ("Builder", "Approvals", "Coverage", "Master view", "Campaigns", "Cycles", "Events", "Completion", "Form", "Contract", "Quiz", "Subcommittees"), except where the tab is the vaguer of the two, in which 

- **admin.manage_email_templates grants two pages that its holder has no route to**  
  `nav-ia/templates-permission-no-route` · low · effort S · Two admin pages and any role granted the template permission; currently latent, becomes a live lockout the first time th  
  Sites: `src/platform/modules/registry.ts:246`, `src/platform/modules/registry.ts:265`, `src/app/(app)/admin/email/page.tsx:87`, `src/app/(app)/admin/email/page.tsx:296`, `src/app/(app)/admin/email/templates/page.tsx:10` and more  
  Impact: An admin who grants exactly "manage email templates" to a communications lead hands them a permission with no door. The holder sees an Admin chip, opens Admin, and finds ten tabs, none of which is theirs; the Email tab that hosts the only link bounces them to /no-access. They cannot search for it either. The permission looks broken rather than unreachable, which sends the report to the wrong place  
  Fix: Add the templates index to the admin registry nav with its own permission: `{ label: "Email templates", href: "/admin/email/templates", permission: "admin.manage_email_templates" }`, placed after the Email entry (registry.ts:265). That one line restores the tab row, the Admin dropdown, Cmd+K and the breadcrumb parent section for both /admin/email/templates and /admin/email/templates/[key] in a sin

- **The link to / is labelled three different ways on the app's four failure screens**  
  `copy-terminology/back-to-root-label` · low · effort S · /no-access (the redirect target of 22 permission gates), the (app) error boundary, the global 404, and /training. Every   
  Sites: `src/app/(app)/no-access/page.tsx:28-30`, `src/app/(app)/error.tsx:53-54`, `src/app/not-found.tsx:25-28`, `src/app/(app)/training/page.tsx:260-261`, `src/platform/ui/breadcrumb-trail.ts:31`  
  Impact: These are the screens a member reaches when something has already gone wrong: a denied permission, a thrown page, a dead link from an email. "Back to home" reads as leaving the product while the breadcrumb one line above calls the same place "Hub", so the single escape route on the worst screens in the app is described in words the rest of the app does not use.  
  Fix: Use "Back to hub" at all four sites, matching the breadcrumb root and sentence case: a one-word edit in `(app)/error.tsx:54`, `not-found.tsx:28` and `training/page.tsx:261`. These four are also the only bare back-to-root links in the app, so this is the natural moment to settle their button variant too (currently primary on /no-access and outline on the other three).


### T5. The same job, built twice

Two surfaces answer one question, and they have already drifted into disagreeing.

*11 confirmed, 3 unverified*

- **The bell popover and /notifications render the same rows with different everything**  
  `duplicate-surfaces/notification-inbox-built-twice` · medium · effort S · Every signed-in user: the bell is on every authenticated route, and /notifications is its only destination.  
  Sites: `src/platform/ui/notification-bell.tsx:150`, `src/app/(app)/notifications/page.tsx:72`, `src/platform/ui/notification-bell.tsx:18`, `src/app/(app)/notifications/page.tsx:87`, `src/platform/ui/notification-bell.tsx:145` and more  
  Impact: The bell is the only in-app link to /notifications (:170), so every member arrives having just read the popover version and finds the same list restyled, retimed and reworded. A screen-reader user gets "Unread" announced on the page and nothing in the popover.  
  Fix: One <NotificationRow title body createdAt unread onOpen /> in src/platform/ui/ owning the dot (with its sr-only label), the two-line body and the timestamp, and one time format: `<DateTime>` with a relative mode, since src/platform/dates already owns time rendering and the bell's local timeAgo duplicates nothing that lives there. The popover keeps its max-h-96 scroller and "View all" footer; the p

- **The notification bell and the notifications page render the same rows with different time formats, different unread dots, and only one of them accessible** `[unverified]`  
  `data-display/notification-row-two-time-formats` · - · effort S · 2 surfaces, but the toolbar bell renders on every authenticated route for every user, and it is the sole navigation path  
  Sites: `src/platform/ui/notification-bell.tsx:18-25`, `src/platform/ui/notification-bell.tsx:157-165`, `src/app/(app)/notifications/page.tsx:75-88`, `src/platform/dates/display.tsx:9-13`  
  Impact: The bell is the only entry point to /notifications, so every user crosses that boundary and the same notification's timestamp changes format and timezone in one click; a member in a different timezone gets "2h ago" in the bell and an Eastern-Time wall clock on the page. A screen-reader user gets no unread indication at all in the bell, because the dot is aria-hidden with no sr-only companion, whil  
  Fix: Add a `relative` option to src/platform/dates/display.tsx (a `<RelativeTime value>` that emits `<time dateTime>` with the absolute string as its `title`, falling back to DateTime past ~7 days) and use it in both places, or simply use `<DateTime>` in the bell. Extract the row itself as `<NotificationRow item unread />` in src/platform/ui/notification-row.tsx, carrying the sr-only "Unread" and one d

- **/admin/email and /admin/notifications are the same delivery-log page built twice**  
  `duplicate-surfaces/delivery-log-built-twice` · medium · effort M · Every admin holding admin.manage_sync; the two pages used whenever email or Teams delivery breaks.  
  Sites: `src/app/(app)/admin/email/page.tsx:420`, `src/app/(app)/admin/notifications/page.tsx:204`, `src/app/(app)/admin/email/page.tsx:463`, `src/app/(app)/admin/notifications/page.tsx:247`, `src/app/(app)/admin/email/page.tsx:536` and more  
  Impact: An admin chasing a failed notification learns the page on one tab and gets a second copy on the other that can drift at any time. They already disagree on which statuses are retryable (email retries FAILED only; notifications retries FAILED, FALLBACK and LOGGED) with nothing on screen explaining why. Any fix to error truncation, retry copy or the filter row has to be made twice.  
  Fix: One <DeliveryLogTable rows columns retryAction retryConfirmLabel emptyDescription /> and one <DeliveryFilterBar fields /> in src/modules/admin/components/. Both pages pass their own column definitions and their own retry predicate; truncation, tooltip, pagination and empty state live once. The same <DeliveryFilterBar> then absorbs the third and fourth copies of that NavForm shape on /admin/people 

- **The compliance roster is built twice and the director's copy silently drops Learning**  
  `duplicate-surfaces/volunteers-compliance-roster-built-twice` · medium · effort M · Every department director (their own roster) and every compliance manager (clinic-wide): the two busiest tables in the v  
  Sites: `src/app/(app)/volunteers/page.tsx:31`, `src/app/(app)/volunteers/master/page.tsx:78`, `src/app/(app)/volunteers/page.tsx:210`, `src/app/(app)/volunteers/master/page.tsx:405`, `src/app/(app)/volunteers/page.tsx:236` and more  
  Impact: A department director reviewing their own team cannot see whether a volunteer finished their assigned learning course; the compliance manager one nav tab away can. The director also has no way to search or filter their roster. And the same six counts are spelled two ways on two pages the same person uses in one sitting.  
  Fix: One <ComplianceRosterTable rows columns={[...]} /> in src/modules/volunteers/components/, plus one exported status module (STATUS_LABEL / STATUS_TONE / TASK_STATE_LABEL / TASK_STATE_TONE / taskState) that both pages import. Give the table the full column set including Learning and let /volunteers render it scoped to the viewer's departments, with the same NavForm filter row and Pagination master a

- **/schedule renders two hand-built copies of "my shifts" - volunteer and attending**  
  `duplicate-surfaces/schedule-dual-portal-one-route` · medium · effort L · Every volunteer and every attending physician, on the most-visited page in the schedule module; plus every director who   
  Sites: `src/app/(app)/schedule/page.tsx:490`, `src/modules/schedule/components/attending-portal-section.tsx:96`, `src/app/(app)/schedule/page.tsx:518`, `src/modules/schedule/components/attending-portal-section.tsx:117`, `src/app/(app)/schedule/page.tsx:613` and more  
  Impact: A faculty member who also volunteers scrolls one page and meets the same four controls twice, worded differently ("pending director review" vs "pending Faculty Relations review", "past shifts" vs "past dates"). Every future schedule change - a new badge, a cancel-window rule, a copy fix - has to be made twice or the two halves of one page disagree.  
  Fix: Extract four components into src/modules/schedule/components/: <ShiftCard> (card + badges + alongside line + an `actions` slot), <PendingRequestStrip> (icon + summary + withdraw slot, taking `reviewerLabel`), <RequestChangeDisclosure> (the details/summary shell, taking children), and <PastShiftsDisclosure> (taking `label` and children). Both hosts pass their own row type through a small adapter to

- **The admin "search a person, then assign" panel is built twice with two radii**  
  `duplicate-surfaces/admin-person-search-panel-twice` · medium · effort M · Every admin using /admin/roles or /admin/terms/[id]: the two places clinic membership and permissions are granted.  
  Sites: `src/modules/admin/components/assignment-form.tsx:294`, `src/modules/admin/components/roster-panel.tsx:282`, `src/modules/admin/components/assignment-form.tsx:318`, `src/modules/admin/components/roster-panel.tsx:307`  
  Impact: An admin adds someone to a term on /admin/terms/[id] and grants them a role on /admin/roles using what looks like the same control, drawn at two sizes on two surfaces, and has to relearn the affordance. A future fix (keyboard selection, a result cap, an "already assigned" marker) lands on only one of them.  
  Fix: One <PersonSearchPanel queryParam clearHref results renderRowActions /> in src/modules/admin/components/, built on <Card pad={false}> so the surface matches every other panel in the module. Both callers pass their own per-row form through renderRowActions (role + term on /admin/roles, department + kind on /admin/terms/[id]); the search box, the result header sentence and the row layout live once.

- **Three email-authoring surfaces share the editor and hand-build three save frames**  
  `duplicate-surfaces/email-authoring-frames-drift` · medium · effort M · Recruitment directors (per-cycle emails), outreach senders (campaigns), and admins (platform templates + sender routing)  
  Sites: `src/app/(app)/admin/email/templates/[key]/page.tsx:132`, `src/app/(app)/recruitment/cycles/[id]/emails/[key]/page.tsx:69`, `src/app/(app)/admin/email/templates/[key]/page.tsx:157`, `src/app/(app)/admin/email/page.tsx:339`, `src/app/(app)/outreach/campaigns/[id]/compose-form.tsx:44` and more  
  Impact: A recruitment director saving a cycle email gets no feedback that the click registered and can double-submit; the same click on the admin template one route away shows "Saving…" with a spinner. Every pending state in the whole outreach campaign editor is missing its spinner and aria-busy. And "where do I change the from address" has three answers with three layouts.  
  Fix: One <TemplateEditorForm saveAction resetAction hasOverride subject body variables ... /> in src/modules/admin/components/ that owns the Card, the FormActions row and both SubmitButtons; the three hosts pass actions and copy only. Delete src/app/(app)/outreach/campaigns/[id]/submit-button.tsx and import @/platform/ui/submit-button in its four consumers. Extract one <SenderAddressForm scope target i

- **Two interview lists over one table disagree about what is true of a candidate**  
  `duplicate-surfaces/two-interview-lists-two-truths` · medium · effort S · Every interview panelist and every recruitment director during a DIRECTOR-track cycle.  
  Sites: `src/app/(app)/recruitment/interviews/page.tsx:21`, `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:49`, `src/app/(app)/recruitment/interviews/page.tsx:38`, `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:73`  
  Impact: A recruitment director working the cycle list cannot see that a candidate withdrew, so they keep scheduling and emailing them. A panelist working their own list cannot see whether a decision has already been recorded, so they write an evaluation for an interview that is already closed. Both are looking at the same rows.  
  Fix: One <InterviewTable rows columns /> in src/modules/recruitment/components/ over a single row projection that always carries `applicationStatus`, `decision`, `scheduledAt`, `panelistCount` and `evaluationCount`. Both pages choose columns; neither chooses which facts exist. Render decision through the <DecisionBadge> proposed in the recruitment status-badge finding, and show the Withdrawn badge on b

- **Two interview lists one nav hop apart print an N/M chip that means two different things** `[unverified]`  
  `data-display/eval-ratio-two-meanings` · - · effort S · 2 surfaces, but the two audiences overlap heavily: recruitment leads on /recruitment/cycles/[id]/interviews and every in  
  Sites: `src/app/(app)/recruitment/cycles/[id]/interviews/page.tsx:79-83`, `src/app/(app)/recruitment/interviews/page.tsx:43-49`  
  Impact: A recruitment lead who also sits on panels reads both lists in the same session. "3/5" on one page is a completion count and on the other a score, with no unit and no tooltip to separate them. Worse, the panelist list never shows a candidate's decision status, so a panelist cannot tell a scheduled interview from a decided one, and the cycle list never shows Withdrawn, so a lead can chase a panel f  
  Fix: Split the two facts into two named renderings and use both on both pages. `<EvalProgress done={n} of={panelists} />` renders "2 of 3 evals" (or an EmptyState inline when there are no panelists) and `<ScoreBadge score={n} outOf={5} />` renders "4 / 5" with a unit-bearing accessible label. Then give the panelist list the same Status column the cycle list derives (lift `status(iv)` out of cycles/[id]

- **Three person-by-date matrices are hand-rolled, so none of them dims while refetching**  
  `duplicate-surfaces/three-hand-rolled-matrix-grids` · low · effort M · Every department director building a schedule, Faculty Relations building attending coverage, and anyone reading the cov  
  Sites: `src/modules/schedule/components/builder-grid.tsx:481`, `src/modules/schedule/components/attending-grid.tsx:293`, `src/modules/schedule/components/attending-coverage-view.tsx:37`, `src/platform/ui/table.tsx:28`  
  Impact: A director clicks a different clinic date or term on the builder and the matrix keeps rendering the old term's assignments as though they were current until the server answers. The three biggest data surfaces in the schedule module are the three with no refetch feedback, while the small roster tables beside them dim correctly.  
  Fix: One <MatrixTable rowHeader columns rows renderCell stickyMinWidth /> in src/platform/ui/ that reuses Table's own outer shell (cardClasses, the overflow-x-auto container and PendingDim) and adds the sticky first column and per-cell borders the three grids need. All three callers keep their own cell renderers (assignment buttons, coverage names, availability marks) and lose the wrapper, the header b

- **/get-started forks /learning and /training into degraded copies for blocked members**  
  `duplicate-surfaces/onboarding-shell-forks-member-pages` · low · effort M · Every new member during onboarding (locked shell) and every existing member afterwards (app shell); four routes.  
  Sites: `src/app/(app)/learning/page.tsx:9`, `src/app/get-started/learning/page.tsx:10`, `src/app/(app)/learning/page.tsx:29`, `src/app/get-started/learning/page.tsx:34`, `src/app/(app)/training/page.tsx:39` and more  
  Impact: The member who most needs guidance, the one the onboarding gate is holding back, gets the thinner page. They are never told a course must be retaken each term, they see a blank panel instead of an empty state, and they never see the "most volunteers attend the live session, the makeup quiz is here if you miss it" explanation a cleared member gets on /training.  
  Fix: Move both bodies into src/modules/learning/components/AssignedCourseList.tsx and src/modules/recruitment/components/TrainingStatus.tsx, each taking a `hrefBase` prop ("/learning" vs "/get-started/learning") so the two shells differ only in chrome. Export the status LABEL map once. Pick one visual for the four training states (the Alert tones, since Alert already ships exactly success/error/info/wa

- **Two approval panels stack on /schedule/requests and only one takes a denial reason**  
  `duplicate-surfaces/schedule-approvals-two-panels-stacked` · low · effort S · Every department director with schedule.manage_requests plus Faculty Relations; the approvals page linked from shift-rem  
  Sites: `src/modules/schedule/components/pending-requests.tsx:147`, `src/modules/schedule/components/attending-pending-requests.tsx:102`, `src/app/(app)/schedule/requests/page.tsx:163`, `src/app/(app)/schedule/requests/page.tsx:196`, `src/modules/schedule/components/pending-requests.tsx:175` and more  
  Impact: Faculty Relations denies an attending's swap and the physician is told no with no reason, while a volunteer denied on the panel directly below it gets one. Someone holding both roles sees two visually identical panels that behave differently, with nothing on screen explaining why.  
  Fix: One <RequestApprovalPanel title rows renderSummary approveAction denyAction allowDenyNote /> in src/modules/schedule/components/, taking a `renderSummary(row)` callback so the volunteer row (department + date) and attending row (column + date + unstaffed warning) keep the genuinely different summaries attending-pending-requests.tsx's own doc comment defends, while sharing the shell, the stale guar

- **Two pairs of pages render the same rows, one with search/filter/paging and its twin with none**  
  `list-surfaces/sibling-lists-same-rows-different-capability` · medium · effort L · 4 surfaces: every member (their own tickets) and every department director (their own roster).  
  Sites: `src/app/(app)/volunteers/page.tsx:180`, `src/app/(app)/volunteers/master/page.tsx:337`, `src/app/(app)/support/page.tsx`, `src/app/(app)/support/all/page.tsx:89`, `src/modules/support/components/request-list.tsx:85` and more  
  Impact: A department director working /volunteers cannot search for one member of their own roster; the compliance manager one tab away can. A volunteer with 40 tickets cannot find an old one on /support, though the IT manager searching the same rows on /support/all can. The capability gap tracks seniority rather than need.  
  Fix: Lift the filter+pager into the shared component boundary: `RequestList` gains the FilterBar and Pagination as an opt-in `paginated`/`filters` prop pair and both support routes use it. For volunteers, delete the /volunteers roster table and render `master/page.tsx`'s table with a `departmentScope` prop, so the director view is the manager view restricted rather than a second table with the copied S

- **The same person-search results panel is a top-level Card on one page and a nested sub-panel on another** `[unverified]`  
  `hierarchy-density/nested-panel-depth` · - · effort S · 2 admin pages (/admin/terms/[id], /admin/roles); admins and roster managers.  
  Sites: `src/modules/admin/components/roster-panel.tsx:309`, `src/modules/admin/components/assignment-form.tsx:290`, `src/modules/admin/components/assignment-form.tsx:320`, `src/modules/admin/components/roster-panel.tsx:373`, `src/modules/admin/components/assignment-form.tsx:292`  
  Impact: An admin who learns "search a person, pick a role, press Add" on the term roster meets the same three-step control on /admin/roles rendered as a subordinate box inside a card, which reads as a different, lesser control and hides that it is the same job. Any fix to one (a keyboard affordance, a result cap, a pending state) has to be found and repeated in the other.  
  Fix: Extract one `<PersonSearchPanel searchName resultsHeader results renderRowForm />` into src/modules/admin/components, built on `<Card pad={false}>` with the header band and divide-y rows exactly as roster-panel.tsx:309-355 has them, taking the per-row form as children so one caller supplies department+kind and the other supplies role+term. Mount it in both places and delete assignment-form.tsx:320


### T6. Feedback that misfires

Actions confirm twice, once, or not at all, and some report success they never got.

*12 confirmed*

- **Eight pages render an inline error Alert for a param the global toast already claims and strips**  
  `feedback/flash-toast-and-inline-alert-double-report` · medium · effort S · 8 pages across 5 modules (outreach, recruitment, volunteers, schedule, admin-adjacent). Hits directors, compliance manag  
  Sites: `src/platform/ui/toast/flash-reader.tsx:75-88`, `src/platform/ui/toast/flash.ts:298-303`, `src/app/(app)/outreach/identities/page.tsx:247`, `src/app/(app)/outreach/scopes/[id]/page.tsx:176`, `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx:60` and more  
  Impact: A refusal flashes twice and then the readable, persistent half disappears mid-read. A board admin whose meeting create failed sees a red banner and a corner pill simultaneously, and a beat later the banner is gone and only the pill remains, for four seconds. The two channels also disagree in wording on the same failure, because the toast passes the raw value through `resolveErrorValue` while the b  
  Fix: One rule: a redirect param is EITHER toasted OR rendered inline, never both, and the toast wins. Delete the eight inline `<Alert>` error branches listed above (they are one line each) and let FlashReader own the `error`/`*Error` convention app-wide. Keep `SUPPRESSED_ERROR_PARAMS` strictly for the three pages that own page-specific error vocabulary the shared code table cannot resolve, and add a co

- **Recruitment builders throw away the `{ok:false, error}` their actions return: eight `if (r.ok)` with no else**  
  `feedback/builder-actions-drop-their-own-error-result` · medium · effort M · 4 builder files covering the Form, Quiz and Contract tabs of every recruitment cycle. Affects every department director   
  Sites: `src/app/(app)/recruitment/cycles/[id]/builder/form-builder.tsx:43-46`, `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx:41`, `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx:46`, `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx:51`, `src/app/(app)/recruitment/cycles/[id]/builder/quiz/quiz-builder.tsx:85` and more  
  Impact: A director editing the application form clicks "Add question" or the delete button on a section, the row does not change, and nothing tells them why. Given #708 (server-action ids rotate on every deploy and lock out open tabs), an open builder tab after a deploy silently ignores every edit the director makes. They re-click, assume the drag-and-drop is flaky, and eventually publish a cycle whose fo  
  Fix: One shape for every client-invoked action in this subtree: call through `runAction` from `@/platform/ui/run-action` (which already normalises rejections into `{error}` and handles the stale-deploy reload), keep the result, and render it through a single `error` state per editor surface, the way field-card.tsx:191 and contract-editor.tsx:120-127 already do. Concretely: add a `useActionError()` hook

- **Two buttons on one page produce a vanishing toast and a permanent URL-pinned banner**  
  `feedback/same-page-flash-params-have-opposite-lifetimes` · medium · effort S · 3 subtrees (recruitment decisions, volunteers language review, schedule attendings). The decisions page is the mass-emai  
  Sites: `src/app/(app)/recruitment/cycles/[id]/decisions/actions.ts:28`, `src/app/(app)/recruitment/cycles/[id]/decisions/actions.ts:48`, `src/app/(app)/recruitment/cycles/[id]/decisions/page.tsx:61-70`, `src/platform/ui/toast/flash.ts:544-550`, `src/app/(app)/volunteers/spanish-review/page.tsx:242-243` and more  
  Impact: A recruitment lead releases acceptances and gets a pill that disappears in four seconds; they send the not-selected batch and get a banner that never leaves, so refreshing or navigating back re-reads "Sent 47 not-selected emails" for a send that already happened, on a page whose whole job is to make irreversible mass-email state legible. Copying the URL to a colleague hands them a stale confirmati  
  Fix: Make param lifetime a property of the convention, not of whether someone remembered a registry row. Register the three orphans (`rejected` scoped to `/recruitment/cycles/*/decisions`, `ok` scoped to `/volunteers/spanish-review`, `notice`/`message` scoped to `/schedule/attendings*`) so every flash param is claimed and stripped, and delete the six inline success `<Alert>` branches they back. Then cl

- **Five copy-to-clipboard controls, four feedback shapes, and two report success on failure**  
  `feedback/clipboard-copy-five-implementations-two-lie` · medium · effort S · 5 surfaces: recruitment invites (leads), calendar subscription on /schedule and /my-info (every member), clinic email ro  
  Sites: `src/app/(app)/recruitment/cycles/[id]/invite-panel.tsx:75-81`, `src/modules/schedule/calendar/feed-url-field.tsx:33-40`, `src/platform/ui/email-list.tsx:65-77`, `src/modules/support/components/epic-request-form.tsx:158-169`, `src/modules/support/components/term-batch-tab.tsx:143-154` and more  
  Impact: invite-panel's copy sits inside an Alert reading "Copy this link now. It is not shown again." If the clipboard write is refused (an insecure context, a permission prompt, an unfocused document) the button still says "Copied", the lead closes the panel, and the single-use invite link is destroyed. On /schedule the same class of failure makes the calendar-feed Copy button appear inert, so a voluntee  
  Fix: One `<CopyButton value label />` in src/platform/ui that awaits the write inside a try/catch, pushes a `useToast()` success or error toast instead of mutating its own label, and falls back to selecting the text when the API is unavailable. Replace all five call sites; delete the three local `copied`/`copyState` states and their five timers. This also gives copy feedback the same channel as every o

- **Navigating to Support or Outreach shows a skeleton of the home dashboard and announces "Loading your dashboard"**  
  `feedback/wrong-module-gets-the-dashboard-skeleton` · medium · effort S · 4 in-shell routes with no loading state; /support is reachable by every signed-in member and deep-linked from shift-remi  
  Sites: `src/app/(app)/loading.tsx:1-5`, `src/app/(app)/dashboard-skeleton.tsx:11-14`, `src/app/(app)/schedule/loading.tsx:1-5`, `src/app/(app)/admin/loading.tsx:1-5`  
  Impact: Clicking Support from anywhere paints a greeting bar, a large next-shift hero and module tiles for a beat before the ticket list appears , the wrong page, laid out convincingly. A screen-reader user is told "Loading your dashboard" while navigating to the IT help desk. Support is also the only (app) module with no loading feedback beyond the 3px top bar once you are inside it.  
  Fix: Two moves, both trivial. First, add `loading.tsx` returning `<PageLoading label="Loading <module>" />` for /support, /outreach and /notifications, matching the nine that already exist. Second, stop the fallback from lying: move DashboardSkeleton's render out of `(app)/loading.tsx` into a route-group-scoped `(app)/@dashboard` or simply have `(app)/loading.tsx` render `<PageLoading />` and let `/` o

- **Two CSV exports fire a network round trip with no pending feedback while a sibling shows "Preparing…"**  
  `feedback/csv-export-pending-state-missing` · medium · effort S · 3 export controls across the Volunteers module: directory (leadership), offboarding transition and flagged tabs (departm  
  Sites: `src/modules/volunteers/components/transition-tab.tsx:95-102`, `src/modules/volunteers/components/transition-tab.tsx:155-157`, `src/modules/volunteers/components/flagged-tab.tsx:57-64`, `src/modules/volunteers/components/flagged-tab.tsx:97-99`, `src/modules/volunteers/components/directory-export-button.tsx:26-66`  
  Impact: A director on a slow connection presses "Export emails CSV", nothing visibly happens for several seconds, and presses again. Each press is a separate server-audited export (the component's own doc explains the POST exists so exports are audited), so the audit log records downloads nobody meant to perform, and two files land in Downloads. The directory export on a neighbouring page handles this cor  
  Fix: Promote directory-export-button.tsx into `src/platform/ui/export-button.tsx` as `<ExportButton endpoint body label />`: it already owns the POST-not-link reasoning, the busy label, the blob lifecycle and the filename parsing. Have both offboarding tabs render it instead of a bare Button plus a local `exportError`, and route its failure through the shared toast rather than three different inline sh

- **Autosave confirmations are unannounced chips on two different timers, invisible to assistive tech**  
  `feedback/transient-saved-chips-with-hand-set-timers` · medium · effort S · The Form, Quiz and Contract builder tabs of every recruitment cycle, plus /admin/contract which mounts ContractEditor in  
  Sites: `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:188-193`, `src/app/(app)/recruitment/cycles/[id]/builder/field-card.tsx:221-224`, `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:118-127`, `src/app/(app)/recruitment/cycles/[id]/builder/contract/contract-editor.tsx:236-241`, `src/platform/ui/toast/toast.tsx:59`  
  Impact: A director editing the application form gets a 1.5-second visual flicker as the only proof their question saved, and the contract builder next door gives 2 seconds; a screen-reader user gets nothing on either, so the only way to know an autosave landed is to reload. On the form builder this compounds with the dropped-error problem: a silent failure and a missed 1.5s success look identical.  
  Fix: Retire both chips and confirm through the toast: on `{ok:true}` call `useToast()({tone:"success", message:"Saved."})`, which already carries `role="status"`, one duration, and the app's single visual language for "that worked". If per-field autosave is too chatty for a toast per keystroke-blur, add a `<SavedIndicator saved />` primitive in src/platform/ui that renders the check chip with `role="st

- **Transient inline confirmations are announced on 2 of 7 surfaces; the other 5 swap a label and vanish**  
  `a11y-responsive/transient-confirmations-silent` · medium · effort S · 5 clipboard controls across recruitment, schedule, my-info and the shared EmailList primitive, plus the two autosaving b  
  Sites: `src/modules/support/components/epic-request-form.tsx:478`, `src/modules/support/components/term-batch-tab.tsx:243`, `src/modules/schedule/calendar/feed-url-field.tsx:40`, `src/platform/ui/email-list.tsx:77`, `src/app/(app)/recruitment/cycles/[id]/invite-panel.tsx:81` and more  
  Impact: A screen-reader user copying the single-use applicant invite link on /recruitment/cycles/[id] (invite-panel.tsx, a link shown exactly once) gets no confirmation that the copy succeeded, and the same for the calendar feed URL on /schedule and /my-info and the clinic email roster in the schedule builder. In the form and contract builders, per-field autosave is silent: there is no way to know a chang  
  Fix: Route all seven through the existing toast channel rather than a seventh local timer: `useToast()` (src/platform/ui/toast/toast.tsx) already renders `role="status"` for non-error tones and owns the dismiss timing. Where a toast is too heavy for a per-field autosave chip, add a tiny `<LiveMessage>` export beside Spinner that renders a `role="status"` sr-only span, and have field-card and contract-e

- **Record saves confirm on half the editors and are silent on the other half**  
  `detail-and-form/save-confirmation-split` · medium · effort M · Roughly 40 create/edit server actions across admin, schedule, volunteers, learning and outreach. Touches every staff rol  
  Sites: `src/app/(app)/admin/people/[id]/page.tsx:142`, `src/app/(app)/admin/people/[id]/page.tsx:210`, `src/app/(app)/admin/people/[id]/page.tsx:109`, `src/app/(app)/schedule/attendings/[id]/page.tsx:69`, `src/app/(app)/schedule/attendings/new/page.tsx:56` and more  
  Impact: A director presses Save on a course, an EHS training, an audience scope, a board meeting, or an attending and the page comes back looking exactly the same, with no toast. The common reaction is to press Save again. On the attending pages it is worse: the save throws them back to the roster list with no message, so the only way to check is to re-open the record. And on /admin/people/[id] the field   
  Fix: `src/platform/actions.ts:15` already owns the error-to-redirect shape for server actions (`runAction`, 7 files). Give it a success half: `successRedirect` gains a sibling `successFlash?: string` (default `"saved"`) that appends `?saved=1` to the success redirect, and make `revalidate`-only calls also redirect to the same path with the flag rather than returning silently. Then migrate the ~40 hand-

- **The same two refusal sentences are hardcoded in three files that can drift apart silently**  
  `feedback/error-copy-triplicated-across-page-and-classifier` · low · effort S · 2 incidents pages (any member filing a concern; every reviewer and strike-issuing director) plus the classifier every ot  
  Sites: `src/platform/ui/toast/flash.ts:265-267`, `src/app/(app)/incidents/page.tsx:43-48`, `src/app/(app)/incidents/strikes/page.tsx:68-77`, `src/platform/ui/toast/flash.ts:298-303`  
  Impact: A reporter refused on /incidents and the same reporter refused on /incidents/mine can be told two different things for one underlying condition, with no way for either to know which is authoritative. More practically, this is the mechanism by which the app's refusal vocabulary fragments: every new page with one page-specific code has to re-copy the shared ones.  
  Fix: Export the shared codes as a plain map from flash.ts (`export const SHARED_ERROR_TEXT = { forbidden: "…", validation: "…" }`) and build both `ERROR_CODE_TABLE` and the two page dictionaries from it: `const ERROR_MESSAGES = { ...SHARED_ERROR_TEXT, "subject-not-found": "…" }`. That keeps each page's suppression and its own vocabulary intact while making the shared half single-source. It also makes t

- **Attending forms render an inline error the toast reader also fires and then strips**  
  `detail-and-form/form-error-channel-split` · medium · effort S · Ten create/edit routes across schedule and admin, plus the shared flash registry every module depends on. Admins and Fac  
  Sites: `src/app/(app)/schedule/attendings/new/page.tsx:68`, `src/app/(app)/schedule/attendings/[id]/page.tsx:114`, `src/app/(app)/schedule/attendings/[id]/page.tsx:115`, `src/app/(app)/schedule/specialties/new/page.tsx:13`, `src/app/(app)/admin/departments/new/page.tsx:12` and more  
  Impact: A Faculty Relations director who submits a duplicate attending name sees the failure twice, then watches the inline copy disappear from under them a beat later; the toast is already fading, so the reason for the refusal can be gone before it is read. On the specialty and admin forms the same failure class is a toast that floats over an unrelated corner of the screen while the offending field is un  
  Fix: One channel per failure class, stated in the house style: a form-submission refusal goes to the toast (the existing `?error=` convention), and a page renders an inline Alert only when its pathname is registered in `SUPPRESSED_ERROR_PARAMS`. Delete the three Alert lines on the attending pages (attendings/new:68, attendings/[id]:114-115) and let them behave like the specialty and admin pairs, or, if

- **Four different validation-failure behaviours; the longest form in the app does nothing at all**  
  `a11y-responsive/onboard-contract-error-recovery` · medium · effort M · The public onboarding contract (every accepted recruit, once, on a link they cannot re-request), plus the apply wizard,   
  Sites: `src/app/onboard/[token]/contract-field.tsx:93`, `src/app/onboard/[token]/contract-field.tsx:255`, `src/app/onboard/[token]/onboard-form.tsx:88`, `src/app/apply/[slug]/apply-wizard.tsx:395`, `src/app/(app)/training/training-quiz.tsx:63` and more  
  Impact: The onboarding contract is one uninterrupted scroll (onboard-form.tsx's own comment at :88-101 records that nothing persists until submit, mitigated only by a beforeunload warning). A newly accepted recruit who submits with a missing field stays at the bottom of the page, hears nothing, sees nothing move, and has to hunt upward through the whole document for red text. This is a token-authenticated  
  Fix: One shape for all four: on a failed submit, render the error summary in an `<Alert tone="error">` (which already emits `role="alert"`, alert.tsx:38-39), move focus to it, and give every per-field message `role="alert"` the way field-preview, SignaturePad and UploadSizeField already do. The cheapest structural version is to close the gap in the primitive rather than in four callers: add an `error` 


### T7. Destructive actions are the least protected

Confirmation and visual emphasis are applied to the reversible action and withheld from the one-way one.

*3 confirmed, 2 unverified*

- **Deny, Revoke, Withdraw and Delete ship bare while their reversible siblings get ConfirmButton**  
  `feedback/destructive-confirm-policy-is-inverted-or-absent` · medium · effort S · 6 surfaces spanning schedule approvals (department directors and Faculty Relations), outreach scopes and campaigns (outr  
  Sites: `src/modules/schedule/components/pending-requests.tsx:137-142`, `src/modules/schedule/components/pending-requests.tsx:155-157`, `src/modules/schedule/components/attending-pending-requests.tsx:90-99`, `src/modules/schedule/components/attending-pending-requests.tsx:102`, `src/app/(app)/outreach/scopes/[id]/page.tsx:218` and more  
  Impact: A director on a trackpad mis-clicks Deny instead of Approve and the volunteer's swap request is refused with no undo and no second chance; the requester must notice and re-file. An outreach admin loses an audience scope, or every grant on it, to one stray click on a control styled like a neutral outline button. A recruitment lead withdraws a live invite link that cannot be reissued to the same per  
  Fix: State the policy once and apply it mechanically: any action that removes access, refuses a person's request, or destroys a record routes through `<ConfirmButton>`, and nothing else does. Swap the six bare controls above to ConfirmButton with an outcome-naming confirmLabel ("Deny this request?", "Delete this scope and its N grants?", "Cancel the scheduled send?", "Withdraw this invite link?"), and 

- **Delete scope and Revoke grant ship unconfirmed while identical acts use ConfirmButton**  
  `detail-and-form/destructive-confirm-gaps` · low · effort S · Two controls on /outreach/scopes/[id], held by outreach admins with `outreach.manage_scopes`; the rule closes the gap fo  
  Sites: `src/app/(app)/outreach/scopes/[id]/page.tsx:229`, `src/app/(app)/outreach/scopes/[id]/page.tsx:218`, `src/app/(app)/outreach/identities/page.tsx:463`, `src/modules/admin/components/roster-panel.tsx:82`, `src/modules/admin/components/assignment-form.tsx:281` and more  
  Impact: An outreach admin one mis-click away from destroying an audience scope that campaigns are bound to, with no confirm step and no undo, on the one page in the module that also refuses to say anything after the delete succeeds. A keyboard or screen-reader user gets none of ConfirmButton's announced arm step here even though every comparable control in the app has it.  
  Fix: Route both controls through `ConfirmButton` (`label="Delete scope"` / `label="Revoke"`), which is a two-line change per site and inherits the danger variant, focus handling and pending guard. Then state the rule in docs/ui-house-style.md §1 (ConfirmButton is currently absent from the catalog table despite 49 consumers): any action that deletes a record or removes an access grant goes through Confi

- **Seven destructive buttons announce "Delete permanently? Confirm?" by appending the primitive default**  
  `copy-terminology/confirm-step-doubled-question` · medium · effort S · Every destructive action in Admin, Schedule specialties, Learning and Volunteers offboarding. ConfirmButton is imported   
  Sites: `src/app/(app)/schedule/specialties/[id]/page.tsx:109`, `src/app/(app)/admin/terms/[id]/page.tsx:263`, `src/modules/admin/components/roles-panel.tsx:198`, `src/modules/admin/components/roles-panel.tsx:256`, `src/modules/admin/components/roster-panel.tsx:489` and more  
  Impact: A screen-reader user activating Delete on an attending specialty hears "Delete permanently? Confirm?" from the aria-live region: two questions, no object named. Sighted users get an armed label longer than its container. In the other direction, the button that erases a volunteer's course progress on /learning/dashboard arms to a bare "Confirm?" naming nothing at all.  
  Fix: One confirm-step shape, matching the apply portal: `confirmLabel` is a single question naming the object, plus its consequence when the action is irreversible ("Delete this specialty?", "Remove this assignment?", "Archive this term?", "Reset this learner's progress? Their score and completion are cleared."). Strip the trailing " Confirm?" from the seven doubled sites, drop the redundant `confirmLa

- **On /schedule/requests, Deny is a solid red button and Approve is a hairline outline one** `[unverified]`  
  `hierarchy-density/destructive-emphasis-inverted` · - · effort S · 2 panels on /schedule/requests, both also mounted for department directors and Faculty Relations; every schedule approve  
  Sites: `src/modules/schedule/components/pending-requests.tsx:139`, `src/modules/schedule/components/pending-requests.tsx:155`, `src/modules/schedule/components/attending-pending-requests.tsx:88`, `src/modules/schedule/components/attending-pending-requests.tsx:102`, `src/platform/ui/confirm-button.tsx:84` and more  
  Impact: The routine, high-frequency action (approving a swap) is the visually weakest control on the card, and the rare, one-way action (denying a volunteer's shift change) is the one the eye lands on and the thumb reaches for first. That is a mis-click risk on a decision the requester cannot undo.  
  Fix: Make Approve the visual primary and route Deny through the same two-click ConfirmButton every other destructive action uses: `<SubmitButton variant="primary" size="sm">Approve</SubmitButton>` behind the existing stale-date disable, and `<ConfirmButton label="Deny" confirmLabel="Deny this request?" size="sm" />` keeping the optional reason Input. Apply identically in both panels so the stacked pair

- **"Primary" is applied to filtering on 4 pages and to nothing on 3, and /admin/settings renders ~73 of them** `[unverified]`  
  `hierarchy-density/primary-button-inflation` · - · effort S · 8 filterable lists across admin, volunteers, incidents, recruitment and learning, plus /admin/settings; admins, director  
  Sites: `src/app/(app)/admin/settings/page.tsx:203`, `src/app/(app)/volunteers/master/page.tsx:378`, `src/app/(app)/volunteers/directory/page.tsx:274`, `src/app/(app)/incidents/review/page.tsx:180`, `src/app/(app)/incidents/strikes/page.tsx:570` and more  
  Impact: When filtering a table looks exactly like recording a disciplinary strike, the eye stops treating brand fill as "this is the thing to do" and starts ignoring it. On /admin/settings nothing on the page leads at all, so an admin changing one notification route scans 73 identical Save buttons to find the row they are in.  
  Fix: State and enforce one primary per view: `variant="primary"` is the page's single most consequential action. Downgrade every filter-bar submit to `variant="outline"` (4 sites), matching admin/people, admin/audit and recruitment/history which already do it. On /admin/settings, group each category's fields into one `<Card>` with `FormSection` per group and one `FormActions`+`SubmitButton` per categor


### T8. Lists behave differently on every page

Filtering, sorting, paging, counting and opening a row are re-decided list by list.

*8 confirmed, 2 unverified*

- **Half the filter bars label their controls visibly, half ship aria-label-only boxes**  
  `list-surfaces/filter-labels-visible-on-half-the-app` · medium · effort S · 5 filter bars on admin's four monitoring/roster lists plus recruitment history; every admin and compliance manager.  
  Sites: `src/app/(app)/admin/people/page.tsx:104`, `src/app/(app)/admin/audit/page.tsx:53`, `src/app/(app)/admin/email/page.tsx:426`, `src/app/(app)/admin/notifications/page.tsx:~236`, `src/app/(app)/recruitment/history/page.tsx:62` and more  
  Impact: On /admin/audit an admin sees two blank boxes and a Filter button; the left one is a free-text action-contains search and the right one is an entity-type picker, and nothing on screen says so. Once a value is typed the placeholder is gone and the field has no name at all, for sighted users and for anyone reviewing the page at zoom.  
  Fix: Make the visible-label form the rule: the FilterBar primitive's `<FilterField label>` slot renders `<Field label>` unconditionally, and the five aria-only bars migrate. The house style already names Field/Input/Select as the form recipe; the only reason these five differ is that they predate it.

- **Five record lists are ul-of-cards instead of Table, in three different row shapes**  
  `list-surfaces/record-lists-drawn-as-ul-of-cards` · medium · effort M · 5 list surfaces across outreach, admin email, recruitment cycles and learning; campaign senders, email admins, recruitme  
  Sites: `src/app/(app)/outreach/campaigns/page.tsx:59`, `src/app/(app)/outreach/scopes/page.tsx:56`, `src/app/(app)/admin/email/templates/page.tsx:27`, `src/app/(app)/recruitment/cycles/[id]/emails/page.tsx:23`, `src/app/(app)/learning/manage/page.tsx:29` and more  
  Impact: A director browsing /outreach/campaigns gets name + date + status with no column headers and no way to scan by status, while the structurally identical /outreach/identities one tab away is a real Table with headers. On /learning/manage the row's state is a run-on sentence rather than the Badges the same status gets on /learning.  
  Fix: Move all five to `Table/THead/TR/TH/TD` with named column headers, and render the secondary state through `<Badge>` in its own column (campaigns already does; the other four copy it). That is the shape 48 files already use, it brings the refetch dim for free, and it removes the two competing ul shells entirely.

- **The filtered-empty state has four container shapes and only two of ten name the filter as the cause**  
  `list-surfaces/filtered-empty-state-four-shapes` · medium · effort M · 8 list surfaces including the two busiest triage queues (support/all, incidents/review); every filtering role.  
  Sites: `src/app/(app)/admin/email/page.tsx:465`, `src/app/(app)/admin/notifications/page.tsx:249`, `src/modules/admin/components/people-table.tsx:22`, `src/modules/admin/components/audit-table.tsx:17`, `src/modules/support/components/request-list.tsx:95` and more  
  Impact: An IT manager filters /support/all to Priority=High and reads "No requests yet." That sentence is false and it reads like the ticket history was lost. On /incidents/review a filter that matches nothing removes the table headers too, so the reviewer cannot see which columns they were filtering.  
  Fix: One shape: `<EmptyState icon={SearchX} title="No <things> found" description="No <thing> matches these filters. Clear a filter above to widen the search."/>` when filters are applied, `<EmptyState title="No <things> yet" description=...>` when not, chosen by the same `hasFilters` boolean the Clear link already needs. Additionally export `<TableEmpty colSpan>` from table.tsx that renders `<TR><TD c

- **Seven filtered lists break the house rule that an empty filtered list must name the filter**  
  `copy-terminology/filtered-empty-copy` · medium · effort M · /support/all, /admin/people, /admin/audit, /volunteers/master, /incidents/strikes, /incidents/review, /recruitment/histo  
  Sites: `src/modules/support/components/request-list.tsx:93-99`, `src/modules/admin/components/people-table.tsx:19-24`, `src/modules/admin/components/audit-table.tsx:14-18`, `src/app/(app)/volunteers/master/page.tsx:395-397`, `src/app/(app)/incidents/strikes/page.tsx:591-593` and more  
  Impact: An IT manager filters /support/all to Priority: High and reads "No requests yet." on a queue holding hundreds of tickets. That sentence asserts the opposite of the truth. On /admin/people and /volunteers/master, "No X found." is ambiguous between "your filter is too narrow" and "the query failed", so people re-run it or file a bug instead of clearing a filter.  
  Fix: One sentence pair applied at all seven sites: when any filter or search term is set, `EmptyState title="No <things> match these filters" description="Widen your search or clear a filter above."`; when nothing is set, the true-empty copy ("No <things> yet"). `RequestList` and `PeopleTable` receive their rows from a filtered parent, so pass a `filtered: boolean` prop; the parents already compute `ha

- **Seven lists are unbounded findMany calls and three more truncate with three different disclosures**  
  `list-surfaces/unbounded-and-silently-truncated-lists` · medium · effort L · 7 unbounded lists plus 3 capped ones; every member (their own tickets and reports) and every admin (terms, departments,   
  Sites: `src/modules/support/services/tech-request.ts:445`, `src/modules/incidents/services/report.ts:691`, `src/platform/email/campaigns/service.ts:136`, `src/platform/email/audience/scopes.ts:114`, `src/app/(app)/admin/terms/page.tsx:17` and more  
  Impact: A four-year volunteer opening /support scrolls their entire ticket history in one unbroken list with no search and no paging, while /support/all, which renders the same RequestList component, has five filters and a pager. On the capped lists, the message that data is being hidden is a different size and a different token on every page, so it reads as incidental prose rather than a control.  
  Fix: Two moves. (1) Give /support and /incidents/mine the same Pagination + FilterBar their manager-facing twins already have; add `take` to the four unbounded services. (2) Replace the three bespoke truncation sentences with one `<ListTruncationNotice shown total hint>` exported alongside Pagination, rendering an `<Alert tone="info">`-shaped line on one token, and settle a single default page size (25

- **Opening a record from a list is a first-cell link, a trailing Edit button column, or the whole card**  
  `list-surfaces/row-open-affordance-three-shapes` · medium · effort S · 7 list surfaces, most of them in Admin where the inconsistency is one nav tab wide; every admin and learning director.  
  Sites: `src/modules/admin/components/people-table.tsx:50`, `src/app/(app)/admin/terms/page.tsx:47`, `src/app/(app)/admin/departments/page.tsx:52`, `src/app/(app)/admin/subcommittees/page.tsx:44`, `src/app/(app)/learning/manage/page.tsx:32` and more  
  Impact: An admin who has learned to click the Code cell on /admin/terms clicks the Code cell on /admin/departments and nothing happens; the affordance moved to an unlabelled column at the far right. The empty `<TH></TH>` also gives screen-reader users a nameless column header on two of the four Admin lists.  
  Fix: Settle on first-cell link as the single row-open gesture (it is the majority: people, terms, support, recruitment, incidents) and reserve the trailing column strictly for destructive or secondary actions, headed `<TH><span className="sr-only">Actions</span></TH>` the way incidents/strikes already does. Departments, subcommittees, learning/manage and cycle emails migrate; the two whole-card-link li

- **The result count sits in four different places and three phrasings across ten lists**  
  `list-surfaces/result-count-four-placements` · medium · effort S · 9 list surfaces across admin, volunteers, incidents, support and recruitment; every filtering role.  
  Sites: `src/app/(app)/admin/people/page.tsx:85`, `src/app/(app)/admin/audit/page.tsx:43`, `src/app/(app)/admin/email/page.tsx:472`, `src/app/(app)/volunteers/master/page.tsx:394`, `src/app/(app)/volunteers/directory/page.tsx:285` and more  
  Impact: The number that tells a manager how big their filtered result is moves to a different part of the screen on every page: for the same person going /admin/people to /volunteers/master to /support/all it is in the header, then above the table, then inside the filter row. On the incidents queues it loses its thousands separator.  
  Fix: Give FilterBar a `resultCount={{ total, noun: "report" }}` prop that renders one fixed slot on the trailing edge of the filter row (the request-filters/applicants position, which keeps it next to the controls that changed it), always through `total.toLocaleString()` and a shared singular/plural helper. Remove the count from PageHeader descriptions and from the standalone `<p>`s. The empty case sto

- **The list result count has five shapes and two number formats, and one page shadows the Pagination primitive to invent a sixth** `[unverified]`  
  `data-display/result-count-five-shapes` · - · effort S · 9+ list surfaces across volunteers, admin, recruitment, support and incidents. Every user who filters or pages a list.  
  Sites: `src/platform/ui/pagination.tsx:27-29`, `src/app/(app)/volunteers/spanish-review/page.tsx:735-778`, `src/app/(app)/admin/people/page.tsx:86-88`, `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:168-170`, `src/modules/support/components/request-filters.tsx:153-155` and more  
  Impact: A 1,204-row people list reads "1,204 people" in Admin and "1204 members" on the compliance master view. On the language review history the pager says "1-25 of 300" with text links; on every other paginated list it says "Page 1 of 12" with buttons and dims the rows while refetching, so the one page that most needs the refetch cue is the one without it.  
  Fix: Add `<ResultCount total filtered? noun />` to src/platform/ui/pagination.tsx alongside the pager: one class string, `toLocaleString()` always, proper pluralization, and the house-style rule that a filtered count names the filter. Give Pagination an optional `total` + `pageSize` so it can render "26-50 of 300" itself where a page wants the range. Then delete the local Pagination in spanish-review/p

- **Every paginated list writes its own count sentence, and one shadows the Pagination primitive's words**  
  `copy-terminology/list-count-and-pager-copy` · medium · effort M · Every paginated or filtered list: /volunteers/master, /volunteers/directory, /volunteers/spanish-review, /admin/people,   
  Sites: `src/platform/ui/pagination.tsx:28-30`, `src/platform/ui/pagination.tsx:34-46`, `src/app/(app)/volunteers/spanish-review/page.tsx:735-777`, `src/app/(app)/volunteers/master/page.tsx:395-397`, `src/app/(app)/volunteers/directory/page.tsx:286-289` and more  
  Impact: A compliance manager paging /volunteers/master reads "Page 2 of 9" with Prev/Next, then opens Language review one tab over and gets "26-50 of 214" with Previous/Next. Two pagers, two mental models, one module. The count sentence also moves between the page header, above the table, and inside the filter bar depending on the list, so there is no single place to look for "how many did my filter match  
  Fix: Give `Pagination` an optional `total` prop and render one line, `{first}-{last} of {total}`, beside Prev/Next; that is strictly more useful than "Page 2 of 9" and is what the spanish-review author reached for. Delete the local `Pagination` at `spanish-review/page.tsx:735-777` and import the primitive. Then adopt one placement and shape for the standalone count: a single `<p className="text-sm text

- **/incidents/strikes stacks 15 controls above row one; its sibling queue stacks 5** `[unverified]`  
  `hierarchy-density/control-wall-above-content` · - · effort M · 2 incidents pages plus the pattern for any future ledger; incident reviewers and department directors.  
  Sites: `src/app/(app)/incidents/strikes/page.tsx:379`, `src/app/(app)/incidents/strikes/page.tsx:529`, `src/app/(app)/incidents/strikes/page.tsx:584`, `src/app/(app)/incidents/review/page.tsx:127`, `src/app/(app)/incidents/review/page.tsx:190` and more  
  Impact: A reviewer opening the strikes ledger to look something up scrolls past a large blank data-entry form every time, and the ledger, the reason they came, starts below the fold. Directors, who can read the ledger but cannot issue, do not see the form at all, so the two audiences experience two structurally different pages under one nav item.  
  Fix: Move recording a strike to `/incidents/strikes/new`, reached from a `buttonClasses("primary", "sm")` "Record action" in the PageHeader action slot, matching the four admin lists and the module's own /incidents report page. Rebuild the form there with `FormSection` + `Field` in a two-column grid instead of the flex-wrap of `w-*` wrappers, so it stops re-flowing. /incidents/strikes then has the iden


### T9. Detail pages and forms have no agreed shape

Where a record is edited, where its status lives and where Save sits are all per page.

*7 confirmed, 1 unverified*

- **A record's active state is a header Badge on five detail pages, a bare checkbox on five**  
  `detail-and-form/record-status-buried` · medium · effort S · Five detail pages plus the five list pages they are reached from. Admins, Faculty Relations, learning managers and compl  
  Sites: `src/app/(app)/admin/people/[id]/page.tsx:234`, `src/app/(app)/admin/terms/[id]/page.tsx:249`, `src/app/(app)/recruitment/cycles/[id]/page.tsx:150`, `src/app/(app)/incidents/[id]/page.tsx:218`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:79` and more  
  Impact: An admin clicks an obviously greyed 'Inactive' department row and lands on a page whose header says nothing about it; they have to scroll past six fields and an Epic block to find an unchecked box. Deactivation is this app's soft delete, so 'is this record live?' is the single most load-bearing fact on the page, and on half the record types it is the least visible thing on it.  
  Fix: Give the five checkbox-only detail pages the same `PageHeader action={<Badge …>}` the other five already use, driven off the record's own `isActive`. Keep the checkbox as the control; the badge is the readout. Concretely: `admin/departments/[id]/page.tsx:83`, `admin/subcommittees/[id]/page.tsx:42`, `schedule/attendings/[id]/page.tsx:112`, `learning/manage/[courseId]/page.tsx:53` and `volunteers/eh

- **Shared create/edit forms have three signatures, so two create pages say only 'Save'**  
  `detail-and-form/create-edit-form-signature` · medium · effort S · Six shared form components serving twelve routes across admin and schedule. Admins and Faculty Relations.  
  Sites: `src/modules/admin/components/department-form.tsx:14`, `src/modules/admin/components/subcommittee-form.tsx:10`, `src/modules/admin/components/attending-specialty-form.tsx:10`, `src/modules/admin/components/person-form.tsx:37`, `src/modules/admin/components/term-form.tsx:69` and more  
  Impact: On the two create pages that say "Save", the button does not name what it will do, and it is the same word the edit page uses, so the create and edit screens are only distinguishable by their H1. If anyone ever wires the term edit route the button will confidently say "Create term" on a form that updates.  
  Fix: One signature for every shared record form: `{ action, mode: "create" | "edit", record? }`, with the submit rendered as `<SubmitButton>{mode === "create" ? "Create <thing>" : "Save changes"}</SubmitButton>` (folding in the SubmitButton fix above). `attending-specialty-form.tsx` is already exactly this shape and should be the template. Add `mode` to person-form.tsx, term-form.tsx and attending-form

- **A form's submit lands in FormActions or inside the field row, both on one page**  
  `detail-and-form/form-action-row-two-shapes` · medium · effort M · 30 forms across recruitment, schedule, admin, volunteers, incidents and outreach. Reviewers, directors and admins, on th  
  Sites: `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:97`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:194`, `src/app/(app)/recruitment/interviews/[interviewId]/page.tsx:223`, `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:289`, `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx:323` and more  
  Impact: On the interview detail page a reviewer sees three write forms whose Save buttons sit at three different heights relative to their fields, so the eye has to re-find the control on every card. The hand-set widths mean the same Notes field is 12rem on one form and full-width on another within a single screen.  
  Fix: Add a second export to `src/platform/ui/form.tsx`: `FormRow` , the `flex flex-wrap items-end gap-3` container with a `<FormRow.Field width="sm"|"md"|"grow">` wrapper that owns the three widths in one place , and require the submit inside it to be the last child, so the whole shape is declared rather than re-measured. Migrate the 30 inline forms; the four on the applicant detail page and the three 

- **Records are created on a /new route or inline above their list, with no rule**  
  `detail-and-form/create-route-vs-inline` · medium · effort M · 15 record types across six modules; the create gesture is the first thing every staff role learns in a module.  
  Sites: `src/app/(app)/admin/subcommittees/new/page.tsx:32`, `src/app/(app)/schedule/specialties/new/page.tsx:47`, `src/app/(app)/learning/manage/page.tsx:19`, `src/app/(app)/volunteers/ehs/manage/page.tsx:23`, `src/app/(app)/outreach/scopes/page.tsx:29` and more  
  Impact: A director who learns "click the button in the page header to add one" on /admin/departments finds no such button on /learning/manage, /volunteers/ehs/manage or /recruitment/events; the create control is somewhere in the page body instead, above or below the list depending on the page. On /recruitment/events the seven-field form sits permanently expanded above the table, so the list is pushed off   
  Fix: One rule, stated in the house style: a record with more than two editable fields is created on a `/new` route reached from the PageHeader `action` slot, using the same shared form component the `[id]` route renders; a one-field quick-add may stay inline above the list. That moves recruitment/events and board-meetings onto `/new` routes (both already have a `[id]` page to redirect to) and leaves le

- **Edit routes disagree on whether they are a titled form or the record's own page**  
  `detail-and-form/edit-route-identity` · low · effort S · Ten `[id]` routes across admin, schedule, learning, volunteers and outreach. Admins, Faculty Relations, learning manager  
  Sites: `src/app/(app)/admin/departments/[id]/page.tsx:83`, `src/app/(app)/schedule/specialties/[id]/page.tsx:88`, `src/app/(app)/schedule/attendings/[id]/page.tsx:112`, `src/app/(app)/learning/manage/[courseId]/page.tsx:53`, `src/app/(app)/volunteers/ehs/manage/[trainingId]/page.tsx:30` and more  
  Impact: A director opening two records in two tabs cannot tell them apart from the browser tab title, because one reads 'Edit DERM' and the other reads the person's name. On /schedule/attendings/[id] the page announces itself as an edit form and then opens on an unrelated access panel, so the first click after landing is a scroll.  
  Fix: One shape: an `[id]` route is the record's page, titled with the record's own name (`title={record.name}`), with its status in the `action` slot (see the record-status finding) and its own edit form as the FIRST section on the page. Retitle the seven `Edit …` / `Edit: …` pages to the bare record name, and move the Hub-access Card on `schedule/attendings/[id]` below `<AttendingForm>` so it sits whe

- **A term can be created but never corrected, and TermForm's edit path is dead code**  
  `detail-and-form/terms-uneditable-dead-form` · medium · effort M · One record type, but it is the term: every roster, schedule, clinic date and recruitment cycle hangs off it. Admins with  
  Sites: `src/modules/admin/components/term-form.tsx:23`, `src/modules/admin/components/term-form.tsx:14`, `src/app/(app)/admin/terms/new/page.tsx:52`, `src/app/(app)/admin/terms/[id]/page.tsx:246`, `src/app/(app)/admin/departments/[id]/page.tsx:84` and more  
  Impact: A mistyped term end date, or a term named "Fall 2026" that should read "Fall 2026-27", cannot be corrected from the product at all. Term dates drive clinic-date generation and the whole schedule, so the fix today is a database edit. Meanwhile the code carries a fully written edit form that a reader would reasonably assume is wired up.  
  Fix: Wire the existing form: add a `Details` section to `admin/terms/[id]/page.tsx` rendering `<TermForm action={updateAction} mode="edit" term={term} />` above the Lifecycle section, matching where departments/[id] and subcommittees/[id] put theirs, with an `updateTerm` action redirecting to `?saved=1`. Freeze `code` on edit the way `DepartmentForm` and `AttendingSpecialtyForm` already do (`disabled={

- **Five sibling admin create/edit forms label their submit four different ways**  
  `copy-terminology/form-submit-verb-drift` · low · effort S · /admin/people/new and [id], /admin/terms/new, /admin/departments, /admin/subcommittees, /schedule/attendings/new and [id  
  Sites: `src/modules/admin/components/person-form.tsx:139-142`, `src/modules/admin/components/term-form.tsx:68-71`, `src/modules/admin/components/department-form.tsx:167-170`, `src/modules/admin/components/subcommittee-form.tsx:33-36`, `src/modules/admin/components/attending-specialty-form.tsx:71-74` and more  
  Impact: An admin creating four record types in one sitting is asked to "Create department", then "Create subcommittee", then "Save" for a person and "Create term" for a term. On the person form "Save" gives no confirmation that a new record is about to exist, which is why people double-submit. On /support/[id] the three Update buttons announce "Saving…" while pending, so the control renames itself under t  
  Fix: One rule: a form that creates a record submits with `Create <thing>`; a form that edits one submits with `Save changes`; a single-control inline editor submits with `Save`. Give `person-form.tsx` and `attending-form.tsx` the same `mode === "create" ? ... : "Save changes"` branch the other three already use, make `term-form.tsx` honour its own `term` prop the same way, and change the three `ticket-

- **PageHeader's action slot carries a primary button, a status badge, or bare underlined text depending on the page** `[unverified]`  
  `hierarchy-density/pageheader-action-slot` · - · effort S · 8 admin and recruitment pages; admins, recruitment directors and reviewers.  
  Sites: `src/app/(app)/admin/email/page.tsx:286`, `src/app/(app)/admin/email/page.tsx:295`, `src/app/(app)/admin/people/page.tsx:91`, `src/app/(app)/admin/terms/page.tsx:25`, `src/app/(app)/admin/departments/page.tsx:19` and more  
  Impact: The top-right of a page is the one position users learn as "the thing this page lets me do". Here it is sometimes the action, sometimes a read-only status, and on /admin/email it is a text link that does not look clickable, which is why the entire email-templates tree is hard to find. The applicants roster's header also sits at a visibly different vertical alignment from its 12 sibling tabs.  
  Fix: Reserve the slot for actions and give PageHeader a second slot for status: `<PageHeader title description status={<Badge/>} action={<Button/>} />`, rendering status as a chip beside the h1 and action right-aligned. Promote /admin/email's two links to `buttonClasses("outline", "sm")` so navigation reads as navigation, move the two Badge actions into the new `status` slot, and let /recruitment/cycle


### T10. Type scale, spacing and emphasis are re-decided per page

Structural rank is drawn at different sizes and insets across pages a director crosses in one session.

*1 confirmed, 8 unverified*

- **SectionHeader ships 2 levels; the app renders section headings at 6 sizes across 38 files** `[unverified]`  
  `hierarchy-density/section-heading-scale` · - · effort M · 38 files across all 9 modules plus the public /onboard tree; every role that reads a carded page, which is every role.  
  Sites: `src/platform/ui/section-header.tsx:6`, `src/app/(app)/my-info/page.tsx:293`, `src/modules/passport/components/service-record-card.tsx:143`, `src/app/(app)/outreach/identities/page.tsx:268`, `src/app/(app)/outreach/scopes/[id]/page.tsx:204` and more  
  Impact: Scanning is learned per page. A director moving Recruitment -> Outreach -> Schedule meets the same structural rank (a card's title) at 12px, 14px, 16px, 18px and 20px, in uppercase on some pages and sentence case on others, so the eye cannot fix on one cue for "this is a new group". On /my-info one card's heading is visibly larger than the nine above it for no reason a member can infer.  
  Fix: Give SectionHeader the levels the app actually uses instead of letting callers patch size through className: keep `eyebrow` and `title`, add `panel` (text-sm font-semibold text-foreground, for the dense sidebar/sub-panel heading the 5 schedule panels want) and `section` (text-lg font-semibold text-foreground, for the page-level group heading schedule/page.tsx:584 and requests:196 want). Then delet

- **Content width and the gap under PageHeader are re-decided per page: 5 widths in one 13-tab workspace** `[unverified]`  
  `hierarchy-density/page-frame-width-rhythm` · - · effort M · ~70 authenticated pages; every role. Worst for recruitment directors (13 tabs) and admins (11 tabs).  
  Sites: `src/platform/ui/app-shell.tsx:112`, `src/app/(app)/recruitment/cycles/[id]/page.tsx:146`, `src/app/(app)/recruitment/cycles/[id]/onboarding/page.tsx:22`, `src/app/(app)/recruitment/cycles/[id]/builder/page.tsx`, `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx:151` and more  
  Impact: Clicking between tabs of one workspace makes the page jump width and re-flow the right margin every time, so the reader loses their place in a table they were reading a moment ago. On a wide monitor a max-w-2xl detail page sits in the left two thirds with 480px of empty canvas beside it, which reads as a broken layout rather than a deliberate reading measure.  
  Fix: Add `PageBody` to src/platform/ui: `<PageBody width="prose"|"wide"|"full">` mapping to `mx-auto w-full max-w-3xl` / `max-w-5xl` / `max-w-full`, owning `space-y-6` between its children and rendering PageHeader in its own slot with a fixed gap. Pick one width per page KIND (list = full, detail/settings = wide, single-form = prose) and apply it across a workspace so every tab of the cycle nav, and al

- **Card offers 2 insets; ~30 sites hand-set 9 different ones through pad={false}** `[unverified]`  
  `hierarchy-density/card-inset-scale` · - · effort M · ~30 sites in 6 modules plus the dashboard and both public shells; every role.  
  Sites: `src/platform/ui/card.tsx:24`, `src/modules/schedule/components/capacity-panel.tsx:76`, `src/modules/schedule/components/readiness-panel.tsx:105`, `src/modules/schedule/components/pending-requests.tsx:69`, `src/modules/schedule/components/attending-pending-requests.tsx:43` and more  
  Impact: Cards in the same column breathe differently, so a reader gets no consistent signal for how much content a card holds. On /schedule/builder the three sidebar panels sit at 16/12px inset next to a main column of p-5 cards, which makes them read as a different kind of object than they are.  
  Fix: Add the two insets the app has repeatedly discovered to the primitive rather than to call sites: `size="panel"` (rounded-2xl, `px-4 py-3`, no shadow) for the schedule sidebar shape, and route every centered empty card through `<Card><EmptyState .../></Card>` so `px-6 py-10` disappears with the 13 ad-hoc bodies. Migrate the six schedule panels and learning/manage:25 to `size="panel"`, collapse the 

- **Peer sections are a Card on one page and a hairline rule on its sibling, and mixed within one page** `[unverified]`  
  `hierarchy-density/section-container-drift` · - · effort S · 5 pages in learning, outreach and admin; directors, senders and admins.  
  Sites: `src/app/(app)/learning/manage/[courseId]/page.tsx:61`, `src/app/(app)/learning/manage/[courseId]/page.tsx:89`, `src/app/(app)/learning/manage/[courseId]/page.tsx:119`, `src/app/(app)/outreach/scopes/[id]/page.tsx:203`, `src/app/(app)/outreach/scopes/[id]/page.tsx:227` and more  
  Impact: A card boundary is the app's only signal for "this is a self-contained group". When the SCORM upload section has no boundary but the two forms above it do, it reads as an afterthought stuck to the bottom of the Assignment card. On /outreach a sender who learns the module on /outreach/identities finds the same information laid out as loose text on /outreach/scopes/[id].  
  Fix: Fix the rule at one grain: a page-level section always renders `<Card>` (or `<Card pad={false}>` when it holds a Table) with a `SectionHeader` as its first child; `border-t` dividers are for splitting content INSIDE a card, never for separating page sections. Wrap /learning/manage/[courseId]'s SCORM section in a Card and give the Course section a `SectionHeader level="title">Course<`, wrap /outrea

- **The same "am I cleared" banner is 17/13px, 18/14px and 14/12px on three pages one click apart** `[unverified]`  
  `hierarchy-density/clearance-banner-scale` · - · effort M · 3 of the 4 pages every volunteer sees on sign-in (/, /my-info, /training) plus /get-started; every member.  
  Sites: `src/modules/my-info/components/clearance-card.tsx:118`, `src/modules/my-info/components/clearance-card.tsx:121`, `src/app/(app)/training/page.tsx:49`, `src/app/(app)/training/page.tsx:50`, `src/app/(app)/training/page.tsx:52` and more  
  Impact: A volunteer who is not cleared meets their own status three times in one session, each time at a slightly different size with the status word carrying different weight, so "what is actually blocking me" has to be re-located on every page. The 1px size differences read as sloppiness rather than as distinct surfaces.  
  Fix: Extract one `<ClearanceBanner cleared eyebrow title body pill />` and one `<ChecklistRow icon label status href />` into src/platform/ui (or src/modules/onboarding/components) on the canonical scale: eyebrow `text-xs font-bold uppercase tracking-wider`, title `text-lg font-bold tracking-tight`, body `text-sm leading-snug`, row label `text-sm font-medium` with the status always a `<Badge>`. Mount b

- **The landing page runs its own h1 size, button geometry and arbitrary-px type scale** `[unverified]`  
  `hierarchy-density/dashboard-own-type-and-button-scale` · - · effort M · / plus /training, /no-access and the get-started tree; every signed-in person on every session.  
  Sites: `src/app/(app)/page.tsx:491`, `src/platform/ui/page-header.tsx:16`, `src/app/(app)/page.tsx:554`, `src/app/(app)/page.tsx:577`, `src/platform/ui/button.tsx:19` and more  
  Impact: The page every signed-in person lands on sets their expectation for the product, and it is the one page that matches none of the others: its title is bigger, its buttons are chunkier, and its labels sit between the sizes used everywhere else. Moving from / into any module reads as a slight downgrade in polish rather than as a change of context.  
  Fix: Put the dashboard on the shared scale rather than the reverse: swap the hand-rolled greeting for `<PageHeader title={greeting} description="Here's what's happening at the clinic this week." />` (its eyebrow becomes `<SectionHeader>`), replace both raw CTA link class strings with `buttonClasses("primary", "md")` and a white-on-brand variant added to button.tsx if the hero genuinely needs one, and r

- **The same summary counts are 24px stat cards on one page and 11px chips on its sibling** `[unverified]`  
  `hierarchy-density/summary-counts-weight` · - · effort S · 6 pages across volunteers, schedule, support and incidents; directors, compliance managers and IT triage.  
  Sites: `src/app/(app)/volunteers/master/page.tsx:297`, `src/app/(app)/volunteers/page.tsx:83`, `src/app/(app)/volunteers/page.tsx:197`, `src/app/(app)/schedule/page.tsx:591`, `src/app/(app)/schedule/full/page.tsx:182` and more  
  Impact: A compliance manager who works /volunteers/master and then opens /volunteers for their own departments has to hunt for the same six numbers at a fifth of the size, tucked beside a heading. On /schedule/full and /support/all the counts that should drive triage are prose or hidden in a dropdown, so the operator scrolls the table to find out how bad the day is.  
  Fix: One rule: a page-level summary of a set the page is about goes in a StatCard row directly under PageHeader; a count that qualifies a single list goes inline as a Badge next to that list's heading. Apply it by replacing volunteers/page.tsx's CountChip with the same StatCard grid master already renders (they read the same `counts` shape, so it lifts unchanged into a shared `<ComplianceStatRow counts

- **The same six compliance counts render as StatCards on one page and Badge chips on its sibling, with different labels and opposite zero handling** `[unverified]`  
  `data-display/stat-row-vs-count-chips` · - · effort M · 5+ surfaces: /volunteers, /volunteers/master, /schedule/full, /recruitment/events/[id], plus the three admin pages that   
  Sites: `src/app/(app)/volunteers/master/page.tsx:296-326`, `src/app/(app)/volunteers/page.tsx:83-85`, `src/app/(app)/volunteers/page.tsx:177-201`, `src/app/(app)/schedule/full/page.tsx:184-194`, `src/app/(app)/recruitment/events/[id]/page.tsx:68-75`  
  Impact: A director who holds both compliance permissions sees the same six numbers as a row of large tiles on Master view and as a huddle of small grey chips one tab away, with the categories renamed and any zero category silently gone, so "nothing expired" and "expired count not shown" look identical. On /schedule/full the day's headcount is buried in a sentence in the page subtitle where every comparabl  
  Fix: Export `<StatRow>` from src/platform/ui/stat-card.tsx: the `grid gap-4 sm:grid-cols-3` wrapper that admin/page.tsx, admin/email, admin/notifications, schedule/page.tsx and master all re-declare, plus a `<StatCard ... hideWhenZero>` opt-in so a page can drop empty categories without hand-building an array. Then delete CountChip and render the six compliance counts as one StatRow on both /volunteers

- **The same two panels are headed "HIPAA Certificate"/"EHS Training" on one page and sentence case on another**  
  `copy-terminology/heading-title-case-islands` · medium · effort S · /my-info, /get-started/hipaa, /volunteers/compliance/[personId], /schedule, /schedule/full, /schedule/builder, /schedule  
  Sites: `src/app/(app)/my-info/page.tsx:354`, `src/app/(app)/my-info/page.tsx:365`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:294`, `src/app/(app)/volunteers/compliance/[personId]/page.tsx:320`, `src/modules/my-info/components/hipaa-panel.tsx:138` and more  
  Impact: A compliance manager moving from a member's own page to the staff view of that member sees the identical panel relabelled, which reads as a different feature rather than the same one from a different seat. Within /schedule/requests, one panel in Title Case and the next in sentence case makes the two approval queues look like they came from different products, which is the exact impression driving   
  Fix: Adopt sentence case for every H1, SectionHeader and nav label, preserving proper nouns and initialisms (HAVEN Hub, HIPAA, EHS, Epic, YNHH, NetID). Fix the 15 sites above: "HIPAA certificate", "EHS training", "Current certificate", "Pending requests", "My schedule", "Full schedule", "Schedule builder", "My info", "Epic requests", "Record disciplinary action". Then move the two compliance section he


### T11. Accessibility and small screens

Repeating structural gaps, not one-off slips.

*5 confirmed*

- **No horizontally scrolling table or grid in the app is keyboard-scrollable (46 Table renderers + 4 hand-rolled)**  
  `a11y-responsive/scroll-region-not-focusable` · medium · effort S · 46 files render <Table>, plus 3 schedule matrices and the public credential page. Every keyboard-only user, on every lis  
  Sites: `src/platform/ui/table.tsx:28`, `src/modules/schedule/components/builder-grid.tsx:481`, `src/modules/schedule/components/attending-grid.tsx:293`, `src/modules/schedule/components/attending-coverage-view.tsx:37`, `src/app/credential/[token]/page.tsx:74` and more  
  Impact: A keyboard-only or switch-access user cannot scroll any of these regions: with no focusable descendant in the off-screen columns, there is nothing to Tab to that would pull the container sideways, and the container itself is not a tab stop. On /credential/[token] the 'Clinic shifts' column, the whole point of a verifiable service record, is unreachable on a phone. Same for the far dates in the sch  
  Fix: One fix in one primitive plus three copies: give the scroll container `tabIndex={0}` and `role="region"` with an accessible name, and a visible focus ring. Add an optional `label` prop to Table (`<Table label="Master compliance roster">`), defaulting to `role="group"` with no tabIndex when no label is given so an unnamed region is never announced as a nameless landmark; the three schedule grids al

- **Four raw controls opt out of the outline focus ring the house style mandates, one has no focus style at all**  
  `a11y-responsive/focus-ring-off-spec-raw-controls` · medium · effort S · 4 controls across incidents (2 surfaces), outreach audience building, and the session-inactivity warning, which appears   
  Sites: `src/app/(app)/incidents/subject-picker.tsx:93`, `src/app/(app)/incidents/strikes/strike-row.tsx:100`, `src/app/(app)/outreach/campaigns/[id]/field-picker.tsx:223`, `src/platform/auth/inactivity.tsx:87`, `src/platform/ui/button.tsx:32`  
  Impact: All four suppress `outline`, which is the only focus indicator that survives Windows High Contrast / forced-colors mode, so in that mode these controls have no visible focus at all. 'Stay signed in' is the worst of them: it is the button that keeps a member from being logged out mid-shift, and a keyboard user cannot see when they have reached it in any mode. The expand toggle on every strike row a  
  Fix: Replace all four class strings with the surface pattern `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand` and drop the `outline-none`; none of the four needs a bespoke ring, they need the one the house style already names. Then close the hole that let inactivity.tsx through: add `src/platform/**/*.tsx` to the no-restricted-syntax `files` list with `src/platform/u

- **On a phone, sub-page navigation exists only as a scrollbar-suppressed strip, because the hamburger drops sub-pages**  
  `a11y-responsive/mobile-subpage-nav-invisible` · medium · effort M · Every module tab row (9 module layouts) and the 13-tab recruitment cycle nav, on every phone-width session. Directors do  
  Sites: `src/platform/ui/tab-row.tsx:71`, `src/platform/ui/tab-row.tsx:104`, `src/platform/ui/global-nav.tsx:355`, `src/modules/recruitment/components/cycle-nav-tabs.tsx:41`, `src/modules/recruitment/cycle-nav.ts:26` and more  
  Impact: A director opening a recruitment cycle on a phone sees roughly three of thirteen tabs, with no scrollbar, no gradient edge and no chevron to say ten more exist off the right edge. The auto-scroll-to-active (module-nav.tsx:41-43) moves the row on load, which makes the row look like it starts mid-list rather than like something that scrolls. The desktop escape hatch, the module dropdown in the toolb  
  Fix: One change in TabRow, since both variants and all six consumers share it: keep the hidden scrollbar (it is a deliberate visual choice) but add an overflow affordance to the `<nav>` itself, either a `mask-image` fade on the overflowing edge or a small chevron button pair shown only when `scrollWidth > clientWidth`. Same element then gets the `tabIndex={0}` / named-region treatment from the scroll-r

- **At phone width the bottom-center toast lane lands under the Intercom launcher, which paints above it**  
  `a11y-responsive/toast-lane-collides-with-intercom` · medium · effort S · Every authenticated phone session where Intercom is configured; every toast, which is the app's only feedback channel on  
  Sites: `src/platform/ui/toast/toast.tsx:282`, `src/platform/ui/toast/toast.tsx:193`, `src/platform/ui/app-shell.tsx:121`, `src/platform/intercom/messenger.tsx:171`, `src/platform/auth/inactivity.tsx:78`  
  Impact: On a phone, every confirmation and error toast overlaps the Intercom help bubble, and Intercom's widget stacks far above the app's z-50, so the bubble covers the toast's Dismiss button. Tapping to dismiss opens the messenger instead. Error toasts are the app's primary failure channel (flash.ts converts 121 `?error=` redirect sites into them), so this is the corner where a member is told a save fai  
  Fix: Either move the app's lane out of the launcher's corner at small widths (`bottom-4 sm:bottom-4` plus `bottom-24` below `sm`, matching the offset help-launcher.tsx:202 already used for the same reason), or give Intercom explicit space by passing `vertical_padding` in the boot args at messenger.tsx:171 and :201 so the launcher clears the lane. The second is preferable because it is one place and it 

- **Chip-remove controls ship 16-22px targets while the same app hand-sets 44px in a dozen places**  
  `a11y-responsive/micro-controls-below-target-size` · low · effort S · MultiCombobox is a shared primitive (2 direct consumers today, and the answer for the 55 hand-rolled multi-selects above  
  Sites: `src/platform/ui/multi-combobox.tsx:150`, `src/app/(app)/outreach/campaigns/[id]/field-picker.tsx:223`, `src/modules/support/components/ticket-number-field.tsx:46`, `src/modules/schedule/components/clinic-date-strip.tsx:63`, `src/app/(app)/incidents/subject-picker.tsx:93` and more  
  Impact: Removing a selected value from a MultiCombobox chip or clearing a stale field in the outreach audience builder needs a precise 16-22px tap, on controls that sit inline with text and adjacent to each other. The same product deliberately gives a schedule date chip and a ticket-number save button 44px, so the experience is inconsistent surface to surface rather than uniformly small.  
  Fix: Add a target-size row to docs/ui-house-style.md section 2 (interactive controls: 44x44 minimum, 24x24 absolute floor for inline chip affordances), then bake it into the two primitives rather than the callers: give MultiCombobox's remove button `inline-flex h-6 w-6 items-center justify-center` with the lucide `X` every other primitive uses instead of the `×` glyph, and swap field-picker.tsx:223's `


### T12. Copy and format drift

Same concept, different words or formats, on surfaces read together.

*3 confirmed*

- **The clinic date is rendered six different ways in Schedule, two of them in one shift card**  
  `copy-terminology/clinic-date-six-formats` · medium · effort M · Every surface in the Schedule module: /schedule, /schedule/full, /schedule/builder, /schedule/check-in, /schedule/attend  
  Sites: `src/app/(app)/schedule/page.tsx:434`, `src/app/(app)/schedule/page.tsx:495`, `src/modules/schedule/engine/display.ts:32-35`, `src/app/(app)/schedule/full/page.tsx:148`, `src/app/(app)/schedule/check-in/page.tsx:108-112` and more  
  Impact: A volunteer looking at one shift card reads their shift date as "Feb 7, 2026" and the swap partner's date three lines below as "February 7th". Nothing tells them these are the same calendar. Directors reconciling the date strip ("February 7th"), the full-schedule header ("Saturday, February 7, 2026") and the approvals panel ("Feb 7") translate formats on every screen, which is where an off-by-one-  
  Fix: Export two option sets from `src/platform/dates`: `CLINIC_DATE_LONG = { weekday: "long", month: "long", day: "numeric", year: "numeric" }` for page and card headers where the date IS the subject, and `CLINIC_DATE_SHORT = { weekday: "short", month: "short", day: "numeric" }` for inline references, chips, date strips and grid columns. Reimplement `displayDate(iso)` in `src/modules/schedule/engine/di

- **One /schedule page uses two verb families for the same swap and drop actions**  
  `copy-terminology/schedule-request-verb-split` · low · effort S · /schedule (both the volunteer and attending sections, rendered on one page for anyone holding both roles) and /schedule/  
  Sites: `src/app/(app)/schedule/page.tsx:511`, `src/modules/schedule/components/attending-portal-section.tsx:107`, `src/app/(app)/schedule/page.tsx:529`, `src/modules/schedule/components/attending-portal-section.tsx:124`, `src/app/(app)/schedule/page.tsx:538` and more  
  Impact: A physician who is both an attending and a department director sees the same control called Cancel in one card and Withdraw in the card below it, and reasonably assumes they differ (Withdraw sounds permanent). Faculty Relations approving on /schedule/requests reads "No requests." above "No pending attending requests." and cannot tell whether the first panel is empty or broken.  
  Fix: One verb per action on both sides: "Cancel request" / "Cancel this request?" for withdrawing a pending request (it is the requester undoing their own ask, and /support already uses "Cancel my request"), and "Request a drop" / "Request this drop?" for the drop heading and confirm on both. Reserve "Withdraw" for the recruitment and membership actions that already own it (`apply/withdraw-control.tsx`

- **Pending button labels split 23 to 61 between "Saving..." and "Saving…"**  
  `copy-terminology/pending-label-ellipsis` · low · effort S · Every write action in Outreach campaigns, Volunteers language review, board meetings and EHS, Schedule triage chats, and  
  Sites: `src/platform/ui/submit-button.tsx:31`, `src/app/(app)/outreach/campaigns/[id]/compose-form.tsx:58`, `src/app/(app)/outreach/campaigns/[id]/timing-actions.tsx:75`, `src/app/(app)/volunteers/spanish-review/page.tsx:454`, `src/app/(app)/volunteers/board-meetings/page.tsx:146` and more  
  Impact: On the campaign editor a sender clicks Save ("Saving..."), then Preview audience ("Previewing..."), then a SubmitButton elsewhere on the same screen shows "Sending…". Individually trivial, but it is visible on every write action in the app and it is the kind of ragged detail that makes a mature product read as assembled rather than designed.  
  Fix: Normalise every pending label and placeholder to U+2026, matching the SubmitButton default: 23 `pendingLabel` values, the two hand-rolled pending texts, and the four `Select...` placeholders. Add the ellipsis to the naming rules in docs/ui-house-style.md section 2 beside the em-dash rule, and extend the existing `local/no-em-dash` ESLint rule (which already scans string literals for a forbidden ch


## Refuted

30 findings were rejected by at least one verifier and are recorded here so they
are not re-filed by a later audit.

- duplicate-surfaces/application-answers-three-renderers: An application's answers get three layouts, two reachable from the same roster row , The two-surface observation is real but the third site, the impact story, and the proposed mechanism all fail on the files. WRONG SITE. src/app/(app)/recruitme
- detail-and-form/detail-section-chrome: The section under a detail page's form is drawn four ways, one bypassing SectionHeader , The observation checks out but the proposal fails on three counts, any one of which sinks it as written. (1) The site census undercounts its own migration target by 2.6x, a
- feedback/mutations-that-say-nothing-happened: Compliance and learning writes complete with no confirmation of any kind , The central claim ("no confirmation of any kind", "total silence") is false at 4 of the 5 cited sites, because each of those writes renders its own result at the exact control tha
- feedback/error-redirect-destroys-the-typed-form: Rejected submissions redirect to an empty form, so the user loses everything they typed , The load-bearing claim ("the redirect re-renders the form with empty defaultValues", "the whole thing is gone") is false for this repo's router, and three suppor
- nav-ia/which-pages-exist-four-lists: Four independent answers to "which pages exist for me", and they already disagree about My Info , The headline user impact is factually false. src/platform/ui/account-menu.tsx:79-84 renders "My Info" and "Training" as links in the toolbar's account disclosure, wh
- nav-ia/redirect-module-roots: Two modules whose root is a redirect, so their breadcrumb and chip point back at the page you are on , The observation is real but narrower than stated, and BOTH proposal variants fail on the files as written. Facts confirmed: src/app/(app)/clinic/page.tsx:6 is `redirec
- copy-terminology/person-noun-drift: The same roster row is a member, a person, or a volunteer depending on which tab you opened , Six of ten cited sites do not say what the finding claims, and the impact narrative is false. Schedule: builder-day-view.tsx:121-131 splits assignments by a.role === DIRE
- primitives/command-palette-stale-focus-trap: CommandPalette inlines the focus trap the hook explicitly forbids copying, and it is the pre-fix version , The duplication is real, but the headline user impact is fabricated and the proposal is unbuildable as specified. FALSE USER IMPACT. I enumerated ev
- a11y-responsive/modal-single-key-shortcuts-on-document: Both review-queue modals bind single-character shortcuts to document, firing irreversible writes from stray keystrokes , Cited lines are quoted accurately (speed-score-modal.tsx:147-167, speed-route-modal.tsx:116-138, command-palette.tsx:117-12
- data-display/compliance-status-four-vocabularies: ComplianceStatus is labelled four different ways and printed raw on one roster, with a comment claiming the maps are shared ,
- data-display/raw-enums-as-ui-text: Six surfaces ship the raw database enum as user-facing status text, against a convention the support module already wrote down ,
- data-display/membership-kind-five-shapes: Director vs Volunteer is drawn five ways, and two sub-views of the same builder page disagree on its colour ,
- data-display/person-identity-cell-four-shapes: Four rosters that all link to the same profile summarise a person four different ways ,
- data-display/eval-ratio-two-meanings: Two interview lists one nav hop apart print an N/M chip that means two different things ,
- data-display/decision-enum-no-shared-badge: The recruitment Decision enum has three private label maps and two tone maps while its own engine already returns a label and tone ,
- data-display/stat-row-vs-count-chips: The same six compliance counts render as StatCards on one page and Badge chips on its sibling, with different labels and opposite zero handling ,
- data-display/result-count-five-shapes: The list result count has five shapes and two number formats, and one page shadows the Pagination primitive to invent a sixth ,
- data-display/notification-row-two-time-formats: The notification bell and the notifications page render the same rows with different time formats, different unread dots, and only one of them accessible ,
- hierarchy-density/section-heading-scale: SectionHeader ships 2 levels; the app renders section headings at 6 sizes across 38 files ,
- hierarchy-density/page-frame-width-rhythm: Content width and the gap under PageHeader are re-decided per page: 5 widths in one 13-tab workspace ,
- hierarchy-density/card-inset-scale: Card offers 2 insets; ~30 sites hand-set 9 different ones through pad={false} ,
- hierarchy-density/summary-counts-weight: The same summary counts are 24px stat cards on one page and 11px chips on its sibling ,
- hierarchy-density/primary-button-inflation: "Primary" is applied to filtering on 4 pages and to nothing on 3, and /admin/settings renders ~73 of them ,
- hierarchy-density/section-container-drift: Peer sections are a Card on one page and a hairline rule on its sibling, and mixed within one page ,
- hierarchy-density/destructive-emphasis-inverted: On /schedule/requests, Deny is a solid red button and Approve is a hairline outline one ,
- hierarchy-density/clearance-banner-scale: The same "am I cleared" banner is 17/13px, 18/14px and 14/12px on three pages one click apart ,
- hierarchy-density/dashboard-own-type-and-button-scale: The landing page runs its own h1 size, button geometry and arbitrary-px type scale ,
- hierarchy-density/nested-panel-depth: The same person-search results panel is a top-level Card on one page and a nested sub-panel on another ,
- hierarchy-density/pageheader-action-slot: PageHeader's action slot carries a primary button, a status badge, or bare underlined text depending on the page ,
- hierarchy-density/control-wall-above-content: /incidents/strikes stacks 15 controls above row one; its sibling queue stacks 5 ,


## Recommended build order

Sized as single-session PRs, not a programme. Ordering rule: things that are actually broken first,
then the primitive that unlocks the widest migration, then the duplicate surfaces.

### PR 1. Escape hatches and swallowed errors (S, pure bug fixes)

Five small unrelated fixes that share one property: a user currently hits a dead end.

- `src/platform/ui/breadcrumbs.tsx:29` renders `crumb.href && !isLast`, so the last crumb never
  links. But `breadcrumb-trail.ts:57` deliberately gives detail pages a linked parent section as
  the last crumb ("no leaf; the section link is the escape"). The renderer strips exactly the
  escape link the builder was designed to provide, and labels an ancestor `aria-current="page"`.
  One-line fix, restores a way out of every detail page in the app.
- `invite-panel.tsx:77` fires `void navigator.clipboard.writeText(issued)` and then sets
  "Copied" unconditionally. On a rejected write the user is told a **show-once** applicant invite
  link is on their clipboard when it is not. Add await plus catch.
- `feed-url-field.tsx:35` awaits with no catch, so a denied clipboard leaves an unhandled rejection
  and the label silently never changes.
- Eight recruitment builder call sites do `if (r.ok) {...}` with no `else`, discarding the
  `{ok:false, error}` their own server actions return. The save just appears not to happen.
- `support`, `outreach` and `notifications` have no `loading.tsx`, so they fall through to
  `(app)/loading.tsx` and show a skeleton of the home dashboard announcing "Loading your dashboard".

### PR 2. One vocabulary per enum (M, highest product value)

Give each status enum one label module in `src/platform/`, exporting `{ label, tone }`, and make
every surface read it. Covers `OnboardingTaskState` (5 vocabularies), `ComplianceStatus` (4, plus
one roster printing the raw enum), `Decision` (3 private label maps and 2 tone maps, while
`decision-summary.ts` already returns a label and tone), `MembershipKind` (5 shapes) and the six
surfaces shipping raw DB enums as UI text ("OPEN", "FALLBACK"). Fixes T1 outright and stops a
member and their director reading different words for one fact.

### PR 3. ConfirmButton, and a real destructive-action policy (M, accessibility-blocking)

`ConfirmButton` documents fixing two accessibility defects; five hand-rolled arm/confirm controls
reintroduce them. On `/outreach/campaigns/[id]?tab=review`, pressing "Send now" unmounts the focused
button and drops focus to `<body>`, so a keyboard user cannot reach "Confirm send" at all. Extract
`useArmedConfirm()`, give `ConfirmButton` an `onConfirm` for the non-form case, migrate all five.

In the same pass, fix the inverted policy: Deny, Revoke, Withdraw and Delete ship bare while their
reversible siblings are confirmed, and on `/schedule/requests` Deny is a solid red button while
Approve, the routine action, is a hairline outline. Also stop seven labels reading
"Delete permanently? Confirm?" by appending the primitive's default to a question.

### PR 4. FilterBar (L, the widest single cohesion win)

`NavForm` ships the behaviour and no layout, so 12 list pages each invent a filter row: labels
visible on half of them and `aria-label`-only on the rest, the submit button primary here and
outline there, Clear present on some, the result count in four places in three phrasings. Add
`FilterBar` and `FilterField` over `NavForm`, migrate the 12. Fold in the auto-submitting selects
that bypass `NavForm` today, which is why a list dims on Next but not on a filter change.

### PR 5. TextLink, Checkbox label, card EmptyState (M, ~110 call sites, one real bug)

Three small primitives with a wide blast radius. `TextLink` first: 41 inline links in 14 recipes,
three of them on a brand token that never lifts in dark mode, so the only back link out of the
check-in kiosk and every link inside an onboarding contract are close to invisible in dark mode.
Then `Checkbox` gains the `label` and `hint` props `Radio` already has (58 rows hand-built in 23
class strings, no group naming, rows under the 44px target), and a card-wrapped `EmptyState`
recipe retires 13 verbatim copies of one string.

### PR 6. Merge the duplicated surfaces (L, your actual complaint)

Cheapest payoff first:

- The notification bell and `/notifications` render the same rows with different time formats,
  different unread dots and only one of them accessible. Share one row component.
- `/admin/email` and `/admin/notifications` are the same delivery log built twice. One page, with
  a source filter.
- The compliance roster is built twice and **the director's copy silently drops Learning**, so the
  two rosters disagree about whether a volunteer is cleared. This one is a correctness fix, not a
  cosmetic one.

Then, if it still bites: `/schedule` renders six duplicated constructs for volunteer and attending
on one route, and the admin "search a person, then assign" panel exists twice at two radii.

### Deliberately not sequenced

T10 (type scale, spacing, emphasis) is 9 findings and mostly unverified, and it is the theme most
likely to be a matter of taste rather than defect. Worth a look together on screen before any of it
is queued. T8's unbounded lists (seven `findMany` calls with no limit) are a performance question
more than a cohesion one and should be sized against real row counts first.
