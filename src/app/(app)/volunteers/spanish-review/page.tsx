import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import {
  listLanguageReviewQueue,
  recordLanguageAssessment,
  type LanguageReviewRow,
} from "@/platform/languages";
import {
  CLINIC_WIDE_INTERPRETER_MIN_SCORE,
  LanguageValidationError,
  SPANISH,
  SPANISH_PROFICIENCY_LEVELS,
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
  normalizeModifier,
  normalizeScore,
  updateSpanishAssessment,
} from "@/platform/languages/spanish-assessments";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { NavForm } from "@/platform/ui/nav-form";
import { Select } from "@/platform/ui/select";
import { Input } from "@/platform/ui/input";

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
  await requirePermission("volunteers.verify_spanish");
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

  // -------------------------------------------------------------------------
  // Actions. Each one bounces back with ?error= or ?ok= rather than returning
  // silently; the previous versions did a bare `return` on every failure, which
  // left the reviewer looking at a reset form with no idea what happened.
  // -------------------------------------------------------------------------

  async function assessAction(formData: FormData) {
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

  async function updateHistoryAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const back = { term: String(formData.get("returnTerm") ?? ""), page: String(formData.get("returnPage") ?? "") };
    try {
      await updateSpanishAssessment({
        id: String(formData.get("id") ?? ""),
        score: normalizeScore(formData.get("score")),
        modifier: normalizeModifier(formData.get("modifier")),
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
        score: normalizeScore(formData.get("score")),
        modifier: normalizeModifier(formData.get("modifier")),
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
        description="Volunteers who reported speaking a language and are awaiting an interpreting-department assessment. Verifying counts them as a provider for that language in scheduling."
      />

      {sp.error && <Alert tone="error">{sp.error}</Alert>}
      {sp.ok && <Alert tone="success">{sp.ok}</Alert>}

      <nav className="flex gap-1 border-b border-border">
        <TabLink tab="queue" activeTab={activeTab} count={queueRows.length}>
          Review queue
        </TabLink>
        <TabLink tab="history" activeTab={activeTab}>
          Assessment history
        </TabLink>
        <TabLink tab="crosscheck" activeTab={activeTab}>
          Flag cross-check
        </TabLink>
      </nav>

      {activeTab === "queue" && (
        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">Language review queue</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Everyone who reported speaking a language and is awaiting assessment. Record a 1-5
              proficiency score for Spanish speakers before verifying: departments differ on the
              score they will staff, so a conversational speaker is useful to someone even when
              they are below the clinic-wide interpreting bar. The score is internal and is never
              shown to the volunteer.
            </p>
          </div>
          {queueRows.length === 0 ? (
            <EmptyCard>No one is awaiting language review.</EmptyCard>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Language</TH>
                  <TH>NetID</TH>
                  <TH>Current score</TH>
                  <TH>Assessment</TH>
                </TR>
              </THead>
              <tbody>
                {queueRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.name}</TD>
                    <TD>
                      <Badge>{r.languageLabel}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {r.netId ?? <span className="text-subtle-foreground">-</span>}
                    </TD>
                    <TD>
                      {r.language !== SPANISH ? (
                        <span className="text-xs text-subtle-foreground">-</span>
                      ) : r.score === null ? (
                        <span className="text-xs text-subtle-foreground">Not yet scored</span>
                      ) : (
                        <Badge tone={spanishScoreTone(r.score)}>
                          {formatSpanishScore(r.score, null)}
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      <AssessForm row={r} action={assessAction} withScore={r.language === SPANISH} />
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </section>
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
              <form action={addPersonToHistoryAction} className="flex flex-wrap items-end gap-2">
                <Field label="NetID or email">
                  <Input name="netIdOrEmail" placeholder="abc123 or name@yale.edu" className="w-48" />
                </Field>
                <Field label="Season">
                  <Select name="termSeason" defaultValue="Spring">
                    {ASSESSMENT_SEASONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Year">
                  <Input
                    name="termYear"
                    inputMode="numeric"
                    placeholder="2026"
                    maxLength={4}
                    className="w-20"
                    defaultValue={activeTerm ? String(new Date(activeTerm.startDate).getUTCFullYear()) : ""}
                  />
                </Field>
                <Field label="Score">
                  <ScoreOptions name="score" />
                </Field>
                <Field label="Modifier">
                  <ModifierOptions name="modifier" />
                </Field>
                <SubmitButton variant="outline" pendingLabel="Adding...">
                  Add assessment
                </SubmitButton>
              </form>
            </div>
          </details>

          <NavForm action={BASE_PATH} className="flex flex-wrap gap-3">
            <input type="hidden" name="tab" value="history" />
            <Input
              name="q"
              placeholder="Search by name, email, or note..."
              defaultValue={search}
              className="min-w-48 flex-1"
            />
            <Select name="term" defaultValue={termFilter}>
              <option value="">All terms</option>
              {allTerms.map((term) => (
                <option key={term} value={term}>
                  {term}
                </option>
              ))}
            </Select>
            <SubmitButton variant="primary" pendingLabel="Searching...">
              Search
            </SubmitButton>
          </NavForm>

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
                    <TH>Edit</TH>
                  </TR>
                </THead>
                <tbody>
                  {history.rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">
                        {r.personId ? (
                          <Link
                            href={`/volunteers/compliance/${r.personId}`}
                            className="text-brand-fg hover:underline"
                          >
                            {r.displayName ?? "Unnamed"}
                          </Link>
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
                      <Link
                        href={`/volunteers/compliance/${m.personId}`}
                        className="text-brand-fg hover:underline"
                      >
                        {m.name}
                      </Link>
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

function TabLink({
  tab,
  activeTab,
  count,
  children,
}: {
  tab: Tab;
  activeTab: Tab;
  count?: number;
  children: React.ReactNode;
}) {
  const active = tab === activeTab;
  return (
    <Link
      href={tabHref(tab)}
      className={[
        "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {count}
        </span>
      )}
    </Link>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function ScoreOptions({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <option value="">N/A</option>
      {SPANISH_PROFICIENCY_LEVELS.map((l) => (
        <option key={l.score} value={l.score}>
          {l.score} - {l.label}
        </option>
      ))}
    </Select>
  );
}

function ModifierOptions({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue}>
      <option value="">none</option>
      <option value="plus">+</option>
      <option value="minus">-</option>
    </Select>
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
  withScore,
}: {
  row: LanguageReviewRow;
  action: (formData: FormData) => Promise<void>;
  withScore: boolean;
}) {
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="personId" value={row.personId} />
      <input type="hidden" name="language" value={row.language} />
      {withScore && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">Score:</span>
          <ScoreOptions name="score" defaultValue={String(row.score ?? "")} />
        </div>
      )}
      <div className="flex gap-2">
        <SubmitButton
          variant="primary"
          size="sm"
          name="verified"
          value="true"
          pendingLabel="Saving..."
        >
          Verify
        </SubmitButton>
        <SubmitButton
          variant="outline"
          size="sm"
          name="verified"
          value="false"
          pendingLabel="Saving..."
        >
          Not verified
        </SubmitButton>
      </div>
    </form>
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
          <Link
            href={tabHref("history", { term, q: search, page: String(page - 1) })}
            className="text-xs text-brand-fg hover:underline"
          >
            Previous
          </Link>
        )}
        {page < pageCount && (
          <Link
            href={tabHref("history", { term, q: search, page: String(page + 1) })}
            className="text-xs text-brand-fg hover:underline"
          >
            Next
          </Link>
        )}
      </div>
    </div>
  );
}

/** The user-facing half of a thrown error, without leaking an internal message. */
function messageFor(err: unknown, fallback: string): string {
  return err instanceof LanguageValidationError ? err.message : fallback;
}
