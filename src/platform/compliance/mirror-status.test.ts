import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { certExpiresAt } from "./rules";
import { computeMirrorStatus, refreshComplianceMirror } from "./mirror-status";

const DAY = 24 * 60 * 60 * 1000;

/** completionDate that yields an expiry far enough out to clear the term bar. */
function compliantCompletionDate(termEnd: Date): Date {
  // expiresAt = completionDate + 365d must be >= termEnd + 30d AND >= now + 60d.
  // Pick a completion date such that expiry sits well past both bars.
  const target = new Date(termEnd.getTime() + 200 * DAY); // desired expiry
  return new Date(target.getTime() - 365 * DAY);
}

async function createActiveTerm(overrides: { endDate?: Date } = {}) {
  const now = Date.now();
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date(now - 30 * DAY),
      endDate: overrides.endDate ?? new Date(now + 90 * DAY),
      status: "ACTIVE",
    },
  });
}

async function createPerson(name = "Test Person") {
  return prisma.person.create({ data: { name } });
}

async function createCert(personId: string, completionDate: Date | null) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "hipaa.pdf",
      storedName: `${personId}-cert.pdf`,
      size: 10,
      mimeType: "application/pdf",
      completionDate,
    },
  });
}

describe("computeMirrorStatus", () => {
  beforeEach(resetDb);

  it("returns 'Not Compliant' for a person with no certificate", async () => {
    await createActiveTerm();
    const person = await createPerson();
    expect(await computeMirrorStatus(person.id)).toBe("Not Compliant");
  });

  it("returns 'Not Compliant' for a cert with no completionDate (UNKNOWN_DATE)", async () => {
    await createActiveTerm();
    const person = await createPerson();
    await createCert(person.id, null);
    expect(await computeMirrorStatus(person.id)).toBe("Not Compliant");
  });

  it("returns 'Not Compliant' for an expired cert", async () => {
    await createActiveTerm();
    const person = await createPerson();
    // Completed > 365 days ago -> expired.
    await createCert(person.id, new Date(Date.now() - 400 * DAY));
    expect(await computeMirrorStatus(person.id)).toBe("Not Compliant");
  });

  it("returns 'Compliant' for a cert that clears the term bar", async () => {
    const term = await createActiveTerm();
    const person = await createPerson();
    await createCert(person.id, compliantCompletionDate(term.endDate));
    expect(await computeMirrorStatus(person.id)).toBe("Compliant");
  });

  it("uses the NEWEST cert (by uploadedAt desc) when several exist", async () => {
    const term = await createActiveTerm();
    const person = await createPerson();
    // Older expired cert.
    const older = await createCert(person.id, new Date(Date.now() - 400 * DAY));
    await prisma.hipaaCertificate.update({
      where: { id: older.id },
      data: { uploadedAt: new Date(Date.now() - 10 * DAY) },
    });
    // Newer compliant cert.
    const newer = await createCert(person.id, compliantCompletionDate(term.endDate));
    await prisma.hipaaCertificate.update({
      where: { id: newer.id },
      data: { uploadedAt: new Date() },
    });
    expect(await computeMirrorStatus(person.id)).toBe("Compliant");
  });

  it("falls back to the no-term rule when there is no active term", async () => {
    // No active term in the DB. A cert expiring well beyond now + 60d is COMPLIANT.
    const person = await createPerson();
    await createCert(person.id, new Date(Date.now() - 100 * DAY)); // expires ~265d out
    expect(await computeMirrorStatus(person.id)).toBe("Compliant");
  });
});

// ---------------------------------------------------------------------------
// refreshComplianceMirror
// ---------------------------------------------------------------------------

