import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listTemplateSummaries } from "@/modules/admin/services/email-templates";
import { PageHeader } from "@/platform/ui/page-header";

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
        <p className="text-sm text-slate-400">No templates registered.</p>
      ) : (
        <ul className="divide-y rounded-lg border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between px-5 py-3">
              <span>
                <Link
                  className="text-sm font-medium underline underline-offset-2"
                  href={`/admin/email/templates/${encodeURIComponent(r.key)}`}
                >
                  {r.name}
                </Link>
                <span className="ml-2 text-xs text-slate-400">{r.category}</span>
              </span>
              <span className="text-xs text-slate-500">
                {r.hasOverride ? "Customized" : "Default"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
