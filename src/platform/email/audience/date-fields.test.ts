import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { resolveAudience } from "./resolve";
import type { Audience } from "./types";

beforeEach(resetDb);

const NOW = new Date("2026-03-15T18:00:00.000Z");

function audienceFor(field: string, op: string, value: string | string[]): Audience {
  return {
    recordType: "PERSON",
    match: "ALL",
    conditions: [{ field, op: op as never, value }],
  };
}

async function personWithCert(name: string, email: string, completionDate: Date | null) {
  const p = await prisma.person.create({
    data: { name, contactEmail: email, status: "ACTIVE" },
  });
  await prisma.hipaaCertificate.create({
    data: {
      personId: p.id,
      fileName: "c.pdf",
      storedName: "c.pdf",
      size: 1,
      mimeType: "application/pdf",
      completionDate,
    },
  });
  return p;
}

describe("compliance and training date fields", () => {
  it("finds certificates completed within a relative window", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["recent@x.com"]);
  });

  it("finds certificates before an absolute date", async () => {
    await personWithCert("Recent", "recent@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Old", "old@x.com", new Date("2025-01-01T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "before", "2026-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["old@x.com"]);
  });

  it("excludes a person whose certificate has a null date under isNotEmpty", async () => {
    await personWithCert("Dated", "dated@x.com", new Date("2026-03-12T12:00:00.000Z"));
    await personWithCert("Undated", "undated@x.com", null);

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "isNotEmpty", ""),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["dated@x.com"]);
  });

  it("matches on joinedAt, a plain Person column", async () => {
    const old = await prisma.person.create({
      data: { name: "Founder", contactEmail: "founder@x.com", status: "ACTIVE" },
    });
    await prisma.person.update({
      where: { id: old.id },
      data: { createdAt: new Date("2024-01-01T12:00:00.000Z") },
    });
    await prisma.person.create({
      data: { name: "New", contactEmail: "new@x.com", status: "ACTIVE" },
    });

    const { recipients } = await resolveAudience(
      audienceFor("joinedAt", "before", "2025-01-01"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["founder@x.com"]);
  });

  // `some` never matches a person with zero rows, which is why the helper
  // emits none-or-null instead. Without this test that branch is unguarded,
  // and a regression would drop the people a compliance reminder is FOR.
  it("isEmpty matches people with no related row at all, not just a null date", async () => {
    await personWithCert("Undated", "undated@x.com", null);
    await prisma.person.create({
      data: { name: "No Cert", contactEmail: "nocert@x.com", status: "ACTIVE" },
    });
    await personWithCert("Dated", "dated@x.com", new Date("2026-03-12T12:00:00.000Z"));

    const { recipients } = await resolveAudience(
      audienceFor("hipaaCompletedAt", "isEmpty", ""),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email).sort()).toEqual(["nocert@x.com", "undated@x.com"]);
  });

  // Person has TWO relations to EhsCompletion: the person's own (ehsCompletions)
  // and the reverse "who marked it" side (ehsCompletionsMarked). Swapping to the
  // reverse relation would compile and typecheck fine while silently changing
  // the send list from "people who completed the training" to "staff who
  // recorded it for someone else" -- so this fixture deliberately puts the
  // completion and the marking on two DIFFERENT people.
  it("ehsCompletedAt matches the person who completed the training, not who marked it", async () => {
    const training = await prisma.ehsTraining.create({ data: { name: "Bloodborne Pathogens" } });
    const completer = await prisma.person.create({
      data: { name: "Completer", contactEmail: "completer@x.com", status: "ACTIVE" },
    });
    const marker = await prisma.person.create({
      data: { name: "Marker", contactEmail: "marker@x.com", status: "ACTIVE" },
    });
    await prisma.ehsCompletion.create({
      data: {
        personId: completer.id,
        trainingId: training.id,
        completedAt: new Date("2026-03-12T12:00:00.000Z"),
        markedById: marker.id,
      },
    });

    const { recipients } = await resolveAudience(
      audienceFor("ehsCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["completer@x.com"]);
  });

  // Same trap as above, on Training's reverse relation: trainings (the
  // person-owned side) vs trainingAttendanceMarked (who recorded attendance).
  it("trainingCompletedAt matches the person who completed the training, not who recorded attendance", async () => {
    const term = await prisma.term.create({
      data: {
        code: "SP26",
        name: "Spring 2026",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-05-01"),
        status: "ACTIVE",
      },
    });
    const recorder = await prisma.person.create({
      data: { name: "Recorder", contactEmail: "recorder@x.com", status: "ACTIVE" },
    });
    const cycle = await prisma.recruitmentCycle.create({
      data: {
        track: "VOLUNTEER",
        termId: term.id,
        title: "T",
        publicSlug: "t-cycle-trap",
        departments: [],
        createdById: recorder.id,
      },
    });
    const completer = await prisma.person.create({
      data: { name: "Completer", contactEmail: "trainee@x.com", status: "ACTIVE" },
    });
    await prisma.training.create({
      data: {
        personId: completer.id,
        termId: term.id,
        cycleId: cycle.id,
        status: "COMPLETE",
        completedVia: "QUIZ",
        completedAt: new Date("2026-03-12T12:00:00.000Z"),
        attendanceRecordedById: recorder.id,
        attendanceRecordedAt: new Date("2026-03-12T12:00:00.000Z"),
      },
    });

    const { recipients } = await resolveAudience(
      audienceFor("trainingCompletedAt", "withinLastDays", "7"),
      { now: NOW },
    );
    expect(recipients.map((r) => r.email)).toEqual(["trainee@x.com"]);
  });
});
