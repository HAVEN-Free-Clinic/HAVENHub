import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { DateTime } from "@/platform/dates/display";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { formatForDateTimeInput, formatForDateInput, formatDateOnly } from "@/platform/dates";
import { getCycle } from "@/modules/recruitment/services/cycles";
import { requirePermission, requirePersonSession } from "@/platform/auth/session";
import { revalidatePath } from "next/cache";
import { createInvite, listInvites, revokeInvite } from "@/modules/recruitment/services/invites";
import { InvitePanel, type InviteRow } from "./invite-panel";
import { can } from "@/platform/rbac/engine";
import { portalUrl } from "@/modules/recruitment/services/portal-url";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { publishCycleAction, closeCycleAction, reopenCycleAction, archiveCycleAction, unarchiveCycleAction, toggleRenewalsAction, setTrainingCycleAction, updateQuizSettingsAction, setCycleDepartmentsAction, setApplicationWindowAction, createTestCycleAction, deleteTestCycleAction } from "../../actions";
import { Alert } from "@/platform/ui/alert";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { PageHeader } from "@/platform/ui/page-header";
import { Field, Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { prisma } from "@/platform/db";
import { MultiCombobox } from "@/platform/ui/multi-combobox";
import { Card } from "@/platform/ui/card";
import { FormActions, FormRow, RowField } from "@/platform/ui/form";
import { SectionHeader } from "@/platform/ui/section-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";
import { CycleStatusBadge } from "@/modules/recruitment/components/status-badge";


type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CycleOverviewPage({ params }: PageProps) {
  const { id } = await params;
  await requirePermission("recruitment.access");
  const cycle = await getCycle(id);
  if (!cycle) notFound();

  // The /recruitment layout admits any recruitment.access holder (reviewers), but the
  // cycle-lifecycle controls below are all gated on recruitment.manage_cycles server-side.
  // Hide them from reviewers so they do not see controls that would only error on submit.
  const session = await requirePersonSession();
  const canManage = await can(session.personId, "recruitment.manage_cycles");
  const zone = await getDisplayTimeZone();

  const activeDepts = await prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { code: "asc" } });
  // Withdrawn applications are excluded: this count warns staff how many
  // applicants a department removal would affect, and nobody will act on a
  // withdrawn one, so counting it overstates the consequence.
  const apps = await prisma.application.findMany({ where: { cycleId: id, status: { not: "WITHDRAWN" } }, select: { departmentChoices: true } });
  const counts = new Map<string, number>();
  for (const a of apps) for (const c of a.departmentChoices) counts.set(c, (counts.get(c) ?? 0) + 1);
  const activeCodes = new Set(activeDepts.map((d) => d.code));
  const deptOptions = [
    ...activeDepts.map((d) => ({ code: d.code, name: d.name, known: true })),
    ...cycle.departments.filter((c) => !activeCodes.has(c)).map((c) => ({ code: c, name: null as string | null, known: false })),
  ];
  // Annotate each option so staff see the consequence of removing a department
  // (applicant counts, and codes no longer in the active department list) both in
  // the dropdown and on the selected chip.
  const deptSelectOptions = deptOptions.map((d) => {
    const c = counts.get(d.code) ?? 0;
    const parts: string[] = [];
    if (c > 0) parts.push(`${c} applicant${c === 1 ? "" : "s"}`);
    if (!d.known) parts.push("not in department list");
    return {
      value: d.code,
      label: d.name ? `${d.code} - ${d.name}` : d.code,
      note: parts.length ? parts.join(" · ") : undefined,
    };
  });
  const applyUrl = await portalUrl(cycle.publicSlug);
  // The opensAt/closesAt window is a soft gate *inside* the OPEN status: the public
  // form only accepts applications while now is in [opensAt, closesAt]. Reflect that
  // here so the admin view matches what an applicant actually sees (issue #106).
  const now = new Date();
  const beforeOpen = cycle.status === "OPEN" && cycle.opensAt !== null && cycle.opensAt > now;
  const afterClose = cycle.status === "OPEN" && cycle.closesAt !== null && cycle.closesAt < now;
  const liveByWindow = cycle.status === "OPEN" && !beforeOpen && !afterClose;
  const isTrainingTrack = cycle.track === "VOLUNTEER" || cycle.track === "DIRECTOR";
  // The online course that makes up this cycle's morning session, set up (and
  // linked to the cycle) from Learning. It replaced the makeup quiz on
  // 2026-09-19, so the card below points there instead of at quiz questions.
  const makeupCourse = canManage && isTrainingTrack
    ? await prisma.course.findUnique({ where: { makeupForCycleId: id }, select: { id: true, title: true, isActive: true } })
    : null;
  // A test run points back at the cycle it copies; a real cycle lists the test
  // runs made from it, so nobody has to hunt for one in the cycle list.
  const testSource = cycle.isTest && cycle.testSourceCycleId
    ? await prisma.recruitmentCycle.findUnique({ where: { id: cycle.testSourceCycleId }, select: { id: true, title: true } })
    : null;
  // The test-run instructions show the viewer their own address as the example,
  // since the sign-in link and every [TEST] email go to whatever address a
  // fake applicant types in.
  const testerEmail = cycle.isTest ? session.email : null;
  const testerPlusExample = testerEmail && testerEmail.includes("@")
    ? testerEmail.replace("@", "+test1@")
    : null;
  const testRuns = canManage && !cycle.isTest
    ? await prisma.recruitmentCycle.findMany({
        where: { testSourceCycleId: id, isTest: true },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  // Invite links are a manage_cycles capability: issuing one admits an applicant
  // past a closed deadline, which is a recruiting decision, not a viewing one.
  const inviteRows: InviteRow[] = canManage
    ? (await listInvites(cycle.id)).map((i) => ({
        id: i.id,
        label: i.label,
        createdByName: i.createdBy.name ?? "Unknown",
        // formatDateOnly, not toLocaleDateString: these are real timestamps, and
        // the clinic renders every one of them in the configured display zone.
        // A guard test (platform/dates/no-raw-locale.guard.test.ts) enforces it.
        createdAtLabel: formatDateOnly(i.createdAt, zone, { month: "short", day: "numeric" }),
        expiresAtLabel: i.expiresAt
          ? formatDateOnly(i.expiresAt, zone, { month: "short", day: "numeric" })
          : null,
        claimedByEmailLower: i.claimedByEmailLower,
        revoked: i.revokedAt !== null,
        expired: i.expiresAt !== null && i.expiresAt <= now,
      }))
    : [];

  // Returns the claim URL for the panel to show ONCE. Both actions re-check
  // manage_cycles: a server action is a public endpoint in its own right, and the
  // page's own gate does not protect it from being invoked directly.
  async function createInviteAction(formData: FormData): Promise<string> {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    const rawTtl = Number.parseInt(String(formData.get("ttlDays") ?? ""), 10);
    const ttlDays = Number.isFinite(rawTtl) && rawTtl > 0 ? Math.min(rawTtl, 365) : 14;
    const { token } = await createInvite(actor.personId, id, {
      label: String(formData.get("label") ?? ""),
      ttlDays,
    });
    revalidatePath(`/recruitment/cycles/${id}`);
    const base = await portalUrl();
    // portalUrl() with no slug returns the portal home; the claim route hangs off
    // the same origin so an invitee lands on the applicant portal, not the hub.
    return `${base.replace(/\/$/, "")}/i/${token}`;
  }

  async function revokeInviteAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    await revokeInvite(actor.personId, String(formData.get("inviteId") ?? ""));
    revalidatePath(`/recruitment/cycles/${id}`);
  }

  return (
    <PageBody width="form">
      <SetBreadcrumb trail={cycleTrail({ cycleId: id, cycleTitle: cycle.title })} />
      <PageHeader
        title={cycle.title}
        status={<CycleStatusBadge status={cycle.status} />}
      />

      {cycle.isTest && (
        <Alert tone="warning">
          <div className="space-y-2">
            <p className="font-medium text-foreground">This is a test run.</p>
            <p>
              {testSource ? (
                <>Copied from <TextLink href={`/recruitment/cycles/${testSource.id}`}>{testSource.title}</TextLink>. </>
              ) : (
                <>The cycle it was copied from has since been deleted. </>
              )}
              Use it to walk through the cycle with made-up applicants. It is hidden from the public apply
              page, so only people with its link can apply, and every email it sends starts with [TEST].
              Nobody accepted here shows up in a schedule builder or can be added to the roster, and changes
              here do not affect the real cycle.
            </p>
            <p className="font-medium text-foreground">How to try it</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Publish the test run, then open its link under Public link below.</li>
              <li>
                Apply the way a volunteer would. When the form asks for an email, use one you can open: the
                sign-in link and every [TEST] email go to that inbox, so you see exactly what applicants will.
                {testerEmail ? (
                  <> For example, apply with <span className="font-medium text-foreground">{testerEmail}</span> and
                  check your own inbox.</>
                ) : null}
              </li>
              <li>
                To be more than one fake applicant from the same inbox, add +test1, +test2 and so on before the @.
                {testerPlusExample ? (
                  <> For example, <span className="font-medium text-foreground">{testerPlusExample}</span>.</>
                ) : null}{" "}
                Gmail delivers these to the same inbox; not every email provider does, so send a test to yours
                first.
              </li>
              <li>Review, decide and send onboarding as you would in the real cycle, then delete the test run.</li>
            </ol>
            {canManage && (
              <form action={deleteTestCycleAction.bind(null, id)}>
                <ConfirmButton label="Delete test run" confirmLabel="Delete this test run and everyone in it?" size="sm" />
              </form>
            )}
          </div>
        </Alert>
      )}

      <Card>
        <SectionHeader>Public link</SectionHeader>
        {cycle.status === "OPEN" ? (
          <div className="mt-1 space-y-1">
            {liveByWindow ? (
              <TextLink href={applyUrl} size="sm" className="inline-block font-medium">
                {applyUrl}
              </TextLink>
            ) : (
              <p className="text-sm text-muted-foreground">{applyUrl}</p>
            )}
            {beforeOpen && (
              <p className="text-xs text-subtle-foreground">Scheduled to open <DateTime value={cycle.opensAt} />. Not accepting applications yet.</p>
            )}
            {afterClose && (
              <p className="text-xs text-subtle-foreground">Application window closed <DateTime value={cycle.closesAt} />. No longer accepting applications.</p>
            )}
            {liveByWindow && cycle.closesAt && (
              <p className="text-xs text-subtle-foreground">Accepting applications until <DateTime value={cycle.closesAt} />.</p>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Publish the cycle to activate {applyUrl}</p>
        )}
      </Card>

      {canManage && (
        <Card>
          <InvitePanel
            rows={inviteRows}
            createAction={createInviteAction}
            revokeAction={revokeInviteAction}
          />
        </Card>
      )}

      <Card className="space-y-3">
        <SectionHeader>Departments</SectionHeader>
        {cycle.status === "ARCHIVED" || !canManage ? (
          <div className="flex flex-wrap gap-2">
            {cycle.departments.length === 0 ? (
              <EmptyState inline>No departments.</EmptyState>
            ) : (
              cycle.departments.map((c) => (
                <span key={c} className="rounded-lg border border-border px-2 py-1 text-sm text-foreground">{c}</span>
              ))
            )}
          </div>
        ) : (
          <form action={setCycleDepartmentsAction.bind(null, id)} className="space-y-3">
            {deptSelectOptions.length === 0 ? (
              <EmptyState inline>No departments configured.</EmptyState>
            ) : (
              <MultiCombobox
                name="departments"
                options={deptSelectOptions}
                defaultValue={cycle.departments}
                ariaLabel="Departments"
                placeholder="Search departments…"
              />
            )}
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save departments</SubmitButton>
            </FormActions>
          </form>
        )}
      </Card>

      {canManage && (cycle.status === "DRAFT" || cycle.status === "OPEN") && (
        <Card className="space-y-3">
          <SectionHeader>Application window</SectionHeader>
          <p className="text-sm text-muted-foreground">
            Optional. While the cycle is open, the public form only accepts applications inside this window. Leave a field blank for no bound, or clear both to accept whenever the cycle is open. Times are in {zoneLabel(zone)}.
          </p>
          <form action={setApplicationWindowAction.bind(null, id)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Opens" hint="Blank means open as soon as the cycle is published.">
                <Input type="datetime-local" name="opensAt" defaultValue={formatForDateTimeInput(cycle.opensAt, zone)} />
              </Field>
              <Field label="Closes" hint="Blank means stay open until the cycle is closed.">
                <Input type="datetime-local" name="closesAt" defaultValue={formatForDateTimeInput(cycle.closesAt, zone)} />
              </Field>
            </div>
            <FormActions>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save window</SubmitButton>
            </FormActions>
          </form>
        </Card>
      )}

      {canManage && (
      <div className="flex flex-wrap items-center gap-3">
        {cycle.status === "DRAFT" && (
          <form action={publishCycleAction.bind(null, id)}>
            <SubmitButton size="sm" pendingLabel="Publishing…">Publish</SubmitButton>
          </form>
        )}
        {cycle.status === "OPEN" && (
          <form action={closeCycleAction.bind(null, id)}>
            <SubmitButton size="sm" variant="outline" pendingLabel="Closing…">Close</SubmitButton>
          </form>
        )}
        {cycle.status === "CLOSED" && (
          <>
            <form action={reopenCycleAction.bind(null, id)}>
              <SubmitButton size="sm" variant="outline" pendingLabel="Reopening…">Reopen</SubmitButton>
            </form>
            <form action={archiveCycleAction.bind(null, id)}>
              <ConfirmButton label="Archive" confirmLabel="Archive this cycle?" size="sm" />
            </form>
          </>
        )}
        {cycle.status === "ARCHIVED" && (
          <>
            <p className="text-sm text-subtle-foreground">
              Archived. Removed from the active cycle list, and decisions, onboarding links and waitlist
              promotions are blocked. Un-archive to finish anyone still mid-pipeline.
            </p>
            <form action={unarchiveCycleAction.bind(null, id)}>
              <SubmitButton size="sm" variant="outline" pendingLabel="Un-archiving…">Un-archive</SubmitButton>
            </form>
          </>
        )}
        {(cycle.status === "DRAFT" || cycle.status === "OPEN") && (
          <form action={toggleRenewalsAction.bind(null, id, !cycle.acceptsRenewals)}>
            <SubmitButton size="sm" variant="ghost">
              {cycle.acceptsRenewals ? "Disable" : "Enable"} renewal branch
            </SubmitButton>
          </form>
        )}
      </div>
      )}

      {canManage && !cycle.isTest && (
        <Card className="space-y-3">
          <SectionHeader>Test run</SectionHeader>
          <p className="text-sm text-muted-foreground">
            Copy this cycle&apos;s form, emails, onboarding contract and settings into a separate test run, then
            walk through it with made-up applicants before the real one goes out. The copy starts as a draft and
            is hidden from the public apply page. Its emails are marked [TEST], and nobody in it can reach a
            schedule or the roster. Delete it when you&apos;re done.
          </p>
          {testRuns.length > 0 && (
            <ul className="space-y-1 text-sm">
              {testRuns.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <TextLink href={`/recruitment/cycles/${t.id}`} className="font-medium">{t.title}</TextLink>
                  <CycleStatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
          <form action={createTestCycleAction.bind(null, id)}>
            <SubmitButton size="sm" variant="outline" pendingLabel="Copying…">Start a test run</SubmitButton>
          </form>
        </Card>
      )}

      {isTrainingTrack && (
        <Card className="space-y-4">
          <SectionHeader>{cycle.track === "DIRECTOR" ? "Director training" : "Training"}</SectionHeader>
          {canManage && (
            <>
              {/* A test run can never be the term's training cycle (training.ts
                  refuses it), so it gets no toggle and no makeup course. */}
              {!cycle.isTest && (
                <form action={setTrainingCycleAction.bind(null, id, !cycle.isTermTraining)}>
                  <SubmitButton size="sm" variant="ghost">
                    {cycle.isTermTraining ? "Stop using as this term's training" : "Use as this term's training"}
                  </SubmitButton>
                </form>
              )}
              {cycle.isTest ? null : makeupCourse ? (
                <p className="text-sm text-muted-foreground">
                  Online makeup course:{" "}
                  <TextLink href={`/learning/manage/${makeupCourse.id}`} className="font-medium">
                    {makeupCourse.title}
                  </TextLink>
                  {makeupCourse.isActive ? "" : " (inactive, so nobody can see it yet)"}
                </p>
              ) : (
                <EmptyState inline>
                  No online makeup course yet. Create a video course in Learning and link it to this
                  cycle; members who owe the morning session will see it on their training page.
                </EmptyState>
              )}
              <form action={updateQuizSettingsAction.bind(null, id)}>
                <FormRow>
                  <RowField label="In-person training date">
                    <Input
                      name="inPersonTrainingDate"
                      type="date"
                      defaultValue={cycle.inPersonTrainingDate ? formatForDateInput(cycle.inPersonTrainingDate, zone) : ""}
                    />
                  </RowField>
                  <RowField label="Training location / time" width="wide">
                    <Input
                      name="trainingLocation"
                      type="text"
                      defaultValue={cycle.trainingLocation ?? ""}
                      placeholder="on Zoom at 10:00 AM"
                    />
                  </RowField>
                  <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save training settings</SubmitButton>
                </FormRow>
              </form>
            </>
          )}
        </Card>
      )}
    </PageBody>
  );
}
