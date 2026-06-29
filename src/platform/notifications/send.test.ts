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
    expect(row?.sentAt).not.toBeNull();
  });

  it("marks the row LOGGED (not SENT) when the transport only logged", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    const transport: TeamsTransport = {
      send: vi.fn().mockResolvedValue({ chatId: "log-chat", logged: true }),
    };
    const n = await drainTeamsQueue(transport);
    expect(n).toBe(1);
    const row = await prisma.teamsMessage.findFirst({ where: { personId: p.id } });
    expect(row?.status).toBe("LOGGED");
    expect(row?.sentAt).toBeNull();
    // No email fallback for a logged (success) row.
    expect(await prisma.emailLog.count()).toBe(0);
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

  it("marks FALLBACK with 'not delivered' in lastError when person has no contactEmail", async () => {
    const p = await prisma.person.create({
      data: { name: "NoEmail", contactEmail: null, entraObjectId: "e-no-email" },
    });
    const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
    await prisma.teamsMessage.update({
      where: { id: row.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 1 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 503")),
    };
    await drainTeamsQueue(transport);
    const after = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("FALLBACK");
    const emailCount = await prisma.emailLog.count({ where: { personId: p.id } });
    expect(emailCount).toBe(0);
    expect(after?.lastError).toContain("not delivered");
  });

  // -------------------------------------------------------------------------
  // Issue #63: a single drain invocation must attempt each QUEUED row at most
  // once, even when the backlog exceeds one batch and every send fails. The
  // cron loop previously re-attempted requeued rows pass after pass within one
  // tick, burning the retry budget.
  // -------------------------------------------------------------------------

  it("attempts each queued message at most once per invocation when every send fails", async () => {
    // 27 rows > the default batch of 25 to exercise keyset paging.
    for (let i = 0; i < 27; i++) {
      const p = await prisma.person.create({
        data: { name: `P${i}`, contactEmail: `p${i}@x.com`, entraObjectId: `e${i}` },
      });
      const row = await queueTeamsMessage(prisma, { personId: p.id, ...baseInput });
      await prisma.teamsMessage.update({
        where: { id: row.id },
        data: { createdAt: new Date(Date.now() + i * 1000) },
      });
    }
    const send = vi.fn().mockRejectedValue(new Error("graph 500"));
    const transport: TeamsTransport = { send };

    await drainTeamsQueue(transport);

    // Every row attempted exactly once: one send call each, attempts == 1, all
    // requeued (none prematurely escalated to FALLBACK).
    expect(send).toHaveBeenCalledTimes(27);
    const rows = await prisma.teamsMessage.findMany();
    expect(rows).toHaveLength(27);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.status).toBe("QUEUED");
    }
  });

  // Issue #74: a "both" Teams message records that its email was already queued
  // up front. On permanent failure the drain must NOT queue the fallback again,
  // and lastError must not claim the message was undelivered (it was, by email).
  it("skips the fallback email on permanent failure when emailAlreadyQueued is set", async () => {
    const p = await prisma.person.create({
      data: { name: "Sam", contactEmail: "sam@x.com", entraObjectId: "e1" },
    });
    const row = await queueTeamsMessage(prisma, {
      personId: p.id,
      ...baseInput,
      emailAlreadyQueued: true,
    });
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
    // No duplicate email, and the error is the raw Teams failure (not "not delivered").
    expect(await prisma.emailLog.count({ where: { personId: p.id } })).toBe(0);
    expect(after?.lastError).toBe("graph 500");
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
