import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { listReferralSites } from "@/modules/referrals/services/referrals";
import { ReferralDirectoryBrowser } from "./referral-directory-browser";

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

      <ReferralDirectoryBrowser sites={sites} />
    </div>
  );
}