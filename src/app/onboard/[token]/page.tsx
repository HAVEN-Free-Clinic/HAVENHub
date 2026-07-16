import { getContractByToken } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { OnboardForm } from "./onboard-form";

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const contract = await getContractByToken(token);
  if (!contract || contract.status !== "PENDING") {
    const support = await getSupportContact();
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-bold">This onboarding form is not available</h1>
        <p className="mt-2 text-muted-foreground">The link may be invalid or already completed.</p>
        {support.email && (
          <p className="mt-4 text-sm text-muted-foreground">
            Need a new link? <SupportLink email={support.email}>{support.label}</SupportLink>
          </p>
        )}
      </main>
    );
  }
  const prefill = {
    firstName: contract.firstName,
    lastName: contract.lastName,
    email: contract.email,
    netId: contract.netId ?? "",
    phone: contract.phone ?? "",
    yaleAffiliation: contract.yaleAffiliation ?? "",
    gradYear: contract.gradYear ?? "",
    spanish: contract.spanishSelfReported,
  };
  let layout = DEFAULT_CONTRACT_LAYOUT;
  try {
    if (contract.templateSnapshot) layout = parseContractLayout(contract.templateSnapshot);
  } catch {
    /* invalid snapshot -> fall back to the code default */
  }
  const orgName = await getSetting<string>("branding.orgName");
  // Stamp the date once on the server so the HIPAA date bounds hydrate identically.
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">HAVEN onboarding</h1>
      <OnboardForm token={contract.token} prefill={prefill} layout={layout} ctx={{ firstName: contract.firstName, orgName, todayIso }} />
    </main>
  );
}
