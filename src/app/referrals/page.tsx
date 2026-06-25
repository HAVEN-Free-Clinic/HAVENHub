import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/platform/ui/page-header";
import { ReferralDirectoryBrowser } from "./referral-directory-browser";
import { listReferralSites, deleteReferralSite, markSiteVerified, revertSiteVerification } from "@/modules/referrals/services/referrals";
import Link from "next/link";

async function deleteSiteAction(id: string) {
  "use server";
  await deleteReferralSite(id);
  redirect("/referrals");
}

async function markVerifiedAction(id: string) {
  "use server";
  await markSiteVerified(id);
  redirect("/referrals");
}

async function revertVerificationAction(id: string) {
  "use server";
  await revertSiteVerification(id);
  redirect("/referrals");
}

export default async function ReferralsPage() {
  const sites = await listReferralSites();

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
          <Link
            href="/referrals/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add provider
          </Link>
        }
      />


      <ReferralDirectoryBrowser
        sites={sites}
        deleteSiteAction={deleteSiteAction}
        markVerifiedAction={markVerifiedAction}
        revertVerificationAction={revertVerificationAction}
      />
    </div>
  );
}