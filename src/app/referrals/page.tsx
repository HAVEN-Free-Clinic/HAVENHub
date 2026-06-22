import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { listReferralSites } from "@/modules/referrals/services/referrals";

export default async function ReferralsPage() {
  const sites = await listReferralSites();

  const stats = {
    total: sites.length,
    uninsured: sites.filter((s) => s.acceptsUninsured).length,
    freeCare: sites.filter((s) => s.freeCareEligible).length,
    fast: sites.filter((s) => s.waitWeeks != null && s.waitWeeks < 4).length,
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Referral Directory"
        description="Specialists, community health partners, and social services HAVEN refers patients to."
        action={
          <Link
            href="/referrals/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-hover"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add provider
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{stats.total}</p>
          <p className="mt-1 text-xs text-muted-foreground">Total providers</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{stats.uninsured}</p>
          <p className="mt-1 text-xs text-muted-foreground">Accept uninsured</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{stats.freeCare}</p>
          <p className="mt-1 text-xs text-muted-foreground">Free Care eligible</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 text-center">
          <p className="text-2xl font-bold text-foreground">{stats.fast}</p>
          <p className="mt-1 text-xs text-muted-foreground">Wait &lt; 4 weeks</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
        <ul className="divide-y divide-border-subtle">
          {sites.map((site) => (
            <li key={site.id}>
              <Link
                href={`/referrals/${site.id}`}
                className="flex items-start justify-between gap-4 px-6 py-4 transition hover:bg-muted"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-faint text-brand-fg">
                    <Building2 className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{site.name}</p>
                    <p className="text-xs text-muted-foreground">{site.specialty}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {site.acceptsUninsured && <Badge tone="success">Uninsured OK</Badge>}
                  {site.freeCareEligible && <Badge tone="brand">Free Care</Badge>}
                  {site.waitWeeks != null && (
                    <Badge tone={site.waitWeeks <= 2 ? "success" : site.waitWeeks <= 6 ? "warning" : "critical"}>
                      ~{site.waitWeeks} wk wait
                    </Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        {sites.length === 0 && (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">
            No providers in the directory yet.
          </p>
        )}
      </div>
    </div>
  );
}