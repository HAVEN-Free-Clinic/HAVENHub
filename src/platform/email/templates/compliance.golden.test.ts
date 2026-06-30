/**
 * Golden-master tests for compliance email templates via renderEmail.
 *
 * These tests assert that the new descriptor + renderEmail system produces the
 * same body content as the pre-refactor complianceReminderEmail /
 * complianceEscalationEmail functions. The body is now injected verbatim into the
 * branded layout shell, so we assert the body is contained in the rendered email.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { renderEmail } from "./renderEmail";
import { complianceReminderContext, complianceEscalationContext } from "./compliance";

beforeEach(resetDb);

describe("compliance templates via renderEmail (body inside branded layout)", () => {
  // ---------------------------------------------------------------------------
  // compliance-reminder
  // ---------------------------------------------------------------------------

  it("compliance-reminder EXPIRED matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "EXPIRED",
        expiresAt: new Date(Date.UTC(2026, 0, 15)),
      }),
    );
    expect(out.subject).toBe("[HAVEN] HIPAA certification reminder");
    expect(out.html).toContain(
      "<p>Hello Jane Doe,</p>\n\n<p>Your HIPAA certification expired on January 15, 2026.</p>\n\n<p>Please upload or renew your certificate in My Info.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  it("compliance-reminder EXPIRING_SOON matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "EXPIRING_SOON",
        expiresAt: new Date(Date.UTC(2026, 0, 15)),
      }),
    );
    expect(out.subject).toBe("[HAVEN] HIPAA certification reminder");
    expect(out.html).toContain(
      "<p>Hello Jane Doe,</p>\n\n<p>Your HIPAA certification expires on January 15, 2026.</p>\n\n<p>Please upload or renew your certificate in My Info.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  it("compliance-reminder NO_CERTIFICATE matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "NO_CERTIFICATE",
        expiresAt: null,
      }),
    );
    expect(out.subject).toBe("[HAVEN] HIPAA certification reminder");
    expect(out.html).toContain(
      "<p>Hello Jane Doe,</p>\n\n<p>We do not have a current HIPAA certificate on file for you.</p>\n\n<p>Please upload or renew your certificate in My Info.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  it("compliance-reminder UNKNOWN_DATE reassures that the certificate is on file (no re-upload ask)", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "UNKNOWN_DATE",
        expiresAt: null,
      }),
    );
    expect(out.subject).toBe("[HAVEN] HIPAA certification reminder");
    expect(out.html).toContain(
      "<p>Hello Jane Doe,</p>\n\n<p>Your HIPAA certificate is on file, and our compliance team is confirming the completion date.</p>\n\n<p>No action is needed from you right now. A coordinator will record the completion date before your certificate counts toward your clearance.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  // ---------------------------------------------------------------------------
  // compliance-escalation
  // ---------------------------------------------------------------------------

  it("compliance-escalation EXPIRED matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-escalation",
      complianceEscalationContext({
        directorName: "Dr. Smith",
        volunteerName: "Jane Doe",
        departmentName: "Cardiology",
        status: "EXPIRED",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Volunteer HIPAA compliance needs attention");
    expect(out.html).toContain(
      "<p>Hello Dr. Smith,</p>\n\n<p>Jane Doe in Cardiology is not HIPAA compliant (expired) and has not responded to reminders. Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  it("compliance-escalation EXPIRING_SOON matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-escalation",
      complianceEscalationContext({
        directorName: "Dr. Smith",
        volunteerName: "Jane Doe",
        departmentName: "Cardiology",
        status: "EXPIRING_SOON",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Volunteer HIPAA compliance needs attention");
    expect(out.html).toContain(
      "<p>Hello Dr. Smith,</p>\n\n<p>Jane Doe in Cardiology is not HIPAA compliant (expiring soon) and has not responded to reminders. Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });

  it("compliance-escalation NO_CERTIFICATE matches pre-refactor output", async () => {
    const out = await renderEmail(
      "compliance-escalation",
      complianceEscalationContext({
        directorName: "Dr. Smith",
        volunteerName: "Jane Doe",
        departmentName: "Cardiology",
        status: "NO_CERTIFICATE",
      }),
    );
    expect(out.subject).toBe("[HAVEN] Volunteer HIPAA compliance needs attention");
    expect(out.html).toContain(
      "<p>Hello Dr. Smith,</p>\n\n<p>Jane Doe in Cardiology is not HIPAA compliant (no certificate on file) and has not responded to reminders. Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });
});
