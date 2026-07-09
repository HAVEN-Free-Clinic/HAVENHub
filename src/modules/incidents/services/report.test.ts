/**
 * TDD tests for the incident reports intake service.
 *
 * submitReport(actorPersonId, input):
 *   - Creates a SUBMITTED report with the reporter set and strikeDecision null.
 *   - Persists the optional fields passed in (setting, subjectPersonId,
 *     subjectDescription, patientImpact, issueNature, priorOccurrence).
 *   - Validation: empty concernTypes -> IncidentValidationError.
 *   - Validation: unknown concern type value -> IncidentValidationError.
 *   - Validation: blank description -> IncidentValidationError.
 *   - Validation: future occurredAt -> IncidentValidationError.
 *   - Missing subjectPersonId row -> IncidentNotFoundError.
 *   - requestStrike without a subjectPersonId -> IncidentValidationError.
 *   - requestStrike when the actor does not manage the subject -> IncidentValidationError.
 *   - requestStrike when the actor manages the subject (active DIRECTOR of a
 *     department the subject is an ACTIVE VOLUNTEER in) -> strikeDecision PENDING.
 *   - Records an incident.submit audit row.
 *
 * canRequestStrikeAgainst(actorPersonId, subjectPersonId):
 *   - false when there is no active term.
 *   - false when the subject's membership is in a department the actor does not manage.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  submitReport,
  canRequestStrikeAgainst,
  CONCERN_TYPE_VALUES,
  IncidentValidationError,
  IncidentNotFoundError,
} from "./report";

// ---------------------------------------------------------------------------
// Helpers (mirrors src/modules/incidents/services/disciplinary.test.ts)
// ---------------------------------------------------------------------------

async function createPerson(name: string, netId?: string) {
  return prisma.person.create({ data: { name, netId } });
}

async function createTerm(
  status: "ACTIVE" | "ARCHIVED" | "PLANNING" = "ACTIVE",
  code = "SU26"
) {
  return prisma.term.create({
    data: {
      code,
      name: `Term ${code}`,
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-09-26"),
      status,
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  status: "ACTIVE" | "REMOVED" = "ACTIVE"
) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind, status },
  });
}

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// submitReport
// ---------------------------------------------------------------------------

describe("submitReport", () => {
  it("creates a SUBMITTED report with the reporter set and strikeDecision null", async () => {
    const reporter = await createPerson("Reporter", "rep001");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "On 2/14 the volunteer raised their voice at a patient.",
      subjectDescription: "SCTM volunteer",
    });

    expect(report.status).toBe("SUBMITTED");
    expect(report.reporterId).toBe(reporter.id);
    expect(report.strikeDecision).toBeNull();
    expect(report.anonymous).toBe(false);
    expect(report.immediateRisk).toBe(false);

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row).not.toBeNull();
    expect(row?.concernTypes).toEqual(["PROFESSIONAL_CONDUCT"]);
    expect(row?.subjectDescription).toBe("SCTM volunteer");
  });

  it("persists the optional fields provided (subject, setting, patient impact, issue nature)", async () => {
    const reporter = await createPerson("Reporter", "rep002");
    const subject = await createPerson("Subject", "sub001");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY", "DOCUMENTATION_WORKFLOW"],
      description: "Medication error during triage.",
      occurredAt: new Date("2026-06-01"),
      setting: "Triage room 2",
      subjectPersonId: subject.id,
      patientImpact: "YES",
      patientImpactDetail: "Patient received wrong dosage.",
      immediateRisk: true,
      issueNature: "INDIVIDUAL",
      priorOccurrence: "NO",
      anonymous: true,
    });

    expect(report.subjectPersonId).toBe(subject.id);
    expect(report.setting).toBe("Triage room 2");
    expect(report.patientImpact).toBe("YES");
    expect(report.patientImpactDetail).toBe("Patient received wrong dosage.");
    expect(report.immediateRisk).toBe(true);
    expect(report.issueNature).toBe("INDIVIDUAL");
    expect(report.priorOccurrence).toBe("NO");
    expect(report.anonymous).toBe(true);
    expect(report.concernTypes).toEqual(["PATIENT_SAFETY", "DOCUMENTATION_WORKFLOW"]);
  });

  it("rejects an empty concernTypes list", async () => {
    const reporter = await createPerson("Reporter", "rep003");

    await expect(
      submitReport(reporter.id, { concernTypes: [], description: "x" })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects an unknown concern type value", async () => {
    const reporter = await createPerson("Reporter", "rep004");

    expect(CONCERN_TYPE_VALUES).not.toContain("NOT_A_REAL_TYPE");

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["NOT_A_REAL_TYPE"],
        description: "x",
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects a blank description", async () => {
    const reporter = await createPerson("Reporter", "rep005");

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["OTHER"],
        description: "   ",
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects a future occurredAt", async () => {
    const reporter = await createPerson("Reporter", "rep006");
    const futureDate = new Date(Date.now() + 86400_000 * 2);

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["OTHER"],
        description: "x",
        occurredAt: futureDate,
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects a subjectPersonId that does not exist -> IncidentNotFoundError", async () => {
    const reporter = await createPerson("Reporter", "rep007");

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["OTHER"],
        description: "x",
        subjectPersonId: "nonexistent-person-id",
      })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("rejects requestStrike without a subjectPersonId", async () => {
    const reporter = await createPerson("Reporter", "rep008");

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["ATTENDANCE_RELIABILITY"],
        description: "no-show",
        requestStrike: true,
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects requestStrike when the actor does not manage the subject", async () => {
    const reporter = await createPerson("Reporter", "rep009");
    const subject = await createPerson("Subject", "sub002");

    await expect(
      submitReport(reporter.id, {
        concernTypes: ["ATTENDANCE_RELIABILITY"],
        description: "no-show",
        subjectPersonId: subject.id,
        requestStrike: true,
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("allows requestStrike when the actor directs a department the subject actively volunteers in, setting strikeDecision PENDING", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const subject = await createPerson("Volunteer", "vol001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show for a scheduled shift.",
      subjectPersonId: subject.id,
      requestStrike: true,
    });

    expect(report.strikeDecision).toBe("PENDING");
    expect(report.reporterId).toBe(director.id);
    expect(report.subjectPersonId).toBe(subject.id);
  });

  it("records an incident.submit audit row", async () => {
    const reporter = await createPerson("Reporter", "rep010");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PRIVACY_HIPAA"],
      description: "Unlocked workstation with a chart open.",
    });

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "incident.submit", entityId: report.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorPersonId).toBe(reporter.id);
    const after = auditRow?.after as Record<string, unknown>;
    expect(after.number).toBe(report.number);
    expect(after.concernTypes).toEqual(["PRIVACY_HIPAA"]);
    expect(after.strikeRequested).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canRequestStrikeAgainst
// ---------------------------------------------------------------------------

describe("canRequestStrikeAgainst", () => {
  it("returns false when there is no active term", async () => {
    await createTerm("ARCHIVED");
    const director = await createPerson("Director", "dir002");
    const subject = await createPerson("Volunteer", "vol002");

    expect(await canRequestStrikeAgainst(director.id, subject.id)).toBe(false);
  });

  it("returns false when the subject's active membership is in a department the actor does not manage", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");
    const director = await createPerson("DirA", "dira002");
    const subject = await createPerson("VolB", "volb002");

    await createMembership(director.id, term.id, deptA.id, "DIRECTOR");
    await createMembership(subject.id, term.id, deptB.id, "VOLUNTEER");

    expect(await canRequestStrikeAgainst(director.id, subject.id)).toBe(false);
  });

  it("returns true for an active director of the subject's active VOLUNTEER department", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTP");
    const director = await createPerson("Director", "dir003");
    const subject = await createPerson("Volunteer", "vol003");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    expect(await canRequestStrikeAgainst(director.id, subject.id)).toBe(true);
  });
});
