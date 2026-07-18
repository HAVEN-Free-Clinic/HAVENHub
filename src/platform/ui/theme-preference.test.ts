import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getPersonThemePreference } from "./theme-preference";

beforeEach(async () => {
  await resetDb();
});

describe("getPersonThemePreference", () => {
  it("returns the person's stored theme preference", async () => {
    const person = await prisma.person.create({
      data: { name: "Prefers Dark", themePreference: "dark" },
    });
    expect(await getPersonThemePreference(person.id)).toBe("dark");
  });

  it("returns null when the person has no stored preference", async () => {
    const person = await prisma.person.create({ data: { name: "No Preference" } });
    expect(await getPersonThemePreference(person.id)).toBeNull();
  });

  it("degrades to null when the database is unreachable", async () => {
    // The root layout resolves this on every authenticated render, so a brief
    // Neon outage must not 500 the whole app -- it degrades to null, and the
    // caller falls back to the admin default theme (as for a session-less
    // visitor) until the DB recovers.
    const spy = vi
      .spyOn(prisma.person, "findUnique")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at ep-flat-block.neon.tech:5432",
          "5.0.0"
        )
      );
    expect(await getPersonThemePreference("any-id")).toBeNull();
    spy.mockRestore();
  });

  it("rethrows non-connectivity DB errors", async () => {
    const spy = vi
      .spyOn(prisma.person, "findUnique")
      .mockRejectedValueOnce(new Error("boom"));
    await expect(getPersonThemePreference("any-id")).rejects.toThrow(/boom/);
    spy.mockRestore();
  });
});
