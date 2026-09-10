import { Badge } from "@/platform/ui/badge";
import { DECISION_LABELS, type Tone } from "./status-badge";
import type { Decision } from "@/modules/recruitment/engine/decision-summary";

/**
 * The two numbers an interview list prints, named so they cannot be confused.
 *
 * Both interview lists rendered a bare `N/M` chip, one nav hop apart, meaning
 * two different things: on /recruitment/interviews it was the panelist's SCORE
 * out of five, and on /recruitment/cycles/[id]/interviews it was how many of the
 * panel had submitted an evaluation. A recruitment lead who also sits on panels
 * reads both in one session, so "2/5" was a good score to one page and a stalled
 * panel to the other, with nothing in the cell to say which.
 *
 * The fix is not a shared chip. It is two chips that say what they are.
 */

/** A panelist's own score for a candidate. */
export function ScoreBadge({ score, outOf = 5 }: { score: number; outOf?: number }) {
  return (
    <Badge tone="brand">
      Scored {score}/{outOf}
    </Badge>
  );
}

/**
 * How much of the panel has evaluated.
 *
 * Never claims more evaluations than panelists: a stray evaluation from someone
 * since removed from the panel would otherwise read as "3 of 2".
 */
export function EvalProgress({ done, panelists }: { done: number; panelists: number }) {
  if (panelists === 0) return <span className="text-subtle-foreground">-</span>;
  const shown = Math.min(done, panelists);
  return (
    <span className="text-foreground-soft whitespace-nowrap">
      {shown} of {panelists} evals
    </span>
  );
}

/**
 * Where an interview stands, in the vocabulary both interview lists now speak.
 *
 * This was a private helper on /recruitment/cycles/[id]/interviews. The
 * panelist's own list at /recruitment/interviews, one nav hop away and listing
 * the same interviews, had no status column at all: Candidate / Dept / When /
 * Your eval, where "Pending" means "you have not evaluated yet" and nothing on
 * the row said whether a decision already existed. A panelist could not tell a
 * live assignment from a closed one without opening each detail page.
 *
 * The precedence comment moved here with the function, because it is the record
 * of why the order is what it is: withdrawal outranks both the decision and the
 * schedule, and it is the one fact the cycle list used to omit. The panelist's
 * list badged it (and the service deliberately keeps a withdrawn applicant's row
 * precisely so nobody dials into a cancelled call), while the lead running the
 * cycle saw "Scheduled" and had no idea the candidate had gone.
 */
export function interviewStatus(iv: {
  scheduledAt: Date | null;
  // The Decision enum, not a bare string: a loose type here is what let the raw
  // constant fall through an `?? iv.decision` escape hatch in the original.
  decision: Decision;
  application: { status: string };
}): { label: string; tone: Tone } {
  if (iv.application.status === "WITHDRAWN") return { label: "Withdrawn", tone: "warning" };
  if (iv.decision !== "PENDING") {
    const tone: Tone =
      iv.decision === "ACCEPT" ? "success" : iv.decision === "REJECT" ? "critical" : "warning";
    return { label: DECISION_LABELS[iv.decision], tone };
  }
  return iv.scheduledAt ? { label: "Scheduled", tone: "brand" } : { label: "Offered", tone: "default" };
}

/** The chip form of `interviewStatus`, for an interview list's Status column. */
export function InterviewStatusBadge({
  interview,
}: {
  interview: Parameters<typeof interviewStatus>[0];
}) {
  const s = interviewStatus(interview);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
