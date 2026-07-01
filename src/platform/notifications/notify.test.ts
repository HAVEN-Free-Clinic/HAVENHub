import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notify } from "./notify";
import { drainTeamsQueue, TEAMS_MAX_ATTEMPTS } from "./send";
import type { TeamsTransport } from "./teams-transport";
import * as channel from "./channel";

const email = { subject: "Subj", html: "<p>email</p>" };
const teams = { title: "Title", summary: "Summary", link: "https://hub/x" };

async function makePerson(over: Partial<{ entraObjectId: string | null; contactEmail: string | null }> = {}) {
  return prisma.person.create({
    data: {
      name: "Sam",
      contactEmail: over.contactEmail === undefined ? "sam@x.com" : over.contactEmail,
      entraObjectId: over.entraObjectId === undefined ? "e1" : over.entraObjectId,
    },
  });
}

describe("notify", () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  it("channel=email queues only an email", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("email");
    const p = await makePerson();
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(1);
    expect(await prisma.teamsMessage.count()).toBe(0);
  });

  it("channel=teams with an identity queues only a Teams message", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const p = await makePerson({ entraObjectId: "e1" });
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(0);
    expect(await prisma.teamsMessage.count()).toBe(1);
  });

  it("channel=both queues an email and a Teams message", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("both");
    const p = await makePerson({ entraObjectId: "e1" });
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    expect(await prisma.emailLog.count()).toBe(1);
    expect(await prisma.teamsMessage.count()).toBe(1);
    expect(await prisma.notification.count({ where: { personId: p.id } })).toBe(1);
  });

  // Issue #74: for channel "both" notify() queues the email up front AND a Teams
  // message carrying the same content as the email fallback. If Teams then fails
  // permanently the drain must NOT queue the fallback email again -- the recipient
  // already got it. Only channel "teams" (no up-front email) should fall back.
  it("channel=both does not double-send the email when Teams fails permanently", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("both");
    const p = await makePerson({ entraObjectId: "e1", contactEmail: "sam@x.com" });
    await notify(prisma, { type: "epic-onboarding", person: p, email, teams });
    // notify queued exactly one email up front and one Teams message.
    expect(await prisma.emailLog.count({ where: { personId: p.id } })).toBe(1);

    // Drive the Teams message to its final attempt, then fail permanently.
    const tm = await prisma.teamsMessage.findFirstOrThrow({ where: { personId: p.id } });
    await prisma.teamsMessage.update({
      where: { id: tm.id },
      data: { attempts: TEAMS_MAX_ATTEMPTS - 1 },
    });
    const transport: TeamsTransport = {
      send: vi.fn().mockRejectedValue(new Error("graph 500")),
    };
    await drainTeamsQueue(transport);

    // Still exactly one email: the permanent-failure fallback was suppressed.
    expect(await prisma.emailLog.count({ where: { personId: p.id } })).toBe(1);
    const after = await prisma.teamsMessage.findUnique({ where: { id: tm.id } });
    expect(after?.status).toBe("FALLBACK");
  });

  it("channel=teams with no identity falls back to email at queue time", async () => {
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const p = await makePerson({ entraObjectId: null });
    await notify(
      prisma,
      { type: "epic-onboarding", person: { ...p, entraObjectId: null }, email, teams },
      { getToken: async () => "tok", fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "x" }) as unknown as typeof fetch }
    );
    expect(await prisma.teamsMessage.count()).toBe(0);
    const e = await prisma.emailLog.findFirst({ where: { personId: p.id } });
    expect(e?.subject).toBe("Subj");
  });

  it("always creates one in-app Notification for the recipient, regardless of channel", async () => {
    // channel = email: one Notification row created
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("email");
    const p1 = await makePerson({ entraObjectId: null });
    await notify(prisma, { type: "epic-onboarding", person: p1, email, teams });
    expect(await prisma.notification.count({ where: { personId: p1.id } })).toBe(1);

    // channel = teams: Notification title/body/type/link match teams fixture
    vi.spyOn(channel, "resolveChannel").mockResolvedValue("teams");
    const p2 = await makePerson({ entraObjectId: "e2", contactEmail: "sam2@x.com" });
    await notify(prisma, { type: "epic-onboarding", person: p2, email, teams });
    const n = await prisma.notification.findFirst({ where: { personId: p2.id } });
    expect(n?.title).toBe(teams.title);
    expect(n?.body).toBe(teams.summary);
    expect(n?.type).toBe("epic-onboarding");
    expect(n?.link).toBe(teams.link);
  });
});
