/**
 * Pure render tests for EHS missing-list interpolation in compliance templates.
 *
 * These tests exercise the template engine directly (no DB, no renderEmail).
 * They assert that precomputed ehsMissingList strings round-trip through
 * renderTemplate without leaving any unresolved template tags.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/platform/email/render/render";
import {
  complianceReminderContext,
  complianceEscalationContext,
  complianceDescriptors,
} from "./compliance";

const reminderDescriptor = complianceDescriptors.find((d) => d.key === "compliance-reminder")!;
const escalationDescriptor = complianceDescriptors.find((d) => d.key === "compliance-escalation")!;

describe("compliance-reminder whitespace-neutrality when hasEhsGap is false (pure, no DB)", () => {
  it("leaves exactly one blank line between the CTA table and the sign-off when hasEhsGap is false", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      ehsMissing: [],
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).toContain("</table>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>");
    // Must NOT have a double blank line (three or more consecutive newlines).
    expect(output).not.toMatch(/\n{3}/);
  });
});

describe("compliance-escalation whitespace-neutrality when hasEhsGap is false (pure, no DB)", () => {
  it("leaves exactly one blank line between the follow-up sentence and the sign-off when hasEhsGap is false", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: [],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).toContain("Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>");
    expect(output).not.toMatch(/\n{3}/);
  });
});

describe("compliance-reminder EHS list rendering (pure, no DB)", () => {
  it("renders both EHS training names into the body", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "COMPLIANT",
      expiresAt: null,
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).toContain("BBP Clinical");
    expect(output).toContain("TB Baseline Screening");
  });

  it("does not leave any unresolved template tags in the output", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "COMPLIANT",
      expiresAt: null,
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });

  it("omits the EHS section entirely when ehsMissing is empty", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("EHS training is incomplete");
  });
});

describe("compliance-escalation EHS list rendering (pure, no DB)", () => {
  it("renders both EHS training names into the body", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).toContain("BBP Clinical");
    expect(output).toContain("TB Baseline Screening");
  });

  it("does not leave any unresolved template tags in the output", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });

  it("omits the Outstanding EHS section entirely when ehsMissing is empty", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).not.toContain("Outstanding EHS training");
  });
});

describe("compliance-escalation EHS-only (COMPLIANT) copy (pure, no DB)", () => {
  it("renders EHS-only copy when status is COMPLIANT, not HIPAA complaint copy", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "COMPLIANT",
      ehsMissing: ["BBP Clinical"],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).not.toContain("not HIPAA compliant");
    expect(output).toContain("has outstanding required EHS training");
    expect(output).toContain("BBP Clinical");
  });

  it("renders the HIPAA non-compliant sentence and sign-off for EXPIRED status (golden guard)", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: [],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).toContain(
      "is not HIPAA compliant (expired) and has not responded to reminders. Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>"
    );
  });
});
