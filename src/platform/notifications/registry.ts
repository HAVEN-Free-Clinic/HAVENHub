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
  { key: "compliance-escalation", label: "Compliance escalation (directors)", defaultChannel: "email" },
  { key: "compliance-date-review", label: "HIPAA certificate date review (compliance managers)", defaultChannel: "email" },
  { key: "compliance-verification-review", label: "HIPAA certificate verification review (compliance managers)", defaultChannel: "email" },
  { key: "compliance-cert-verified", label: "HIPAA certificate verified (member)", defaultChannel: "email" },
  { key: "epic-onboarding", label: "Epic onboarding", defaultChannel: "email" },
  { key: "epic-activation", label: "Epic activation", defaultChannel: "email" },
  { key: "epic-password-reset", label: "Epic password reset", defaultChannel: "email" },
  { key: "recruitment.interview_assignment", label: "Recruitment: interview panel assignment", defaultChannel: "email" },
  { key: "recruitment.review_digest", label: "Recruitment: daily review digest (directors)", defaultChannel: "email" },
  { key: "support.ticket_submitted", label: "IT Support: ticket received (requester)", defaultChannel: "email" },
  { key: "support.ticket_manager_alert", label: "IT Support: new-ticket alert (managers)", defaultChannel: "email" },
  { key: "support.request_assigned", label: "IT Support: request assigned", defaultChannel: "email" },
  { key: "support.status_changed", label: "IT Support: status changed", defaultChannel: "email" },
  { key: "support.comment_added", label: "IT Support: new comment", defaultChannel: "email" },
  { key: "support.request_resolved", label: "IT Support: request resolved", defaultChannel: "email" },
  { key: "shift-reminder", label: "Shift reminder", defaultChannel: "email" },
  { key: "incidents.report_submitted", label: "Incident: report submitted (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_requested", label: "Incident: strike requested (reviewers)", defaultChannel: "email" },
  { key: "incidents.strike_decided", label: "Incident: strike decision (reporter)", defaultChannel: "email" },
  { key: "incidents.report_resolved", label: "Incident: report resolved (reporter)", defaultChannel: "email" },
  { key: "incidents.strike_issued", label: "Incident: strike issued (subject)", defaultChannel: "email" },
  { key: "incidents.strike_issued_directors", label: "Incident: strike issued (directors)", defaultChannel: "email" },
];

/** The settings-registry key that stores a type's channel override. */
export function channelSettingKey(typeKey: string): string {
  return `notifications.${typeKey}.channel`;
}
