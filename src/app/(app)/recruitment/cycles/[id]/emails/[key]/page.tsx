import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getCycleEmailForEdit,
  saveCycleEmail,
  resetCycleEmail,
  CycleEmailValidationError,
} from "@/modules/recruitment/services/cycle-emails";
import { CYCLE_EMAIL_KEYS, type CycleEmailKey } from "@/modules/recruitment/email/render";
import { PageHeader } from "@/platform/ui/page-header";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
// TemplateEditor lives in the admin route group. TypeScript resolves the path
// correctly because [key] is a literal directory name on disk.
import { TemplateEditor } from "@/app/(app)/admin/email/templates/[key]/preview";

type Props = {
  params: Promise<{ id: string; key: string }>;
  searchParams: Promise<{ error?: string }>;
};

function isCycleKey(k: string): k is CycleEmailKey {
  return (CYCLE_EMAIL_KEYS as readonly string[]).includes(k);
}

export default async function EditCycleEmailPage({ params, searchParams }: Props) {
  await requirePermission("recruitment.manage_cycles");
  const { id, key } = await params;
  const { error } = await searchParams;
  const decodedKey = decodeURIComponent(key);
  if (!isCycleKey(decodedKey)) notFound();
  const t = await getCycleEmailForEdit(id, decodedKey);
  const base = `/recruitment/cycles/${id}/emails/${key}`;

  async function saveAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    const subject = (formData.get("subject") as string | null) ?? "";
    const body = (formData.get("body") as string | null) ?? "";
    try {
      await saveCycleEmail(id, decodedKey as CycleEmailKey, { subject, body }, actor.personId);
    } catch (err) {
      if (err instanceof CycleEmailValidationError) {
        redirect(`${base}?error=${encodeURIComponent(err.problems.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(base);
    redirect(base);
  }

  async function resetAction() {
    "use server";
    const actor = await requirePermission("recruitment.manage_cycles");
    await resetCycleEmail(id, decodedKey as CycleEmailKey, actor.personId);
    revalidatePath(base);
    redirect(base);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.name}
        description={t.hasOverride ? "Customized for this cycle" : "Using the default"}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      <form action={saveAction}>
        <TemplateEditor
          templateKey={t.key}
          variables={t.variables}
          initialSubject={t.subject}
          initialBody={t.body}
          isLayout={false}
          layoutSource={t.layoutSource}
        />
        <div className="mt-4 flex gap-2">
          <Button type="submit">Save</Button>
        </div>
      </form>
      {t.hasOverride ? (
        <form action={resetAction}>
          <Button type="submit" variant="outline">Reset to default</Button>
        </form>
      ) : null}
    </div>
  );
}
