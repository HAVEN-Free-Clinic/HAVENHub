/**
 * TDD tests for the volunteers compliance service.
 *
 * departmentCompliance(viewerPersonId):
 *   - Returns departments where the viewer holds an ACTIVE DIRECTOR membership
 *     in the active term.
 *   - For each department: every ACTIVE membership (both DIRECTOR and VOLUNTEER
 *     kinds) with newest cert + computed status.
 *   - Members sorted: non-compliant first (NO_CERTIFICATE, EXPIRED, UNKNOWN_DATE,
 *     EXPIRING_SOON, COMPLIANT), then alphabetically by name within each bucket.
 *   - Status counts per department.
 *   - Viewer with no director memberships gets [].
 *   - Volunteer-only viewer gets [].
 *
 * verifyCertificate(actorPersonId, certId):
 *   - Stamps verifiedById + verifiedAt on the cert.
 *   - Audits compliance.verify with { certId, ownerPersonId }.
 *   - Re-verify updates the stamp.
 *   - Throws CertificateNotFoundError when cert does not exist.
 *   - Throws ComplianceForbiddenError when actor cannot view the certificate
 *     (cross-dept director: rejects, cert stays unverified, no audit row).
 *   - manage_compliance holder CAN verify cross-dept certificates.
 *   - Same-dept director CAN verify certificates of their department members.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  departmentCompliance,
  verifyCertificate,
  CertificateNotFoundError,
  ComplianceForbiddenError,
} from "./compliance";

// ---------------------------------------------------------------------------
// Helpers
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

/** Create a certificate with a given completionDate (in days offset from 2025-01-01). */
async function createCert(
  personId: string,
  completionDate: Date | null,
  uploadedAt?: Date
) {
  const id = `cert-${Math.random().toString(36).slice(2)}`;
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "test.pdf",
      storedName: `${id}.pdf`,
      size: 100,
      mimeType: "application/pdf",
      completionDate,
      uploadedAt: uploadedAt ?? new Date(),
    },
  });
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

function noon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

