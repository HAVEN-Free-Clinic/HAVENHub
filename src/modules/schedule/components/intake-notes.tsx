import type { BuilderMemberIntake } from "@/modules/schedule/services/builder";

// ---------------------------------------------------------------------------
// Training-intake notes
// ---------------------------------------------------------------------------

/**
 * Renders the scheduling preferences a member gave during training intake so
 * directors can use them while building. Returns null when the member left
 * everything blank.
 */
export function IntakeNotes({
  intake,
  className = "",
}: {
  intake: BuilderMemberIntake;
  className?: string;
}) {
  const { minShiftsWanted, additionalShiftAvailability, feedback } = intake;
  if (!minShiftsWanted && !additionalShiftAvailability && !feedback) return null;

  const border = "border-border";
  const body = "text-muted-foreground";
  const label = "text-foreground";

  return (
    <div className={`mt-2 space-y-0.5 border-t ${border} pt-2 text-xs ${body} ${className}`}>
      {minShiftsWanted && (
        <p>
          <span className={`font-semibold ${label}`}>Wants</span> {minShiftsWanted}+ shifts this term
        </p>
      )}
      {additionalShiftAvailability && (
        <p>
          <span className={`font-semibold ${label}`}>Availability:</span> {additionalShiftAvailability}
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
