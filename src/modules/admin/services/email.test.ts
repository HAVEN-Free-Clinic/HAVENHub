import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listEmails,
  retryEmail,
  emailHealthCounts,
  EmailNotFoundError,
  EmailStateError,
} from "./email";

const ACTOR = "actor-person-id";

/** Seed a minimal EmailLog row. */
async function seedEmail(overrides: {
  toEmail?: string;
  subject?: string;
  template?: string;
  status?: "QUEUED" | "SENT" | "FAILED";
  sentAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
}) {
  return prisma.emailLog.create({
    data: {
      toEmail: overrides.toEmail ?? "test@example.com",
      subject: overrides.subject ?? "Test Subject",
      html: "<p>body</p>",
      template: overrides.template ?? "generic",
      status: overrides.status ?? "QUEUED",
      sentAt: overrides.sentAt ?? null,
      attempts: overrides.attempts ?? 0,
      lastError: overrides.lastError ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// listEmails
// ---------------------------------------------------------------------------

describe("listEmails - pagination and ordering", () => {
  beforeEach(resetDb);

  it("returns newest first with page size 25, and page 2 has the remainder", async () => {
    // Seed 26 rows with distinct createdAt ordering using raw inserts with
    // explicit timestamps to guarantee ordering determinism.
    for (let i = 0; i < 26; i++) {
      await prisma.emailLog.create({
        data: {
          toEmail: `user${i}@example.com`,
          subject: "Seed",
          html: "<p>x</p>",
          template: "generic",
          status: "QUEUED",
          // stagger creation times so ordering is deterministic
          createdAt: new Date(Date.now() + i * 1000),
        },
      });
    }

    const page1 = await listEmails({ page: 1 });
    expect(page1.rows).toHaveLength(25);
    expect(page1.total).toBe(26);

    const page2 = await listEmails({ page: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.total).toBe(26);
  });

  it("returns newest createdAt first on page 1", async () => {
    const old = await prisma.emailLog.create({
      data: {
        toEmail: "old@example.com",
        subject: "Old",
        html: "<p>x</p>",
        template: "generic",
        status: "QUEUED",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    const recent = await prisma.emailLog.create({
      data: {
        toEmail: "recent@example.com",
        subject: "Recent",
        html: "<p>x</p>",
        template: "generic",
        status: "QUEUED",
        createdAt: new Date("2025-06-01T00:00:00Z"),
      },
    });

    const result = await listEmails({});
    expect(result.rows[0].id).toBe(recent.id);
    expect(result.rows[1].id).toBe(old.id);
  });
});

describe("listEmails - filters", () => {
  beforeEach(resetDb);

  it("filters by status: only FAILED rows returned", async () => {
    await seedEmail({ status: "FAILED" });
    await seedEmail({ status: "SENT", sentAt: new Date() });
    await seedEmail({ status: "QUEUED" });

    const result = await listEmails({ status: "FAILED" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("FAILED");
    expect(result.total).toBe(1);
  });

  it("filters by template: exact match only", async () => {
    await seedEmail({ template: "compliance-reminder" });
    await seedEmail({ template: "compliance-reminder" });
    await seedEmail({ template: "welcome" });

    const result = await listEmails({ template: "compliance-reminder" });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.template === "compliance-reminder")).toBe(true);
  });

  it("filters by q: case-insensitive toEmail substring match", async () => {
    await seedEmail({ toEmail: "Alice@Example.COM" });
    await seedEmail({ toEmail: "bob@other.org" });
    await seedEmail({ toEmail: "alice2@somewhere.net" });

    const result = await listEmails({ q: "alice" });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("ignores q when q is empty string (returns all)", async () => {
    await seedEmail({ toEmail: "a@example.com" });
    await seedEmail({ toEmail: "b@example.com" });

    const result = await listEmails({ q: "" });
    expect(result.total).toBe(2);
  });

  it("counts field is global (not filtered): counts include all statuses even when status filter applied", async () => {
    await seedEmail({ status: "QUEUED" });
    await seedEmail({ status: "QUEUED" });
    await seedEmail({ status: "FAILED" });

    const result = await listEmails({ status: "FAILED" });
    // rows/total are filtered
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
    // counts are global
    expect(result.counts.queued).toBe(2);
    expect(result.counts.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// emailHealthCounts
// ---------------------------------------------------------------------------

describe("emailHealthCounts", () => {
  beforeEach(resetDb);

  it("returns exact queued, failed, and sentToday counts", async () => {
    const now = new Date("2026-06-08T15:00:00Z");
    const startOfToday = new Date(Date.UTC(2026, 5, 8)); // June 8 2026 00:00 UTC

    // 2 QUEUED
    await seedEmail({ status: "QUEUED" });
    await seedEmail({ status: "QUEUED" });

    // 1 FAILED
    await seedEmail({ status: "FAILED", attempts: 8 });

    // 2 SENT today (sentAt >= startOfToday)
    await seedEmail({
      status: "SENT",
      sentAt: new Date(startOfToday.getTime() + 3_600_000),
    });
    await seedEmail({
      status: "SENT",
      sentAt: new Date(startOfToday.getTime() + 7_200_000),
    });

    // 1 SENT yesterday (should NOT count toward sentToday)
    await seedEmail({
      status: "SENT",
      sentAt: new Date(startOfToday.getTime() - 1), // 1 ms before midnight UTC
    });

    const counts = await emailHealthCounts(now);
    expect(counts.queued).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.sentToday).toBe(2);
  });

  it("excludes a SENT row whose sentAt is before today UTC midnight", async () => {
    const now = new Date("2026-06-08T00:00:00Z");
    const startOfToday = new Date(Date.UTC(2026, 5, 8));

    await seedEmail({
      status: "SENT",
      sentAt: new Date(startOfToday.getTime() - 1000), // 1 second before midnight
    });

    const counts = await emailHealthCounts(now);
    expect(counts.sentToday).toBe(0);
  });

  it("returns zeros when the table is empty", async () => {
    const counts = await emailHealthCounts(new Date());
    expect(counts.queued).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.sentToday).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// retryEmail
// ---------------------------------------------------------------------------

describe("retryEmail", () => {
  beforeEach(resetDb);

  it("flips a FAILED row to QUEUED with attempts 0 and lastError null", async () => {
    const email = await seedEmail({
      status: "FAILED",
      attempts: 8,
      lastError: "connection refused",
    });

    await retryEmail(ACTOR, email.id);

    const updated = await prisma.emailLog.findUniqueOrThrow({ where: { id: email.id } });
    expect(updated.status).toBe("QUEUED");
    expect(updated.attempts).toBe(0);
    expect(updated.lastError).toBeNull();
  });

  it("writes an email.retry audit row with before/after snapshot", async () => {
    const email = await seedEmail({
      status: "FAILED",
      attempts: 5,
      lastError: "timeout",
    });

    await retryEmail(ACTOR, email.id);

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "email.retry", entityId: email.id },
    });
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0];
    expect(audit.actorPersonId).toBe(ACTOR);
    expect(audit.entityType).toBe("EmailLog");
    expect((audit.before as Record<string, unknown>).status).toBe("FAILED");
    expect((audit.before as Record<string, unknown>).attempts).toBe(5);
    expect((audit.after as Record<string, unknown>).status).toBe("QUEUED");
  });

  it("throws EmailStateError when retrying a SENT row", async () => {
    const email = await seedEmail({ status: "SENT", sentAt: new Date() });

    await expect(retryEmail(ACTOR, email.id)).rejects.toBeInstanceOf(EmailStateError);
  });

  it("throws EmailStateError when retrying a QUEUED row", async () => {
    const email = await seedEmail({ status: "QUEUED" });

    await expect(retryEmail(ACTOR, email.id)).rejects.toBeInstanceOf(EmailStateError);
  });

  it("throws EmailStateError with message 'Only failed emails can be retried.'", async () => {
    const email = await seedEmail({ status: "SENT", sentAt: new Date() });

    await expect(retryEmail(ACTOR, email.id)).rejects.toThrow(
      "Only failed emails can be retried."
    );
  });

  it("throws EmailNotFoundError when the id does not exist", async () => {
    await expect(retryEmail(ACTOR, "nonexistent-id")).rejects.toBeInstanceOf(
      EmailNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe("EmailNotFoundError", () => {
  it("is an instance of Error, carries the id, and has the correct name", () => {
    const err = new EmailNotFoundError("abc-123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EmailNotFoundError);
    expect(err.message).toContain("abc-123");
    expect(err.name).toBe("EmailNotFoundError");
  });
});

describe("EmailStateError", () => {
  it("is an instance of Error with the correct name", () => {
    const err = new EmailStateError("Only failed emails can be retried.");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EmailStateError);
    expect(err.message).toBe("Only failed emails can be retried.");
    expect(err.name).toBe("EmailStateError");
  });
});
