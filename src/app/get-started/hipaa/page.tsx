import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import {
  getMyInfo,
  listMyCertificates,
  saveCertificate,
  setCertificateCompletionDate,
  parseCertificateUpload,
  CertificateValidationError,
} from "@/modules/my-info/services/my-info";
import { complianceStatus } from "@/platform/compliance/rules";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { OnboardingStepShell } from "../onboarding-step-shell";

export default async function OnboardingHipaaPage({
  searchParams,
}: {
  searchParams: Promise<{ certError?: string; certSaved?: string; dateError?: string; dateSaved?: string }>;
}) {
  const person = await requirePersonSession();
  const status = await getOnboardingStatus(person.personId);
  if (status.exempt || !status.hasActiveTerm || status.onboarded) redirect("/");
  const task = status.tasks.find((t) => t.key === "hipaa");
  if (!task || task.state === "COMPLETE" || task.state === "NOT_REQUIRED") redirect("/get-started");

  const sp = await searchParams;
  const [{ activeTerm }, certificates] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
  ]);
  const certStatus = complianceStatus(certificates[0] ?? null, activeTerm?.endDate ?? null);

  async function uploadAction(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    const parsed = parseCertificateUpload(formData);
    if (!parsed) redirect("/get-started/hipaa?certError=Choose+a+PDF+file.");
    try {
      const bytes = Buffer.from(await parsed.file.arrayBuffer());
      await saveCertificate(s.personId, { name: parsed.name, type: parsed.type, size: parsed.size, bytes });
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(`/get-started/hipaa?certError=${encodeURIComponent(err.reason)}`);
      }
      throw err;
    }
    redirect("/get-started/hipaa?certSaved=1");
  }

  async function dateAction(formData: FormData) {
    "use server";
    const s = await requirePersonSession();
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    const certId = (formData.get("certId") as string | null) ?? "";
    try {
      await setCertificateCompletionDate(s.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(`/get-started/hipaa?dateError=${encodeURIComponent(err.reason)}`);
      }
      throw err;
    }
    redirect("/get-started/hipaa?dateSaved=1");
  }

  return (
    <OnboardingStepShell
      title="HIPAA certificate"
      description="Upload your current HIPAA certificate so we can verify it is valid through the term."
      completedCount={status.completedCount}
      totalCount={status.totalCount}
    >
      <HipaaPanel
        certificates={certificates}
        uploadAction={uploadAction}
        dateAction={dateAction}
        status={certStatus}
        error={sp.certError}
        certSaved={sp.certSaved === "1"}
        dateError={sp.dateError}
        dateSaved={sp.dateSaved === "1"}
      />
    </OnboardingStepShell>
  );
}
