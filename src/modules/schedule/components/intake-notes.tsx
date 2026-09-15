import type { BuilderMemberIntake } from "@/modules/schedule/services/builder";

// ---------------------------------------------------------------------------
// Intake notes
// ---------------------------------------------------------------------------

/**
 * Renders the scheduling preferences a member gave so directors can use them
 * while building: the onboarding contract's availability change request and
 * shift count, then the note they left on the training quiz. Returns null when
 * the member left everything blank.
 */
export function IntakeNotes({
  intake,
  className = "",
}: {
  intake: BuilderMemberIntake;
  className?: string;
}) {
  const { availabilityChangeRequest, preferredShifts, feedback } = intake;
  if (!availabilityChangeRequest && !preferredShifts && !feedback) {
    return null;
  }

  const border = "border-border";
  const body = "text-muted-foreground";
  const label = "text-foreground";

  return (
    <div className={`mt-2 space-y-0.5 border-t ${border} pt-2 text-xs ${body} ${className}`}>
      {availabilityChangeRequest && (
        // pre-line: this is a paragraph the member wrote, often a list of
        // dates, and collapsing its line breaks runs the dates together.
        <p className="whitespace-pre-line break-words [overflow-wrap:anywhere]">
          <span className={`font-semibold ${label}`}>Availability change request:</span> {availabilityChangeRequest}
        </p>
      )}
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
