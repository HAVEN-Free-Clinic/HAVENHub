# In-app HIPAA cert PDF viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let members and compliance/department managers preview a HIPAA cert PDF inline in a modal, in-app, without leaving the page — while keeping the existing download.

**Architecture:** Add an `?inline=1` mode to the existing authenticated cert route so it can serve `Content-Disposition: inline`; render that URL in a same-origin `<iframe>` inside a new reusable modal primitive, triggered by a `CertificateViewer` button wired into the three surfaces that currently link to a cert. No new dependencies, no schema change, no access-control change.

**Tech Stack:** Next.js 16 App Router (Server + Client Components), React 19, TypeScript, Tailwind v4, Vitest 4 (node environment). Existing libs only — certs are PDF-only and browsers render PDFs natively in an iframe.

**Spec:** `docs/superpowers/specs/2026-06-11-hipaa-cert-pdf-viewer-design.md`

---

## Testing reality (read before starting)

This codebase's Vitest config is **node-environment only** (`environment: "node"`,
`include: ["src/**/*.test.ts"]`), has **no** `@testing-library/react`/jsdom, and has
**zero** `.test.tsx` component tests. The route handler also depends on next-auth `auth()`,
which no existing test mocks (tests are integration-style against a real test DB, plus
pure-function unit tests).

Therefore this plan:

- **Unit-tests the one pure piece** — the `Content-Disposition` builder — in a node
  `.test.ts`, matching the codebase pattern (Task 1).
- Does **not** add a React DOM test stack. The route handler, the `Modal` primitive, and
  `CertificateViewer` are verified by `npm run typecheck`, `npm run lint`, and a **manual
  smoke test** in the running app (Task 8). Introducing jsdom + Testing Library is
  out-of-scope and contrary to the repo's conventions.

Run after every task: `npm run typecheck` and `npm run lint` must stay green.

---

## File structure

New:

- `src/app/my-info/certificate/[id]/content-disposition.ts` — pure helper that builds the
  `Content-Disposition` header for `inline` or `attachment`, encapsulating the filename
  sanitization currently inline in the route.
- `src/app/my-info/certificate/[id]/content-disposition.test.ts` — node unit tests.
- `src/platform/ui/modal.tsx` — reusable accessible modal primitive (client).
- `src/modules/my-info/components/certificate-viewer.tsx` — "View" button + modal + iframe
  (client).

Modified:

- `src/app/my-info/certificate/[id]/route.ts` — parse `?inline=1`, use the helper.
- `src/modules/my-info/components/hipaa-panel.tsx` — replace two "Download" links with
  `CertificateViewer`.
- `src/app/volunteers/page.tsx` — replace the per-row "Download" anchor with
  `CertificateViewer`.
- `src/app/volunteers/master/page.tsx` — replace the per-row "Download" anchor with
  `CertificateViewer`.

---

## Task 1: Content-Disposition helper (pure, tested)

**Files:**
- Create: `src/app/my-info/certificate/[id]/content-disposition.ts`
- Test: `src/app/my-info/certificate/[id]/content-disposition.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/my-info/certificate/[id]/content-disposition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { certificateContentDisposition } from "./content-disposition";

describe("certificateContentDisposition", () => {
  it("builds an attachment header by default", () => {
    expect(certificateContentDisposition("cert.pdf", false)).toBe(
      "attachment; filename=\"cert.pdf\"; filename*=UTF-8''cert.pdf",
    );
  });

  it("builds an inline header when inline is true", () => {
    expect(certificateContentDisposition("cert.pdf", true)).toBe(
      "inline; filename=\"cert.pdf\"; filename*=UTF-8''cert.pdf",
    );
  });

  it("strips control chars and quotes from the ASCII filename but keeps the encoded original", () => {
    const header = certificateContentDisposition('a"b.pdf', false);
    expect(header).toBe(
      "attachment; filename=\"ab.pdf\"; filename*=UTF-8''a%22b%01.pdf",
    );
  });

  it("falls back to certificate.pdf when the name sanitizes to empty", () => {
    const header = certificateContentDisposition('"""', true);
    expect(header).toBe(
      "inline; filename=\"certificate.pdf\"; filename*=UTF-8''%22%22%22",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- content-disposition`
Expected: FAIL — cannot find module `./content-disposition` / `certificateContentDisposition` is not a function.

- [ ] **Step 3: Write the helper**

Create `src/app/my-info/certificate/[id]/content-disposition.ts`:

