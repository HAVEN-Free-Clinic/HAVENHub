// src/modules/recruitment/services/portal-status.ts
import { prisma } from "@/platform/db";
import type { ApplicantIdentity } from "./portal-auth";

export type ApplicantAppRow = { slug: string; cycleTitle: string; status: "DRAFT" | "SUBMITTED" };

export async function listApplicantApplications(identity: ApplicantIdentity): Promise<ApplicantAppRow[]> {
  const applicants = await prisma.applicant.findMany({
    where: { OR: [{ emailLower: identity.email }, ...(identity.personId ? [{ applicantPersonId: identity.personId }] : [])] },
    include: { cycle: { select: { publicSlug: true, title: true } }, applications: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
  });
  const rows: ApplicantAppRow[] = [];
  for (const a of applicants) {
    const app = a.applications[0];
    if (!app) continue;
    rows.push({ slug: a.cycle.publicSlug, cycleTitle: a.cycle.title, status: app.status as "DRAFT" | "SUBMITTED" });
  }
  return rows;
}
