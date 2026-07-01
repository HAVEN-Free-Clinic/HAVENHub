import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getOrgIdentity, formatOrgLine } from "./org";

beforeEach(async () => {
  await resetDb();
});

describe("formatOrgLine", () => {
  it("joins name and tagline with a middot", () => {
    expect(formatOrgLine({ name: "HAVEN Free Clinic", tagline: "Yale University" })).toBe(
      "HAVEN Free Clinic · Yale University"
    );
  });

  it("returns just the name when the tagline is blank", () => {
    expect(formatOrgLine({ name: "HAVEN Free Clinic", tagline: "" })).toBe("HAVEN Free Clinic");
  });

  it("ignores a whitespace-only tagline", () => {
    expect(formatOrgLine({ name: "HAVEN Free Clinic", tagline: "   " })).toBe("HAVEN Free Clinic");
  });
});

describe("getOrgIdentity", () => {
  it("returns the registry defaults when no overrides exist", async () => {
    expect(await getOrgIdentity()).toEqual({
      name: "HAVEN Free Clinic",
      tagline: "Yale University",
    });
  });

  it("returns stored overrides when present", async () => {
    await prisma.setting.create({ data: { key: "branding.orgName", value: "Open Door Clinic" } });
    await prisma.setting.create({ data: { key: "branding.orgTagline", value: "Community Health" } });
    expect(await getOrgIdentity()).toEqual({
      name: "Open Door Clinic",
      tagline: "Community Health",
    });
  });
});
