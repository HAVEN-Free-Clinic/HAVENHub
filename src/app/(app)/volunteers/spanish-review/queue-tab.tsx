"use client";

import { useState } from "react";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Checkbox } from "@/platform/ui/checkbox";
import { EmptyState } from "@/platform/ui/empty-state";
import { useBulkSelection } from "@/platform/ui/use-bulk-selection";
import { useTimeZone } from "@/platform/dates/client";
import { formatDateOnly } from "@/platform/dates/format";
// Type-only, so the server module is erased at compile time and never bundled.
import type { LanguageReviewRow } from "@/platform/languages";
import { SPANISH, formatSpanishScore, spanishScoreTone } from "@/platform/languages/catalog";
import { ScoreOptions } from "@/platform/ui/score-options";

type Action = (formData: FormData) => Promise<void>;

/** The two tabs this component draws. Both list rows still owed an assessment. */
export type ReviewView = "queue" | "later";

/**
 * The review queue, over both sources.
 *
 * Applicant rows come first and carry an "Applicant" badge: they are the ones
 * holding up a decision, while a member's claim can wait for the next
 * assessment session. Nothing here gates the department's accept control; the
 * assessment is advisory. The Cycle / Department column is what tells a
 * reviewer which of the two they are looking at without reading the badge.
 *
 * Client component so rows can be ticked and assessed together. Each row's own
 * Verify / Not verified form is unchanged; the bulk bar posts one `entry` per
 * ticked row, carrying the same fields that row's form would.
 *
 * Draws the Review later tab too. Its rows are the same unassessed rows and are
 * assessed the same way; only the move differs. The queue sets a row aside to
 * review later, and Review later moves it back. A move records nothing about
 * the assessment.
 */
