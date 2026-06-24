# In-app HIPAA cert PDF viewer — Design

**Date:** 2026-06-11
**Branch:** `feat/hipaa-cert-pdf-viewer`
**Status:** Approved for planning

## Problem

HIPAA certificates are uploaded PDFs stored in Vercel Blob (prod) or local disk (dev/CI)
and served only as **downloads**. The single authenticated route
`GET /my-info/certificate/[id]` returns the file with
`Content-Disposition: attachment`, so every place that references a cert —
the member's own panel and the two manager rosters — can only download the file
and open it outside the app.

Members and compliance/department managers want to **preview a cert inline, in-app**,
without the download round-trip, while keeping the existing download available.

## Scope

In scope:

- Inline (preview) serving of an existing cert PDF.
- A modal viewer reachable from the three existing surfaces that link to a cert:
  - `src/modules/my-info/components/hipaa-panel.tsx` — member viewing their own certs.
  - `src/app/volunteers/page.tsx` — department roster (`volunteers.view`).
  - `src/app/volunteers/master/page.tsx` — master roster (`volunteers.manage_compliance`).
- A reusable, accessible modal primitive (none exists today).

Out of scope (YAGNI):

- The `/get-started/hipaa` onboarding step (not requested).
- Annotations, multi-page thumbnails, zoom controls beyond the browser's native PDF UI.
- Any new PDF rendering library (`react-pdf` / `pdfjs-dist`). Certs are PDF-only and
  browsers render PDFs natively in an iframe.
- Changes to upload, parsing, compliance rules, or access-control policy.

## Key facts (verified in codebase)

- **Certs are PDF-only.** `saveCertificate` rejects any non-`application/pdf` type and any
  non-`.pdf` extension (`src/modules/my-info/services/my-info.ts:229,236`). The viewer only
  needs to render PDFs.
- **No global CSP / `X-Frame-Options`.** The only CSP in the app is scoped to the branding
  asset route (`src/app/api/branding/[asset]/route.ts:32`). A same-origin iframe of an
  inline-served PDF renders without CSP changes.
- **Access control already covers all viewers.** `canViewCertificate(viewerId, ownerId)`
  (`src/platform/compliance/access.ts:25`) allows owner, `volunteers.manage_compliance`, or
  a department director who manages a dept where the owner has an active term membership.
  The viewer reuses this unchanged.
- **No modal/dialog primitive exists.** UI primitives live in `src/platform/ui/`
  (Card, Button, Badge, Alert, etc.); the app hand-rolls primitives (no shadcn/Radix).

## Architecture

Four units, each independently understandable and testable.

### 1. Inline serving on the existing route

**File:** `src/app/my-info/certificate/[id]/route.ts`

Change the `GET` handler to inspect the request URL for an `inline=1` query parameter
(rename the currently-unused `_request` param to `request`). When present, set
`Content-Disposition: inline`; otherwise keep the existing
`attachment; filename="…"; filename*=UTF-8''…` exactly as today.

- All auth, `getActivePerson`, `canViewCertificate`, the 404-on-missing-or-forbidden
  behavior, and `storedName`-from-DB-only handling are **unchanged and reused**.
- Default (no query param) remains `attachment`, so existing download links keep working
  with no change.
- `Content-Type` stays `cert.mimeType` (always `application/pdf`).

Contract:

- `GET /my-info/certificate/{id}` → `attachment` (unchanged).
- `GET /my-info/certificate/{id}?inline=1` → same bytes, `Content-Disposition: inline`.
- Both paths enforce identical auth/access and return 404 to hide existence on
  forbidden/missing.

### 2. Reusable modal primitive

**File:** `src/platform/ui/modal.tsx` (new, client component — `"use client"`)

A generic, accessible dialog used by the viewer (and reusable elsewhere later).

- Props (approximate): `open: boolean`, `onClose: () => void`, `title?: ReactNode`,
  `children: ReactNode`, optional `footer?: ReactNode`, optional size.
- Behavior:
  - Renders through a portal to `document.body`.
  - `role="dialog"`, `aria-modal="true"`, labelled by the title.
  - Closes on Escape and on backdrop click; an explicit close (✕) button in the header.
  - Focus trap within the dialog; moves focus into the dialog on open and restores focus
    to the previously focused element on close.
  - Locks body scroll while open.
- Styling follows existing primitives: `rounded-2xl`, `border-slate-200`, white panel,
  soft shadow, semi-transparent slate backdrop. Tailwind v4.
- Returns `null` when `open` is false (and only mounts children while open).

### 3. `CertificateViewer` client component

**File:** `src/modules/my-info/components/certificate-viewer.tsx` (new, client component)

A self-contained "view this cert" control used in all three surfaces.

