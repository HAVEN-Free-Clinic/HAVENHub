import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/platform/auth/session";
import {
  getCampaign,
  assertMayActOnScope,
  CampaignScopeError,
} from "@/platform/email/campaigns/service";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
import { DateTime } from "@/platform/dates/display";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input, Field } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";
import { AudienceBuilder } from "./audience-builder";
import { SubmitButton } from "./submit-button";
import { ReviewActions } from "./review-actions";
import { TimingActions } from "./timing-actions";
import { EditorTabs, type EditorTab } from "./tabs";
import {
  saveAction,
  previewAction,
  countNodesAction,
  testAction,
  sendAction,
  scheduleLaterAction,
  scheduleRecurringAction,
  cancelAction,
} from "./actions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export default async function CampaignEditorPage({ params, searchParams }: Props) {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const activeTab: EditorTab =
    rawTab === "audience" ? "audience" : rawTab === "review" ? "review" : "compose";

  const campaign = await getCampaign(id);
  if (!campaign) redirect("/outreach/campaigns");

  // Captured here (rather than reading campaign.scopeId at each .bind() call
  // below) purely for brevity across the seven actions bound further down --
  // unlike the pre-split version of this page, none of those actions are
  // nested closures anymore (they live in actions.ts, taking scopeId as an
  // explicit parameter), so there is no closure-narrowing pitfall left to
  // work around here. Verified with `tsc --noEmit`.
  const scopeId = campaign.scopeId;

  // A scoped sender may not even OPEN a campaign outside every scope they hold:
  // the URL alone would otherwise leak another department's audience and
  // content. /no-access rather than the ?error= pattern the actions below use,
  // since there is no "back to this same page" to usefully redirect to here.
  // The resolved scope is reused below for display (boundScope) instead of
  // querying it again.
  let boundScope: Awaited<ReturnType<typeof assertMayActOnScope>>;
  try {
    boundScope = await assertMayActOnScope(actor.personId, scopeId);
  } catch (err) {
    if (err instanceof CampaignScopeError) redirect("/no-access");
    throw err;
  }

  const isSent = campaign.status === "SENT";
  const isDraft = campaign.status === "DRAFT";
  const isScheduled = campaign.status === "SCHEDULED";
  const isActive = campaign.status === "ACTIVE";

  const [layoutSource, brandColor] = await Promise.all([
    loadLayoutSource(),
    getSetting<string>("branding.brandColor"),
  ]);

  const parsedAudience: Audience = isAudience(campaign.audienceJson)
    ? campaign.audienceJson
    : EMPTY_AUDIENCE;

  const {
    departments: audienceDepartments,
    terms: audienceTerms,
    cycles: audienceCycles,
    subcommittees: audienceSubcommittees,
    zoneLabel: audienceZoneLabel,
  } = await loadAudienceBuilderOptions(parsedAudience);

  const scopeName = boundScope?.name ?? "a deleted scope";

  const zone = await getDisplayTimeZone();

  // ---------------------------------------------------------------------------
  // Server actions, bound to this campaign's id and scope. `.bind()` is the
  // sanctioned way to pass extra arguments to a Server Action referenced from
  // a form -- see the doc comment at the top of actions.ts for why these live
  // at module scope instead of as closures declared in this component's body.
  // ---------------------------------------------------------------------------

  const boundSaveAction = saveAction.bind(null, id, scopeId);
  const boundPreviewAction = previewAction.bind(null, id, scopeId);
  // Bound at module scope like every other action here, and for the same
  // reason: the audience it counts arrives as its own trailing argument from
  // the client, never captured from this render scope.
  const boundCountNodesAction = countNodesAction.bind(null, id, scopeId);
  const boundTestAction = testAction.bind(null, id, scopeId);
  const boundSendAction = sendAction.bind(null, id, scopeId);
  const boundScheduleLaterAction = scheduleLaterAction.bind(null, id, scopeId);
  const boundScheduleRecurringAction = scheduleRecurringAction.bind(null, id, scopeId);
  const boundCancelAction = cancelAction.bind(null, id, scopeId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={
          isSent
            ? "This campaign has already been sent."
            : isScheduled
              ? "Scheduled. Waiting to send."
              : isActive
                ? "Recurring. Sends on a schedule."
                : campaign.status === "CANCELLED"
                  ? "Cancelled."
                  : "Draft"
        }
      />

      {/* Compose / Audience / Review tabs. Every section below stays mounted
          regardless of which tab is active (toggled with the `hidden`
          attribute, not conditional rendering) so that no input -- especially
          the audience JSON hidden input and the sendOncePerPerson checkbox,
          which is form-associated from OUTSIDE this form's DOM subtree --
          silently stops submitting with the rest of the compose form just
          because its tab is not the one currently showing. See tabs.tsx. */}
      {isDraft && <EditorTabs active={activeTab} basePath={`/outreach/campaigns/${id}`} />}

      {/* Main save form: editable only while a draft */}
      {isDraft && (
        <form id="campaign-compose" action={boundSaveAction} className="space-y-8">
          {/* Tracks which tab was showing when Save was clicked, so a
              successful (or rejected) save redirects back to the same tab
              instead of always landing on Compose. */}
          <input type="hidden" name="tab" value={activeTab} />

          {/* Section 1: Compose */}
          <div hidden={activeTab !== "compose"} className="space-y-6">
            <h2 className="text-base font-semibold text-foreground">1. Compose</h2>

            {/* Campaign name */}
            <div className="max-w-sm">
              <Field label="Campaign name">
                <Input
                  name="name"
                  type="text"
                  defaultValue={campaign.name}
                  required
                />
              </Field>
            </div>

            {/* Template editor (subject + body) */}
            <TemplateEditor
              variables={PERSON_VARIABLES}
              initialSubject={campaign.subject}
              initialBody={campaign.body}
              isLayout={false}
              layoutSource={layoutSource}
              brandColor={brandColor}
            />
          </div>

          {/* Section 2: Audience */}
          <div hidden={activeTab !== "audience"} className="border-t border-border pt-6 space-y-4">
            <h2 className="text-base font-semibold text-foreground">2. Audience</h2>
            {campaign.scopeId && (
              <Alert tone="info">
                This campaign is bounded by the <strong>{scopeName}</strong> scope. Recipients are
                the people matching BOTH that scope and the conditions below.
              </Alert>
            )}
            <AudienceBuilder
              fields={PERSON_FIELD_VIEWS}
              departments={audienceDepartments}
              terms={audienceTerms}
              cycles={audienceCycles}
              subcommittees={audienceSubcommittees}
              initial={parsedAudience}
              zoneLabel={audienceZoneLabel}
              // Gated on the ACTIVE tab, not merely on being a draft. Every
              // section stays mounted regardless of which tab is showing (see
              // tabs.tsx and the comment above), so the builder mounts on
              // Compose and Review too, and an ungated prop would fan out up to
              // MAX_COUNTED_NODES sequential person counts, plus a table scan
              // per named count-kind field, on every editor load -- for numbers
              // on a hidden pane that nobody can see. The builder itself must
              // stay mounted for its hidden `audience` input; only the counting
              // is conditional.
              countAction={activeTab === "audience" ? boundCountNodesAction : undefined}
            />
          </div>

          {/* Sticky save footer. Always visible (not tab-gated): Save is the
              only way to persist the sendOncePerPerson toggle in the Timing
              section below, which lives under the Review tab, so a sender
              who flips it there still needs Save reachable without switching
              tabs first. */}
          <div className="sticky bottom-0 -mx-1 border-t border-border bg-surface py-3">
            <SubmitButton pendingLabel="Saving...">Save</SubmitButton>
          </div>
        </form>
      )}

      {/* Read-only summary for any non-draft campaign (sent / scheduled / recurring / cancelled) */}
      {!isDraft && (
        <div className="space-y-4">
          <Card className="space-y-2">
            <p className="text-sm font-medium text-foreground-soft">Subject</p>
            <p className="text-sm text-foreground-soft">{campaign.subject || <em className="text-subtle-foreground">No subject</em>}</p>
          </Card>
        </div>
      )}

      {/* Section 3: Review & send (drafts only) */}
      {isDraft && (
        <div hidden={activeTab !== "review"} id="review" className="space-y-4 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">3. Review &amp; send</h2>

          {/* Preview / Test / Send. These operate on the last-saved campaign, so
              ReviewActions disables them while the compose form has unsaved edits. */}
          <ReviewActions
            // Key on updatedAt so a successful save (revalidatePath + redirect ?saved=1)
            // really REMOUNTS this, resetting the useFormDirty guard. A same-page soft
            // nav that only changes search params reconciles rather than remounts, so
            // useState(false) otherwise kept `dirty` true forever and Preview/Test/Send
            // stayed disabled -- telling the admin to "save your changes" right after
            // they saved (#14).
            key={campaign.updatedAt.toISOString()}
            formId="campaign-compose"
            previewAction={boundPreviewAction}
            testAction={boundTestAction}
            sendAction={boundSendAction}
          />

        </div>
      )}

      {/* Schedule status banner (SCHEDULED or ACTIVE) */}
      {(isScheduled || isActive) && (
        <div className="rounded-xl border border-brand/20 bg-brand-faint p-4 space-y-3">
          {isScheduled && campaign.scheduledAt && (
            <p className="text-sm text-brand-fg">
              <strong>Scheduled to send on</strong>{" "}
              <DateTime value={campaign.scheduledAt} />
            </p>
          )}
          {isActive && (
            <p className="text-sm text-brand-fg">
              <strong>Recurring:</strong> {campaign.cronExpr}
              {campaign.nextRunAt && (
                <> (next run <DateTime value={campaign.nextRunAt} />)</>
              )}
            </p>
          )}
          <form action={boundCancelAction}>
            <Button type="submit" variant="outline">
              Cancel schedule
            </Button>
          </form>
        </div>
      )}

      {/* Timing section: DRAFT only. Scheduling reads the last-saved campaign, so
          TimingActions gates the submits behind the same compose-form dirty guard
          ReviewActions uses -- otherwise unsaved edits would be silently scheduled
          (and then locked, since a scheduled campaign can no longer be edited). */}
      {isDraft && (
        <div hidden={activeTab !== "review"} className="space-y-5 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">Timing</h2>
          <TimingActions
            // Remount on save so the useFormDirty guard resets -- see ReviewActions (#14).
            key={campaign.updatedAt.toISOString()}
            formId="campaign-compose"
            scheduleLaterAction={boundScheduleLaterAction}
            scheduleRecurringAction={boundScheduleRecurringAction}
            zoneLabel={zoneLabel(zone)}
            initialSendOncePerPerson={campaign.sendOncePerPerson}
          />
        </div>
      )}

      {/* Sent runs list */}
      {campaign.runs.length > 0 && (
        <div className="space-y-3 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">Sent runs</h2>
          {campaign.runs.some((run) => run.enqueuedCount < run.recipientCount) && (
            <Alert tone="warning">
              One or more runs enqueued fewer recipient emails than recorded &mdash; a run may have
              been interrupted just after it was marked sent. Compare the Recipients and Enqueued
              columns below and resend if recipients are missing.
            </Alert>
          )}
          <Table>
            <THead>
              <TR>
                <TH>Sent at</TH>
                <TH>Recipients</TH>
                <TH>Enqueued</TH>
              </TR>
            </THead>
            <tbody>
              {campaign.runs.map((run) => (
                <TR key={run.id}>
                  <TD className="text-foreground-soft"><DateTime value={run.runAt} /></TD>
                  <TD className="text-foreground-soft">{run.recipientCount}</TD>
                  <TD className={run.enqueuedCount < run.recipientCount ? "font-medium text-foreground" : "text-foreground-soft"}>
                    {run.enqueuedCount}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
