import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { computeServiceRecord } from "./service-record";

async function person(name = "Ada Lovelace") {
  return prisma.person.create({ data: { name } });
}

async function term(
  code: string,
  start: string,
  status: "PLANNING" | "ACTIVE" | "ARCHIVED" = "ARCHIVED",
) {
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

  describe("dates and hours", () => {
    /** A member with three shifts in one term and department. */
    async function threeShifts(hoursPerShift: number | null) {
      const p = await person();
      const d = await prisma.department.upsert({
        where: { code: "ITCM" },
        update: { hoursPerShift },
        create: { code: "ITCM", name: "Internal Medicine", hoursPerShift },
      });
      const t = await term("SU26", "2026-05-01");
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
      for (const day of ["2026-06-17", "2026-06-03", "2026-06-10"]) {
        await prisma.shiftAssignment.create({
          data: {
            termId: t.id, departmentId: d.id, personId: p.id,
            clinicDate: new Date(`${day}T12:00:00Z`), role: "VOLUNTEER",
          },
        });
      }
      return p;
    }

    it("lists the dates served, ascending", async () => {
      const p = await threeShifts(6);
      const record = await computeServiceRecord(p.id);
      // Seeded out of order above: the output must be sorted, not insertion order.
      expect(record.terms[0].dates).toEqual(["2026-06-03", "2026-06-10", "2026-06-17"]);
    });

    it("multiplies shifts by the department's hours per shift", async () => {
      const p = await threeShifts(6);
      const record = await computeServiceRecord(p.id);
      expect(record.terms[0].hours).toBe(18);
    });

    it("handles a fractional shift length", async () => {
      const p = await threeShifts(5.5);
      const record = await computeServiceRecord(p.id);
      expect(record.terms[0].hours).toBe(16.5);
    });

    // The point of the whole feature: an unconfigured department must not
    // produce a number. A fabricated hour total on a document a member submits
    // with a residency application is worse than an honest omission.
    it("reports null hours when the department has no hours configured", async () => {
      const p = await threeShifts(null);
      const record = await computeServiceRecord(p.id);
      expect(record.terms[0].shifts).toBe(3);
      expect(record.terms[0].hours).toBeNull();
      // Dates are still known: only the hours input was missing.
      expect(record.terms[0].dates).toHaveLength(3);
    });

    // Mirrors the existing shifts:null rule. On a term nobody was counting, an
    // empty date list would read as "served no days" rather than "not recorded".
    it("reports null dates and hours when the term has no shift data at all", async () => {
      const p = await person();
      const d = await prisma.department.upsert({
        where: { code: "ITCM" },
        update: { hoursPerShift: 6 },
        create: { code: "ITCM", name: "Internal Medicine", hoursPerShift: 6 },
      });
      const t = await term("SP26", "2026-01-12");
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });

      const record = await computeServiceRecord(p.id);
      expect(record.terms[0].shifts).toBeNull();
      expect(record.terms[0].dates).toBeNull();
      expect(record.terms[0].hours).toBeNull();
    });

    // Dates are per (term, department), like shifts. A member serving in two
    // departments on the same Saturday gets that date on BOTH rows, because each
    // row describes that department's service, and its hours are that
    // department's rate. Collapsing them would understate one of the two.
    it("attributes a shared clinic date to each department separately", async () => {
      const p = await person();
      const med = await prisma.department.upsert({
        where: { code: "ITCM" },
        update: { hoursPerShift: 6 },
        create: { code: "ITCM", name: "Internal Medicine", hoursPerShift: 6 },
      });
      const peds = await prisma.department.upsert({
        where: { code: "PEDS" },
        update: { hoursPerShift: 4 },
        create: { code: "PEDS", name: "Pediatrics", hoursPerShift: 4 },
      });
      const t = await term("SU26", "2026-05-01");
      for (const d of [med, peds]) {
        await prisma.termMembership.create({
          data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
        });
        await prisma.shiftAssignment.create({
          data: {
            termId: t.id, departmentId: d.id, personId: p.id,
            clinicDate: new Date("2026-06-03T12:00:00Z"), role: "VOLUNTEER",
          },
        });
      }

      const record = await computeServiceRecord(p.id);
      const byDept = new Map(record.terms.map((r) => [r.departmentName, r]));
      expect(byDept.get("Internal Medicine")!.dates).toEqual(["2026-06-03"]);
      expect(byDept.get("Pediatrics")!.dates).toEqual(["2026-06-03"]);
      // Each at its own department's rate, which is the reason hours are
      // per-department rather than one clinic-wide number.
      expect(byDept.get("Internal Medicine")!.hours).toBe(6);
      expect(byDept.get("Pediatrics")!.hours).toBe(4);
    });
  });

  it("counts shifts per department, not per term, for a member in two departments in one term", async () => {
    const p = await person();
    const itcm = await department();
    const peds = await department("PEDS", "Pediatrics");
    const t = await term("SU26", "2026-05-01");
    for (const d of [itcm, peds]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }
    // Two in Internal Medicine, one in Pediatrics. A term-grained count would
    // print 3 against BOTH rows: 6 shown against 3 served.
    for (const day of ["2026-06-03", "2026-06-10"]) {
      await prisma.shiftAssignment.create({
        data: {
          termId: t.id,
          departmentId: itcm.id,
          personId: p.id,
          clinicDate: new Date(`${day}T12:00:00Z`),
          role: "VOLUNTEER",
        },
      });
    }
    await prisma.shiftAssignment.create({
      data: {
        termId: t.id,
        departmentId: peds.id,
        personId: p.id,
        clinicDate: new Date("2026-06-17T12:00:00Z"),
        role: "VOLUNTEER",
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(2);
    expect(record.terms.find((r) => r.departmentName === "Internal Medicine")!.shifts).toBe(2);
    expect(record.terms.find((r) => r.departmentName === "Pediatrics")!.shifts).toBe(1);
  });

  it("probes shift data per department, so one department reads 0 while another reads null", async () => {
    const p = await person();
    const other = await person("Someone Else");
    const itcm = await department();
    const peds = await department("PEDS", "Pediatrics");
    const t = await term("SU26", "2026-05-01");
    for (const d of [itcm, peds]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "VOLUNTEER" },
      });
    }
    // The term HAS shift data, but only for Internal Medicine, and it belongs to
    // someone else. Pediatrics was not being counted, which is "Not recorded",
    // not "0 scheduled".
    await prisma.shiftAssignment.create({
      data: {
        termId: t.id,
        departmentId: itcm.id,
        personId: other.id,
        clinicDate: new Date("2026-06-03T12:00:00Z"),
        role: "VOLUNTEER",
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms.find((r) => r.departmentName === "Internal Medicine")!.shifts).toBe(0);
    expect(record.terms.find((r) => r.departmentName === "Pediatrics")!.shifts).toBeNull();
  });

  it("collapses a VOLUNTEER and a DIRECTOR membership in one term and department to the senior role", async () => {
    const p = await person();
    const d = await department();
    const t = await term("SU26", "2026-05-01");
    // `kind` is part of the membership unique key, so both rows can coexist.
    for (const kind of ["VOLUNTEER", "DIRECTOR"] as const) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind },
      });
    }
    await prisma.shiftAssignment.create({
      data: {
        termId: t.id,
        departmentId: d.id,
        personId: p.id,
        clinicDate: new Date("2026-06-03T12:00:00Z"),
        role: "VOLUNTEER",
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.terms).toHaveLength(1);
    expect(record.terms[0].track).toBe("DIRECTOR");
    expect(record.terms[0].shifts).toBe(1);
  });

  it("excludes a term that has not started yet", async () => {
    const p = await person();
    const d = await department();
    const served = await term("SU26", "2026-05-01");
    // The clinic rosters the next term ahead of the ACTIVE flip, so an incoming
    // director genuinely holds this membership before serving a day.
    const upcoming = await term("FA99", "2099-09-01", "PLANNING");
    for (const t of [served, upcoming]) {
      await prisma.termMembership.create({
        data: { personId: p.id, termId: t.id, departmentId: d.id, kind: "DIRECTOR" },
      });
    }

    const record = await computeServiceRecord(p.id);

    expect(record.terms.map((r) => r.termCode)).toEqual(["SU26"]);
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

  it("ignores recruitment outcomes that fail only ONE of ONBOARDED and ACCEPTED", async () => {
    // The fixture above fails BOTH conditions, so it would still be excluded if
    // the filter were an OR. These fail exactly one each, which is the only
    // shape that catches an OR-for-AND regression.
    const p = await person();
    const applicant = await prisma.historicalApplicant.create({
      data: { primaryEmail: "ada@example.com", firstName: "Ada", lastName: "Lovelace", personId: p.id },
    });
    const base = {
      applicantId: applicant.id,
      sourceBaseId: "app1",
      sourceTableId: "tbl1",
      track: "VOLUNTEER" as const,
      decidedAt: new Date("2022-09-15T12:00:00Z"),
    };
    // Reached ONBOARDED, but withdrew: not service.
    await prisma.historicalApplication.create({
      data: {
        ...base,
        sourceRecordId: "rec-onboarded-withdrawn",
        cycleCode: "V-FA22",
        cycleLabel: "Fall 2022 Volunteer Recruitment",
        termCode: "FA22",
        furthestStage: "ONBOARDED",
        outcome: "WITHDRAWN",
      },
    });
    // Outcome ACCEPTED, but never reached onboarding: still not service.
    await prisma.historicalApplication.create({
      data: {
        ...base,
        sourceRecordId: "rec-accepted-not-onboarded",
        cycleCode: "V-SP23",
        cycleLabel: "Spring 2023 Volunteer Recruitment",
        termCode: "SP23",
        furthestStage: "ACCEPTED",
        outcome: "ACCEPTED",
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
      data: {
        name: "Ada Lovelace",
        licensedRN: true,
        // Verified, so it belongs on the record. A self-reported claim would not.
        languages: { create: { language: "es", verified: true, verifiedAt: new Date() } },
      },
    });

    const record = await computeServiceRecord(p.id);

    expect(record.capabilities).toEqual({ verifiedLanguages: ["es"], licensedRN: true });
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
