import type { TechRequestCategory, TechRequestPriority, EpicRequestKind, EpicRequestStatus } from "@prisma/client";
import type { Tone } from "@/platform/ui/badge";

/** Badge's tone union under support's own name, kept for the one map below. */
export type SupportTone = Tone;

/** Friendly category text (never the raw enum) for the submit form, list rows, and ticket detail headers. */
export const CATEGORY_LABELS: Record<TechRequestCategory, string> = {
  EPIC: "Epic access",
  DUO_MFA: "DUO MFA",
  GENERAL_IT: "General IT",
  TEAMS: "Teams access",
  HAVEN_HUB: "HAVEN Hub",
  OTHER: "Other",
};

/** Friendly priority text (never the raw enum) for the filter bar and the manager control panel. */
export const PRIORITY_LABELS: Record<TechRequestPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

/** Friendly Epic request kind text (never the raw enum). Shared by the ticket
 *  detail and the Epic Requests tables so both render identical labels. */
export const EPIC_KIND_LABELS: Record<EpicRequestKind, string> = {
  NEW: "New account",
  MODIFY: "Modification",
  RENEW: "Renewal",
  DEACTIVATE: "Deactivation",
};

/** Friendly Epic request status text (never the raw enum). */
export const EPIC_STATUS_LABELS: Record<EpicRequestStatus, string> = {
  PENDING: "Pending",
  SUBMITTED: "Submitted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const EPIC_STATUS_TONE: Record<EpicRequestStatus, SupportTone> = {
  PENDING: "default",
  SUBMITTED: "warning",
  COMPLETED: "success",
  CANCELLED: "critical",
};
