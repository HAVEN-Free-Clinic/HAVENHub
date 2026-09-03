import type { AttendanceEventKind } from "@prisma/client";

/** Event-kind wording, shared by the list, the detail page and the kiosk. */
export const KIND_LABELS: Record<AttendanceEventKind, string> = {
  TRAINING: "Training session",
  INFO_SESSION: "Info session",
  OTHER: "Other event",
};

/**
 * Badge tone per kind. Training is the one kind whose check-ins change a
 * member's clearance (it completes their training), so it carries the accent
 * tone; the other two only record who was there.
 */
export function kindTone(kind: AttendanceEventKind): "brand" | "default" {
  return kind === "TRAINING" ? "brand" : "default";
}
