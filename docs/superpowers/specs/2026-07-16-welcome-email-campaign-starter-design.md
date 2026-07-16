# Welcome to HAVEN Hub — campaign starter

**Date:** 2026-07-16
**Status:** Approved

## Goal

Ship a warm, polished "Welcome to HAVEN Hub" intro email that an admin can send as a
campaign to all HAVEN affiliates, introducing the platform and its capabilities and
pointing people at the docs (`docs.havenfreeclinic.org`). The email must lean on the
HAVEN Hub design system so it reads as a first-party product email, not a one-off.

## How campaigns work (constraints)

- A campaign stores an inline `subject` + `body` (HTML) authored in `/admin/email`.
  There is no per-campaign "template key"; the body is raw HTML.
- The body renders inside the shared layout wrapper (`templates/layout.ts`): a
  Yale-blue header band with the "HAVEN Free Clinic" wordmark, a 600px white card,
  and a slate footer. **The starter authors only the content slot** — it must not
  recreate the document, header, or footer.
- The render engine supports only `{{var}}`, `{{{raw}}}`, and `{{#if x}}…{{else}}…{{/if}}`.
  There is no `{{#each}}`.
- The only merge variables available to a campaign body are `firstName` and `name`
  (`audience/variables.ts`, `PERSON_VARIABLES`). Any other `{{ … }}` token makes
  `updateCampaign` reject the body on Save/Send. **The starter body therefore uses
  no other tokens** — brand color and all links are hard-coded literals.
- `createDraft` seeds the audience to every PERSON (`match: "ALL"`), which is exactly
  the "all affiliates" audience.

## Design

Three focused changes plus tests. No new permission (reuses `admin.send_email_campaign`).

### 1. `src/platform/email/campaigns/starters.ts` (new)

```ts
export type CampaignStarter = {
  id: string;        // "welcome"
  name: string;      // default campaign name: "Welcome to HAVEN Hub"
  label: string;     // chooser label
  description: string;
  subject: string;   // "Welcome to HAVEN Hub{{#if firstName}}, {{firstName}}{{/if}}"
  body: string;      // the designed HTML content slot
};

export const CAMPAIGN_STARTERS: CampaignStarter[];
export function getStarter(id: string): CampaignStarter | undefined;
```

Mirrors `layout.ts` (a big HTML constant + descriptor in one file).

### 2. `src/platform/email/campaigns/service.ts`

`createDraft(actorId, name, opts?: { starterId?: string })`:
- When `opts.starterId` resolves to a starter, seed `subject`/`body` from it and use
  the starter's `name` when the caller passed a blank name.
- No starter → unchanged behavior (empty subject/body, "Untitled campaign").

### 3. `src/app/(app)/admin/email/campaigns/new/page.tsx`

- Add a `RadioGroup` "Start from": **Blank** (default) / **Welcome to HAVEN Hub**,
  each with a one-line description. Uses existing `RadioGroup`/`Radio`/`Card`/`Field`.
- `createAction` reads `starter` from the form and passes it to `createDraft`.
- Relax the required name field so a starter can supply the default name.

### Design-system treatment

Hanken Grotesk; Yale-blue `#00356b` accents; the layout's slate palette
(`#0f172a`/`#1e293b`/`#475569`/`#64748b`/`#e2e8f0`/`#f8fafc`); 8px card + 6px button
radii. Bulletproof (Outlook-safe) table-based primary button; a brand-tinted "Start
here" callout mirroring the app's `brand-faint` panels; an uppercase eyebrow label;
a capabilities panel of hairline-divided feature rows. No images. Personalized
greeting with a graceful "there" fallback.

### Content (warm & welcoming; all four feature groups)

Greeting → intro → primary "Open HAVEN Hub" button (`hub.havenfreeclinic.org`) →
capabilities panel (Profile & clearance / Clinic schedule / Training & learning /
IT & Epic support / Report a concern / Notifications) → "Start here" 3-step callout →
Help + `docs.havenfreeclinic.org` → sign-off.

## Testing

- `starters.test.ts` (pure): the welcome `subject` and `body` validate against
  `["firstName","name"]` with `ok: true` (no unknown vars, no unclosed `#if`); the
  body contains the hub link, the docs link, and no stray `{{`; `getStarter` resolves
  "welcome" and returns undefined otherwise.
- `starters.golden.test.ts` (pure): render the body with a sample `firstName`, wrap it
  in `layoutDescriptor.defaultBody`, and snapshot the full HTML — catches accidental
  drift the way the other template golden tests do.
- `service.test.ts` (DB): `createDraft` with `starterId: "welcome"` seeds subject/body
  and the starter name; without it stays empty.

## Out of scope

- Deep-linking individual docs pages (link the docs root; page IDs are brittle).
- Fixing the unrelated `.com` hub typo in `templates/schedule.ts`.
