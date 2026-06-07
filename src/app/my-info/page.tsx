import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import {
  getMyInfo,
  listMyCertificates,
  updateMyInfo,
  withdrawFromTerm,
  saveCertificate,
  CertificateValidationError,
} from "@/modules/my-info/services/my-info";
import { PersonConflictError } from "@/platform/people";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { MembershipsCard } from "@/modules/my-info/components/memberships-card";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";

type PageProps = {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    withdrawn?: string;
    certSaved?: string;
    certError?: string;
  }>;
};

export default async function MyInfoPage({ searchParams }: PageProps) {
  const person = await requireModuleAccess("my-info");
  const sp = await searchParams;

  // Fetch all data in parallel where possible.
  const [myInfo, activeTerm, certificates] = await Promise.all([
    getMyInfo(person.personId),
    prisma.term.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    }),
    listMyCertificates(person.personId),
  ]);

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
    const file = formData.get("certificate") as File | null;
    if (!file || file.size === 0) {
      redirect("/my-info?certError=Choose+a+PDF+file.");
    }
    try {
      const bytes = Buffer.from(await file!.arrayBuffer());
      await saveCertificate(session.personId, {
        name: file!.name,
        type: file!.type,
        size: file!.size,
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
            error={sp.certError}
            certSaved={sp.certSaved === "1"}
          />
        </section>
      </div>
    </AppShell>
  );
}
