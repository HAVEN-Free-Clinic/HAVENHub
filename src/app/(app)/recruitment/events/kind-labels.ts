import type { AttendanceEventKind } from "@prisma/client";

/** Event-kind wording, shared by the list, the detail page and the kiosk. */
export const KIND_LABELS: Record<AttendanceEventKind, string> = {
  TRAINING: "Training session",
  INFO_SESSION: "Info session",
  MOCK_CLINIC: "Mock clinic",
  OTHER: "Other event",
};

/**
 * Badge tone per kind. Training and mock clinic are the two parts of training
 * day, the only kinds whose check-ins change a member's clearance, so they
 * carry the accent tone; the others only record who was there.
 */
export function kindTone(kind: AttendanceEventKind): "brand" | "default" {
  return kind === "TRAINING" || kind === "MOCK_CLINIC" ? "brand" : "default";
}
