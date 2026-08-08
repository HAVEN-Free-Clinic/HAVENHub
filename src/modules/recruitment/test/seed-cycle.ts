import { prisma } from "@/platform/db";

type ContractSeed = {
  status: "PENDING" | "SUBMITTED" | "PROMOTED";
  expiresAt?: Date | null;
  promotedPersonId?: string | null;
  templateSnapshot?: object | null;
  customAnswers?: object | null;
};

/**
 * Seed one cycle with a caller-described set of acceptances.
 *
 * Each entry becomes an applicant, an application, and an acceptance in the
 * given department, plus an OnboardingContract when `contract` is set. Two
 * entries sharing an `applicationKey` attach to the SAME application, which is
 * how a conflicted acceptance (accepted by more than one department) is built.
 */
export async function seedCycle(entries: Array<{
  applicationKey?: string;
  dept?: "SRHD" | "PCAR";
  firstName?: string;
  lastName?: string;
  contract?: ContractSeed;
}>) {
  const term = await prisma.term.create({ data: {
    code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE",
  } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  await prisma.department.create({ data: { code: "PCAR", name: "PCAR" } });

  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: {
    name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] },
  } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // A person with no recruitment permission, for authorization tests.
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });

  const cycle = await prisma.recruitmentCycle.create({ data: {
    track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v",
    departments: ["SRHD", "PCAR"], createdById: srr.id, status: "OPEN",
  } });

  const applicationsByKey = new Map<string, string>();
  const acceptances: { id: string; contractId: string | null }[] = [];

  for (const [i, e] of entries.entries()) {
    const key = e.applicationKey ?? `app-${i}`;
    let applicationId = applicationsByKey.get(key);
    if (!applicationId) {
      const applicant = await prisma.applicant.create({ data: {
        cycleId: cycle.id,
        firstName: e.firstName ?? `First${i}`,
        lastName: e.lastName ?? `Last${i}`,
        email: `applicant${i}@yale.edu`,
        emailLower: `applicant${i}@yale.edu`,
        netId: `net${i}`,
      } });
      const application = await prisma.application.create({ data: {
        cycleId: cycle.id, applicantId: applicant.id, answers: {},
        applicantType: "NEW", departmentChoices: ["SRHD"],
      } });
      applicationId = application.id;
      applicationsByKey.set(key, applicationId);
    }

    const acceptance = await prisma.acceptance.create({ data: {
      applicationId, departmentCode: e.dept ?? "SRHD", approvedById: srr.id,
    } });

    let contractId: string | null = null;
    if (e.contract) {
      const c = await prisma.onboardingContract.create({ data: {
        acceptanceId: acceptance.id,
        token: `tok-${i}-${acceptance.id}`,
        status: e.contract.status,
        firstName: e.firstName ?? `First${i}`,
        lastName: e.lastName ?? `Last${i}`,
        email: `applicant${i}@yale.edu`,
        expiresAt: e.contract.expiresAt ?? null,
        promotedPersonId: e.contract.promotedPersonId ?? null,
        templateSnapshot: e.contract.templateSnapshot ?? undefined,
        customAnswers: e.contract.customAnswers ?? undefined,
        submittedAt: e.contract.status === "PENDING" ? null : new Date(),
      } });
      contractId = c.id;
    }
    acceptances.push({ id: acceptance.id, contractId });
  }

  return { cycleId: cycle.id, srrId: srr.id, plainId: plain.id, acceptances };
}
