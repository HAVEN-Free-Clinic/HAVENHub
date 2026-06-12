import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { PersonConflictError } from "@/platform/people";
import { getMyInfo, updateMyInfo } from "@/modules/my-info/services/my-info";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "profile");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const sp = await searchParams;
  const { person: me } = await getMyInfo(person.personId);

  async function action(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    try {
      await updateMyInfo(s.personId, {
        phone: (formData.get("phone") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
      });
    } catch (err) {
      if (err instanceof PersonConflictError) {
        redirect(`/get-started/profile?error=${encodeURIComponent(`${err.field} already belongs to another person`)}`);
      }
      throw err;
    }
    redirect("/get-started");
  }

  return (
    <OnboardingStepShell
      title="Profile & agreements"
      description="Confirm your contact details so we can reach you about shifts."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <MyInfoForm action={action} person={me} error={sp.error} />
    </OnboardingStepShell>
  );
}
