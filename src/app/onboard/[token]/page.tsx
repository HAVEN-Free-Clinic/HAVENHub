import { getContractByToken, lookupStoredEpicId } from "@/modules/recruitment/services/onboarding";
import { parseContractLayout } from "@/modules/recruitment/contract/layout";
import { DEFAULT_CONTRACT_LAYOUT } from "@/modules/recruitment/contract/system-fields";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import { buildOnboardingNextSteps } from "@/modules/recruitment/onboarding-next-steps";
import { getSetting } from "@/platform/settings/service";
import { getSupportContact } from "@/platform/branding/support";
import { SupportLink } from "@/platform/branding/support-link";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatDateOnly } from "@/platform/dates";
import { prisma } from "@/platform/db";
import { OnboardForm } from "./onboard-form";
import { NextStepsScreen } from "./next-steps-screen";
import { formatTrainingDate, formatTrainingLocation } from "./training-date";

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // getContractByToken folds an expired PENDING link into null (services/
  // onboarding.ts), so an expired PENDING token (still needs a new link) and
  // an unknown token land here identically. That is correct: this branch
  // cannot tell the two apart, and both genuinely are errors. A SUBMITTED/
  // PROMOTED contract past its expiresAt still resolves here (expiry only
  // ever gated the fill-out window), so revisiting a completed link still
  // reaches the confirmation branch below.
  const contract = await getContractByToken(token);
  if (!contract) {
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

  const orgName = await getSetting<string>("branding.orgName");
  const zone = await getDisplayTimeZone();
  const cycle = contract.acceptance?.application?.cycle ?? null;

  // SUBMITTED (awaiting promotion) and PROMOTED (converted into a Person and
  // membership) both mean the volunteer already completed this form. Reopening
  // the link at either point -- a bookmark, or checking what they signed -- is
  // a success, not the "link may be invalid" failure above. Render the same
  // next-steps content the completion screen shows (onboard-form.tsx), resolved
  // fresh from the live row rather than anything cached from submit time.
  //
  // Sign-in and Epic need no PROMOTED-specific copy: the sign-in line stays
  // true either way (SSO is unconditional; the non-Yale magic-link line
  // describes the only sign-in mechanism that exists, and is if anything MORE
  // reliably true once promoted, since promotion guarantees a Person row for
  // lookupStoredEpicId/requestMemberLoginLink (member-magic-link.ts:153-156)
  // to match against). The Epic line self-corrects because storedEpicId is
  // looked up live here: if promotion adopted a self-reported existingEpicId
  // onto the new Person (promotion.ts's effectiveEpicId), lookupStoredEpicId
  // now finds it and buildOnboardingNextSteps switches to the "already on file"
  // branch on its own, with no extra branching needed. The review line DOES
  // need PROMOTED-specific copy: promoteContracts is the review-and-roster-add
  // action, so it must read in the past tense once that has happened (the
  // `reviewed` input below).
  if (contract.status !== "PENDING") {
    const trainingDate = formatTrainingDate(cycle?.inPersonTrainingDate ?? null, zone);
    const trainingLocation = formatTrainingLocation(cycle?.trainingLocation ?? null);
    const storedEpicId = await lookupStoredEpicId(contract.netId, contract.email);
    const steps = buildOnboardingNextSteps({
      email: contract.email,
      trainingDate,
      trainingLocation,
      epicNeeded: contract.epicNeeded,
      storedEpicId,
      hasEpic: contract.hasEpic,
      // PROMOTED means promoteContracts already did the review and the
      // roster add; the review line must say so in the past tense rather
      // than promise it as still pending.
      reviewed: contract.status === "PROMOTED",
    });
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="text-2xl font-bold tracking-tight">{orgName} onboarding</h1>
        <p className="mt-2 text-muted-foreground">
          You completed this on {formatDateOnly(contract.submittedAt, zone)}.
        </p>
        <NextStepsScreen steps={steps} />
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

  // department/track drive which contract blocks are shown (department
  // responsibility agreements, the Epic self-report, staff-title, etc.), so
  // they come from the same acceptance -> application -> cycle chain the
  // server submit path will validate against, not from anything the
  // applicant could submit. A departmentCode that no longer resolves to a
  // Department (deleted/renamed) falls through epicRequirementFor's null
  // branch to NONE, matching its documented "no basis to provision Epic"
  // contract.
  const departmentCode = contract.acceptance?.departmentCode ?? null;
  const track = cycle?.track ?? "VOLUNTEER";
  const dept = departmentCode
    ? await prisma.department.findUnique({
        where: { code: departmentCode },
        select: { requiresEpicDirector: true, requiresEpicVolunteer: true },
      })
    : null;
  const epicRequirement = epicRequirementFor(dept, track);
  // The Epic ID already on file for this applicant (a returning member), matched
  // the same way promotion and submitContract match. When set, the Epic section
  // confirms it instead of re-collecting. Same lookup on both sides keeps the
  // section's client/server visibility in agreement.
  const storedEpicId = await lookupStoredEpicId(contract.netId, contract.email);

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
          department: departmentCode, track, epicRequirement, storedEpicId,
        }}
        departments={departments}
      />
    </main>
  );
}
