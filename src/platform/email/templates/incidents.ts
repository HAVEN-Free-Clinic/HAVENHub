/**
 * Incident Reports email templates for HAVEN Hub.
 *
 * Six templates cover the incident-report lifecycle:
 *   - incidents.report_submitted: sent to reviewers (incidents.manage) when a
 *     new report is filed.
 *   - incidents.strike_requested: sent to reviewers when a director-filed
 *     report also requests a disciplinary strike against the subject.
 *   - incidents.strike_decided: sent to the reporter once a reviewer approves
 *     or declines a pending strike request on their report.
 *   - incidents.report_resolved: sent to the reporter once a reviewer marks
 *     their report RESOLVED or DISMISSED.
 *   - incidents.strike_issued: sent to the subject once a disciplinary action
 *     is recorded against them.
 *   - incidents.strike_issued_directors: sent to the directors of the
 *     subject's active departments, unless the strike is confidential.
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

export type StrikeIssuedDirectorsParams = {
  directorName: string;
  /** Full name of the person the strike was issued against. */
  subjectName: string;
  category: string;
  /** The incident's date: a preformatted UTC calendar-day marker, never zone-shifted. */
  occurredDate: string;
  issuedBy: string;
  /** The subject's running strike total, preformatted. */
  strikeCount: string;
  /** Absolute link to the strikes ledger. */
  ledgerLink: string;
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

/** Build the flat render-engine context for incidents.forwarded_external. */
export function forwardedExternalContext(p: {
  recipientName: string;
  subjectLine: string;
  concernSummary: string;
  immediateRisk: boolean;
  forwardedBy: string;
  note: string;
}): Record<string, unknown> {
  return {
    recipientName: p.recipientName,
    subjectLine: p.subjectLine,
    concernSummary: p.concernSummary,
    immediateRisk: p.immediateRisk,
    forwardedBy: p.forwardedBy,
    note: p.note,
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

/** Build the flat render-engine context for incidents.strike_issued_directors. */
export function strikeIssuedDirectorsContext(
  p: StrikeIssuedDirectorsParams
): Record<string, unknown> {
  return {
    directorName: p.directorName,
    subjectName: p.subjectName,
    category: p.category,
    occurredDate: p.occurredDate,
    issuedBy: p.issuedBy,
    strikeCount: p.strikeCount,
    ledgerLink: p.ledgerLink,
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
{{#if reviewLink}}<p><a href="{{ reviewLink }}">Open the review queue</a></p>{{/if}}
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
  {
    key: "incidents.forwarded_external",
    name: "Incident: forwarded to an external supervisor",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "recipientName", label: "Recipient name, or 'Colleague'", sampleValue: "Dr. Smith" },
      { name: "subjectLine", label: "What is being forwarded", sampleValue: "Incident report #42" },
      { name: "concernSummary", label: "Comma-separated concern types", sampleValue: "Professional Conduct" },
      { name: "immediateRisk", label: "True when flagged as immediate risk", sampleValue: "false" },
      { name: "forwardedBy", label: "The reviewer who forwarded it", sampleValue: "Dr. Jane Doe" },
      { name: "note", label: "The reviewer's covering note (may be blank)", sampleValue: "Please review before Saturday." },
    ],
    defaultSubject: "{{ subjectLine }}: forwarded for your awareness",
    // No link and no verbatim description, exactly as the blind-copy send it
    // replaces: the recipient has no Hub account to follow a link with, and the
    // point is awareness that an incident occurred, not distribution of the
    // account. The reviewer's note is the only free text, and it is theirs.
    defaultBody: `<p>Hello {{ recipientName }},</p>
{{#if immediateRisk}}<p><strong>This has been flagged as an immediate risk.</strong></p>{{/if}}
<p>{{ forwardedBy }} has forwarded {{ subjectLine }} ({{ concernSummary }}) to you for your awareness.</p>
{{#if note}}<p>{{ note }}</p>{{/if}}
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
{{#if reviewLink}}<p><a href="{{ reviewLink }}">Open the review queue</a></p>{{/if}}
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
      { name: "occurredDate", label: "Date of incident", sampleValue: "July 15, 2026" },
    ],
    defaultSubject: "A disciplinary action has been recorded against you",
    defaultBody: `<p>Hi {{ subjectName }},</p>
<p>A disciplinary action has been officially recorded against you.</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0">
  <tr><td style="font-weight:600;padding-right:12px">Category</td><td>{{ category }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Date of incident</td><td>{{ occurredDate }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Issued by</td><td>{{ issuedBy }}</td></tr>
</table>
<p><strong>Details:</strong><br>{{ description }}</p>
<p>If you have questions or believe this was issued in error, please reach out to your department directors or the HAVEN Executive Directors at <a href="mailto:haven.free.clinic@yale.edu">haven.free.clinic@yale.edu</a>.</p>`,
  },
  {
    key: "incidents.strike_issued_directors",
    name: "Incident: strike issued (directors)",
    category: "transactional",
    group: "incidents",
    variables: [
      { name: "directorName", label: "Director name", sampleValue: "Dr. Smith" },
      { name: "subjectName", label: "Name of the person the strike is against", sampleValue: "Alex Rivera" },
      { name: "category", label: "Strike category", sampleValue: "Attendance" },
      { name: "occurredDate", label: "Date of incident", sampleValue: "July 15, 2026" },
      { name: "issuedBy", label: "Issued by name", sampleValue: "Caprice Culkin" },
      { name: "strikeCount", label: "The person's running strike total", sampleValue: "2" },
      { name: "ledgerLink", label: "Link to the strikes ledger", sampleValue: "https://hub.havenfreeclinic.org/incidents/strikes" },
    ],
    defaultSubject: "Disciplinary action recorded for {{ subjectName }}",
    defaultBody: `<p>Hello {{ directorName }},</p>
<p>A disciplinary action was recorded against {{ subjectName }}, a member of a department you direct. They now have {{ strikeCount }} on file.</p>
<table role="presentation" style="border-collapse:collapse;margin:16px 0">
  <tr><td style="font-weight:600;padding-right:12px">Category</td><td>{{ category }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Date of incident</td><td>{{ occurredDate }}</td></tr>
  <tr><td style="font-weight:600;padding-right:12px">Issued by</td><td>{{ issuedBy }}</td></tr>
</table>
{{#if ledgerLink}}<p><a href="{{ ledgerLink }}">Open the strikes ledger</a></p>{{/if}}
<p>Thank you,<br>HAVEN Free Clinic</p>`,
  },
];
