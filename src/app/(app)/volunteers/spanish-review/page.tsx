import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { listLanguageReviewQueue, recordLanguageAssessment } from "@/platform/languages";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SubmitButton } from "@/platform/ui/submit-button";
import { Select } from "@/platform/ui/select";
import { Input } from "@/platform/ui/input";

type PageProps = {
  searchParams: Promise<{ tab?: string; q?: string; term?: string }>;
};

export default async function LanguageReviewPage({ searchParams }: PageProps) {
  const session = await requirePermission("volunteers.verify_spanish");
  const sp = await searchParams;
  const activeTab = sp.tab === "history" ? "history" : "queue";
  const search = sp.q ?? "";
  const termFilter = sp.term ?? "";

  const canSeeHistory = await can(session.personId, "volunteers.view") ||
    await can(session.personId, "volunteers.verify_spanish");

  const rows = activeTab === "queue" ? await listLanguageReviewQueue() : [];

  // All distinct terms for the dropdown, most recent first
  const allTerms = canSeeHistory
    ? await prisma.spanishAssessmentRecord.findMany({
        select: { term: true },
        distinct: ["term"],
        orderBy: { term: "desc" },
      })
    : [];

  // Group terms by year for the hierarchy display
  const termsByYear = new Map<string, string[]>();
  for (const { term } of allTerms) {
    const year = term.split(" ")[1] ?? "Unknown";
    if (!termsByYear.has(year)) termsByYear.set(year, []);
    termsByYear.get(year)!.push(term);
  }
  const sortedYears = [...termsByYear.keys()].sort((a, b) => b.localeCompare(a));

  const historyRows = activeTab === "history" && canSeeHistory
    ? await prisma.spanishAssessmentRecord.findMany({
        where: {
          ...(termFilter ? { term: termFilter } : {}),
          ...(search
            ? {
                OR: [
                  { email: { contains: search, mode: "insensitive" } },
                  { name: { contains: search, mode: "insensitive" } },
                  { notes: { contains: search, mode: "insensitive" } },
                  { person: { name: { contains: search, mode: "insensitive" } } },
                ],
              }
            : {}),
        },
        orderBy: [{ term: "desc" }, { name: "asc" }, { email: "asc" }],
        include: { person: { select: { name: true } } },
      })
    : [];

  async function assessAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("volunteers.verify_spanish");
    const language = String(formData.get("language") ?? "");
    const rawScore = formData.get("score");
    const rawModifier = formData.get("modifier");
    const score = language === "es" && rawScore ? parseInt(String(rawScore), 10) : null;
    const modifier = rawModifier ? String(rawModifier) : null;

    // Also upsert a SpanishAssessmentRecord for current term tracking
    if (language === "es" && score) {
      const activeTerm = await prisma.term.findFirst({
        where: { status: "ACTIVE" },
        select: { name: true },
      });
      const termLabel = activeTerm?.name ?? new Date().getFullYear().toString();
            const personIdVal = String(formData.get("personId") ?? "");
      const existing = await prisma.spanishAssessmentRecord.findFirst({
        where: { personId: personIdVal, term: termLabel },
      });
      if (existing) {
      await prisma.spanishAssessmentRecord.update({
          where: { id: existing.id },
          data: { score, modifier, verified: formData.get("verified") === "true" },
        });
      } else {
        await prisma.spanishAssessmentRecord.create({
          data: {
            email: "",
            personId: personIdVal,
            score,
            modifier,
            term: termLabel,
            verified: formData.get("verified") === "true",
          },
        });
      }
    }

    await recordLanguageAssessment(actor.personId, {
      personId: String(formData.get("personId") ?? ""),
      language,
      verified: formData.get("verified") === "true",
      score: score && score >= 1 && score <= 5 ? score : null,
    });
    revalidatePath("/volunteers/spanish-review");
  }

  async function updateHistoryAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const id = String(formData.get("id") ?? "");
    const rawScore = formData.get("score");
    const modifier = formData.get("modifier");
    const notes = formData.get("notes");
    const score = rawScore ? parseInt(String(rawScore), 10) : null;
    await prisma.spanishAssessmentRecord.update({
      where: { id },
      data: {
        score: score && score >= 1 && score <= 5 ? score : null,
        modifier: modifier ? String(modifier) : null,
        notes: notes ? String(notes) : null,
      },
    });
    revalidatePath("/volunteers/spanish-review?tab=history");
  }

  async function addTermAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const season = String(formData.get("termSeason") ?? "").trim();
    const year = String(formData.get("termYear") ?? "").trim();
    if (!season || !year || year.length !== 4 || isNaN(Number(year))) return;
    const term = `${season} ${year}`;
    // Check if term already exists
    const existing = await prisma.spanishAssessmentRecord.findFirst({ where: { term } });
    if (existing) return;
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: "",
        name: `[${term} term created]`,
        term,
        score: null,
        modifier: null,
        notes: "Term placeholder",
        verified: null,
      },
    });
    revalidatePath("/volunteers/spanish-review?tab=history");
  }

    async function deleteTermAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const id = String(formData.get("id") ?? "");
    const record = await prisma.spanishAssessmentRecord.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!record?.name?.startsWith("[")) return;
    await prisma.spanishAssessmentRecord.delete({ where: { id } });
    revalidatePath("/volunteers/spanish-review?tab=history");
  }

    async function linkPersonAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const id = String(formData.get("id") ?? "");
    const netIdOrEmail = String(formData.get("netIdOrEmail") ?? "").trim().toLowerCase();
    if (!netIdOrEmail) return;
    const person = await prisma.person.findFirst({
      where: {
        OR: [
          { netId: { equals: netIdOrEmail, mode: "insensitive" } },
          { contactEmail: { equals: netIdOrEmail, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (!person) return;
    await prisma.spanishAssessmentRecord.update({
      where: { id },
      data: { personId: person.id },
    });
    revalidatePath("/volunteers/spanish-review?tab=history");
  }

    async function addPersonToHistoryAction(formData: FormData) {
    "use server";
    await requirePermission("volunteers.verify_spanish");
    const netIdOrEmail = String(formData.get("netIdOrEmail") ?? "").trim().toLowerCase();
    const term = String(formData.get("term") ?? "").trim();
    const rawScore = formData.get("score");
    const modifier = formData.get("modifier");
    if (!netIdOrEmail || !term) return;
    const person = await prisma.person.findFirst({
      where: {
        OR: [
          { netId: { equals: netIdOrEmail, mode: "insensitive" } },
          { contactEmail: { equals: netIdOrEmail, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, contactEmail: true },
    });
    const score = rawScore ? parseInt(String(rawScore), 10) : null;
    await prisma.spanishAssessmentRecord.create({
      data: {
        email: person?.contactEmail ?? netIdOrEmail,
        name: person?.name ?? null,
        personId: person?.id ?? null,
        score: score && score >= 1 && score <= 5 ? score : null,
        modifier: modifier ? String(modifier) : null,
        term,
        verified: null,
      },
    });
    revalidatePath("/volunteers/spanish-review?tab=history");
  }

  function scoreTone(score: number | null): "success" | "warning" | "critical" | "default" {
    if (!score) return "default";
    if (score >= 4) return "success";
    if (score === 3) return "warning";
    return "critical";
  }

  function scoreLabel(score: number | null, modifier: string | null): string {
    if (!score) return "Missing";
    const mod = modifier === "plus" ? "+" : modifier === "minus" ? "-" : "";
    const labels: Record<number, string> = {
      1: "Almost none",
      2: "Some",
      3: "Conversational",
      4: "Fluent",
      5: "Native",
    };
    return `${score}${mod} - ${labels[score] ?? ""}`;
  }

  function scoreLabel(score: number | null, modifier: string | null): string {
    if (!score) return "Missing";
    const mod = modifier === "plus" ? "+" : modifier === "minus" ? "-" : "";
    const labels: Record<number, string> = {
      1: "Almost none",
      2: "Some",
      3: "Conversational",
      4: "Fluent",
      5: "Native",
    };
    return `${score}${mod} - ${labels[score] ?? ""}`;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Language review"
        description="Volunteers who reported speaking a language and are awaiting an interpreting-department assessment."
      />

      {/* Tab nav */}
      <div className="flex gap-1 border-b border-border">
        <a
          href="/volunteers/spanish-review?tab=queue"
          className={["px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", activeTab === "queue" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"].join(" ")}
        >
          Review queue
          {rows.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground min-w-[1.25rem]">
              {rows.length}
            </span>
          )}
        </a>
        {canSeeHistory && (
          <a
            href="/volunteers/spanish-review?tab=history"
            className={["px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", activeTab === "history" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"].join(" ")}
          >
            Assessment history
          </a>
        )}
      </div>

      {/* Queue tab */}
      {activeTab === "queue" && (
        <div className="space-y-8">
          {/* INTP Assessment Queue */}
          <section>
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">INTP Assessment Queue</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Volunteers in or applying to the Department of Interpretation and Diversity who claimed a language and are awaiting assessment. Record a proficiency score for Spanish speakers before verifying.
              </p>
            </div>
            {rows.filter(r => r.isIntp).length === 0 ? (
              <Card pad={false} className="px-6 py-8 text-center text-sm text-muted-foreground">
                No INTP members are awaiting language assessment.
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
                  {rows.filter(r => r.isIntp).map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.name}</TD>
                      <TD><Badge>{r.languageLabel}</Badge></TD>
                      <TD className="text-muted-foreground">
                        {r.netId ?? <span className="text-subtle-foreground">-</span>}
                      </TD>
                      <TD className="text-muted-foreground">
                        {r.contactEmail ?? <span className="text-subtle-foreground">-</span>}
                      </TD>
                      <TD className="w-24">
                        {r.score != null
                          ? <Badge tone={scoreTone(r.score)}>{scoreLabel(r.score, null)}</Badge>
                          : <span className="text-subtle-foreground text-xs">Not yet scored</span>
                        }
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-2">
                          {r.language === "es" && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <span className="shrink-0">Score:</span>
                              <Select
                                name="score"
                                form={`assess-verify-${r.id}`}
                                defaultValue={String(r.score ?? "")}
                              >
                                <option value="">-</option>
                                <option value="1">1 - Almost none</option>
                                <option value="2">2 - Some</option>
                                <option value="3">3 - Conversational</option>
                                <option value="4">4 - Fluent</option>
                                <option value="5">5 - Native</option>
                              </Select>
                              <Select name="modifier" form={`assess-verify-${r.id}`}>
                                <option value="">none</option>
                                <option value="plus">+</option>
                                <option value="minus">-</option>
                              </Select>
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
          </section>

          {/* General language verification queue */}
          <section>
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">General Language Verification Queue</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Volunteers outside INTP who claimed a language and are awaiting verification.
              </p>
            </div>
            {rows.filter(r => !r.isIntp).length === 0 ? (
              <Card pad={false} className="px-6 py-8 text-center text-sm text-muted-foreground">
                No other volunteers are awaiting language verification.
              </Card>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Language</TH>
                    <TH>NetID</TH>
                    <TH>Email</TH>
                    <TH>Assessment</TH>
                  </TR>
                </THead>
                <tbody>
                  {rows.filter(r => !r.isIntp).map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.name}</TD>
                      <TD><Badge>{r.languageLabel}</Badge></TD>
                      <TD className="text-muted-foreground">
                        {r.netId ?? <span className="text-subtle-foreground">-</span>}
                      </TD>
                      <TD className="text-muted-foreground">
                        {r.contactEmail ?? <span className="text-subtle-foreground">-</span>}
                      </TD>
                      <TD>
                        <div className="flex gap-2">
                          <form action={assessAction}>
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
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </div>
      )}

      {/* History tab */}
      {activeTab === "history" && canSeeHistory && (
        <div className="space-y-6">
                  <div className="space-y-6">
          <Card pad={false} className="px-5 py-4 bg-muted">
            <p className="text-sm text-muted-foreground">
              Historical Spanish proficiency assessment records conducted by the Department of Interpretation and Diversity (INTP), going back to Spring 2012. Includes current active volunteers and HAVEN alumni. Scores reflect the INTP assessment, not self-reported proficiency.
            </p>
          </Card>

          {/* Manually add a person */}
          <details className="rounded-xl border border-border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground select-none">
              Manually add a person to assessment history
            </summary>
            <div className="px-4 pb-4 pt-2 space-y-2">
              <p className="text-xs text-muted-foreground">
                Use this if someone was assessed but does not appear in the history. Enter their NetID or email to link them to their Hub profile.
              </p>
              <form action={addPersonToHistoryAction} className="flex gap-2 flex-wrap items-end">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">NetID or email</label>
                  <Input name="netIdOrEmail" placeholder="abc123 or name@yale.edu" className="w-48" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Term</label>
                  <Select name="term">
                    {allTerms.map(t => (
                      <option key={t.term} value={t.term}>{t.term}</option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Score</label>
                  <Select name="score">
                    <option value="">-</option>
                    <option value="1">1 - Almost none</option>
                    <option value="2">2 - Some</option>
                    <option value="3">3 - Conversational</option>
                    <option value="4">4 - Fluent</option>
                    <option value="5">5 - Native</option>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Modifier</label>
                  <Select name="modifier">
                    <option value="">none</option>
                    <option value="plus">+</option>
                    <option value="minus">-</option>
                  </Select>
                </div>
                <SubmitButton variant="outline" pendingLabel="Adding...">Add to history</SubmitButton>
              </form>
            </div>
          </details>

          {/* Search + term filter */}
            <form method="GET" action="/volunteers/spanish-review" className="flex gap-3 flex-1 flex-wrap">
              <input type="hidden" name="tab" value="history" />
              <Input
                name="q"
                placeholder="Search by name or email..."
                defaultValue={search}
                className="flex-1 min-w-48"
              />
              <Select name="term" defaultValue={termFilter}>
                <option value="">All terms</option>
                {sortedYears.map((year) => (
                  <optgroup key={year} label={year}>
                    {termsByYear.get(year)!.map((term) => (
                      <option key={term} value={term}>{term}</option>
                    ))}
                  </optgroup>
                ))}
              </Select>
              <SubmitButton variant="primary" pendingLabel="Searching...">Search</SubmitButton>
            </form>

            {/* Add new term */}
            <form action={addTermAction} className="flex gap-2 items-center flex-wrap">
              <Select name="termSeason">
                <option value="">Season</option>
                <option value="Spring">Spring</option>
                <option value="Summer">Summer</option>
                <option value="Fall">Fall</option>
                <option value="Winter">Winter</option>
              </Select>
              <Input
                name="termYear"
                placeholder="2027"
                className="w-24"
                maxLength={4}
              />
              <SubmitButton variant="outline" pendingLabel="Adding...">Add term</SubmitButton>
            </form>
          </div>

          {historyRows.length === 0 ? (
            <Card pad={false} className="px-6 py-10 text-center text-sm text-muted-foreground">
              No assessment records found.
            </Card>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Term</TH>
                  <TH className="w-16">Score</TH>
                  <TH>Notes</TH>
                  <TH>Verified</TH>
                  <TH>Edit</TH>
                </TR>
              </THead>
              <tbody>
                {historyRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">
                      {r.person?.name ?? r.name ?? (
                        <form action={linkPersonAction} className="flex gap-1 items-center">
                          <input type="hidden" name="id" value={r.id} />
                          <Input
                            name="netIdOrEmail"
                            placeholder="NetID or email..."
                            className="w-36 text-xs"
                          />
                          <SubmitButton variant="outline" size="sm" pendingLabel="Linking...">Link</SubmitButton>
                        </form>
                      )}
                    </TD>
                    <TD className="text-muted-foreground text-xs">{r.email || "-"}</TD>
                    <TD className="text-muted-foreground whitespace-nowrap">{r.term}</TD>
                     <TD className="w-24">
                      <Badge tone={scoreTone(r.score)}>
                        {scoreLabel(r.score, r.modifier)}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground text-xs max-w-48 truncate">
                      {r.notes ?? "-"}
                    </TD>
                    <TD>
                      {r.verified === true
                        ? <Badge tone="success">Verified</Badge>
                        : r.verified === false
                        ? <Badge tone="critical">Not verified</Badge>
                        : <span className="text-muted-foreground text-xs">-</span>
                      }
                    </TD>
                    <TD>
                      <div className="flex flex-col gap-1">
                        <form action={updateHistoryAction} className="flex gap-1 items-center flex-wrap">
                          <input type="hidden" name="id" value={r.id} />
                          <Select name="score" defaultValue={String(r.score ?? "")}>
                            <option value="">-</option>
                            <option value="1">1 - Almost none</option>
                            <option value="2">2 - Some</option>
                            <option value="3">3 - Conversational</option>
                            <option value="4">4 - Fluent</option>
                            <option value="5">5 - Native</option>
                          </Select>
                          <Select name="modifier" defaultValue={r.modifier ?? ""}>
                            <option value="">none</option>
                            <option value="plus">+</option>
                            <option value="minus">-</option>
                          </Select>
                          <Input
                            name="notes"
                            defaultValue={r.notes ?? ""}
                            placeholder="Notes..."
                            className="w-32 text-xs"
                          />
                          <SubmitButton variant="outline" size="sm" pendingLabel="Saving...">Save</SubmitButton>
                        </form>
                        {r.name?.startsWith("[") && (
                          <form action={deleteTermAction}>
                            <input type="hidden" name="id" value={r.id} />
                            <SubmitButton variant="outline" size="sm" pendingLabel="Deleting...">Delete term</SubmitButton>
                          </form>
                        )}
                      </div>
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