async function grantPermission(personId: string, permission: string) {
  const role = await prisma.role.create({
    data: {
      name: `Role-${permission}-${Date.now()}`,
      isSystem: false,
      grants: { create: [{ permission }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId, termId: null } });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// departmentCompliance
// ---------------------------------------------------------------------------

describe("departmentCompliance", () => {
  it("returns empty array when viewer has no director memberships", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Volunteer", "vol001");
    await createMembership(viewer.id, term.id, dept.id, "VOLUNTEER");

    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when there is no active term", async () => {
    await createTerm("ARCHIVED");
    const viewer = await createPerson("Director", "dir001");
    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when viewer has only a REMOVED directorship", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR", "REMOVED");

    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(0);
  });

  it("scopes to departments where the viewer is an ACTIVE DIRECTOR", async () => {
    const term = await createTerm();
    const itcm = await createDepartment("ITCM");
    const srr = await createDepartment("SRR");
    const viewer = await createPerson("Director", "dir001");

    // Only ITCM director
    await createMembership(viewer.id, term.id, itcm.id, "DIRECTOR");
    const other = await createPerson("Member", "mem001");
    await createMembership(other.id, term.id, srr.id, "VOLUNTEER");

    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(1);
    expect(result[0].department.code).toBe("ITCM");
  });

  it("includes members of both DIRECTOR and VOLUNTEER kinds", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const otherDir = await createPerson("OtherDir", "dir002");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(otherDir.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(1);
    // All 3 people in the department (viewer + otherDir + vol)
    expect(result[0].members).toHaveLength(3);
    const names = result[0].members.map((m) => m.person.name);
    expect(names).toContain("Director");
    expect(names).toContain("OtherDir");
    expect(names).toContain("Volunteer");
  });

  it("excludes REMOVED memberships from member list", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const removed = await createPerson("Removed", "rem001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(removed.id, term.id, dept.id, "VOLUNTEER", "REMOVED");

    const result = await departmentCompliance(viewer.id);
    expect(result[0].members).toHaveLength(1); // only the viewer/director
  });

  it("picks the newest certificate per person", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const oldDate = noon(2024, 1, 1);
    const newDate = noon(2025, 6, 1);

    await createCert(vol.id, oldDate, new Date("2024-01-01T12:00:00Z"));
    const newest = await createCert(vol.id, newDate, new Date("2025-06-01T12:00:00Z"));

    const result = await departmentCompliance(viewer.id);
    const volMember = result[0].members.find((m) => m.person.id === vol.id);
    expect(volMember?.cert?.id).toBe(newest.id);
    expect(volMember?.cert?.completionDate).toEqual(newDate);
  });

  it("resolves verifiedByName from Person and returns null when unverified", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");
    const verifier = await createPerson("Alice Verifier", "alv001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const cert = await createCert(vol.id, noon(2026, 1, 1));
    // Stamp the cert as verified by the verifier person
    await prisma.hipaaCertificate.update({
      where: { id: cert.id },
      data: { verifiedById: verifier.id, verifiedAt: new Date() },
    });

    const result = await departmentCompliance(viewer.id);
    const volMember = result[0].members.find((m) => m.person.id === vol.id);
    // verifiedByName should resolve to the verifier's real name
    expect(volMember?.verifiedByName).toBe("Alice Verifier");

    // Viewer has no cert, so verifiedByName should be null
    const viewerMember = result[0].members.find((m) => m.person.id === viewer.id);
    expect(viewerMember?.verifiedByName).toBeNull();
  });

  it("assigns NO_CERTIFICATE status when person has no cert", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");

    const result = await departmentCompliance(viewer.id);
    const volMember = result[0].members.find((m) => m.person.id === vol.id);
    expect(volMember?.status).toBe("NO_CERTIFICATE");
    expect(volMember?.cert).toBeNull();
  });

  it("assigns UNKNOWN_DATE when cert has no completionDate", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    await createCert(vol.id, null);

    const result = await departmentCompliance(viewer.id);
    const volMember = result[0].members.find((m) => m.person.id === vol.id);
    expect(volMember?.status).toBe("UNKNOWN_DATE");
  });

  it("assigns COMPLIANT status when cert is within validity and covers term bar", async () => {
    // term ends 2026-09-26; bar = term end + 30d = 2026-10-26
    // cert completion 2026-01-01 => expires 2027-01-01 (covers the bar)
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");
    const vol = await createPerson("Volunteer", "vol001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");
    await createMembership(vol.id, term.id, dept.id, "VOLUNTEER");
    // completionDate 2026-01-01 => expires 2027-01-01, covers term end 2026-09-26 + 30d
    await createCert(vol.id, noon(2026, 1, 1));

    const result = await departmentCompliance(viewer.id);
    const volMember = result[0].members.find((m) => m.person.id === vol.id);
    expect(volMember?.status).toBe("COMPLIANT");
  });

  it("members are sorted by status priority then name", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Alice Director", "dir001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");

    // Create members in various status states
    const compliant = await createPerson("Zara Compliant", "zara01");
    const expiring = await createPerson("Bob Expiring", "bob01");
    const noCert = await createPerson("Alice NoCert", "anc01");
    const expired = await createPerson("Charlie Expired", "che01");

    await createMembership(compliant.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(expiring.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(noCert.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(expired.id, term.id, dept.id, "VOLUNTEER");

    // compliant: cert expires 2027-01-01, covers term end + 30d
    await createCert(compliant.id, noon(2026, 1, 1));
    // expiring: cert expires soon but not expired (within 60d of now)
    await createCert(expiring.id, daysFromNow(-305)); // 365 - 305 = 60d left
    // noCert: no cert
    // expired: cert already expired
    await createCert(expired.id, daysFromNow(-400)); // expired 35 days ago

    const result = await departmentCompliance(viewer.id);
    const statuses = result[0].members.map((m) => m.status);

    // NO_CERTIFICATE comes first, then EXPIRED, then EXPIRING_SOON, then COMPLIANT
    // (viewer Alice has no cert => NO_CERTIFICATE; noCert Alice also NO_CERT)
    expect(statuses.indexOf("NO_CERTIFICATE")).toBeLessThan(statuses.indexOf("COMPLIANT"));
    expect(statuses.indexOf("EXPIRED")).toBeLessThan(statuses.indexOf("COMPLIANT"));
    expect(statuses.indexOf("EXPIRING_SOON")).toBeLessThan(statuses.indexOf("COMPLIANT"));
  });

  it("computes correct status counts", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");
    const viewer = await createPerson("Director", "dir001");

    await createMembership(viewer.id, term.id, dept.id, "DIRECTOR");

    const vol1 = await createPerson("Vol1", "vol001");
    const vol2 = await createPerson("Vol2", "vol002");
    await createMembership(vol1.id, term.id, dept.id, "VOLUNTEER");
    await createMembership(vol2.id, term.id, dept.id, "VOLUNTEER");

    // vol1: compliant
    await createCert(vol1.id, noon(2026, 1, 1));
    // vol2: no cert
    // viewer: no cert

    const result = await departmentCompliance(viewer.id);
    const counts = result[0].counts;
    expect(counts.COMPLIANT).toBe(1);
    expect(counts.NO_CERTIFICATE).toBe(2); // viewer + vol2
    expect(counts.EXPIRED).toBe(0);
    expect(counts.EXPIRING_SOON).toBe(0);
    expect(counts.UNKNOWN_DATE).toBe(0);
  });

  it("handles viewer directing multiple departments independently", async () => {
    const term = await createTerm();
    const itcm = await createDepartment("ITCM");
    const srr = await createDepartment("SRR");
    const viewer = await createPerson("Director", "dir001");

    await createMembership(viewer.id, term.id, itcm.id, "DIRECTOR");
    await createMembership(viewer.id, term.id, srr.id, "DIRECTOR");

    const result = await departmentCompliance(viewer.id);
    expect(result).toHaveLength(2);
    const codes = result.map((r) => r.department.code).sort();
    expect(codes).toEqual(["ITCM", "SRR"]);
  });
});

