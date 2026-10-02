import type { FormStatus } from "@prisma/client";

export const FORM_STATUS_LABELS: Record<FormStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
};

export const FORM_STATUS_TONES: Record<FormStatus, "default" | "brand" | "success"> = {
  DRAFT: "default",
  OPEN: "success",
  CLOSED: "default",
};
