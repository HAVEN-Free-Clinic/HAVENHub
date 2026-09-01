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
});
