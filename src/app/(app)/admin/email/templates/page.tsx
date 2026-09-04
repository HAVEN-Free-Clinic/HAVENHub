import Link from "next/link";
import { MailX } from "lucide-react";
import { requirePermission } from "@/platform/auth/session";
import { listTemplateSummaries } from "@/modules/admin/services/email-templates";
import { PageHeader } from "@/platform/ui/page-header";
import { cardClasses } from "@/platform/ui/card";
import { EmptyState } from "@/platform/ui/empty-state";

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
        <ul className={`${cardClasses({ pad: false })} divide-y`}>
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between px-5 py-3">
              <span>
                <Link
                  className="text-sm font-medium underline underline-offset-2"
                  href={`/admin/email/templates/${encodeURIComponent(r.key)}`}
                >
                  {r.name}
                </Link>
                <span className="ml-2 text-xs text-subtle-foreground">{r.category}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {r.hasOverride ? "Customized" : "Default"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
