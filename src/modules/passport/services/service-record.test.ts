import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { computeServiceRecord } from "./service-record";

async function person(name = "Ada Lovelace") {
  return prisma.person.create({ data: { name } });
}

async function term(code: string, start: string, status: "ACTIVE" | "ARCHIVED" = "ARCHIVED") {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date(`${start}T12:00:00Z`),
      endDate: new Date(`${start}T12:00:00Z`),
      status,
    },
  });
}

async function department(code = "ITCM", name = "Internal Medicine") {
  return prisma.department.upsert({ where: { code }, update: {}, create: { code, name } });
}

describe("computeServiceRecord", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns a row per ACTIVE membership, ascending by term start", async () => {
    const p = await person();
    const d = await department();
    const older = await term("SP26", "2026-01-12");
    const newer = await term("SU26", "2026-05-01");
    for (const t of [newer, older]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }

    const record = await computeServiceRecord(p.id);

    expect(record.terms.map((r) => r.termCode)).toEqual(["SP26", "SU26"]);
    expect(record.terms[0].departmentName).toBe("Internal Medicine");
    expect(record.terms[0].track).toBe("VOLUNTEER");
    expect(record.terms[0].source).toBe("MEMBERSHIP");
  });

  it("excludes REMOVED memberships", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER", status: "REMOVED" },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(0);
  });

  it("distinguishes a term with no shift data (null) from a term where the member had none (0)", async () => {
    const p = await person();
    const other = await person("Someone Else");
    const d = await department();
    const noData = await term("SP26", "2026-01-12");
    const hasData = await term("SU26", "2026-05-01");
    for (const t of [noData, hasData]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }
    // Shift data exists for SU26, but belongs to a different person.
    await prisma.shiftAssignment.create({
      data: {
        termId: hasData.id,
        departmentId: d.id,
        personId: other.id,
        clinicDate: new Date("2026-06-03T12:00:00Z"),
        role: "VOLUNTEER",
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms.find((r) => r.termCode === "SP26")!.shifts).toBeNull();
    expect(record.terms.find((r) => r.termCode === "SU26")!.shifts).toBe(0);
  });

  it("counts the member's own shifts in a term that has shift data", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
    });
    for (const day of ["2026-06-03", "2026-06-10", "2026-06-17"]) {
      await prisma.shiftAssignment.create({
        data: {
          termId: t.id,
          departmentId: d.id,
          personId: p.id,
          clinicDate: new Date(`${day}T12:00:00Z`),
          role: "VOLUNTEER",
        },
      });
    }

    const record = await computeServiceRecord(p.id);

    expect(record.terms[0].shifts).toBe(3);
  });

  it("reconstructs a pre-roster term from an ONBOARDED + ACCEPTED recruitment outcome", async () => {
    const p = await person();
    await department();
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec1",
        cycleCode: "V-FA23",
        cycleLabel: "Fall 2023 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "FA23",
        resultDepartment: "ITCM",
        furthestStage: "ONBOARDED",
        outcome: "ACCEPTED",
        decidedAt: new Date("2023-09-15T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(1);
    expect(record.terms[0].source).toBe("RECRUITMENT");
    expect(record.terms[0].termCode).toBe("FA23");
    expect(record.terms[0].departmentName).toBe("Internal Medicine");
    expect(record.terms[0].shifts).toBeNull();
    expect(record.memberSince).toEqual({ label: "Fall 2023 Volunteer Recruitment", source: "RECRUITMENT" });
  });

  it("ignores recruitment outcomes that did not reach ONBOARDED + ACCEPTED", async () => {
    const p = await person();
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec2",
        cycleCode: "V-FA22",
        cycleLabel: "Fall 2022 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "FA22",
        furthestStage: "FINAL_ROUND",
        outcome: "REJECTED",
        decidedAt: new Date("2022-09-15T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(0);
  });

  it("drops the recruitment row when a membership covers the same term", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "DIRECTOR" },
    });
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    await prisma.historicalApplication.create({
      data: {
        applicantId: applicant.id,
        sourceBaseId: "app1",
        sourceTableId: "tbl1",
        sourceRecordId: "rec3",
        cycleCode: "V-SU26",
        cycleLabel: "Summer 2026 Volunteer Recruitment",
        track: "VOLUNTEER",
        termCode: "SU26",
        furthestStage: "ONBOARDED",
        outcome: "ACCEPTED",
        decidedAt: new Date("2026-04-01T12:00:00Z"),
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(1);
    expect(record.terms[0].source).toBe("MEMBERSHIP");
    expect(record.terms[0].track).toBe("DIRECTOR");
  });

  it("carries verified capabilities and a SCHEDULED basis", async () => {
    const p = await prisma.person.create({
      data: { name: "Ada Lovelace", spanishVerified: true, licensedRN: true },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.capabilities).toEqual({ spanishVerified: true, licensedRN: true });
    expect(record.basis).toBe("SCHEDULED");
    expect(record.name).toBe("Ada Lovelace");
    expect(record.memberSince).toBeNull();
  });

  it("returns JSON-safe values only", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    await prisma.termMembership.create({
      data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
    });

    const record = await computeServiceRecord(p.id);

    expect(typeof record.terms[0].startDate).toBe("string");
    expect(typeof record.generatedAt).toBe("string");
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
