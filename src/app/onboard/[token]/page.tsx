import { getContractByToken } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { prisma } from "@/platform/db";
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
  };
  let layout = DEFAULT_CONTRACT_LAYOUT;
  try {
    if (contract.templateSnapshot) layout = parseContractLayout(contract.templateSnapshot);
  } catch {
    /* invalid snapshot -> fall back to the code default */
  }
  const orgName = await getSetting<string>("branding.orgName");

  // department/track drive which contract blocks are shown (department
  // responsibility agreements, the Epic self-report, staff-title, etc.), so
  // they come from the same acceptance -> application -> cycle chain the
  // server submit path will validate against, not from anything the
  // applicant could submit. A departmentCode that no longer resolves to a
  // Department (deleted/renamed) falls through epicRequirementFor's null
  // branch to NONE, matching its documented "no basis to provision Epic"
  // contract.
  const departmentCode = contract.acceptance?.departmentCode ?? null;
  const track = contract.acceptance?.application?.cycle?.track ?? "VOLUNTEER";
  const dept = departmentCode
    ? await prisma.department.findUnique({
        where: { code: departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const epicRequirement = epicRequirementFor(dept, track);

  // Stamp the date/year once on the server so the HIPAA date bounds and grad
  // year options hydrate identically on the client.
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const currentYear = now.getUTCFullYear();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">{orgName} onboarding</h1>
      <OnboardForm
        token={contract.token}
        prefill={prefill}
        layout={layout}
        ctx={{
          firstName: contract.firstName, orgName, todayIso, currentYear,
          trainingDate: "", trainingLocation: "",
          department: departmentCode, track, epicRequirement,
        }}
      />
    </main>
  );
}