// ---------------------------------------------------------------------------
// verifyCertificate
// ---------------------------------------------------------------------------

describe("verifyCertificate", () => {
  it("stamps verifiedById and verifiedAt on the certificate", async () => {
    const actor = await createPerson("Director", "dir001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, noon(2025, 6, 1));

    const before = new Date();
    await verifyCertificate(actor.id, cert.id);
    const after = new Date();

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({
      where: { id: cert.id },
    });
    expect(updated.verifiedById).toBe(actor.id);
    expect(updated.verifiedAt).not.toBeNull();
    expect(updated.verifiedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updated.verifiedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("creates an audit log entry with compliance.verify action", async () => {
    const actor = await createPerson("Director", "dir001");
    await grantPermission(actor.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, noon(2025, 6, 1));

    await verifyCertificate(actor.id, cert.id);

    const log = await prisma.auditLog.findFirst({
      where: { action: "compliance.verify", entityId: cert.id },
    });
    expect(log).not.toBeNull();
    expect(log?.actorPersonId).toBe(actor.id);
    // The after field includes certId and ownerPersonId
    const afterData = log?.after as Record<string, unknown>;
    expect(afterData.certId).toBe(cert.id);
    expect(afterData.ownerPersonId).toBe(owner.id);
  });

  it("re-verify updates the stamp rather than failing", async () => {
    const actor1 = await createPerson("Director1", "dir001");
    await grantPermission(actor1.id, "volunteers.manage_compliance");
    const actor2 = await createPerson("Director2", "dir002");
    await grantPermission(actor2.id, "volunteers.manage_compliance");
    const owner = await createPerson("Volunteer", "vol001");
    const cert = await createCert(owner.id, noon(2025, 6, 1));

    await verifyCertificate(actor1.id, cert.id);

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    await verifyCertificate(actor2.id, cert.id);

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({
      where: { id: cert.id },
    });
    // Should now be stamped by actor2
    expect(updated.verifiedById).toBe(actor2.id);
  });

  it("throws CertificateNotFoundError when cert does not exist", async () => {
    // The existence check fires before the scope check, so no permissions needed.
    const actor = await createPerson("Director", "dir001");

    await expect(verifyCertificate(actor.id, "nonexistent-id")).rejects.toBeInstanceOf(
      CertificateNotFoundError
    );
  });

  it("CertificateNotFoundError has the expected name", async () => {
    const actor = await createPerson("Director", "dir001");

    try {
      await verifyCertificate(actor.id, "nonexistent-id");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err instanceof CertificateNotFoundError).toBe(true);
      expect((err as CertificateNotFoundError).name).toBe("CertificateNotFoundError");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyCertificate - scope enforcement (IDOR fix)
// ---------------------------------------------------------------------------

describe("verifyCertificate scope enforcement", () => {
  it("throws ComplianceForbiddenError when a director from a different department tries to verify", async () => {
    // Set up two departments; actor directs deptA, owner is only in deptB.
    const term = await createTerm();
    const deptA = await createDepartment("ITCM");
    const deptB = await createDepartment("SRR");

    const actor = await createPerson("DirA", "dira01");
    const owner = await createPerson("VolB", "volb01");

    // actor has volunteers.view and is ACTIVE DIRECTOR in deptA only
    await grantPermission(actor.id, "volunteers.view");
    await createMembership(actor.id, term.id, deptA.id, "DIRECTOR");
    // owner is only a volunteer in deptB (not in actor's department)
    await createMembership(owner.id, term.id, deptB.id, "VOLUNTEER");

    const cert = await createCert(owner.id, noon(2025, 6, 1));

    // Must reject with ComplianceForbiddenError
    await expect(verifyCertificate(actor.id, cert.id)).rejects.toBeInstanceOf(
      ComplianceForbiddenError
    );

    // Cert must remain unverified
    const unchanged = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(unchanged.verifiedById).toBeNull();
    expect(unchanged.verifiedAt).toBeNull();

    // No audit row must have been written
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "compliance.verify", entityId: cert.id },
    });
    expect(auditRow).toBeNull();
  });

  it("allows a manage_compliance holder to verify a certificate in a department they do not direct", async () => {
    const term = await createTerm();
    const dept = await createDepartment("SRR");

    const actor = await createPerson("Compliance Manager", "cmgr01");
    const owner = await createPerson("VolSRR", "vsrr01");

    // actor has manage_compliance but is NOT a director or member of dept
    await grantPermission(actor.id, "volunteers.manage_compliance");
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER");

    const cert = await createCert(owner.id, noon(2025, 6, 1));

    // Must succeed without throwing
    await expect(verifyCertificate(actor.id, cert.id)).resolves.toBeUndefined();

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.verifiedById).toBe(actor.id);
  });

  it("allows a same-department director to verify a member's certificate", async () => {
    const term = await createTerm();
    const dept = await createDepartment("ITCM");

    const actor = await createPerson("DirITCM", "ditcm01");
    const owner = await createPerson("VolITCM", "vitcm01");

    await grantPermission(actor.id, "volunteers.view");
    await createMembership(actor.id, term.id, dept.id, "DIRECTOR");
    await createMembership(owner.id, term.id, dept.id, "VOLUNTEER");

    const cert = await createCert(owner.id, noon(2025, 6, 1));

    await expect(verifyCertificate(actor.id, cert.id)).resolves.toBeUndefined();

    const updated = await prisma.hipaaCertificate.findUniqueOrThrow({ where: { id: cert.id } });
    expect(updated.verifiedById).toBe(actor.id);
  });
});
