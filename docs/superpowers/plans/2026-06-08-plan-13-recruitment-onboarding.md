# Plan 13 — Recruitment Onboarding & Roster Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accepted applicants complete a codified onboarding contract via a tokenized public link, and an admin bulk-promotes submitted contracts into the term roster — creating/reactivating `Person` + `TermMembership` and auto-wiring the HIPAA certificate and an EPIC request.

**Architecture:** A new `OnboardingContract` model tied 1:1 to an `Acceptance`. A public `/onboard/[token]` form (no auth). An admin onboarding surface (send links + bulk promote, gated `recruitment.review_all`). The promotion service writes the shared platform models (`Person`/`TermMembership`/`HipaaCertificate`/`EpicRequest`) DIRECTLY via prisma (no `@/modules/*` cross-imports), inlining the few invariants. Plan 11/12 code is untouched.

**Tech Stack:** Next.js 16 App Router, Prisma/Postgres, vitest, Playwright. Reuses `@/platform/rbac/engine` (`can`), `@/modules/recruitment/services/review` (`RecruitmentAuthError`), `@/platform/email/send` (`queueEmail`), `@/platform/audit` (`recordAudit`), `@/platform/config` (`UPLOAD_DIR`, `MAX_UPLOAD_MB`), `node:crypto` (`randomUUID`).

**Spec:** `docs/superpowers/specs/2026-06-08-recruitment-onboarding-design.md`.

**Branch:** `plan-13/recruitment-onboarding` (exists, stacked on plan-12).

**Project rule:** NO em-dashes in shipped UI/email text or comments. Use a colon, comma, or plain words.

**Key model facts:** `Person` has a single `name` (combine first+last), unique `netId` and unique `contactEmail`, `epicId?`, `status` (PersonStatus, default ACTIVE). `HipaaCertificate` = personId/fileName/storedName/size/mimeType/completionDate?/source(CertificateSource UPLOAD|IMPORT). `EpicRequest` = personId/kind(EpicRequestKind NEW|MODIFY|RENEW)/status(default PENDING)/requestedById. `TermMembership` = personId/termId/departmentId/kind(MembershipKind DIRECTOR|VOLUNTEER)/status(default ACTIVE). `RecruitmentTrack` and `MembershipKind` share the values "VOLUNTEER"/"DIRECTOR".

---

## File Structure

- `prisma/schema.prisma` + migration — `ContractStatus` enum + `OnboardingContract` model + back-relations.
- `src/platform/test/db.ts` — `resetDb()` gains `"OnboardingContract"`.
- `src/modules/recruitment/email/templates/onboarding.ts` (+ test).
- `src/modules/recruitment/services/onboarding.ts` — `ContractError`, `ContractValidationError`, `createOrResendContract`, `getContractByToken`, `submitContract`, `listOnboarding`.
- `src/modules/recruitment/services/promotion.ts` — `promoteContracts`.
- `src/app/onboard/[token]/{page.tsx, onboard-form.tsx, actions.ts, error.tsx}` — public.
- `src/app/recruitment/cycles/[id]/onboarding/{page.tsx, actions.ts}` — admin.
- `src/app/recruitment/cycles/[id]/page.tsx` — add "Onboarding" link.
- `e2e/recruitment-onboarding.spec.ts`.

---

## Conventions
- Unit tests `npm test -- <path>`; integration tests need `npm run test:prepare` once.
- `npm run typecheck` + `npm run lint` stay clean. Module boundary: recruitment imports only `@/platform/**` and within the module.
- If typecheck errors ONLY in `.next/dev/types/validator.ts`, run `rm -rf .next` (stale gitignored artifact) and retry.
- Commit at the end of every task (colon, no em-dash).

---

### Task 1: Schema — OnboardingContract

**Files:** `prisma/schema.prisma`, `src/platform/test/db.ts`, migration.

- [ ] **Step 1: Add the enum** (near the recruitment enums):
```prisma
enum ContractStatus {
  PENDING
  SUBMITTED
  PROMOTED
}
```

- [ ] **Step 2: Add the model** (append after the `Acceptance` model):
```prisma
model OnboardingContract {
  id                       String         @id @default(cuid())
  acceptanceId             String         @unique
  token                    String         @unique
  status                   ContractStatus @default(PENDING)
  firstName                String
  lastName                 String
  email                    String
  netId                    String?
  phone                    String?
  dateOfBirth              DateTime?
  dietaryRestrictions      String?
  yaleAffiliation          String?
  gradYear                 String?
  agreementSignature       String?
  professionalismSignature String?
  trainingSignature        String?
  initials                 String?
  epicNeeded               Boolean        @default(false)
  hasEpic                  Boolean        @default(false)
  existingEpicId           String?
  epicAccessType           String?
  worksWithYnhh            Boolean        @default(false)
  hipaaStoredName          String?
  hipaaFileName            String?
  hipaaMimeType            String?
  hipaaSize                Int?
  hipaaCompletedAt         DateTime?
  sentAt                   DateTime?
  submittedAt              DateTime?
  promotedAt               DateTime?
  promotedById             String?
  promotedPersonId         String?
  createdAt                DateTime       @default(now())
  updatedAt                DateTime       @updatedAt

  acceptance     Acceptance @relation(fields: [acceptanceId], references: [id], onDelete: Cascade)
  promotedBy     Person?    @relation("contractPromotedBy", fields: [promotedById], references: [id], onDelete: SetNull)
  promotedPerson Person?    @relation("contractPromotedPerson", fields: [promotedPersonId], references: [id], onDelete: SetNull)

  @@index([status])
}
```