```ts
/**
 * Build a Content-Disposition header value for a certificate file.
 *
 * - `inline` controls whether the browser renders the file in-page (preview) or
 *   downloads it.
 * - The ASCII `filename` parameter is sanitized (control chars and double-quotes
 *   removed, per RFC 6266) and falls back to "certificate.pdf" if it sanitizes to
 *   empty; the RFC 5987 `filename*` parameter carries the full original name.
 */
export function certificateContentDisposition(fileName: string, inline: boolean): string {
  const disposition = inline ? "inline" : "attachment";
  const safeFileName = fileName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "certificate.pdf";
  const encodedFileName = encodeURIComponent(fileName);
  return `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- content-disposition`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/my-info/certificate/[id]/content-disposition.ts" "src/app/my-info/certificate/[id]/content-disposition.test.ts"
git commit -m "feat(hipaa): add content-disposition helper for cert serving"
```

---

## Task 2: Serve cert inline via `?inline=1`

**Files:**
- Modify: `src/app/my-info/certificate/[id]/route.ts`

- [ ] **Step 1: Import the helper and read the inline flag**

In `src/app/my-info/certificate/[id]/route.ts`, add the import near the existing imports:

```ts
import { certificateContentDisposition } from "./content-disposition";
```

Change the handler signature so the request is used (it is currently named `_request`):

```ts
export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
```

- [ ] **Step 2: Replace the inline filename-building + header block**

Find this block near the end of the handler:

```ts
  // Strip control characters and double-quotes from the original file name for
  // use in the ASCII filename parameter (RFC 5987 / RFC 6266 safety).
  const safeFileName = cert.fileName.replace(/[\x00-\x1f\x7f"]/g, "").trim() || "certificate.pdf";
  // Append the RFC 5987 encoded filename* parameter so browsers that support it
  // receive the full original Unicode name alongside the sanitized ASCII fallback.
  const encodedFileName = encodeURIComponent(cert.fileName);

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": cert.mimeType,
      "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`,
      "Content-Length": String(fileByteLength),
    },
  });
```

Replace it with:

```ts
  // `?inline=1` previews the file in-page (used by the in-app viewer); the default
  // remains a download so existing links are unaffected.
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  return new Response(fileBytes, {
    status: 200,
    headers: {
      "Content-Type": cert.mimeType,
      "Content-Disposition": certificateContentDisposition(cert.fileName, inline),
      "Content-Length": String(fileByteLength),
    },
  });
```

- [ ] **Step 3: Typecheck, lint, and run the suite**

Run: `npm run typecheck && npm run lint && npm test -- content-disposition`
Expected: no type/lint errors; helper tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/my-info/certificate/[id]/route.ts"
git commit -m "feat(hipaa): serve cert inline with ?inline=1"
```

---

## Task 3: Reusable modal primitive

**Files:**
- Create: `src/platform/ui/modal.tsx`

No unit test (see "Testing reality" — no DOM test stack in this repo). Verified by typecheck/lint here and manual smoke in Task 8.

- [ ] **Step 1: Create the Modal component**

Create `src/platform/ui/modal.tsx`:

```tsx
"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Accessible modal dialog. Renders via a portal to document.body, traps focus,
 * closes on Escape and backdrop click, locks body scroll while open, and restores
 * focus to the previously focused element on close. Renders nothing when closed.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the dialog on open.
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Minimal focus trap: keep Tab within the panel.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-200 bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="min-w-0 truncate text-sm font-semibold text-slate-700">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/platform/ui/modal.tsx
git commit -m "feat(ui): add accessible Modal primitive"
```

---

## Task 4: CertificateViewer component

**Files:**
- Create: `src/modules/my-info/components/certificate-viewer.tsx`

No unit test (see "Testing reality"). Verified by typecheck/lint here and manual smoke in Task 8.

- [ ] **Step 1: Create the component**

Create `src/modules/my-info/components/certificate-viewer.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { Modal } from "@/platform/ui/modal";
import { buttonClasses } from "@/platform/ui/button";

type CertificateViewerProps = {
  certId: string;
  fileName: string;
  /** Shown in the header when a manager is viewing someone else's certificate. */
  ownerName?: string;
};

/**
 * "View" button that opens a modal previewing the certificate PDF inline. The
 * iframe is only mounted while the modal is open (so roster rows never each load
 * a PDF) and unmounts on close. Download / Open-in-new-tab are provided as
 * fallbacks for browsers that will not render PDFs in an iframe.
 */
export function CertificateViewer({ certId, fileName, ownerName }: CertificateViewerProps) {
  const [open, setOpen] = useState(false);

  const inlineHref = `/my-info/certificate/${certId}?inline=1`;
  const downloadHref = `/my-info/certificate/${certId}`;
  const title = ownerName ? `${ownerName} — ${fileName}` : fileName;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses("outline", "sm", "gap-1.5")}
      >
        <Eye className="h-4 w-4" />
        View
      </button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={title}
          footer={
            <>
              <a
                href={inlineHref}
                target="_blank"
                rel="noreferrer"
                className={buttonClasses("ghost", "sm")}
              >
                Open in new tab
              </a>
              <a href={downloadHref} className={buttonClasses("outline", "sm")}>
                Download
              </a>
            </>
          }
        >
          <iframe
            src={inlineHref}
            title={`Certificate preview: ${fileName}`}
            className="h-[75vh] w-full rounded-lg border border-slate-200"
          />
        </Modal>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/my-info/components/certificate-viewer.tsx
git commit -m "feat(hipaa): add CertificateViewer modal component"
```

