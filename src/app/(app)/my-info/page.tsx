import { redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import {
  getMyInfo,
  listMyCertificates,
  updateMyInfo,
  withdrawFromTerm,
  saveCertificate,
  parseCertificateUpload,
  CertificateValidationError,
} from "@/modules/my-info/services/my-info";
import { PersonConflictError } from "@/platform/people";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { MembershipsCard } from "@/modules/my-info/components/memberships-card";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";
import { EpicPanel } from "@/modules/my-info/components/epic-panel";
import { ClearanceCard } from "@/modules/my-info/components/clearance-card";
import { complianceStatus, overallClearance } from "@/platform/compliance/rules";
import { resolveTrainingState, requiredTrainingTracks } from "@/modules/recruitment/services/training";
import {
  myEpicPanel,
  createEpicRequest,
  EpicStateError,
  EpicForbiddenError,
} from "@/modules/volunteers/services/epic";
import type { EpicRequestKind } from "@prisma/client";

type PageProps = {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    withdrawn?: string;
    certSaved?: string;
    certError?: string;
    epicError?: string;
    epicSaved?: string;
  }>;
};

export default async function MyInfoPage({ searchParams }: PageProps) {
  const person = await requireModuleAccess("my-info");
  const sp = await searchParams;

  // Fetch all data in parallel where possible.
  // getMyInfo already loads the active term; reuse it to avoid a second query.
  const [myInfo, certificates, epicPanel] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
    myEpicPanel(person.personId),
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
        // epicId intentionally absent: it is IT-managed, not self-service
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

  async function epicRequestAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const rawKind = (formData.get("kind") as string | null) ?? "";
    const notes = (formData.get("notes") as string | null) || null;

    // Validate kind. The service re-checks via kind-sanity rules; we map the
    // resulting EpicStateError message to the epicError param.
    // jobTitle and mirrorEpicId are not accepted from the self-service form;
    // the IT team fills those in while processing the request.
    const allowedKinds: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];
    if (!(allowedKinds as string[]).includes(rawKind)) {
      redirect("/my-info?epicError=Invalid+request+kind.");
    }

    try {
      await createEpicRequest(session.personId, {
        personId: session.personId,
        kind: rawKind as EpicRequestKind,
        notes,
      });
    } catch (err) {
      if (err instanceof EpicStateError) {
        redirect(`/my-info?epicError=${encodeURIComponent(err.message)}`);
      }
      if (err instanceof EpicForbiddenError) {
        redirect(`/my-info?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect("/my-info?epicSaved=1");
  }

  // Compute compliance status for the newest cert
  const newestCert = certificates[0] ?? null;
  const status = complianceStatus(
    newestCert,
    activeTerm?.endDate ?? null
  );

  const tracks = activeTerm ? await requiredTrainingTracks(person.personId, activeTerm.id) : [];
  const trainingRows = activeTerm
    ? await Promise.all(
        tracks.map(async (track) => ({
          label: track === "DIRECTOR" ? "Director training" : "Volunteer training",
          state: await resolveTrainingState(person.personId, activeTerm.id, track),
        }))
      )
    : [];
  const allTrainingsComplete = trainingRows.length === 0 || trainingRows.every((r) => r.state === "COMPLETE");
  const clearance = overallClearance(status, allTrainingsComplete);

  const withdrawn = sp.withdrawn !== undefined ? parseInt(sp.withdrawn, 10) : undefined;

  return (
    <>
      <PageHeader
        title="My Info"
        description="Keep your contact details current."
      />

      <div className="mt-8 space-y-10">
        {/* Profile form */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Profile
          </h2>
          <MyInfoForm
            action={updateAction}
            person={myInfo.person}
            error={sp.error ? decodeURIComponent(sp.error) : undefined}
            saved={sp.saved === "1" ? "Saved." : undefined}
          />
        </section>

        {/* Memberships */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
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
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            HIPAA Certificate
          </h2>
          <HipaaPanel
            certificates={certificates}
            uploadAction={uploadAction}
            error={sp.certError ? decodeURIComponent(sp.certError) : undefined}
            certSaved={sp.certSaved === "1"}
            status={status}
          />
        </section>

        {/* Clearance */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Clearance
          </h2>
          <ClearanceCard
            clearance={clearance}
            certStatus={status}
            trainingRows={trainingRows}
            termName={activeTerm?.name ?? null}
          />
        </section>

        {/* Epic access */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Epic Access
          </h2>
          <EpicPanel
            epicId={epicPanel.epicId}
            openRequest={epicPanel.openRequest}
            action={epicRequestAction}
            error={sp.epicError ? decodeURIComponent(sp.epicError) : undefined}
            saved={sp.epicSaved === "1"}
          />
        </section>
      </div>
    </>
  );
}
