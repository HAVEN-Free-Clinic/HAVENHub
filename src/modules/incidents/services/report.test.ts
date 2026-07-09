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
 *
 * listMyReports(actorPersonId):
 *   - Returns only the actor's own reports, newest first.
 *
 * getReport(actorPersonId, id):
 *   - Missing report -> IncidentNotFoundError.
 *   - Non-owner without incidents.manage -> IncidentForbiddenError.
 *   - Owner (non-manager) can read their own report, with reviewNotes stripped to null.
 *   - A holder of incidents.manage can read any report, reviewNotes included.
 *
 * listReviewQueue(actorPersonId, filters):
 *   - Non-manager -> IncidentForbiddenError.
 *   - A holder of incidents.manage sees all reports, regardless of reporter.
 *   - Filters by status.
 *   - Orders immediateRisk reports first, then newest first.
 *
 * reviewReport(actorPersonId, id, input):
 *   - Non-manager -> IncidentForbiddenError.
 *   - A holder of incidents.manage sets status and reviewNotes; RESOLVED/DISMISSED
 *     stamp resolvedById/resolvedAt, other statuses clear them.
 *   - Records an incident.review audit row.
 *
 * decideStrike(actorPersonId, reportId, input):
 *   - Non-manager -> IncidentForbiddenError.
 *   - Missing report -> IncidentNotFoundError.
 *   - Report with no pending strike request -> IncidentValidationError.
 *   - approve: bad category -> IncidentValidationError.
 *   - approve: creates a linked DisciplinaryAction (reportId, personId = subject),
 *     confidential mirrors the report's anonymous flag, strikeDecision -> APPROVED.
 *   - decline: strikeDecision -> DECLINED, no DisciplinaryAction created.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  submitReport,
  canRequestStrikeAgainst,
  listMyReports,
  getReport,
  listReviewQueue,
  reviewReport,
  decideStrike,
  CONCERN_TYPE_VALUES,
  IncidentValidationError,
  IncidentNotFoundError,
  IncidentForbiddenError,
} from "./report";
import { DISCIPLINARY_CATEGORIES } from "./disciplinary";

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

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
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

// ---------------------------------------------------------------------------
// listMyReports
// ---------------------------------------------------------------------------

