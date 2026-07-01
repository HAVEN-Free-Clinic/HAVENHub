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
  /**
   * Base URL of the hub (e.g. https://hub.havenfreeclinic.org), used to build the
   * "Open HAVEN Hub" call-to-action that links the member to My Info. The sole
   * production caller (reminders.ts) always supplies it.
   */
  appUrl?: string;
  /** Resolved `branding.brandColor`, used for the CTA button background. */
  brandColor?: string;
  /** Names of required EHS trainings the member has not yet completed. */
  ehsMissing?: string[];
};

export type ComplianceEscalationParams = {
  directorName: string;
  volunteerName: string;
  departmentName: string;
  status: ComplianceStatus;
  /** Names of required EHS trainings the volunteer has not yet completed. */
  ehsMissing?: string[];
};

export type ComplianceDateReviewParams = {
  /** The volunteer whose certificate landed without a parsed completion date. */
  volunteerName: string;
  /** Absolute URL to the compliance master view where the date is entered. */
  reviewLink: string;
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
  // Actionable statuses (EXPIRING_SOON / EXPIRED / NO_CERTIFICATE) get a call-to-
  // action into HAVEN Hub: the member can fix them by uploading a fresh
  // certificate. The CTA (inline link + button) lives in the template, gated by
  // `showCta`.
  //
  // UNKNOWN_DATE and PENDING_VERIFICATION are waiting on a coordinator (to set the
  // completion date / verify it), so the member has no reliable self-serve fix; we
  // reassure them via `actionLine` and show no CTA.
  let statusLine: string;
  let actionLine = "";
  let showCta = false;
  switch (p.status) {
    case "EXPIRING_SOON":
      statusLine = `Your HIPAA certification expires on ${fmtDate(p.expiresAt)}.`;
      showCta = true;
      break;
    case "EXPIRED":
      statusLine = `Your HIPAA certification expired on ${fmtDate(p.expiresAt)}.`;
      showCta = true;
      break;
    case "NO_CERTIFICATE":
      statusLine = "We do not have a current HIPAA certificate on file for you.";
      showCta = true;
      break;
    case "UNKNOWN_DATE":
      // The certificate IS on file; only the parsed completion date is missing,
      // which only a coordinator can supply. Do not tell the member they have no
      // cert or to re-upload.
      statusLine =
        "Your HIPAA certificate is on file, and our compliance team is confirming the completion date.";
      actionLine =
        "No action is needed from you right now. A coordinator will record the completion date before your certificate counts toward your clearance.";
      break;
    case "PENDING_VERIFICATION":
      statusLine = "Your HIPAA certificate is on file and awaiting verification by a coordinator.";
      actionLine =
        "No action is needed from you right now. A coordinator will verify your certificate before it counts toward your clearance.";
      break;
    case "COMPLIANT":
      // HIPAA is current, but the person has outstanding EHS items (otherwise
      // isFullyCompliant would have prevented a reminder from being sent).
      statusLine = "Your HIPAA certificate is on file and current.";
      actionLine = "No HIPAA action is needed from you right now.";
      break;
    default:
      throw new Error(`Unexpected reminder status: ${p.status}`);
  }

  return {
    personName: p.personName,
    statusLine,
    actionLine,
    showCta,
    ctaUrl: `${p.appUrl ?? ""}/my-info`,
    brandColor: p.brandColor ?? "",
    ehsMissingList: (p.ehsMissing ?? []).join(", "),
    hasEhsGap: (p.ehsMissing ?? []).length > 0,
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
    ehsMissingList: (p.ehsMissing ?? []).join(", "),
    hasEhsGap: (p.ehsMissing ?? []).length > 0,
    hipaaActionable: p.status !== "COMPLIANT",
  };
}

/**
 * Build the flat render-engine context for the compliance-date-review template,
 * sent to compliance managers when a volunteer's certificate is saved without a
 * machine-readable completion date.
 */
