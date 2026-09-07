import { Badge } from "@/platform/ui/badge";

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
