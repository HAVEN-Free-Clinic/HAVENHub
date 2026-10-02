import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { formatForDateTimeInput } from "@/platform/dates/format";
import { DateTime } from "@/platform/dates/display";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
import { EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import { getForm, listResponses, assignmentStatus, summarize } from "@/modules/forms/service";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { Button, buttonClasses } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { CopyButton } from "@/platform/ui/copy-button";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { EmptyState } from "@/platform/ui/empty-state";
import { SectionHeader } from "@/platform/ui/section-header";
import { TabRow, type TabItem } from "@/platform/ui/tab-row";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { FORM_STATUS_LABELS, FORM_STATUS_TONES } from "../status";
import { FormBuilder } from "./form-builder";
import { AssignAudienceForm, AssignListForm } from "./assign-forms";
import { ResultsSummary } from "./results-summary";
import {
  saveFormAction,
  setStatusAction,
  duplicateFormAction,
  deleteFormAction,
  assignAudienceAction,
  assignListAction,
  countAssignNodesAction,
  unassignAction,
  remindAction,
} from "./actions";

type Tab = "build" | "assign" | "responses";

export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requirePermission("forms.manage");
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const form = await getForm(id);
  if (!form) notFound();

  const tab: Tab = rawTab === "assign" || rawTab === "responses" || rawTab === "build"
    ? rawTab
    : form._count.responses > 0 ? "responses" : "build";

  const zone = await getDisplayTimeZone();
  const base = (await getSetting<string>("app.baseUrl")).replace(/\/$/, "");
  const link = `${base}/my-info/forms/${id}`;

  const tabs: TabItem[] = [
    { label: "Build", href: `/forms/${id}?tab=build` },
    { label: "Assign & share", href: `/forms/${id}?tab=assign`, badge: form._count.assignments || undefined },
    { label: "Responses", href: `/forms/${id}?tab=responses`, badge: form._count.responses || undefined },
  ];
  const isActive = (item: TabItem) => new URLSearchParams(item.href.split("?")[1]).get("tab") === tab;

  const boundStatus = setStatusAction.bind(null, id);

  return (
    <div className="space-y-6">
      <SetBreadcrumbLeaf label={form.title} />
      <PageHeader
        title={form.title}
        status={<Badge tone={FORM_STATUS_TONES[form.status]}>{FORM_STATUS_LABELS[form.status]}</Badge>}
        description={form.updatedBy ? `Last edited by ${form.updatedBy.name}.` : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {form.status !== "OPEN" && (
              <form action={boundStatus}>
                <input type="hidden" name="status" value="OPEN" />
                <Button type="submit" size="sm">
                  {form.status === "DRAFT" ? "Open for responses" : "Reopen"}
                </Button>
              </form>
            )}
            {form.status === "OPEN" && (
              <form action={boundStatus}>
                <input type="hidden" name="status" value="CLOSED" />
                <ConfirmButton size="sm" label="Close form" confirmLabel="Stop accepting responses?" />
              </form>
            )}
            <form action={duplicateFormAction.bind(null, id)}>
              <Button type="submit" variant="outline" size="sm">
                Duplicate
              </Button>
            </form>
            {form._count.responses === 0 && (
              <form action={deleteFormAction.bind(null, id)}>
                <ConfirmButton size="sm" label="Delete" confirmLabel="Delete this form?" />
              </form>
            )}
          </div>
        }
      />

      {form.status === "DRAFT" && (
        <Alert tone="info">
          This form is a draft. Nobody can fill it out until you open it for responses.
        </Alert>
      )}
      {form.status === "OPEN" && form.closesAt && (
        <p className="text-sm text-muted-foreground">
          Closes <DateTime value={form.closesAt} />.
        </p>
      )}

      <TabRow variant="underline" label="Form sections" items={tabs} isActive={isActive} />

      {tab === "build" && (
        <FormBuilder
          key={form.layoutVersion}
          initialLayout={form.parsedLayout}
          initialSettings={{
            title: form.title,
            description: form.description,
            openToAnyone: form.openToAnyone,
            allowEdits: form.allowEdits,
            closesAt: form.closesAt ? formatForDateTimeInput(form.closesAt, zone) : "",
          }}
          layoutVersion={form.layoutVersion}
          responseCount={form._count.responses}
          zoneLabel={zoneLabel(zone)}
          action={saveFormAction.bind(null, id)}
        />
      )}

      {tab === "assign" && <AssignTab id={id} link={link} open={form.status === "OPEN"} openToAnyone={form.openToAnyone} />}

      {tab === "responses" && <ResponsesTab id={id} layout={form.parsedLayout} />}
    </div>
  );
}

