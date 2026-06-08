/**
 * Integration tests for the compliance reminder engine (runComplianceReminders).
 *
 * Each test resets the database and builds its own fixture set. The "now"
 * parameter is pinned so dedup windows and cert expiry are deterministic.
 *
 * Cert expiry math: certExpiresAt(completionDate) = completionDate + 365 days.
 * Term bar: cert must expire >= termEnd + 30 days to be COMPLIANT.
 * EXPIRING_SOON: valid today but fails term bar OR within 60d of expiry.
 * EXPIRED: expiresAt < now.
 *
 * All assertions use EmailLog.template to distinguish reminder vs escalation rows.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runComplianceReminders } from "./reminders";

// ---------------------------------------------------------------------------
// Reference "now" for all tests
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-01T12:00:00.000Z");

// certExpiresAt(completionDate) = completionDate + 365 days
// EXPIRED:  completionDate such that expiresAt < NOW
//           => completionDate < 2026-06-01 - 365d = 2025-06-01
//           => use 2025-01-01 (well expired)
const EXPIRED_COMPLETION = new Date("2025-01-01T12:00:00.000Z");

// EXPIRING_SOON: expiresAt is in [NOW, NOW+60d) -- fails 60d renewal window
// completionDate = 2026-06-01 - 365d + 30d = 2026-06-01 - 335d
// => use 2025-07-01 (expiresAt = 2026-06-30, which is 29d from NOW -- EXPIRING_SOON)
const EXPIRING_COMPLETION = new Date("2025-07-01T12:00:00.000Z");

// COMPLIANT: expiresAt >= termEnd+30d AND >= NOW+60d
// Term endDate = 2026-08-31; termEnd+30d = 2026-09-30
// Need completionDate such that expiresAt >= 2026-09-30
// => completionDate >= 2026-09-30 - 365d = 2025-09-30
// => use 2026-01-01 (expiresAt = 2027-01-01 -- well compliant)
const COMPLIANT_COMPLETION = new Date("2026-01-01T12:00:00.000Z");

// Interval = 7 days; mirrors config.COMPLIANCE_REMINDER_INTERVAL_DAYS default.
// Advance by 8 days to be past the window.
const INTERVAL_DAYS = 7;
const ADVANCE_DAYS = INTERVAL_DAYS + 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function advanceNow(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createTerm(endDate: Date = new Date("2026-08-31T00:00:00.000Z")) {
  return prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate,
      status: "ACTIVE",
    },
  });
}

async function createDepartment(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Department` },
  });
}

async function createPerson(
  name: string,
  contactEmail: string | null = null,
  status: "ACTIVE" | "OFFBOARDED" = "ACTIVE"
) {
  return prisma.person.create({ data: { name, contactEmail, status } });
}

async function addMembership(
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

async function addCert(personId: string, completionDate: Date | null) {
  return prisma.hipaaCertificate.create({
    data: {
      personId,
      fileName: "cert.pdf",
      storedName: "cert.pdf",
      size: 1000,
      mimeType: "application/pdf",
      completionDate,
    },
  });
}

async function emailLogCount(template: string): Promise<number> {
  return prisma.emailLog.count({ where: { template } });
}

async function getReminderRow(personId: string) {
  return prisma.complianceReminder.findUnique({ where: { personId } });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// No active term
// ---------------------------------------------------------------------------

describe("no active term", () => {
  it("returns all-zero result and sends no emails", async () => {
    const result = await runComplianceReminders(NOW);
    expect(result).toEqual({ remindersSent: 0, escalationsSent: 0, reset: 0, skipped: 0 });
    expect(await emailLogCount("compliance-reminder")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Person not in active term
// ---------------------------------------------------------------------------

describe("person with no active membership in active term", () => {
  it("is ignored - no row created, no email", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Ghost", "ghost@example.com");
    // membership is REMOVED, not ACTIVE
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER", "REMOVED");
    await addCert(person.id, EXPIRED_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(0);
    expect(await emailLogCount("compliance-reminder")).toBe(0);
    expect(await getReminderRow(person.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// First run - EXPIRED volunteer, no existing row
// ---------------------------------------------------------------------------

describe("first run - EXPIRED volunteer, no row", () => {
  it("creates compliance-reminder EmailLog, row with remindersSent=1, result.remindersSent=1", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(1);
    expect(result.escalationsSent).toBe(0);
    expect(result.reset).toBe(0);
    expect(result.skipped).toBe(0);

    expect(await emailLogCount("compliance-reminder")).toBe(1);

    const row = await getReminderRow(person.id);
    expect(row).not.toBeNull();
    expect(row!.remindersSent).toBe(1);
    expect(row!.lastRemindedAt).not.toBeNull();
    expect(row!.lastStatus).toBe("EXPIRED");
    expect(row!.escalatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Immediate second run - dedup window (skipped)
// ---------------------------------------------------------------------------

describe("immediate second run - within dedup window", () => {
  it("skips, no new EmailLog, row unchanged", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    await runComplianceReminders(NOW);
    // Run again immediately with the same "now"
    const result = await runComplianceReminders(NOW);

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.remindersSent).toBe(0);
    // Only 1 email total from both runs
    expect(await emailLogCount("compliance-reminder")).toBe(1);

    const row = await getReminderRow(person.id);
    expect(row!.remindersSent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Third run - past the interval window
// ---------------------------------------------------------------------------

describe("third run - now advanced past the interval", () => {
  it("sends another reminder, remindersSent becomes 2", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    await runComplianceReminders(NOW);
    const now2 = advanceNow(ADVANCE_DAYS);
    const result = await runComplianceReminders(now2);

    expect(result.remindersSent).toBe(1);
    expect(await emailLogCount("compliance-reminder")).toBe(2);

    const row = await getReminderRow(person.id);
    expect(row!.remindersSent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Escalation threshold reached on a past-interval run
// ---------------------------------------------------------------------------

describe("escalation at threshold", () => {
  it("sends escalation to director at remindersSent=3, then no second escalation on next run", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");

    const volunteer = await createPerson("Alice", "alice@example.com");
    const director = await createPerson("Director Bob", "bob@example.com");

    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(director.id, term.id, dept.id, "DIRECTOR");
    await addCert(volunteer.id, EXPIRED_COMPLETION);
    // Give the director a compliant cert so they are not a reminder candidate themselves.
    await addCert(director.id, COMPLIANT_COMPLETION);

    // Run 1: remindersSent=1 (no escalation; threshold is 3)
    await runComplianceReminders(NOW);
    // Run 2: remindersSent=2
    await runComplianceReminders(advanceNow(ADVANCE_DAYS));
    // Run 3: remindersSent=3 => threshold reached, escalation fires
    const r3 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 2));

    expect(r3.remindersSent).toBe(1);
    expect(r3.escalationsSent).toBe(1);

    expect(await emailLogCount("compliance-reminder")).toBe(3);
    expect(await emailLogCount("compliance-escalation")).toBe(1);

    const row = await getReminderRow(volunteer.id);
    expect(row!.remindersSent).toBe(3);
    expect(row!.escalatedAt).not.toBeNull();

    // Run 4: past-interval again. Another reminder is sent but NOT another escalation
    const r4 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 3));

    expect(r4.remindersSent).toBe(1);
    expect(r4.escalationsSent).toBe(0);

    expect(await emailLogCount("compliance-escalation")).toBe(1); // still only 1
    const row4 = await getReminderRow(volunteer.id);
    expect(row4!.remindersSent).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// COMPLIANT reset
// ---------------------------------------------------------------------------

describe("COMPLIANT reset", () => {
  it("resets row to zeroed state when person becomes compliant, no new EmailLog", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Alice", "alice@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    // Build up a non-zero reminder row
    await runComplianceReminders(NOW);
    const emailsBefore = await emailLogCount("compliance-reminder");
    expect(emailsBefore).toBe(1);

    // Swap in a compliant cert
    await prisma.hipaaCertificate.updateMany({
      where: { personId: person.id },
      data: { completionDate: COMPLIANT_COMPLETION },
    });

    const result = await runComplianceReminders(advanceNow(ADVANCE_DAYS));

    expect(result.reset).toBe(1);
    expect(result.remindersSent).toBe(0);
    expect(result.escalationsSent).toBe(0);
    // No new email after reset
    expect(await emailLogCount("compliance-reminder")).toBe(emailsBefore);

    const row = await getReminderRow(person.id);
    expect(row!.remindersSent).toBe(0);
    expect(row!.lastRemindedAt).toBeNull();
    expect(row!.lastStatus).toBeNull();
    expect(row!.escalatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NO_CERTIFICATE and UNKNOWN_DATE both trigger reminders
// ---------------------------------------------------------------------------

describe("NO_CERTIFICATE and UNKNOWN_DATE persons", () => {
  it("sends a compliance-reminder to each", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");

    const noCert = await createPerson("NoCert Person", "nocert@example.com");
    const unknownDate = await createPerson("UnknownDate Person", "unknown@example.com");

    await addMembership(noCert.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(unknownDate.id, term.id, dept.id, "VOLUNTEER");

    // unknownDate has a cert but completionDate is null
    await addCert(unknownDate.id, null);
    // noCert has no cert at all

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(2);
    expect(await emailLogCount("compliance-reminder")).toBe(2);

    const noCertRow = await getReminderRow(noCert.id);
    expect(noCertRow!.lastStatus).toBe("NO_CERTIFICATE");

    const unknownRow = await getReminderRow(unknownDate.id);
    expect(unknownRow!.lastStatus).toBe("UNKNOWN_DATE");
  });
});

// ---------------------------------------------------------------------------
// Person with no contactEmail is skipped
// ---------------------------------------------------------------------------

describe("person with no contactEmail", () => {
  it("is skipped, no row created, skipped counter incremented", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("NoEmail Person", null); // no contactEmail
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.remindersSent).toBe(0);
    expect(await emailLogCount("compliance-reminder")).toBe(0);
    // No row should be created for the no-email person
    expect(await getReminderRow(person.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Director escalation: excludes the volunteer themselves
// ---------------------------------------------------------------------------

describe("escalation excludes the volunteer when they are also a director", () => {
  it("does not send an escalation to the volunteer-director themselves", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");

    // person is both VOLUNTEER and DIRECTOR in the same dept
    const selfDirector = await createPerson("SelfDirector", "self@example.com");
    await addMembership(selfDirector.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(selfDirector.id, term.id, dept.id, "DIRECTOR");
    await addCert(selfDirector.id, EXPIRED_COMPLETION);

    // run 3 times to reach threshold
    await runComplianceReminders(NOW);
    await runComplianceReminders(advanceNow(ADVANCE_DAYS));
    const r3 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 2));

    // No escalation email should be sent because the only director IS the volunteer
    expect(r3.escalationsSent).toBe(0);
    expect(await emailLogCount("compliance-escalation")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Director escalation deduplication: director of two of volunteer's departments
// ---------------------------------------------------------------------------

describe("director who directs two of the volunteer's departments gets only one escalation email", () => {
  it("sends exactly one compliance-escalation to a shared director", async () => {
    const term = await createTerm();
    const deptA = await createDepartment("ANAT");
    const deptB = await createDepartment("BIOL");

    const volunteer = await createPerson("MultiDept Volunteer", "vol@example.com");
    const director = await createPerson("Shared Director", "dir@example.com");

    // volunteer is in BOTH departments
    await addMembership(volunteer.id, term.id, deptA.id, "VOLUNTEER");
    await addMembership(volunteer.id, term.id, deptB.id, "VOLUNTEER");

    // director directs BOTH departments
    await addMembership(director.id, term.id, deptA.id, "DIRECTOR");
    await addMembership(director.id, term.id, deptB.id, "DIRECTOR");

    await addCert(volunteer.id, EXPIRED_COMPLETION);
    // Give director a compliant cert so they are not a reminder candidate themselves.
    await addCert(director.id, COMPLIANT_COMPLETION);

    // Three runs to reach escalation threshold
    await runComplianceReminders(NOW);
    await runComplianceReminders(advanceNow(ADVANCE_DAYS));
    const r3 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 2));

    // Director is deduped to exactly 1 escalation email (not 2)
    expect(r3.escalationsSent).toBe(1);
    expect(await emailLogCount("compliance-escalation")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple directors in same department
// ---------------------------------------------------------------------------

describe("multiple directors in the volunteer's department", () => {
  it("sends one escalation email per director", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");

    const volunteer = await createPerson("Volunteer", "vol@example.com");
    const dir1 = await createPerson("Director One", "dir1@example.com");
    const dir2 = await createPerson("Director Two", "dir2@example.com");

    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(dir1.id, term.id, dept.id, "DIRECTOR");
    await addMembership(dir2.id, term.id, dept.id, "DIRECTOR");

    await addCert(volunteer.id, EXPIRED_COMPLETION);
    // Give directors compliant certs so they are not reminder candidates themselves.
    await addCert(dir1.id, COMPLIANT_COMPLETION);
    await addCert(dir2.id, COMPLIANT_COMPLETION);

    await runComplianceReminders(NOW);
    await runComplianceReminders(advanceNow(ADVANCE_DAYS));
    const r3 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 2));

    expect(r3.escalationsSent).toBe(2);
    expect(await emailLogCount("compliance-escalation")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Director without contactEmail is skipped in escalation
// ---------------------------------------------------------------------------

describe("director with no contactEmail", () => {
  it("is skipped in escalation, escalationsSent is 0", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");

    const volunteer = await createPerson("Volunteer", "vol@example.com");
    const director = await createPerson("No Email Director", null); // no contactEmail

    await addMembership(volunteer.id, term.id, dept.id, "VOLUNTEER");
    await addMembership(director.id, term.id, dept.id, "DIRECTOR");

    await addCert(volunteer.id, EXPIRED_COMPLETION);

    await runComplianceReminders(NOW);
    await runComplianceReminders(advanceNow(ADVANCE_DAYS));
    const r3 = await runComplianceReminders(advanceNow(ADVANCE_DAYS * 2));

    expect(r3.escalationsSent).toBe(0);
    expect(await emailLogCount("compliance-escalation")).toBe(0);

    // escalatedAt must be set even when no director email goes out: the threshold
    // was met and we attempted escalation, so the once-per-streak guard must fire.
    const row = await getReminderRow(volunteer.id);
    expect(row!.remindersSent).toBe(3);
    expect(row!.escalatedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMPLIANT person with no existing row: do nothing
// ---------------------------------------------------------------------------

describe("COMPLIANT person with no existing reminder row", () => {
  it("does nothing - no row, no email, no reset counted", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Compliant Person", "compliant@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(0);
    expect(result.reset).toBe(0);
    expect(result.skipped).toBe(0);
    expect(await emailLogCount("compliance-reminder")).toBe(0);
    expect(await getReminderRow(person.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMPLIANT person with a zeroed row: do nothing (no reset counted)
// ---------------------------------------------------------------------------

describe("COMPLIANT person with already-zeroed reminder row", () => {
  it("does not increment reset counter when row already zeroed", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Compliant Person", "compliant@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);

    // Create a zeroed reminder row manually
    await prisma.complianceReminder.create({
      data: {
        personId: person.id,
        remindersSent: 0,
        lastRemindedAt: null,
        lastStatus: null,
        escalatedAt: null,
      },
    });

    const result = await runComplianceReminders(NOW);

    expect(result.reset).toBe(0);
    expect(result.remindersSent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EXPIRING_SOON also triggers reminder
// ---------------------------------------------------------------------------

describe("EXPIRING_SOON person", () => {
  it("receives a compliance-reminder email", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Expiring Person", "expiring@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRING_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(1);
    const row = await getReminderRow(person.id);
    expect(row!.lastStatus).toBe("EXPIRING_SOON");
  });
});
