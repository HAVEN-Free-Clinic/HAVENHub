import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  listLanguageReviewQueue,
  recordApplicationLanguageAssessment,
  recordLanguageAssessment,
} from "@/platform/languages";
import {
  CLINIC_WIDE_INTERPRETER_MIN_SCORE,
  LanguageValidationError,
  SPANISH,
  formatSpanishScore,
  spanishProficiencyLabel,
  spanishScoreTone,
} from "@/platform/languages/catalog";
import {
  ASSESSMENT_SEASONS,
  addPersonToSpanishHistory,
  HISTORY_PAGE_SIZE,
  linkSpanishAssessmentToPerson,
  listAssessmentTerms,
  listSpanishAssessmentHistory,
  listSpanishFlagMismatches,
  normalizeScore,
  normalizeScoreAndModifier,
  updateSpanishAssessment,
} from "@/platform/languages/spanish-assessments";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";
import { Select } from "@/platform/ui/select";
import { Input } from "@/platform/ui/input";
import { TextLink } from "@/platform/ui/text-link";
import { FormRow, RowField } from "@/platform/ui/form";
import { ScoreOptions } from "@/platform/ui/score-options";
import { QueueTab } from "./queue-tab";
import { TabRow } from "@/platform/ui/tab-row";
import { viewableMemberIds } from "@/platform/member-profile";

/**
 * Language review queue for the interpreting department.
 *
 * The route is still /volunteers/spanish-review so existing links and bookmarks
 * keep working, but the queue covers every language rather than only Spanish.
 * Renaming the route is a separate, purely cosmetic change.
 *
 * The permission is likewise still volunteers.verify_spanish: renaming a
 * permission means re-granting it in production, and the reviewers who hold it
 * are exactly the people who should assess any language.
 *
 * Three tabs:
 *   - queue      the claims awaiting assessment, one flat queue for everyone
 *   - history    every INTP Spanish assessment, back to Spring 2012
 *   - crosscheck people flagged in Hub whose assessment does not back it up
 *
 * The 1-5 proficiency score is INTERNAL. It renders here and on a member's
 * profile, both staff-gated, and never on /my-info.
 *
 * No data access or mutation logic lives in this file. It all sits in
 * platform/languages, where it is reachable from a test; the version that
 * inlined it here had two buttons writing the same fact two different ways.
 */

const BASE_PATH = "/volunteers/spanish-review";

type Tab = "queue" | "history" | "crosscheck";

type PageProps = {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    term?: string;
    page?: string;
    error?: string;
    ok?: string;
  }>;
};

function tabHref(tab: Tab, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return `${BASE_PATH}?${qs.toString()}`;
}

