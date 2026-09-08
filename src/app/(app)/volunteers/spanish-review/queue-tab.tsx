import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { EmptyState } from "@/platform/ui/empty-state";
import type { LanguageReviewRow } from "@/platform/languages";
import { SPANISH, formatSpanishScore, spanishScoreTone } from "@/platform/languages/catalog";
import { ScoreOptions } from "@/platform/ui/score-options";

/**
 * The review queue, over both sources.
 *
 * Applicant rows come first and carry an "Applicant" badge: they are blocking a
 * department's accept decision, while a member's claim can wait for the next
 * assessment session. The Cycle / Department column is what tells a reviewer
 * which of the two they are looking at without reading the badge.
 */
export function QueueTab({
  rows,
  assessMemberAction,
  assessApplicantAction,
}: {
  rows: LanguageReviewRow[];
  assessMemberAction: (formData: FormData) => Promise<void>;
  assessApplicantAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">Language review queue</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Everyone awaiting assessment. Applicants come first: their departments assess before
          accepting, so a verdict here goes straight onto the application. Record a 1-5 proficiency
          score for Spanish speakers before verifying: departments differ on the score they will
          staff, so a conversational speaker is useful to someone even when they are below the
          clinic-wide interpreting bar. The score is internal and is never shown to the volunteer.
          Anyone with an assessment already on file does not appear.
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No one is awaiting language review." bordered />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Language</TH>
              <TH>NetID</TH>
              <TH>Cycle / Department</TH>
              <TH>Current score</TH>
              <TH>Assessment</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">
                  <div className="flex items-center gap-2">
                    <span>{r.name}</span>
                    {r.source === "applicant" && <Badge tone="warning">Applicant</Badge>}
                  </div>
                </TD>
                <TD>
                  <Badge>{r.languageLabel}</Badge>
                </TD>
                <TD className="text-muted-foreground">
                  {r.netId ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-xs text-muted-foreground">
                  <div>{r.contextLabel || <span className="text-subtle-foreground">-</span>}</div>
                  {r.departments.length > 0 && (
                    <div className="text-subtle-foreground">{r.departments.join(", ")}</div>
                  )}
                </TD>
                <TD>
                  {r.language !== SPANISH ? (
                    <span className="text-xs text-subtle-foreground">-</span>
                  ) : r.score === null ? (
                    <span className="text-xs text-subtle-foreground">Not yet scored</span>
                  ) : (
                    <Badge tone={spanishScoreTone(r.score)}>{formatSpanishScore(r.score, null)}</Badge>
                  )}
                </TD>
                <TD>
                  <AssessForm
                    row={r}
                    action={r.source === "applicant" ? assessApplicantAction : assessMemberAction}
                    withScore={r.language === SPANISH}
                  />
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function AssessForm({
  row,
  action,
  withScore,
}: {
  row: LanguageReviewRow;
  action: (formData: FormData) => Promise<void>;
  withScore: boolean;
}) {
  return (
    <form action={action} className="flex flex-col gap-2">
      {/* One of the two, never both: an applicant has no Person and a member has
          no application. The action each form is bound to reads only its own. */}
      {row.source === "applicant" ? (
        <input type="hidden" name="applicationId" value={row.applicationId ?? ""} />
      ) : (
        <input type="hidden" name="personId" value={row.personId ?? ""} />
      )}
      <input type="hidden" name="language" value={row.language} />
      {withScore && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">Score:</span>
          <ScoreOptions name="score" defaultValue={String(row.score ?? "")} />
        </div>
      )}
      <div className="flex gap-2">
        <SubmitButton variant="primary" size="sm" name="verified" value="true" pendingLabel="Saving...">
          Verify
        </SubmitButton>
        <SubmitButton variant="outline" size="sm" name="verified" value="false" pendingLabel="Saving...">
          Not verified
        </SubmitButton>
      </div>
    </form>
  );
}
