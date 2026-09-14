import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import {
  AI_DIMENSIONS,
  AI_DISAGREEMENT_THRESHOLD,
  AI_REVIEW_ATTENTION_FLAGS,
  aiRerouteSuggestion,
  aiReviewFlagLabel,
  aiScoreGap,
  formatAiGap,
  isAiReviewFlag,
} from "@/modules/recruitment/engine/ai-review";
import type { AiReviewView } from "@/modules/recruitment/services/ai-review";

type Props = {
  review: AiReviewView;
  committeeAverage: number | null;
  routedDepartmentCode: string | null;
  departmentChoices: string[];
  /** Department code to name, for the codes this card mentions. A code missing
   *  here renders as itself. */
  departmentNames: Record<string, string>;
};

/**
 * The AI reviewer's advisory read on the applicant detail page, for recruitment
 * leads. It sits in the review rail beside the committee score and above the
 * routing control, because what it is most often for is a routing call: the
 * applicant is strong, but not for the department they picked.
 *
 * Server-renderable (no hooks, no client state): it is plain markup over one row.
 */
export function AiReviewCard({ review, committeeAverage, routedDepartmentCode, departmentChoices, departmentNames }: Props) {
  const name = (code: string) => (departmentNames[code] ? `${departmentNames[code]} (${code})` : code);
  const reroute = aiRerouteSuggestion({
    bestFitDepartmentCode: review.bestFitDepartmentCode,
    routedDepartmentCode,
    departmentChoices,
  });
  const gap = aiScoreGap(committeeAverage, review.score);
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <SectionHeader>AI reviewer</SectionHeader>
        <Badge title="Not a committee score. Never counted in the committee average, routing tiers or score assignments.">
          Advisory
        </Badge>
      </div>
      <p className="mt-1 text-xs text-subtle-foreground">
        {review.score}/5 · rank {review.rank} · {review.runLabel}
      </p>
      <p className="mt-1 text-xs text-subtle-foreground">
        {gap == null ? (
          "No committee score to compare yet."
        ) : (
          <>
            Committee {committeeAverage!.toFixed(1)} avg, {formatAiGap(gap)} against the AI
            {Math.abs(gap) >= AI_DISAGREEMENT_THRESHOLD && (
              <Badge tone="warning" className="ml-1.5">
                Big gap
              </Badge>
            )}
          </>
        )}
      </p>

      {reroute ? (
        <Alert tone="warning" className="mt-3">
          <p className="font-medium">Suggests re-routing to {name(reroute.to)}</p>
          <p className="mt-1">
            {reroute.from
              ? `${routedDepartmentCode ? "Routed to" : "First choice is"} ${name(reroute.from)}.`
              : "They did not rank a department."}
            {!routedDepartmentCode && review.firstChoiceFit != null && review.firstChoiceDepartmentCode === reroute.from
              ? ` Fit there: ${review.firstChoiceFit}/5.`
              : ""}
          </p>
        </Alert>
      ) : (
        review.bestFitDepartmentCode && (
          <p className="mt-3 text-sm text-foreground-soft">
            Best fit: <strong className="text-foreground">{name(review.bestFitDepartmentCode)}</strong>
          </p>
        )
      )}

      {review.overrideNote && (
        <Alert tone="error" className="mt-3">
          Scored 1 regardless of rank: {review.overrideNote}
        </Alert>
      )}

      <p className="mt-3 text-sm break-words text-foreground-soft [overflow-wrap:anywhere]">{review.justification}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {AI_DIMENSIONS.map((d) => (
          <div key={d.key}>
            <dt className="text-xs text-subtle-foreground" title={d.hint}>
              {d.label}
            </dt>
            <dd className="text-foreground">{review[d.key]}/5</dd>
          </div>
        ))}
      </dl>

      {review.flags.length > 0 && (
        <ul aria-label="AI flags" className="mt-3 flex flex-wrap gap-1.5">
          {review.flags.map((flag) => (
            <li key={flag}>
              <Badge tone={isAiReviewFlag(flag) && AI_REVIEW_ATTENTION_FLAGS.has(flag) ? "warning" : "default"}>
                {aiReviewFlagLabel(flag)}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-subtle-foreground">
        Advisory, from an offline scoring run, and shown to recruitment leads only. A rank band against how many
        the cycle can accept, not an absolute score.
      </p>
    </Card>
  );
}
