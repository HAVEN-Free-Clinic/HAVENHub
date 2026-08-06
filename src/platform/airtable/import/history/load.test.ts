import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { loadHistory } from "./load";
import type { RawHistoryRow, RawInterestRow } from "./types";

const row = (recordId: string, email: string, over: Partial<RawHistoryRow> = {}): RawHistoryRow => ({
  source: { baseId: "appTest", tableId: "tblTest", recordId },
  cycle: { code: "V-FA25", label: "Fall 2025 Volunteer Recruitment", track: "VOLUNTEER", termCode: "FA25" },
  identity: { firstName: "Ada", lastName: "Lovelace", email, netId: null },
  applicantType: null, departmentChoicesRaw: ["BVHD"], resultDepartmentRaw: null,
  furthestStage: "APPLIED", outcome: "NO_DECISION",
  submittedAt: null, decidedAt: null, unmapped: null,
  ...over,
});

const interestRow = (recordId: string, email: string, over: Partial<RawInterestRow> = {}): RawInterestRow => ({
  source: { baseId: "appTest", tableId: "tblInterest", recordId },
  identity: { firstName: "Ada", lastName: "Lovelace", email, netId: null },
  submittedAt: null,
  ...over,
});

beforeEach(async () => {
  await prisma.historicalApplication.deleteMany();
  await prisma.historicalInterest.deleteMany();
  await prisma.historicalApplicantEmail.deleteMany();
  await prisma.historicalApplicant.deleteMany();
  // The linking test creates a Person; without this the suite passes once
  // and then fails on the unique contactEmail on every later run.
  await prisma.person.deleteMany({ where: { contactEmail: "a@yale.edu" } });
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

  it("adopts a netId that arrives on a re-run without orphaning the applicant", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    await loadHistory(
      [row("rec1", "a@yale.edu", { identity: { firstName: "Ada", lastName: "Lovelace", email: "a@yale.edu", netId: "abc12" } })],
      [], { dryRun: false },
    );

    expect(await prisma.historicalApplicant.count()).toBe(1);
    const applicant = await prisma.historicalApplicant.findFirst();
    expect(applicant!.netId).toBe("abc12");
  });

  it("does not orphan the application when a netId arrives on a re-run", async () => {
    await loadHistory([row("rec1", "a@yale.edu")], [], { dryRun: false });
    await loadHistory(
      [row("rec1", "a@yale.edu", { identity: { firstName: "Ada", lastName: "Lovelace", email: "a@yale.edu", netId: "abc12" } })],
      [], { dryRun: false },
    );

    // Fetched by netId, not findFirst(), so this targets the one true
    // surviving applicant even if a duplicate were (wrongly) also present.
    expect(await prisma.historicalApplicant.count()).toBe(1);
    const applicant = await prisma.historicalApplicant.findFirst({ where: { netId: "abc12" } });
    expect(await prisma.historicalApplication.count()).toBe(1);
    const application = await prisma.historicalApplication.findFirst();
    expect(application!.applicantId).toBe(applicant!.id);
  });

  it("merges two pre-existing applicants once a later row proves they are the same person", async () => {
    // Applicant A: email-only, no netId.
    await loadHistory([row("recA", "old@yale.edu")], [], { dryRun: false });
    // Applicant B: a different email, carrying the netId.
    await loadHistory(
      [row("recB", "new@yale.edu", { identity: { firstName: "Ada", lastName: "Lovelace", email: "new@yale.edu", netId: "abc12" } })],
      [], { dryRun: false },
    );
    expect(await prisma.historicalApplicant.count()).toBe(2);

    // A third row carries BOTH keys: A and B are now known to be one person.
    const report = await loadHistory(
      [row("recC", "old@yale.edu", { identity: { firstName: "Ada", lastName: "Lovelace", email: "old@yale.edu", netId: "abc12" } })],
      [], { dryRun: false },
    );

    const applicants = await prisma.historicalApplicant.findMany();
    expect(applicants).toHaveLength(1);
    const survivor = applicants[0];
    expect(survivor.netId).toBe("abc12");

    const applications = await prisma.historicalApplication.findMany();
    expect(applications).toHaveLength(3);
    expect(applications.every((a) => a.applicantId === survivor.id)).toBe(true);

    const emails = await prisma.historicalApplicantEmail.findMany();
    expect(emails).toHaveLength(2);
    expect(emails.every((e) => e.applicantId === survivor.id)).toBe(true);

    expect(report.identitiesMerged).toBe(1);
  });

  it("keeps two different people separate even when their sources share a bare record id", async () => {
    // Airtable base duplication preserves record ids, so "rec1" from one base
    // and "rec1" from a cloned base are two unrelated rows that happen to
    // carry the same recordId. Neither row has a netId or a shared email, so
    // the only thing that could wrongly merge them is an identity key that
    // ignores which source the record id came from.
    await loadHistory(
      [
        row("rec1", "person-a@yale.edu", { source: { baseId: "appA", tableId: "tblA", recordId: "rec1" } }),
        row("rec1", "person-b@yale.edu", { source: { baseId: "appB", tableId: "tblB", recordId: "rec1" } }),
      ],
      [],
      { dryRun: false },
    );

    expect(await prisma.historicalApplicant.count()).toBe(2);
  });

  it("counts interest rows in the report even though they carry no cycle code", async () => {
    // perSource is keyed by cycle code, which interest rows do not have, so
    // interestRows is the only place their count is visible to a human
    // reading the dry-run report.
    const report = await loadHistory(
      [],
      [interestRow("recI1", "i1@yale.edu"), interestRow("recI2", "i2@yale.edu")],
      { dryRun: true },
    );
    expect(report.interestRows).toBe(2);
  });
});