describe("refreshComplianceMirror", () => {
  beforeEach(resetDb);

  /** Create a person with an ACTIVE membership in the given term. */
  async function createMember(
    termId: string,
    departmentId: string,
    name: string
  ) {
    const person = await createPerson(name);
    await prisma.termMembership.create({
      data: {
        personId: person.id,
        termId,
        departmentId,
        kind: "VOLUNTEER",
        status: "ACTIVE",
      },
    });
    return person;
  }

  async function createDepartment(code = "ITCM") {
    return prisma.department.create({ data: { code, name: code } });
  }

  it("enqueues a Person outbox row only for people whose computed status differs from mirroredHipaaStatus", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment();

    // Person A: compliant cert, mirrored "Not Compliant" -> CHANGED -> enqueue.
    const a = await createMember(term.id, dept.id, "Alice Changed");
    await createCert(a.id, compliantCompletionDate(term.endDate));
    await prisma.person.update({ where: { id: a.id }, data: { mirroredHipaaStatus: "Not Compliant" } });

    // Person B: no cert (Not Compliant), mirrored "Not Compliant" -> UNCHANGED -> no enqueue.
    const b = await createMember(term.id, dept.id, "Bob Unchanged");
    await prisma.person.update({ where: { id: b.id }, data: { mirroredHipaaStatus: "Not Compliant" } });

    const count = await refreshComplianceMirror();

    expect(count).toBe(1);

    const aRows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: a.id } });
    expect(aRows).toHaveLength(1);
    expect(aRows[0].status).toBe("PENDING");
    expect(aRows[0].changedFields).toEqual(["hipaaStatus"]);

    const bRows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: b.id } });
    expect(bRows).toHaveLength(0);
  });

  it("enqueues when mirroredHipaaStatus is null and the computed status is anything (first assert)", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment();
    const a = await createMember(term.id, dept.id, "Never Mirrored");
    // No cert -> Not Compliant; mirroredHipaaStatus is null -> differs -> enqueue.

    const count = await refreshComplianceMirror();
    expect(count).toBe(1);

    const rows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: a.id } });
    expect(rows).toHaveLength(1);
  });

  it("includes people who have ANY cert even without an active-term membership", async () => {
    // No active term, no membership, but a cert on file -> still considered.
    const person = await createPerson("Cert Only");
    await createCert(person.id, new Date(Date.now() - 100 * DAY)); // Compliant under no-term rule

    const count = await refreshComplianceMirror();
    expect(count).toBe(1);
    const rows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: person.id } });
    expect(rows).toHaveLength(1);
  });

  it("skips enqueue when a PENDING Person outbox row already exists for that person", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment();
    const a = await createMember(term.id, dept.id, "Already Pending");
    await createCert(a.id, compliantCompletionDate(term.endDate));
    await prisma.person.update({ where: { id: a.id }, data: { mirroredHipaaStatus: "Not Compliant" } });
    // Pre-existing PENDING row.
    await prisma.outbox.create({
      data: {
        entityType: "Person",
        entityId: a.id,
        operation: "upsert",
        changedFields: ["name"],
        status: "PENDING",
      },
    });

    const count = await refreshComplianceMirror();

    // Status differs, but a PENDING row already exists -> not counted, not duplicated.
    expect(count).toBe(0);
    const rows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: a.id } });
    expect(rows).toHaveLength(1);
  });

  it("leaves unchanged people untouched and returns 0 when nothing changed", async () => {
    const term = await createActiveTerm();
    const dept = await createDepartment();
    const a = await createMember(term.id, dept.id, "Compliant And Mirrored");
    await createCert(a.id, compliantCompletionDate(term.endDate));
    await prisma.person.update({ where: { id: a.id }, data: { mirroredHipaaStatus: "Compliant" } });

    const count = await refreshComplianceMirror();

    expect(count).toBe(0);
    const rows = await prisma.outbox.findMany({ where: { entityType: "Person", entityId: a.id } });
    expect(rows).toHaveLength(0);
  });

  // Guard: certExpiresAt is exercised so a future drift in the rule surfaces here.
  it("sanity: compliantCompletionDate yields an expiry past the term bar", async () => {
    const term = await createActiveTerm();
    const completion = compliantCompletionDate(term.endDate);
    expect(certExpiresAt(completion).getTime()).toBeGreaterThan(
      term.endDate.getTime() + 30 * DAY
    );
  });
});
