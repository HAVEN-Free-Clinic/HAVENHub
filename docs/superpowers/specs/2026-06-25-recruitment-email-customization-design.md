# Recruitment Email Customization (Per-Cycle Overrides) Design

**Date:** 2026-06-25
**Branch:** stacked on `feat/recruitment-form-builder-redesign` (PR #60) work
**Status:** Approved, ready for implementation plan

## Goal

Make every recruitment email editable. They are the only app emails still
hardcoded as inline-HTML functions that bypass the existing editable
email-template system. Register them so admins can edit a global default for
each, and add a per-cycle override layer so a cycle can tailor its own
acceptance, interview, onboarding, and confirmation copy.

This is the first of two sequenced features. The second (per-cycle onboarding
form builder) is a separate spec.

## Background (current state)

There is a mature, admin-editable email-template system:

- `EmailTemplate` model: `key @unique`, `subject`, `body`, `updatedBy`. At most
  one global override per key.
- A descriptor registry (`src/platform/email/templates/registry.ts`) of
  `TemplateDescriptor`s: `key`, `name`, `category`, `variables`,
  `defaultSubject`, `defaultBody`. The registry literally carries the comment
  `// Extended by later tasks (recruitment descriptors).`
- A render engine (`src/platform/email/render/`) with `{{ var }}` (escaped) and
  `{{{ var }}}` (raw) interpolation plus allowed-variable validation
  (`validateTemplate`).
- `renderEmail(key, context)` resolves subject/body (DB override -> code
  default), renders with the context, and wraps the body in a shared layout.
- An admin editor at `/admin/email/templates` backed by
  `src/modules/admin/services/email-templates.ts`.

The recruitment emails do NOT use any of this. They are inline functions that
manually `escapeHtml` and return bare `<p>` fragments (no layout):

| Email | queueEmail `template:` key | Variables (current fn input) | Cycle in context? | Send site |
|-------|----------------------------|------------------------------|-------------------|-----------|
| Acceptance | `recruitment.acceptance` | firstName, cycleTitle, departmentName | Yes | `services/decisions.ts:78-80` |
| Interview invite | `recruitment.interview_invite` | firstName, departmentName, scheduledAt, zoomLink | Yes | `services/interviews.ts:105-107` |
| Onboarding link | `recruitment.onboarding` | firstName, cycleTitle, contractUrl | Yes | `services/onboarding.ts:65-72` |
| Application received | `recruitment.application_received` | firstName, cycleTitle | Yes | `services/submissions.ts:254-258` (fully inline, no template fn) |
| Magic link | `recruitment.portal_link` | firstName?, url | **No** (requested by email from portal home; no cycle) | `services/portal-auth.ts:129-130` |

The `template:` tags already equal the keys we will register.

## Architecture (Approach A)

Reuse the registry + render engine + global editor; add an isolated per-cycle
override table and a recruitment-module render seam that layers the cycle on
top. The global `EmailTemplate` semantics are untouched.

### Resolution order (per field, subject and body independently)

```
cycle override (RecruitmentCycleEmail)  ->  global override (EmailTemplate)  ->  descriptor default
```

The layout wrapper stays global (cycle override of the layout is out of scope).

### Consequence: emails now use the shared layout

Registering these emails means they are wrapped in the shared layout
(header/footer) like every other app email, instead of sending as bare `<p>`
fragments. This is a deliberate consistency upgrade. The `defaultBody` of each
descriptor carries the existing copy as the body content.

## Data model

```prisma
model RecruitmentCycleEmail {
  id          String   @id @default(cuid())
  cycleId     String
  cycle       RecruitmentCycle @relation(fields: [cycleId], references: [id], onDelete: Cascade)
  /// Descriptor key, e.g. "recruitment.acceptance". One of the cycle-scoped
  /// recruitment keys only (portal_link is excluded: it has no cycle).
  key         String
  subject     String
  body        String
  updatedById String?
  updatedBy   Person?  @relation("recruitmentCycleEmailUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([cycleId, key])
}
```

- Add the inverse relation field on `RecruitmentCycle` (e.g. `cycleEmails RecruitmentCycleEmail[]`).
- Add the inverse relation field on `Person` (e.g. `recruitmentCycleEmailsUpdated RecruitmentCycleEmail[] @relation("recruitmentCycleEmailUpdatedBy")`).
- A row exists ONLY when the cycle overrides that email. Absent row = inherit.
- Hand-authored migration creates the table (no enum changes).

## Descriptors

New `src/platform/email/templates/recruitment.ts` exports
`recruitmentDescriptors: TemplateDescriptor[]` for all 5 keys, added to the
registry `ALL` array. Each descriptor:

- `category: "transactional"`.
- `variables`: declared with `name`, `label`, `sampleValue`. Variables are the
  flat, already-formatted strings the body interpolates (see Context builders).
- `defaultSubject` / `defaultBody`: the existing copy, converted to `{{ }}`
  interpolation. The render engine escapes `{{ }}` values, so the manual
  `escapeHtml` calls in the old functions are removed.

Variable sets:

- `recruitment.acceptance`: `firstName`, `cycleTitle`, `departmentName`
- `recruitment.interview_invite`: `firstName`, `departmentName`, `interviewTime`, `joinLink`
- `recruitment.onboarding`: `firstName`, `cycleTitle`, `contractUrl`
- `recruitment.application_received`: `firstName`, `cycleTitle`
- `recruitment.portal_link`: `firstName`, `portalUrl`

Default bodies preserve the current wording. Examples (body content only; the
layout adds the wrapper):

- acceptance: `<p>Congratulations {{ firstName }},</p><p>You've been accepted into <strong>{{ departmentName }}</strong> for {{ cycleTitle }}. We'll follow up shortly with onboarding next steps.</p>` ; subject `You've been accepted to HAVEN: {{ departmentName }}`
- interview_invite: `<p>Hi {{ firstName }},</p><p>You're invited to a director interview for <strong>{{ departmentName }}</strong> at HAVEN Free Clinic.</p><p>Time: {{ interviewTime }}<br/>Join: {{{ joinLink }}}</p><p>Please reply if you need to reschedule.</p>` ; subject `HAVEN {{ departmentName }} director interview`
- onboarding: `<p>Congratulations {{ firstName }},</p><p>To finish joining HAVEN for {{ cycleTitle }}, please complete your onboarding contract here: <a href="{{ contractUrl }}">{{ contractUrl }}</a></p><p>It collects your signatures, EPIC access details, and HIPAA certificate.</p>` ; subject `Complete your HAVEN onboarding for {{ cycleTitle }}`
- application_received: `<p>Hi {{ firstName }},</p><p>Thanks for applying to HAVEN Free Clinic. We have received your {{ cycleTitle }} application and will be in touch.</p>` ; subject `We received your {{ cycleTitle }} application`
- portal_link: `<p>Hi {{ firstName }},</p><p>Use this link to access your HAVEN Hub application. It expires in 30 minutes and can be used once.</p><p><a href="{{ portalUrl }}">Open my application</a></p><p>If you did not request this, you can ignore this email.</p>` ; subject `Your HAVEN Hub application link`

Notes:
- `joinLink` is raw HTML (`{{{ }}}`) because the context builder emits either an
  `<a>` tag or the plain fallback text "link to follow".
- `firstName` falls back to "there" (acceptance/interview/onboarding/app-received)
  or the magic link's existing greeting handling; the context builder supplies
  the fallback string so the template stays pure interpolation.

## Render seam

New `src/modules/recruitment/email/render.ts`:

```ts
export const CYCLE_EMAIL_KEYS = [
  "recruitment.acceptance",
  "recruitment.interview_invite",
  "recruitment.onboarding",
  "recruitment.application_received",
] as const;
export type CycleEmailKey = typeof CYCLE_EMAIL_KEYS[number];

export async function renderCycleEmail(
  cycleId: string,
  key: CycleEmailKey,
  context: Record<string, unknown>,
): Promise<{ subject: string; html: string }>;
```

Behavior:
- Validate `key` is a `CYCLE_EMAIL_KEYS` member (throws otherwise).
- Load the descriptor (throws if missing).
- Read the cycle override (`RecruitmentCycleEmail` by `cycleId_key`), the global
  override (`EmailTemplate` by key), and the layout source
  (`loadLayoutSource()` from platform).
- `subjectSource = cycleOverride?.subject ?? globalOverride?.subject ?? descriptor.defaultSubject`
  (same for body).
- `renderTemplate(subjectSource, context)` and `renderTemplate(bodySource, context)`,
  then wrap the rendered body in the layout via `renderTemplate(layoutSource, { ...context, body, subject })`.

Platform's `renderEmail`/`loadLayoutSource` are reused; the cycle table is read
only in the recruitment module, so platform stays generic.

For the magic link (no cycle), the send site calls the existing platform
`renderEmail("recruitment.portal_link", context)` directly.

## Admin UX

### Per-cycle editor

A new **Emails** section on the cycle detail page, route
`/recruitment/cycles/[id]/emails`, gated by `recruitment.manage_cycles` (the
permission used for all cycle management, enforced via `requirePermission` at the
action layer the same way `src/app/(app)/recruitment/actions.ts` does).

- Lists the 4 cycle-scoped emails. For each: the display name, an
  overridden/"using default" indicator, a subject+body editor, the variable
  chips for that descriptor, a sample-value preview (render with the
  descriptor's `sampleValue`s through `renderCycleEmail`/preview helper), a
  **Save** action (upsert the `RecruitmentCycleEmail` row) and a **Reset to
  default** action (delete the row).
- Validation reuses `validateTemplate` against the descriptor's allowed
  variables; invalid templates are rejected with the problem list, mirroring the
  global editor's behavior.
- Reuse the existing template-editor component where practical; if its data
  shape is too coupled to the global service, extract a shared presentational
  piece rather than duplicate the editor.

### Global editor

Registering the descriptors makes all 5 (including the magic link) appear in the
existing `/admin/email/templates` editor automatically. No new work there beyond
registration.

## Service layer

New `src/modules/recruitment/services/cycle-emails.ts`:

- `listCycleEmails(cycleId)`: for each cycle-scoped key, return
  `{ key, name, variables, defaultSubject, defaultBody, subject, body, hasOverride }`
  where `subject`/`body` are the effective cycle-or-default values. (Effective =
  cycle override else global override else descriptor default, matching render
  resolution, so the editor shows what will actually send.)
- `saveCycleEmail(cycleId, key, subject, body, actorId)`: `can(actorId,
  "recruitment.manage_cycles")` check, key-is-cycle-scoped check,
  `validateTemplate` against allowed vars (throw `TemplateValidationError`-style
  on failure), upsert the row, `recordAudit` (action e.g.
  `recruitment.cycle_email_save`).
- `resetCycleEmail(cycleId, key, actorId)`: `can(actorId,
  "recruitment.manage_cycles")` check, delete the row if present, `recordAudit`
  (action e.g. `recruitment.cycle_email_reset`).

## Send-site integration

| Site | Change |
|------|--------|
| `decisions.ts` acceptance loop | Resolve override sources once for the cycle, render per applicant via `renderCycleEmail(cycle.id, "recruitment.acceptance", ctx)`; `ctx = { firstName, cycleTitle, departmentName }`. |
| `interviews.ts` | `renderCycleEmail(cycleId, "recruitment.interview_invite", ctx)`; context builder formats `scheduledAt -> interviewTime` and `zoomLink -> joinLink` (anchor or "link to follow"). Obtain `cycleId` from the interview's application/cycle. |
| `onboarding.ts` | `renderCycleEmail(cycleId, "recruitment.onboarding", ctx)`; `ctx = { firstName, cycleTitle, contractUrl }`. Obtain `cycleId` from `acceptance.application.cycleId`. |
| `submissions.ts` application received | Replace the inline HTML with `renderCycleEmail(cycle.id, "recruitment.application_received", ctx)`; `ctx = { firstName, cycleTitle }`. |
| `portal-auth.ts` magic link | Replace `portalLinkEmail()` with platform `renderEmail("recruitment.portal_link", { firstName, portalUrl })`. |

All `template:` tags passed to `queueEmail` stay the existing keys. The old
inline functions (`acceptance.ts`, `interview-invite.ts`, `onboarding.ts`,
`portal-link-email.ts`) are deleted once their send sites are migrated.

### Transaction note

`decisions.ts`, `interviews.ts`, `onboarding.ts`, and `submissions.ts` queue
inside a Prisma transaction. `renderCycleEmail` reads template rows via the
global `prisma` client (templates are not mutated in those transactions), then
the resolved `subject`/`html` are passed to `queueEmail(tx, ...)`. This matches
how the existing `renderEmail` is used elsewhere. Render before the queue call.

## Testing

- **Descriptor tests** (`recruitment.test.ts`, golden-style like `epic`):
  each default subject/body renders with sample values; declared variables pass
  `validateTemplate`; escaping holds (a `<script>` in `firstName` is escaped via
  `{{ }}`, the `joinLink` anchor renders raw via `{{{ }}}`).
- **`renderCycleEmail` resolution tests:** cycle override wins; falls back to
  global `EmailTemplate`; falls back to descriptor default; output is wrapped in
  the layout; a non-cycle key (`recruitment.portal_link`) and an unknown key are
  rejected.
- **`cycle-emails` service tests:** save requires permission and valid template
  (rejects an unknown variable), upserts and records audit; reset deletes the
  row and records audit; `listCycleEmails` reports `hasOverride` and effective
  values correctly.
- **Send-site tests:** with a cycle override present, the queued email's
  `subject`/`html` reflect the override (acceptance, interview, onboarding,
  application-received); with none, they reflect the default; the magic link
  uses the global template. Extend the existing `decisions`/`interviews`/
  `onboarding`/`submissions` tests rather than duplicate setup.
- Replace the old inline-function tests (`acceptance.test.ts`,
  `interview-invite.test.ts`, `email/templates/onboarding.test.ts`) with the
  descriptor tests; delete them with their functions.
- `resetDb` truncate list must include `RecruitmentCycleEmail`.

## Global constraints

- No em-dashes anywhere (code, comments, copy). Use commas, parentheses, colons.
- Product name "HAVEN Hub" (two words) in user-facing copy; identifiers stay
  `havenhub`. Existing email copy that says "HAVEN Free Clinic" is the org name
  and is preserved verbatim.
- No new dependencies.
- Hand-authored Prisma migration applied to dev and test DBs; run
  `prisma migrate status` before any Neon deploy.
- Reuse the existing render engine, `validateTemplate`, registry, and layout. Do
  not fork the rendering or validation logic.

## Out of scope

- Per-cycle override of the shared layout wrapper.
- Per-cycle enable/disable of an email (a cycle cannot suppress an email type;
  it can only re-word it).
- The per-cycle onboarding form builder (separate, second spec).
- Any change to non-recruitment emails or the global editor UI.
