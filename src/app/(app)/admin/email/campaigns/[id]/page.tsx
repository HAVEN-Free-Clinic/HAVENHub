import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  getCampaign,
  updateCampaign,
  previewAudience,
  testSend,
  sendCampaignNow,
  scheduleCampaign,
  cancelCampaign,
  CampaignValidationError,
  CampaignConfirmationError,
} from "@/platform/email/campaigns/service";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { getSetting } from "@/platform/settings/service";
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { prisma } from "@/platform/db";
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
import { TemplateEditor } from "../../templates/[key]/preview";
import { AudienceBuilder } from "./audience-builder";
import { SubmitButton } from "./submit-button";
import { ReviewActions } from "./review-actions";
import { TimingActions } from "./timing-actions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    saved?: string;
    tested?: string;
    sent?: string;
    preview?: string;
    count?: string;
    excluded?: string;
    scheduled?: string;
    cancelled?: string;
  }>;
};

const EMPTY_AUDIENCE: Audience = {
  recordType: "PERSON",
  match: "ALL",
  conditions: [],
};

export default async function CampaignEditorPage({ params, searchParams }: Props) {
  await requirePermission("admin.send_email_campaign");
  const { id } = await params;
  const sp = await searchParams;

  const campaign = await getCampaign(id);
  if (!campaign) redirect("/admin/email/campaigns");

  const isSent = campaign.status === "SENT";
  const isDraft = campaign.status === "DRAFT";
  const isScheduled = campaign.status === "SCHEDULED";
  const isActive = campaign.status === "ACTIVE";

  const [layoutSource, brandColor, departments] = await Promise.all([
    loadLayoutSource(),
    getSetting<string>("branding.brandColor"),
    prisma.department.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const parsedAudience: Audience = isAudience(campaign.audienceJson)
    ? campaign.audienceJson
    : EMPTY_AUDIENCE;

  const zone = await getDisplayTimeZone();

  // ---------------------------------------------------------------------------
  // Server actions
  // ---------------------------------------------------------------------------

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    const name = ((formData.get("name") as string | null) ?? "").trim();
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    let audience: Audience;
    try {
      const raw = JSON.parse((formData.get("audience") as string | null) ?? "{}");
      audience = isAudience(raw) ? raw : EMPTY_AUDIENCE;
    } catch {
      audience = EMPTY_AUDIENCE;
    }

    try {
      await updateCampaign(actor.personId, id, { name: name || undefined, subject, body, audience });
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        redirect(
          `/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }

    revalidatePath(`/admin/email/campaigns/${id}`);
    redirect(`/admin/email/campaigns/${id}?saved=1`);
  }

  async function previewAction() {
    "use server";
    await requirePermission("admin.send_email_campaign");

    let count = 0;
    let excluded = 0;
    try {
      const result = await previewAudience(id);
      count = result.count;
      excluded = result.excludedNoEmail;
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        redirect(
          `/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }

    redirect(
      `/admin/email/campaigns/${id}?preview=1&count=${count}&excluded=${excluded}#review`,
    );
  }

  async function testAction() {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    if (!actor.email) {
      redirect(
        `/admin/email/campaigns/${id}?error=${encodeURIComponent("Your account has no email address on file.")}`,
      );
    }
    try {
      await testSend(actor.personId, id, actor.email);
    } catch {
      redirect(
        `/admin/email/campaigns/${id}?error=${encodeURIComponent("Test send failed. Check that the campaign has a subject and body.")}`,
      );
    }
    redirect(`/admin/email/campaigns/${id}?tested=1#review`);
  }

  async function sendAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
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
          `/admin/email/campaigns/${id}?error=${encodeURIComponent(
            `This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and click Send again.`,
          )}`,
        );
      }
      if (err instanceof CampaignValidationError) {
        redirect(
          `/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`,
        );
      }
      throw err;
    }

    revalidatePath("/admin/email/campaigns");
    redirect(`/admin/email/campaigns/${id}?sent=${recipientCount}`);
  }

  async function scheduleLaterAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    const raw = (formData.get("scheduledAt") as string | null) ?? "";
    if (!raw) redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent("Pick a date and time")}`);
    const scheduledAt = parseZonedInput(raw, await getDisplayTimeZone());
    if (!scheduledAt) {
      redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent("Pick a valid date and time")}`);
    }
    const rawCount = formData.get("confirmCount");
    const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "SCHEDULED", scheduledAt }, undefined, { confirmCount });
    } catch (err) {
      if (err instanceof CampaignConfirmationError) {
        redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and schedule again.`)}`);
      }
      if (err instanceof CampaignValidationError) {
        redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/admin/email/campaigns/${id}`);
    redirect(`/admin/email/campaigns/${id}?scheduled=1`);
  }

  async function scheduleRecurringAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    const cronExpr = ((formData.get("cronExpr") as string | null) ?? "").trim();
    const rawCount = formData.get("confirmCount");
    const confirmCount = rawCount !== null && rawCount !== "" ? Number(rawCount) : undefined;
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "RECURRING", cronExpr }, undefined, { confirmCount });
    } catch (err) {
      if (err instanceof CampaignConfirmationError) {
        redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent(`This campaign targets ${err.expected} recipients. Type ${err.expected} in the confirmation field and start recurring again.`)}`);
      }
      if (err instanceof CampaignValidationError) {
        redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/admin/email/campaigns/${id}`);
    redirect(`/admin/email/campaigns/${id}?scheduled=1`);
  }

  async function cancelAction() {
    "use server";
    const actor = await requirePermission("admin.send_email_campaign");
    try {
      await cancelCampaign(actor.personId, id);
    } catch (err) {
      if (err instanceof CampaignValidationError) {
        redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/admin/email/campaigns/${id}`);
    redirect(`/admin/email/campaigns/${id}?cancelled=1`);
  }

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

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

      {/* Flash banners: saved / sent / scheduled / cancelled only */}
      {errorMessage && <Alert tone="error">{errorMessage}</Alert>}
      {sp.saved === "1" && !errorMessage && (
        <Alert tone="success">Campaign saved.</Alert>
      )}
      {sp.sent && !errorMessage && (
        <Alert tone="success">
          Campaign sent to {sp.sent} {sp.sent === "1" ? "recipient" : "recipients"}.
        </Alert>
      )}
      {sp.scheduled === "1" && !errorMessage && (
        <Alert tone="success">Campaign scheduled.</Alert>
      )}
      {sp.cancelled === "1" && !errorMessage && (
        <Alert tone="info">Schedule cancelled.</Alert>
      )}

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
            <AudienceBuilder
              fields={PERSON_FIELD_VIEWS}
              departments={departments}
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

          {/* Inline audience preview result */}
          {sp.preview === "1" && !errorMessage && (
            <Alert tone="info">
              <strong>Audience preview:</strong> {sp.count ?? "0"} recipient
              {sp.count !== "1" ? "s" : ""}
              {Number(sp.excluded ?? "0") > 0
                ? `, ${sp.excluded} excluded (no email address on file)`
                : ""}
              .
            </Alert>
          )}

          {/* Inline test-send confirmation */}
          {sp.tested === "1" && !errorMessage && (
            <Alert tone="success">Test email sent to your address.</Alert>
          )}
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
