/**
 * TDD tests for the incident reports intake service.
 *
 * submitReport(actorPersonId, input):
 *   - Creates a SUBMITTED report with the reporter set.
 *   - Persists the optional fields passed in (setting, subjectDescription,
 *     patientImpact, issueNature, priorOccurrence).
 *   - subjects: Array<{ personId, requestStrike? }> creates one deduped
 *     IncidentReportSubject row per person, strike-flagged ones PENDING.
 *   - Validation: empty concernTypes -> IncidentValidationError.
 *   - Validation: unknown concern type value -> IncidentValidationError.
 *   - Validation: blank description -> IncidentValidationError.
 *   - Validation: future occurredAt -> IncidentValidationError.
 *   - Missing linked personId -> IncidentNotFoundError.
 *   - requestStrike when the actor does not manage that subject -> IncidentValidationError.
 *   - requestStrike when the actor manages the subject (active DIRECTOR of a
 *     department the subject is an ACTIVE VOLUNTEER in) -> that row's strikeDecision PENDING.
 *   - Records an incident.submit audit row.
 *
 * canRequestStrikeAgainst(actorPersonId, subjectPersonId):
 *   - false when there is no active term.
 *   - false when the subject's membership is in a department the actor does not manage.
 *
 * listMyReports(actorPersonId):
 *   - Returns only the actor's own reports, newest first, with subjectNames/strike counts.
 *
 * getReport(actorPersonId, id):
 *   - Missing report -> IncidentNotFoundError.
 *   - Non-owner without incidents.manage -> IncidentForbiddenError.
 *   - Owner (non-manager) can read their own report, with reviewNotes stripped to null.
 *   - A holder of incidents.manage can read any report, reviewNotes included.
 *   - report.subjects exposes each linked person with their strikeDecision.
 *
 * listReviewQueue(actorPersonId, filters):
 *   - Non-manager -> IncidentForbiddenError.
 *   - A holder of incidents.manage sees all reports, regardless of reporter.
 *   - Filters by status.
 *   - Orders immediateRisk reports first, then newest first.
 *   - q matches any linked subject's name; strikePending matches any PENDING subject.
 *
 * reviewReport(actorPersonId, id, input):
 *   - Non-manager -> IncidentForbiddenError.
 *   - A holder of incidents.manage sets status and reviewNotes; RESOLVED/DISMISSED
 *     stamp resolvedById/resolvedAt, other statuses clear them.
 *   - Records an incident.review audit row.
 *
 * decideStrike(actorPersonId, reportSubjectId, input):
 *   - Non-manager -> IncidentForbiddenError.
 *   - Missing IncidentReportSubject row -> IncidentNotFoundError.
 *   - Row with no pending strike request -> IncidentValidationError.
 *   - approve: bad category -> IncidentValidationError.
 *   - approve: creates a linked DisciplinaryAction (reportId, personId = subject),
 *     confidential mirrors the report's anonymous flag, strikeDecision -> APPROVED.
 *   - decline: strikeDecision -> DECLINED, no DisciplinaryAction created.
 *   - Deciding one subject's row never touches another subject's row on the same report.
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
  linkableReports,
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
  it("creates a SUBMITTED report with the reporter set", async () => {
    const reporter = await createPerson("Reporter", "rep001");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "On 2/14 the volunteer raised their voice at a patient.",
      subjectDescription: "SCTM volunteer",
    });

    expect(report.status).toBe("SUBMITTED");
    expect(report.reporterId).toBe(reporter.id);
    expect(report.anonymous).toBe(false);
    expect(report.immediateRisk).toBe(false);

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row).not.toBeNull();
    expect(row?.concernTypes).toEqual(["PROFESSIONAL_CONDUCT"]);
    expect(row?.subjectDescription).toBe("SCTM volunteer");
  });

  it("persists the optional fields provided (setting, patient impact, issue nature)", async () => {
    const reporter = await createPerson("Reporter", "rep002");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY", "DOCUMENTATION_WORKFLOW"],
      description: "Medication error during triage.",
      occurredAt: new Date("2026-06-01"),
      setting: "Triage room 2",
      patientImpact: "YES",
      patientImpactDetail: "Patient received wrong dosage.",
      immediateRisk: true,
      issueNature: "INDIVIDUAL",
      priorOccurrence: "NO",
      anonymous: true,
    });

    expect(report.setting).toBe("Triage room 2");
    expect(report.patientImpact).toBe("YES");
    expect(report.patientImpactDetail).toBe("Patient received wrong dosage.");
    expect(report.immediateRisk).toBe(true);
    expect(report.issueNature).toBe("INDIVIDUAL");
    expect(report.priorOccurrence).toBe("NO");
    expect(report.anonymous).toBe(true);
    expect(report.concernTypes).toEqual(["PATIENT_SAFETY", "DOCUMENTATION_WORKFLOW"]);
  });

  it("persists multiple linked people as IncidentReportSubject rows", async () => {
    const reporter = await createPerson("Reporter", "rep002");
    const a = await createPerson("Alex", "sub-a");
    const b = await createPerson("Bri", "sub-b");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY"],
      description: "Both were involved in the handoff error.",
      subjectDescription: "two volunteers",
      subjects: [{ personId: a.id }, { personId: b.id }],
    });

    const rows = await prisma.incidentReportSubject.findMany({
      where: { reportId: report.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.personId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.strikeDecision === null)).toBe(true);
    expect(report.subjectDescription).toBe("two volunteers");
  });

  it("dedupes a repeated personId into a single link", async () => {
    const reporter = await createPerson("Reporter", "rep002b");
    const a = await createPerson("Alex", "sub-a2");

    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "x",
      subjects: [{ personId: a.id }, { personId: a.id, requestStrike: false }],
    });

    const rows = await prisma.incidentReportSubject.findMany({ where: { reportId: report.id } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a linked person that does not exist -> IncidentNotFoundError", async () => {
    const reporter = await createPerson("Reporter", "rep002c");
    await expect(
      submitReport(reporter.id, {
        concernTypes: ["OTHER"],
        description: "x",
        subjects: [{ personId: "nonexistent-person-id" }],
      })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("rejects requestStrike against a person the actor does not manage -> IncidentValidationError", async () => {
    const reporter = await createPerson("Reporter", "rep009");
    const subject = await createPerson("Subject", "sub002");
    await expect(
      submitReport(reporter.id, {
        concernTypes: ["ATTENDANCE_RELIABILITY"],
        description: "no-show",
        subjects: [{ personId: subject.id, requestStrike: true }],
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("sets strikeDecision PENDING only for the managed volunteer, null for the rest", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "dir001");
    const managed = await createPerson("Managed Volunteer", "vol001");
    const other = await createPerson("Unmanaged Person", "oth001");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");

    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show for a scheduled shift.",
      subjects: [{ personId: managed.id, requestStrike: true }, { personId: other.id }],
    });

    const rows = await prisma.incidentReportSubject.findMany({ where: { reportId: report.id } });
    const byPerson = new Map(rows.map((r) => [r.personId, r.strikeDecision]));
    expect(byPerson.get(managed.id)).toBe("PENDING");
    expect(byPerson.get(other.id)).toBeNull();
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

  it("persists an attachment row for a file passed in input.files", async () => {
    const reporter = await createPerson("Reporter", "rep011att");

    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "See attached screenshot.",
      files: [
        {
          fileName: "screenshot.png",
          mimeType: "image/png",
          bytes: Buffer.from("fake-png-bytes"),
        },
      ],
    });

    const attachments = await prisma.incidentReportAttachment.findMany({
      where: { reportId: report.id },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0].fileName).toBe("screenshot.png");
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].uploadedById).toBe(reporter.id);
    expect(attachments[0].storedName).not.toBe("pending");
    expect(attachments[0].storedName).toBe(`incidents/${report.id}/${attachments[0].id}.png`);
  });

  it("rejects an oversized attachment before creating any report row (M4)", async () => {
    const reporter = await createPerson("Reporter", "rep-oversized");

    // uploads.maxMb defaults to 5 MB in tests; a 6 MB file exceeds the cap, so
    // validateUploadedFile throws IncidentValidationError. That validation now
    // runs before prisma.incidentReport.create, so no report row is committed.
    const oversized = Buffer.alloc(6 * 1024 * 1024);
    await expect(
      submitReport(reporter.id, {
        concernTypes: ["OTHER"],
        description: "See attached oversized file.",
        files: [{ fileName: "huge.png", mimeType: "image/png", bytes: oversized }],
      })
    ).rejects.toBeInstanceOf(IncidentValidationError);

    // The submission rejected before any report or attachment row existed.
    expect(await prisma.incidentReport.count({ where: { reporterId: reporter.id } })).toBe(0);
    expect(await prisma.incidentReportAttachment.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// submitReport -> notify() wiring
// ---------------------------------------------------------------------------

describe("submitReport notifications", () => {
  it("notifies every incidents.manage holder of the new report, and never notifies the subject", async () => {
    const reporter = await createPerson("Reporter", "notif-rep001");
    const subject = await createPerson("Subject", "notif-sub001");
    const manager = await createPerson("Manager", "notif-mgr001");
    await grantPermission(manager.id, "incidents.manage");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Raised their voice at a patient.",
      subjects: [{ personId: subject.id }],
    });

    const managerNotes = await prisma.notification.findMany({
      where: { personId: manager.id, type: "incidents.report_submitted" },
    });
    expect(managerNotes).toHaveLength(1);
    expect(managerNotes[0].body).toContain(String(report.number));
    expect(managerNotes[0].link).toMatch(/\/incidents\/review$/);

    // The subject of the report is never a notification recipient.
    const subjectNotes = await prisma.notification.findMany({ where: { personId: subject.id } });
    expect(subjectNotes).toEqual([]);
  });

  it("does not fail when no one holds incidents.manage", async () => {
    const reporter = await createPerson("Reporter", "notif-rep002");

    await expect(
      submitReport(reporter.id, { concernTypes: ["OTHER"], description: "no reviewers exist yet" })
    ).resolves.toBeDefined();

    expect(await prisma.notification.count({ where: { type: "incidents.report_submitted" } })).toBe(0);
  });

  it("sends one strike_requested alert naming the flagged people when a strike is requested", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "notif-dir001");
    const managed = await createPerson("Managed Vol", "notif-vol001");
    const bystander = await createPerson("Bystander", "notif-by001");
    const manager = await createPerson("Manager", "notif-mgr002");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "incidents.manage");

    await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show.",
      subjects: [{ personId: managed.id, requestStrike: true }, { personId: bystander.id }],
    });

    const submittedNotes = await prisma.notification.findMany({
      where: { personId: manager.id, type: "incidents.report_submitted" },
    });
    expect(submittedNotes).toHaveLength(1);

    const strikeNotes = await prisma.notification.findMany({
      where: { personId: manager.id, type: "incidents.strike_requested" },
    });
    expect(strikeNotes).toHaveLength(1);
    expect(strikeNotes[0].body).toContain("Managed Vol");

    // Neither the director (reporter) nor the subjects receive these alerts.
    expect(await prisma.notification.count({ where: { personId: director.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { personId: managed.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { personId: bystander.id } })).toBe(0);
  });

  it("excludes a linked subject who holds incidents.manage from the reviewer alerts, while still notifying a separate manager (M7)", async () => {
    const reporter = await createPerson("Reporter", "notif-m7-rep");
    const subjectManager = await createPerson("Subject Manager", "notif-m7-subm");
    const otherManager = await createPerson("Other Manager", "notif-m7-oth");
    await grantPermission(subjectManager.id, "incidents.manage");
    await grantPermission(otherManager.id, "incidents.manage");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Concerns the subject, who also manages incidents.",
      subjects: [{ personId: subjectManager.id }],
    });

    // The separate manager is alerted about the new report.
    const otherNotes = await prisma.notification.findMany({
      where: { personId: otherManager.id, type: "incidents.report_submitted" },
    });
    expect(otherNotes).toHaveLength(1);
    expect(otherNotes[0].body).toContain(String(report.number));

    // The linked subject, though they hold incidents.manage, is filtered out of
    // the reviewer set and receives no notification about a report about them.
    expect(await prisma.notification.count({ where: { personId: subjectManager.id } })).toBe(0);
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
      subjects: [{ personId: subject.id }],
    });

    const rows = await listMyReports(reporter.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].subjectNames).toEqual(["Subject Person"]);
  });

  it("returns an empty list when the actor has filed nothing", async () => {
    const a = await createPerson("NoReports", "nr001");

    expect(await listMyReports(a.id)).toEqual([]);
  });

  it("breaks a same-millisecond createdAt tie by number, newest first", async () => {
    const a = await createPerson("Tiebreak", "tb001");

    const first = await submitReport(a.id, { concernTypes: ["OTHER"], description: "first" });
    const second = await submitReport(a.id, { concernTypes: ["OTHER"], description: "second" });

    // Force an identical createdAt to simulate two reports landing in the
    // same millisecond; only the number tiebreaker can then order them.
    const tiedAt = new Date();
    await prisma.incidentReport.update({ where: { id: first.id }, data: { createdAt: tiedAt } });
    await prisma.incidentReport.update({ where: { id: second.id }, data: { createdAt: tiedAt } });

    const rows = await listMyReports(a.id);

    expect(rows.map((r) => r.report.id)).toEqual([second.id, first.id]);
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
      subjects: [{ personId: subject.id }],
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
    expect(report.subjects.map((s) => s.person.name)).toEqual(["Subject"]);
    expect(report.attachments).toEqual([]);
  });

  it("denies manage powers to a self-reporting subject-manager: reviewNotes stripped, canManage false (audit #11)", async () => {
    const selfManager = await createPerson("Self Manager", "self01");
    await grantPermission(selfManager.id, "incidents.manage");
    // They file a report about an incident they were involved in and list themselves
    // among the subjects. reviewReport/decideStrike reject a subject server-side, so
    // getReport must not hand them manage powers (reviewNotes leak + dead-end controls).
    const r = await submitReport(selfManager.id, {
      concernTypes: ["OTHER"],
      description: "self-report",
      subjects: [{ personId: selfManager.id }],
    });
    await prisma.incidentReport.update({
      where: { id: r.id },
      data: { reviewNotes: "M appears culpable; recommend removal." },
    });

    const { report, canManage } = await getReport(selfManager.id, r.id);
    expect(canManage).toBe(false);
    expect(report.reviewNotes).toBeNull();
  });

  it("getReport returns the linked subjects with names", async () => {
    const owner = await createPerson("Owner", "gr-own");
    const a = await createPerson("Alex", "gr-a");
    const report = await submitReport(owner.id, {
      concernTypes: ["OTHER"],
      description: "x",
      subjects: [{ personId: a.id }],
    });
    const { report: got } = await getReport(owner.id, report.id);
    expect(got.subjects.map((s) => s.person.name)).toEqual(["Alex"]);
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

  it("forbids a subject who holds incidents.manage from reading a report about themselves", async () => {
    const reporter = await createPerson("Reporter", "m5-get-rep001");
    const subject = await createPerson("Subject", "m5-get-sub001");
    await grantPermission(subject.id, "incidents.manage");
    const r = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "about the subject",
      subjects: [{ personId: subject.id }],
    });

    await expect(getReport(subject.id, r.id)).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("still lets a subject who holds incidents.manage read a report they filed themselves (owner path)", async () => {
    const owner = await createPerson("Owner", "m5-get-own001");
    await grantPermission(owner.id, "incidents.manage");
    // The reporter files a report naming themselves as the subject; the
    // reporter-owner read path must remain open.
    const r = await submitReport(owner.id, {
      concernTypes: ["OTHER"],
      description: "self-filed",
      subjects: [{ personId: owner.id }],
    });

    const { report } = await getReport(owner.id, r.id);
    expect(report.id).toBe(r.id);
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

  it("q matches a report by any linked subject's name", async () => {
    const reporter = await createPerson("Reporter", "lq-rep");
    const manager = await createPerson("Manager", "lq-mgr");
    const zoe = await createPerson("Zoe Zephyr", "lq-zoe");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "x",
      subjects: [{ personId: zoe.id }],
    });
    const { rows } = await listReviewQueue(manager.id, { q: "Zephyr" });
    expect(rows.map((r) => r.report.id)).toContain(report.id);
    expect(rows.find((r) => r.report.id === report.id)?.subjectNames).toContain("Zoe Zephyr");
  });

  it("strikePending matches a report with any PENDING subject", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "lq-dir");
    const managed = await createPerson("Managed", "lq-vol");
    const manager = await createPerson("Manager", "lq-mgr2");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "x",
      subjects: [{ personId: managed.id, requestStrike: true }],
    });
    const { rows } = await listReviewQueue(manager.id, { strikePending: true });
    expect(rows.map((r) => r.report.id)).toContain(report.id);
    expect(rows.find((r) => r.report.id === report.id)?.strikePendingCount).toBe(1);
  });

  it("excludes reports that link the reviewer as a subject, while keeping subject-less reports", async () => {
    const reporter = await createPerson("Reporter", "m5-rq-rep001");
    const other = await createPerson("Other", "m5-rq-oth001");
    const managerSubject = await createPerson("ManagerSubject", "m5-rq-ms001");
    await grantPermission(managerSubject.id, "incidents.manage");

    const aboutManager = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "about the reviewer themselves",
      subjects: [{ personId: managerSubject.id }],
    });
    const noSubject = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "no subject linked",
    });
    const aboutOther = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "about someone else",
      subjects: [{ personId: other.id }],
    });

    const { rows, total } = await listReviewQueue(managerSubject.id, {});
    const ids = rows.map((r) => r.report.id);

    expect(ids).not.toContain(aboutManager.id);
    expect(ids).toContain(noSubject.id);
    expect(ids).toContain(aboutOther.id);
    expect(total).toBe(2);
  });

  it("ignores an unknown status filter value instead of throwing", async () => {
    const reporter = await createPerson("Reporter", "l8-rq-rep001");
    const manager = await createPerson("Manager", "l8-rq-mgr001");
    await grantPermission(manager.id, "incidents.manage");
    await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    // A crafted, non-enum status must not reach Prisma; it is dropped and the
    // query returns all reports rather than throwing.
    const { total } = await listReviewQueue(manager.id, { status: "NOT_A_STATUS" });
    expect(total).toBe(1);
  });

  it("does not overflow int4 when q is a digit string larger than 2147483647", async () => {
    const reporter = await createPerson("Reporter", "m6-rq-rep001");
    const manager = await createPerson("Manager", "m6-rq-mgr001");
    await grantPermission(manager.id, "incidents.manage");
    await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    // 9999999999 exceeds a Postgres int4; the numeric branch must be skipped so
    // the query matches on names only rather than throwing.
    await expect(listReviewQueue(manager.id, { q: "9999999999" })).resolves.toMatchObject({ total: 0 });
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

  it("notifies the reporter when a report is RESOLVED, and never notifies the subject", async () => {
    const reporter = await createPerson("Reporter", "rr007");
    const subject = await createPerson("Subject", "rr-sub001");
    const manager = await createPerson("Manager", "rr-mgr006");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "x",
      subjects: [{ personId: subject.id }],
    });

    await reviewReport(manager.id, report.id, { status: "RESOLVED" });

    const reporterNotes = await prisma.notification.findMany({
      where: { personId: reporter.id, type: "incidents.report_resolved" },
    });
    expect(reporterNotes).toHaveLength(1);
    expect(reporterNotes[0].body).toContain("resolved");
    expect(reporterNotes[0].link).toMatch(new RegExp(`/incidents/${report.id}$`));

    expect(await prisma.notification.count({ where: { personId: subject.id } })).toBe(0);
  });

  it("notifies the reporter when a report is DISMISSED, and does not notify on a non-terminal status", async () => {
    const reporter = await createPerson("Reporter", "rr008");
    const manager = await createPerson("Manager", "rr-mgr007");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    await reviewReport(manager.id, report.id, { status: "UNDER_REVIEW" });
    expect(
      await prisma.notification.count({ where: { personId: reporter.id, type: "incidents.report_resolved" } })
    ).toBe(0);

    await reviewReport(manager.id, report.id, { status: "DISMISSED" });

    const reporterNotes = await prisma.notification.findMany({
      where: { personId: reporter.id, type: "incidents.report_resolved" },
    });
    expect(reporterNotes).toHaveLength(1);
    expect(reporterNotes[0].body).toContain("dismissed");
  });

  it("does not re-notify or reset the resolution date when re-saving an already-terminal report", async () => {
    const reporter = await createPerson("Reporter", "rr009");
    const manager = await createPerson("Manager", "rr-mgr009");
    await grantPermission(manager.id, "incidents.manage");
    const report = await submitReport(reporter.id, { concernTypes: ["OTHER"], description: "x" });

    const resolved = await reviewReport(manager.id, report.id, { status: "RESOLVED" });
    const firstResolvedAt = (resolved.resolvedAt as Date).getTime();

    // A reviewer re-opens the closed report only to edit reviewNotes; the Status
    // select still reads RESOLVED, so the status does not actually change.
    const reSaved = await reviewReport(manager.id, report.id, {
      status: "RESOLVED",
      reviewNotes: "added context",
    });

    // The reporter is notified exactly once (from the original resolution).
    expect(
      await prisma.notification.count({ where: { personId: reporter.id, type: "incidents.report_resolved" } })
    ).toBe(1);
    // The original resolution timestamp is preserved, not bumped to now.
    expect((reSaved.resolvedAt as Date).getTime()).toBe(firstResolvedAt);
    expect(reSaved.resolvedById).toBe(manager.id);
    expect(reSaved.reviewNotes).toBe("added context");
  });

  it("forbids a subject who holds incidents.manage from adjudicating a report about themselves", async () => {
    const reporter = await createPerson("Reporter", "m5-rr-rep001");
    const subject = await createPerson("Subject", "m5-rr-sub001");
    await grantPermission(subject.id, "incidents.manage");
    const report = await submitReport(reporter.id, {
      concernTypes: ["OTHER"],
      description: "about the subject",
      subjects: [{ personId: subject.id }],
    });

    await expect(
      reviewReport(subject.id, report.id, { status: "RESOLVED" })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);

    const row = await prisma.incidentReport.findUnique({ where: { id: report.id } });
    expect(row?.status).toBe("SUBMITTED");
  });
});

// ---------------------------------------------------------------------------
// decideStrike
// ---------------------------------------------------------------------------

describe("decideStrike (per subject)", () => {
  async function seedPendingStrike() {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "ds-dir");
    const managed = await createPerson("Managed", "ds-vol");
    const bystander = await createPerson("Bystander", "ds-by");
    const manager = await createPerson("Manager", "ds-mgr");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(manager.id, "incidents.manage");

    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show.",
      anonymous: true,
      subjects: [{ personId: managed.id, requestStrike: true }, { personId: bystander.id }],
    });
    const pending = await prisma.incidentReportSubject.findFirstOrThrow({
      where: { reportId: report.id, strikeDecision: "PENDING" },
    });
    return { report, pending, managed, bystander, manager, director };
  }

  it("non-manager -> IncidentForbiddenError", async () => {
    const { pending, director } = await seedPendingStrike();
    await expect(
      decideStrike(director.id, pending.id, { approve: false })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("missing subject row -> IncidentNotFoundError", async () => {
    const { manager } = await seedPendingStrike();
    await expect(
      decideStrike(manager.id, "no-such-row", { approve: false })
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });

  it("a co-subject of the report cannot adjudicate another subject's strike, even holding incidents.manage", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const director = await createPerson("Director", "ds-cosub-dir");
    const managed = await createPerson("Managed", "ds-cosub-vol");
    const coSubjectManager = await createPerson("Co Subject Manager", "ds-cosub-mgr");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(managed.id, term.id, dept.id, "VOLUNTEER");
    await grantPermission(coSubjectManager.id, "incidents.manage");

    // A report linking the managed volunteer (strike requested) and the manager as a
    // co-subject. The manager holds incidents.manage but is a subject of this report.
    const report = await submitReport(director.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "Both were involved.",
      anonymous: true,
      subjects: [{ personId: managed.id, requestStrike: true }, { personId: coSubjectManager.id }],
    });
    const pending = await prisma.incidentReportSubject.findFirstOrThrow({
      where: { reportId: report.id, strikeDecision: "PENDING" },
    });

    await expect(
      decideStrike(coSubjectManager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);
    // The co-subject's attempt leaves the pending strike untouched.
    const row = await prisma.incidentReportSubject.findUnique({ where: { id: pending.id } });
    expect(row?.strikeDecision).toBe("PENDING");
  });

  it("approve issues one DisciplinaryAction for that person, mirrors anonymous->confidential, sets APPROVED", async () => {
    const { pending, managed, manager } = await seedPendingStrike();

    const row = await decideStrike(manager.id, pending.id, {
      approve: true,
      category: DISCIPLINARY_CATEGORIES[0],
    });
    expect(row.strikeDecision).toBe("APPROVED");
    expect(row.strikeDecidedById).toBe(manager.id);

    const actions = await prisma.disciplinaryAction.findMany({ where: { personId: managed.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0].reportId).toBe(pending.reportId);
    expect(actions[0].confidential).toBe(true);
  });

  it("approving one subject leaves another subject's request untouched", async () => {
    const { report, pending, manager } = await seedPendingStrike();
    await decideStrike(manager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] });
    const others = await prisma.incidentReportSubject.findMany({
      where: { reportId: report.id, id: { not: pending.id } },
    });
    expect(others.every((r) => r.strikeDecision === null)).toBe(true);
  });

  it("decline sets DECLINED with no DisciplinaryAction", async () => {
    const { pending, managed, manager } = await seedPendingStrike();
    const row = await decideStrike(manager.id, pending.id, { approve: false });
    expect(row.strikeDecision).toBe("DECLINED");
    expect(await prisma.disciplinaryAction.count({ where: { personId: managed.id } })).toBe(0);
  });

  it("row not PENDING -> IncidentValidationError", async () => {
    const { pending, manager } = await seedPendingStrike();
    await decideStrike(manager.id, pending.id, { approve: false });
    await expect(
      decideStrike(manager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentValidationError);
  });

  it("rejects approve with an invalid category, and creates no strike", async () => {
    const { pending, manager } = await seedPendingStrike();

    await expect(
      decideStrike(manager.id, pending.id, { approve: true, category: "NotACategory" })
    ).rejects.toBeInstanceOf(IncidentValidationError);

    const action = await prisma.disciplinaryAction.findUnique({ where: { reportId_personId: { reportId: pending.reportId, personId: pending.personId } } });
    expect(action).toBeNull();
    const row = await prisma.incidentReportSubject.findUnique({ where: { id: pending.id } });
    expect(row?.strikeDecision).toBe("PENDING");
  });

  it("notifies the reporter (approve = true) when a strike is approved, and never notifies the linked people", async () => {
    const { director, managed, bystander, manager, pending } = await seedPendingStrike();

    await decideStrike(manager.id, pending.id, {
      approve: true,
      category: DISCIPLINARY_CATEGORIES[0],
    });

    const reporterNotes = await prisma.notification.findMany({
      where: { personId: director.id, type: "incidents.strike_decided" },
    });
    expect(reporterNotes).toHaveLength(1);
    expect(reporterNotes[0].body).toContain("approved");

    expect(await prisma.notification.count({ where: { personId: managed.id, type: "incidents.strike_decided" } })).toBe(0);
    expect(await prisma.notification.count({ where: { personId: bystander.id, type: "incidents.strike_decided" } })).toBe(0);
  });

  it("notifies the reporter (approve = false) when a strike is declined", async () => {
    const { director, manager, pending } = await seedPendingStrike();

    await decideStrike(manager.id, pending.id, { approve: false });

    const reporterNotes = await prisma.notification.findMany({
      where: { personId: director.id, type: "incidents.strike_decided" },
    });
    expect(reporterNotes).toHaveLength(1);
    expect(reporterNotes[0].body).toContain("declined");
  });

  it("forbids a linked subject who holds incidents.manage from deciding a strike on themselves", async () => {
    const { pending, managed } = await seedPendingStrike();
    await grantPermission(managed.id, "incidents.manage");

    await expect(
      decideStrike(managed.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] })
    ).rejects.toBeInstanceOf(IncidentForbiddenError);

    const row = await prisma.incidentReportSubject.findUnique({ where: { id: pending.id } });
    expect(row?.strikeDecision).toBe("PENDING");
    expect(await prisma.disciplinaryAction.count({ where: { personId: managed.id } })).toBe(0);
  });

  it("rejects a second decideStrike once the strike was approved, leaving exactly one strike (L2 atomic guard)", async () => {
    const { pending, managed, manager } = await seedPendingStrike();
    await decideStrike(manager.id, pending.id, { approve: true, category: DISCIPLINARY_CATEGORIES[0] });

    // A second decision (here a decline) on the now-APPROVED subject row must be
    // rejected rather than flipping it to DECLINED while the strike stays live.
    await expect(
      decideStrike(manager.id, pending.id, { approve: false })
    ).rejects.toBeInstanceOf(IncidentValidationError);

    const row = await prisma.incidentReportSubject.findUnique({ where: { id: pending.id } });
    expect(row?.strikeDecision).toBe("APPROVED");
    expect(await prisma.disciplinaryAction.count({ where: { personId: managed.id } })).toBe(1);
  });

  it("notifies the subject and their directors when a strike is approved", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SCTM");
    const central = await createPerson("Central", "ds-notif-c");
    const director = await createPerson("Dept Director", "ds-notif-d");
    const subject = await createPerson("Struck Volunteer", "ds-notif-s");
    const reporter = await createPerson("Reporter", "ds-notif-r");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const report = await submitReport(reporter.id, {
      concernTypes: ["ATTENDANCE_RELIABILITY"],
      description: "No-call/no-show for a Saturday clinic.",
      subjects: [{ personId: subject.id }],
    });
    const row = await prisma.incidentReportSubject.findFirstOrThrow({
      where: { reportId: report.id, personId: subject.id },
    });
    await prisma.incidentReportSubject.update({
      where: { id: row.id },
      data: { strikeDecision: "PENDING" },
    });

    await decideStrike(central.id, row.id, { approve: true, category: "Attendance" });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { personId: director.id, type: "incidents.strike_issued_directors" },
      })
    ).toBe(1);
  });

  it("notifies no director when the report was anonymous, since the strike is confidential", async () => {
    const term = await createTerm();
    const dept = await createDepartment("JCTM");
    const central = await createPerson("Central", "ds-anon-c");
    const director = await createPerson("Dept Director", "ds-anon-d");
    const subject = await createPerson("Struck Volunteer", "ds-anon-s");
    const reporter = await createPerson("Reporter", "ds-anon-r");
    await grantPermission(central.id, "incidents.manage");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");
    await createMembership(subject.id, term.id, dept.id, "VOLUNTEER");

    const report = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Anonymous concern.",
      anonymous: true,
      subjects: [{ personId: subject.id }],
    });
    const row = await prisma.incidentReportSubject.findFirstOrThrow({
      where: { reportId: report.id, personId: subject.id },
    });
    await prisma.incidentReportSubject.update({
      where: { id: row.id },
      data: { strikeDecision: "PENDING" },
    });

    await decideStrike(central.id, row.id, { approve: true, category: "Professionalism" });

    expect(
      await prisma.notification.count({
        where: { personId: subject.id, type: "incidents.strike_issued" },
      })
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { type: "incidents.strike_issued_directors" } })
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// linkableReports
// ---------------------------------------------------------------------------

describe("linkableReports", () => {
  it("rejects an actor without incidents.manage", async () => {
    const nobody = await createPerson("Nobody", "lr-nc");
    await expect(linkableReports(nobody.id)).rejects.toBeInstanceOf(IncidentForbiddenError);
  });

  it("labels a report with its number, concern types, and date, newest first", async () => {
    const central = await createPerson("Central", "lr-c");
    const reporter = await createPerson("Reporter", "lr-r");
    await grantPermission(central.id, "incidents.manage");

    const older = await submitReport(reporter.id, {
      concernTypes: ["PROFESSIONAL_CONDUCT"],
      description: "Older report.",
    });
    const newer = await submitReport(reporter.id, {
      concernTypes: ["PATIENT_SAFETY", "PRIVACY_HIPAA"],
      description: "Newer report.",
    });

    const rows = await linkableReports(central.id);
    expect(rows[0].id).toBe(newer.id);
    expect(rows[0].label).toContain(`#${newer.number}`);
    expect(rows[0].label).toContain("Patient Safety");
    expect(rows[1].id).toBe(older.id);
  });

  it("caps the list at 200 reports", async () => {
    const central = await createPerson("Central", "lr-cap-c");
    const reporter = await createPerson("Reporter", "lr-cap-r");
    await grantPermission(central.id, "incidents.manage");

    await prisma.incidentReport.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        number: 5000 + i,
        reporterId: reporter.id,
        concernTypes: ["OTHER"],
        description: `Bulk report ${i}.`,
      })),
    });

    expect(await linkableReports(central.id)).toHaveLength(200);
  });
});
