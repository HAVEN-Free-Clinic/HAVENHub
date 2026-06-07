import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import {
  getMyInfo,
  listMyCertificates,
  updateMyInfo,
  withdrawFromTerm,
  saveCertificate,
  setCertificateCompletionDate,
  parseCertificateUpload,
  CertificateValidationError,
} from "@/modules/my-info/services/my-info";
import { PersonConflictError } from "@/platform/people";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { MembershipsCard } from "@/modules/my-info/components/memberships-card";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";
import { complianceStatus } from "@/platform/compliance/rules";

type PageProps = {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    withdrawn?: string;
    certSaved?: string;
    certError?: string;
    dateError?: string;
    dateSaved?: string;
  }>;
};

export default async function MyInfoPage({ searchParams }: PageProps) {
  const person = await requireModuleAccess("my-info");
  const sp = await searchParams;

  // Fetch all data in parallel where possible.
  // getMyInfo already loads the active term; reuse it to avoid a second query.
  const [myInfo, certificates] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
  ]);
  const { activeTerm } = myInfo;

  // Server actions
  async function updateAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    try {
      await updateMyInfo(session.personId, {
        phone: (formData.get("phone") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
        epicId: (formData.get("epicId") as string) || null,
      });
    } catch (err) {
      if (err instanceof PersonConflictError) {
        redirect(
          `/my-info?error=${encodeURIComponent(`${err.field} already belongs to another person`)}`
        );
      }
      throw err;
    }
    redirect("/my-info?saved=1");
  }

  async function withdrawAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    const count = await withdrawFromTerm(session.personId);
    redirect(`/my-info?withdrawn=${count}`);
  }

  async function uploadAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const parsed = parseCertificateUpload(formData);
    if (!parsed) {
      redirect("/my-info?certError=Choose+a+PDF+file.");
    }
    try {
      const bytes = Buffer.from(await parsed.file.arrayBuffer());
      await saveCertificate(session.personId, {
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        bytes,
      });
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(
          `/my-info?certError=${encodeURIComponent(err.reason)}`
        );
      }
      throw err;
    }
    redirect("/my-info?certSaved=1");
  }

  async function dateAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const dateIso = (formData.get("completionDate") as string | null) ?? "";
    const certId = (formData.get("certId") as string | null) ?? "";
    try {
      await setCertificateCompletionDate(session.personId, certId, dateIso);
    } catch (err) {
      if (err instanceof CertificateValidationError) {
        redirect(`/my-info?dateError=${encodeURIComponent(err.reason)}`);
      }
      throw err;
    }
    redirect("/my-info?dateSaved=1");
  }

  // Compute compliance status for the newest cert
  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(
    newestCert,
    activeTerm?.endDate ?? null
  );

  const withdrawn = sp.withdrawn !== undefined ? parseInt(sp.withdrawn, 10) : undefined;

  return (
    <AppShell userName={person.name} termLabel={activeTerm?.name ?? null}>
      <PageHeader
        title="My Info"
        description="Keep your contact details current."
      />

      <div className="mt-8 space-y-10">
        {/* Profile form */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Profile
          </h2>
          <MyInfoForm
            action={updateAction}
            person={myInfo.person}
            error={sp.error}
            saved={sp.saved === "1" ? "Saved." : undefined}
          />
        </section>

        {/* Memberships */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Memberships
          </h2>
          <MembershipsCard
            memberships={myInfo.memberships}
            withdrawAction={withdrawAction}
            withdrawn={withdrawn}
          />
        </section>

        {/* HIPAA certificate */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
            HIPAA Certificate
          </h2>
          <HipaaPanel
            certificates={certificates}
            uploadAction={uploadAction}
            dateAction={dateAction}
            error={sp.certError}
            certSaved={sp.certSaved === "1"}
            dateError={sp.dateError}
            dateSaved={sp.dateSaved === "1"}
            status={status}
          />
        </section>
      </div>
    </AppShell>
  );
}
