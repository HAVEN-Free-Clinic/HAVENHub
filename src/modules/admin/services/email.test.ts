import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ALLOWLIST THE SENDER TEST RESOLVES AGAINST, stated here rather than
 * borrowed.
 *
 * sendSenderTest exists to mirror what the drain would do with the same From, so
 * its cases are ROUTING cases: Maileroo signs it, Graph signs it, nothing signs
 * it. Which real domain falls in which bucket is a Maileroo dashboard state and
 * no business of this file.
 *
 * It borrowed that state anyway, with hfc.it@yale.edu as its Graph example, and
 * broke when Maileroo verified yale.edu on 2026-09-02 and the shipped row
 * flipped to maileroo: the test named for routing to Graph started routing to
 * Maileroo. Same coupling as the twelve fixed in the commit before this one, in
 * a directory that commit's verification globs did not cover.
 *
 * So the shapes are declared, on the RFC 2606 reserved `.example` TLD so they
 * can never quietly start meaning something about a real sending domain. The
 * unsignable case is declared by ABSENCE from this list, which is the same
 * statement made the only way an allowlist can make it.
 *
 * Set through SENDING_DOMAINS, the same override an operator pulls, so the real
 * chain still runs underneath: config.ts's format check, parseSendingDomains,
 * and the module-level map signingTransportFor reads. vitest.setup.ts re-claims
 * the variable before every test file, so this cannot leak into one that expects
 * the shipped default.
 */
const { MAILEROO_FROM, GRAPH_FROM, UNSIGNABLE_FROM, PINNED_SENDER } = vi.hoisted(() => {
  const MAILEROO_DOMAIN = "maileroo-signed.example";
  const GRAPH_DOMAIN = "graph-signed.example";
  process.env.SENDING_DOMAINS = `${MAILEROO_DOMAIN}:maileroo,${GRAPH_DOMAIN}:graph`;
  return {
    /** Signable by Maileroo, so the drain sends it AS ITSELF. */
    MAILEROO_FROM: `recruitment@${MAILEROO_DOMAIN}`,
    /** Signable only by Graph, so the drain routes it there. */
    GRAPH_FROM: `hfc.it@${GRAPH_DOMAIN}`,
    /** Deliberately on no row above: nothing can sign it, so it gets pinned. */
    UNSIGNABLE_FROM: "someone@unlisted.example",
    /** The global email.sender setting, which a pinned send leaves as. */
    PINNED_SENDER: `noreply@${MAILEROO_DOMAIN}`,
  };
});

