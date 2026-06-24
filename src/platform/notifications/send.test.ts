// src/platform/notifications/send.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { queueTeamsMessage, drainTeamsQueue, TEAMS_MAX_ATTEMPTS } from "./send";
import type { TeamsTransport } from "./teams-transport";

const baseInput = {
  type: "compliance-reminder",
  title: "HIPAA compliance reminder",
  summary: "Expiring soon.",
  link: "https://hub/compliance",
  bodyHtml: "<p>x</p>",
  fallbackSubject: "HIPAA compliance reminder",
  fallbackHtml: "<p>fallback</p>",
};

describe("queueTeamsMessage", () => {
  beforeEach(async () => await resetDb());

  it("creates a QUEUED row", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    expect(row.status).toBe("QUEUED");
  });
});

describe("drainTeamsQueue", () => {
  beforeEach(async () => await resetDb());

  it("sends a queued message and marks it SENT, caching the chat id", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    const transport: TeamsTransport = {
      send: vi.fn().mockResolvedValue({ chatId: "chat-9" }),
    };
    const n = await drainTeamsQueue(transport);
    expect(n).toBe(1);
    const row = await prisma.teamsMessage.findFirst({ where: { personId: p.id } });
    expect(row?.status).toBe("SENT");
    expect(row?.chatId).toBe("chat-9");
  });

  it("requeues on transient failure until max attempts", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    // Pre-age the row to one attempt below the max.
    await prisma.teamsMessage.update({
      where: { id: row.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 2 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 500")),
    };
    await drainTeamsQueue(transport);
    const after1 = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after1?.status).toBe("QUEUED");
    expect(after1?.attempts).toBe(TEAMS_MAX_ATTEMPTS - 1);
  });

  it("falls back to email when a send fails permanently", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    await prisma.teamsMessage.update({
      where: { id: row.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 1 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 500")),
    };
    await drainTeamsQueue(transport);
    const after = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("FALLBACK");
    const email = await prisma.emailLog.findFirst({ where: { personId: p.id } });
    expect(email?.toEmail).toBe("sam@x.com");
    expect(email?.subject).toBe("HIPAA compliance reminder");
  });
});
