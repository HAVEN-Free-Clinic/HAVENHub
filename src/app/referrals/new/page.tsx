import { redirect } from "next/navigation";
import { PageHeader } from "@/platform/ui/page-header";
import { createReferralSite } from "@/modules/referrals/services/referrals";
import { ReferralSiteForm } from "./referral-site-form";

async function createSiteAction(formData: FormData) {
  "use server";

  const languages = (formData.get("languages") as string)
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const referralSteps = (formData.get("referralSteps") as string)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const waitWeeksRaw = formData.get("waitWeeks") as string;
  const flagRaw = formData.get("flag") as string;

  const providerCount = Number(formData.get("providerCount") ?? 0);
  const providers = Array.from({ length: providerCount })
    .map((_, i) => ({
      name: (formData.get(`provider_name_${i}`) as string) ?? "",
      specialty: (formData.get(`provider_specialty_${i}`) as string) ?? "",
    }))
    .filter((p) => p.name.trim().length > 0);

  const site = await createReferralSite({
    name: formData.get("name") as string,
    category: formData.get("category") as any,
    specialty: formData.get("specialty") as string,
    system: formData.get("system") as any,
    acceptsUninsured: formData.get("acceptsUninsured") === "on",
    freeCareEligible: formData.get("freeCareEligible") === "on",
    slidingScale: formData.get("slidingScale") === "on",
    waitWeeks: waitWeeksRaw ? Number(waitWeeksRaw) : undefined,
    waitNote: (formData.get("waitNote") as string) || undefined,
    phone: formData.get("phone") as string,
    address: formData.get("address") as string,
    languages,
    schedulingContact: formData.get("schedulingContact") as string,
    fax: (formData.get("fax") as string) || undefined,
    referralSteps,
    notes: (formData.get("notes") as string) || undefined,
    flag: flagRaw ? (flagRaw as any) : undefined,
    flagText: (formData.get("flagText") as string) || undefined,
    providers,
  });

  redirect(`/referrals/${site.id}`);
}

export default function NewReferralSitePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Add provider"
        description="Add a new referral site or specialist to the directory."
      />
      <ReferralSiteForm action={createSiteAction} />
    </div>
  );
}