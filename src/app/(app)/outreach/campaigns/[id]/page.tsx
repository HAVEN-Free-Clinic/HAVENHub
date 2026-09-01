import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/platform/auth/session";
import {
  getCampaign,
  updateCampaign,
  previewAudience,
  testSend,
  sendCampaignNow,
  scheduleCampaign,
  cancelCampaign,
  assertMayActOnScope,
  CampaignValidationError,
  CampaignConfirmationError,
  CampaignScopeError,
} from "@/platform/email/campaigns/service";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { loadAudienceBuilderOptions } from "@/platform/email/audience/builder-options";
import { DateTime } from "@/platform/dates/display";
import { parseZonedInput } from "@/platform/dates";
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
import { ReviewActions, type PreviewResult } from "./review-actions";
import { TimingActions } from "./timing-actions";

type Props = {
  params: Promise<{ id: string }>;
};

const EMPTY_AUDIENCE: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [],
};

// Module scope, NOT a closure inside the page component: a "use server" action
// closure can only capture serializable values (Next's transform bundles every
// render-scope identifier an action references as an encrypted bound
// argument), and a plain function reference is not serializable. This used to
// be declared inside CampaignEditorPage's body, which made every action below
// that called it dead at runtime -- the page rendered, but the server threw
// "Functions cannot be passed directly to Client Components" and emitted each
// form's action as `javascript:throw new Error(...)`. Hoisted here and given
// its own explicit, serializable arguments instead of closing over them.
//
// The same predicate CampaignValidationError/CampaignConfirmationError already
// get at each call site below: a blocked sender sees an inline explanation via
// ?error=, not the generic error boundary. Every mutating action shares this
// exact predicate, since a scoped sender may not edit, cancel, preview, or
// send/schedule a campaign outside their granted scopes any more than they may
// view one.
async function assertScopeOrRedirect(
  personId: string,
  scopeId: string | null,
  id: string,
): Promise<void> {
  try {
    await assertMayActOnScope(personId, scopeId);
  } catch (err) {
    if (err instanceof CampaignScopeError) {
      redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

export default async function CampaignEditorPage({ params }: Props) {
  const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
  const { id } = await params;

  const campaign = await getCampaign(id);
  if (!campaign) redirect("/outreach/campaigns");

  // Captured here (rather than reading campaign.scopeId inside the server action
  // closures below) because TS does not carry the null-check narrowing above into
  // nested "use server" closures: campaign's declared type is still `... | null`
  // inside them, even though it can only ever be the non-null branch at runtime.
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
  } = await loadAudienceBuilderOptions(parsedAudience);

  const scopeName = boundScope?.name ?? "a deleted scope";

  const zone = await getDisplayTimeZone();

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    const name = ((formData.get("name") as string | null) ?? "").trim();
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    const sendOncePerPerson = formData.get("sendOncePerPerson") === "on";
    let audience: Audience;
    try {
      const raw = JSON.parse((formData.get("audience") as string | null) ?? "{}");
      audience = isAudience(raw) ? raw : EMPTY_AUDIENCE;
    } catch {
      audience = EMPTY_AUDIENCE;
    }

    try {
      await updateCampaign(actor.personId, id, {
        name: name || undefined,
        subject,
        body,
        audience,
        sendOncePerPerson,
      });
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        redirect(
          `/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }

    revalidatePath(`/outreach/campaigns/${id}`);
    redirect(`/outreach/campaigns/${id}?saved=1`);
  }

  // Returns the resolved roll rather than redirecting: ReviewActions renders it
  // in place. A redirect could only carry a count, and the global FlashReader
  // strips the params as soon as it toasts them, leaving nothing to render from.
  async function previewAction(): Promise<PreviewResult> {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    try {
      // A preview lists real recipient names, so it needs the same scope check
      // as an actual send -- returned as a `problems` entry rather than a
      // redirect, matching how this action already reports every other failure.
      await assertMayActOnScope(actor.personId, scopeId);
      return { ok: true, preview: await previewAudience(id) };
    } catch (err) {
      if (err instanceof CampaignScopeError) return { ok: false, problems: [err.message] };
      if (err instanceof CampaignValidationError) return { ok: false, problems: err.problems };
      throw err;
    }
  }

  async function testAction() {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    if (!actor.email) {
      redirect(
        `/outreach/campaigns/${id}?error=${encodeURIComponent("Your account has no email address on file.")}`,
      );
    }
    try {
      await testSend(actor.personId, id, actor.email);
    } catch {
      redirect(
        `/outreach/campaigns/${id}?error=${encodeURIComponent("Test send failed. Check that the campaign has a subject and body.")}`,
      );
    }
    redirect(`/outreach/campaigns/${id}?tested=1#review`);
  }

  async function sendAction(formData: FormData) {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    const rawCount = formData.get("confirmCount");
    const confirmCount =
      rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;

    let recipientCount = 0;
    try {
      const result = await sendCampaignNow(actor.personId, id, { confirmCount });
      recipientCount = result.recipientCount;
    } catch (err) {
      if (err instanceof CampaignConfirmationError) {
        redirect(
          `/outreach/campaigns/${id}?error=${encodeURIComponent(
            `This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and click Send again.`,
          )}`,
        );
      }
      if (err instanceof CampaignValidationError) {
        redirect(
          `/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }

    revalidatePath("/outreach/campaigns");
    redirect(`/outreach/campaigns/${id}?sent=${recipientCount}`);
  }

  async function scheduleLaterAction(formData: FormData) {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    const raw = (formData.get("scheduledAt") as string | null) ?? "";
    if (!raw) redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent("Pick a date and time")}`);
    const scheduledAt = parseZonedInput(raw, await getDisplayTimeZone());
    if (!scheduledAt) {
      redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent("Pick a valid date and time")}`);
    }
    const rawCount = formData.get("confirmCount");
    const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "SCHEDULED", scheduledAt }, undefined, { confirmCount });
    } catch (err) {
      if (err instanceof CampaignConfirmationError) {
        redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and schedule again.`)}`);
      }
      if (err instanceof CampaignValidationError) {
        redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/outreach/campaigns/${id}`);
    redirect(`/outreach/campaigns/${id}?scheduled=1`);
  }

  async function scheduleRecurringAction(formData: FormData) {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    const cronExpr = ((formData.get("cronExpr") as string | null) ?? "").trim();
    const rawCount = formData.get("confirmCount");
    const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "RECURRING", cronExpr }, undefined, { confirmCount });
    } catch (err) {
      if (err instanceof CampaignConfirmationError) {
        redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and start recurring again.`)}`);
      }
      if (err instanceof CampaignValidationError) {
        redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/outreach/campaigns/${id}`);
    redirect(`/outreach/campaigns/${id}?scheduled=1`);
  }

  async function cancelAction() {
    "use server";
    const actor = await requireAnyPermission(["outreach.send", "outreach.send_unrestricted"]);
    await assertScopeOrRedirect(actor.personId, scopeId, id);
    try {
      await cancelCampaign(actor.personId, id);
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        redirect(`/outreach/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/outreach/campaigns/${id}`);
    redirect(`/outreach/campaigns/${id}?cancelled=1`);
  }

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

      {/* Main save form: editable only while a draft */}
      {isDraft && (
        <form id="campaign-compose" action={saveAction} className="space-y-8">
          {/* Section 1: Compose */}
          <div className="space-y-6">
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
          <div className="border-t border-border pt-6 space-y-4">
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
              initial={parsedAudience}
            />
          </div>

          {/* Sticky save footer */}
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
        <div id="review" className="space-y-4 border-t border-border pt-6">
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
            previewAction={previewAction}
            testAction={testAction}
            sendAction={sendAction}
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
          <form action={cancelAction}>
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
        <div className="space-y-5 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">Timing</h2>
          <TimingActions
            // Remount on save so the useFormDirty guard resets -- see ReviewActions (#14).
            key={campaign.updatedAt.toISOString()}
            formId="campaign-compose"
            scheduleLaterAction={scheduleLaterAction}
            scheduleRecurringAction={scheduleRecurringAction}
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
