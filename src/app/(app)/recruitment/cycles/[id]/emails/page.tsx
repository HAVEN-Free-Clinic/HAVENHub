import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { listCycleEmails } from "@/modules/recruitment/services/cycle-emails";
import { PageHeader } from "@/platform/ui/page-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { TextLink } from "@/platform/ui/text-link";

export default async function CycleEmailsPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("recruitment.access");
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;
  const cycle = await prisma.recruitmentCycle.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!cycle) notFound();
  const emails = await listCycleEmails(cycle.id);
  return (
    <PageBody>
      <PageHeader
        title="Cycle emails"
        description={`Customize the emails sent for ${cycle.title}. Unset emails use the global default.`}
      />
      <Table>
        <THead>
          <TR>
            <TH>Email</TH>
            <TH>Status</TH>
          </TR>
        </THead>
        <tbody>
          {emails.map((e) => (
            <TR key={e.key}>
              <TD>
                <TextLink
                  href={`/recruitment/cycles/${cycle.id}/emails/${encodeURIComponent(e.key)}`}
                  className="font-medium"
                >
                  {e.name}
                </TextLink>
              </TD>
              <TD>
                <Badge tone={e.hasOverride ? "brand" : "default"}>
                  {e.hasOverride ? "Customized for this cycle" : "Using the default"}
                </Badge>
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </PageBody>
  );
}