- [ ] **Step 3: Back-relations.** In `model Acceptance`, add `contract OnboardingContract?`. In `model Person`, add:
```prisma
  contractsPromoted   OnboardingContract[] @relation("contractPromotedBy")
  contractsPromotedTo OnboardingContract[] @relation("contractPromotedPerson")
```

- [ ] **Step 4: Migration.** `npm run db:migrate -- --name recruitment_onboarding`. Expect the table + enum + FKs (acceptance Cascade, promotedBy/promotedPerson SetNull) + the `@@unique` on acceptanceId and token + `@@index([status])`. If drift refuses migrate dev, hand-write the SQL then `npx prisma migrate resolve --applied <ts>_recruitment_onboarding` and `npx prisma generate`.

- [ ] **Step 5: resetDb.** In `src/platform/test/db.ts` add `"OnboardingContract",` to the TRUNCATE list BEFORE `"Acceptance"`.

- [ ] **Step 6: Verify.** `npx prisma validate` → valid. `npm run typecheck` → clean.

- [ ] **Step 7: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat(recruitment): onboarding contract model"
```

---

### Task 2: Onboarding email template

**Files:** `src/modules/recruitment/email/templates/onboarding.ts` (+ test).

- [ ] **Step 1: Failing test** (`onboarding.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { onboardingEmail } from "./onboarding";

describe("onboardingEmail", () => {
  it("greets, names the cycle, and includes the contract link", () => {
    const { subject, html } = onboardingEmail({ firstName: "Ann", cycleTitle: "Volunteer SU26", contractUrl: "http://x/onboard/tok123" });
    expect(subject).toContain("Volunteer SU26");
    expect(html).toContain("Ann");
    expect(html).toContain("http://x/onboard/tok123");
  });
  it("escapes HTML in user values and has no em-dash", () => {
    const { subject, html } = onboardingEmail({ firstName: "<b>X</b>", cycleTitle: "A & B", contractUrl: "http://x" });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&amp;");
    expect(subject).not.toContain("—");
    expect(html).not.toContain("—");
  });
  it("falls back to a neutral greeting for empty firstName", () => {
    expect(onboardingEmail({ firstName: "", cycleTitle: "C", contractUrl: "http://x" }).html).toContain("there");
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`onboarding.ts`):
```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Onboarding email carrying the tokenized contract link. Plan 11's acceptance
 *  email is separate and unchanged; this is the "complete your contract" step. */
export function onboardingEmail(input: {
  firstName: string;
  cycleTitle: string;
  contractUrl: string;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const cycle = escapeHtml(input.cycleTitle);
  const url = escapeHtml(input.contractUrl);
  return {
    subject: `Complete your HAVEN onboarding for ${input.cycleTitle}`,
    html: `<p>Congratulations ${name},</p><p>To finish joining HAVEN for ${cycle}, please complete your onboarding contract here: <a href="${url}">${url}</a></p><p>It collects your signatures, EPIC access details, and HIPAA certificate.</p>`,
  };
}
```

- [ ] **Step 4: Run — PASS (3 tests).** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/email/templates/onboarding.ts src/modules/recruitment/email/templates/onboarding.test.ts
git commit -m "feat(recruitment): onboarding email template"
```

---

### Task 3: Onboarding service — create/send, fetch, submit, list

**Files:** `src/modules/recruitment/services/onboarding.ts` (+ test).

- [ ] **Step 1: Failing test** (`onboarding.test.ts` in services):
```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import {
  createOrResendContract, getContractByToken, submitContract, listOnboarding,
  ContractError, ContractValidationError,
} from "./onboarding";

async function seed() {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", emailLower: "ada@yale.edu", netId: "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  return { srr, plain, cycle, acceptance };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates a PENDING contract with a token and queues an onboarding email; resend does not duplicate", async () => {
  const { srr, acceptance } = await seed();
  const c1 = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect(c1.status).toBe("PENDING");
  expect(c1.token).toBeTruthy();
  expect(await prisma.emailLog.count()).toBe(1);
  const c2 = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect(c2.id).toBe(c1.id);
  expect(await prisma.onboardingContract.count()).toBe(1);
  expect(await prisma.emailLog.count()).toBe(2);
});

it("requires review_all to send", async () => {
  const { plain, acceptance } = await seed();
  await expect(createOrResendContract(acceptance.id, plain.id, "http://test")).rejects.toBeInstanceOf(RecruitmentAuthError);
});

it("getContractByToken returns the contract", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  expect((await getContractByToken(c.token))?.id).toBe(c.id);
});

it("submitContract validates signatures + hipaa and stores SUBMITTED", async () => {
  const { srr, acceptance } = await seed();
  const c = await createOrResendContract(acceptance.id, srr.id, "http://test");
  await expect(submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
    agreementSignature: "", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: new Date("2026-01-01"), hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  })).rejects.toBeInstanceOf(ContractValidationError); // agreementSignature missing

  const ok = await submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu", netId: "al99", phone: "203",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: true, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: new Date("2026-01-01"), hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  });
  expect(ok.status).toBe("SUBMITTED");
  expect(ok.hipaaStoredName).toBeTruthy();
  expect(ok.epicNeeded).toBe(true);

  await expect(submitContract(c.token, {
    firstName: "Ada", lastName: "Lovelace", email: "ada@yale.edu",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, worksWithYnhh: false,
    hipaaCompletedAt: new Date("2026-01-01"), hipaaFile: { fileName: "c.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") },
  })).rejects.toBeInstanceOf(ContractError); // already submitted
});

