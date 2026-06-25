import { redirect } from "next/navigation";
import { PageHeader } from "@/platform/ui/page-header";
import { getReferralSite, updateReferralSite } from "@/modules/referrals/services/referrals";
import { ReferralSiteForm } from "@/app/referrals/new/referral-site-form";
import type { ProviderCategory, ProviderFlag, ProviderSystem } from "@prisma/client";

export default async function EditReferralSitePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const site = await getReferralSite(id);

  async function updateSiteAction(formData: FormData) {
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

    await updateReferralSite(id, {
      name: formData.get("name") as string,
      category: formData.get("category") as ProviderCategory,
      specialty: formData.get("specialty") as string,
      system: (formData.get("system") as ProviderSystem) || undefined,
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
      flag: flagRaw ? (flagRaw as ProviderFlag) : undefined,
      flagText: (formData.get("flagText") as string) || undefined,
      providers,
    });

    redirect(`/referrals/${id}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={`Edit ${site.name}`} description="Update this provider's directory entry." />
      <ReferralSiteForm
        action={updateSiteAction}
        submitLabel="Save changes"
        initialValues={{
          name: site.name,
          category: site.category,
          specialty: site.specialty,
          system: site.system,
          acceptsUninsured: site.acceptsUninsured,
          freeCareEligible: site.freeCareEligible,
          slidingScale: site.slidingScale,
          waitWeeks: site.waitWeeks,
          waitNote: site.waitNote,
          phone: site.phone,
          address: site.address,
          languages: site.languages,
          schedulingContact: site.schedulingContact,
          fax: site.fax,
          referralSteps: site.referralSteps,
          notes: site.notes,
          flag: site.flag,
          flagText: site.flagText,
          providers: site.providers.map((p) => ({ name: p.name, specialty: p.specialty })),
        }}
      />
    </div>
  );
}