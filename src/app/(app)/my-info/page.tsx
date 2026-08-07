import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { SectionHeader } from "@/platform/ui/section-header";
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
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";
import { ClearanceCard, certRequirement, taskRequirement } from "@/modules/my-info/components/clearance-card";
import { CalendarSubscribeCard } from "@/modules/my-info/components/calendar-subscribe-card";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { effectiveComplianceStatus } from "@/platform/compliance/rules";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { issueFeedToken, readFeedToken } from "@/modules/schedule/calendar/feed-token";
import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { recordAudit } from "@/platform/audit";

type PageProps = {
  searchParams: Promise<{
    withdrawn?: string;
  }>;
};

export default async function MyInfoPage({ searchParams }: PageProps) {
  const person = await requireModuleAccess("my-info");
  const sp = await searchParams;

  // Fetch all data in parallel where possible.
  // getMyInfo already loads the active term; reuse it to avoid a second query.
  const [myInfo, certificates, ehsItems, feedToken, baseUrl, timeZone] = await Promise.all([
    getMyInfo(person.personId),
    listMyCertificates(person.personId),
    getMyEhsStatus(person.personId),
    readFeedToken(person.personId),
    getSetting<string>("app.baseUrl"),
    getDisplayTimeZone(),
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
        dietaryRestrictions: (formData.get("dietaryRestrictions") as string) || null,
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

  async function withdrawAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const reason = (formData.get("reason") as string | null) ?? null;
    const count = await withdrawFromTerm(session.personId, reason);
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

  async function generateFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueFeedToken(session.personId);
    await recordAudit({
      actorPersonId: session.personId,
      action: "calendar_feed.issue",
      entityType: "CalendarFeedToken",
      entityId: session.personId,
    });
    revalidatePath("/my-info");
  }

  async function resetFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueFeedToken(session.personId);
    await recordAudit({
      actorPersonId: session.personId,
      action: "calendar_feed.reset",
      entityType: "CalendarFeedToken",
      entityId: session.personId,
    });
    revalidatePath("/my-info");
  }

  // Drive the HIPAA requirement row from the SAME rule as the clearance banner
  // beside it (effectiveComplianceStatus over the full cert history, with the
  // verified-fallback). Using complianceStatus(newestCert) here made the row show
  // PENDING_VERIFICATION for an early renewal while the banner showed "Cleared".
  const status = effectiveComplianceStatus(
    certificates,
    activeTerm?.endDate ?? null
  );

  // Onboarding status drives the clearance card (includes EHS as a non-blocking item).
  const onboarding = await getOnboardingStatus(person.personId);

  const requirements = onboarding.tasks
    .filter((t) => t.state !== "NOT_REQUIRED")
    .map((t) => (t.key === "hipaa" ? certRequirement(status) : taskRequirement(t.label, t.state)));

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
          <SectionHeader className="mb-4">Profile</SectionHeader>
          <MyInfoForm
            action={updateAction}
            person={myInfo.person}
          />
        </section>

        {/* Memberships */}
        <section>
          <SectionHeader className="mb-4">Memberships</SectionHeader>
          <MembershipsCard
            memberships={myInfo.memberships}
            withdrawAction={withdrawAction}
            withdrawn={withdrawn}
          />
        </section>

        {/* HIPAA certificate */}
        <section>
          <SectionHeader className="mb-4">HIPAA Certificate</SectionHeader>
          <HipaaPanel
            certificates={certificates}
            uploadAction={uploadAction}
            status={status}
          />
        </section>

        {/* EHS Training */}
        <section>
          <SectionHeader className="mb-4">EHS Training</SectionHeader>
          <EhsPanel items={ehsItems} />
        </section>

        {/* Clearance */}
        <section>
          <SectionHeader className="mb-4">Clearance</SectionHeader>
          <ClearanceCard
            requirements={requirements}
            cleared={onboarding.cleared}
            termName={activeTerm?.name ?? null}
            // Only offer the /get-started CTA if going there would do something. An
            // already-onboarded member (the usual case here) has only non-blocking,
            // coordinator-recorded items left, and /get-started just redirects home.
            finishHref={onboarding.onboarded ? undefined : "/get-started"}
          />
        </section>

        {/* Calendar subscription */}
        <section>
          <SectionHeader className="mb-4">Calendar</SectionHeader>
          <CalendarSubscribeCard
            feedUrl={feedToken ? `${baseUrl}/api/calendar/${feedToken.token}.ics` : null}
            lastFetchedAt={feedToken?.lastFetchedAt ?? null}
            timeZone={timeZone}
            generateAction={generateFeedAction}
            resetAction={resetFeedAction}
          />
        </section>
      </div>
    </>
  );
}
