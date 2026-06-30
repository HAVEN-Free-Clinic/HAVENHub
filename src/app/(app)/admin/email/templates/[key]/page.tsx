import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  TemplateValidationError,
} from "@/modules/admin/services/email-templates";
import { saveSenderRule, clearSenderRule, SenderRuleValidationError } from "@/platform/email/sender-rules";
import { sendSenderTest } from "@/modules/admin/services/email";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { Input } from "@/platform/ui/input";
import { TemplateEditor } from "./preview";

type Props = {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function EditTemplatePage({ params, searchParams }: Props) {
  await requirePermission("admin.manage_email_templates");
  const { key } = await params;
  const { error } = await searchParams;
  const decodedKey = decodeURIComponent(key);
  const t = await getTemplateForEdit(decodedKey);

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
    redirect(`/admin/email/templates/${key}`);
  }

  async function resetAction() {
    "use server";
    const actor = await requirePermission("admin.manage_email_templates");
    await resetTemplateOverride(actor.personId, decodedKey);
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
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
    redirect(`/admin/email/templates/${key}`);
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
      await sendSenderTest(a.personId, { toEmail, fromEmail, fromName: fromName || null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test send failed.";
      redirect(`/admin/email/templates/${key}?error=${encodeURIComponent(message)}`);
    }
    revalidatePath(`/admin/email/templates/${key}`);
    redirect(`/admin/email/templates/${key}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.name}
        description={t.hasOverride ? "Customized" : "Using default"}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form action={saveAction}>
        <TemplateEditor
          templateKey={t.key}
          variables={t.variables}
          initialSubject={t.subject}
          initialBody={t.body}
          isLayout={t.isLayout}
          layoutSource={t.layoutSource}
        />
        <div className="mt-4 flex gap-2">
          <Button type="submit">Save</Button>
        </div>
      </form>

      {t.hasOverride ? (
        <form action={resetAction}>
          <Button type="submit" variant="outline">
            Reset to default
          </Button>
        </form>
      ) : null}

      <form action={saveSenderAction} className="space-y-3 rounded-2xl border border-border bg-surface p-5">
        <div>
          <p className="text-sm font-medium text-foreground-soft">Send from</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Leave blank to inherit ({t.inheritedSender.fromEmail}). The connected mailbox
            must have Send-As rights on any address you enter.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Input
              name="fromEmail"
              type="email"
              defaultValue={t.senderFromEmail ?? ""}
              placeholder={t.inheritedSender.fromEmail}
              aria-label="From address"
            />
          </div>
          <div className="w-48">
            <Input
              name="fromName"
              defaultValue={t.senderFromName ?? ""}
              placeholder="Display name (optional)"
              aria-label="From display name"
            />
          </div>
          <Button type="submit" variant="outline">Save sender</Button>
          <Button type="submit" formAction={testSenderAction} variant="ghost">Send test</Button>
        </div>
      </form>
    </div>
  );
}
