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

// Actionable reminders (EXPIRED / EXPIRING_SOON / NO_CERTIFICATE) link the member
// straight into HAVEN Hub: an inline link in the sentence plus a brand-colored CTA
// button. Both point at {appUrl}/my-info.
const APP_URL = "https://hub.example.org";
const BRAND = "#00356b";
const CTA_URL = `${APP_URL}/my-info`;

/** The exact rendered body for an actionable status (linked sentence + CTA button). */
function actionableBody(personName: string, statusLine: string): string {
  return [
    `<p>Hello ${personName},</p>`,
    ``,
    `<p>${statusLine}</p>`,
    ``,
    `<p>Please upload or renew your certificate in <a href="${CTA_URL}">HAVEN Hub</a>.</p>`,
    ``,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">`,
    `  <tr>`,
    `    <td style="border-radius: 6px; background-color: ${BRAND};">`,
    `      <a href="${CTA_URL}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Open HAVEN Hub &rarr;</a>`,
    `    </td>`,
    `  </tr>`,
    `</table>`,
    ``,
    `<p>Thank you,<br>HAVEN Free Clinic</p>`,
  ].join("\n");
}

describe("compliance templates via renderEmail (body inside branded layout)", () => {
  // ---------------------------------------------------------------------------
  // compliance-reminder
  // ---------------------------------------------------------------------------

  it("compliance-reminder EXPIRED links to HAVEN Hub with a CTA button", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "EXPIRED",
        expiresAt: new Date(Date.UTC(2026, 0, 15)),
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Compliance reminder");
    expect(out.html).toContain(
      actionableBody("Jane Doe", "Your HIPAA certification expired on January 15, 2026."),
    );
  });

  it("compliance-reminder EXPIRING_SOON links to HAVEN Hub with a CTA button", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "EXPIRING_SOON",
        expiresAt: new Date(Date.UTC(2026, 0, 15)),
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Compliance reminder");
    expect(out.html).toContain(
      actionableBody("Jane Doe", "Your HIPAA certification expires on January 15, 2026."),
    );
  });

  it("compliance-reminder NO_CERTIFICATE links to HAVEN Hub with a CTA button", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "NO_CERTIFICATE",
        expiresAt: null,
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Compliance reminder");
    expect(out.html).toContain(
      actionableBody("Jane Doe", "We do not have a current HIPAA certificate on file for you."),
    );
  });

  it("compliance-reminder UNKNOWN_DATE reassures (no link, no CTA button)", async () => {
    const out = await renderEmail(
      "compliance-reminder",
      complianceReminderContext({
        personName: "Jane Doe",
        status: "UNKNOWN_DATE",
        expiresAt: null,
        appUrl: APP_URL,
        brandColor: BRAND,
      }),
    );
    expect(out.subject).toBe("[HAVEN] Compliance reminder");
    expect(out.html).toContain(
      "<p>Hello Jane Doe,</p>\n\n<p>Your HIPAA certificate is on file, and our compliance team is confirming the completion date.</p>\n\n<p>No action is needed from you right now. A coordinator will record the completion date before your certificate counts toward your clearance.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
    // No-action statuses must not get the upgrade prompt or the button.
    expect(out.html).not.toContain("Open HAVEN Hub");
    expect(out.html).not.toContain(CTA_URL);
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
    expect(out.subject).toBe("[HAVEN] Volunteer compliance needs attention");
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
    expect(out.subject).toBe("[HAVEN] Volunteer compliance needs attention");
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
    expect(out.subject).toBe("[HAVEN] Volunteer compliance needs attention");
    expect(out.html).toContain(
      "<p>Hello Dr. Smith,</p>\n\n<p>Jane Doe in Cardiology is not HIPAA compliant (no certificate on file) and has not responded to reminders. Please follow up.</p>\n\n<p>Thank you,<br>HAVEN Free Clinic</p>",
    );
  });
});
