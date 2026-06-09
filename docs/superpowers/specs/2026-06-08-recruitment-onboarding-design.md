# Recruitment Onboarding & Roster Promotion Design (Plan 13)

**Date:** 2026-06-08
**Status:** Approved (brainstorm) — Plan 13, the fourth sub-project of the Recruitment program
**Module id:** `recruitment`
**Builds on:** Plans 10 (intake), 11 (review/acceptance), 12 (director interviews). Branch `plan-13/recruitment-onboarding` is stacked on `plan-12/recruitment-interviews`.

Plan 13 closes the recruitment loop: an accepted applicant completes a codified **onboarding contract** via a tokenized public link (identity, typed signatures, EPIC access intake, HIPAA certificate), and an admin **bulk-promotes** submitted contracts into the term roster, creating/reactivating `Person` records + `TermMembership`, and auto-wiring the existing compliance (HIPAA) and Volunteers (EPIC) modules. Modeled on the Airtable `SU-26 Volunteer Contracts` and `Director Contracts` tables ("Added to main management?" was the manual promotion step).

Applies to both tracks (a contract is tied to an `Acceptance`, which exists for volunteer accepts and director ACCEPT decisions alike). **Plan 11/12 code is not modified.** Plan 14 (volunteer training + quiz) is separate.

---

## 1. Decisions (from brainstorm)

- **Contract form:** a **codified fixed schema** (not the Plan 10 dynamic builder). Each field has known semantics so promotion can feed `Person`/`TermMembership`/`HipaaCertificate`/`EpicRequest` directly.
- **Promotion trigger:** **bulk admin promote**. Submitting a contract marks it ready; an admin selects ready contracts and promotes them in one batch. Match-or-create the `Person` (by netId then email, reactivating returning members); idempotent.
- **EPIC/HIPAA handoff:** **auto-wire both** on promote (attach the HIPAA cert; create an `EpicRequest` when EPIC is needed and the person has no epicId, or set `person.epicId` from a supplied existing id).
- **Access:** the contract is a public tokenized link (accepted applicants are not platform users). The admin onboarding surface is gated `recruitment.review_all` (promotion writes the master roster).

---

## 2. Cross-domain write approach (architecture)

Promotion must create a `Person` + `TermMembership` (admin domain), a `HipaaCertificate` (compliance), and an `EpicRequest` (Volunteers). The lint module-boundary rule forbids `@/modules/recruitment` from importing `@/modules/admin` or `@/modules/volunteers`. But those are all **shared Prisma models** in the platform schema.

**Decision:** the recruitment promotion service writes these shared models **directly via prisma**, inlining the few invariants that matter (Person ACTIVE; no open Epic request before creating one; kind-NEW requires no epicId). A freshly created recruit satisfies these by construction. This keeps Plan 13 self-contained and lint-clean and matches the `src/modules/admin/services/roster.ts` note that recruitment-driven roster intake is "deferred to the Recruitment module." No `@/modules/*` cross-imports; no changes to Plan 11/12.

---

## 3. Data model

### New enum
```
enum ContractStatus { PENDING, SUBMITTED, PROMOTED }
```

### New model: `OnboardingContract`

| Field | Type | Notes |
|-------|------|-------|
| `id` | String @id @default(cuid()) | |
| `acceptanceId` | String @unique | FK → Acceptance (onDelete: Cascade); one contract per acceptance |
| `token` | String @unique | public-link secret (`cuid`, used in `/onboard/[token]`) |
| `status` | ContractStatus @default(PENDING) | |
| `firstName` | String | identity (prefilled from the applicant, applicant may correct) |
| `lastName` | String | |
| `email` | String | |
| `netId` | String? | |
| `phone` | String? | |
| `dateOfBirth` | DateTime? | |
| `dietaryRestrictions` | String? | |
| `yaleAffiliation` | String? | |
| `gradYear` | String? | |
| `agreementSignature` | String? | typed acknowledgment |
| `professionalismSignature` | String? | typed acknowledgment |
| `trainingSignature` | String? | typed acknowledgment |
| `initials` | String? | typed acknowledgment |
| `epicNeeded` | Boolean @default(false) | does this role need EPIC access |
| `hasEpic` | Boolean @default(false) | applicant already has EPIC |
| `existingEpicId` | String? | if hasEpic |
| `epicAccessType` | String? | requested access type |
| `worksWithYnhh` | Boolean @default(false) | |
| `hipaaStoredName` | String? | uploaded cert: server filename under UPLOAD_DIR |
| `hipaaFileName` | String? | original filename |
| `hipaaMimeType` | String? | |
| `hipaaSize` | Int? | |
| `hipaaCompletedAt` | DateTime? | HIPAA completion date |
| `sentAt` | DateTime? | when the onboarding link email was sent |
| `submittedAt` | DateTime? | when the applicant submitted |
| `promotedAt` | DateTime? | |
| `promotedById` | String? | FK → Person (SetNull); the admin who promoted |
| `promotedPersonId` | String? | FK → Person (SetNull); the created/matched roster Person |
| `createdAt` / `updatedAt` | DateTime | |

