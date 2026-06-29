/**
 * Compliance email templates for HAVEN Hub.
 *
 * Two templates are provided:
 *   - compliance-reminder: sent directly to a volunteer whose HIPAA cert is
 *     expiring, expired, or missing.
 *   - compliance-escalation: sent to a department director when a volunteer
 *     has not responded to reminders.
 *
 * Each template is expressed as a TemplateDescriptor (for the registry + admin
 * UI) plus a typed context-builder function that maps the original params into
 * the flat string/boolean context the render engine consumes.
 */

import type { ComplianceStatus } from "@/platform/compliance/rules";
import type { TemplateDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Param types (unchanged -- callers depend on these)
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
// Private helpers
// ---------------------------------------------------------------------------

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

const READABLE_STATUS: Record<ComplianceStatus, string> = {
  EXPIRING_SOON: "expiring soon",
  EXPIRED: "expired",
  NO_CERTIFICATE: "no certificate on file",
  UNKNOWN_DATE: "completion date needed",
  PENDING_VERIFICATION: "awaiting verification",
  COMPLIANT: "compliant",
};

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * Build the flat render-engine context for the compliance-reminder template.
 * All derived display strings are computed here so the template body is pure
 * interpolation.
 */
export function complianceReminderContext(p: ComplianceReminderParams): Record<string, unknown> {
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
    case "PENDING_VERIFICATION":
      statusLine = "Your HIPAA certificate is on file and awaiting verification by a coordinator.";
      break;
    // unreachable: callers filter COMPLIANT before building a reminder context
    default:
      throw new Error(`Unexpected reminder status: ${p.status}`);
  }
  return {
    personName: p.personName,
    statusLine,
  };
}

/**
 * Build the flat render-engine context for the compliance-escalation template.
 */
export function complianceEscalationContext(p: ComplianceEscalationParams): Record<string, unknown> {
  return {
    directorName: p.directorName,
    volunteerName: p.volunteerName,
    departmentName: p.departmentName,
    readableStatus: READABLE_STATUS[p.status],
  };
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const complianceDescriptors: TemplateDescriptor[] = [
  {
    key: "compliance-reminder",
    name: "Compliance Reminder",
    category: "transactional",
    variables: [
      { name: "personName", label: "Volunteer name", sampleValue: "Jane Doe" },
      {
        name: "statusLine",
        label: "Status sentence (pre-computed from status + expiry date)",
        sampleValue: "Your HIPAA certification expires on January 15, 2026.",
      },
    ],
    defaultSubject: "[HAVEN] HIPAA certification reminder",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>{{ statusLine }}</p>

<p>Please upload or renew your certificate in My Info.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "compliance-escalation",
    name: "Compliance Escalation",
    category: "transactional",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "volunteerName", label: "Volunteer name", sampleValue: "Jane Doe" },
      { name: "departmentName", label: "Department name", sampleValue: "Cardiology" },
      { name: "readableStatus", label: "Human-readable compliance status", sampleValue: "expired" },
    ],
    defaultSubject: "[HAVEN] Volunteer HIPAA compliance needs attention",
    defaultBody: `<p>Hello {{ directorName }},</p>

<p>{{ volunteerName }} in {{ departmentName }} is not HIPAA compliant ({{ readableStatus }}) and has not responded to reminders. Please follow up.</p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