export function complianceDateReviewContext(p: ComplianceDateReviewParams): Record<string, unknown> {
  return {
    volunteerName: p.volunteerName,
    reviewLink: p.reviewLink,
  };
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const complianceDescriptors: TemplateDescriptor[] = [
  {
    key: "compliance-reminder",
    name: "Compliance: reminder",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "personName", label: "Volunteer name", sampleValue: "Jane Doe" },
      {
        name: "statusLine",
        label: "Status sentence (pre-computed from status + expiry date)",
        sampleValue: "Your HIPAA certification expires on January 15, 2026.",
      },
      {
        name: "actionLine",
        label: "Reassurance sentence shown when no action is possible (UNKNOWN_DATE / PENDING_VERIFICATION)",
        sampleValue: "No action is needed from you right now.",
      },
      {
        name: "showCta",
        label: "Show the 'Open HAVEN Hub' call-to-action (true for actionable statuses)",
        sampleValue: "true",
      },
      {
        name: "ctaUrl",
        label: "Absolute link to My Info in HAVEN Hub",
        sampleValue: "https://hub.havenfreeclinic.org/my-info",
      },
      {
        name: "brandColor",
        label: "Brand color for the call-to-action button background (hex)",
        sampleValue: "#00356b",
      },
      { name: "ehsMissingList", label: "Comma-separated list of missing required EHS training names", sampleValue: "Blood Borne Pathogens" },
      { name: "hasEhsGap", label: "True when one or more required EHS trainings are incomplete", sampleValue: "false" },
    ],
    defaultSubject: "[HAVEN] Compliance reminder",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>{{ statusLine }}</p>

{{#if showCta}}<p>Please upload or renew your certificate in <a href="{{ ctaUrl }}">HAVEN Hub</a>.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Open HAVEN Hub &rarr;</a>
    </td>
  </tr>
</table>{{else}}<p>{{ actionLine }}</p>{{/if}}{{#if hasEhsGap}}

<p>Your EHS training is incomplete. The following item(s) still need to be completed: {{ ehsMissingList }}.</p><p>Please complete these through Yale EHS. Reach out to your director if you are unsure how.</p>{{/if}}

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "compliance-escalation",
    name: "Compliance: escalation",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "volunteerName", label: "Volunteer name", sampleValue: "Jane Doe" },
      { name: "departmentName", label: "Department name", sampleValue: "Cardiology" },
      { name: "readableStatus", label: "Human-readable HIPAA compliance status", sampleValue: "expired" },
      { name: "ehsMissingList", label: "Comma-separated list of missing required EHS training names", sampleValue: "Blood Borne Pathogens" },
      { name: "hasEhsGap", label: "True when one or more required EHS trainings are incomplete", sampleValue: "false" },
      { name: "hipaaActionable", label: "True when the HIPAA status itself is non-compliant (false when only EHS is outstanding)", sampleValue: "true" },
    ],
    defaultSubject: "[HAVEN] Volunteer compliance needs attention",
    defaultBody: `<p>Hello {{ directorName }},</p>

{{#if hipaaActionable}}<p>{{ volunteerName }} in {{ departmentName }} is not HIPAA compliant ({{ readableStatus }}) and has not responded to reminders. Please follow up.</p>{{else}}<p>{{ volunteerName }} in {{ departmentName }} has outstanding required EHS training and has not responded to reminders. Please follow up.</p>{{/if}}{{#if hasEhsGap}}

<p>Outstanding EHS training: {{ ehsMissingList }}.</p>{{/if}}

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "compliance-date-review",
    name: "Compliance: date review",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "volunteerName", label: "Volunteer name", sampleValue: "Jane Doe" },
      {
        name: "reviewLink",
        label: "Link to the compliance master view",
        sampleValue: "https://hub.havenfreeclinic.org/volunteers/master",
      },
    ],
    defaultSubject: "[HAVEN] HIPAA certificate needs a completion date",
    defaultBody: `<p>Hello,</p>

<p>{{ volunteerName }} uploaded a HIPAA certificate, but the completion date could not be read automatically. Please review the certificate and set the completion date so the volunteer can be cleared.</p>

<p><a href="{{ reviewLink }}">Open the compliance master view</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
