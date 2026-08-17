import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/modules/schedule/services/triage-chat-presets";
import { buildPageMetadata } from "@/platform/branding/metadata";
import { PageHeader } from "@/platform/ui/page-header";
import { PresetForm } from "../preset-form";

export function generateMetadata() {
  return buildPageMetadata({
    title: "New triage chat preset",
    description: "Configure a weekly Teams triage chat: its departments, name, and opening message.",
  });
}

export default async function NewTriageChatPresetPage() {
  await requirePermission("schedule.manage_triage_chats");
  const departments = await prisma.department.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="New triage chat preset"
        description="One preset per weekly chat, for example Ancillary and Clinical."
      />
      <PresetForm
        presetId={null}
        initial={{
          name: "",
          nameTemplate: "{{clinicDateShort}} Triage Chat",
          messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
          departmentIds: [],
        }}
        departments={departments}
      />
    </div>
  );
}
