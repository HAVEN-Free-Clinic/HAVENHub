import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { drainTeamsQueue } from "@/platform/notifications/send";
import type { TeamsTransport } from "@/platform/notifications/teams-transport";

const failing: TeamsTransport = {
  send: async () => {
    throw new Error("graph down");
  },
};

async function seedQueued(): Promise<string> {
  const person = await prisma.person.create({
    data: { name: "T", status: "ACTIVE", entraObjectId: "entra-1", contactEmail: "t@example.com" },
  });
  const row = await prisma.teamsMessage.create({
    data: {
      personId: person.id,
      type: "generic",
      title: "t",
      summary: "s",
      bodyHtml: "<p>b</p>",
      fallbackSubject: "fs",
      fallbackHtml: "<p>fb</p>",
    },
  });
  return row.id;
}

describe("drainTeamsQueue retry gate", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("keeps a failed row locked and does not re-attempt it within the stale window", async () => {
    const id = await seedQueued();

    await drainTeamsQueue(failing);
    const first = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(first.status).toBe("QUEUED");
    expect(first.attempts).toBe(1);
    expect(first.lockedAt).not.toBeNull();

    await drainTeamsQueue(failing);
    const second = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(second.attempts).toBe(1);

    await prisma.teamsMessage.update({
      where: { id },
      data: { lockedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    await drainTeamsQueue(failing);
    const third = await prisma.teamsMessage.findUniqueOrThrow({ where: { id } });
    expect(third.attempts).toBe(2);
  });
});
