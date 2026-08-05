/**
 * Compliance email templates for HAVEN Hub.
 *
 * These cover the HIPAA certificate lifecycle: the member-facing reminder for a cert
 * that is expiring, expired, or missing, the manager-facing date-review and
 * verification-review notices, and the member-facing "your certificate is verified"
 * confirmation. Everything else needed for clearance lives in ./clearance.ts.
 *
 * Each template is expressed as a TemplateDescriptor (for the registry + admin
 * UI) plus a typed context-builder function that maps the original params into
 * the flat string/boolean context the render engine consumes.
 */

import type { ComplianceStatus } from "@/platform/compliance/rules";
import { formatCalendarDate } from "@/platform/dates";
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

/** Format a Date as "Month D, YYYY" using UTC; returns "soon" when null. */
function fmtDate(d: Date | null): string {
  if (d === null) return "soon";
  return formatCalendarDate(d, { month: "long", day: "numeric", year: "numeric" });
}

/** Short human phrase per HIPAA status. Consumed by the director-facing digest. */
export const READABLE_STATUS: Record<ComplianceStatus, string> = {
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
    // No COMPLIANT branch: the engine only calls this for a member whose HIPAA
    // status is actually unsatisfied. A COMPLIANT status reaching here means the
    // caller's gate is wrong, so the default throw below is the right answer.
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

/**
 * Build the context for the compliance-verification-review template, sent to
 * compliance managers when a volunteer's certificate is saved WITH a machine-read
 * completion date but still needs a manager to verify it (PENDING_VERIFICATION).
 * Same shape as the date-review context (volunteer name + master-view link).
 */
export function complianceVerificationReviewContext(p: ComplianceDateReviewParams): Record<string, unknown> {
  return {
    volunteerName: p.volunteerName,
    reviewLink: p.reviewLink,
  };
}

/** Params for the member-facing "your certificate is verified" email. */
export type ComplianceCertVerifiedParams = {
  volunteerName: string;
  myInfoLink: string;
};

/**
 * Build the context for the compliance-cert-verified template, sent to the
 * certificate OWNER when a manager verifies it. Every other compliance template
 * in this file is manager-facing; this one closes the loop back to the member,
 * who is blocked by the gate until this happens.
 */
export function complianceCertVerifiedContext(p: ComplianceCertVerifiedParams): Record<string, unknown> {
  return {
    volunteerName: p.volunteerName,
    myInfoLink: p.myInfoLink,
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
    ],
    defaultSubject: "[HAVEN] HIPAA certification reminder",
    defaultBody: `<p>Hello {{ personName }},</p>

<p>{{ statusLine }}</p>

{{#if showCta}}<p>Please upload or renew your certificate in <a href="{{ ctaUrl }}">HAVEN Hub</a>.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 18px;">
  <tr>
    <td style="border-radius: 6px; background-color: {{ brandColor }};">
      <a href="{{ ctaUrl }}" style="display: inline-block; padding: 12px 24px; font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none;">Open HAVEN Hub &rarr;</a>
    </td>
  </tr>
</table>{{else}}<p>{{ actionLine }}</p>{{/if}}

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
  {
    key: "compliance-verification-review",
    name: "Compliance: verification review",
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
    defaultSubject: "[HAVEN] HIPAA certificate awaiting verification",
    defaultBody: `<p>Hello,</p>

<p>{{ volunteerName }} uploaded a HIPAA certificate with a completion date, but it must be verified before the volunteer can be cleared. Please review the certificate and verify it.</p>

<p><a href="{{ reviewLink }}">Open the compliance master view</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "compliance-cert-verified",
    name: "Compliance: certificate verified (member)",
    category: "transactional",
    group: "compliance",
    variables: [
      { name: "volunteerName", label: "Volunteer name", sampleValue: "Jane Doe" },
      {
        name: "myInfoLink",
        label: "Link to the member's own info page",
        sampleValue: "https://hub.havenfreeclinic.org/my-info",
      },
    ],
    defaultSubject: "[HAVEN] Your HIPAA certificate is verified",
    defaultBody: `<p>Hi {{ volunteerName }},</p>

<p>A compliance manager has confirmed your HIPAA certificate. Nothing further is needed from you for this requirement.</p>

<p><a href="{{ myInfoLink }}">View your certificate</a></p>

<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