describe("listMyReports", () => {
  it("returns only the actor's own reports, newest first", async () => {
    const a = await createPerson("A", "a001");
    const b = await createPerson("B", "b001");

    const first = await submitReport(a.id, { concernTypes: ["OTHER"], description: "first" });
    await submitReport(b.id, { concernTypes: ["OTHER"], description: "other-person" });
    const second = await submitReport(a.id, { concernTypes: ["OTHER"], description: "second" });

    const rows = await listMyReports(a.id);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.report.id)).toEqual([second.id, first.id]);
    expect(rows[0].report.description).toBe("second");
    expect(rows[1].report.description).toBe("first");
  });

  it("includes the subject's name when the report names a subject", async () => {
    const reporter = await createPerson("Reporter", "rep011");
    const subject = await createPerson("Subject Person", "sub003");

    await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "with subject",
      subjectPersonId: subject.id,
    });

    const rows = await listMyReports(reporter.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].subjectName).toBe("Subject Person");
  });

  it("returns an empty list when the actor has filed nothing", async () => {
    const a = await createPerson("NoReports", "nr001");

    expect(await listMyReports(a.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getReport
// ---------------------------------------------------------------------------

describe("getReport", () => {
  it("throws IncidentNotFoundError for a missing report", async () => {
    const someone = await createPerson("Someone", "some001");

    await expect(getReport(someone.id, "nonexistent-report-id")).rejects.toBeInstanceOf(
      IncidentNotFoundError
    );
  });

  it("forbids a non-owner without incidents.manage", async () => {
    const a = await createPerson("A", "a002");
    const stranger = await createPerson("S", "s001");
    const r = await submitReport(a.id, { concernTypes: ["OTHER"], description: "secret" });

    await expect(getReport(stranger.id, r.id)).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("allows the owner to read their own report, with reviewNotes stripped to null", async () => {
    const reporter = await createPerson("Reporter", "rep012");
    const subject = await createPerson("Subject", "sub004");
    const r = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "owner-visible",
      subjectPersonId: subject.id,
    });
    await prisma.incidentReport.update({
      where: { id: r.id },
      data: { reviewNotes: "internal reviewer notes" },
    });

    const { report, canManage } = await getReport(reporter.id, r.id);

    expect(canManage).toBe(false);
    expect(report.id).toBe(r.id);
    expect(report.reviewNotes).toBeNull();
    expect(report.reporter.name).toBe("Reporter");
    expect(report.subject?.name).toBe("Subject");
    expect(report.attachments).toEqual([]);
  });

  it("allows a holder of incidents.manage to read any report, including reviewNotes", async () => {
    const reporter = await createPerson("Reporter", "rep013");
    const manager = await createPerson("Manager", "mgr001");
    await grantPermission(manager.id, "incidents.manage");
    const r = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "manager-visible",
    });
    await prisma.incidentReport.update({
      where: { id: r.id },
      data: { reviewNotes: "internal reviewer notes" },
    });

    const { report, canManage } = await getReport(manager.id, r.id);

    expect(canManage).toBe(true);
    expect(report.id).toBe(r.id);
    expect(report.reviewNotes).toBe("internal reviewer notes");
  });
});

// ---------------------------------------------------------------------------
// listReviewQueue
// ---------------------------------------------------------------------------

describe("listReviewQueue", () => {
  it("forbids a non-manager", async () => {
    const a = await createPerson("A", "a003");

    await expect(listReviewQueue(a.id, {})).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("lets a manager see all reports, regardless of who reported them", async () => {
    const reporterOne = await createPerson("Reporter One", "rq001");
    const reporterTwo = await createPerson("Reporter Two", "rq002");
    const manager = await createPerson("Manager", "rq-mgr001");
    await grantPermission(manager.id, "incidents.manage");

    const first = await submitReport(reporterOne.id, { concernTypes: ["OTHER"], description: "from reporter one" });
    const second = await submitReport(reporterTwo.id, { concernTypes: ["OTHER"], description: "from reporter two" });

    const { rows, total } = await listReviewQueue(manager.id, {});

    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.report.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    const rowForOne = rows.find((r) => r.report.id === first.id);
    expect(rowForOne?.reporterName).toBe("Reporter One");
    const rowForTwo = rows.find((r) => r.report.id === second.id);
    expect(rowForTwo?.reporterName).toBe("Reporter Two");
  });

  it("filters by status", async () => {
    const reporter = await createPerson("Reporter", "rq003");
    const manager = await createPerson("Manager", "rq-mgr002");
    await grantPermission(manager.id, "incidents.manage");

    const submitted = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "still submitted" });
    const toResolve = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "will be resolved" });
    await reviewReport(manager.id, toResolve.id, { status: "RESOLVED" });

    const { rows, total } = await listReviewQueue(manager.id, { status: "RESOLVED" });

    expect(total).toBe(1);
    expect(rows.map((r) => r.report.id)).toEqual([toResolve.id]);
    expect(rows.map((r) => r.report.id)).not.toContain(submitted.id);
  });

  it("orders immediateRisk reports first even when older, then newest first among the rest", async () => {
    const reporter = await createPerson("Reporter", "rq004");
    const manager = await createPerson("Manager", "rq-mgr003");
    await grantPermission(manager.id, "incidents.manage");

    // Filed first (oldest) but immediateRisk, so it must still sort to the top.
    const risky = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY"],
      description: "immediate risk, filed first but should sort to the top",
      immediateRisk: true,
    });
    const older = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "older, no risk" });
    const newer = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "newer, no risk" });

    const { rows } = await listReviewQueue(manager.id, {});

    expect(rows.map((r) => r.report.id)).toEqual([risky.id, newer.id, older.id]);
  });
});

