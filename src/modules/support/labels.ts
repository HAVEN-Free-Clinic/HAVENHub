import type { TechRequestCategory, TechRequestPriority } from "@prisma/client";

/** Friendly category text (never the raw enum) for the submit form, list rows, and ticket detail headers. */
export const CATEGORY_LABELS: Record<TechRequestCategory, string> = {
  EPIC: "Epic access",
  DUO_MFA: "DUO MFA",
  GENERAL_IT: "General IT",
  TEAMS: "Teams access",
  OTHER: "Other",
};

/** Friendly priority text (never the raw enum) for the filter bar and the manager control panel. */
export const PRIORITY_LABELS: Record<TechRequestPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};
