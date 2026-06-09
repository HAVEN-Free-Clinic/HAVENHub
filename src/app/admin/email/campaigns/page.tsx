import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { listCampaigns } from "@/platform/email/campaigns/service";
import { PageHeader } from "@/platform/ui/page-header";

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export default async function EmailCampaignsPage() {
  await requirePermission("admin.send_email_campaign");
  const campaigns = await listCampaigns();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email campaigns"
        description="Compose and send ad-hoc bulk emails to a filtered audience."
        action={
          <Link
            href="/admin/email/campaigns/new"
            className="inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            New campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Campaigns let you send a one-off or recurring email to a filtered group of people.
          </p>
          <Link
            href="/admin/email/campaigns/new"
            className="inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            New campaign
          </Link>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border border-slate-200 bg-white">
          {campaigns.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-5 py-3">
              <span>
                <Link
                  className="text-sm font-medium underline underline-offset-2"
                  href={`/admin/email/campaigns/${c.id}`}
                >
                  {c.name}
                </Link>
                <span className="ml-2 text-xs text-slate-400">{fmtDate(c.createdAt)}</span>
              </span>
              <span className="text-xs text-slate-500">{c.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
