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
  { key: "compliance-reminder", label: "HIPAA compliance reminder", defaultChannel: "email" },
  { key: "compliance-escalation", label: "HIPAA compliance escalation (directors)", defaultChannel: "email" },
  { key: "compliance-date-review", label: "HIPAA certificate date review (compliance managers)", defaultChannel: "email" },
  { key: "epic-onboarding", label: "EPIC onboarding", defaultChannel: "email" },
  { key: "epic-activation", label: "EPIC activation", defaultChannel: "email" },
  { key: "epic-password-reset", label: "EPIC password reset", defaultChannel: "email" },
  { key: "recruitment.interview_assignment", label: "Recruitment: interview panel assignment", defaultChannel: "email" },
];

/** The settings-registry key that stores a type's channel override. */
export function channelSettingKey(typeKey: string): string {
  return `notifications.${typeKey}.channel`;
}
