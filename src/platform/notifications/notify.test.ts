// src/platform/notifications/notify.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { notify } from "./notify";
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
});