export default async function LanguageReviewPage({ searchParams }: PageProps) {
  const viewer = await requirePermission("volunteers.verify_spanish");
  const sp = await searchParams;
  const activeTab: Tab =
    sp.tab === "history" ? "history" : sp.tab === "crosscheck" ? "crosscheck" : "queue";
  const search = sp.q ?? "";
  // "All terms" is the default. The previous default of the ACTIVE term meant
  // opening the tab in a term with no assessments yet showed an empty table with
  // no hint that a filter was doing it.
  const termFilter = sp.term ?? "";
  const page = Number.parseInt(sp.page ?? "1", 10) || 1;

  const [queueRows, activeTerm] = await Promise.all([
    activeTab === "queue" ? listLanguageReviewQueue() : Promise.resolve([]),
    getActiveTerm(),
  ]);

  const history =
    activeTab === "history"
      ? await listSpanishAssessmentHistory({ term: termFilter, search, page })
      : null;
  const allTerms = activeTab === "history" ? await listAssessmentTerms() : [];
  const mismatches = activeTab === "crosscheck" ? await listSpanishFlagMismatches() : [];

  // Which of these names the reviewer may actually open.
  //
  // Both tables linked every name to /volunteers/compliance/[personId]
  // unconditionally, and that page redirects to /no-access unless
  // canViewMemberProfile passes. A reviewer holding only
  // volunteers.verify_spanish -- the persona the registry documents as this
  // being "their sole page" -- bounced on every single row; an INTP
  // director-reviewer bounced on every name outside their own departments and
  // on every alum, which is most of a history running back to 2012.
  //
  // Every other surface that renders this link already gates it and falls back
  // to plain text: /schedule/full, the builder day view, the readiness panel,
  // and the directory, whose comment calls this "the dead-end-result bug this
  // codebase has already shipped four times".
  const profileIds = await viewableMemberIds(viewer.personId, [
    ...history?.rows.flatMap((r) => (r.personId ? [r.personId] : [])) ?? [],
    ...mismatches.map((m) => m.personId),
  ]);

  // -------------------------------------------------------------------------
  // Actions. Each one bounces back with ?error= or ?ok= rather than returning
  // silently; the previous versions did a bare `return` on every failure, which
  // left the reviewer looking at a reset form with no idea what happened.
  // -------------------------------------------------------------------------

  async function assessMemberAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const personId = String(formData.get("personId") ?? "");
    const language = String(formData.get("language") ?? "");
    const verified = formData.get("verified") === "true";
    // The score field is present only on Spanish rows; other languages carry
    // no score. Absent means "this form never asked", which
    // recordLanguageAssessment reads as leave-alone; an explicit empty
    // selection means N/A and clears it.
    const hasScoreField = formData.has("score");
    const score = hasScoreField ? normalizeScore(formData.get("score")) : undefined;

    try {
      await recordLanguageAssessment(actor.personId, {
        personId,
        language,
        verified,
        ...(score === undefined ? {} : { score }),
      });
    } catch (err) {
      redirect(tabHref("queue", { error: messageFor(err, "Could not record that assessment.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("queue", { ok: "Assessment recorded." }));
  }

  async function assessApplicantAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const applicationId = String(formData.get("applicationId") ?? "");
    const language = String(formData.get("language") ?? "");
    const verified = formData.get("verified") === "true";
    const score = normalizeScore(formData.get("score"));

    try {
      await recordApplicationLanguageAssessment(actor.personId, {
        applicationId,
        language,
        verified,
        score,
      });
    } catch (err) {
      redirect(tabHref("queue", { error: messageFor(err, "Could not record that assessment.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("queue", { ok: "Assessment recorded." }));
  }

  async function updateHistoryAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const back = { term: String(formData.get("returnTerm") ?? ""), page: String(formData.get("returnPage") ?? "") };
    try {
      await updateSpanishAssessment({
        id: String(formData.get("id") ?? ""),
        ...normalizeScoreAndModifier(formData.get("score"), formData.get("modifier")),
        notes: formData.get("notes") === null ? null : String(formData.get("notes")),
      });
    } catch (err) {
      redirect(tabHref("history", { ...back, error: messageFor(err, "Could not save that record.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("history", { ...back, ok: "Record saved." }));
  }

  /**
   * Verify (or un-verify) straight from a history row.
   *
   * Routed through recordLanguageAssessment rather than writing PersonLanguage
   * directly, so this button produces the same audit row and the same member
   * email as the identical button on the queue tab. The version that called
   * updateMany here produced neither, and silently reported success when the
   * person had no Spanish claim to update.
   */
  async function verifyFromHistoryAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const personId = String(formData.get("personId") ?? "");
    const back = { term: String(formData.get("returnTerm") ?? ""), page: String(formData.get("returnPage") ?? "") };
    if (!personId) {
      redirect(
        tabHref("history", {
          ...back,
          error: "Link this record to a Hub account before verifying it.",
        }),
      );
    }
    try {
      await recordLanguageAssessment(actor.personId, {
        personId,
        language: SPANISH,
        verified: formData.get("verified") === "true",
      });
    } catch (err) {
      redirect(tabHref("history", { ...back, error: messageFor(err, "Could not verify that record.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("history", { ...back, ok: "Verification recorded." }));
  }

  async function linkPersonAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const back = { term: String(formData.get("returnTerm") ?? ""), page: String(formData.get("returnPage") ?? "") };
    try {
      await linkSpanishAssessmentToPerson({
        id: String(formData.get("id") ?? ""),
        netIdOrEmail: String(formData.get("netIdOrEmail") ?? ""),
      });
    } catch (err) {
      redirect(tabHref("history", { ...back, error: messageFor(err, "Could not link that record.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("history", { ...back, ok: "Record linked." }));
  }

  async function addPersonToHistoryAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const season = String(formData.get("termSeason") ?? "").trim();
    const year = String(formData.get("termYear") ?? "").trim();
    try {
      if (!/^\d{4}$/.test(year)) {
        throw new LanguageValidationError("Enter a four-digit year, e.g. 2026.");
      }
      await addPersonToSpanishHistory({
        netIdOrEmail: String(formData.get("netIdOrEmail") ?? ""),
        term: `${season} ${year}`,
        ...normalizeScoreAndModifier(formData.get("score"), formData.get("modifier")),
      });
    } catch (err) {
      redirect(tabHref("history", { error: messageFor(err, "Could not add that assessment.") }));
    }
    revalidatePath(BASE_PATH);
    redirect(tabHref("history", { ok: "Assessment added." }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Language review"
        description="Members who reported speaking a language, and applicants to departments that confirm Spanish before accepting regardless of what they claimed, both awaiting an interpreting-department verdict. Verifying a member counts them as a provider for that language in scheduling."
      />

      {/* No inline Alert: FlashReader claims this param, toasts it, and strips it
          from the URL, so an inline branch reported it twice and then lost its
          value on the router.replace. Error toasts do not auto-dismiss. */}

      {/* `|| undefined` on the badge, not `|| 0`: TabRow renders a badge
          whenever it is not undefined, and a literal 0 beside "Review queue"
          reads as a count of zero rather than as no count. */}
      <TabRow
        variant="underline"
        label="Language review sections"
        isActive={(item) => item.href === tabHref(activeTab)}
        items={[
          { label: "Review queue", href: tabHref("queue"), badge: queueRows.length || undefined },
          { label: "Assessment history", href: tabHref("history") },
          { label: "Flag cross-check", href: tabHref("crosscheck") },
        ]}
      />

      {activeTab === "queue" && (
        <QueueTab
          rows={queueRows}
          assessMemberAction={assessMemberAction}
          assessApplicantAction={assessApplicantAction}
        />
      )}

      {activeTab === "history" && history && (
        <div className="space-y-6">
          <Card pad={false} className="bg-muted px-5 py-4">
            <p className="text-sm text-muted-foreground">
              Every INTP Spanish proficiency assessment, back to Spring 2012, covering current
              volunteers and alumni. These are INTP assessment scores, not self-reported
              proficiency, and they are not shown to the volunteers they describe.
            </p>
          </Card>

          <details className="rounded-xl border border-border">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground">
              Add an assessment
            </summary>
            <div className="space-y-2 px-4 pb-4 pt-2">
              <p className="text-xs text-muted-foreground">
                For someone assessed outside the queue. Enter their NetID or email to link the
                record to their Hub profile.
              </p>
              <form action={addPersonToHistoryAction}>
                <FormRow>
                  <RowField label="NetID or email">
                    <Input name="netIdOrEmail" placeholder="abc123 or name@yale.edu" />
                  </RowField>
                  <RowField label="Season">
                    <Select name="termSeason" defaultValue="Spring">
                      {ASSESSMENT_SEASONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </RowField>
                  <RowField label="Year" width="numeric">
                    <Input
                      name="termYear"
                      inputMode="numeric"
                      placeholder="2026"
                      maxLength={4}
                      defaultValue={activeTerm ? String(new Date(activeTerm.startDate).getUTCFullYear()) : ""}
                    />
                  </RowField>
                  <RowField label="Score">
                    <ScoreOptions name="score" />
                  </RowField>
                  <RowField label="Modifier">
                    <ModifierOptions name="modifier" />
                  </RowField>
                  <SubmitButton variant="outline" pendingLabel="Adding...">
                    Add assessment
                  </SubmitButton>
                </FormRow>
              </form>
            </div>
          </details>

          <FilterBar
            action={BASE_PATH}
            clearHref={search || termFilter ? `${BASE_PATH}?tab=history` : undefined}
          >
            <input type="hidden" name="tab" value="history" />
            <FilterField label="Search" width="grow">
              <Input
                type="search"
                name="q"
                placeholder="Name, email, or note..."
                defaultValue={search}
              />
            </FilterField>
            <FilterField label="Term" width="wide">
              <Select name="term" defaultValue={termFilter}>
                <option value="">All terms</option>
                {allTerms.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </Select>
            </FilterField>
          </FilterBar>

          {history.rows.length === 0 ? (
            <EmptyCard>No assessment records match that filter.</EmptyCard>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Term</TH>
                    <TH>Score</TH>
                    <TH>Notes</TH>
                    <TH>Verified</TH>
                    {/* Buttons, not an editable column: named for screen
                        readers and left blank for the eye, the way the other
                        eight action columns in the app are. The header also
                        said "Edit" over a Verify / Not verified form. */}
                    <TH><span className="sr-only">Actions</span></TH>
                  </TR>
                </THead>
                <tbody>
                  {history.rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">
                        {r.personId && profileIds.has(r.personId) ? (
                          <TextLink href={`/volunteers/compliance/${r.personId}`}>
                            {r.displayName ?? "Unnamed"}
                          </TextLink>
                        ) : (
                          (r.displayName ?? <span className="text-subtle-foreground">-</span>)
                        )}
                      </TD>
                      <TD className="text-muted-foreground">
                        {r.email || <span className="text-subtle-foreground">-</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">{r.term}</TD>
                      <TD>
                        <Badge tone={spanishScoreTone(r.score)}>
                          <span className="whitespace-nowrap">
                            {formatSpanishScore(r.score, r.modifier)}
                          </span>
                        </Badge>
                      </TD>
                      <TD>
                        <span className="block max-w-32 truncate text-xs italic text-muted-foreground">
                          {r.notes || spanishProficiencyLabel(r.score)}
                        </span>
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          {r.verified === true && <Badge tone="success">Verified</Badge>}
                          {r.verified === false && <Badge tone="critical">Not verified</Badge>}
                          {r.personId === null ? (
                            <span className="text-xs text-subtle-foreground">Not linked</span>
                          ) : (
                            <form action={verifyFromHistoryAction} className="flex gap-1">
                              <input type="hidden" name="personId" value={r.personId} />
                              <input type="hidden" name="returnTerm" value={termFilter} />
                              <input type="hidden" name="returnPage" value={String(history.page)} />
                              {r.verified !== true && (
                                <SubmitButton
                                  variant="primary"
                                  size="sm"
                                  name="verified"
                                  value="true"
                                  pendingLabel="Saving..."
                                >
                                  Verify
                                </SubmitButton>
                              )}
                              {r.verified !== false && (
                                <SubmitButton
                                  variant="outline"
                                  size="sm"
                                  name="verified"
                                  value="false"
                                  pendingLabel="Saving..."
                                >
                                  <span className="whitespace-nowrap">Not verified</span>
                                </SubmitButton>
                              )}
                            </form>
                          )}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          <form
                            action={updateHistoryAction}
                            className="flex flex-wrap items-center gap-1"
                          >
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="returnTerm" value={termFilter} />
                            <input type="hidden" name="returnPage" value={String(history.page)} />
                            <ScoreOptions name="score" defaultValue={String(r.score ?? "")} />
                            <ModifierOptions name="modifier" defaultValue={r.modifier ?? ""} />
                            <Input
                              name="notes"
                              defaultValue={r.notes ?? spanishProficiencyLabel(r.score)}
                              placeholder="Notes..."
                              className="w-32 text-xs"
                            />
                            <SubmitButton variant="outline" size="sm" pendingLabel="Saving...">
                              Save
                            </SubmitButton>
                          </form>
                          {r.personId === null && (
                            <form action={linkPersonAction} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="returnTerm" value={termFilter} />
                              <input type="hidden" name="returnPage" value={String(history.page)} />
                              <Input
                                name="netIdOrEmail"
                                placeholder="NetID or email..."
                                className="w-36 text-xs"
                              />
                              <SubmitButton variant="outline" size="sm" pendingLabel="Linking...">
                                Link
                              </SubmitButton>
                            </form>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              <Pagination
                page={history.page}
                pageCount={history.pageCount}
                total={history.total}
                term={termFilter}
                search={search}
              />
            </>
          )}
        </div>
      )}

      {activeTab === "crosscheck" && (
        <div className="space-y-6">
          <Card pad={false} className="bg-muted px-5 py-4">
            <p className="text-sm text-muted-foreground">
              Active volunteers carrying a verified Spanish flag in Hub whose assessment does not
              back it up: either no assessment on record at all, or a most recent score below{" "}
              {CLINIC_WIDE_INTERPRETER_MIN_SCORE}, the clinic-wide interpreting bar. A score below
              that is conversational, which some departments still staff, so each row names the
              person&apos;s departments that would. Nothing is revoked automatically. Set a
              department&apos;s own bar on its page under Admin.
            </p>
          </Card>
          {mismatches.length === 0 ? (
            <EmptyCard>
              Every verified Spanish flag is backed by an assessment at or above the clinic-wide
              bar.
            </EmptyCard>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>NetID</TH>
                  <TH>Latest score</TH>
                  <TH>Assessed</TH>
                  <TH>Why it is listed</TH>
                  <TH>Departments that still accept</TH>
                </TR>
              </THead>
              <tbody>
                {mismatches.map((m) => (
                  <TR key={m.personId}>
                    <TD className="font-medium">
                      {profileIds.has(m.personId) ? (
                        <TextLink href={`/volunteers/compliance/${m.personId}`}>
                          {m.name}
                        </TextLink>
                      ) : (
                        m.name
                      )}
                    </TD>
                    <TD className="text-muted-foreground">
                      {m.netId ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                    <TD>
                      <Badge tone={spanishScoreTone(m.score)}>
                        {formatSpanishScore(m.score, null)}
                      </Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {m.term ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {m.reason === "no-assessment"
                        ? "Flagged in Hub, never on the assessment list"
                        : `Scored below ${CLINIC_WIDE_INTERPRETER_MIN_SCORE} (conversational)`}
                    </TD>
                    <TD>
                      {m.acceptedByDepartments.length === 0 ? (
                        <span className="text-xs text-subtle-foreground">None</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {m.acceptedByDepartments.map((code) => (
                            <Badge key={code} tone="success">
                              {code}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------


function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </Card>
  );
}

/**
 * Legacy only. The modifier is how the assessors wrote a half step before the
 * scale had one, so it stays editable for imported rows but is not how a new
 * assessment records a half. Picking a half step from the score select drops
 * whatever is selected here: see normalizeScoreAndModifier.
 */
function ModifierOptions({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <option value="">none</option>
      <option value="plus">+</option>
      <option value="minus">-</option>
    </Select>
  );
}

function Pagination({
  page,
  pageCount,
  total,
  term,
  search,
}: {
  page: number;
  pageCount: number;
  total: number;
  term: string;
  search: string;
}) {
  if (pageCount <= 1) {
    return (
      <p className="text-xs text-muted-foreground">
        {total} {total === 1 ? "record" : "records"}.
      </p>
    );
  }
  const first = (page - 1) * HISTORY_PAGE_SIZE + 1;
  const last = Math.min(page * HISTORY_PAGE_SIZE, total);
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        {first}-{last} of {total}
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <TextLink
            href={tabHref("history", { term, q: search, page: String(page - 1) })}
            size="xs"
          >
            Previous
          </TextLink>
        )}
        {page < pageCount && (
          <TextLink
            href={tabHref("history", { term, q: search, page: String(page + 1) })}
            size="xs"
          >
            Next
          </TextLink>
        )}
      </div>
    </div>
  );
}

/** The user-facing half of a thrown error, without leaking an internal message. */
function messageFor(err: unknown, fallback: string): string {
  return err instanceof LanguageValidationError ? err.message : fallback;
}