it("listOnboarding returns acceptances with contract status", async () => {
  const { srr, cycle, acceptance } = await seed();
  await createOrResendContract(acceptance.id, srr.id, "http://test");
  const rows = await listOnboarding(cycle.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].contract?.status).toBe("PENDING");
});
```

- [ ] **Step 2: Prepare DB + run — FAIL.**

- [ ] **Step 3: Implement** (`onboarding.ts`):
```ts
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OnboardingContract } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { config } from "@/platform/config";
import { queueEmail } from "@/platform/email/send";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";
import { onboardingEmail } from "../email/templates/onboarding";

export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = "ContractError"; }
}
export class ContractValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(message: string, fieldErrors: Record<string, string> = {}) { super(message); this.name = "ContractValidationError"; this.fieldErrors = fieldErrors; }
}

export async function createOrResendContract(acceptanceId: string, actorId: string, baseUrl: string): Promise<OnboardingContract> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can send onboarding links.");
  const acceptance = await prisma.acceptance.findUnique({
    where: { id: acceptanceId },
    include: { application: { include: { applicant: true, cycle: { select: { title: true } } } }, contract: true },
  });
  if (!acceptance) throw new ContractError("Acceptance not found.");
  const applicant = acceptance.application.applicant;
  let contract = acceptance.contract;
  if (!contract) {
    contract = await prisma.onboardingContract.create({
      data: {
        acceptanceId, token: randomUUID(), firstName: applicant.firstName, lastName: applicant.lastName,
        email: applicant.email, netId: applicant.netId, phone: applicant.phone,
      },
    });
  }
  const url = `${baseUrl}/onboard/${contract.token}`;
  const email = onboardingEmail({ firstName: contract.firstName, cycleTitle: acceptance.application.cycle.title, contractUrl: url });
  const c = contract;
  await prisma.$transaction(async (tx) => {
    await queueEmail(tx, { to: c.email, subject: email.subject, html: email.html, template: "recruitment.onboarding" });
    await tx.onboardingContract.update({ where: { id: c.id }, data: { sentAt: new Date() } });
  });
  await recordAudit({ actorPersonId: actorId, action: "recruitment.onboarding_send", entityType: "OnboardingContract", entityId: c.id });
  return c;
}

export async function getContractByToken(token: string) {
  return prisma.onboardingContract.findUnique({ where: { token } });
}

export type ContractSubmission = {
  firstName: string; lastName: string; email: string; netId?: string; phone?: string;
  dateOfBirth?: Date; dietaryRestrictions?: string; yaleAffiliation?: string; gradYear?: string;
  agreementSignature: string; professionalismSignature: string; trainingSignature: string; initials: string;
  epicNeeded: boolean; hasEpic: boolean; existingEpicId?: string; epicAccessType?: string; worksWithYnhh: boolean;
  hipaaCompletedAt?: Date; hipaaFile?: { fileName: string; mimeType: string; bytes: Buffer };
};

