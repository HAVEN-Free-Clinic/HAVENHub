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
 * All assertions use EmailLog.template to distinguish one stream's rows from another's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { runComplianceReminders } from "./reminders";
import * as channel from "@/platform/notifications/channel";

// resolveChannel is spied per-test (the Teams-routing cases). runComplianceReminders
// now reads the channel itself, so a leaked spy would mis-route later tests. Restore
// after every test to keep them isolated.
afterEach(() => {
  vi.restoreAllMocks();
});

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
  // Default a phone so a person WITH a contactEmail has a complete profile: full
  // clearance now requires profile (contactEmail + phone), and these fixtures test
  // HIPAA/EHS state, not the profile gap (which is covered by its own test).
  return prisma.person.create({ data: { name, contactEmail, phone: "555-0000", status } });
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
      // Auto-verify so tests keep their intended EXPIRED / EXPIRING_SOON /
      // COMPLIANT status under the PENDING_VERIFICATION gate.
      verifiedAt: completionDate !== null ? new Date() : null,
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

describe("no active term", () => {
  it("returns all-zero result and sends no emails", async () => {
    const result = await runComplianceReminders(NOW);
    expect(result).toEqual({ remindersSent: 0, reset: 0, skipped: 0 });
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
    expect(result.reset).toBe(0);
    expect(result.skipped).toBe(0);

    expect(await emailLogCount("compliance-reminder")).toBe(1);

    const row = await getReminderRow(person.id);
    expect(row).not.toBeNull();
    expect(row!.remindersSent).toBe(1);
    expect(row!.lastRemindedAt).not.toBeNull();
    expect(row!.lastStatus).toBe("EXPIRED");
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
    // No new email after reset
    expect(await emailLogCount("compliance-reminder")).toBe(emailsBefore);

    const row = await getReminderRow(person.id);
    expect(row!.remindersSent).toBe(0);
    expect(row!.lastRemindedAt).toBeNull();
    expect(row!.lastStatus).toBeNull();
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

// ---------------------------------------------------------------------------
// Teams channel routing for compliance reminder
// ---------------------------------------------------------------------------

describe("Teams channel routing", () => {
  it("queues a Teams message for the reminder when the type routes to teams", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");

    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    // Create person with entraObjectId so Teams identity can be resolved
    const person = await createPerson("Teams Volunteer", "teams-vol@example.com");
    // Update the person to set entraObjectId (createPerson helper does not set it)
    await prisma.person.update({
      where: { id: person.id },
      data: { entraObjectId: "e-vol" },
    });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    await runComplianceReminders(NOW);

    const teams = await prisma.teamsMessage.findFirst({ where: { type: "compliance-reminder" } });
    expect(teams).not.toBeNull();
    expect(teams?.title).toBe("Compliance reminder");
  });

  // #132: under the shipped default channel ("email"), notify() queues nothing
  // for a Teams-only member (entraObjectId set, contactEmail null). The old guard
  // still admitted, claimed, counted, and escalated them -- a member contacted on
  // no channel looked "reminded". They must now be skipped instead.
  it("skips a Teams-only member (no contactEmail) when the channel is email, without claiming or counting", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("email");

    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Teams-only Volunteer", null); // no contactEmail
    await prisma.person.update({
      where: { id: person.id },
      data: { entraObjectId: "e-teamsonly" },
    });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.remindersSent).toBe(0);
    // Nothing was queued on any channel, and no reminder-state row was created.
    expect(await emailLogCount("compliance-reminder")).toBe(0);
    expect(await prisma.teamsMessage.count({ where: { type: "compliance-reminder" } })).toBe(0);
    expect(await getReminderRow(person.id)).toBeNull();
  });

  it("reminds a Teams-only member (no contactEmail) when the channel is teams", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");

    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Teams-only Reachable", null); // no contactEmail
    await prisma.person.update({
      where: { id: person.id },
      data: { entraObjectId: "e-reachable" },
    });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, EXPIRED_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(1);
    const teams = await prisma.teamsMessage.findFirst({ where: { type: "compliance-reminder" } });
    expect(teams).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HIPAA-compliant person with an EHS gap still receives a compliance-reminder
// ---------------------------------------------------------------------------

describe("EHS gap reminder", () => {
  it("sends a compliance-reminder to a HIPAA-compliant person who has a missing EHS training", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("EHS Gap Volunteer", "ehsgap@example.com");
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    // Give them a valid (COMPLIANT) HIPAA cert
    await addCert(person.id, COMPLIANT_COMPLETION);

    // Create an active EHS training required for everyone that they have NOT completed
    const { createTraining } = await import("@/platform/ehs/services/trainings");
    const actor = await prisma.person.create({ data: { name: "EHS Admin", status: "ACTIVE" } });
    await createTraining({ name: "BBP Clinical", requiredForAll: true }, actor.id);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(1);
    const emailCount = await emailLogCount("compliance-reminder");
    expect(emailCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HIPAA-compliant person with an incomplete profile still receives a reminder
// (full-clearance coverage: the reminder now spans profile/training/learning too)
// ---------------------------------------------------------------------------

describe("profile gap reminder", () => {
  it("sends a compliance-reminder to a HIPAA-compliant person whose profile is incomplete", async () => {
    const term = await createTerm();
    const dept = await createDepartment("PCAR");
    const person = await createPerson("Profile Gap Volunteer", "profilegap@example.com");
    // Clear the phone so the profile is incomplete (contactEmail present, phone missing).
    await prisma.person.update({ where: { id: person.id }, data: { phone: null } });
    await addMembership(person.id, term.id, dept.id, "VOLUNTEER");
    await addCert(person.id, COMPLIANT_COMPLETION);

    const result = await runComplianceReminders(NOW);

    expect(result.remindersSent).toBe(1);
    expect(await emailLogCount("compliance-reminder")).toBe(1);
  });
});
