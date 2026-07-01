import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

describe("Notification model", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates and reads an unread notification linked to a person", async () => {
    const person = await prisma.person.create({
      data: { name: "Sam Volunteer", contactEmail: "sam@example.com" },
    });
    const row = await prisma.notification.create({
      data: {
        personId: person.id,
        type: "epic-activation",
        title: "EPIC access update",
        body: "Your EPIC access has been activated.",
        link: "https://hub.example.com/volunteers",
      },
    });
    expect(row.readAt).toBeNull();
    const found = await prisma.notification.findFirst({ where: { personId: person.id } });
    expect(found?.type).toBe("epic-activation");
  });
});
