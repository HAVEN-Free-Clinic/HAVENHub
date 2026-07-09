import type { TechRequestCategory } from "@prisma/client";

/** Friendly category text (never the raw enum) for the submit form, list rows, and ticket detail headers. */
export const CATEGORY_LABELS: Record<TechRequestCategory, string> = {
  EPIC: "Epic access",
  DUO_MFA: "DUO MFA",
  GENERAL_IT: "General IT",
  TEAMS: "Teams access",
  OTHER: "Other",
};