- Props: `certId: string`, `fileName: string`, and optional `ownerName?: string`
  (shown in the header when a manager views someone else's cert).
- Renders a **"View"** trigger button (Button primitive, `outline`/`sm` to match rows).
- Holds its own `open` state. While open, renders `<Modal>` containing:
  - Header: file name (and owner name when provided).
  - Body: `<iframe src={`/my-info/certificate/${certId}?inline=1`}>` sized to a large
    viewport area (e.g. `h-[80vh] w-full`), bordered like the SCORM player. The iframe is
    **only mounted while the modal is open** and unmounts on close, so roster rows never
    each load a PDF — at most one PDF loads at a time.
  - Footer actions:
    - **Download** — anchor to `/my-info/certificate/${certId}` (the existing `attachment`
      route); doubles as the fallback when inline preview fails.
    - **Open in new tab** — anchor to `/my-info/certificate/${certId}?inline=1`,
      `target="_blank"` `rel="noopener"`, for mobile/browsers that won't render PDFs
      in an iframe.
- The trigger button is the **primary** per-row action. The separate "Download" anchors
  in the rosters/panel are removed (download remains available inside the modal),
  keeping rows uncluttered.

### 4. Wiring into existing surfaces

Replace the current "Download" anchor with a `<CertificateViewer …>` in each:

- `src/modules/my-info/components/hipaa-panel.tsx` (lines ~98, ~192) — own certs;
  no `ownerName` (it's the member's own).
- `src/app/volunteers/page.tsx` (line ~246) — dept roster; pass the member's name as
  `ownerName`.
- `src/app/volunteers/master/page.tsx` (line ~322) — master roster; pass the member's
  name as `ownerName`.

These are Server Components rendering rows; `CertificateViewer` is a client component
imported and rendered per row (it manages its own state and only mounts the iframe when
open), so no page needs to become a client component.

## Data flow

```
[Surface row] "View" button (CertificateViewer, client)
   → open modal, mount <iframe src="/my-info/certificate/{id}?inline=1">
      → GET route: auth → getActivePerson → canViewCertificate(viewer, owner)
         → getObject(storedName) → 200 application/pdf, Content-Disposition: inline
      → browser renders PDF natively inside the iframe
   → footer: Download (?attachment) / Open in new tab (?inline=1)
   → Escape / backdrop / ✕ → unmount iframe, restore focus
```

No new persistence, no schema change, no new service. Access decisions stay entirely in
the existing route + `canViewCertificate`.

## Error handling / edge cases

- **File missing in storage:** route already returns 404 (JSON). The iframe will display
  that response; the modal always shows the Download + Open-in-new-tab footer so the user
  has a clear next step. (Optionally an `onError`/`onLoad`-driven inline notice — nice to
  have, not required.)
- **Forbidden cert:** route returns 404 (existence hidden); same fallback footer applies.
  In practice the surfaces only render a viewer for certs the viewer can already access.
- **Mobile / browsers without inline PDF support:** covered by Download and
  Open-in-new-tab footer actions.
- **Large PDFs:** served as a single response as today; no streaming/range changes.

## Testing

- **Route** (`src/app/my-info/certificate/[id]/route.test.ts`, extend or add):
  - `?inline=1` ⇒ `Content-Disposition: inline`.
  - No query param ⇒ `Content-Disposition: attachment` (unchanged).
  - Auth/access still gate both modes (401 without session, 404 when
    `canViewCertificate` is false), confirming the query flag does not bypass checks.
- **Modal primitive** (`src/platform/ui/modal.test.tsx`):
  - Renders nothing when closed; renders dialog when open.
  - Escape and backdrop click call `onClose`; close button calls `onClose`.
  - `role="dialog"` / `aria-modal` present; focus moves in on open.
- **CertificateViewer** (`src/modules/my-info/components/certificate-viewer.test.tsx`):
  - Trigger opens the modal; iframe `src` is `/my-info/certificate/{id}?inline=1`.
  - Download link points at `/my-info/certificate/{id}` (no query).
  - `ownerName` appears in the header when provided.
  - Closing unmounts the iframe.

(Confirm the project's component test runner — Vitest + RTL or equivalent — during
planning and match the existing route-test style in
`src/app/api/branding/[asset]/route.test.ts`.)

## Files touched

New:

- `src/platform/ui/modal.tsx`
- `src/modules/my-info/components/certificate-viewer.tsx`
- `src/platform/ui/modal.test.tsx`
- `src/modules/my-info/components/certificate-viewer.test.tsx`

Modified:

- `src/app/my-info/certificate/[id]/route.ts` (inline disposition flag)
- `src/app/my-info/certificate/[id]/route.test.ts` (inline assertions; create if absent)
- `src/modules/my-info/components/hipaa-panel.tsx`
- `src/app/volunteers/page.tsx`
- `src/app/volunteers/master/page.tsx`
