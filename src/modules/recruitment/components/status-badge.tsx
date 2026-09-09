import type { CycleStatus } from "@prisma/client";
import { Badge } from "@/platform/ui/badge";
import type { Decision } from "@/modules/recruitment/engine/decision-summary";

/**
 * Recruitment's two status vocabularies, in one place.
 *
 * Built like `SupportStatusBadge`, whose doc comment states the rule these
 * broke: the label is friendly text, never the raw enum. Five recruitment
 * surfaces rendered the database constant directly -- "OPEN", "ARCHIVED", and
 * in prose "This cycle is OPEN." -- while the tone map that coloured them was
 * duplicated byte-for-byte across two files.
 *
 * The decision half had three identical copies of the same label map, one per
 * page that shows an interview outcome.
 */

type Tone = "default" | "brand" | "success" | "warning" | "critical";

/** Short, friendly cycle status (never the raw enum). */
export const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
  ARCHIVED: "Archived",
};

const CYCLE_STATUS_TONES: Record<CycleStatus, Tone> = {
  DRAFT: "default",
  OPEN: "success",
  CLOSED: "warning",
  ARCHIVED: "default",
};

export function CycleStatusBadge({ status }: { status: CycleStatus }) {
  return <Badge tone={CYCLE_STATUS_TONES[status]}>{CYCLE_STATUS_LABELS[status]}</Badge>;
}

/**
 * An interview outcome.
 *
 * The wording is what the three copies of this map already said, deliberately:
 * consolidating them is the point, and quietly renaming "Rejected" on the way
 * through would be an unrequested copy change on three pages at once.
 *
 * PENDING has a label because two of those pages print it as text, but no tone
 * and no badge: the cycle interview list renders a RICHER state for pending
 * (Withdrawn / Scheduled / Offered) that carries more than "pending" does, and
 * flattening it into one chip would lose that.
 */
export const DECISION_LABELS: Record<Decision, string> = {
  PENDING: "Pending",
  ACCEPT: "Accepted",
  REJECT: "Rejected",
  WAITLIST: "Waitlisted",
};

const DECISION_TONES: Record<Exclude<Decision, "PENDING">, Tone> = {
  ACCEPT: "success",
  REJECT: "critical",
  WAITLIST: "warning",
};

export function DecisionBadge({ decision }: { decision: Exclude<Decision, "PENDING"> }) {
  return <Badge tone={DECISION_TONES[decision]}>{DECISION_LABELS[decision]}</Badge>;
}
