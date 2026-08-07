import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import type { ApplicantIdentity } from "./portal-auth";
import type { ApplicantType } from "@/modules/recruitment/engine/visibility";
import { persistFiles, cleanupFiles, validateUploadedFile, type UploadedFile } from "./upload";
import type { FieldValidation } from "../engine/schema-builder";

export class DraftError extends Error {
  constructor(m: string) { super(m); this.name = "DraftError"; }
}

function isFileAnswer(v: unknown): boolean {
  return !!v && typeof v === "object" && "storedName" in (v as object);
}

/** Drop any file-shaped value from a client-supplied answer set. File references
 *  are written ONLY by uploadDraftFile, which validates the upload and generates
 *  the storedName server-side. Trusting a client-supplied storedName here would let
 *  an applicant point a FILE answer at an arbitrary storage key (path traversal /
 *  reading another applicant's upload) and satisfy a required-FILE field with no
 *  real upload. */
function stripFileAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!isFileAnswer(v)) out[k] = v;
  }
  return out;
}

/** Full-replace incoming (already file-free) answers, then overlay the stored
 *  draft's real file references. A file input cannot round-trip through the form's
 *  FormData, so each autosave arrives without it; overlaying the stored refs keeps
 *  a previously uploaded file from being wiped. Non-file answers are intentionally
 *  not preserved so unchecking a box or clearing a select still clears it. */
function mergeDraftAnswers(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (isFileAnswer(v)) merged[k] = v;
  }
  return merged;
}

export type DraftView = {
  applicationId: string;
  /** The real column type. This deliberately does NOT narrow to the two states
   *  the wizard can act on: it used to say "DRAFT" | "SUBMITTED", and getDraft
   *  reached the third value through a cast, so widening ApplicationStatus with
   *  WITHDRAWN compiled silently and /apply/[slug] handed a withdrawn applicant
   *  the wizard back, prefilled with their old answers. Every consumer must
   *  decide what it does with a status it cannot continue. */
  status: ApplicationStatus;
  applicantType: ApplicantType;
  renewalDepartment: string | null;
  answers: Record<string, unknown>;
};

/** The applicant's row (draft or submitted) for this cycle, scoped to identity. */
async function findRow(slug: string, identity: ApplicantIdentity) {
  const cycle = await prisma.recruitmentCycle.findUnique({
    where: { publicSlug: slug },
    select: { id: true, status: true, opensAt: true, closesAt: true },
  });
  if (!cycle) return null;
  const applicant = await prisma.applicant.findFirst({
    where: {
      cycleId: cycle.id,
      OR: [
        { emailLower: identity.email },
        ...(identity.personId ? [{ applicantPersonId: identity.personId }] : []),
      ],
    },
    include: { applications: true },
  });
  return { cycle, applicant };
}

/** Load the applicant's row (draft or submitted) for this cycle, scoped to identity. */
export async function getDraft(slug: string, identity: ApplicantIdentity): Promise<DraftView | null> {
  const row = await findRow(slug, identity);
  const app = row?.applicant?.applications[0];
  if (!app) return null;
  return {
    applicationId: app.id,
    status: app.status,
    applicantType: app.applicantType,
    renewalDepartment: app.renewalDepartment,
    answers: (app.answers as Record<string, unknown>) ?? {},
  };
}

/** Upsert a DRAFT application for the identity.
 *  Rejects with DraftError when the cycle is closed or the row is already SUBMITTED. */
export async function saveDraft(
  slug: string,
  identity: ApplicantIdentity,
  input: { answers: Record<string, unknown>; applicantType?: ApplicantType; renewalDepartment?: string | null },
): Promise<void> {
  const row = await findRow(slug, identity);
  if (!row) throw new DraftError("Cycle not found.");
  const { cycle, applicant } = row;

  const now = new Date();
  const open =
    cycle.status === "OPEN" &&
    (!cycle.opensAt || cycle.opensAt <= now) &&
    (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new DraftError("This application is closed.");

  // Never trust client-supplied file answers on autosave; file refs are written
  // only by uploadDraftFile. Use the stripped set for both the update-merge and the
  // create branches below.
  const cleanAnswers = stripFileAnswers(input.answers);

  const existing = applicant?.applications[0];

  if (existing) {
    // Merge and write under a row lock, re-reading `answers`/`status` inside the
    // transaction. The old code checked `status === "SUBMITTED"` against the stale
    // findRow read and then issued an UNCONDITIONAL update, so a submitApplication
    // that flipped DRAFT->SUBMITTED between the read and the write silently
    // overwrote the server-built submitted answers with the raw draft snapshot
    // (reverting signature blob refs to data URLs, restoring stripped hidden
    // answers) with no recovery path. FOR UPDATE serializes this against submit and
    // against a concurrent uploadDraftFile, and re-reading means the file-ref
    // overlay uses live refs (a file uploaded during this autosave is not dropped).
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; answers: unknown }[]>`
        SELECT "status", "answers" FROM "Application" WHERE "id" = ${existing.id} FOR UPDATE
      `;
      const fresh = locked[0];
      if (!fresh || fresh.status !== "DRAFT") {
        throw new DraftError("Your application has already been submitted.");
      }
      const answers = mergeDraftAnswers(fresh.answers as Record<string, unknown> | null, cleanAnswers);
      await tx.application.update({
        where: { id: existing.id },
        data: {
          answers: answers as never,
          ...(input.applicantType ? { applicantType: input.applicantType } : {}),
          ...(input.renewalDepartment !== undefined ? { renewalDepartment: input.renewalDepartment } : {}),
        },
      });
    });
    return;
  }

  // Create applicant + application atomically via upsert on the (cycleId, emailLower) unique.
  // The update branch handles the rare case of an Applicant row with no Application yet.
  await prisma.applicant.upsert({
    where: { cycleId_emailLower: { cycleId: cycle.id, emailLower: identity.email } },
    create: {
      cycleId: cycle.id,
      applicantPersonId: identity.personId,
      firstName: "",
      lastName: "",
      email: identity.email,
      emailLower: identity.email,
      applications: {
        create: {
          cycleId: cycle.id,
          applicantType: input.applicantType ?? "NEW",
          departmentChoices: [],
          subcommitteeRanking: [],
          status: "DRAFT",
          renewalDepartment: input.renewalDepartment ?? null,
          answers: cleanAnswers as never,
        },
      },
    },
    update: {
      applications: {
        create: {
          cycleId: cycle.id,
          applicantType: input.applicantType ?? "NEW",
          departmentChoices: [],
          subcommitteeRanking: [],
          status: "DRAFT",
          renewalDepartment: input.renewalDepartment ?? null,
          answers: cleanAnswers as never,
        },
      },
    },
  });
}

