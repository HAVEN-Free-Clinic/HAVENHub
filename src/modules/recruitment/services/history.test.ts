import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getApplicantHistory } from "./history";

beforeEach(async () => {
  // resetDb() truncates the live platform tables (Term, Department,
  // RecruitmentCycle, Applicant, Application, ...) that seedTwoLiveApplications
  // creates. It does not reach the Historical* tables (they postdate resetDb's
  // truncate list), so those are cleared explicitly below.
  await resetDb();
  await prisma.historicalApplication.deleteMany();
  await prisma.historicalApplicantEmail.deleteMany();
  await prisma.historicalApplicant.deleteMany();
});
afterEach(async () => { await resetDb(); });

async function seedArchive(email: string) {
  const applicant = await prisma.historicalApplicant.create({
    data: {
      primaryEmail: email, firstName: "Ada", lastName: "Lovelace",
      emails: { create: [{ email }] },
    },
  });
  await prisma.historicalApplication.create({
    data: {
      applicantId: applicant.id,
      sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "rec1",
      cycleCode: "V-FA25", cycleLabel: "Fall 2025 Volunteer Recruitment",
      track: "VOLUNTEER", termCode: "FA25",
      departmentChoices: ["BVHD"], furthestStage: "FINAL_ROUND", outcome: "REJECTED",
    },
  });
  return applicant;
}

/**
 * Seeds two live-era applications for one person in two different cycles.
 * Needed by the exclusion test: with only one application, asserting "the
 * current one is absent" passes vacuously on an empty list.
 *
 * RecruitmentCycle requires a real termId and createdById, and Applicant has
 * a @@unique([cycleId, emailLower]), so the same person applying into two
 * cycles needs two Applicant rows (one per cycle) that share an email --
 * never one Applicant row reused across cycles.
 */
async function seedTwoLiveApplications(email: string): Promise<{
  current: { id: string; cycleId: string };
  sibling: { id: string; cycleId: string };
}> {
  const term = await prisma.term.create({
    data: { code: "HTEST-FA26", name: "HTEST Fall 2026", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
  });
  const dept = await prisma.department.create({ data: { code: "HTEST", name: "HTEST Department" } });
  const srr = await prisma.person.create({ data: { name: "HTEST SRR", status: "ACTIVE" } });

  const cycleA = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "HTEST Cycle A", publicSlug: "htest-cycle-a", departments: [dept.code], createdById: srr.id, status: "OPEN" },
  });
  const cycleB = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "HTEST Cycle B", publicSlug: "htest-cycle-b", departments: [dept.code], createdById: srr.id, status: "OPEN" },
  });

  const emailLower = email.toLowerCase();
  const applicantA = await prisma.applicant.create({
    data: { cycleId: cycleA.id, firstName: "Ada", lastName: "Lovelace", email, emailLower },
  });
  const applicantB = await prisma.applicant.create({
    data: { cycleId: cycleB.id, firstName: "Ada", lastName: "Lovelace", email, emailLower },
  });

  const current = await prisma.application.create({
    data: { cycleId: cycleA.id, applicantId: applicantA.id, answers: {}, applicantType: "NEW", departmentChoices: [dept.code] },
  });
  const sibling = await prisma.application.create({
    data: { cycleId: cycleB.id, applicantId: applicantB.id, answers: {}, applicantType: "NEW", departmentChoices: [dept.code] },
  });

  return {
    current: { id: current.id, cycleId: cycleA.id },
    sibling: { id: sibling.id, cycleId: cycleB.id },
  };
}

