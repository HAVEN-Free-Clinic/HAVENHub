import { randomUUID } from "node:crypto";
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
  // Upserted rather than created: a caller may seed more than one cycle in a
  // single test (e.g. to prove cross-cycle scoping), and Term.code,
  // Department.code, and Role.name are all globally unique, so a second call
  // in the same test would otherwise collide on shared reference data instead
  // of creating a second, independent cycle.
  const term = await prisma.term.upsert({
    where: { code: "FA26" },
    update: {},
    create: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  await prisma.department.upsert({ where: { code: "SRHD" }, update: {}, create: { code: "SRHD", name: "SRHD" } });
  await prisma.department.upsert({ where: { code: "PCAR" }, update: {}, create: { code: "PCAR", name: "PCAR" } });

  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.upsert({
    where: { name: "Rec Admin" },
    update: {},
    create: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  // A person with no recruitment permission, for authorization tests.
  const plain = await prisma.person.create({ data: { name: "Nobody", status: "ACTIVE" } });

  // publicSlug is unique per cycle (unlike the reference data above), so each
  // call gets its own cycle rather than colliding with a prior one.
  const cycle = await prisma.recruitmentCycle.create({ data: {
    track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${randomUUID()}`,
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
