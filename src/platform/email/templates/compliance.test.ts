/**
 * Tests for compliance email templates.
 *
 * Pure unit tests -- no DB, no network.
 */

import { describe, expect, it } from "vitest";
import {
  complianceReminderEmail,
  complianceEscalationEmail,
  COMPLIANCE_TEMPLATES,
  type ComplianceReminderParams,
  type ComplianceEscalationParams,
} from "./compliance";

// ---------------------------------------------------------------------------
// COMPLIANCE_TEMPLATES map
// ---------------------------------------------------------------------------

describe("COMPLIANCE_TEMPLATES", () => {
  it("has exactly the two expected keys", () => {
    expect(Object.keys(COMPLIANCE_TEMPLATES).sort()).toEqual([
      "compliance-escalation",
      "compliance-reminder",
    ]);
  });

  it("maps compliance-reminder to complianceReminderEmail", () => {
    expect(COMPLIANCE_TEMPLATES["compliance-reminder"]).toBe(complianceReminderEmail);
  });

  it("maps compliance-escalation to complianceEscalationEmail", () => {
    expect(COMPLIANCE_TEMPLATES["compliance-escalation"]).toBe(complianceEscalationEmail);
  });
});

// ---------------------------------------------------------------------------
// complianceReminderEmail
// ---------------------------------------------------------------------------

describe("complianceReminderEmail", () => {
  it("subject is exactly '[HAVEN] HIPAA certification reminder'", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { subject } = complianceReminderEmail(params);
    expect(subject).toBe("[HAVEN] HIPAA certification reminder");
  });

  it("EXPIRING_SOON: html contains the word 'expires'", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("expires");
  });

  it("EXPIRING_SOON: html contains the formatted expiry date", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    // Expect "July 4, 2026" (UTC)
    expect(html).toContain("July 4, 2026");
  });

  it("EXPIRED: html contains the word 'expired'", () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("expired");
  });

  it("EXPIRED: html contains the formatted expiry date", () => {
    const params: ComplianceReminderParams = {
      personName: "Bob Jones",
      status: "EXPIRED",
      expiresAt: new Date("2025-01-15T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("January 15, 2025");
  });

  it("NO_CERTIFICATE: html contains 'do not have'", () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "NO_CERTIFICATE",
      expiresAt: null,
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("do not have");
  });

  it("UNKNOWN_DATE: html contains 'do not have'", () => {
    const params: ComplianceReminderParams = {
      personName: "Carol White",
      status: "UNKNOWN_DATE",
      expiresAt: null,
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("do not have");
  });

  it("html contains the escaped person name", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("Alice Smith");
  });

  it("html contains the My Info call to action", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("My Info");
  });

  it("HTML-escapes a malicious personName", () => {
    const params: ComplianceReminderParams = {
      personName: "<script>alert(1)</script>",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-07-04T00:00:00Z"),
    };
    const { html } = complianceReminderEmail(params);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("EXPIRING_SOON with null expiresAt shows 'soon'", () => {
    const params: ComplianceReminderParams = {
      personName: "Alice Smith",
      status: "EXPIRING_SOON",
      expiresAt: null,
    };
    const { html } = complianceReminderEmail(params);
    expect(html).toContain("soon");
  });
});

// ---------------------------------------------------------------------------
// complianceEscalationEmail
// ---------------------------------------------------------------------------

describe("complianceEscalationEmail", () => {
  it("subject is exactly '[HAVEN] Volunteer HIPAA compliance needs attention'", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { subject } = complianceEscalationEmail(params);
    expect(subject).toBe("[HAVEN] Volunteer HIPAA compliance needs attention");
  });

  it("html contains the volunteer name", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("Alice Smith");
  });

  it("html contains the department name", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("Outreach");
  });

  it("html contains readable status 'expired' for EXPIRED", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("expired");
  });

  it("html contains readable status 'expiring soon' for EXPIRING_SOON", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRING_SOON",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("expiring soon");
  });

  it("html contains readable status 'no certificate on file' for NO_CERTIFICATE", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "NO_CERTIFICATE",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("no certificate on file");
  });

  it("html contains readable status 'completion date needed' for UNKNOWN_DATE", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "UNKNOWN_DATE",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("completion date needed");
  });

  it("html contains readable status 'compliant' for COMPLIANT", () => {
    const params: ComplianceEscalationParams = {
      directorName: "Dr. Director",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "COMPLIANT",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).toContain("compliant");
  });

  it("HTML-escapes a malicious directorName", () => {
    const params: ComplianceEscalationParams = {
      directorName: "<script>evil()</script>",
      volunteerName: "Alice Smith",
      departmentName: "Outreach",
      status: "EXPIRED",
    };
    const { html } = complianceEscalationEmail(params);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
