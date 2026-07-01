import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache } from "@/platform/settings/service";
import {
  groupForTemplate,
  resolveSenderForTemplate,
  resolveInheritedSender,
  saveSenderRule,
  clearSenderRule,
  listSenderRules,
  SenderRuleValidationError,
} from "./sender-rules";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

describe("groupForTemplate", () => {
  it("maps a registered descriptor to its group", () => {
    expect(groupForTemplate("recruitment.acceptance")).toBe("recruitment");
    expect(groupForTemplate("compliance-reminder")).toBe("compliance");
  });

  it("maps campaign system keys to the campaign group", () => {
    expect(groupForTemplate("campaign")).toBe("campaign");
    expect(groupForTemplate("campaign:test")).toBe("campaign");
  });

  it("returns null for an unknown key", () => {
    expect(groupForTemplate("totally-unknown")).toBeNull();
  });
});

describe("resolveSenderForTemplate", () => {
  it("returns null when no rule matches", async () => {
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toBeNull();
  });

  it("applies a CATEGORY rule to a template in that group", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", {
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toEqual({
      fromEmail: "recruit@yale.edu",
      fromName: "HAVEN Recruitment",
    });
  });

  it("a TEMPLATE rule overrides the CATEGORY rule", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await saveSenderRule(null, "TEMPLATE", "recruitment.acceptance", { fromEmail: "special@yale.edu" });
    const r = await resolveSenderForTemplate("recruitment.acceptance");
    expect(r?.fromEmail).toBe("special@yale.edu");
  });

  it("reflects a cleared rule (cache invalidated)", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    expect(await resolveSenderForTemplate("recruitment.acceptance")).not.toBeNull();
    await clearSenderRule(null, "CATEGORY", "recruitment");
    expect(await resolveSenderForTemplate("recruitment.acceptance")).toBeNull();
  });
});

describe("resolveInheritedSender", () => {
  it("falls back to the global email.sender setting when no category rule exists", async () => {
    await prisma.setting.create({ data: { key: "email.sender", value: "hfc.it@yale.edu" } });
    _resetSettingsCache();
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("hfc.it@yale.edu");
    expect(r.fromName).toBeNull();
  });

  it("returns the category rule when present", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    const r = await resolveInheritedSender("recruitment.acceptance");
    expect(r.fromEmail).toBe("recruit@yale.edu");
  });
});

describe("saveSenderRule", () => {
  it("rejects a malformed email", async () => {
    await expect(
      saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "not-an-email" })
    ).rejects.toBeInstanceOf(SenderRuleValidationError);
  });

  it("upserts (one row per scope+target) and lists it", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "a@yale.edu" });
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "b@yale.edu" });
    const rows = await listSenderRules();
    expect(rows).toHaveLength(1);
    expect(rows[0].fromEmail).toBe("b@yale.edu");
  });
});