import { config } from "@/platform/config";
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
        data: { key: "email.sender", value: PINNED_SENDER },
      });
      _resetSettingsCache();
    });

    /**
     * Set the Graph OAuth credentials for one test and restore them afterwards.
     *
     * Needed now that the Graph branch of the sender test is built through
     * resolveGraphSigner, the same factory the drain uses. vitest.setup.ts
     * claims every GRAPH_OAUTH_* name as "" so a local run cannot diverge from
     * CI, which is exactly the unconfigured state that factory refuses.
     */
    async function withGraphOAuth<T>(present: boolean, fn: () => Promise<T>): Promise<T> {
      const keys = [
        "GRAPH_OAUTH_TENANT_ID",
        "GRAPH_OAUTH_CLIENT_ID",
        "GRAPH_OAUTH_CLIENT_SECRET",
      ] as const;
      const mutable = config as unknown as Record<string, string | undefined>;
      const previous = keys.map((key) => mutable[key]);
      for (const key of keys) mutable[key] = present ? "configured" : "";
      try {
        return await fn();
      } finally {
        keys.forEach((key, i) => {
          mutable[key] = previous[i];
        });
      }
    }

    /** The singleton row that means "an admin has connected a Graph mailbox". */
    const connectMailbox = (account: string) =>
      prisma.mailCredential.create({ data: { id: "mailer", refreshToken: "rt", account } });

    it("tests a Maileroo-signable address AS ITSELF", async () => {
      const fetchMock = vi.fn(async () => mailerooOk());
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: MAILEROO_FROM },
        { fetchImpl: fetchMock as typeof fetch }
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
      expect(JSON.parse(String(init.body)).from.address).toBe(MAILEROO_FROM);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "email.sender_test" },
      });
      expect((audit.after as { sentAs: string }).sentAs).toBe(MAILEROO_FROM);
    });

    it("tests the pinned global sender for an address no transport can sign", async () => {
      const fetchMock = vi.fn(async () => mailerooOk());
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: UNSIGNABLE_FROM },
        { fetchImpl: fetchMock as typeof fetch }
      );
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
      expect(JSON.parse(String(init.body)).from.address).toBe(PINNED_SENDER);
      // And the audit records what actually left, not what was asked for. An
      // admin reading "sent as the address you typed" for a send that was pinned
      // would take the wrong reassurance from a green sender test.
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "email.sender_test" },
      });
      expect((audit.after as { sentAs: string }).sentAs).toBe(PINNED_SENDER);
    });

    it("tests the CONNECTED MAILBOX through Graph, since that is where the drain sends it", async () => {
      // The connected mailbox is Graph-routed with no list entry, so dropping
      // the mailbox argument here would send this test through Maileroo and
      // report on a send production does not make -- which is the one thing
      // this function exists to avoid. Its domain is Maileroo-signed and the
      // fixture pins no addresses at all, so nothing else can explain a Graph
      // result.
      await connectMailbox(MAILEROO_FROM);
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      await withGraphOAuth(true, () =>
        sendSenderTest(
          ACTOR,
          { toEmail: "me@yale.edu", fromEmail: MAILEROO_FROM },
          { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
        )
      );
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("graph.microsoft.com");
      expect(String(url)).toContain(encodeURIComponent(MAILEROO_FROM));
    });

    it("tests that same address through MAILEROO when no mailbox is connected", async () => {
      // The other polarity, and what makes the case above mean something: with
      // no credential row the address falls back to its domain, which is
      // Maileroo-signed, so it must NOT reach Graph.
      const fetchMock = vi.fn(async () => mailerooOk());
      await sendSenderTest(
        ACTOR,
        { toEmail: "me@yale.edu", fromEmail: MAILEROO_FROM },
        { fetchImpl: fetchMock as typeof fetch }
      );
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("smtp.maileroo.com");
    });

    it("tests a Graph-signable address through Graph, because that is where the drain sends it", async () => {
      await connectMailbox("hfc.it@yale.edu");
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      await withGraphOAuth(true, () =>
        sendSenderTest(
          ACTOR,
          { toEmail: "me@yale.edu", fromEmail: GRAPH_FROM },
          { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
        )
      );
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      // Graph's own endpoint, and the requested address as the sending mailbox:
      // the whole point of this case is that the address is tested AS ITSELF,
      // which is what makes it a Send-As check. Nothing routes to Graph in the
      // shipped default any more, so this case exists only because the fixture
      // above declares it, and it is what the SENDING_DOMAINS reversal lever
      // lands an operator in.
      expect(String(url)).toContain("graph.microsoft.com");
      expect(String(url)).toContain(encodeURIComponent(GRAPH_FROM));
    });

    // ---- The Graph preconditions, which the drain refuses on ---------------
    //
    // This branch used to build a bare GraphTransport, so an unconfigured
    // deployment got an opaque Entra 400 or "Mail account is not connected" --
    // neither of which points at the routing decision that put the address on
    // Graph. Both states are newly reachable without anyone editing
    // SENDING_DOMAINS, because GRAPH_SENDER_ADDRESSES routes by address.
    it("refuses routing-first when Graph has no OAuth credentials, instead of an Entra 400", async () => {
      await connectMailbox("hfc.it@yale.edu");
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      const err = await withGraphOAuth(false, () =>
        sendSenderTest(
          ACTOR,
          { toEmail: "me@yale.edu", fromEmail: GRAPH_FROM },
          { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
        ).catch((e) => e)
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Stop routing this From to Graph");
      expect((err as Error).message).toContain("GRAPH_OAUTH_TENANT_ID");
      // Refused before any request went out, so no admin reads a network error.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses routing-first when no Graph mailbox is connected", async () => {
      const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
      const err = await withGraphOAuth(true, () =>
        sendSenderTest(
          ACTOR,
          { toEmail: "me@yale.edu", fromEmail: GRAPH_FROM },
          { getAccessToken: () => Promise.resolve("tok"), fetchImpl: fetchMock as typeof fetch }
        ).catch((e) => e)
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("connect a mailbox in Admin > Email");
      expect((err as Error).message).not.toMatch(/Mail account is not connected/);
      expect(fetchMock).not.toHaveBeenCalled();
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
