import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/platform/auth/session";
import {
  getCampaign,
  assertMayActOnScope,
  previewAudience,
  senderIdentitiesForCampaign,
  CampaignScopeError,
  CampaignValidationError,
  type AudiencePreview,
} from "@/platform/email/campaigns/service";
import { SENDING_DOMAINS } from "@/platform/email/sending-domains";
import { mailConnectionStatus } from "@/platform/email/oauth";
import { UnknownAudienceFieldError } from "@/platform/email/audience/person-fields";
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
import type { SendingDomainMap } from "../../sender-identity-notes";
import {
  saveAction,
  previewAction,
  countNodesAction,
  searchPeopleAction,
  includePersonAction,
  excludePersonAction,
  clearExcludedAction,
  pastedEmailsAction,
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
  const senderOptions = isDraft ? await senderIdentitiesForCampaign(actor.personId, id) : [];
  // Plain data for the client notes: sending-domains.ts reads `@/platform/config`
  // at import and must not be bundled into the browser.
  const domains: SendingDomainMap = Object.fromEntries(SENDING_DOMAINS);
  const mail = isDraft
    ? await mailConnectionStatus()
    : { account: null as string | null };

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
        <ComposeForm id="campaign-compose" action={boundSaveAction}>
          {/* Tracks which tab was showing when Save was clicked, so a
              successful (or rejected) save redirects back to the same tab
              instead of always landing on Compose. */}
          <input type="hidden" name="tab" value={activeTab} />

          {/* Section 1: Compose */}
          <div hidden={activeTab !== "compose"} className="space-y-6">
            <h2 className="text-base font-semibold text-foreground">1. Compose</h2>

            {/* Campaign name */}
            <div className="max-w-sm">
              <CampaignNameField initialName={campaign.name} />
            </div>

            {/* Sending identity. Sits in the Compose section because the From
                address is part of composing the message, and because this is
                the point at which the two consequences the sender cannot
                otherwise see (the Graph throughput ceiling and the Send-As
                requirement) are still cheap to act on. */}
            <SenderPicker
              options={senderOptions}
              initial={campaign.fromEmail}
              domains={domains}
              connectedMailbox={mail.account}
            />

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
          />
        </div>
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
