import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";

vi.mock("@/platform/posthog/capture", () => ({
  aliasPerson: vi.fn(),
  flushEvents: vi.fn(),
}));

import { aliasPerson } from "@/platform/posthog/capture";
import { promoteContracts } from "./promotion";

async function seedSubmitted(email = "ada@yale.edu") {
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const srr = await prisma.person.create({ data: { name: "SRR", status: "ACTIVE" } });
  const role = await prisma.role.create({ data: { name: "Rec Admin", grants: { create: [{ permission: "recruitment.review_all" }] } } });
  await prisma.roleAssignment.create({ data: { personId: srr.id, roleId: role.id } });
  const cycle = await prisma.recruitmentCycle.create({ data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["SRHD"], createdById: srr.id, status: "OPEN" } });
  const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "Ada", lastName: "Lovelace", email, emailLower: email.toLowerCase(), netId: "al99" } });
  const application = await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["SRHD"], transferFromDepartments: [] } });
  const acceptance = await prisma.acceptance.create({ data: { applicationId: application.id, departmentCode: "SRHD", approvedById: srr.id } });
  const contract = await prisma.onboardingContract.create({ data: {
    acceptanceId: acceptance.id, token: `t-${Math.random()}`, status: "SUBMITTED",
    firstName: "Ada", lastName: "Lovelace", email, netId: "al99",
    agreementSignature: "Ada", professionalismSignature: "Ada", trainingSignature: "Ada", initials: "AL",
    epicNeeded: false, hasEpic: false, submittedAt: new Date(),
  } });
  return { srr, contract };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});
afterEach(resetDb);

describe("promoteContracts applicant->person alias", () => {
  it("aliases the applicant email into the newly created person id", async () => {
    const { srr, contract } = await seedSubmitted("ada@yale.edu");
    await promoteContracts([contract.id], srr.id);

    const person = await prisma.person.findFirstOrThrow({ where: { contactEmail: "ada@yale.edu" } });
    expect(vi.mocked(aliasPerson)).toHaveBeenCalledWith(
      expect.objectContaining({ personId: person.id, previousDistinctId: "ada@yale.edu", flush: false }),
    );
  });
});
