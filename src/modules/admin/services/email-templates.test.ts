import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  listTemplateSummaries,
  TemplateValidationError,
} from "./email-templates";

beforeEach(resetDb);

describe("email-templates service", () => {
  it("returns the code default when no override exists", async () => {
    const t = await getTemplateForEdit("compliance-reminder");
    expect(t.hasOverride).toBe(false);
    expect(t.subject).toBe("[HAVEN] HIPAA certification reminder");
  });

  it("saves an override and reports it on next load", async () => {
    await saveTemplateOverride(null, "compliance-reminder", {
      subject: "New reminder for {{ personName }}",
      body: "<p>{{ personName }}</p>",
    });
    const t = await getTemplateForEdit("compliance-reminder");
    expect(t.hasOverride).toBe(true);
    expect(t.subject).toBe("New reminder for {{ personName }}");
  });

  it("rejects an override referencing unknown variables", async () => {
    await expect(
      saveTemplateOverride(null, "compliance-reminder", { subject: "x", body: "{{ bogusVar }}" }),
    ).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it("rejects an unbalanced conditional", async () => {
    await expect(
      saveTemplateOverride(null, "compliance-reminder", { subject: "x", body: "{{#if personName}}hi" }),
    ).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it("reset deletes the override and reverts to default", async () => {
    await saveTemplateOverride(null, "compliance-reminder", { subject: "X", body: "Y" });
    await resetTemplateOverride(null, "compliance-reminder");
    const t = await getTemplateForEdit("compliance-reminder");
    expect(t.hasOverride).toBe(false);
  });

  it("lists a summary per descriptor with override flags", async () => {
    await saveTemplateOverride(null, "layout", { subject: "{{ subject }}", body: "{{{ body }}}" });
    const rows = await listTemplateSummaries();
    expect(rows.find((r) => r.key === "layout")?.hasOverride).toBe(true);
    expect(rows.find((r) => r.key === "compliance-reminder")?.hasOverride).toBe(false);
  });

  it("throws on an unknown key", async () => {
    await expect(getTemplateForEdit("nope")).rejects.toThrow(/Unknown email template/);
  });
});
