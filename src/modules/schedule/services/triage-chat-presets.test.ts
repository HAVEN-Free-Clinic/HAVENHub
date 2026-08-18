import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  listTriageChatPresets,
  listTriageChatCards,
  createTriageChatPreset,
  updateTriageChatPreset,
  deactivateTriageChatPreset,
  TriageChatPresetValidationError,
  DEFAULT_MESSAGE_TEMPLATE,
} from "./triage-chat-presets";

beforeEach(resetDb);

const ACTOR = "actor-1";

async function departments() {
  const a = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const b = await prisma.department.create({ data: { code: "LABR", name: "Laboratory" } });
  return { a, b };
}

describe("triage chat presets", () => {
  it("creates a preset with its departments", async () => {
    const { a, b } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      departmentIds: [a.id, b.id],
    });
    const saved = await prisma.triageChatPreset.findUniqueOrThrow({
      where: { id },
      include: { departments: true },
    });
    expect(saved.departments).toHaveLength(2);
  });

  it("rejects a blank name", async () => {
    await expect(
      createTriageChatPreset(ACTOR, {
        name: "  ",
        nameTemplate: "x",
        messageTemplate: "y",
        departmentIds: [],
      }),
    ).rejects.toBeInstanceOf(TriageChatPresetValidationError);
  });

  it("rejects a name template that would produce an empty chat name", async () => {
    await expect(
      createTriageChatPreset(ACTOR, {
        name: "Ancillary",
        nameTemplate: "   ",
        messageTemplate: "y",
        departmentIds: [],
      }),
    ).rejects.toBeInstanceOf(TriageChatPresetValidationError);
  });

  it("replaces the department set on update rather than appending", async () => {
    const { a, b } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    await updateTriageChatPreset(ACTOR, id, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [b.id],
    });
    const saved = await prisma.triageChatPreset.findUniqueOrThrow({
      where: { id },
      include: { departments: true },
    });
    expect(saved.departments.map((d) => d.departmentId)).toEqual([b.id]);
  });

  it("deactivates rather than deletes, so chat history still resolves", async () => {
    const { a } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    await deactivateTriageChatPreset(ACTOR, id);
    expect((await prisma.triageChatPreset.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
    expect(await listTriageChatPresets()).toHaveLength(0);
  });

  it("lists active presets in order with their department names", async () => {
    const { a } = await departments();
    await createTriageChatPreset(ACTOR, {
      name: "Clinical",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
      order: 1,
    });
    await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
      order: 0,
    });
    const presets = await listTriageChatPresets();
    expect(presets.map((p) => p.name)).toEqual(["Ancillary", "Clinical"]);
    expect(presets[0].departmentNames).toEqual(["Behavioral Health"]);
  });

  it("marks a preset that already has a chat for the clinic date", async () => {
    const { a } = await departments();
    const { id } = await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: new Date("2026-05-01T12:00:00Z"),
        endDate: new Date("2026-08-01T12:00:00Z"),
      },
    });
    const clinicDate = new Date("2026-05-30T12:00:00Z");
    await prisma.triageChat.create({
      data: {
        presetId: id,
        termId: term.id,
        clinicDate,
        topic: "05.30.26 Ancillary",
        messageBody: "Hi everyone,\n\nRoster below.",
        graphChatId: "chat-1",
        webUrl: "https://teams/1",
      },
    });

    const [thisWeek] = await listTriageChatCards(clinicDate);
    expect(thisWeek.existingChat?.webUrl).toBe("https://teams/1");

    // A different clinic date is a different chat, so the card offers Create again.
    const [nextWeek] = await listTriageChatCards(new Date("2026-06-06T12:00:00Z"));
    expect(nextWeek.existingChat).toBeNull();
  });

  it("returns presets with no chat when there is no clinic date", async () => {
    const { a } = await departments();
    await createTriageChatPreset(ACTOR, {
      name: "Ancillary",
      nameTemplate: "x",
      messageTemplate: "y",
      departmentIds: [a.id],
    });
    const cards = await listTriageChatCards(null);
    expect(cards).toHaveLength(1);
    expect(cards[0].existingChat).toBeNull();
  });
});
