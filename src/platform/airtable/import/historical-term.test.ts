import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { SP26_ROSTER_FIELDS as R } from "../fields";
import {
  runHistoricalTermImport,
  HistoricalTermNotArchivedError,
  type HistoricalTermSpec,
} from "./historical-term";
import type { AirtableReader } from "./importer";

const SPEC: HistoricalTermSpec = {
  code: "SP26",
  name: "Spring 2026",
  startDate: new Date("2026-01-12T12:00:00Z"),
  endDate: new Date("2026-05-29T12:00:00Z"),
};

const OPTS = {
  baseId: "base",
  rosterTableId: "sp26-roster",
  rosterFields: R,
  term: SPEC,
};

function reader(rows: Array<Record<string, unknown>>): AirtableReader {
  return {
    async listAll() {
      return rows.map((fields, i) => ({ id: `recRow${i}`, fields }));
    },
  };
}

const DEFAULT_ROWS = [
  { [R.departmentName]: "ITCM", [R.directors]: ["recDir"], [R.volunteers]: ["recVol"] },
];

async function seedPeople() {
  await prisma.person.create({
    data: { name: "Dir One", netId: "dir1", airtableRecordId: "recDir", status: "OFFBOARDED" },
  });
  await prisma.person.create({
    data: { name: "Vol One", netId: "vol1", airtableRecordId: "recVol", status: "ACTIVE" },
  });
}

describe("runHistoricalTermImport", () => {
  beforeEach(resetDb);

  it("dry-run reports without writing", async () => {
    await seedPeople();
    const report = await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.term).toEqual({ code: "SP26", created: true });
    expect(report.departments).toEqual({ created: 1, existing: 0 });
    expect(report.memberships).toEqual({ created: 2, existing: 0 });
    expect(await prisma.term.count()).toBe(0);
    expect(await prisma.termMembership.count()).toBe(0);
  });

  it("creates the term ARCHIVED and never activates it", async () => {
    await seedPeople();
    await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });

    const term = await prisma.term.findUniqueOrThrow({ where: { code: "SP26" } });
    expect(term.status).toBe("ARCHIVED");
    expect(term.name).toBe("Spring 2026");
    expect(await prisma.term.count({ where: { status: "ACTIVE" } })).toBe(0);
  });

  it("records a membership for an OFFBOARDED person (the whole point)", async () => {
    await seedPeople();
    const report = await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });

    expect(report.memberships.created).toBe(2);
    const director = await prisma.person.findFirstOrThrow({ where: { netId: "dir1" } });
    const membership = await prisma.termMembership.findFirstOrThrow({
      where: { personId: director.id },
      include: { term: true, department: true },
    });
    expect(membership.status).toBe("ACTIVE");
    expect(membership.kind).toBe("DIRECTOR");
    expect(membership.term.code).toBe("SP26");
    expect(membership.department.code).toBe("ITCM");
    // Person.status is history's business, not this import's.
    expect((await prisma.person.findUniqueOrThrow({ where: { id: director.id } })).status).toBe(
      "OFFBOARDED",
    );
  });

  it("is idempotent: a second run creates nothing", async () => {
    await seedPeople();
    await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });
    const second = await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });

    expect(second.term.created).toBe(false);
    expect(second.memberships).toEqual({ created: 0, existing: 2 });
    expect(await prisma.termMembership.count()).toBe(2);
  });

  it("does not resurrect a membership an admin marked REMOVED", async () => {
    await seedPeople();
    await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });
    await prisma.termMembership.updateMany({ data: { status: "REMOVED" } });

    await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });

    const statuses = (await prisma.termMembership.findMany({ select: { status: true } })).map(
      (m) => m.status,
    );
    expect(statuses).toEqual(["REMOVED", "REMOVED"]);
  });

  it("refuses to run against an ACTIVE term", async () => {
    await seedPeople();
    await prisma.term.create({
      data: { ...SPEC, status: "ACTIVE" },
    });

    await expect(
      runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false }),
    ).rejects.toBeInstanceOf(HistoricalTermNotArchivedError);
    expect(await prisma.termMembership.count()).toBe(0);
  });

  it("refuses in dry-run too, so the operator finds out before --apply", async () => {
    await prisma.term.create({ data: { ...SPEC, status: "PLANNING" } });

    await expect(
      runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: true }),
    ).rejects.toBeInstanceOf(HistoricalTermNotArchivedError);
  });

  it("reports roster links that match no Person instead of failing", async () => {
    await seedPeople();
    const rows = [
      { [R.departmentName]: "ITCM", [R.directors]: ["recDir"], [R.volunteers]: ["recGhost"] },
    ];
    const report = await runHistoricalTermImport(reader(rows), { ...OPTS, dryRun: false });

    expect(report.memberships.created).toBe(1);
    expect(report.unresolvedPeople).toEqual([
      { recordId: "recGhost", departmentCode: "ITCM", kind: "VOLUNTEER" },
    ]);
  });

  it("dedupes a person linked twice into the same department and kind", async () => {
    await seedPeople();
    const rows = [
      { [R.departmentName]: "ITCM", [R.volunteers]: ["recVol", "recVol"] },
    ];
    const report = await runHistoricalTermImport(reader(rows), { ...OPTS, dryRun: false });

    expect(report.memberships.created).toBe(1);
    expect(await prisma.termMembership.count()).toBe(1);
  });

  it("keeps an existing department's customized name", async () => {
    await seedPeople();
    await prisma.department.create({ data: { code: "ITCM", name: "IT & Clinic Management" } });

    await runHistoricalTermImport(reader(DEFAULT_ROWS), { ...OPTS, dryRun: false });

    const dept = await prisma.department.findUniqueOrThrow({ where: { code: "ITCM" } });
    expect(dept.name).toBe("IT & Clinic Management");
  });

  it("records the same person in two departments and both tracks", async () => {
    await seedPeople();
    const rows = [
      { [R.departmentName]: "ITCM", [R.directors]: ["recVol"] },
      { [R.departmentName]: "PHAM", [R.volunteers]: ["recVol"] },
    ];
    const report = await runHistoricalTermImport(reader(rows), { ...OPTS, dryRun: false });

    expect(report.memberships.created).toBe(2);
    expect(report.departments).toEqual({ created: 2, existing: 0 });
  });
});