export async function submitContract(token: string, input: ContractSubmission): Promise<OnboardingContract> {
  const contract = await prisma.onboardingContract.findUnique({ where: { token } });
  if (!contract) throw new ContractError("This onboarding link is not valid.");
  if (contract.status !== "PENDING") throw new ContractError("This onboarding form has already been submitted.");

  const e: Record<string, string> = {};
  if (!input.firstName?.trim()) e.firstName = "required";
  if (!input.lastName?.trim()) e.lastName = "required";
  if (!input.email?.trim()) e.email = "required";
  if (!input.agreementSignature?.trim()) e.agreementSignature = "required";
  if (!input.professionalismSignature?.trim()) e.professionalismSignature = "required";
  if (!input.trainingSignature?.trim()) e.trainingSignature = "required";
  if (!input.initials?.trim()) e.initials = "required";
  if (!input.hipaaCompletedAt) e.hipaaCompletedAt = "required";
  if (!input.hipaaFile && !contract.hipaaStoredName) e.hipaaFile = "required";
  if (input.hasEpic && !input.existingEpicId?.trim()) e.existingEpicId = "required when you already have EPIC";
  if (Object.keys(e).length > 0) throw new ContractValidationError("Please fix the highlighted fields.", e);

  let fileRef: { hipaaStoredName?: string; hipaaFileName?: string; hipaaMimeType?: string; hipaaSize?: number } = {};
  if (input.hipaaFile) {
    const capBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
    if (input.hipaaFile.bytes.length > capBytes) throw new ContractValidationError("File too large.", { hipaaFile: `max ${config.MAX_UPLOAD_MB} MB` });
    const dir = path.resolve(path.join(config.UPLOAD_DIR, "onboarding", contract.id));
    await fs.mkdir(dir, { recursive: true });
    const safeExt = (path.extname(input.hipaaFile.fileName).match(/^\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? "";
    const storedName = `hipaa-${randomUUID()}${safeExt}`;
    const diskPath = path.resolve(dir, storedName);
    if (!diskPath.startsWith(dir + path.sep)) throw new ContractValidationError("Invalid file.", { hipaaFile: "invalid" });
    await fs.writeFile(diskPath, input.hipaaFile.bytes);
    fileRef = { hipaaStoredName: storedName, hipaaFileName: input.hipaaFile.fileName, hipaaMimeType: input.hipaaFile.mimeType, hipaaSize: input.hipaaFile.bytes.length };
  }

  const updated = await prisma.onboardingContract.update({
    where: { id: contract.id },
    data: {
      firstName: input.firstName.trim(), lastName: input.lastName.trim(), email: input.email.trim(),
      netId: input.netId?.trim() || null, phone: input.phone?.trim() || null, dateOfBirth: input.dateOfBirth ?? null,
      dietaryRestrictions: input.dietaryRestrictions?.trim() || null, yaleAffiliation: input.yaleAffiliation?.trim() || null, gradYear: input.gradYear?.trim() || null,
      agreementSignature: input.agreementSignature.trim(), professionalismSignature: input.professionalismSignature.trim(),
      trainingSignature: input.trainingSignature.trim(), initials: input.initials.trim(),
      epicNeeded: input.epicNeeded, hasEpic: input.hasEpic, existingEpicId: input.existingEpicId?.trim() || null,
      epicAccessType: input.epicAccessType?.trim() || null, worksWithYnhh: input.worksWithYnhh,
      hipaaCompletedAt: input.hipaaCompletedAt ?? null, ...fileRef,
      status: "SUBMITTED", submittedAt: new Date(),
    },
  });
  await recordAudit({ action: "recruitment.onboarding_submit", entityType: "OnboardingContract", entityId: contract.id });
  return updated;
}

export async function listOnboarding(cycleId: string) {
  return prisma.acceptance.findMany({
    where: { application: { cycleId } },
    include: { application: { include: { applicant: { select: { firstName: true, lastName: true, email: true } } } }, contract: true },
    orderBy: { createdAt: "asc" },
  });
}
```

- [ ] **Step 4: Run — PASS (5 tests).** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/onboarding.ts src/modules/recruitment/services/onboarding.test.ts
git commit -m "feat(recruitment): onboarding service: send link, submit contract, list"
```

---

### Task 4: Promotion service

**Files:** `src/modules/recruitment/services/promotion.ts` (+ test).

- [ ] **Step 1: Failing test** (`promotion.test.ts`):
```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { RecruitmentAuthError } from "./review";
import { promoteContracts } from "./promotion";

async function seedSubmitted(opts: { netId?: string; email?: string; epicNeeded?: boolean; existingEpicId?: string } = {}) {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const srhd = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email: opts.email ?? "ada@yale.edu", emailLower: (opts.email ?? "ada@yale.edu").toLowerCase(), netId: opts.netId ?? "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  const contract = await prisma.onboardingContract.create({ data: {
    acceptanceId: acceptance.id, token: `t-${Math.random()}`, status: "SUBMITTED",
    firstName: "Ada", lastName: "Lovelace", email: opts.email ?? "ada@yale.edu", netId: opts.netId ?? "al99",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: opts.epicNeeded ?? false, hasEpic: !!opts.existingEpicId, existingEpicId: opts.existingEpicId,
    hipaaStoredName: "hipaa-x.pdf", hipaaFileName: "c.pdf", hipaaMimeType: "application/pdf", hipaaSize: 10, hipaaCompletedAt: new Date("2026-01-01"),
    submittedAt: new Date(),
  } });
  return { term, srhd, srr, cycle, contract };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("creates a new ACTIVE person + membership + hipaa cert + epic request when epicNeeded", async () => {
  const { term, srhd, srr, contract } = await seedSubmitted({ epicNeeded: true });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 1, reactivated: 0, skipped: 0 });
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.status).toBe("ACTIVE");
  expect(await prisma.termMembership.count({ where: { personId: person.id, termId: term.id, departmentId: srhd.id, kind: "VOLUNTEER" } })).toBe(1);
  expect(await prisma.hipaaCertificate.count({ where: { personId: person.id } })).toBe(1);
  expect(await prisma.epicRequest.count({ where: { personId: person.id, kind: "NEW" } })).toBe(1);
  const after = await prisma.onboardingContract.findUniqueOrThrow({ where: { id: contract.id } });
  expect(after.status).toBe("PROMOTED");
  expect(after.promotedPersonId).toBe(person.id);
});

it("reactivates a returning person matched by netId without duplicating", async () => {
  const existing = await prisma.person.create({ data: { name: "Ada Lovelace", netId: "al99", status: "OFFBOARDED" } });
  const { srr, contract } = await seedSubmitted({ netId: "al99", epicNeeded: false });
  const res = await promoteContracts([contract.id], srr.id);
  expect(res).toEqual({ created: 0, reactivated: 1, skipped: 0 });
  expect(await prisma.person.count({ where: { netId: "al99" } })).toBe(1);
  expect((await prisma.person.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe("ACTIVE");
});

it("sets epicId from existingEpicId and creates no epic request", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: true, existingEpicId: "EPIC777" });
  await promoteContracts([contract.id], srr.id);
  const person = await prisma.person.findFirstOrThrow({ where: { netId: "al99" } });
  expect(person.epicId).toBe("EPIC777");
  expect(await prisma.epicRequest.count({ where: { personId: person.id } })).toBe(0);
});

it("skips a non-SUBMITTED contract (idempotent re-run)", async () => {
  const { srr, contract } = await seedSubmitted({ epicNeeded: false });
  await promoteContracts([contract.id], srr.id);
  const res2 = await promoteContracts([contract.id], srr.id);
  expect(res2).toEqual({ created: 0, reactivated: 0, skipped: 1 });
});

it("requires review_all", async () => {
  const { contract } = await seedSubmitted();
  const plain = await prisma.person.create({ data: { name: "No", status: "ACTIVE" } });
  await expect(promoteContracts([contract.id], plain.id)).rejects.toBeInstanceOf(RecruitmentAuthError);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** (`promotion.ts`):
```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { RecruitmentAuthError } from "./review";

export async function promoteContracts(contractIds: string[], actorId: string): Promise<{ created: number; reactivated: number; skipped: number }> {
  if (!(await can(actorId, "recruitment.review_all"))) throw new RecruitmentAuthError("Only SRR can promote onboarding contracts.");
  let created = 0, reactivated = 0, skipped = 0;

  for (const id of contractIds) {
    const contract = await prisma.onboardingContract.findUnique({
      where: { id },
      include: { acceptance: { include: { application: { include: { cycle: { select: { termId: true, track: true } } } } } } },
    });
    if (!contract || contract.status !== "SUBMITTED") { skipped += 1; continue; }
    const cycle = contract.acceptance.application.cycle;
    const dept = await prisma.department.findUnique({ where: { code: contract.acceptance.departmentCode } });
    if (!dept) { skipped += 1; continue; }
    const kind: "DIRECTOR" | "VOLUNTEER" = cycle.track === "DIRECTOR" ? "DIRECTOR" : "VOLUNTEER";

    try {
      const wasNew = await prisma.$transaction(async (tx) => {
        // 1. Match-or-create Person (netId then contactEmail).
        let person = contract.netId
          ? await tx.person.findFirst({ where: { netId: { equals: contract.netId, mode: "insensitive" } } })
          : null;
        if (!person && contract.email) {
          person = await tx.person.findFirst({ where: { contactEmail: { equals: contract.email, mode: "insensitive" } } });
        }
        let isNew = false;
        if (person) {
          await tx.person.update({
            where: { id: person.id },
            data: {
              status: "ACTIVE",
              phone: person.phone ?? contract.phone,
              yaleAffiliation: person.yaleAffiliation ?? contract.yaleAffiliation,
              gradYear: person.gradYear ?? contract.gradYear,
              epicId: person.epicId ?? contract.existingEpicId,
            },
          });
        } else {
          isNew = true;
          person = await tx.person.create({
            data: {
              name: `${contract.firstName} ${contract.lastName}`.trim(),
              netId: contract.netId, contactEmail: contract.email, phone: contract.phone,
              yaleAffiliation: contract.yaleAffiliation, gradYear: contract.gradYear,
              epicId: contract.existingEpicId, status: "ACTIVE",
            },
          });
        }
        const effectiveEpicId = person.epicId ?? contract.existingEpicId ?? null;

        // 2. Membership (skip if identical exists).
        const existingMembership = await tx.termMembership.findFirst({ where: { personId: person.id, termId: cycle.termId, departmentId: dept.id } });
        if (!existingMembership) {
          await tx.termMembership.create({ data: { personId: person.id, termId: cycle.termId, departmentId: dept.id, kind, status: "ACTIVE" } });
        }

        // 3. HIPAA cert (skip if same stored file already attached).
        if (contract.hipaaStoredName) {
          const existingCert = await tx.hipaaCertificate.findFirst({ where: { personId: person.id, storedName: contract.hipaaStoredName } });
          if (!existingCert) {
            await tx.hipaaCertificate.create({
              data: {
                personId: person.id, fileName: contract.hipaaFileName ?? contract.hipaaStoredName, storedName: contract.hipaaStoredName,
                size: contract.hipaaSize ?? 0, mimeType: contract.hipaaMimeType ?? "application/octet-stream",
                completionDate: contract.hipaaCompletedAt, source: "IMPORT",
              },
            });
          }
        }

        // 4. EPIC request (only when needed, no epicId, no open request).
        if (contract.epicNeeded && !effectiveEpicId) {
          const openReq = await tx.epicRequest.findFirst({ where: { personId: person.id, status: { in: ["PENDING", "SUBMITTED"] } } });
          if (!openReq) {
            await tx.epicRequest.create({ data: { personId: person.id, kind: "NEW", requestedById: actorId } });
          }
        }

        // 5. Mark promoted.
        await tx.onboardingContract.update({ where: { id: contract.id }, data: { status: "PROMOTED", promotedAt: new Date(), promotedById: actorId, promotedPersonId: person.id } });
        return isNew;
      });
      if (wasNew) created += 1; else reactivated += 1;
      await recordAudit({ actorPersonId: actorId, action: "recruitment.promote", entityType: "OnboardingContract", entityId: id });
    } catch {
      skipped += 1;
    }
  }
  return { created, reactivated, skipped };
}
```

- [ ] **Step 4: Run — PASS (5 tests).** Then `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/modules/recruitment/services/promotion.ts src/modules/recruitment/services/promotion.test.ts
git commit -m "feat(recruitment): promotion service: person, membership, hipaa, epic"
```

---

### Task 5: Public onboarding contract form

**Files:** `src/app/onboard/[token]/{page.tsx, onboard-form.tsx, actions.ts, error.tsx}`.

This route calls NO auth guard (the token is the capability), exactly like `/apply/[slug]`.

- [ ] **Step 1: Submit action** (`actions.ts`):
```ts
"use server";
import { submitContract, ContractError, ContractValidationError, type ContractSubmission } from "@/modules/recruitment/services/onboarding";

export type SubmitResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function submitOnboarding(token: string, formData: FormData): Promise<SubmitResult> {
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const bool = (k: string) => formData.get(k) === "on";
  const dob = str("dateOfBirth");
  const hipaaAt = str("hipaaCompletedAt");
  const file = formData.get("hipaaFile");
  const input: ContractSubmission = {
    firstName: str("firstName"), lastName: str("lastName"), email: str("email"), netId: str("netId") || undefined, phone: str("phone") || undefined,
    dateOfBirth: dob ? new Date(dob) : undefined, dietaryRestrictions: str("dietaryRestrictions") || undefined,
    yaleAffiliation: str("yaleAffiliation") || undefined, gradYear: str("gradYear") || undefined,
    agreementSignature: str("agreementSignature"), professionalismSignature: str("professionalismSignature"),
    trainingSignature: str("trainingSignature"), initials: str("initials"),
    epicNeeded: bool("epicNeeded"), hasEpic: bool("hasEpic"), existingEpicId: str("existingEpicId") || undefined,
    epicAccessType: str("epicAccessType") || undefined, worksWithYnhh: bool("worksWithYnhh"),
    hipaaCompletedAt: hipaaAt ? new Date(hipaaAt) : undefined,
    hipaaFile: file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type, bytes: Buffer.from(await file.arrayBuffer()) } : undefined,
  };
  try {
    await submitContract(token, input);
    return { ok: true };
  } catch (err) {
    if (err instanceof ContractValidationError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof ContractError) return { ok: false, message: err.message };
    throw err;
  }
}
```

- [ ] **Step 2: Page (server)** (`page.tsx`):
```tsx
import { getContractByToken } from "@/modules/recruitment/services/onboarding";
import { OnboardForm } from "./onboard-form";

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const contract = await getContractByToken(token);
  if (!contract || contract.status !== "PENDING") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">This onboarding form is not available</h1>
        <p className="mt-2 text-slate-500">The link may be invalid or already completed.</p>
      </main>
    );
  }
  const prefill = { firstName: contract.firstName, lastName: contract.lastName, email: contract.email, netId: contract.netId ?? "", phone: contract.phone ?? "" };
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">HAVEN onboarding</h1>
      <OnboardForm token={contract.token} prefill={prefill} />
    </main>
  );
}
```

- [ ] **Step 3: Client form** (`onboard-form.tsx`). Renders the codified sections (identity, signatures, EPIC intake conditional on the hasEpic checkbox, HIPAA file + date) and posts to `submitOnboarding`:
```tsx
"use client";
import { useState } from "react";
import { submitOnboarding, type SubmitResult } from "./actions";

