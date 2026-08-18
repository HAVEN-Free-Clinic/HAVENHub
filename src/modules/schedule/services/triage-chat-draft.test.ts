import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { setSetting } from "@/platform/settings/service";
import {
  loadTriageChatDraft,
  renderTriageText,
  textToTeamsHtml,
} from "./triage-chat-draft";

beforeEach(resetDb);

const CLINIC_DATE = new Date("2026-05-30T12:00:00Z");
const NOW = new Date("2026-05-27T14:00:00Z");

async function seed(options: { triage?: boolean; membershipStatus?: "ACTIVE" | "REMOVED" } = {}) {
  const { triage = true, membershipStatus = "ACTIVE" } = options;
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T12:00:00Z"),
      endDate: new Date("2026-08-01T12:00:00Z"),
      status: "ACTIVE",
      clinicDates: [CLINIC_DATE],
    },
  });
  const bvhd = await prisma.department.create({ data: { code: "BVHD", name: "Behavioral Health" } });
  const exec = await prisma.department.create({ data: { code: "EXEC", name: "Executive Directors" } });

  const goeun = await prisma.person.create({
    data: { name: "Goeun Lee", netId: "gl123", entraObjectId: "oid-goeun" },
  });
  const phil = await prisma.person.create({
    data: { name: "Phil Xu", netId: "px9", entraObjectId: "oid-phil" },
  });

  for (const [person, dept] of [[goeun, bvhd], [phil, exec]] as const) {
    await prisma.termMembership.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        status: membershipStatus,
        kind: "DIRECTOR",
      },
    });
    await prisma.shiftAssignment.create({
      data: {
        termId: term.id,
        departmentId: dept.id,
        personId: person.id,
        clinicDate: CLINIC_DATE,
        role: "DIRECTOR",
        triage: dept.code === "EXEC" ? false : triage,
      },
    });
  }

  const preset = await prisma.triageChatPreset.create({
    data: {
      name: "Ancillary",
      nameTemplate: "{{clinicDateShort}} Ancillary Triage Chat",
      messageTemplate: "Hi everyone! Clinic is {{clinicDate}}.\n\n{{rosterBlock}}",
      departments: { create: [{ departmentId: bvhd.id }] },
    },
  });
  return { term, preset, bvhd, exec, goeun, phil };
}

describe("renderTriageText", () => {
  it("substitutes variables and leaves an unknown one empty", () => {
    expect(renderTriageText("A {{x}} B {{missing}}C", { x: "1" })).toBe("A 1 B C");
  });
});

describe("textToTeamsHtml", () => {
  it("escapes html and turns newlines into breaks", () => {
    expect(textToTeamsHtml("a <b>\nc & d")).toBe("a &lt;b&gt;<br>c &amp; d");
  });
});

describe("loadTriageChatDraft", () => {
  it("builds the topic, message, and roster for the upcoming clinic date", async () => {
    const { preset } = await seed();
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft).not.toBeNull();
    expect(draft!.topic).toBe("05.30.26 Ancillary Triage Chat");
    expect(draft!.messageBody).toContain("Clinic is Saturday, May 30, 2026");
    expect(draft!.messageBody).toContain("- Behavioral Health: Goeun Lee");
    expect(draft!.roster.members.map((m) => m.name).sort()).toEqual(["Goeun Lee", "Phil Xu"]);
    expect(draft!.roster.sessionCoordinators).toEqual(["Phil Xu"]);
  });

  it("drops a person whose membership is no longer active", async () => {
    const { preset } = await seed({ membershipStatus: "REMOVED" });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.roster.members).toHaveLength(0);
  });

  it("warns when a selected department has no triage director on shift", async () => {
    const { preset } = await seed({ triage: false });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).toContain("Behavioral Health");
  });

  it("warns, without blocking, when the clinic date has been closed", async () => {
    const { preset, term } = await seed();
    // A closed Saturday stays in Term.clinicDates and is taken out of service by
    // this flag, so the draft still builds and the ED still gets the roster: the
    // spec asks for a warning here, not a block.
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: CLINIC_DATE, isClosed: true },
    });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft).not.toBeNull();
    expect(draft!.warnings.join(" ")).toContain("marked closed");
    expect(draft!.roster.members.map((m) => m.name).sort()).toEqual(["Goeun Lee", "Phil Xu"]);
  });

  it("does not warn about a clinic date that is open", async () => {
    const { preset, term } = await seed();
    await prisma.clinicDay.create({
      data: { termId: term.id, clinicDate: CLINIC_DATE, isClosed: false },
    });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).not.toContain("marked closed");
  });

  it("warns when an always-include department has nobody on shift", async () => {
    const { preset, phil } = await seed();
    // The Executive Directors are always included, so nobody on shift there
    // renders {{sessionCoordinators}} as an empty string into the middle of the
    // opening message with nothing to say it happened.
    await prisma.shiftAssignment.deleteMany({ where: { personId: phil.id } });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.roster.sessionCoordinators).toEqual([]);
    expect(draft!.warnings.join(" ")).toContain(
      "Executive Directors joins every triage chat but has nobody on shift",
    );
    // Still a warning and not a block: the rest of the roster is intact.
    expect(draft!.roster.members.map((m) => m.name)).toEqual(["Goeun Lee"]);
  });

  it("does not warn about an always-include department that is staffed", async () => {
    const { preset } = await seed();
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).not.toContain("Executive Directors joins every triage chat");
  });

  it("warns about an always-include code that matches no department", async () => {
    const { preset } = await seed();
    // Through the settings service, never a raw Setting insert: the resolver
    // holds a process-global cache that a raw write would leave stale.
    await setSetting("triageChats.alwaysIncludeDepartmentCodes", "EXEC,NOPE", null);
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.warnings.join(" ")).toContain("NOPE");
  });

  it("surfaces an existing chat for the same preset and clinic date", async () => {
    const { preset, term } = await seed();
    await prisma.triageChat.create({
      data: {
        presetId: preset.id,
        termId: term.id,
        clinicDate: CLINIC_DATE,
        topic: "05.30.26 Ancillary Triage Chat",
        messageBody: "Hi everyone,\n\nRoster below.",
        graphChatId: "chat-1",
        webUrl: "https://teams.microsoft.com/l/chat/1",
      },
    });
    const draft = await loadTriageChatDraft(preset.id, {
      now: NOW,
      resolveIds: (members) =>
        members.map((member) => ({ member, userId: "oid", source: "stored" as const })),
    });
    expect(draft!.existingChat?.graphChatId).toBe("chat-1");
  });
});
