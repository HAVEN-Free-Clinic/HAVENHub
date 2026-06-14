import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getTemplateForEdit,
  saveTemplateOverride,
  resetTemplateOverride,
  TemplateValidationError,
} from "@/modules/admin/services/email-templates";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
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
    </div>
  );
}