- Relations: `acceptance Acceptance`, `promotedBy Person? @relation("contractPromotedBy")`, `promotedPerson Person? @relation("contractPromotedPerson")`. `@@index([status])`.
- Back-relation on `Acceptance`: `contract OnboardingContract?`. Back-relations on `Person`: `contractsPromoted`/`contractsPromotedTo` (the two named relations).
- `src/platform/test/db.ts` `resetDb()` gains `"OnboardingContract"` (before `"Acceptance"`).

**Lifecycle:** `PENDING` (created + link emailed) → `SUBMITTED` (public form completed) → `PROMOTED` (admin bulk-promote wrote Person/membership/handoffs).

---

## 4. Public contract form

`/onboard/[token]` — public, no auth (same carve-out as `/apply/[slug]`: no session guard; the token is the capability).

1. Load the contract by `token`. If missing or `status !== PENDING` (already submitted/promoted), render a closed-state page (no form).
2. Render the codified form, identity prefilled from the contract: identity fields; the four typed-signature acknowledgments; the EPIC intake block (`epicNeeded`, `hasEpic`, `existingEpicId`, `epicAccessType`, `worksWithYnhh`); a HIPAA cert **file upload** + completion date.
3. On submit (server action): validate (identity present; all four signature acknowledgments present; HIPAA cert + `hipaaCompletedAt` present; EPIC fields conditional — `existingEpicId` required when `hasEpic`); write the cert to `UPLOAD_DIR/onboarding/<contractId>/` capped by `MAX_UPLOAD_MB`, filename sanitized + containment-checked (reuse the Plan 10 file-write hardening); set the contract fields, `status = SUBMITTED`, `submittedAt`. Confirmation page.
4. Errors map to per-field inline messages with entered values preserved. Untrusted text renders as escaped React content. No em-dashes.

---

## 5. Onboarding admin surface

`/recruitment/cycles/[id]/onboarding` — gated `requirePermission("recruitment.review_all")`.

- Lists the cycle's **accepted** applicants (its `Acceptance` rows) joined to their contract, each row showing the applicant, department, and contract-status badge: **No contract** / **Sent** / **Submitted** / **Promoted** (with a link to the promoted `Person` once promoted).
- **Bulk "Send onboarding links"** (checkbox-selected accepted applicants without a contract): for each, create an `OnboardingContract` (PENDING, random token, identity seeded from the applicant) and queue an **onboarding email** carrying `/onboard/[token]`. Re-sendable (re-queues the email, stamps `sentAt`); does not duplicate a contract.
- **Bulk "Promote selected"** (checkbox-selected `SUBMITTED` contracts): run promotion (§6); reports `{ created, reactivated, skipped }`.

Two checkbox forms over the same table; each a `review_all`-gated server action.

