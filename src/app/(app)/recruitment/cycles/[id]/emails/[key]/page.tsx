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
import { getSetting } from "@/platform/settings/service";
import { PageHeader } from "@/platform/ui/page-header";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { getCycle } from "@/modules/recruitment/services/cycles";
// TemplateEditor lives in the admin route group. TypeScript resolves the path
// correctly because [key] is a literal directory name on disk.
import { TemplateEditorForm } from "@/modules/admin/components/template-editor-form";

type Props = {
  params: Promise<{ id: string; key: string }>;
};

function isCycleKey(k: string): k is CycleEmailKey {
  return (CYCLE_EMAIL_KEYS as readonly string[]).includes(k);
}

export default async function EditCycleEmailPage({ params }: Props) {
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.manage_cycles");
  const { id, key } = await params;
  const decodedKey = decodeURIComponent(key);
  if (!isCycleKey(decodedKey)) notFound();
  const cycle = await getCycle(id);
  if (!cycle) notFound();
  const t = await getCycleEmailForEdit(id, decodedKey);
  const brandColor = await getSetting<string>("branding.brandColor");
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
      <SetBreadcrumb
        trail={cycleTrail({
          cycleId: id,
          cycleTitle: cycle.title,
          section: { label: "Emails", slug: "emails" },
          leaf: t.name,
        })}
      />
      <PageHeader
        title={t.name}
        description={t.hasOverride ? "Customized for this cycle" : "Using the default"}
      />
      <TemplateEditorForm
        saveAction={saveAction}
        resetAction={resetAction}
        hasOverride={t.hasOverride}
        templateKey={t.key}
        variables={t.variables}
        initialSubject={t.subject}
        initialBody={t.body}
        isLayout={false}
        layoutSource={t.layoutSource}
        brandColor={brandColor}
      />
    </div>
  );
}
