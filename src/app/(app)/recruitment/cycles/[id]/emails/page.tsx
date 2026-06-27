import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { listCycleEmails } from "@/modules/recruitment/services/cycle-emails";
import { PageHeader } from "@/platform/ui/page-header";
import { buttonClasses } from "@/platform/ui/button";

export default async function CycleEmailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!cycle) notFound();
  const emails = await listCycleEmails(cycle.id);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Cycle emails"
        description={`Customize the emails sent for ${cycle.title}. Unset emails use the global default.`}
      />
      <ul className="space-y-2">
        {emails.map((e) => (
          <li key={e.key} className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-foreground">{e.name}</span>
              <span className="block text-xs text-muted-foreground">
                {e.hasOverride ? "Customized for this cycle" : "Using the default"}
              </span>
            </span>
            <Link
              href={`/recruitment/cycles/${cycle.id}/emails/${encodeURIComponent(e.key)}`}
              className={buttonClasses("outline", "sm")}
            >
              Edit
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
