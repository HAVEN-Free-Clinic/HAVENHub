import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";

beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;

async function person(name: string, email: string | null, status: "ACTIVE" | "OFFBOARDED" = "ACTIVE") {
  return prisma.person.create({ data: { name, contactEmail: email, status } });
}

async function cert(
  personId: string,
  completionDate: Date | null,
  // Dated certs default to verified so they resolve to their date-based status;
  // pass null to exercise the awaiting-verification gate.
  verifiedAt: Date | null = completionDate ? new Date() : null,
) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
      verifiedAt,
    },
  });
}

describe("resolveAudience (PERSON)", () => {
  it("returns recipients matching the where and excludes blank emails", async () => {
    await person("Active One", "one@example.com", "ACTIVE");
    await person("Active NoEmail", null, "ACTIVE");
    await person("Offboarded", "off@example.com", "OFFBOARDED");

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual(["one@example.com"]);
    expect(res.excludedNoEmail).toBe(1);
    expect(res.recipients[0].variables).toEqual({ firstName: "Active", name: "Active One" });
    expect(res.recipients[0].recordType).toBe("PERSON");
  });

  it("empty conditions resolve to zero recipients", async () => {
    await person("Someone", "s@example.com");
    const res = await resolveAudience({ recordType: "PERSON", match: "ALL", conditions: [] });
    expect(res.recipients).toEqual([]);
  });
});

describe("resolveAudience compliance status (issue #72)", () => {
  // No active term is created, so the term bar is absent and a certificate is
  // COMPLIANT iff it expires more than 60 days from now.
  it("COMPLIANT matches people whose live status is compliant", async () => {
    const now = Date.now();

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // expires now+335d -> COMPLIANT

    const expired = await person("Expired", "expired@example.com");
    await cert(expired.id, new Date(now - 400 * DAY)); // expires now-35d -> EXPIRED

    await person("No Cert", "nocert@example.com"); // NO_CERTIFICATE

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["COMPLIANT"] }],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["compliant@example.com"]);
  });

  it("matches derived statuses even when no ComplianceReminder rows exist", async () => {
    const now = Date.now();

    const expired = await person("Expired", "expired@example.com");
    await cert(expired.id, new Date(now - 400 * DAY)); // EXPIRED

    await person("No Cert", "nocert@example.com"); // NO_CERTIFICATE

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // COMPLIANT, excluded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["EXPIRED", "NO_CERTIFICATE"] }],
    });

    expect(res.recipients.map((r) => r.email).sort()).toEqual([
      "expired@example.com",
      "nocert@example.com",
    ]);
  });

  it("composes with other conditions (ALL)", async () => {
    const now = Date.now();

    const active = await person("Active Compliant", "active@example.com", "ACTIVE");
    await cert(active.id, new Date(now - 30 * DAY)); // COMPLIANT

    const offboarded = await person("Offboarded Compliant", "off@example.com", "OFFBOARDED");
    await cert(offboarded.id, new Date(now - 30 * DAY)); // COMPLIANT but offboarded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "complianceStatus", op: "in", value: ["COMPLIANT"] },
      ],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["active@example.com"]);
  });

  it("PENDING_VERIFICATION matches people with a dated but unverified cert", async () => {
    const now = Date.now();

    const pending = await person("Pending", "pending@example.com");
    // Date would otherwise read COMPLIANT, but no human has verified it.
    await cert(pending.id, new Date(now - 30 * DAY), null);

    const compliant = await person("Compliant", "compliant@example.com");
    await cert(compliant.id, new Date(now - 30 * DAY)); // verified -> COMPLIANT, excluded

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "complianceStatus", op: "in", value: ["PENDING_VERIFICATION"] }],
    });

    expect(res.recipients.map((r) => r.email)).toEqual(["pending@example.com"]);
  });
});

describe("resolveAudience clearance + nested groups", () => {
  async function activeTerm() {
    return prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01"),
        endDate: new Date("2026-09-26"),
        status: "ACTIVE",
      },
    });
  }

  it("isCleared=true matches fully-cleared active-term members", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });

    const cleared = await prisma.person.create({
      data: { name: "Cleared", contactEmail: "cleared@x.edu", phone: "555-1", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: cleared.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    await cert(cleared.id, new Date()); // valid + verified -> COMPLIANT

    const notCleared = await prisma.person.create({
      data: { name: "NotCleared", contactEmail: "notcleared@x.edu", phone: "555-2", status: "ACTIVE" },
    });
    await prisma.termMembership.create({
      data: { personId: notCleared.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    // no cert -> HIPAA incomplete -> not cleared

    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ALL",
      conditions: [{ field: "isCleared", op: "isTrue" }],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["cleared@x.edu"]);
  });

  it("resolves a nested group (ANY of a plain condition OR a nested ALL group)", async () => {
    const term = await activeTerm();
    const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });

    const volRn = await prisma.person.create({
      data: { name: "Vol RN", contactEmail: "volrn@x.edu", status: "ACTIVE", licensedRN: true },
    });
    await prisma.termMembership.create({
      data: { personId: volRn.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const volNonRn = await prisma.person.create({
      data: { name: "Vol NonRN", contactEmail: "volnonrn@x.edu", status: "ACTIVE", licensedRN: false },
    });
    await prisma.termMembership.create({
      data: { personId: volNonRn.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });

    // ANY of: status=OFFBOARDED, OR (role=VOLUNTEER AND licensedRN). Only volRn qualifies.
    const res = await resolveAudience({
      recordType: "PERSON",
      match: "ANY",
      conditions: [
        { field: "status", op: "eq", value: "OFFBOARDED" },
        {
          match: "ALL",
          children: [
            { field: "role", op: "eq", value: "VOLUNTEER" },
            { field: "licensedRN", op: "isTrue" },
          ],
        },
      ],
    });
    expect(res.recipients.map((r) => r.email)).toEqual(["volrn@x.edu"]);
  });
});