---

## Task 5: Wire viewer into the My Info HIPAA panel

**Files:**
- Modify: `src/modules/my-info/components/hipaa-panel.tsx`

`hipaa-panel.tsx` is a Server Component; rendering the client `CertificateViewer` inside it is fine. It replaces both "Download" links (the current certificate and each history row). The viewer's modal footer keeps Download available.

- [ ] **Step 1: Add the import**

Near the other imports (after the `Badge` import around line 20), add:

```tsx
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
```

- [ ] **Step 2: Replace the "Current Certificate" Download link**

Find (around lines 90-103):

```tsx
            <p className="text-sm text-slate-600">
              {latest.source === "IMPORT"
                ? "On file (imported from previous records)"
                : `Uploaded ${formatDate(latest.uploadedAt)}`}{" "}
              <Link
                href={`/my-info/certificate/${latest.id}`}
                className="text-brand hover:underline"
              >
                Download
              </Link>
            </p>
```

Replace with:

```tsx
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span>
                {latest.source === "IMPORT"
                  ? "On file (imported from previous records)"
                  : `Uploaded ${formatDate(latest.uploadedAt)}`}
              </span>
              <CertificateViewer certId={latest.id} fileName={latest.fileName} />
            </div>
```

- [ ] **Step 3: Replace the history-row Download link**

Find (around lines 182-198):

```tsx
            {history.map((cert) => (
              <li key={cert.id} className="flex items-center gap-3 text-sm text-slate-600">
                <span>
                  {cert.source === "IMPORT"
                    ? "On file (imported from previous records)"
                    : formatDate(cert.uploadedAt)}
                </span>
                <span className="text-slate-400">{formatSize(cert.size)}</span>
                <Link
                  href={`/my-info/certificate/${cert.id}`}
                  className="text-brand hover:underline"
                >
                  Download
                </Link>
              </li>
            ))}
```

Replace with:

```tsx
            {history.map((cert) => (
              <li key={cert.id} className="flex items-center gap-3 text-sm text-slate-600">
                <span>
                  {cert.source === "IMPORT"
                    ? "On file (imported from previous records)"
                    : formatDate(cert.uploadedAt)}
                </span>
                <span className="text-slate-400">{formatSize(cert.size)}</span>
                <CertificateViewer certId={cert.id} fileName={cert.fileName} />
              </li>
            ))}
```

- [ ] **Step 4: Remove the now-unused `Link` import if nothing else uses it**

Run: `grep -n "<Link" src/modules/my-info/components/hipaa-panel.tsx`
If there are **no** remaining `<Link` usages, remove `import Link from "next/link";` (around line 15). If any remain, leave the import in place.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors (no unused-import warnings).

- [ ] **Step 6: Commit**

```bash
git add src/modules/my-info/components/hipaa-panel.tsx
git commit -m "feat(hipaa): use CertificateViewer in My Info panel"
```

---

## Task 6: Wire viewer into the department roster

**Files:**
- Modify: `src/app/volunteers/page.tsx`

The row already has the member's name available; pass it as `ownerName` so managers see whose cert they're viewing.

- [ ] **Step 1: Add the import**

Add near the top imports of `src/app/volunteers/page.tsx`:

```tsx
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
```

- [ ] **Step 2: Replace the Download anchor**

Find (around lines 244-251):

```tsx
                            {m.cert && (
                              <a
                                href={`/my-info/certificate/${m.cert.id}`}
                                className="text-xs text-brand underline underline-offset-2 hover:opacity-75"
                                target="_blank"
                                rel="noreferrer"
                              >
                                Download
                              </a>
```

Replace with:

```tsx
                            {m.cert && (
                              <CertificateViewer
                                certId={m.cert.id}
                                fileName={m.cert.fileName}
                                ownerName={m.name}
                              />
```

Note: confirm the row variable for the member's display name. Run
`grep -n "m\.name\|m\.fullName\|m\.person" src/app/volunteers/page.tsx` and use the
existing display-name field (e.g. `m.name`). Also confirm `m.cert.fileName` is selected;
if the cert object on the row lacks `fileName`, either add it to the query's `select`/shape
for `m.cert` or pass a sensible label — see Step 3.

