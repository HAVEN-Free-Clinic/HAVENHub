// src/modules/recruitment/services/drafts.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";
import { persistFiles, cleanupFiles, type UploadedFile } from "./upload";

export class DraftError extends Error {
  constructor(m: string) { super(m); this.name = "DraftError"; }
}

export type DraftView = {
  applicationId: string;
  status: "DRAFT" | "SUBMITTED";
  applicantType: "NEW" | "RENEWAL";
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
    status: app.status as "DRAFT" | "SUBMITTED",
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
  input: { answers: Record<string, unknown>; applicantType?: "NEW" | "RENEWAL"; renewalDepartment?: string | null },
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

  const existing = applicant?.applications[0];
  if (existing && existing.status === "SUBMITTED") {
    throw new DraftError("Your application has already been submitted.");
  }

  const data = {
    answers: input.answers as never,
    ...(input.applicantType ? { applicantType: input.applicantType } : {}),
    ...(input.renewalDepartment !== undefined ? { renewalDepartment: input.renewalDepartment } : {}),
  };

  if (existing) {
    await prisma.application.update({ where: { id: existing.id }, data });
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
          answers: input.answers as never,
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
          answers: input.answers as never,
        },
      },
    },
  });
}

/** Delete DRAFT applications (and their applicant + uploaded files) not touched
 *  in `olderThanDays`. Submitted applications are never swept. */
export async function sweepAbandonedDrafts(olderThanDays = 30): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.application.findMany({
    where: { status: "DRAFT", updatedAt: { lt: cutoff } },
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
  const fileField = await prisma.formField.findFirst({ where: { cycleId: cycle.id, key: fieldKey, type: "FILE" }, select: { key: true } });
  if (!fileField) throw new DraftError("Unexpected file upload.");

  const { answerPatch, storageKeys } = await persistFiles(cycle.id, { [fieldKey]: file });
  const prior = (app.answers as Record<string, unknown>)[fieldKey] as { storedName?: string } | undefined;
  try {
    await prisma.application.update({ where: { id: app.id }, data: { answers: { ...(app.answers as Record<string, unknown>), ...answerPatch } as never } });
  } catch (err) {
    await cleanupFiles(storageKeys);
    throw err;
  }
  // Best-effort delete of the file this one replaced.
  if (prior?.storedName) await cleanupFiles([`recruitment/${cycle.id}/${prior.storedName}`]);
  return { fileName: file.fileName };
}