describe("getApplicantHistory", () => {
  it("finds archive entries by email, case-insensitively", async () => {
    await seedArchive("ada@yale.edu");
    const h = await getApplicantHistory({ emails: ["Ada@Yale.edu"] });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].era).toBe("archive");
    expect(h.entries[0].cycleLabel).toBe("Fall 2025 Volunteer Recruitment");
  });

  it("returns an empty history rather than throwing for an unknown applicant", async () => {
    const h = await getApplicantHistory({ emails: ["nobody@yale.edu"] });
    expect(h.entries).toEqual([]);
    expect(h.applicationCount).toBe(0);
    expect(h.furthest).toBeNull();
  });

  it("reports the furthest stage across all entries", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "rec2",
        cycleCode: "V-SP25", cycleLabel: "Spring 2025 Volunteer Recruitment",
        track: "VOLUNTEER", termCode: "SP25",
        departmentChoices: [], furthestStage: "APPLIED", outcome: "REJECTED",
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    expect(h.applicationCount).toBe(2);
    expect(h.furthest!.stage).toBe("FINAL_ROUND");
    expect(h.furthest!.cycleLabel).toBe("Fall 2025 Volunteer Recruitment");
  });

  it("matches on netId even when the email differs", async () => {
    await prisma.historicalApplicant.create({
      data: {
        netId: "al123", primaryEmail: "old@yale.edu", firstName: "Ada", lastName: "Lovelace",
        emails: { create: [{ email: "old@yale.edu" }] },
        applications: {
          create: [{
            sourceBaseId: "appT", sourceTableId: "tblT", sourceRecordId: "recX",
            cycleCode: "V-SU25", cycleLabel: "Summer 2025 Volunteer Recruitment",
            track: "VOLUNTEER", termCode: "SU25",
            departmentChoices: [], furthestStage: "APPLIED", outcome: "REJECTED",
          }],
        },
      },
    });
    const h = await getApplicantHistory({ netId: "al123", emails: ["brand-new@gmail.com"] });
    expect(h.entries).toHaveLength(1);
  });

  it("excludes the application currently being viewed but keeps its siblings", async () => {
    // Live-era exclusion: the reviewer card must not list the page it is on.
    // Two live applications are seeded so the assertion distinguishes real
    // exclusion from an empty result set.
    const { current, sibling } = await seedTwoLiveApplications("ada@yale.edu");

    const h = await getApplicantHistory({
      emails: ["ada@yale.edu"],
      excludeApplicationId: current.id,
    });

    const liveIds = h.entries.filter((e) => e.era === "live").map((e) => e.href);
    expect(liveIds).toContain(`/recruitment/cycles/${sibling.cycleId}/applicants/${sibling.id}`);
    expect(liveIds).not.toContain(`/recruitment/cycles/${current.cycleId}/applicants/${current.id}`);
  });

  it("reports a withdrawn application as withdrawn, not accepted", async () => {
    // The acceptance row survives a withdrawal by design (services/withdraw.ts
    // never tears one down), so without reading Application.status this entry
    // renders "Accepted" on the applicant detail card, the history browser, and
    // the admin person profile -- the exact surfaces a reviewer reads when
    // weighing a returning applicant who in fact declined.
    const { current } = await seedTwoLiveApplications("ada@yale.edu");
    const srr = await prisma.person.findFirstOrThrow({ where: { name: "HTEST SRR" } });
    await prisma.acceptance.create({
      data: { applicationId: current.id, departmentCode: "HTEST", approvedById: srr.id },
    });
    const entryFor = async (id: string) =>
      (await getApplicantHistory({ emails: ["ada@yale.edu"] })).entries.find((e) => e.href?.endsWith(`/${id}`))!;

    // Control: while the acceptance stands, the row is genuinely ACCEPTED.
    const accepted = await entryFor(current.id);
    expect(accepted.outcome).toBe("ACCEPTED");
    expect(accepted.furthestStage).toBe("ACCEPTED");

    await prisma.application.update({
      where: { id: current.id },
      data: { status: "WITHDRAWN", withdrawnAt: new Date() },
    });

    const withdrawn = await entryFor(current.id);
    expect(withdrawn.outcome).toBe("WITHDRAWN");
    expect(withdrawn.furthestStage).toBe("APPLIED");
  });

  it("includes interest-form entries, distinctly from applications", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalInterest.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appyZMpXNJ0rVzOT8", sourceTableId: "tblEacqiHtqKMJphX", sourceRecordId: "recI1",
        submittedAt: new Date("2024-09-01T00:00:00Z"),
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    const interest = h.entries.find((e) => e.kind === "interest");
    expect(interest).toBeDefined();
    expect(interest!.furthestStage).toBeNull();
    expect(interest!.outcome).toBeNull();
    // An interest submission is not an application and must not inflate the count.
    expect(h.applicationCount).toBe(1);
  });

  it("sorts entries newest first", async () => {
    const applicant = await seedArchive("ada@yale.edu");
    await prisma.historicalInterest.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "appyZMpXNJ0rVzOT8", sourceTableId: "tblEacqiHtqKMJphX", sourceRecordId: "recI1",
        submittedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const h = await getApplicantHistory({ emails: ["ada@yale.edu"] });
    expect(h.entries[h.entries.length - 1].kind).toBe("interest");
  });
});