type Prefill = { firstName: string; lastName: string; email: string; netId: string; phone: string };

export function OnboardForm({ token, prefill }: { token: string; prefill: Prefill }) {
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hasEpic, setHasEpic] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    const res = await submitOnboarding(token, new FormData(e.currentTarget));
    setResult(res);
    setSubmitting(false);
  }
  if (result?.ok) {
    return <p className="mt-8 rounded border border-green-300 bg-green-50 px-4 py-3 text-green-800">Thanks, your onboarding is complete. We will be in touch with next steps.</p>;
  }
  const err = (k: string) => (result && !result.ok ? result.fieldErrors?.[k] : undefined);
  const field = (label: string, name: string, opts: { type?: string; defaultValue?: string; required?: boolean } = {}) => (
    <label className="block text-sm">{label}{opts.required && <span className="text-red-600"> *</span>}
      <input name={name} type={opts.type ?? "text"} defaultValue={opts.defaultValue} className="mt-1 w-full rounded border px-2 py-1" />
      {err(name) && <span className="block text-xs text-red-600">{err(name)}</span>}
    </label>
  );

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-6">
      {result && !result.ok && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{result.message}</p>}
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">Your information</legend>
        {field("First name", "firstName", { defaultValue: prefill.firstName, required: true })}
        {field("Last name", "lastName", { defaultValue: prefill.lastName, required: true })}
        {field("Email", "email", { type: "email", defaultValue: prefill.email, required: true })}
        {field("NetID", "netId", { defaultValue: prefill.netId })}
        {field("Phone", "phone", { defaultValue: prefill.phone })}
        {field("Date of birth", "dateOfBirth", { type: "date" })}
        {field("Dietary restrictions", "dietaryRestrictions")}
      </fieldset>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">Acknowledgements</legend>
        {field("Volunteer agreement (type your full name)", "agreementSignature", { required: true })}
        {field("Professionalism policy (type your full name)", "professionalismSignature", { required: true })}
        {field("Training acknowledgement (type your full name)", "trainingSignature", { required: true })}
        {field("Initials", "initials", { required: true })}
      </fieldset>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">EPIC access</legend>
        <label className="block text-sm"><input type="checkbox" name="epicNeeded" /> EPIC access is required for my role</label>
        <label className="block text-sm"><input type="checkbox" name="hasEpic" checked={hasEpic} onChange={(e) => setHasEpic(e.target.checked)} /> I already have an EPIC ID</label>
        {hasEpic && field("Existing EPIC ID", "existingEpicId", { required: true })}
        {field("Access type (if known)", "epicAccessType")}
        <label className="block text-sm"><input type="checkbox" name="worksWithYnhh" /> I currently work with Yale New Haven Hospital</label>
      </fieldset>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold uppercase tracking-wide text-slate-400">HIPAA</legend>
        {field("HIPAA completion date", "hipaaCompletedAt", { type: "date", required: true })}
        <label className="block text-sm">HIPAA certificate (PDF)<span className="text-red-600"> *</span>
          <input name="hipaaFile" type="file" className="mt-1 w-full rounded border px-2 py-1" />
          {err("hipaaFile") && <span className="block text-xs text-red-600">{err("hipaaFile")}</span>}
        </label>
      </fieldset>
      <button disabled={submitting} className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{submitting ? "Submitting..." : "Submit onboarding"}</button>
    </form>
  );
}
```

- [ ] **Step 4: Error boundary** (`error.tsx`):
```tsx
"use client";
export default function OnboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-slate-500">Please try again. If the problem persists, contact HAVEN IT.</p>
      <button onClick={() => reset()} className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm text-white">Try again</button>
    </main>
  );
}
```

- [ ] **Step 5: Verify.** `npm run typecheck` → clean. `npx eslint src` → clean. No em-dashes. No auth guard in the route.

- [ ] **Step 6: Commit.**
```bash
git add src/app/onboard
git commit -m "feat(recruitment): public onboarding contract form"
```

---

### Task 6: Admin onboarding surface

**Files:** `src/app/recruitment/cycles/[id]/onboarding/{page.tsx, actions.ts}`, and the cycle overview link.

- [ ] **Step 1: Overview link.** In `src/app/recruitment/cycles/[id]/page.tsx`, in the `flex gap-3` link row add:
```tsx
        <Link href={`/recruitment/cycles/${id}/onboarding`} className="rounded-md border px-3 py-1.5 text-sm">Onboarding</Link>
