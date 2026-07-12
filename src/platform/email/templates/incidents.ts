/**
 * Incident Reports email templates for HAVEN Hub.
 *
 * Four templates cover the incident-report lifecycle:
 *   - incidents.report_submitted: sent to reviewers (incidents.manage) when a
 *     new report is filed.
 *   - incidents.strike_requested: sent to reviewers when a director-filed
 *     report also requests a disciplinary strike against the subject.
 *   - incidents.strike_decided: sent to the reporter once a reviewer approves
 *     or declines a pending strike request on their report.
 *   - incidents.report_resolved: sent to the reporter once a reviewer marks
 *     their report RESOLVED or DISMISSED.
 *
 * Each template is expressed as a TemplateDescriptor (for the registry + admin
 * UI) plus a typed context-builder function that maps the caller's params into
 * the flat string/boolean context the render engine consumes. All derived
 * display strings (e.g. "resolved" vs "dismissed") are precomputed here so the
 * template bodies stay pure interpolation -- the render engine has no
 * {{#each}}, only {{ var }}, {{#if}}/{{else}}/{{/if}}, and {{{ raw }}}.
 */

import type { TemplateDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

export type ReportSubmittedParams = {
  reviewerName: string;
  reportNumber: number;
  /** Comma-separated, human-readable concern type labels (e.g. "Patient Safety, Professional Conduct"). */
  concernSummary: string;
  immediateRisk: boolean;
  /** Absolute link into the reviewer queue. */
  reviewLink: string;
};

export type StrikeRequestedParams = {
  reviewerName: string;
  reportNumber: number;
  /** Comma-separated names of the people a strike is being requested against. */
  subjectNames: string;
  /** Absolute link into the reviewer queue. */
  reviewLink: string;
};

export type StrikeDecidedParams = {
  reporterName: string;
  reportNumber: number;
  approved: boolean;
};

export type ReportResolvedParams = {
  reporterName: string;
  reportNumber: number;
  /** true when the report was RESOLVED, false when DISMISSED. */
  approved: boolean;
  /** Absolute link to the reporter's own report. */
  reportLink: string;
};

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/** Build the flat render-engine context for incidents.report_submitted. */
export function reportSubmittedContext(p: ReportSubmittedParams): Record<string, unknown> {
  return {
    reviewerName: p.reviewerName,
    reportNumber: String(p.reportNumber),
    concernSummary: p.concernSummary,
    immediateRisk: p.immediateRisk,
    reviewLink: p.reviewLink,
  };
}

/** Build the flat render-engine context for incidents.strike_requested. */
export function strikeRequestedContext(p: StrikeRequestedParams): Record<string, unknown> {
  return {
    reviewerName: p.reviewerName,
    reportNumber: String(p.reportNumber),
    subjectNames: p.subjectNames,
    reviewLink: p.reviewLink,
  };
}

/** Build the flat render-engine context for incidents.strike_decided. */
export function strikeDecidedContext(p: StrikeDecidedParams): Record<string, unknown> {
  return {
    reporterName: p.reporterName,
    reportNumber: String(p.reportNumber),
    approved: p.approved,
  };
}

/** Build the flat render-engine context for incidents.report_resolved. */
export function reportResolvedContext(p: ReportResolvedParams): Record<string, unknown> {
  return {
    reporterName: p.reporterName,
    reportNumber: String(p.reportNumber),
    outcome: p.approved ? "resolved" : "dismissed",
    reportLink: p.reportLink,
  };
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

export const incidentsDescriptors: TemplateDescriptor[] = [
  {
    key: "incidents.report_submitted",
    name: "Incident: report submitted (reviewers)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "reviewerName", label: "Reviewer name", sampleValue: "Dr. Smith" },
      { name: "reportNumber", label: "Report number", sampleValue: "42" },
      { name: "concernSummary", label: "Comma-separated concern types", sampleValue: "Professional Conduct" },
      { name: "immediateRisk", label: "True when flagged as immediate risk", sampleValue: "false" },
      { name: "reviewLink", label: "Link to the review queue", sampleValue: "https://hub.havenfreeclinic.org/incidents/review" },
    ],
    defaultSubject: "New incident report #{{ reportNumber }}",
    defaultBody: `<p>Hello {{ reviewerName }},</p>
{{#if immediateRisk}}<p><strong>This report is flagged as an immediate risk and needs urgent attention.</strong></p>{{/if}}
<p>Incident report #{{ reportNumber }} was submitted ({{ concernSummary }}).</p>
<p><a href="{{ reviewLink }}">Open the review queue</a></p>
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "incidents.strike_requested",
    name: "Incident: strike requested (reviewers)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "reviewerName", label: "Reviewer name", sampleValue: "Dr. Smith" },
      { name: "reportNumber", label: "Report number", sampleValue: "42" },
      { name: "subjectNames", label: "Names the strike is requested against (comma-separated)", sampleValue: "Jane Doe, John Roe" },
      { name: "reviewLink", label: "Link to the review queue", sampleValue: "https://hub.havenfreeclinic.org/incidents/review" },
    ],
    defaultSubject: "Strike requested on incident report #{{ reportNumber }}",
    defaultBody: `<p>Hello {{ reviewerName }},</p>
<p>Incident report #{{ reportNumber }} includes a request to issue a disciplinary strike against {{ subjectNames }}.</p>
<p><a href="{{ reviewLink }}">Open the review queue</a></p>
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "incidents.strike_decided",
    name: "Incident: strike decision (reporter)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "reporterName", label: "Reporter name", sampleValue: "Jane Doe" },
      { name: "reportNumber", label: "Report number", sampleValue: "42" },
      { name: "approved", label: "True when the strike was approved, false when declined", sampleValue: "true" },
    ],
    defaultSubject: "Strike decision on incident report #{{ reportNumber }}",
    defaultBody: `<p>Hello {{ reporterName }},</p>
{{#if approved}}<p>A reviewer has approved the strike you requested on incident report #{{ reportNumber }}.</p>{{else}}<p>A reviewer has declined the strike you requested on incident report #{{ reportNumber }}.</p>{{/if}}
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "incidents.report_resolved",
    name: "Incident: report resolved (reporter)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "reporterName", label: "Reporter name", sampleValue: "Jane Doe" },
      { name: "reportNumber", label: "Report number", sampleValue: "42" },
      { name: "outcome", label: "Precomputed outcome word: resolved or dismissed", sampleValue: "resolved" },
      { name: "reportLink", label: "Link to the reporter's own report", sampleValue: "https://hub.havenfreeclinic.org/incidents/mine" },
    ],
    defaultSubject: "Incident report #{{ reportNumber }} {{ outcome }}",
    defaultBody: `<p>Hello {{ reporterName }},</p>
<p>Your incident report #{{ reportNumber }} has been {{ outcome }}.</p>
<p><a href="{{ reportLink }}">View your report</a></p>
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "incidents.strike_issued",
    name: "Incident: strike issued (subject)",
    category: "transactional" as const,
    group: "incidents" as const,
    variables: [
      { name: "subjectName", label: "Subject first name", sampleValue: "Alex" },
      { name: "category", label: "Strike category", sampleValue: "Attendance" },
      { name: "description", label: "Strike description", sampleValue: "No-show to assigned clinic shift on July 15, 2026." },
      { name: "issuedBy", label: "Issued by name", sampleValue: "Caprice Culkin" },
      { name: "issuedDate", label: "Date issued", sampleValue: "July 15, 2026" },
    ],
    defaultSubject: "A disciplinary action has been recorded against you",
    defaultBody: `<p>Hi {{ subjectName }},</p>
<p>A disciplinary action has been officially recorded against you.</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0">
  <tr><td style="font-weight:600;padding-right:12px">Category</td><td>{{ category }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Date</td><td>{{ issuedDate }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Issued by</td><td>{{ issuedBy }}</td></tr>
</table>
<p><strong>Details:</strong><br>{{ description }}</p>
<p>If you have questions or believe this was issued in error, please reach out to your department directors or the HAVEN Executive Directors at <a href="mailto:haven.free.clinic@yale.edu">haven.free.clinic@yale.edu</a>.</p>`,
  },
];
