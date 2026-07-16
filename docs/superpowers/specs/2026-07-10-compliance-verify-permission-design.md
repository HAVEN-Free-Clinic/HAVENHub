# Split certificate verification from compliance view

Date: 2026-07-10
Branch: `feat/compliance-verify-permission`

## Problem

On the `/volunteers` "Compliance" page, a department director can click **Verify**
on a member's HIPAA certificate. Verifying stamps `verifiedById`/`verifiedAt`,
which clears the `PENDING_VERIFICATION` status of a self-uploaded cert and marks
it compliant. Attesting that a certificate is genuine is a compliance/admin
responsibility, not something a department director should do.

The root cause is that `verifyCertificate` authorizes through
`canViewCertificate`, which returns true for a department director (rule 3:
`volunteers.view` + manages a department the owner is an ACTIVE member of). So
the ability to **view** a department's compliance and the ability to **verify**
a certificate are currently the same capability. They should be separate.

Note: directors already cannot **edit/set** completion dates. On the department
page the date-entry form is gated `canEditDate={isAdmin}`, and the service
(`setCompletionDateAsManager`) requires `volunteers.manage_compliance` or
`admin.access`. No change is needed there; this spec only removes the director
**verify** path and hides its button.

## Goal

- Directors keep a **read-only** compliance view: roster status, plus viewing and
  downloading the certificate PDF (unchanged `canViewCertificate`).
- Verifying a certificate requires `volunteers.manage_compliance` **or**
  `admin.access` — the exact same gate as setting a completion date.
- Compliance managers who are **not** directors retain a working path to verify a
  `PENDING_VERIFICATION` cert (a self-upload that already has a self-reported
  date). This path does not exist today on the master view, so it must be added.

## Non-goals

- No change to `canViewCertificate` or the `/my-info/certificate/[id]` download
  route (directors keep view/download).
- No change to `setCompletionDateAsManager` or director date-editing (already
  blocked).
- No new RBAC permission. The split is the existing **view vs. manage_compliance**
  distinction; reusing `volunteers.manage_compliance` is the split.

## Design

### 1. Service: `verifyCertificate` authorization (`src/modules/volunteers/services/compliance.ts`)

Replace the `canViewCertificate` check with a master-key check that mirrors
`setCompletionDateAsManager`:

```
const isManager = await can(actorPersonId, "volunteers.manage_compliance");
const isAdmin = await can(actorPersonId, "admin.access");
if (!isManager && !isAdmin) {
  throw new ComplianceForbiddenError(
    "Only compliance managers or admins can verify certificates."
  );
}
```

Everything else stays: cert-not-found throws `CertificateNotFoundError`, the
stamp write, and the `compliance.verify` audit row are unchanged. Re-verify
remains allowed for holders. The `canViewCertificate` import is dropped from this
file if it becomes unused.

### 2. Component: `CertificateViewer` (`src/modules/my-info/components/certificate-viewer.tsx`)

Add the following optional props:

- `canVerify?: boolean` — viewer holds `manage_compliance`/`admin`.
- `verified?: boolean` — whether the cert already has a `verifiedAt` stamp.
- `onVerify?: () => Promise<{ error?: string }>` — bound server action.

Render a **Verify** button in the modal footer when
`canVerify && onVerify && hasDate && !verified` (i.e. the `PENDING_VERIFICATION`
case). It sits next to the date-edit controls, shares the existing `error`/
`isPending` handling, and on success closes the modal and calls `router.refresh()`
(same pattern as `handleSubmit`). Verifying from inside the viewer means the
manager looks at the PDF before attesting — better governance than a row button.

Certs that are dateless use the existing "Save and verify" date-entry form
(unchanged); already-verified certs need no button.

### 3. Department page (`src/app/(app)/volunteers/page.tsx`)

- Remove the standalone `<form action={verifyAction}>` Verify button in the row.
- Compute `isManager = await can(viewer.personId, "volunteers.manage_compliance")`
  (top-level, next to the existing `isAdmin`).
- Pass to `CertificateViewer`: `canVerify={isManager || isAdmin}`,
  `verified={Boolean(m.cert?.verifiedAt)}`, and
  `onVerify={verifyAction.bind(null, m.cert.id)}`.
- `verifyAction` is refactored to take `certId` as a bound arg and return
  `{ error?: string }` (matching `setDateAction`) instead of reading `FormData`
  and redirecting. It still calls `requirePermission("volunteers.view")` for a
  coarse gate; the service is the real gate. `canEditDate={isAdmin}` is unchanged.

Directors (view-only, no manage_compliance) now see **View** but no Verify.

### 4. Master page (`src/app/(app)/volunteers/master/page.tsx`)

- Add a `verifyAction(certId)` server action:
  `requirePermission("volunteers.manage_compliance")`, call `verifyCertificate`,
  map `ComplianceForbiddenError`/`CertificateNotFoundError` to `{ error }`,
  `revalidatePath("/volunteers/master")`, return `{}`.
- Pass `canVerify`, `verified={Boolean(row.cert?.verifiedAt)}`, and
  `onVerify={verifyAction.bind(null, row.cert.id)}` to the existing
  `CertificateViewer`. Existing `canEditDate` / `canEditExistingDate` unchanged.

This gives non-director compliance managers a verify path for `PENDING_VERIFICATION`
certs, closing the gap created by removing the director path.

### 5. Tests (`src/modules/volunteers/services/compliance.test.ts`)

Invert the behavior the current suite encodes:

- "allows a same-department director to verify a member's certificate" →
  now asserts `verifyCertificate` **rejects** with `ComplianceForbiddenError`,
  the cert stays unverified (`verifiedAt` null), and **no** `compliance.verify`
  audit row is written.
- "allows a director to verify across a delegation edge" → same inversion.
- The cross-department director rejection test stays green (still forbidden).
- Keep/confirm: `manage_compliance` holder can verify (incl. a department they do
  not direct); add an `admin.access`-only holder can verify.
- A plain member / `volunteers.view`-only non-director cannot verify.

## Verification

- `npx vitest run src/modules/volunteers/services/compliance.test.ts` — red before
  implementation (inverted tests), green after.
- `npx tsc --noEmit` and `npm run lint` clean.
- Manually confirm on the running app (if feasible): a director sees View but no
  Verify on `/volunteers`; a compliance manager can verify a `PENDING_VERIFICATION`
  cert from the viewer modal on both pages.
