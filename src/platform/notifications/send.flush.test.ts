import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { drainTeamsQueue, queueTeamsMessage, flushTeamsQueue } from "@/platform/notifications/send";
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

async function seedPerson(): Promise<string> {
  const person = await prisma.person.create({
    data: { name: "T2", status: "ACTIVE", entraObjectId: "entra-2", contactEmail: "t2@example.com" },
  });
  return person.id;
}

const teamsInput = (personId: string) => ({
  personId,
  type: "generic",
  title: "t",
  summary: "s",
  bodyHtml: "<p>b</p>",
  fallbackSubject: "fs",
  fallbackHtml: "<p>fb</p>",
});

describe("teams fire-on-enqueue wiring", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("queueTeamsMessage does not deliver synchronously outside a request scope", async () => {
    const personId = await seedPerson();
    await queueTeamsMessage(prisma, teamsInput(personId));
    const row = await prisma.teamsMessage.findFirstOrThrow({ where: { personId } });
    expect(row.status).toBe("QUEUED");
  });

  it("flushTeamsQueue drains a queued message via the resolved transport", async () => {
    const personId = await seedPerson();
    await queueTeamsMessage(prisma, teamsInput(personId));
    await flushTeamsQueue();
    const row = await prisma.teamsMessage.findFirstOrThrow({ where: { personId } });
    // The log transport (EMAIL_TRANSPORT=log in tests) records LOGGED, not SENT.
    expect(row.status).toBe("LOGGED");
  });
});
