import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ScoreOptions } from "@/platform/ui/score-options";
import { DateTime } from "@/platform/dates/display";
import type { LanguageVerdict } from "@/platform/languages";
import { SPANISH, formatSpanishScore, languageLabel, spanishScoreTone } from "@/platform/languages/catalog";

/**
 * What the interpreting department already knows about this applicant's
 * languages, shown on the page where the department decides.
 *
 * ADVISORY ONLY. Nothing here disables, hides, or is a precondition for the
 * accept control elsewhere on this page: the department reads the verdict and
 * still makes its own call, which is the whole reason the assessment happens
 * before acceptance rather than after promotion.
 *
 * `action` is assessApplicantLanguageAction, already bound to this cycle and
 * application by the caller (its signature has a cycleId and applicationId
 * ahead of the FormData, like every other server action this page binds).
 */
export function LanguageAssessmentCard({
  applicationId,
  languages,
  verdicts,
  assessorNames,
  canAssess,
  action,
}: {
  applicationId: string;
  /** Spanish, always, plus whatever else the applicant claimed. */
  languages: string[];
  /** language -> the verdict that stands for this applicant, from priorLanguageVerdicts. */
  verdicts: Map<string, LanguageVerdict>;
  /** assessedById -> display name. History-sourced verdicts carry no assessor id and are absent here. */
  assessorNames: Map<string, string>;
  canAssess: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <Card>
      <SectionHeader>Language assessment</SectionHeader>
      <p className="mt-1 text-xs text-muted-foreground">
        What the interpreting department has confirmed for this applicant. For your information
        only: it does not block, gate, or need to happen before an acceptance.
      </p>
      <ul className="mt-3 space-y-3">
        {languages.map((language) => {
          const verdict = verdicts.get(language);
          const assessedHere = verdict?.applicationId === applicationId;
          const assessorName = verdict?.assessedById ? assessorNames.get(verdict.assessedById) : undefined;
          return (
            <li key={language} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{languageLabel(language)}</Badge>
              {!verdict ? (
                <span className="text-muted-foreground">Awaiting assessment</span>
              ) : (
                <>
                  {/* verified is tri-state: an imported history row can carry a
                      human's involvement with no recorded yes/no outcome (see
                      LanguageVerdict.verified). That must never read as a green
                      "Verified" nobody actually recorded. */}
                  {verdict.verified === null ? (
                    <Badge>Outcome not recorded</Badge>
                  ) : (
                    <Badge tone={verdict.verified ? "success" : "critical"}>
                      {verdict.verified ? "Verified" : "Not verified"}
                    </Badge>
                  )}
                  {language === SPANISH && verdict.score !== null && (
                    <Badge tone={spanishScoreTone(verdict.score)}>
                      {formatSpanishScore(verdict.score, null)}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {assessedHere ? "assessed for this application" : verdictOrigin(verdict)}
                    {assessorName ? ` by ${assessorName}` : ""}, <DateTime value={verdict.assessedAt} />
                  </span>
                </>
              )}
              {/* Always available to a permission holder, not just for a
                  suppressed on-file verdict: a mistyped score or a wrong
                  yes/no recorded for THIS application must be correctable too,
                  not permanent the moment it is saved. ScoreOptions below
                  defaults to the verdict's own score, so a correction starts
                  from what is on record rather than blank. */}
              {canAssess && verdict && (
                <form action={action} className="ml-auto flex flex-wrap items-center gap-2">
                  <input type="hidden" name="language" value={language} />
                  <span className="text-xs text-subtle-foreground">
                    {assessedHere ? "Re-record:" : "Assess anyway:"}
                  </span>
                  {language === SPANISH && (
                    <ScoreOptions name="score" defaultValue={String(verdict.score ?? "")} />
                  )}
                  <SubmitButton variant="ghost" size="sm" name="verified" value="true" pendingLabel="Saving…">
                    Verify
                  </SubmitButton>
                  <SubmitButton variant="ghost" size="sm" name="verified" value="false" pendingLabel="Saving…">
                    Not verified
                  </SubmitButton>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Where an on-file verdict came from, for the reviewer reading it: naming the
 * fact that spared the interpreting department the work of assessing this
 * application from scratch, rather than just saying "already on file."
 */
function verdictOrigin(verdict: LanguageVerdict): string {
  if (verdict.source === "member") return "on file from their member profile";
  if (verdict.source === "history") {
    return verdict.term
      ? `on file from assessment history, ${verdict.term}`
      : "on file from assessment history";
  }
  return "on file from a different application";
}
