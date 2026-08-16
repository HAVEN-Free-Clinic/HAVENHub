/** Where a notification type is delivered. */
export type NotificationChannel = "email" | "teams" | "both";

/** One admin-routable notification type, keyed by its email-template descriptor. */
export interface NotificationType {
  /** Stable key, matches the email template descriptor (e.g. "compliance-reminder"). */
  key: string;
  /** Human label for the admin channel picker. */
  label: string;
  /** Channel used until an admin overrides it. Always "email" so behavior is unchanged on first deploy. */
  defaultChannel: NotificationChannel;
}

/** Every notification type that flows through the notify() dispatcher. */
export const NOTIFICATION_TYPES: NotificationType[] = [
  { key: "compliance-reminder", label: "Compliance reminder", defaultChannel: "email" },
  { key: "onboarding-reminder", label: "Onboarding: outstanding requirements", defaultChannel: "email" },
  { key: "clearance-digest", label: "Clearance: weekly digest (directors)", defaultChannel: "email" },
  { key: "compliance-date-review", label: "HIPAA certificate date review (compliance managers)", defaultChannel: "email" },
  { key: "compliance-verification-review", label: "HIPAA certificate verification review (compliance managers)", defaultChannel: "email" },
  { key: "compliance-cert-verified", label: "HIPAA certificate verified (member)", defaultChannel: "email" },
  { key: "epic-onboarding", label: "Epic onboarding", defaultChannel: "email" },
  { key: "epic-activation", label: "Epic activation", defaultChannel: "email" },
  { key: "epic-password-reset", label: "Epic password reset", defaultChannel: "email" },
  { key: "recruitment.interview_assignment", label: "Recruitment: interview panel assignment", defaultChannel: "email" },
  { key: "recruitment.review_digest", label: "Recruitment: daily review digest (directors)", defaultChannel: "email" },
  { key: "recruitment.applicant_withdrew", label: "Recruitment: applicant withdrew (panel + directors)", defaultChannel: "email" },
  { key: "support.ticket_submitted", label: "IT Support: ticket received (requester)", defaultChannel: "email" },
  { key: "support.ticket_manager_alert", label: "IT Support: new-ticket alert (managers)", defaultChannel: "email" },
  { key: "support.status_changed", label: "IT Support: status changed", defaultChannel: "email" },
  { key: "support.comment_added", label: "IT Support: new comment", defaultChannel: "email" },
  { key: "support.request_resolved", label: "IT Support: request resolved", defaultChannel: "email" },
  { key: "shift-reminder", label: "Shift reminder", defaultChannel: "email" },
  { key: "clinic-checkin-invite", label: "Clinic day: check-in link", defaultChannel: "email" },
  { key: "incidents.report_submitted", label: "Incident: report submitted (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_requested", label: "Incident: strike requested (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_decided", label: "Incident: strike decision (reporter)", defaultChannel: "email" },
  { key: "incidents.report_resolved", label: "Incident: report resolved (reporter)", defaultChannel: "email" },
  { key: "incidents.strike_issued", label: "Incident: strike issued (subject)", defaultChannel: "email" },
  { key: "incidents.strike_issued_directors", label: "Incident: strike issued (directors)", defaultChannel: "email" },
  { key: "volunteers.self_withdrawal", label: "Volunteers: member not returning this term (offboarding managers)", defaultChannel: "email" },
  { key: "volunteers.language_assessed", label: "Volunteers: language assessment result (member)", defaultChannel: "email" },
];

/** The settings-registry key that stores a type's channel override. */
export function channelSettingKey(typeKey: string): string {
  return `notifications.${typeKey}.channel`;
}
