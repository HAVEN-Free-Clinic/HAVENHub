import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

describe("TeamsMessage model", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates and reads a queued Teams message linked to a person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam Volunteer", contactEmail: "sam@example.com" },
    });

    const row = await prisma.teamsMessage.create({
      data: {
        personId: person.id,
        type: "compliance-reminder",
        title: "HIPAA compliance reminder",
        summary: "Your HIPAA training is expiring soon.",
        link: "https://hub.example.com/compliance",
        bodyHtml: "<strong>HIPAA compliance reminder</strong>",
        fallbackSubject: "HIPAA compliance reminder",
        fallbackHtml: "<p>reminder</p>",
      },
    });

    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);

    const found = await prisma.teamsMessage.findFirst({ where: { personId: person.id } });
    expect(found?.type).toBe("compliance-reminder");
  });
});
