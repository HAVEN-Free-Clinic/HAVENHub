import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { listReferralSites, deleteReferralSite } from "@/modules/referrals/services/referrals";
import { ReferralDirectoryBrowser } from "./referral-directory-browser";

async function deleteSiteAction(id: string) {
  "use server";
  await deleteReferralSite(id);
  redirect("/referrals");
}

export default async function ReferralsPage() {
  const sites = await listReferralSites();

  const stats = {
    total: sites.length,
    uninsured: sites.filter((s) => s.acceptsUninsured).length,
    freeCare: sites.filter((s) => s.freeCareEligible).length,
    fast: sites.filter((s) => s.waitWeeks != null && s.waitWeeks < 4).length,
  };

  const oldestReview = sites.reduce<Date | null>((oldest, s) => {
    if (!s.lastReviewedAt) return oldest;
    if (!oldest || s.lastReviewedAt < oldest) return s.lastReviewedAt;
    return oldest;
  }, null);
  
  return (
    <div className="space-y-8">
      <PageHeader
        title="Referral Directory"
        description={
          <>
            Specialists, community health partners, and social services HAVEN refers patients to.
            {oldestReview && (
              <span className="ml-2 italic text-subtle-foreground">
                · Oldest entry last reviewed {oldestReview.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
              </span>
            )}
          </>
        }
        action={
          <a
            href="/referrals/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add provider
          </a>
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

      <ReferralDirectoryBrowser sites={sites} deleteSiteAction={deleteSiteAction} />
    </div>
  );
}