/** Delete DRAFT applications (and their applicant + uploaded files) not touched
 *  in `olderThanDays`. Submitted applications are never swept.
 *
 *  Only drafts whose cycle is no longer accepting submissions are swept. A draft
 *  in a still-open cycle is preserved no matter how stale, because the applicant
 *  can still return and submit it -- deleting it (and their uploads) would be
 *  irreversible data loss. "Open" mirrors the saveDraft / uploadDraftFile guard:
 *  status OPEN and within the opensAt..closesAt window; the filter below is its
 *  negation. */
export async function sweepAbandonedDrafts(olderThanDays = 30): Promise<{ deleted: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.application.findMany({
    where: {
      status: "DRAFT",
      updatedAt: { lt: cutoff },
      // Cycle is NOT open: closed/archived/not-yet-published status, or its
      // submission window has not started / has already ended.
      cycle: {
        OR: [
          { status: { not: "OPEN" } },
          { opensAt: { gt: now } },
          { closesAt: { lt: now } },
        ],
      },
    },
    select: { id: true, applicantId: true, cycleId: true, answers: true },
  });
  let deleted = 0;
  for (const app of stale) {
    const answers = (app.answers as Record<string, unknown>) ?? {};
    const keys: string[] = [];
    for (const v of Object.values(answers)) {
      if (v && typeof v === "object" && "storedName" in (v as object)) {
        keys.push(`recruitment/${app.cycleId}/${(v as { storedName: string }).storedName}`);
      }
    }
    await cleanupFiles(keys);
    // Deleting the Applicant cascades to its Application (Application FK is onDelete: Cascade).
    await prisma.applicant.delete({ where: { id: app.applicantId } });
    deleted += 1;
  }
  return { deleted };
}

export async function uploadDraftFile(
  slug: string,
  identity: ApplicantIdentity,
  fieldKey: string,
  file: UploadedFile,
): Promise<{ fileName: string }> {
  const row = await findRow(slug, identity);
  if (!row) throw new DraftError("Application not found.");
  const { cycle, applicant } = row;
  const now = new Date();
  const open = cycle.status === "OPEN" && (!cycle.opensAt || cycle.opensAt <= now) && (!cycle.closesAt || cycle.closesAt >= now);
  if (!open) throw new DraftError("This application is closed.");
  const app = applicant?.applications[0];
  if (!app || app.status === "SUBMITTED") throw new DraftError("No editable draft.");

  // The key must be a FILE field in this cycle (the same allowlist defense the
  // submit path uses, since the key builds the storage path).
  const fileField = await prisma.formField.findFirst({ where: { cycleId: cycle.id, key: fieldKey, type: "FILE" }, select: { key: true, validation: true } });
  if (!fileField) throw new DraftError("Unexpected file upload.");

  // Enforce the same size cap and accepted-type rules the submit path applies.
  // Without this, an oversize or disallowed file uploaded here would be carried
  // into the submission unchecked (the submit path never re-validates draft files).
  const maxMb = await getSetting<number>("uploads.maxMb");
  const problem = validateUploadedFile(file, fileField.validation as FieldValidation | null, maxMb);
  if (problem) throw new DraftError(problem.message);

  const { answerPatch, storageKeys } = await persistFiles(cycle.id, { [fieldKey]: file });

  // Merge the file ref under a row lock, re-reading `answers`/`status` INSIDE the
  // transaction. persistFiles is a full object-storage round trip; the old code
  // snapshotted app.answers before it and wrote `{ ...staleAnswers, ...answerPatch }`
  // afterward, so any autosave, sibling upload, or DRAFT->SUBMITTED claim that
  // committed during the upload was silently reverted (typed answers lost, other
  // file refs dropped and orphaned, or the file ref written onto a now-SUBMITTED
  // row). FOR UPDATE serializes the write and re-reads live answers, so only this
  // field is added and everything committed during the upload survives.
  let priorStoredName: string | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; answers: unknown }[]>`
        SELECT "status", "answers" FROM "Application" WHERE "id" = ${app.id} FOR UPDATE
      `;
      const fresh = locked[0];
      if (!fresh || fresh.status !== "DRAFT") {
        throw new DraftError("No editable draft.");
      }
      const freshAnswers = (fresh.answers as Record<string, unknown> | null) ?? {};
      priorStoredName = (freshAnswers[fieldKey] as { storedName?: string } | undefined)?.storedName;
      await tx.application.update({
        where: { id: app.id },
        data: { answers: { ...freshAnswers, ...answerPatch } as never },
      });
    });
  } catch (err) {
    await cleanupFiles(storageKeys);
    throw err;
  }
  // Best-effort delete of the file this one replaced.
  if (priorStoredName) await cleanupFiles([`recruitment/${cycle.id}/${priorStoredName}`]);
  return { fileName: file.fileName };
}