- [ ] **Step 3: Ensure `fileName` is available on the row's cert**

Run: `grep -n "cert:" src/app/volunteers/page.tsx; grep -rn "fileName" src/modules/volunteers/services/compliance.ts`
- If the compliance service already includes `fileName` on the cert shape, no change.
- If not, add `fileName` to the selected cert fields in `departmentCompliance`
  (`src/modules/volunteers/services/compliance.ts`) so `m.cert.fileName` is populated.
  (The `HipaaCertificate` model has `fileName` — `src/prisma/schema.prisma`.)

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/volunteers/page.tsx src/modules/volunteers/services/compliance.ts
git commit -m "feat(hipaa): use CertificateViewer in department roster"
```

---

## Task 7: Wire viewer into the master roster

**Files:**
- Modify: `src/app/volunteers/master/page.tsx`

- [ ] **Step 1: Add the import**

Add near the top imports of `src/app/volunteers/master/page.tsx`:

```tsx
import { CertificateViewer } from "@/modules/my-info/components/certificate-viewer";
```

- [ ] **Step 2: Replace the Download anchor**

Find (around lines 320-327):

```tsx
                        {row.cert && (
                          <a
                            href={`/my-info/certificate/${row.cert.id}`}
                            className="text-xs text-brand underline underline-offset-2 hover:opacity-75"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Download
                          </a>
```

Replace with:

```tsx
                        {row.cert && (
                          <CertificateViewer
                            certId={row.cert.id}
                            fileName={row.cert.fileName}
                            ownerName={row.name}
                          />
```

Note: confirm the master-row display-name field. Run
`grep -n "row\.name\|row\.fullName\|row\.person" src/app/volunteers/master/page.tsx` and
use the existing field. Confirm `row.cert.fileName` is populated (Step 3).

- [ ] **Step 3: Ensure `fileName` is available on the master row's cert**

Run: `grep -rn "fileName\|cert:" src/modules/volunteers/services/compliance.ts`
- If `masterCompliance` already includes `fileName` on the cert shape, no change.
- If not, add `fileName` to the selected cert fields in `masterCompliance`
  (`src/modules/volunteers/services/compliance.ts`).

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/volunteers/master/page.tsx src/modules/volunteers/services/compliance.ts
git commit -m "feat(hipaa): use CertificateViewer in master roster"
```

---

## Task 8: Full verification (build + manual smoke)

**Files:** none (verification only)

- [ ] **Step 1: Full static checks + test suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck/lint clean; full Vitest suite passes (including the new
`content-disposition` tests). Note: the suite needs the test database — if it is not
running, start it per the repo's normal flow (`npm run db:up` then `npm run test:prepare`)
before `npm test`.

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds (catches client/server boundary mistakes — e.g. importing a
client component incorrectly).

- [ ] **Step 3: Manual smoke test in the running app**

Run: `npm run dev`, then in the browser verify each surface:

1. **My Info** (`/my-info`) as a member with a cert: click **View** on the current cert
   and on a history row → modal opens, PDF renders in the iframe. **Download** in the
   footer downloads the file; **Open in new tab** opens the inline PDF. **Escape**,
   backdrop click, and **✕** all close the modal and return focus to the View button.
2. **Department roster** (`/volunteers`) as a department director: **View** on a member's
   row shows that member's cert with their name in the modal header.
3. **Master roster** (`/volunteers/master`) as a compliance manager: **View** on any row
   shows the cert with the owner's name in the header.
4. Confirm no row still shows a bare "Download" link (the viewer replaced them).

- [ ] **Step 4: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore(hipaa): finalize in-app cert PDF viewer" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** inline serving (Task 2 + helper Task 1), modal primitive (Task 3),
  CertificateViewer with View/Download/Open-in-new-tab (Task 4), wiring into all three
  surfaces (Tasks 5-7), error/mobile fallbacks via footer links (Task 4), verification
  (Task 8). Onboarding step intentionally excluded per spec scope.
- **Testing deviation from default TDD** is deliberate and documented under "Testing
  reality": the repo has no React DOM test infrastructure and the route depends on
  un-mocked `auth()`. The pure helper is TDD'd; components and the route are verified by
  typecheck/lint/build + manual smoke. Do not add a DOM test stack.
- **Type consistency:** `certificateContentDisposition(fileName, inline)`,
  `Modal({ open, onClose, title, children, footer })`, and
  `CertificateViewer({ certId, fileName, ownerName })` are used consistently across tasks.
- **Open confirmations flagged in-task:** the exact member display-name field and whether
  `fileName` is already on the roster cert shapes (Tasks 6-7 include grep checks and a
  fallback to extend the compliance service `select`).
