import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listTeamsMessages,
  retryTeamsMessage,
  TeamsMessageStateError,
} from "./teams-messages";

let _seedIdx = 0;
async function seed(status: "QUEUED" | "SENT" | "FAILED" | "FALLBACK") {
  const idx = ++_seedIdx;
  const p = await prisma.person.create({
    data: { name: "Sam", contactEmail: `sam${idx}@x.com`, entraObjectId: `e${idx}` },
  });
  return prisma.teamsMessage.create({
    data: {
      personId: p.id,
      type: "epic-onboarding",
      title: "T",
      summary: "S",
      bodyHtml: "<p>x</p>",
      fallbackSubject: "T",
      fallbackHtml: "<p>x</p>",
      status,
    },
  });
}

describe("listTeamsMessages", () => {
  beforeEach(async () => await resetDb());

  it("filters by status", async () => {
    await seed("QUEUED");
    await seed("FAILED");
    const { rows, total } = await listTeamsMessages({ status: "FAILED" });
    expect(total).toBe(1);
    expect(rows[0].status).toBe("FAILED");
  });
});

describe("retryTeamsMessage", () => {
  beforeEach(async () => await resetDb());

  it("resets a FAILED row to QUEUED with zero attempts", async () => {
    const row = await seed("FAILED");
    await prisma.teamsMessage.update({ where: { id: row.id }, data: { attempts: 8 } });
    await retryTeamsMessage(row.id);
    const after = await prisma.teamsMessage.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("QUEUED");
    expect(after?.attempts).toBe(0);
  });

  it("rejects retrying a SENT row", async () => {
    const row = await seed("SENT");
    await expect(retryTeamsMessage(row.id)).rejects.toBeInstanceOf(TeamsMessageStateError);
  });
});
