import { Card } from "@/platform/ui/card";
import type { MyEhsItem } from "@/platform/ehs/services/my-ehs";
import { DateOnly } from "@/platform/dates/display";
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ehsCompletionLabel } from "@/platform/ehs/completion-link";

/**
 * The member's EHS items, in two modes.
 *
 * Read mode (default, /my-info and any viewer without manage_compliance) gives
 * each outstanding item its OWN link, because they do not all live in the same
 * place: Workday holds the courses, while the health requirements (TB baseline,
 * HepB immunity) are done in HealthOnTrack. A single Workday button used to send
 * people to the wrong system for exactly the items holding up their clearance.
 * An item with no link is one a coordinator records for you, so it gets no CTA
 * rather than a button that leads nowhere useful.
 *
 * Manage mode (a compliance manager on /volunteers/compliance/[personId]) swaps
 * those links for the same Mark/Unmark controls as the /volunteers/ehs grid, so a
 * coordinator who has opened one person's record to answer "why am I not cleared?"
 * can fix it there instead of hunting that person down in the grid. Unmarking
 * hard-deletes the completion and its provenance, so it keeps the grid's two-click
 * confirm.
 */
export function EhsPanel({
  items,
  manage,
}: {
  items: MyEhsItem[];
  manage?: {
    /** For the buttons' accessible names only; the action binds the person itself. */
    personName: string;
    toggleAction: (formData: FormData) => Promise<void>;
  };
}) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-sm text-subtle-foreground">
          {manage
            ? "No EHS trainings are required for this member."
            : "No EHS trainings are required for you."}
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-4 text-sm">
            <div className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                {item.complete ? (
                  <span className="text-success-foreground font-medium">Done</span>
                ) : (
                  <span className="text-subtle-foreground">Needed</span>
                )}
                <span>{item.name}</span>
              </span>
              {item.description && (
                <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
                  {item.description}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {item.complete && item.completedAt && (
                <span className="text-xs text-subtle-foreground">
                  completed <DateOnly value={item.completedAt} />
                </span>
              )}
              {manage ? (
                <form action={manage.toggleAction}>
                  <input type="hidden" name="trainingId" value={item.id} />
                  <input type="hidden" name="complete" value={item.complete ? "0" : "1"} />
                  {item.complete ? (
                    <ConfirmButton
                      size="sm"
                      label="Unmark"
                      confirmLabel="Unmark?"
                      aria-label={`Unmark ${item.name} complete for ${manage.personName}`}
                    />
                  ) : (
                    <SubmitButton
                      size="sm"
                      variant="outline"
                      aria-label={`Mark ${item.name} complete for ${manage.personName}`}
                      pendingLabel="Saving…"
                    >
                      Mark complete
                    </SubmitButton>
                  )}
                </form>
              ) : (
                !item.complete &&
                item.completionUrl && (
                  <ExternalLinkButton href={item.completionUrl}>
                    {ehsCompletionLabel(item.completionUrl)}
                  </ExternalLinkButton>
                )
              )}
            </div>
          </li>
        ))}
      </ul>
      {!manage && (
        <p className="mt-4 text-xs text-subtle-foreground">
          Your coordinator records these once EHS shows them complete, so an item can
          stay outstanding here for a few days after you finish it.
        </p>
      )}
    </Card>
  );
}
