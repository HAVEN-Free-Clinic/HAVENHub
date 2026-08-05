import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { loadHistory } from "./load";
import type { RawHistoryRow } from "./types";

const row = (recordId: string, email: string, over: Partial<RawHistoryRow> = {}): RawHistoryRow => ({
  source: { baseId: "appTest", tableId: "tblTest", recordId },
  cycle: { code: "V-FA25", label: "Fall 2025 Volunteer Recruitment", track: "VOLUNTEER", termCode: "FA25" },
  identity: { firstName: "Ada", lastName: "Lovelace", email, netId: null },
  applicantType: null, departmentChoicesRaw: ["BVHD"], resultDepartmentRaw: null,
  furthestStage: "APPLIED", outcome: "NO_DECISION",
  submittedAt: null, decidedAt: null, unmapped: null,
  ...over,
});

beforeEach(async () => {
  await prisma.historicalApplication.deleteMany();
  await prisma.historicalInterest.deleteMany();
  await prisma.historicalApplicantEmail.deleteMany();
  await prisma.historicalApplicant.deleteMany();
});

describe("loadHistory", () => {
  it("writes nothing when dryRun is true", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: true });
    expect(await prisma.historicalApplicant.count()).toBe(0);
  });

  it("writes an applicant, an email and an application", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    expect(await prisma.historicalApplicant.count()).toBe(1);
    expect(await prisma.historicalApplicantEmail.count()).toBe(1);
    expect(await prisma.historicalApplication.count()).toBe(1);
  });

  it("is idempotent: running twice yields identical counts", async () => {
    const rows = [row("rec1", "a@yale.edu"), row("rec2", "b@yale.edu")];
    await loadHistory(rows, [], { dryRun: false });
    const first = await prisma.historicalApplication.count();
    await loadHistory(rows, [], { dryRun: false });
    expect(await prisma.historicalApplication.count()).toBe(first);
    expect(await prisma.historicalApplicant.count()).toBe(2);
  });

  it("updates a changed row in place rather than duplicating it", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    await loadHistory([row("rec1", "a@yale.edu", { furthestStage: "ACCEPTED", outcome: "ACCEPTED" })], [], { dryRun: false });
    const all = await prisma.historicalApplication.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].furthestStage).toBe("ACCEPTED");
  });

  it("groups two cycles for one person under a single applicant", async () => {
    await loadHistory([
      row("rec1", "a@yale.edu"),
      row("rec2", "a@yale.edu", { cycle: { code: "V-SP25", label: "Spring 2025 Volunteer Recruitment", track: "VOLUNTEER", termCode: "SP25" } }),
    ], [], { dryRun: false });
    expect(await prisma.historicalApplicant.count()).toBe(1);
    expect(await prisma.historicalApplication.count()).toBe(2);
  });

  it("links to a Person when the email matches, and leaves personId null otherwise", async () => {
    const person = await prisma.person.create({
      data: { name: "Ada Lovelace", contactEmail: "a@yale.edu" },
    });
    await loadHistory([row("rec1", "a@yale.edu"), row("rec2", "z@yale.edu")], [], { dryRun: false });
    const linkedRow = await prisma.historicalApplicant.findFirst({ where: { primaryEmail: "a@yale.edu" } });
    const unlinked = await prisma.historicalApplicant.findFirst({ where: { primaryEmail: "z@yale.edu" } });
    expect(linkedRow!.personId).toBe(person.id);
    expect(unlinked!.personId).toBeNull();
  });

  it("reports unmapped department labels instead of coercing them", async () => {
    const report = await loadHistory(
      [row("rec1", "a@yale.edu", { departmentChoicesRaw: ["Not A Real Dept"] })],
      [], { dryRun: true },
    );
    expect(report.unmappedDepartments).toContain("Not A Real Dept");
  });
});
