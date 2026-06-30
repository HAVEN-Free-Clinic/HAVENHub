import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getSupportContact } from "./support";

beforeEach(async () => {
  await resetDb();
});

describe("getSupportContact", () => {
  it("returns the registry defaults when no overrides exist", async () => {
    expect(await getSupportContact()).toEqual({
      email: "hfc.it@yale.edu",
      label: "Contact the HAVEN Free Clinic IT team",
    });
  });

  it("returns a stored support email override when present", async () => {
    await prisma.setting.create({
      data: { key: "branding.supportEmail", value: "help@opendoor.org" },
    });
    expect((await getSupportContact()).email).toBe("help@opendoor.org");
  });

  it("derives the label from the configured organization name", async () => {
    await prisma.setting.create({
      data: { key: "branding.orgName", value: "Open Door Clinic" },
    });
    expect((await getSupportContact()).label).toBe("Contact the Open Door Clinic IT team");
  });

  it("returns an empty email when the support email is cleared", async () => {
    await prisma.setting.create({ data: { key: "branding.supportEmail", value: "" } });
    expect((await getSupportContact()).email).toBe("");
  });
});
