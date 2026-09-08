import { MailX } from "lucide-react";
import { requirePermission } from "@/platform/auth/session";
import { listTemplateSummaries } from "@/modules/admin/services/email-templates";
import { PageHeader } from "@/platform/ui/page-header";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";

export default async function EmailTemplatesPage() {
  await requirePermission("admin.manage_email_templates");
  const rows = await listTemplateSummaries();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email templates"
        description="Edit the content of any platform email. Changes apply immediately."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={MailX}
          title="No templates registered"
          description="Platform emails register their templates on boot. If this stays empty, no email-sending code has loaded yet."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Template</TH>
              <TH>Category</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.key}>
                <TD>
                  <TextLink
                    className="font-medium"
                    href={`/admin/email/templates/${encodeURIComponent(r.key)}`}
                  >
                    {r.name}
                  </TextLink>
                </TD>
                <TD className="text-muted-foreground">{r.category}</TD>
                <TD>
                  {/* A Badge, not a run-on sentence: this is the row's state,
                      and it is what an admin scans the list for. */}
                  <Badge tone={r.hasOverride ? "brand" : "default"}>
                    {r.hasOverride ? "Customized" : "Default"}
                  </Badge>
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
