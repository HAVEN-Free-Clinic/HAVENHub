import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { drainEmailQueue } from "@/platform/email/send";
import type { EmailTransport } from "@/platform/email/transport";

const failing: EmailTransport = {
  send: async () => {
    throw new Error("graph down");
  },
};

async function seedQueued(): Promise<string> {
  const row = await prisma.emailLog.create({
    data: { toEmail: "x@example.com", subject: "s", html: "<p>x</p>", template: "generic" },
  });
  return row.id;
}

describe("drainEmailQueue retry gate", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps a failed row locked and does not re-attempt it within the stale window", async () => {
    const id = await seedQueued();

    await drainEmailQueue(failing);
    const first = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(first.status).toBe("QUEUED");
    expect(first.attempts).toBe(1);
    expect(first.lockedAt).not.toBeNull(); // gate: lock retained on failure

    // Immediate second drain: the fresh lock makes the row unclaimable.
    await drainEmailQueue(failing);
    const second = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(second.attempts).toBe(1);

    // Age the lock past the 5-minute stale window; the row becomes retryable.
    await prisma.emailLog.update({
      where: { id },
      data: { lockedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    await drainEmailQueue(failing);
    const third = await prisma.emailLog.findUniqueOrThrow({ where: { id } });
    expect(third.attempts).toBe(2);
  });
});
