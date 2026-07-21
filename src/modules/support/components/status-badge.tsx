/**
 * SupportStatusBadge: neutral chip + status dot for a TechRequest's lifecycle
 * state. No tinted fills (see Badge) - only the small leading dot carries color.
 *
 * Tone choices mirror existing status-badge conventions elsewhere in the app
 * (see onboarding-checklist's StatusPill and the Epic requests page's
 * STATUS_TONE): an open/new state reads neutral, active work reads brand,
 * anything waiting on a person reads warning, a good terminal state reads
 * success, a quiet terminal state reads default, and an abandoned state reads
 * critical.
 */

import type { TechRequestStatus } from "@prisma/client";
import { Badge } from "@/platform/ui/badge";

/** Short, friendly status text (never the raw enum). */
export const STATUS_LABELS: Record<TechRequestStatus, string> = {
  SUBMITTED: "Submitted",
  IN_PROGRESS: "In progress",
  // Viewer-neutral: this label renders on manager surfaces too (triage list, status
  // dropdown), where "Awaiting you" would wrongly read as awaiting the manager.
  AWAITING_REQUESTER: "Awaiting requester",
  AWAITING_YNHH: "Awaiting YNHH",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const STATUS_TONES: Record<TechRequestStatus, Tone> = {
  SUBMITTED: "default",
  IN_PROGRESS: "brand",
  AWAITING_REQUESTER: "warning",
  AWAITING_YNHH: "warning",
  RESOLVED: "success",
  CLOSED: "default",
  CANCELLED: "critical",
};

export function SupportStatusBadge({ status }: { status: TechRequestStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}