```

- [ ] **Step 2: Actions** (`onboarding/actions.ts`):
```ts
"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requirePersonSession } from "@/platform/auth/session";
import { createOrResendContract, ContractError } from "@/modules/recruitment/services/onboarding";
import { promoteContracts } from "@/modules/recruitment/services/promotion";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}
function bounce(cycleId: string, msg: string) {
  return `/recruitment/cycles/${cycleId}/onboarding?msg=${encodeURIComponent(msg)}`;
}

export async function sendLinksAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("acceptanceId").map(String);
  const base = await baseUrl();
  let sent = 0;
  try {
    for (const acceptanceId of ids) { await createOrResendContract(acceptanceId, person.personId, base); sent += 1; }
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof ContractError) redirect(bounce(cycleId, (err as Error).message));
    throw err;
  }
  redirect(bounce(cycleId, `Sent ${sent} onboarding link(s).`));
}

export async function promoteAction(cycleId: string, formData: FormData) {
  const person = await requirePersonSession();
  const ids = formData.getAll("contractId").map(String);
  try {
    const res = await promoteContracts(ids, person.personId);
    redirect(bounce(cycleId, `Promoted: ${res.created} new, ${res.reactivated} returning, ${res.skipped} skipped.`));
  } catch (err) {
    if (err instanceof RecruitmentAuthError) redirect(bounce(cycleId, (err as Error).message));
    throw err;
  }
}
```

- [ ] **Step 3: Page** (`onboarding/page.tsx`) — gated `recruitment.review_all`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { listOnboarding } from "@/modules/recruitment/services/onboarding";
import { sendLinksAction, promoteAction } from "./actions";

function statusLabel(c: { status: string } | null): string {
  if (!c) return "No contract";
  if (c.status === "PENDING") return "Sent";
  if (c.status === "SUBMITTED") return "Submitted";
  return "Promoted";
}

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const { id } = await params;
  const { msg } = await searchParams;
  await requirePermission("recruitment.review_all");
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const rows = await listOnboarding(id);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Onboarding: {cycle.title}</h1>
      {msg && <p className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</p>}

      <form action={sendLinksAction.bind(null, id)} className="mt-6">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500"><th className="py-2"></th><th>Applicant</th><th>Dept</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-2">{!r.contract && <input type="checkbox" name="acceptanceId" value={r.id} />}</td>
                <td>{r.application.applicant.firstName} {r.application.applicant.lastName}</td>
                <td>{r.departmentCode}</td>
                <td>{statusLabel(r.contract)}{r.contract?.promotedPersonId ? " (on roster)" : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="py-6 text-slate-500">No accepted applicants yet.</td></tr>}
          </tbody>
        </table>
        <button className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Send onboarding links</button>
      </form>

      <form action={promoteAction.bind(null, id)} className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Promote submitted contracts</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {rows.filter((r) => r.contract?.status === "SUBMITTED").map((r) => (
            <li key={r.id}><label><input type="checkbox" name="contractId" value={r.contract!.id} /> {r.application.applicant.firstName} {r.application.applicant.lastName} ({r.departmentCode})</label></li>
          ))}
          {rows.filter((r) => r.contract?.status === "SUBMITTED").length === 0 && <li className="text-slate-500">No submitted contracts ready to promote.</li>}
        </ul>
        <button className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white">Promote selected</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Verify.** `npm run typecheck` → clean. `npx eslint src` → clean. No em-dashes.

- [ ] **Step 5: Commit.**
```bash
git add "src/app/recruitment/cycles/[id]/onboarding" "src/app/recruitment/cycles/[id]/page.tsx"
git commit -m "feat(recruitment): admin onboarding surface: send links and bulk promote"
```

---

### Task 7: e2e — onboarding + promotion

**Files:** `e2e/recruitment-onboarding.spec.ts`.

Build a volunteer cycle, submit + accept an applicant (reuse the Plan 11 review e2e helpers), send the onboarding link, open `/onboard/[token]` unauthenticated and submit with a cert, then bulk promote and assert the result banner. Read `e2e/recruitment-review.spec.ts` for the build/accept helpers and `playwright.config.ts`.

- [ ] **Step 1: Write the spec.** Core flow + assertions. Key steps: login as `j.carney@yale.edu` (review_all); create + publish a VOLUNTEER cycle with a DEPARTMENT_CHOICE field; submit a public application choosing SRHD; accept it (applicant detail accept panel); go to `/recruitment/cycles/<id>/onboarding`, select the accepted applicant, "Send onboarding links"; read the contract token from the DB is not available in e2e, so instead: after sending, the onboarding page does not expose the token. To exercise the public form in e2e, navigate via the link is not possible without the token. SIMPLIFY: the e2e asserts the admin flow through promotion by (a) sending links, then (b) since the public submit cannot be reached without the emailed token, the e2e instead verifies the "Send N onboarding link(s)" banner and the row status flips to "Sent". The full public-submit + promote path is covered by the integration tests (Tasks 3, 4). Document this scope limit in the test as a comment.

```ts
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

