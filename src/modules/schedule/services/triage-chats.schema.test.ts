import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";

beforeEach(resetDb);

async function seedPreset() {
  const dept = await prisma.department.create({
    data: { code: "BVHD", name: "Behavioral Health" },
  });
  const preset = await prisma.triageChatPreset.create({
    data: {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: "Hi everyone,\n\n{{rosterBlock}}",
      departments: { create: [{ departmentId: dept.id }] },
    },
    include: { departments: true },
  });
  return { dept, preset };
}

describe("triage chat schema", () => {
  it("stores a preset with its departments", async () => {
    const { dept, preset } = await seedPreset();
    expect(preset.departments).toHaveLength(1);
    expect(preset.departments[0].departmentId).toBe(dept.id);
    expect(preset.isActive).toBe(true);
  });

  it("refuses a second chat for the same preset and clinic date", async () => {
    const { preset } = await seedPreset();
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-01T12:00:00Z") },
    });
    const clinicDate = new Date("2026-05-30T12:00:00Z");
    const base = {
      presetId: preset.id,
      termId: term.id,
      clinicDate,
      topic: "05.30.26 Ancillary Triage Chat",
      graphChatId: "chat-1",
      webUrl: "https://teams.microsoft.com/l/chat/1",
    };

    await prisma.triageChat.create({ data: base });
    await expect(
      prisma.triageChat.create({ data: { ...base, graphChatId: "chat-2" } }),
    ).rejects.toThrow();
  });

  it("records per-member add outcomes", async () => {
    const { preset } = await seedPreset();
    const term = await prisma.term.create({
      data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-01T12:00:00Z"), endDate: new Date("2026-08-01T12:00:00Z") },
    });
    const person = await prisma.person.create({ data: { name: "Goeun Lee", netId: "gl123" } });
    const chat = await prisma.triageChat.create({
      data: {
        presetId: preset.id,
        termId: term.id,
        clinicDate: new Date("2026-05-30T12:00:00Z"),
        topic: "05.30.26 Ancillary Triage Chat",
        graphChatId: "chat-1",
        webUrl: "https://teams.microsoft.com/l/chat/1",
        members: {
          create: [
            { personId: person.id, personName: "Goeun Lee", departmentName: "Behavioral Health", addedOk: false, error: "not found in directory" },
          ],
        },
      },
      include: { members: true },
    });
    expect(chat.members[0].addedOk).toBe(false);
    expect(chat.members[0].error).toBe("not found in directory");
    expect(chat.messagePostedAt).toBeNull();
  });
});
