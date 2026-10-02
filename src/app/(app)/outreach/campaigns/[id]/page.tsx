import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/platform/auth/session";
import {
  getCampaign,
  assertMayActOnScope,
  previewAudience,
  senderIdentitiesForCampaign,
  campaignDelivery,
  campaignActivity,
  CampaignScopeError,
  CampaignValidationError,
  type AudiencePreview,
} from "@/platform/email/campaigns/service";
import { UnknownAudienceFieldError } from "@/platform/email/audience/person-fields";
import { loadLayoutSource, renderInlineEmail } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience, EMPTY_AUDIENCE } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
import { DateTime } from "@/platform/dates/display";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { zoneLabel } from "@/platform/dates/zone";
import { formatDateTime } from "@/platform/dates/format";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Card } from "@/platform/ui/card";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";
import { AudienceBuilder } from "./audience-builder";
import { ComposeForm } from "./compose-form";
import { CampaignNameField } from "./campaign-name-field";
import { ReviewActions } from "./review-actions";
import { RecipientPreview } from "./recipient-preview";
import { TimingActions } from "./timing-actions";
import { EditorTabs, type EditorTab } from "./tabs";
import { SenderPicker } from "./sender-picker";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { SectionHeader } from "@/platform/ui/section-header";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { CampaignPresence } from "./campaign-presence";
import { DeliveryRefresh } from "./delivery-refresh";
import { ActivityLog } from "./activity-log";
import {
  saveAction,
  previewAction,
  countNodesAction,
  searchPeopleAction,
  includePersonAction,
  excludePersonAction,
  clearExcludedAction,
  pastedEmailsAction,
  applicantCycleAction,
  testAction,
  sendAction,
  scheduleLaterAction,
  scheduleRecurringAction,
  cancelAction,
  unscheduleAction,
  duplicateAction,
  deleteAction,
  retryFailedAction,
  heartbeatAction,
  leaveAction,
} from "./actions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
};

/**
 * The recipient roll for the Audience tab, or null if it cannot be resolved.
 *
 * Module scope, like every other helper this page's server actions sit beside:
 * see the doc comment at the top of actions.ts for what a render-scope function
 * costs at runtime.
 *
 * Degrades to null rather than propagating, for the same reason
 * countNodesAction returns an empty map. Both failures here describe an audience
 * the builder is specifically built to let a sender REPAIR: a stored tree that
 * no longer parses, and one naming a field that has since been retired (which
 * field-picker.tsx renders as "Unknown field" with a control to remove it).
 * Throwing would take down the whole editor for exactly the campaign someone
 * opened it to fix. Caught by type, so any other failure still surfaces.
 */
