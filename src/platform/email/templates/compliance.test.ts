/**
 * Tests for compliance email templates via renderEmail.
 *
 * These tests verify the behavioral contracts (subject, HTML shape, HTML
 * escaping, status branches) previously tested against the old
 * complianceReminderEmail / complianceEscalationEmail functions.
 *
 * The golden-master (byte-exact) assertions live in compliance.golden.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import {
  complianceReminderContext,
  complianceEscalationContext,
  type ComplianceReminderParams,
  type ComplianceEscalationParams,
} from "./compliance";

beforeEach(resetDb);

// ---------------------------------------------------------------------------
// compliance-reminder
// ---------------------------------------------------------------------------

describe("compliance-reminder via renderEmail", () => {
  it("subject is exactly '[HAVEN] HIPAA certification reminder'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { subject } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(subject).toBe("[HAVEN] HIPAA certification reminder");
  });

  it("EXPIRING_SOON: html contains the word 'expires'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("expires");
  });

  it("EXPIRING_SOON: html contains the formatted expiry date", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    // Expect "July 4, 2026" (UTC)
    expect(html).toContain("July 4, 2026");
  });

  it("EXPIRED: html contains the word 'expired'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("expired");
  });

  it("EXPIRED: html contains the formatted expiry date", async () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("January 15, 2025");
  });

  it("NO_CERTIFICATE: html contains 'do not have'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "NO_CERTIFICATE",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("do not have");
  });

  it("UNKNOWN_DATE: html contains 'do not have'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "UNKNOWN_DATE",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("do not have");
  });

  it("html contains the escaped person name", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("Alice Smith");
  });

  it("html contains the My Info call to action", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("My Info");
  });

  it("HTML-escapes a malicious personName", async () => {
    const params: ComplianceReminderParams = {
      personName: "<script>alert(1)</script>",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("EXPIRING_SOON with null expiresAt shows 'soon'", async () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: null,
    };
    const { html } = await renderEmail("compliance-reminder", complianceReminderContext(params));
    expect(html).toContain("soon");
  });
});

// ---------------------------------------------------------------------------
// compliance-escalation
// ---------------------------------------------------------------------------

describe("compliance-escalation via renderEmail", () => {
  it("subject is exactly '[HAVEN] Volunteer HIPAA compliance needs attention'", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { subject } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(subject).toBe("[HAVEN] Volunteer HIPAA compliance needs attention");
  });

  it("html contains the volunteer name", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("Alice Smith");
  });

  it("html contains the department name", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("Outreach");
  });

  it("html contains readable status 'expired' for EXPIRED", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("expired");
  });

  it("html contains readable status 'expiring soon' for EXPIRING_SOON", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRING_SOON",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("expiring soon");
  });

  it("html contains readable status 'no certificate on file' for NO_CERTIFICATE", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "NO_CERTIFICATE",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("no certificate on file");
  });

  it("html contains readable status 'completion date needed' for UNKNOWN_DATE", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "UNKNOWN_DATE",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("completion date needed");
  });

  it("html contains readable status 'compliant' for COMPLIANT", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "COMPLIANT",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).toContain("compliant");
  });

  it("HTML-escapes a malicious directorName", async () => {
    const params: ComplianceEscalationParams = {
      directorName: "<script>evil()</script>",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = await renderEmail("compliance-escalation", complianceEscalationContext(params));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
