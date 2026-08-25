import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { listLanguageReviewQueue, recordLanguageAssessment } from "@/platform/languages";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Select } from "@/platform/ui/select";

/**
 * Language review queue for the interpreting department.
 *
 * The route is still /volunteers/spanish-review so existing links and bookmarks
 * keep working, but the queue now covers every language rather than only
 * Spanish. Renaming the route is a separate, purely cosmetic change.
 *
 * The permission is likewise still volunteers.verify_spanish: renaming a
 * permission means re-granting it in production, and the reviewers who hold it
 * are exactly the people who should assess any language.
 */
export default async function LanguageReviewPage() {
  await requirePermission("volunteers.verify_spanish");
  const rows = await listLanguageReviewQueue();

  async function assessAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const language = String(formData.get("language") ?? "");
    const rawScore = formData.get("score");
    const score = language === "es" && rawScore ? parseInt(String(rawScore), 10) : null;
    await recordLanguageAssessment(actor.personId, {
      personId: String(formData.get("personId") ?? ""),
      language,
      verified: formData.get("verified") === "true",
      score: score && score >= 1 && score <= 5 ? score : null,
    });
    revalidatePath("/volunteers/spanish-review");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Language review"
        description="Volunteers who reported speaking a language and are awaiting an interpreting-department assessment. Verifying counts them as a provider for that language in scheduling."
      />
      {rows.length === 0 ? (
        <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
          No one is awaiting language review.
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Language</TH>
              <TH>NetID</TH>
              <TH>Email</TH>
              <TH>Score</TH>
              <TH>Assessment</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              // One row per (person, language): someone claiming two languages
              // is assessed on each separately.
              <TR key={r.id}>
                <TD className="font-medium">{r.name}</TD>
                <TD>
                  <Badge>{r.languageLabel}</Badge>
                </TD>
                <TD className="text-muted-foreground">
                  {r.netId ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-muted-foreground">
                  {r.contactEmail ?? <span className="text-subtle-foreground">-</span>}
                </TD>
                <TD className="text-muted-foreground">
                  {r.language === "es"
                    ? r.score
                      ? <span className="font-medium text-foreground">{r.score}/5</span>
                      : <span className="text-subtle-foreground">-</span>
                    : <span className="text-subtle-foreground">N/A</span>
                  }
                </TD>
                <TD>
                  <div className="flex flex-col gap-2">
                    {r.language === "es" && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="shrink-0">Score (1-5):</span>
                        <Select
                          name="score"
                          form={`assess-verify-${r.id}`}
                          defaultValue={r.score ?? ""}
                          className="rounded border border-border bg-background px-2 py-0.5 text-sm text-foreground"
                        >
                          <option value="">-</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </Select>
                        {r.score && (
                          <span className="text-xs text-muted-foreground">
                            (previously {r.score})
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <form id={`assess-verify-${r.id}`} action={assessAction}>
                        <input type="hidden" name="personId" value={r.personId} />
                        <input type="hidden" name="language" value={r.language} />
                        <input type="hidden" name="verified" value="true" />
                        <SubmitButton variant="primary" size="sm" pendingLabel="Saving...">Verify</SubmitButton>
                      </form>
                      <form action={assessAction}>
                        <input type="hidden" name="personId" value={r.personId} />
                        <input type="hidden" name="language" value={r.language} />
                        <input type="hidden" name="verified" value="false" />
                        <SubmitButton variant="outline" size="sm" pendingLabel="Saving...">Not verified</SubmitButton>
                      </form>
                    </div>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