async function devLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.click('button:has-text("Dev sign in")');
  await page.waitForURL((url) => url.pathname === "/");
}

// NOTE: the public /onboard/[token] submit + bulk promote are covered by integration
// tests (onboarding.test.ts, promotion.test.ts). The e2e cannot read the emailed token,
// so it verifies the admin send-links flow end to end (accept -> send -> status "Sent").
test("onboarding: accept then send onboarding link", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/recruitment/cycles/new");
  await page.fill('input[name="title"]', "Onboard E2E");
  const slug = `onboard-e2e-${Date.now()}`;
  await page.fill('input[name="publicSlug"]', slug);
  await page.fill('input[name="departments"]', "SRHD");
  await page.click('button:has-text("Create")');
  await page.waitForURL((url) => url.pathname.includes("/builder"));
  const cycleId = page.url().split("/cycles/")[1].split("/")[0];
  const idForm = page.locator("section", { hasText: "Your information" }).locator('form:has(select[name="type"])');
  await idForm.locator('input[name="label"]').fill("1st choice department");
  await idForm.locator('select[name="type"]').selectOption("DEPARTMENT_CHOICE");
  await idForm.locator('button:has-text("Add field")').click();
  await page.goto(`/recruitment/cycles/${cycleId}`);
  await page.click('button:has-text("Publish")');
  await expect(page.locator("span", { hasText: "OPEN" })).toBeVisible();

  const ctx = await page.context().browser()!.newContext();
  const apply = await ctx.newPage();
  await apply.goto(`/apply/${slug}`);
  await apply.fill('input[name="first_name"]', "Ona");
  await apply.fill('input[name="last_name"]', "Boarder");
  await apply.fill('input[name="email"]', "ona@yale.edu");
  await apply.selectOption('select[name="1st_choice_department"]', "SRHD");
  await apply.click('button:has-text("Submit application")');
  await expect(apply.getByText(/your application was received/i)).toBeVisible();
  await ctx.close();

  await page.goto(`/recruitment/cycles/${cycleId}/applicants`);
  await page.getByRole("link", { name: /Ona Boarder/ }).click();
  await page.selectOption('select[name="departmentCode"]', "SRHD");
  await page.click('button:has-text("Accept")');
  await expect(page.getByText(/Accepted into/)).toBeVisible();

  await page.goto(`/recruitment/cycles/${cycleId}/onboarding`);
  await page.check('input[name="acceptanceId"]');
  await page.click('button:has-text("Send onboarding links")');
  await expect(page.getByText(/Sent 1 onboarding link/)).toBeVisible();
  await expect(page.getByText("Sent")).toBeVisible();
});
```

- [ ] **Step 2: Run** `npm run e2e -- recruitment-onboarding.spec.ts`, adapt selectors, iterate to green.

- [ ] **Step 3: Commit.**
```bash
git add e2e/recruitment-onboarding.spec.ts
git commit -m "test(recruitment): e2e accept then send onboarding link"
```

---

### Task 8: Final verification

- [ ] **Step 1:** `npm run test:prepare && npm test` → all green.
- [ ] **Step 2:** `npm run typecheck` clean; `npm run lint` clean; `npm run build` succeeds.
- [ ] **Step 3:** Em-dash sweep `grep -rn "—" src/modules/recruitment src/app/recruitment src/app/onboard src/app/apply | grep -v "\.test\."` → none.
- [ ] **Step 4:** Confirm Plan 11/12 untouched: `git diff f981053..HEAD -- src/modules/recruitment/services/review.ts src/modules/recruitment/services/decisions.ts src/modules/recruitment/services/interview-decisions.ts` shows no changes (the onboarding/promotion work is additive). Commit any fixups.

---

## Self-Review notes (for the executor)

- **Spec coverage:** model (§3) → T1; email (§5) → T2; contract lifecycle + public submit (§3,§4,§5,§8) → T3; promotion + EPIC/HIPAA wiring (§6) → T4; public form (§4) → T5; admin surface (§5) → T6; testing (§9) → T2-4,7; done-criteria (§10) → T8.
- **Cross-domain writes:** promotion (`promotion.ts`) writes `Person`/`TermMembership`/`HipaaCertificate`/`EpicRequest` via prisma only; no `@/modules/admin` or `@/modules/volunteers` imports (lint boundary holds). Plan 11/12 services untouched (verified in T8).
- **Type consistency:** `ContractSubmission` shape used by `submitContract` + the public action; `ContractError`/`ContractValidationError` in `onboarding.ts`, `RecruitmentAuthError` reused from `review.ts`; `promoteContracts` returns `{created, reactivated, skipped}` used by `promoteAction`; `Person.name` is single-field (combine first+last); membership `kind` literal `"VOLUNTEER"|"DIRECTOR"` from `cycle.track`; HIPAA `source: "IMPORT"`; EPIC `kind: "NEW"`.
- **File hardening:** the contract cert write reuses the Plan 10 pattern (size cap, sanitized extension, containment check).
- **e2e scope limit (T7):** the public submit + promote are integration-tested; the e2e covers accept → send-link (it cannot read the emailed token). Documented in the test.
- **No em-dashes** in shipped UI/email; swept in T8.