// ---------------------------------------------------------------------------
// reviewReport
// ---------------------------------------------------------------------------

describe("reviewReport", () => {
  it("forbids a non-manager", async () => {
    const reporter = await createPerson("Reporter", "rr001");
    const nonManager = await createPerson("NonManager", "rr002");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    await expect(
      reviewReport(nonManager.id, report.id, { status: "RESOLVED" })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("throws IncidentNotFoundError for a missing report", async () => {
    const manager = await createPerson("Manager", "rr-mgr001");
    await grantPermission(manager.id, "incidents.manage");

    await expect(
      reviewReport(manager.id, "nonexistent-report-id", { status: "RESOLVED" })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("sets status and reviewNotes, stamping resolvedById/resolvedAt for RESOLVED", async () => {
    const reporter = await createPerson("Reporter", "rr003");
    const manager = await createPerson("Manager", "rr-mgr002");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    const before = new Date();
    const updated = await reviewReport(manager.id, report.id, {
      status: "RESOLVED",
      reviewNotes: "Reviewed, no further action.",
    });

    expect(updated.status).toBe("RESOLVED");
    expect(updated.reviewNotes).toBe("Reviewed, no further action.");
    expect(updated.resolvedById).toBe(manager.id);
    expect(updated.resolvedAt).not.toBeNull();
    expect((updated.resolvedAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row?.status).toBe("RESOLVED");
    expect(row?.resolvedById).toBe(manager.id);
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.reviewNotes).toBe("Reviewed, no further action.");
  });

  it("stamps resolvedById/resolvedAt for DISMISSED and keeps existing notes when none are passed", async () => {
    const reporter = await createPerson("Reporter", "rr004");
    const manager = await createPerson("Manager", "rr-mgr003");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });
    await prisma.incidentReport.update({ where: { id: report.id }, data: { reviewNotes: "pre-existing note" } });

    const updated = await reviewReport(manager.id, report.id, { status: "DISMISSED" });

    expect(updated.status).toBe("DISMISSED");
    expect(updated.resolvedById).toBe(manager.id);
    expect(updated.resolvedAt).not.toBeNull();
    expect(updated.reviewNotes).toBe("pre-existing note");
  });

  it("clears resolvedById/resolvedAt for a non-terminal status", async () => {
    const reporter = await createPerson("Reporter", "rr005");
    const manager = await createPerson("Manager", "rr-mgr004");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });
    await reviewReport(manager.id, report.id, { status: "RESOLVED" });

    const reopened = await reviewReport(manager.id, report.id, { status: "UNDER_REVIEW" });

    expect(reopened.status).toBe("UNDER_REVIEW");
    expect(reopened.resolvedById).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
  });

  it("records an incident.review audit row", async () => {
    const reporter = await createPerson("Reporter", "rr006");
    const manager = await createPerson("Manager", "rr-mgr005");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    await reviewReport(manager.id, report.id, { status: "UNDER_REVIEW" });

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "incident.review", entityId: report.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorPersonId).toBe(manager.id);
    const after = auditRow?.after as Record<string, unknown>;
    expect(after.status).toBe("UNDER_REVIEW");
  });
});

// ---------------------------------------------------------------------------
// decideStrike
// ---------------------------------------------------------------------------

describe("decideStrike", () => {
  /**
   * Seeds a director who manages a department, an ACTIVE VOLUNTEER-kind
   * subject in that department in the active term, and a central
   * incidents.manage holder. The director then submits a report against the
   * subject with requestStrike: true, landing strikeDecision at PENDING.
   */
  async function seedPendingStrikeRequest(opts: { anonymous?: boolean } = {}) {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "ds-dir001");
    const subject = await createPerson("Volunteer", "ds-vol001");
    const manager = await createPerson("Manager", "ds-mgr001");

    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "incidents.manage");

    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show for a scheduled shift.",
      subjectPersonId: subject.id,
      requestStrike: true,
      anonymous: opts.anonymous ?? false,
      patientImpact: "YES",
    });

    expect(report.strikeDecision).toBe("PENDING");

    return { term, dept, director, subject, manager, report };
  }

  it("approve creates a linked confidential strike for an anonymous report", async () => {
    const { subject, manager, report } = await seedPendingStrikeRequest({ anonymous: true });

    const updated = await decideStrike(manager.id, report.id, {
      approve: true,
      category: DISCIPLINARY_CATEGORIES[0],
    });

    expect(updated.strikeDecision).toBe("APPROVED");
    expect(updated.strikeDecidedById).toBe(manager.id);
    expect(updated.strikeDecidedAt).not.toBeNull();

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } });
    expect(action).not.toBeNull();
    expect(action?.personId).toBe(subject.id);
    expect(action?.reportId).toBe(report.id);
    expect(action?.confidential).toBe(true);
    expect(action?.patientInvolved).toBe(true);
    expect(action?.category).toBe(DISCIPLINARY_CATEGORIES[0]);
    expect(action?.description).toBe(report.description);
    expect(action?.issuedById).toBe(manager.id);

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row?.strikeDecision).toBe("APPROVED");
    expect(row?.strikeDecidedById).toBe(manager.id);
  });

  it("approve for a non-anonymous report creates a non-confidential strike", async () => {
    const { subject, manager, report } = await seedPendingStrikeRequest({ anonymous: false });

    await decideStrike(manager.id, report.id, {
      approve: true,
      category: DISCIPLINARY_CATEGORIES[0],
    });

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } });
    expect(action).not.toBeNull();
    expect(action?.confidential).toBe(false);
    expect(action?.personId).toBe(subject.id);
  });

  it("decline sets strikeDecision DECLINED with no DisciplinaryAction created", async () => {
    const { manager, report } = await seedPendingStrikeRequest();

    const updated = await decideStrike(manager.id, report.id, { approve: false });

    expect(updated.strikeDecision).toBe("DECLINED");
    expect(updated.strikeDecidedById).toBe(manager.id);
    expect(updated.strikeDecidedAt).not.toBeNull();

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } });
    expect(action).toBeNull();

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row?.strikeDecision).toBe("DECLINED");
  });

  it("throws IncidentValidationError when the report has no pending strike request", async () => {
    const reporter = await createPerson("Reporter", "ds-rep001");
    const manager = await createPerson("Manager", "ds-mgr002");
    await grantPermission(manager.id, "incidents.manage");

    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "no strike requested",
    });
    expect(report.strikeDecision).toBeNull();

    await expect(
      decideStrike(manager.id, report.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentValidationError);

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } });
    expect(action).toBeNull();
  });

  it("throws IncidentValidationError when a decided report's strike is decided again", async () => {
    const { manager, report } = await seedPendingStrikeRequest();
    await decideStrike(manager.id, report.id, { approve: false });

    await expect(
      decideStrike(manager.id, report.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("forbids a non-manager, even the director who submitted the request", async () => {
    const { director, report } = await seedPendingStrikeRequest();

    await expect(
      decideStrike(director.id, report.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("throws IncidentNotFoundError for a missing report", async () => {
    const manager = await createPerson("Manager", "ds-mgr003");
    await grantPermission(manager.id, "incidents.manage");

    await expect(
      decideStrike(manager.id, "nonexistent-report-id", { approve: false })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("rejects approve with an invalid category, and creates no strike", async () => {
    const { manager, report } = await seedPendingStrikeRequest();

    await expect(
      decideStrike(manager.id, report.id, { approve: true, category: "NotACategory" })
    ).rejects.toBeInstanceOf(IncidentValidationError);

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId: report.id } });
    expect(action).toBeNull();
    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row?.strikeDecision).toBe("PENDING");
  });
});
