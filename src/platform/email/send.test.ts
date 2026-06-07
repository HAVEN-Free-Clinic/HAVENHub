/**
 * Integration tests for queueEmail and drainEmailQueue.
 *
 * These tests run against the real test database (port 5434).
 * resetDb() truncates EmailLog (and all other tables) between tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { queueEmail, drainEmailQueue } from "./send";
import type { EmailTransport } from "./transport";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub transport whose send resolves immediately. */
function okTransport(): EmailTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(msg) {
      calls.push(msg.to);
    },
  };
}

/** Build a stub transport whose send always rejects with a given message. */
function failTransport(message = "boom"): EmailTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(msg) {
      calls.push(msg.to);
      throw new Error(message);
    },
  };
}

/** Build a stub transport that fails for the first recipient and succeeds for all others. */
function failFirstTransport(firstTo: string): EmailTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(msg) {
      calls.push(msg.to);
      if (msg.to === firstTo) throw new Error("first fails");
    },
  };
}

const BASE_EMAIL = {
  subject: "Hello",
  html: "<p>Hello</p>",
  template: "test-template",
};

// ---------------------------------------------------------------------------

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// queueEmail
// ---------------------------------------------------------------------------

describe("queueEmail", () => {
  it("inserts an EmailLog row with QUEUED status", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.toEmail).toBe("a@example.com");
    expect(row.subject).toBe("Hello");
    expect(row.html).toBe("<p>Hello</p>");
    expect(row.template).toBe("test-template");
    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);
    expect(row.sentAt).toBeNull();
  });

  it("stores optional personId and triggeredById", async () => {
    const person = await prisma.person.create({ data: { name: "Alice" } });
    const triggerer = await prisma.person.create({ data: { name: "Bob" } });
    await queueEmail(prisma, {
      ...BASE_EMAIL,
      to: "a@example.com",
      personId: person.id,
      triggeredById: triggerer.id,
    });
    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.personId).toBe(person.id);
    expect(row.triggeredById).toBe(triggerer.id);
  });

  it("leaves NO EmailLog row when the outer transaction rolls back", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await queueEmail(tx, { ...BASE_EMAIL, to: "rollback@example.com" });
        throw new Error("intentional rollback");
      })
    ).rejects.toThrow("intentional rollback");

    const count = await prisma.emailLog.count();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drainEmailQueue
// ---------------------------------------------------------------------------

describe("drainEmailQueue", () => {
  it("marks a QUEUED row SENT with sentAt set and returns 1", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    const transport = okTransport();

    const processed = await drainEmailQueue(transport);

    expect(processed).toBe(1);
    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.status).toBe("SENT");
    expect(row.sentAt).not.toBeNull();
    expect(transport.calls).toEqual(["a@example.com"]);
  });

  it("increments attempts and sets lastError when send fails, status stays QUEUED", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    const transport = failTransport("boom");

    await drainEmailQueue(transport);

    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("boom");
    expect(row.sentAt).toBeNull();
  });

  it("marks FAILED when attempts reaches MAX_ATTEMPTS (8)", async () => {
    // Pre-seed a row already at 7 attempts.
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    await prisma.emailLog.updateMany({ data: { attempts: 7 } });

    const transport = failTransport("boom");
    await drainEmailQueue(transport);

    const row = await prisma.emailLog.findFirstOrThrow();
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(8);
    expect(row.lastError).toBe("boom");
  });

  it("does not re-process SENT or FAILED rows, returns 0 on a second pass", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    const transport = okTransport();

    // First pass sends it.
    await drainEmailQueue(transport);
    // Second pass should find nothing QUEUED.
    const processed = await drainEmailQueue(transport);

    expect(processed).toBe(0);
    // send was called exactly once total.
    expect(transport.calls).toHaveLength(1);
  });

  it("returns the correct count for multiple queued rows", async () => {
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    await queueEmail(prisma, { ...BASE_EMAIL, to: "b@example.com" });
    await queueEmail(prisma, { ...BASE_EMAIL, to: "c@example.com" });

    const transport = okTransport();
    const processed = await drainEmailQueue(transport);

    expect(processed).toBe(3);
    expect(transport.calls).toHaveLength(3);
  });

  it("processes rows oldest-first", async () => {
    // Insert with a small delay so createdAt differs.
    await queueEmail(prisma, { ...BASE_EMAIL, to: "first@example.com" });
    // Force a later timestamp for the second row.
    await prisma.emailLog.updateMany({
      where: { toEmail: "first@example.com" },
      data: { createdAt: new Date("2020-01-01T00:00:00Z") },
    });
    await queueEmail(prisma, { ...BASE_EMAIL, to: "second@example.com" });
    await prisma.emailLog.updateMany({
      where: { toEmail: "second@example.com" },
      data: { createdAt: new Date("2020-01-02T00:00:00Z") },
    });

    const transport = okTransport();
    await drainEmailQueue(transport);

    expect(transport.calls).toEqual(["first@example.com", "second@example.com"]);
  });

  it("failure for one row does not prevent other rows from being sent", async () => {
    // Queue rows A, B, C with distinct addresses.
    await queueEmail(prisma, { ...BASE_EMAIL, to: "a@example.com" });
    await queueEmail(prisma, { ...BASE_EMAIL, to: "b@example.com" });
    await queueEmail(prisma, { ...BASE_EMAIL, to: "c@example.com" });

    // Transport that fails only for A, succeeds for everyone else.
    const transport = failFirstTransport("a@example.com");
    const processed = await drainEmailQueue(transport);

    // All three rows were attempted.
    expect(processed).toBe(3);
    expect(transport.calls).toHaveLength(3);
    expect(transport.calls).toContain("a@example.com");
    expect(transport.calls).toContain("b@example.com");
    expect(transport.calls).toContain("c@example.com");

    // B and C are SENT.
    const rowB = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "b@example.com" } });
    expect(rowB.status).toBe("SENT");
    expect(rowB.sentAt).not.toBeNull();

    const rowC = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "c@example.com" } });
    expect(rowC.status).toBe("SENT");
    expect(rowC.sentAt).not.toBeNull();

    // A is still QUEUED with attempts=1 and lastError set.
    const rowA = await prisma.emailLog.findFirstOrThrow({ where: { toEmail: "a@example.com" } });
    expect(rowA.status).toBe("QUEUED");
    expect(rowA.attempts).toBe(1);
    expect(rowA.lastError).toBe("first fails");
  });
});
