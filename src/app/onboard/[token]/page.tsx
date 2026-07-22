import { getContractByToken } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { prisma } from "@/platform/db";
import { OnboardForm } from "./onboard-form";
import { formatTrainingDate, formatTrainingLocation } from "./training-date";

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
  const cycle = contract.acceptance?.application?.cycle ?? null;
  const track = cycle?.track ?? "VOLUNTEER";
  const dept = departmentCode
    ? await prisma.department.findUnique({
        where: { code: departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const epicRequirement = epicRequirementFor(dept, track);

  // The director default's second_department_name question is a
  // DEPARTMENT_CHOICE custom question (contract/defaults/director.ts); its
  // options come from the clinic's active departments, not the layout
  // itself. FieldPreview (shared with the apply wizard) renders whatever
  // strings this list contains as the option value; the apply wizard passes
  // department CODES (RecruitmentCycle.departments is String[] of Department
  // codes, threaded through apply/[slug]/page.tsx's `def.departments`), so
  // codes are used here too to keep a stored answer consistent across both
  // flows and with the department-gated agreement blocks in
  // defaults/departments.ts, which key visibleWhen on the code.
  const departmentRows = await prisma.department.findMany({
    where: { isActive: true },
    select: { code: true, name: true },
    orderBy: { name: "asc" },
  });
  const departments = departmentRows.map((d) => d.code);

  const zone = await getDisplayTimeZone();
  const trainingDate = formatTrainingDate(cycle?.inPersonTrainingDate ?? null, zone);
  const trainingLocation = formatTrainingLocation(cycle?.trainingLocation ?? null);

  // Stamp the date once on the server so the HIPAA date bounds hydrate
  // identically on the client.
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight">{orgName} onboarding</h1>
      <OnboardForm
        token={contract.token}
        prefill={prefill}
        layout={layout}
        ctx={{
          firstName: contract.firstName, orgName, todayIso,
          trainingDate, trainingLocation,
          department: departmentCode, track, epicRequirement,
        }}
        departments={departments}
      />
    </main>
  );
}
