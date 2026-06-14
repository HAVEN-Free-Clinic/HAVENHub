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
import { PERSON_FIELD_VIEWS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { Alert } from "@/platform/ui/alert";
import { TemplateEditor } from "../../templates/[key]/preview";
import { AudienceBuilder } from "./audience-builder";
import { CronPresets } from "./cron-presets";
import { SubmitButton } from "./submit-button";

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

  const [layoutSource, departments] = await Promise.all([
    loadLayoutSource(),
    prisma.department.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  const parsedAudience: Audience = isAudience(campaign.audienceJson)
    ? campaign.audienceJson
    : EMPTY_AUDIENCE;

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
    const scheduledAt = new Date(raw);
    if (Number.isNaN(scheduledAt.getTime())) {
      redirect(`/admin/email/campaigns/${id}?error=${encodeURIComponent("Pick a valid date and time")}`);
    }
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "SCHEDULED", scheduledAt });
    } catch (err) {
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
    try {
      await scheduleCampaign(actor.personId, id, { scheduleType: "RECURRING", cronExpr });
    } catch (err) {
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
    await cancelCampaign(actor.personId, id);
    revalidatePath(`/admin/email/campaigns/${id}`);
    redirect(`/admin/email/campaigns/${id}?cancelled=1`);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={
          isSent
            ? "This campaign has already been sent."
            : isScheduled
              ? "Scheduled — waiting to send."
              : isActive
                ? "Recurring — sends on a schedule."
                : campaign.status === "CANCELLED"
                  ? "Cancelled."
                  : "Draft"
        }
      />

      {/* Flash banners — saved / sent / scheduled / cancelled only */}
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

      {/* Main save form — editable only while a draft */}
      {isDraft && (
        <form action={saveAction} className="space-y-8">
          {/* Section 1: Compose */}
          <div className="space-y-6">
            <h2 className="text-base font-semibold text-foreground">1. Compose</h2>

            {/* Campaign name */}
            <div>
              <label className="block text-sm font-medium text-foreground-soft" htmlFor="campaign-name">
                Campaign name
              </label>
              <Input
                id="campaign-name"
                name="name"
                type="text"
                defaultValue={campaign.name}
                required
                className="mt-1 max-w-sm"
              />
            </div>

            {/* Template editor (subject + body) */}
            <TemplateEditor
              variables={PERSON_VARIABLES}
              initialSubject={campaign.subject}
              initialBody={campaign.body}
              isLayout={false}
              layoutSource={layoutSource}
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
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-2">
            <p className="text-sm font-medium text-foreground-soft">Subject</p>
            <p className="text-sm text-foreground-soft">{campaign.subject || <em className="text-subtle-foreground">No subject</em>}</p>
          </div>
        </div>
      )}

      {/* Section 3: Review & send — drafts only */}
      {isDraft && (
        <div id="review" className="space-y-4 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">3. Review &amp; send</h2>

          <div className="flex flex-wrap gap-3">
            {/* Preview audience */}
            <form action={previewAction}>
              <SubmitButton variant="outline" pendingLabel="Previewing...">
                Preview audience
              </SubmitButton>
            </form>

            {/* Test send */}
            <form action={testAction}>
              <SubmitButton variant="outline" pendingLabel="Sending test...">
                Send test to me
              </SubmitButton>
            </form>

            {/* Live send */}
            <form action={sendAction} className="flex items-center gap-2">
              <div>
                <label className="block text-xs text-muted-foreground" htmlFor="confirmCount">
                  Confirm count (required for &gt;25 recipients)
                </label>
                <Input
                  id="confirmCount"
                  name="confirmCount"
                  type="number"
                  min={1}
                  placeholder="e.g. 42"
                  className="mt-0.5 w-24"
                />
              </div>
              <SubmitButton variant="danger" pendingLabel="Sending...">
                Send now
              </SubmitButton>
            </form>
          </div>

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
              {campaign.scheduledAt.toLocaleString()}
            </p>
          )}
          {isActive && (
            <p className="text-sm text-brand-fg">
              <strong>Recurring:</strong> {campaign.cronExpr}
              {campaign.nextRunAt && (
                <> &mdash; next run {campaign.nextRunAt.toLocaleString()}</>
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

      {/* Timing section — DRAFT only */}
      {isDraft && (
        <div className="space-y-5 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">Timing</h2>

          {/* Schedule for later */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground-soft">Schedule for later</p>
            <form action={scheduleLaterAction} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-muted-foreground" htmlFor="scheduledAt">
                  Send at
                </label>
                <Input
                  id="scheduledAt"
                  name="scheduledAt"
                  type="datetime-local"
                  required
                  className="mt-0.5 w-auto"
                />
              </div>
              <Button type="submit">Schedule</Button>
            </form>
          </div>

          {/* Recurring */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground-soft">Recurring</p>
            <form action={scheduleRecurringAction} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-muted-foreground" htmlFor="cronExpr">
                  Cron expression
                </label>
                <CronPresets />
              </div>
              <Button type="submit">Start recurring</Button>
            </form>
            <p className="text-xs text-muted-foreground">
              Cron format: minute hour day month weekday, in UTC. Example:{" "}
              <code className="font-mono">0 13 * * 1</code> = Mondays at 13:00 UTC.
            </p>
          </div>
        </div>
      )}

      {/* Sent runs list */}
      {campaign.runs.length > 0 && (
        <div className="space-y-3 border-t border-border pt-6">
          <h2 className="text-base font-semibold text-foreground">Sent runs</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-muted-foreground border-b border-border">
                <th className="pb-2 pr-6">Sent at</th>
                <th className="pb-2">Recipients</th>
              </tr>
            </thead>
            <tbody>
              {campaign.runs.map((run) => (
                <tr key={run.id} className="border-b border-border-subtle last:border-0">
                  <td className="py-2 pr-6 text-foreground-soft">{run.runAt.toLocaleString()}</td>
                  <td className="py-2 text-foreground-soft">{run.recipientCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
