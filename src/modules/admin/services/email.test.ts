import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import {
  listEmails,
  listEmailTemplates,
  retryEmail,
  retryAllFailedEmails,
  emailHealthCounts,
  sendSenderTest,
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
  createdAt?: Date;
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
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

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

  it("paginates deterministically when every row shares one createdAt (campaign fan-out tie)", async () => {
    // queueEmails writes a campaign fan-out via chunked createMany, so every row
    // gets one identical CURRENT_TIMESTAMP. Give 30 rows the exact same createdAt
    // and page through: with the (createdAt, id) tiebreaker the pages partition
    // the rows -- no id appears twice, none is dropped -- and each page is sorted
    // by id descending within the tie group.
    const tie = new Date("2026-05-01T00:00:00Z");
    for (let i = 0; i < 30; i++) {
      await seedEmail({ toEmail: `fanout${i}@example.com`, createdAt: tie });
    }

    const p1 = await listEmails({ page: 1 });
    const p2 = await listEmails({ page: 2 });
    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(5);

    const seen = [...p1.rows, ...p2.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(30); // no repeats across pages, nothing dropped

    // Within the tie group the order is a stable total order by id desc.
    const idsDesc = [...seen].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(seen).toEqual(idsDesc);
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
// listEmailTemplates (issue #99: filter options derived from logged values)
// ---------------------------------------------------------------------------

describe("listEmailTemplates", () => {
  beforeEach(resetDb);

  it("returns the distinct template values actually present, sorted", async () => {
    await seedEmail({ template: "recruitment.acceptance" });
    await seedEmail({ template: "recruitment.acceptance" });
    await seedEmail({ template: "campaign" });
    await seedEmail({ template: "compliance-reminder" });
    await seedEmail({ template: "epic-onboarding" });

    const templates = await listEmailTemplates();

    expect(templates).toEqual([
      "campaign",
      "compliance-reminder",
      "epic-onboarding",
      "recruitment.acceptance",
    ]);
  });

  it("returns an empty array when the log is empty", async () => {
    expect(await listEmailTemplates()).toEqual([]);
  });
});

describe("emailHealthCounts", () => {
  beforeEach(resetDb);

  it("counts sentToday by the display-zone (default Eastern) day, not UTC", async () => {
    // 11:00 EDT on 2026-06-08. Eastern midnight today is 2026-06-08T04:00:00Z.
    const now = new Date("2026-06-08T15:00:00Z");

    // 2 QUEUED
    await seedEmail({ status: "QUEUED" });
    await seedEmail({ status: "QUEUED" });

    // 1 FAILED
    await seedEmail({ status: "FAILED", attempts: 8 });

    // 2 SENT clearly within Eastern "today" (after 04:00Z, before now).
    await seedEmail({ status: "SENT", sentAt: new Date("2026-06-08T12:00:00Z") });
    await seedEmail({ status: "SENT", sentAt: new Date("2026-06-08T13:00:00Z") });

    // SENT at 03:00Z = 2026-06-07 23:00 EDT -> yesterday in Eastern, though it is
    // still "today" in UTC. It must NOT count (this is the whole fix).
    await seedEmail({ status: "SENT", sentAt: new Date("2026-06-08T03:00:00Z") });

    const counts = await emailHealthCounts(now);
    expect(counts.queued).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.sentToday).toBe(2);
  });

  it("excludes a SENT row before Eastern midnight today", async () => {
    const now = new Date("2026-06-08T15:00:00Z"); // 11:00 EDT
    // 03:59Z = 2026-06-07 23:59 EDT -> before Eastern midnight (04:00Z) -> excluded.
    await seedEmail({ status: "SENT", sentAt: new Date("2026-06-08T03:59:00Z") });

    const counts = await emailHealthCounts(now);
    expect(counts.sentToday).toBe(0);
  });

  it("returns zeros when the table is empty", async () => {
    const counts = await emailHealthCounts(new Date());
    expect(counts.queued).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.retryableFailed).toBe(0);
    expect(counts.sentToday).toBe(0);
  });

  it("retryableFailed counts only recent failures while failed counts all of them", async () => {
    const now = new Date("2026-06-10T12:00:00Z");
    await seedEmail({ status: "FAILED", attempts: 8, createdAt: new Date("2026-06-09T12:00:00Z") }); // recent
    await seedEmail({ status: "FAILED", attempts: 8, createdAt: new Date("2026-06-01T12:00:00Z") }); // 9 days old

    const counts = await emailHealthCounts(now);
    expect(counts.failed).toBe(2); // standing health signal: every failure
    expect(counts.retryableFailed).toBe(1); // only what "Retry all" would send
  });
});

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

  it("clears a non-null lockedAt when retrying a FAILED row (defense in depth: retryEmail no longer depends on FAILED rows already carrying lockedAt: null)", async () => {
    const email = await prisma.emailLog.create({
      data: {
        toEmail: "locked@example.com",
        subject: "Locked",
        html: "<p>x</p>",
        template: "generic",
        status: "FAILED",
        attempts: 8,
        lockedAt: new Date(),
      },
    });

    await retryEmail(ACTOR, email.id);

    const updated = await prisma.emailLog.findUniqueOrThrow({ where: { id: email.id } });
    expect(updated.status).toBe("QUEUED");
    expect(updated.lockedAt).toBeNull();
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
// retryAllFailedEmails (issue #63: bulk recovery)
// ---------------------------------------------------------------------------

describe("retryAllFailedEmails", () => {
  beforeEach(resetDb);

  it("requeues every FAILED row and leaves SENT/QUEUED rows untouched", async () => {
    const f1 = await seedEmail({ status: "FAILED", attempts: 8, lastError: "boom" });
    const f2 = await seedEmail({ status: "FAILED", attempts: 8, lastError: "boom" });
    const sent = await seedEmail({ status: "SENT", sentAt: new Date() });
    const queued = await seedEmail({ status: "QUEUED" });

    const count = await retryAllFailedEmails(ACTOR);
    expect(count).toBe(2);

    for (const id of [f1.id, f2.id]) {
      const row = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("QUEUED");
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBeNull();
    }
    // Non-FAILED rows are not disturbed.
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("SENT");
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("QUEUED");
  });

  it("writes one email.retry_all audit row carrying the count", async () => {
    await seedEmail({ status: "FAILED", attempts: 8 });
    await seedEmail({ status: "FAILED", attempts: 8 });

    await retryAllFailedEmails(ACTOR);

    const audits = await prisma.auditLog.findMany({ where: { action: "email.retry_all" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorPersonId).toBe(ACTOR);
    expect(audits[0].entityType).toBe("EmailLog");
    expect((audits[0].after as Record<string, unknown>).count).toBe(2);
  });

  it("returns 0 and writes no audit when there are no FAILED rows", async () => {
    await seedEmail({ status: "QUEUED" });

    const count = await retryAllFailedEmails(ACTOR);
    expect(count).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "email.retry_all" } })).toBe(0);
  });

  it("only re-queues FAILED rows from the last 7 days, leaving older failures FAILED", async () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const recent = await seedEmail({
      status: "FAILED",
      attempts: 8,
      createdAt: new Date("2026-06-09T12:00:00Z"), // 1 day old -> retried
    });
    const stale = await seedEmail({
      status: "FAILED",
      attempts: 8,
      createdAt: new Date("2026-06-01T12:00:00Z"), // 9 days old -> left alone
    });

    const count = await retryAllFailedEmails(ACTOR, now);
    expect(count).toBe(1);

    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe("QUEUED");
    // A months-late acceptance notice / expired magic link must not be re-blasted.
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
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

describe("sendSenderTest", () => {
  beforeEach(async () => {
    await resetDb();
    _resetSettingsCache();
  });

  it("in log mode it does not throw and records an audit entry", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await sendSenderTest("actor1", { toEmail: "me@yale.edu", fromEmail: "recruit@yale.edu" });
    } finally {
      spy.mockRestore();
    }
    const audit = await prisma.auditLog.findFirst({ where: { action: "email.sender_test" } });
    expect(audit).not.toBeNull();
  });

  // The sender test's only value is that it mirrors what a real send will do
  // with the same From. Under the allowlist that is no longer one answer per
  // transport setting, so these cover all three outcomes maileroo mode can now
  // produce. Asserted at both polarities on purpose: a test that only checked
  // the pinned case would pass against the old unconditional pin.
  describe("in maileroo mode it mirrors what the drain would do with the same From", () => {
    const mailerooOk = () =>
      new Response(JSON.stringify({ success: true, message: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    beforeEach(async () => {
      await prisma.setting.create({ data: { key: "email.transport", value: "maileroo" } });
      await prisma.setting.create({
        data: { key: "email.sender", value: "noreply@havenfreeclinic.org" },
      });
      _resetSettingsCache();
    });

    it("tests a Maileroo-signable address AS ITSELF", async () => {
      const fetchMock = vi.fn(async () => mailerooOk());
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: "recruitment@havenfreeclinic.org" },
        { fetchImpl: fetchMock as typeof fetch }
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
      expect(JSON.parse(String(init.body)).from.address).toBe("recruitment@havenfreeclinic.org");
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "email.sender_test" },
      });
      expect((audit.after as { sentAs: string }).sentAs).toBe("recruitment@havenfreeclinic.org");
    });

    it("tests the pinned global sender for an address no transport can sign", async () => {
      const fetchMock = vi.fn(async () => mailerooOk());
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: "someone@example.com" },
        { fetchImpl: fetchMock as typeof fetch }
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
      expect(JSON.parse(String(init.body)).from.address).toBe("noreply@havenfreeclinic.org");
    });

    it("tests a Graph-signable address through Graph, because that is where the drain sends it", async () => {
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: "hfc.it@yale.edu" },
        { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
      );
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("graph.microsoft.com");
      expect(String(url)).toContain(encodeURIComponent("hfc.it@yale.edu"));
    });
  });

  it("in graph mode it throws when Graph responds non-OK", async () => {
    await prisma.setting.create({ data: { key: "email.transport", value: "graph" } });
    _resetSettingsCache();
    const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      sendSenderTest(
        "actor1",
        { toEmail: "me@yale.edu", fromEmail: "recruit@yale.edu" },
        { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
      )
    ).rejects.toThrow(/403/);
  });
});