async function loadRecipientPreview(id: string): Promise<AudiencePreview | null> {
  try {
    return await previewAudience(id);
  } catch (err) {
    if (err instanceof CampaignValidationError) return null;
    if (err instanceof UnknownAudienceFieldError) return null;
    throw err;
  }
}

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

  // The identities this person may send this campaign as, in resolution order.
  // The same list the server authorizes a submitted choice against, so the menu
  // can never offer something the save would refuse. Loaded only for a draft,
  // since nothing else can change the sender.
  // The sending-domain notes (SENDING_DOMAINS as plain data, plus the mailbox
  // Graph is connected as) used to be resolved here for SenderPicker. They were
  // removed from the composer: they answer an ADMIN's question at issue time,
  // not a sender's at compose time, and a sender can only pick from what an
  // admin already approved. mailConnectionStatus() went with them, which also
  // takes an OAuth-status read off every draft render.
  const senderOptions = isDraft ? await senderIdentitiesForCampaign(actor.personId, id) : [];

  const zone = await getDisplayTimeZone();

  // Resolved on the server, and only for the tab that shows it. Unlike the
  // per-node counts (which the builder fetches as the sender types), this is the
  // saved roll: rendering it up front is what makes the Audience tab show who is
  // about to be emailed without a button press. Gated on the ACTIVE tab because
  // every section of this page stays mounted regardless of which one is showing
  // (see tabs.tsx), so an ungated call would resolve the entire audience on
  // every Compose and Review load for a pane nobody can see.
  const recipientPreview =
    isDraft && activeTab === "audience" ? await loadRecipientPreview(id) : null;

  const [delivery, activity] = await Promise.all([
    campaignDelivery(id),
    campaignActivity(id),
  ]);
  const deliveryByRun = new Map(delivery.runs.map((r) => [r.runId, r]));
  const pending = delivery.runs.reduce((n, r) => n + r.queued, 0);

  // A non-draft campaign can no longer be edited, so it gets a read-only render
  // of what was (or will be) sent, with the same sample values the editor's
  // preview uses. Before this only the subject was visible after sending.
  const sentPreview = isDraft
    ? null
    : await renderInlineEmail(
        { subject: campaign.subject, body: campaign.body },
        Object.fromEntries(PERSON_VARIABLES.map((v) => [v.name, v.sampleValue])),
        layoutSource,
        brandColor,
      );

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
  // The manual-list controls. Bound exactly like the rest, and gated on the
  // same scope inside actions.ts: a scoped sender may no more edit another
  // department's recipient list than they may preview or send that campaign.
  const boundSearchPeopleAction = searchPeopleAction.bind(null, id, scopeId);
  const boundIncludePersonAction = includePersonAction.bind(null, id, scopeId);
  const boundExcludePersonAction = excludePersonAction.bind(null, id, scopeId);
  const boundClearExcludedAction = clearExcludedAction.bind(null, id, scopeId);
  const boundPastedEmailsAction = pastedEmailsAction.bind(null, id, scopeId);
  const boundApplicantCycleAction = applicantCycleAction.bind(null, id, scopeId);
  const boundTestAction = testAction.bind(null, id, scopeId);
  const boundSendAction = sendAction.bind(null, id, scopeId);
  const boundScheduleLaterAction = scheduleLaterAction.bind(null, id, scopeId);
  const boundScheduleRecurringAction = scheduleRecurringAction.bind(null, id, scopeId);
  const boundCancelAction = cancelAction.bind(null, id, scopeId);
  const boundUnscheduleAction = unscheduleAction.bind(null, id, scopeId);
  const boundDuplicateAction = duplicateAction.bind(null, id, scopeId);
  const boundDeleteAction = deleteAction.bind(null, id, scopeId);
  const boundRetryFailedAction = retryFailedAction.bind(null, id, scopeId);
  const boundHeartbeatAction = heartbeatAction.bind(null, id, scopeId);
  const boundLeaveAction = leaveAction.bind(null, id);

  return (
    <div className="space-y-6">
      <SetBreadcrumbLeaf label={campaign.name} />
      <PageHeader
        title={campaign.name}
        description={`${
          isSent
            ? "This campaign has already been sent."
            : isScheduled
              ? "Scheduled. Waiting to send."
              : isActive
                ? "Recurring. Sends on a schedule."
                : campaign.status === "CANCELLED"
                  ? "Cancelled."
                  : "Draft."
        }${
          campaign.updatedBy
            ? ` Last edited by ${campaign.updatedBy.name}, ${formatDateTime(campaign.updatedAt, zone)}.`
            : ""
        }`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <form action={boundDuplicateAction}>
              <Button type="submit" variant="outline" size="sm">
                Duplicate
              </Button>
            </form>
            {isDraft && campaign.runs.length === 0 && (
              <form action={boundDeleteAction}>
                <ConfirmButton size="sm" label="Delete draft" confirmLabel="Delete this draft?" />
              </form>
            )}
          </div>
        }
      />

      {isDraft && (
        <CampaignPresence
          heartbeat={boundHeartbeatAction}
          leave={boundLeaveAction}
          loadedVersion={campaign.contentVersion}
        />
      )}

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
        <ComposeForm
          id="campaign-compose"
          action={boundSaveAction}
          savedAt={campaign.updatedAt.toISOString()}
          contentVersion={campaign.contentVersion}
        >
          {/* Tracks which tab was showing when Save was clicked, so a
              successful (or rejected) save redirects back to the same tab
              instead of always landing on Compose. */}
          <input type="hidden" name="tab" value={activeTab} />

          {/* Section 1: Compose */}
          <div hidden={activeTab !== "compose"} className="space-y-6">
            <SectionHeader level="title">1. Compose</SectionHeader>

            {/* Campaign name */}
            <div className="max-w-sm">
              <CampaignNameField initialName={campaign.name} />
            </div>

            {/* Sending identity. Sits in the Compose section because the From
                address is part of composing the message. A closed list, no
                warning panels: the Graph throughput ceiling and the Send-As
                requirement are shown where they are still actionable, which is
                the three admin surfaces that CREATE an identity. */}
            <SenderPicker options={senderOptions} initial={campaign.fromEmail} />

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
            <SectionHeader level="title">2. Audience</SectionHeader>
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

        </ComposeForm>
      )}

      {/* The recipient roll and the manual include / exclude / paste controls.
          A SIBLING of the compose form, not a child of it: every control here is
          its own form posting its own server action, and a nested <form> is
          invalid HTML that the parser unnests, which would silently reparent
          these buttons into the compose form and make each one save the
          campaign instead. Tab-gated the same way the sections inside the form
          are. */}
      {isDraft && (
        // Rendered on EVERY tab, not just the Audience one, and gated only with
        // `hidden` like the sections inside the compose form above. The panel
        // returns null without a roll, so this costs nothing to show, and it is
        // not a style choice: its dirty guard is a listener that starts at
        // mount, so a panel mounted by the tab switch could not see an edit made
        // on Compose beforehand and arrived with every control enabled. The
        // first click then discarded the unsaved compose state, audience tree
        // included. See the doc comment in recipient-preview.tsx.
        //
        // Only the ROLL is tab-gated, on the server, because resolving one costs
        // a full audience resolve (see loadRecipientPreview's call site).
        <div hidden={activeTab !== "audience"} className="border-t border-border pt-6">
          <RecipientPreview
            // savedAt, NOT key. Keying this on updatedAt remounts the panel on
            // every manual-list action, which resets the guard and takes the
            // half-typed contents of the paste box with it. The dirty guard
            // resets from the prop instead (useFormDirty). ReviewActions and
            // TimingActions still use the key, which is correct for them:
            // neither holds unsaved text.
            savedAt={campaign.updatedAt.toISOString()}
            formId="campaign-compose"
            preview={recipientPreview}
            excludedCount={campaign.excludePersonIds.length}
            pastedText={campaign.pastedEmails.join("\n")}
            searchAction={boundSearchPeopleAction}
            includeAction={boundIncludePersonAction}
            excludeAction={boundExcludePersonAction}
            clearExcludedAction={boundClearExcludedAction}
            pastedEmailsAction={boundPastedEmailsAction}
            applicantCycleIds={campaign.applicantCycleIds}
            cycleOptions={audienceCycles}
            applicantCycleAction={boundApplicantCycleAction}
          />
        </div>
      )}

      {/* Read-only summary for any non-draft campaign (sent / scheduled / recurring / cancelled) */}
      {!isDraft && sentPreview && (
        <div className="space-y-4">
          <Card className="space-y-2">
            <p className="text-sm font-medium text-foreground-soft">Subject</p>
            <p className="text-sm text-foreground-soft">{campaign.subject || <em className="text-subtle-foreground">No subject</em>}</p>
          </Card>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground-soft">Message (shown with sample data)</p>
            {/* sandbox="" with no allowances: the body is staff-written HTML and
                this frame has no reason to run anything. */}
            <iframe
              title="Campaign message"
              sandbox=""
              className="h-[34rem] w-full rounded-xl border border-border bg-surface"
              srcDoc={sentPreview.html}
            />
          </div>
        </div>
      )}

      {/* Section 3: Review & send (drafts only) */}
      {isDraft && (
        <div hidden={activeTab !== "review"} id="review" className="space-y-4 border-t border-border pt-6">
          <SectionHeader level="title">3. Review &amp; send</SectionHeader>

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
          <p className="text-sm text-brand-fg">
            Need a change? Move it back to draft, edit, and schedule it again. Cancelling stops it
            for good.
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={boundUnscheduleAction}>
              <Button type="submit">Move back to draft</Button>
            </form>
            <form action={boundCancelAction}>
              <ConfirmButton label="Cancel schedule" confirmLabel="Cancel this campaign for good?" />
            </form>
          </div>
        </div>
      )}

      {/* Timing section: DRAFT only. Scheduling reads the last-saved campaign, so
          TimingActions gates the submits behind the same compose-form dirty guard
          ReviewActions uses -- otherwise unsaved edits would be silently scheduled
          (and then locked, since a scheduled campaign can no longer be edited). */}
      {isDraft && (
        <div hidden={activeTab !== "review"} className="space-y-5 border-t border-border pt-6">
          <SectionHeader level="title">Timing</SectionHeader>
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
          <SectionHeader level="title">Sent runs</SectionHeader>
          {campaign.runs.some((run) => run.enqueuedCount < run.recipientCount) && (
            <Alert tone="warning">
              One or more runs enqueued fewer recipient emails than recorded: a run may have
              been interrupted just after it was marked sent. Compare the Recipients and Enqueued
              columns below and resend if recipients are missing.
            </Alert>
          )}
          {pending > 0 && (
            <>
              <DeliveryRefresh />
              <p className="text-sm text-muted-foreground">
                {pending} {pending === 1 ? "email is" : "emails are"} still being delivered. Large
                sends go out at about 30 a minute; this page updates on its own.
              </p>
            </>
          )}
          <Table>
            <THead>
              <TR>
                <TH>Sent at</TH>
                <TH>Recipients</TH>
                <TH>Enqueued</TH>
                <TH>Delivered</TH>
                <TH>Pending</TH>
                <TH>Failed</TH>
              </TR>
            </THead>
            <tbody>
              {campaign.runs.map((run) => {
                const d = deliveryByRun.get(run.id);
                return (
                  <TR key={run.id}>
                    <TD className="text-foreground-soft"><DateTime value={run.runAt} /></TD>
                    <TD className="text-foreground-soft">{run.recipientCount}</TD>
                    <TD className={run.enqueuedCount < run.recipientCount ? "font-medium text-foreground" : "text-foreground-soft"}>
                      {run.enqueuedCount}
                    </TD>
                    <TD className="text-foreground-soft">{d?.sent ?? 0}</TD>
                    <TD className="text-foreground-soft">{d?.queued ?? 0}</TD>
                    <TD className={d && d.failed > 0 ? "font-medium text-critical-foreground" : "text-foreground-soft"}>
                      {d?.failed ?? 0}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>

          {delivery.failedTotal > 0 && (
            <div className="space-y-3">
              <Alert tone="error">
                {delivery.failedTotal} {delivery.failedTotal === 1 ? "email" : "emails"} could not
                be delivered after repeated attempts. A bad address will fail again; a temporary
                outage usually succeeds on retry.
              </Alert>
              <Table>
                <THead>
                  <TR>
                    <TH>Recipient</TH>
                    <TH>Reason</TH>
                  </TR>
                </THead>
                <tbody>
                  {delivery.failed.map((f) => (
                    <TR key={f.id}>
                      <TD className="text-foreground-soft">{f.toEmail}</TD>
                      <TD className="text-xs text-muted-foreground">{f.lastError ?? "Unknown error"}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
              {delivery.failedTotal > delivery.failed.length && (
                <p className="text-xs text-muted-foreground">
                  Showing the first {delivery.failed.length} of {delivery.failedTotal}.
                </p>
              )}
              <form action={boundRetryFailedAction}>
                <Button type="submit" variant="outline">
                  Retry failed emails
                </Button>
              </form>
            </div>
          )}
        </div>
      )}

      {activity.length > 0 && (
        <div className="space-y-3 border-t border-border pt-6">
          <SectionHeader level="title">Activity</SectionHeader>
          <ActivityLog entries={activity} />
        </div>
      )}
    </div>
  );
}