async function AssignTab({ id, link, open, openToAnyone }: { id: string; link: string; open: boolean; openToAnyone: boolean }) {
  const [status, options] = await Promise.all([assignmentStatus(id), loadAudienceBuilderOptions(EMPTY_AUDIENCE)]);
  const pending = status.filter((s) => !s.responded);
  const pendingEmails = pending.flatMap((s) => (s.person.contactEmail ? [s.person.contactEmail] : []));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHeader level="title">Share link</SectionHeader>
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-sm">{link}</code>
            <CopyButton value={link} label="Copy link" />
          </div>
          <p className="text-sm text-muted-foreground">
            {openToAnyone
              ? "Anyone who signs in to the Hub with this link can respond."
              : "Only the people assigned below can respond with this link. To let anyone signed in respond, turn that on under Build."}{" "}
            Responses always carry the respondent&apos;s name.
          </p>
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Completion</SectionHeader>
        {status.length === 0 ? (
          <Card>
            <EmptyState inline>Nobody is assigned yet. Assign people below.</EmptyState>
          </Card>
        ) : (
          <>
            <p className="text-sm text-foreground-soft">
              {status.length - pending.length} of {status.length} assigned have responded.
            </p>
            {pending.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <form action={remindAction.bind(null, id)}>
                  <ConfirmButton
                    size="sm"
                    disabled={!open}
                    label={`Email a reminder to ${pending.length} ${pending.length === 1 ? "person" : "people"}`}
                    confirmLabel={`Send ${pending.length} reminder ${pending.length === 1 ? "email" : "emails"}?`}
                  />
                </form>
                {pendingEmails.length > 0 && <CopyButton value={pendingEmails.join("; ")} label="Copy their emails" />}
              </div>
            )}
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Status</TH>
                  <TH>Assigned</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <tbody>
                {status.map((s) => (
                  <TR key={s.person.id}>
                    <TD>
                      <div className="font-medium text-foreground">{s.person.name}</div>
                      <div className="text-xs text-muted-foreground">{s.person.contactEmail ?? ""}</div>
                    </TD>
                    <TD>
                      {s.responded ? <Badge tone="success">Responded</Badge> : <Badge tone="default">Waiting</Badge>}
                      {!s.responded && s.remindedAt && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          reminded <DateTime value={s.remindedAt} />
                        </span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      <DateTime value={s.assignedAt} />
                    </TD>
                    <TD className="text-right">
                      {!s.responded && (
                        <form action={unassignAction.bind(null, id)}>
                          <input type="hidden" name="personId" value={s.person.id} />
                          <ConfirmButton size="sm" label="Unassign" confirmLabel={`Unassign ${s.person.name}?`} />
                        </form>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Assign by audience</SectionHeader>
        <Card>
          <AssignAudienceForm
            action={assignAudienceAction.bind(null, id)}
            countAction={countAssignNodesAction.bind(null, id)}
            open={open}
            options={{
              fields: PERSON_FIELD_VIEWS,
              departments: options.departments,
              terms: options.terms,
              cycles: options.cycles,
              subcommittees: options.subcommittees,
              zoneLabel: options.zoneLabel,
            }}
          />
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Assign by list</SectionHeader>
        <Card>
          <AssignListForm action={assignListAction.bind(null, id)} open={open} />
        </Card>
      </section>
    </div>
  );
}

async function ResponsesTab({ id, layout }: { id: string; layout: Parameters<typeof summarize>[0] }) {
  const responses = await listResponses(id);
  if (responses.length === 0) {
    return (
      <Card>
        <EmptyState inline>No responses yet.</EmptyState>
      </Card>
    );
  }
  const summary = summarize(layout, responses);
  const questions = layout.questions.filter((q) => q.type !== "section");
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground-soft">
          {responses.length} {responses.length === 1 ? "response" : "responses"}
          {responses.some((r) => r.source === "AIRTABLE") && " (including responses imported from Airtable)"}.
        </p>
        {/* A route handler, not an action: the browser downloads the file. */}
        <a href={`/forms/${id}/export`} className={buttonClasses("outline", "sm")} download>
          Download CSV
        </a>
      </div>

      <section className="space-y-3">
        <SectionHeader level="title">Summary</SectionHeader>
        <ResultsSummary summary={summary} />
      </section>

      <section className="space-y-3">
        <SectionHeader level="title">Individual responses</SectionHeader>
        <div className="space-y-2">
          {responses.map((r) => (
            <details key={r.id} className="rounded-xl border border-border bg-surface">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="font-medium text-foreground">{r.name}</span>
                <span className="text-muted-foreground">
                  <DateTime value={r.submittedAt} />
                  {r.source === "AIRTABLE" && " · Airtable"}
                </span>
              </summary>
              <dl className="space-y-3 border-t border-border px-4 py-3 text-sm">
                {questions.map((q) => {
                  const v = r.answers[q.key];
                  return (
                    <div key={q.key}>
                      <dt className="font-medium text-foreground-soft">{q.label}</dt>
                      <dd className="mt-0.5 whitespace-pre-line text-foreground">
                        {v === undefined || v === "" ? (
                          <span className="text-subtle-foreground">No answer</span>
                        ) : Array.isArray(v) ? (
                          v.join(", ")
                        ) : (
                          v
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