### Onboarding email
`src/modules/recruitment/email/templates/onboarding.ts` → `onboardingEmail({ firstName, cycleTitle, contractUrl }) → { subject, html }`. HTML-escaped; `template: "recruitment.onboarding"`; carries the `/onboard/[token]` link. (Plan 11's `acceptanceEmail` is unchanged.)

---

## 6. Promotion logic

`promoteContracts(contractIds: string[], actorId: string): Promise<{ created: number; reactivated: number; skipped: number }>` (recruitment service). Requires `recruitment.review_all` (else `RecruitmentAuthError`). For each contract:

- Load the contract with its acceptance → application → cycle (for term + track) and `departmentCode`. If `status !== SUBMITTED`, **skip** (idempotent; counted in `skipped`).
- In one transaction per contract:
  1. **Match-or-create Person:** find by `netId` (case-insensitive) then by `email`/`contactEmail`. If found: set `status = ACTIVE`, fill only missing identity fields (do not clobber), set `epicId` only if absent and the contract supplied `existingEpicId` → `reactivated`. Else create a new ACTIVE `Person` from the contract identity (with `epicId` = `existingEpicId` when present) → `created`.
  2. **Membership:** upsert a `TermMembership` for `(cycle.termId, departmentId of departmentCode, personId)`, `kind` = cycle.track, status ACTIVE. Skip if an identical ACTIVE membership exists.
  3. **HIPAA:** if the contract has a stored cert, create a `HipaaCertificate` (`fileName`, `storedName`, `size`, `mimeType`, `completionDate = hipaaCompletedAt`, `source = IMPORT`) unless a cert with the same `storedName` already exists for the person.
  4. **EPIC:** if `epicNeeded` and the person has no `epicId` and no open (`PENDING`/`SUBMITTED`) `EpicRequest`, create an `EpicRequest` (`kind = NEW`, `personId`, `requestedById = actorId`).
  5. Set the contract `status = PROMOTED`, `promotedAt`, `promotedById = actor`, `promotedPersonId`.
- `recordAudit("recruitment.promote", ...)` per contract.
- A per-contract failure (e.g., a unique `contactEmail` collision on create) is caught, that contract is left un-promoted and counted as `skipped`/failed, and the batch continues.

Department-code → department-id resolution uses the `Department` table.

---

## 7. Services & files

- `prisma/schema.prisma` + migration — `OnboardingContract` + enum + back-relations; `resetDb()`.
- `src/modules/recruitment/email/templates/onboarding.ts` (+ test).
- `src/modules/recruitment/services/onboarding.ts` — `createOrResendContract` (send-links), `getContractByToken`, `submitContract`, `listOnboarding(cycleId)`; typed errors `ContractError`, reuse `RecruitmentAuthError`.
- `src/modules/recruitment/services/promotion.ts` — `promoteContracts`.
- Public: `src/app/onboard/[token]/{page.tsx, onboard-form.tsx, actions.ts, error.tsx}`.
- Admin: `src/app/recruitment/cycles/[id]/onboarding/{page.tsx, actions.ts}`.
- `src/platform/modules/registry.ts` — no new permissions (reuses `recruitment.review_all`); the onboarding link is per-cycle (overview), not top-level nav.

### Typed errors
- `ContractError` (invalid/closed token, validation, wrong state) in `services/onboarding.ts`.
- Reuse `RecruitmentAuthError` for out-of-scope admin actions.

---

## 8. Error handling

- **Invalid/closed token** → closed-state page; submit on a non-PENDING contract → `ContractError`.
- **Contract validation** → per-field inline errors; entered values preserved; missing/oversize/wrong-type file → field error.
- **Promote a non-SUBMITTED contract** → skipped + counted, not an error.
- **Person-match collision** (unique conflict on create) → that contract fails, is counted, batch continues.
- **Out-of-scope admin action** → `RecruitmentAuthError`.
- Public pages carry their own error boundary; untrusted values render as escaped text.

---

## 9. Testing

**Email (unit):** `onboardingEmail` (names candidate/cycle, includes the contract URL, escapes HTML, no em-dash).

**Services (integration):**
- `createOrResendContract` (creates PENDING + token + queues email; re-send re-queues without duplicating).
- `submitContract` (validation: missing signature/cert rejected; happy path stores fields + cert + SUBMITTED; submit on non-PENDING rejected).
- `getContractByToken` / `listOnboarding`.
- `promoteContracts`:
  - creates a NEW ACTIVE Person + membership + HipaaCertificate + EpicRequest (when `epicNeeded`, no epicId);
  - reactivates a returning Person matched by netId WITHOUT duplicating, and adds the membership;
  - sets `epicId` from `existingEpicId` and then does NOT create an EpicRequest;
  - skips EpicRequest when `epicNeeded` is false;
  - skips an already-PROMOTED contract (idempotent re-run);
  - requires `review_all`.

**e2e (Playwright):** accept an applicant (reuse Plan 11 flow) → on the onboarding surface send the link → open `/onboard/[token]` unauthenticated and submit with a cert → bulk promote → assert the new Person, the TermMembership, the HipaaCertificate, and the EpicRequest exist (verified through admin/volunteers surfaces or a direct check).

---

## 10. Done-criteria

- `OnboardingContract` model + migration; `resetDb` updated.
- Admin (`review_all`) can send onboarding links to accepted applicants and bulk-promote submitted contracts.
- The public `/onboard/[token]` form accepts a complete contract (identity, signatures, EPIC intake, HIPAA cert) unauthenticated, with the file hardening from Plan 10.
- Promotion match-or-creates an ACTIVE Person, adds the term membership, attaches the HIPAA cert, and wires EPIC (request or epicId) per the contract, idempotently, writing only shared platform models (no cross-module imports; Plan 11/12 untouched).
- Unit + integration + e2e tests green; CI (lint incl. module-boundary, typecheck, tests) passes.