export function QueueTab({
  view,
  rows,
  assessMemberAction,
  assessApplicantAction,
  bulkAssessAction,
  moveAction,
}: {
  view: ReviewView;
  rows: LanguageReviewRow[];
  assessMemberAction: Action;
  assessApplicantAction: Action;
  bulkAssessAction: Action;
  /** Review later from the queue, back to the queue from Review later. Reads `entry` fields. */
  moveAction: Action;
}) {
  const zone = useTimeZone();
  const selection = useBulkSelection({ rows, idOf: (r) => r.id });

  // The score each Spanish row's select shows, keyed by row id, only once the
  // reviewer has changed it. The bulk bar sits outside every row's form, so it
  // can post a row's score only by reading it from here, and the select is
  // controlled from the same state so what is posted is what is on screen.
  const [scores, setScores] = useState<Readonly<Record<string, string>>>({});
  const scoreOf = (r: LanguageReviewRow) => scores[r.id] ?? String(r.score ?? "");

  // Scoped to the rows on screen by the hook: an assessed row drops out of
  // `rows` on the re-render, and must not be posted a second time.
  const selectedIds = new Set(selection.ids);
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const count = selectedRows.length;
  const unscored = selectedRows.filter((r) => r.language === SPANISH && scoreOf(r) === "").length;

  const entries = selectedRows.map((r) => (
    <input key={r.id} type="hidden" name="entry" value={bulkEntry(r, scoreOf(r))} />
  ));

  return (
    <section>
      <div className="mb-3">
        {view === "queue" ? (
          <>
            <h2 className="text-sm font-semibold text-foreground">Language review queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Everyone awaiting assessment. Applicants come first: their departments assess before
              accepting, so a verdict here goes straight onto the application. Record a 1-5
              proficiency score for Spanish speakers before verifying: departments differ on the
              score they will staff, so a conversational speaker is useful to someone even when they
              are below the clinic-wide interpreting bar. The score is internal and is never shown to
              the volunteer. Anyone with an assessment already on file does not appear. Not ready to
              assess someone yet? Review later sets them aside without recording anything.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-foreground">Review later</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              People set aside from the queue to come back to. Nothing has been recorded for them, so
              they are still owed an assessment. Assess them here the same way as in the queue, or
              move them back to it.
            </p>
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={view === "queue" ? "No one is awaiting language review." : "No one is set aside to review later."}
          bordered
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <form action={bulkAssessAction}>
              {entries}
              <input type="hidden" name="verified" value="true" />
              <input type="hidden" name="returnTab" value={view} />
              <SubmitButton variant="primary" size="sm" disabled={count === 0} pendingLabel="Saving…">
                {count === 0 ? "Verify selected" : `Verify ${count} selected`}
              </SubmitButton>
            </form>
            {/* Two clicks for the "no": it takes every ticked person out of the
                queue and tells each member their language was not confirmed. */}
            <form action={bulkAssessAction}>
              {entries}
              <input type="hidden" name="verified" value="false" />
              <input type="hidden" name="returnTab" value={view} />
              <ConfirmButton
                size="sm"
                disabled={count === 0}
                label={count === 0 ? "Mark not verified" : `Mark ${count} not verified`}
                confirmLabel={`Mark ${count} not verified?`}
              />
            </form>
            <form action={moveAction}>
              {entries}
              <SubmitButton variant="outline" size="sm" disabled={count === 0} pendingLabel="Moving…">
                {bulkMoveLabel(view, count)}
              </SubmitButton>
            </form>
            <p className="text-xs text-muted-foreground">
              {count === 0
                ? "Tick rows to assess several at once. Shift-click selects a range."
                : unscored > 0
                  ? `${unscored} selected Spanish ${unscored === 1 ? "speaker has" : "speakers have"} no score yet. Each row keeps the score chosen on it.`
                  : "Each row keeps the score chosen on it."}
            </p>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>
                  <Checkbox
                    checked={selection.allSelected}
                    indeterminate={selection.someSelected}
                    onChange={selection.toggleAll}
                    aria-label={view === "queue" ? "Select everyone in the queue" : "Select everyone set aside"}
                  />
                  <span className="sr-only">Select</span>
                </TH>
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
                  <TD>
                    <Checkbox
                      checked={selection.has(r.id)}
                      // onClick, not onChange: a change event carries no
                      // shiftKey, and the range is what makes a long queue
                      // quick to select.
                      onClick={(e) => selection.toggle(r.id, e.shiftKey)}
                      onChange={() => {}}
                      aria-label={`Select ${r.name}, ${r.languageLabel}`}
                    />
                  </TD>
                  <TD className="font-medium">
                    <div className="flex items-center gap-2">
                      <span>{r.name}</span>
                      {r.source === "applicant" && <Badge tone="warning">Applicant</Badge>}
                    </div>
                    {r.reviewLater && (
                      <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                        Set aside {formatDateOnly(r.reviewLater.since, zone)}
                        {r.reviewLater.byName ? ` by ${r.reviewLater.byName}` : ""}
                      </div>
                    )}
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
                    <div className="flex flex-wrap items-end gap-2">
                      <AssessForm
                        row={r}
                        action={r.source === "applicant" ? assessApplicantAction : assessMemberAction}
                        returnTab={view}
                        withScore={r.language === SPANISH}
                        score={scoreOf(r)}
                        onScoreChange={(value) => setScores((prev) => ({ ...prev, [r.id]: value }))}
                      />
                      {/* A form of its own rather than a third button in
                          AssessForm. A second action in one form needs a
                          formAction on every submit, and Verify / Not verified
                          carry name/value, which a formAction silently drops
                          (see SubmitButton). */}
                      <form action={moveAction}>
                        <input type="hidden" name="entry" value={bulkEntry(r, scoreOf(r))} />
                        <SubmitButton variant="ghost" size="sm" pendingLabel="Moving…">
                          {view === "queue" ? "Review later" : "Back to queue"}
                        </SubmitButton>
                      </form>
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </section>
  );
}

/** The bulk move button. Distinct from the per-row labels even with nothing ticked. */
function bulkMoveLabel(view: ReviewView, count: number): string {
  if (view === "queue") return count === 0 ? "Review selected later" : `Review ${count} later`;
  return count === 0 ? "Move selected back" : `Move ${count} back to queue`;
}

/**
 * One ticked row, as the bulk form posts it. Read by
 * parseBulkAssessmentEntries, which applies the same score rules the row's own
 * form gets: only a Spanish row carries a score field, and blank is N/A.
 */
function bulkEntry(row: LanguageReviewRow, score: string): string {
  const withScore = row.language === SPANISH ? { score } : {};
  return JSON.stringify(
    row.source === "applicant"
      ? { source: "applicant", applicationId: row.applicationId, language: row.language, ...withScore }
      : { source: "member", personId: row.personId, language: row.language, ...withScore },
  );
}

/**
 * One form, two submit buttons.
 *
 * The score select used to sit outside the verify form and reach it with a
 * `form=` attribute, which meant the Not-verified button (a second, separate
 * form) submitted no score at all and cleared the one on record. Both outcomes
 * now post the same fields.
 */
function AssessForm({
  row,
  action,
  returnTab,
  withScore,
  score,
  onScoreChange,
}: {
  row: LanguageReviewRow;
  action: Action;
  /** Which tab to land back on, so assessing from Review later stays there. */
  returnTab: ReviewView;
  withScore: boolean;
  score: string;
  onScoreChange: (value: string) => void;
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
      <input type="hidden" name="returnTab" value={returnTab} />
      {withScore && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">Score:</span>
          <ScoreOptions name="score" value={score} onChange={(e) => onScoreChange(e.target.value)} />
        </div>
      )}
      <div className="flex gap-2">
        <SubmitButton variant="primary" size="sm" name="verified" value="true" pendingLabel="Saving…">
          Verify
        </SubmitButton>
        <SubmitButton variant="outline" size="sm" name="verified" value="false" pendingLabel="Saving…">
          Not verified
        </SubmitButton>
      </div>
    </form>
  );
}
