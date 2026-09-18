import type { BuilderMemberIntake } from "@/modules/schedule/services/builder";

// ---------------------------------------------------------------------------
// Intake notes
// ---------------------------------------------------------------------------

/**
 * Renders the scheduling preferences a member gave so directors can use them
 * while building: the onboarding contract's shift count, then the note they left
 * on the training quiz. Returns null when the member left everything blank.
 *
 * The availability change request the contract also collects is NOT here. It is
 * a request someone has to decide, not a preference to read while building, so it
 * lives on /schedule/requests with the drop and swap requests, where a director
 * can apply it to the member's availability and it stops being shown once they
 * have. Leaving a copy here would have kept displaying a request already handled,
 * with nothing to say so.
 */
export function IntakeNotes({
  intake,
  className = "",
}: {
  intake: BuilderMemberIntake;
  className?: string;
}) {
  const { preferredShifts, feedback } = intake;
  if (!preferredShifts && !feedback) {
    return null;
  }

  const border = "border-border";
  const body = "text-muted-foreground";
  const label = "text-foreground";

  return (
    <div className={`mt-2 space-y-0.5 border-t ${border} pt-2 text-xs ${body} ${className}`}>
      {preferredShifts && (
        <p>
          <span className={`font-semibold ${label}`}>Prefers</span> {preferredShifts}{" "}
          {preferredShifts === "1" ? "shift" : "shifts"} this term
        </p>
      )}
      {feedback && (
        <p>
          <span className={`font-semibold ${label}`}>Note to directors:</span> {feedback}
        </p>
      )}
    </div>
  );
}
