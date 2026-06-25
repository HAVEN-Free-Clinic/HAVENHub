// src/modules/recruitment/services/drafts.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";

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
