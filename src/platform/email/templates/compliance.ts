/**
 * Compliance email templates for HAVEN Hub.
 *
 * Two templates are provided:
 *   - compliance-reminder: sent directly to a volunteer whose HIPAA cert is
 *     expiring, expired, or missing.
 *   - compliance-escalation: sent to a department director when a volunteer
 *     has not responded to reminders.
 */

import type { ComplianceStatus } from "@/platform/compliance/rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplianceReminderParams = {
  personName: string;
  status: ComplianceStatus;
  expiresAt: Date | null;
};

export type ComplianceEscalationParams = {
  directorName: string;
  volunteerName: string;
  departmentName: string;
  status: ComplianceStatus;
};

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape user-supplied values before interpolating into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Format a Date as "Month D, YYYY" using UTC; returns "soon" when null. */
function fmtDate(d: Date | null): string {
  if (d === null) return "soon";
  const month = MONTH_NAMES[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

// ---------------------------------------------------------------------------
// complianceReminderEmail
// ---------------------------------------------------------------------------

export function complianceReminderEmail(p: ComplianceReminderParams): { subject: string; html: string } {
  const subject = "[HAVEN] HIPAA certification reminder";

  let statusLine: string;
  switch (p.status) {
    case "EXPIRING_SOON":
      statusLine = `Your HIPAA certification expires on ${fmtDate(p.expiresAt)}.`;
      break;
    case "EXPIRED":
      statusLine = `Your HIPAA certification expired on ${fmtDate(p.expiresAt)}.`;
      break;
    case "NO_CERTIFICATE":
    case "UNKNOWN_DATE":
      statusLine = "We do not have a current HIPAA certificate on file for you.";
      break;
    case "COMPLIANT":
      statusLine = "Your HIPAA certification is up to date.";
      break;
  }

  const html = `
<p>Hello ${esc(p.personName)},</p>

<p>${statusLine}</p>

<p>Please upload or renew your certificate in My Info.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>
`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// complianceEscalationEmail
// ---------------------------------------------------------------------------

const READABLE_STATUS: Record<ComplianceStatus, string> = {
  EXPIRING_SOON: "expiring soon",
  EXPIRED: "expired",
  NO_CERTIFICATE: "no certificate on file",
  UNKNOWN_DATE: "completion date needed",
  COMPLIANT: "compliant",
};

export function complianceEscalationEmail(p: ComplianceEscalationParams): { subject: string; html: string } {
  const subject = "[HAVEN] Volunteer HIPAA compliance needs attention";

  const readableStatus = READABLE_STATUS[p.status];

  const html = `
<p>Hello ${esc(p.directorName)},</p>

<p>${esc(p.volunteerName)} in ${esc(p.departmentName)} is not HIPAA compliant (${readableStatus}) and has not responded to reminders. Please follow up.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>
`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export const COMPLIANCE_TEMPLATES = {
  "compliance-reminder": complianceReminderEmail,
  "compliance-escalation": complianceEscalationEmail,
} as const;

export type ComplianceTemplateKey = keyof typeof COMPLIANCE_TEMPLATES;
