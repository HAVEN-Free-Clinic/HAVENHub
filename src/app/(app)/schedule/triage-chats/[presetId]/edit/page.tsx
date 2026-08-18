import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { PresetForm } from "../../preset-form";

export function generateMetadata() {
  return buildPageMetadata({
    title: "Edit triage chat preset",
    description: "Change a weekly Teams triage chat's departments, name, or opening message.",
  });
}

export default async function EditTriageChatPresetPage({
  params,
}: {
  params: Promise<{ presetId: string }>;
}) {
  await requirePermission("schedule.manage_triage_chats");
  const { presetId } = await params;

  const [preset, departments] = await Promise.all([
    prisma.triageChatPreset.findUnique({
      where: { id: presetId },
      include: { departments: true },
    }),
    prisma.department.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!preset) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={`Edit ${preset.name}`} />
      <PresetForm
        presetId={preset.id}
        initial={{
          name: preset.name,
          nameTemplate: preset.nameTemplate,
          messageTemplate: preset.messageTemplate,
          departmentIds: preset.departments.map((d) => d.departmentId),
        }}
        departments={departments}
      />
    </div>
  );
}
