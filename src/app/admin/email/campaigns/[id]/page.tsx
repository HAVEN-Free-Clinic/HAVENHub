import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  getCampaign,
  updateCampaign,
  previewAudience,
  testSend,
  sendCampaignNow,
  CampaignValidationError,
  CampaignConfirmationError,
} from "@/platform/email/campaigns/service";
import { loadLayoutSource } from "@/platform/email/templates/renderEmail";
import { PERSON_FIELDS } from "@/platform/email/audience/person-fields";
import { PERSON_VARIABLES } from "@/platform/email/audience/variables";
import { isAudience } from "@/platform/email/audience/types";
import type { Audience } from "@/platform/email/audience/types";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Input } from "@/platform/ui/input";
import { TemplateEditor } from "../../templates/[key]/preview";
import { AudienceBuilder } from "./audience-builder";

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
      `/admin/email/campaigns/${id}?preview=1&count=${count}&excluded=${excluded}`,
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
    redirect(`/admin/email/campaigns/${id}?tested=1`);
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={isSent ? "This campaign has already been sent." : "Draft"}
      />

      {/* Flash banners */}
      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-critical/20 bg-red-50 px-3 py-2 text-sm text-critical"
        >
          {errorMessage}
        </p>
      )}
      {sp.saved === "1" && !errorMessage && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-success">
          Campaign saved.
        </p>
      )}
      {sp.tested === "1" && !errorMessage && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-success">
          Test email sent to your address.
        </p>
      )}
      {sp.sent && !errorMessage && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-success">
          Campaign sent to {sp.sent} {sp.sent === "1" ? "recipient" : "recipients"}.
        </p>
      )}
      {sp.preview === "1" && !errorMessage && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <strong>Audience preview:</strong> {sp.count ?? "0"} recipient
          {sp.count !== "1" ? "s" : ""}
          {Number(sp.excluded ?? "0") > 0
            ? `, ${sp.excluded} excluded (no email address on file)`
            : ""}
          .
        </div>
      )}

      {/* Main save form */}
      {!isSent && (
        <form action={saveAction} className="space-y-8">
          {/* Campaign name */}
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="campaign-name">
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

          {/* Audience builder */}
          <AudienceBuilder
            fields={PERSON_FIELDS}
            departments={departments}
            initial={parsedAudience}
          />

          <Button type="submit">Save</Button>
        </form>
      )}

      {/* Sent-campaign read-only summary */}
      {isSent && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-2">
            <p className="text-sm font-medium text-slate-700">Subject</p>
            <p className="text-sm text-slate-600">{campaign.subject || <em className="text-slate-400">No subject</em>}</p>
          </div>
        </div>
      )}

      {/* Action forms: preview / test send / send */}
      {!isSent && (
        <div className="flex flex-wrap gap-3 border-t border-slate-200 pt-6">
          {/* Preview audience */}
          <form action={previewAction}>
            <Button type="submit" variant="outline">
              Preview audience
            </Button>
          </form>

          {/* Test send */}
          <form action={testAction}>
            <Button type="submit" variant="outline">
              Send test to me
            </Button>
          </form>

          {/* Live send */}
          <form action={sendAction} className="flex items-center gap-2">
            <div>
              <label className="block text-xs text-slate-500" htmlFor="confirmCount">
                Confirm count (required for &gt;25 recipients)
              </label>
              <input
                id="confirmCount"
                name="confirmCount"
                type="number"
                min={1}
                placeholder="e.g. 42"
                className="mt-0.5 w-24 rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
            <Button type="submit" variant="danger" className="self-end">
              Send now
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
