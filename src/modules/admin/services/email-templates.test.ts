import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { _resetSettingsCache, setSetting } from "@/platform/settings/service";
import { prisma } from "@/platform/db";
import { saveSenderRule } from "@/platform/email/sender-rules";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  listTemplateSummaries,
  TemplateValidationError,
} from "./email-templates";

beforeEach(async () => {
  await resetDb();
  _resetSettingsCache();
});

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

  it("rejects a blank/whitespace-only subject", async () => {
    await expect(
      saveTemplateOverride(null, "compliance-reminder", { subject: "   ", body: "hello" }),
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

  it("exposes the default brand color for the preview when unset", async () => {
    const t = await getTemplateForEdit("compliance-reminder");
    expect(t.brandColor).toBe("#00356b");
  });

  it("exposes the configured brand color for the preview", async () => {
    await setSetting("branding.brandColor", "#0a7d3c", null);
    const t = await getTemplateForEdit("compliance-reminder");
    expect(t.brandColor).toBe("#0a7d3c");
  });
});

describe("getTemplateForEdit sender info", () => {
  it("reports no override and the inherited global default", async () => {
    await prisma.setting.create({ data: { key: "email.sender", value: "hfc.it@yale.edu" } });
    _resetSettingsCache();
    const t = await getTemplateForEdit("recruitment.acceptance");
    expect(t.hasSenderOverride).toBe(false);
    expect(t.senderFromEmail).toBeNull();
    expect(t.inheritedSender.fromEmail).toBe("hfc.it@yale.edu");
  });

  it("reports a template-level override and inherits from the category for the placeholder", async () => {
    await saveSenderRule(null, "CATEGORY", "recruitment", { fromEmail: "recruit@yale.edu" });
    await saveSenderRule(null, "TEMPLATE", "recruitment.acceptance", {
      fromEmail: "special@yale.edu",
      fromName: "Special",
    });
    const t = await getTemplateForEdit("recruitment.acceptance");
    expect(t.hasSenderOverride).toBe(true);
    expect(t.senderFromEmail).toBe("special@yale.edu");
    expect(t.senderFromName).toBe("Special");
    expect(t.inheritedSender.fromEmail).toBe("recruit@yale.edu");
  });
});

// ---------------------------------------------------------------------------
// The layout's {{{ body }}} slot (audit 14, EMAIL-6)
//
// The layout is the single wrapper every platform email renders inside. Both
// ways of losing its raw slot used to validate cleanly, because `body` IS a
// declared layout variable -- and the editor's "Insert a variable" chips hand
// the admin the broken double-braced form. One admin action, every outbound
// email, no error at send time.
// ---------------------------------------------------------------------------

describe("layout body slot", () => {
  it("rejects a layout saved without the {{{ body }}} slot", async () => {
    await expect(
      saveTemplateOverride(null, "layout", {
        subject: "unused",
        body: "<html><body><h1>HAVEN</h1><footer>bye</footer></body></html>",
      })
    ).rejects.toBeInstanceOf(TemplateValidationError);
  });

  it("rejects a double-braced {{ body }}, which would deliver escaped markup", async () => {
    await expect(
      saveTemplateOverride(null, "layout", {
        subject: "unused",
        body: "<html><body>{{ body }}</body></html>",
      })
    ).rejects.toThrow(/triple-braced/);
  });

  it("accepts a layout that keeps the raw slot", async () => {
    await saveTemplateOverride(null, "layout", {
      subject: "unused",
      body: "<html><body><h1>HAVEN</h1>{{{ body }}}</body></html>",
    });
    const t = await getTemplateForEdit("layout");
    expect(t.body).toContain("{{{ body }}}");
  });

  // The rule is layout-specific: an ordinary template has no body slot at all.
  it("does not impose the slot on non-layout templates", async () => {
    await saveTemplateOverride(null, "recruitment.acceptance", {
      subject: "Welcome",
      body: "<p>Congratulations.</p>",
    });
    const t = await getTemplateForEdit("recruitment.acceptance");
    expect(t.body).toContain("Congratulations");
  });
});
