/**
 * Pure render tests for the compliance-reminder body.
 *
 * These tests exercise the template engine directly (no DB, no renderEmail) and
 * assert two properties that survive the split: the body leaves no unresolved
 * template tags on either branch, and dropping the optional branch does not leave a
 * double blank line behind. The EHS and onboarding cases this file used to cover
 * moved to the onboarding-reminder template, which owns that copy now.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/platform/email/render/render";
import { complianceReminderContext, complianceDescriptors } from "./compliance";

const reminderDescriptor = complianceDescriptors.find((d) => d.key === "compliance-reminder")!;

describe("compliance-reminder body rendering (pure, no DB)", () => {
  it("leaves exactly one blank line between the CTA table and the sign-off", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).toContain("</table>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>");
    // Must NOT have a double blank line (three or more consecutive newlines).
    expect(output).not.toMatch(/\n{3}/);
  });

  it("leaves no unresolved template tags on the actionable branch", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "EXPIRED",
      expiresAt: new Date("2025-09-01T00:00:00Z"),
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });

  it("leaves no unresolved template tags on the no-action branch", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "UNKNOWN_DATE",
      expiresAt: null,
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });
});
