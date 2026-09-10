import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  TemplateValidationError,
  type TemplateForEdit,
} from "@/modules/admin/services/email-templates";
import {
  saveSenderRule,
  clearSenderRule,
  orgDisplayName,
  SenderRuleValidationError,
} from "@/platform/email/sender-rules";
import { sendSenderTest } from "@/modules/admin/services/email";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { SubmitButton } from "@/platform/ui/submit-button";
import { cardClasses } from "@/platform/ui/card";
import { Input } from "@/platform/ui/input";
import { TemplateEditorForm } from "@/modules/admin/components/template-editor-form";
import { FormRow, ROW_WIDTH } from "@/platform/ui/form";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";

type Props = {
  params: Promise<{ key: string }>;
};

export default async function EditTemplatePage({ params }: Props) {
  await requirePermission("admin.manage_email_templates");
  const { key } = await params;
  const decodedKey = decodeURIComponent(key);
  // A mistyped, stale, or renamed template key throws "Unknown email template:
  // ...". Render the standard not-found page for that case instead of letting the
  // raw error bubble to Next's default error screen.
  let t: TemplateForEdit;
  try {
    t = await getTemplateForEdit(decodedKey);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unknown email template")) {
      notFound();
    }
    throw err;
  }

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("admin.manage_email_templates");
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    try {
      await saveTemplateOverride(actor.personId, decodedKey, { subject, body });
    } catch (err) {
      if (err instanceof TemplateValidationError) {
        redirect(
          `/admin/email/templates/${key}?error=${encodeURIComponent(err.problems.join("; "))}`
        );
      }
      throw err;
    }
    revalidatePath(`/admin/email/templates/${key}`);
    // The editor redraws with exactly the text just submitted, so a bare
    // redirect could not be told apart from a save that never landed.
    redirect(`/admin/email/templates/${key}?saved=1`);
  }

  async function resetAction() {
    "use server";
    const actor = await requirePermission("admin.manage_email_templates");
    await resetTemplateOverride(actor.personId, decodedKey);
    revalidatePath(`/admin/email/templates/${key}`);
    // Its own value: reverting to the built-in text is a different outcome from
    // saving an override, and the header's Customized/Using default line is the
    // only other place it shows.
    redirect(`/admin/email/templates/${key}?saved=reset`);
  }

  async function saveSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_email_templates");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    try {
      if (fromEmail === "") {
        await clearSenderRule(a.personId, "TEMPLATE", decodedKey);
      } else {
        await saveSenderRule(a.personId, "TEMPLATE", decodedKey, { fromEmail, fromName });
      }
    } catch (err) {
      if (err instanceof SenderRuleValidationError) {
        redirect(`/admin/email/templates/${key}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    revalidatePath(`/admin/email/templates/${key}`);
    // Same param the identical control on /admin/email uses; its registry entry
    // is scoped to this route too.
    redirect(`/admin/email/templates/${key}?senderSaved=1`);
  }

  async function testSenderAction(formData: FormData) {
    "use server";
    const a = await requirePermission("admin.manage_email_templates");
    const fromEmail = ((formData.get("fromEmail") as string | null) ?? "").trim();
    const fromName = ((formData.get("fromName") as string | null) ?? "").trim();
    const person = await prisma.person.findUnique({
      where: { id: a.personId },
      select: { contactEmail: true },
    });
    const toEmail = person?.contactEmail ?? "";
    if (fromEmail === "" || toEmail === "") {
      redirect(
        `/admin/email/templates/${key}?error=${encodeURIComponent("A from address and your account email are required to send a test.")}`
      );
    }
    try {
      // A BLANK display name is not "no name" any more: a rule that carries none
      // falls through to the org floor, so a test sent with no name would stop
      // showing what recipients see, which is the one thing this button is for.
      await sendSenderTest(a.personId, {
        toEmail,
        fromEmail,
        fromName: fromName || (await orgDisplayName()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test send failed.";
      redirect(`/admin/email/templates/${key}?error=${encodeURIComponent(message)}`);
    }
    revalidatePath(`/admin/email/templates/${key}`);
    // This button SENDS a real message and said nothing about it, while the same
    // button one route up on /admin/email has always confirmed.
    redirect(`/admin/email/templates/${key}?senderTested=1`);
  }

  return (
    <div className="space-y-6">
      <SetBreadcrumbLeaf label={t.name} />
      <PageHeader
        title={t.name}
        description={t.hasOverride ? "Customized" : "Using default"}
      />

      <TemplateEditorForm
        saveAction={saveAction}
        resetAction={resetAction}
        hasOverride={t.hasOverride}
        templateKey={t.key}
        variables={t.variables}
        initialSubject={t.subject}
        initialBody={t.body}
        isLayout={t.isLayout}
        layoutSource={t.layoutSource}
        brandColor={t.brandColor}
      />

      <form action={saveSenderAction} className={`${cardClasses()} space-y-3`}>
        <div>
          <p className="text-sm font-medium text-foreground-soft">Send from</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Leave blank to inherit ({t.inheritedSender.fromEmail}). The connected mailbox
            must have Send-As rights on any address you enter.
          </p>
        </div>
        <FormRow>
          <div className={ROW_WIDTH.wide}>
            <Input
              name="fromEmail"
              type="email"
              defaultValue={t.senderFromEmail ?? ""}
              placeholder={t.inheritedSender.fromEmail}
              aria-label="From address"
            />
          </div>
          <div className={ROW_WIDTH.control}>
            <Input
              name="fromName"
              defaultValue={t.senderFromName ?? ""}
              placeholder="Display name (optional)"
              aria-label="From display name"
            />
          </div>
          {/* Same two-actions-one-form shape as the send-from rows on
              /admin/email, and the same reading: `pending` is form-wide, so a
              plain pendingLabel would show "Saving…" here while a test send is
              what is running. Each button keeps its own label; the spinner says
              something is in flight. See that page for why this is a choice
              rather than a limit of useFormStatus. */}
          <SubmitButton variant="outline" pendingLabel="Save sender">Save sender</SubmitButton>
          <SubmitButton formAction={testSenderAction} variant="ghost" pendingLabel="Send test">Send test</SubmitButton>
        </FormRow>
      </form>
    </div>
  );
}
