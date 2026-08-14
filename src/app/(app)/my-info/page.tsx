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
import { PhotoError, removePhoto, setPhotoFromUpload } from "@/platform/photos";
import { MyInfoForm } from "@/modules/my-info/components/my-info-form";
import { MembershipsCard } from "@/modules/my-info/components/memberships-card";
import { PhotoCard } from "@/modules/my-info/components/photo-card";
import { HipaaPanel } from "@/modules/my-info/components/hipaa-panel";
import { EhsPanel } from "@/modules/my-info/components/ehs-panel";
import { ClearanceCard, certRequirement, taskRequirement } from "@/modules/my-info/components/clearance-card";
import { getMyEhsStatus } from "@/platform/ehs/services/my-ehs";
import { effectiveComplianceStatus } from "@/platform/compliance/rules";
import { getOnboardingStatus } from "@/modules/onboarding/services/onboarding";
import { getSetting } from "@/platform/settings/service";
import {
  issueServiceCredential,
  publishCredential,
  unpublishCredential,
  getCredential,
  type IssuedCredential,
} from "@/modules/passport/services/credential";
import { issueWalletPass } from "@/modules/passport/services/wallet-pass";
import { isWalletEnabled } from "@/modules/passport/services/wallet-client";
import { ServiceRecordCard } from "@/modules/passport/components/service-record-card";
import { listMyStrikes } from "@/modules/incidents/services/disciplinary";
import { StrikesPanel } from "./strikes-panel";
import { languagesForPerson } from "@/platform/languages";
import { LanguagesPanel } from "./languages-panel";
import { CalendarSubscribeSection } from "@/modules/schedule/calendar/subscribe-section";
import { issueAuditedFeedToken } from "@/modules/schedule/calendar/subscribe-actions";

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
  const [myInfo, certificates, ehsItems, brandColor, orgName, existingCredential, baseUrl, maxMb, myStrikes, myLanguages] =
    await Promise.all([
      getMyInfo(person.personId),
      listMyCertificates(person.personId),
      getMyEhsStatus(person.personId),
      getSetting<string>("branding.brandColor"),
      getSetting<string>("branding.orgName"),
      getCredential(person.personId),
      getSetting<string>("app.baseUrl"),
      getSetting<number>("uploads.maxMb"),
      // Always the session's own person, never a client-supplied id, so this
      // cannot be turned into a lookup of someone else's disciplinary record.
      listMyStrikes(person.personId),
      languagesForPerson(person.personId),
    ]);
  const { activeTerm } = myInfo;

  // Resolved on the server so the card can omit the wallet section entirely
  // when no vendor key is configured, rather than rendering a button that
  // would always come back null.
  const walletEnabled = isWalletEnabled();

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

  async function photoUploadAction(formData: FormData) {
    "use server";
    const session = await requireModuleAccess("my-info");
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) {
      redirect("/my-info?photoError=Choose+an+image+file.");
    }
    try {
      await setPhotoFromUpload(
        session.personId,
        { type: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
        await getSetting<number>("uploads.maxMb"),
        // Actor is the member themselves: this is their own affirmative
        // override of any prior opt-out, so suppression clears (see
        // setPhotoFromUpload's doc comment).
        session.personId
      );
    } catch (err) {
      if (err instanceof PhotoError) {
        redirect(`/my-info?photoError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    // The account menu (rendered by the (app) layout, on every authenticated
    // page) reads photoVersion from the session and renders it into the photo
    // URL's ?v= cache-buster. That layout persists across soft navigation, so
    // without this the menu would keep the pre-upload ?v= for the rest of the
    // session -- and since the route itself is served with a one-year
    // immutable Cache-Control, the browser would also hold the old bytes at
    // that exact URL. revalidatePath("/", "layout") busts the Router Cache for
    // every layout in the tree, including (app)/layout.tsx, so the very next
    // render re-reads the session and picks up the new version.
    revalidatePath("/", "layout");
    redirect("/my-info?photoSaved=1");
  }

  async function photoRemoveAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await removePhoto(session.personId);
    // Same reasoning as photoUploadAction above: removal also bumps
    // photoVersion (and drops photoKey), and the account menu needs that
    // fresh version on its very next render, not whenever the layout
    // happens to re-run on its own.
    revalidatePath("/", "layout");
    redirect("/my-info?photoRemoved=1");
  }

  // The card also renders on /schedule, so both paths are revalidated: a member
  // who generates the link here must not find a stale empty card over there.
  async function generateFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueAuditedFeedToken(session.personId, "issue");
    revalidatePath("/my-info");
    revalidatePath("/schedule");
  }

  async function resetFeedAction() {
    "use server";
    const session = await requireModuleAccess("my-info");
    await issueAuditedFeedToken(session.personId, "reset");
    revalidatePath("/my-info");
    revalidatePath("/schedule");
  }

  async function issueAction(): Promise<IssuedCredential> {
    "use server";
    const session = await requireModuleAccess("my-info");
    return issueServiceCredential(session.personId);
  }

  // Both actions derive personId from the session, never from an argument: this
  // page is the only caller of publishCredential/unpublishCredential, and a
  // client-suppliable person id would let any signed-in member publish someone
  // else's record to the public internet.
  async function publishAction(): Promise<string> {
    "use server";
    const session = await requireModuleAccess("my-info");
    return publishCredential(session.personId);
  }

  async function unpublishAction(): Promise<void> {
    "use server";
    const session = await requireModuleAccess("my-info");
    await unpublishCredential(session.personId);
  }

  // Zero-argument, same as the three actions above: personId always comes from
  // the session, never a client-supplied value, so a member can never mint a
  // badge in someone else's name. issueWalletPass is best-effort and returns
  // null (not a throw) whenever the wallet feature is off or the vendor call
  // fails, which the card renders as a calm, expected state.
  async function issueWalletPassAction(): Promise<{ googleSaveUrl: string; shareUrl: string } | null> {
    "use server";
    const session = await requireModuleAccess("my-info");
    return issueWalletPass(session.personId);
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
        {/* Photo */}
        <section>
          <SectionHeader className="mb-4">Photo</SectionHeader>
          <PhotoCard
            person={{
              id: person.personId,
              name: person.name,
              photoVersion: myInfo.person.photoVersion,
              photoKey: myInfo.person.photoKey,
            }}
            photoSource={myInfo.person.photoSource}
            maxMb={maxMb}
            uploadAction={photoUploadAction}
            removeAction={photoRemoveAction}
          />
        </section>

        {/* Profile form */}
        <section>
          <SectionHeader className="mb-4">Profile</SectionHeader>
          <MyInfoForm
            action={updateAction}
            person={myInfo.person}
          />
        </section>

        {/* Languages. Part of the "who you are on record as" block at the top of
            the page, beside Profile and Memberships -- not down among the
            compliance sections, where members read it as an afterthought. */}
        <section>
          <SectionHeader className="mb-4">Languages</SectionHeader>
          <LanguagesPanel languages={myLanguages} />
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

        {/* Clearance. Ahead of the HIPAA and EHS sections it summarizes: the
            banner tells a member to "finish the unchecked items below", which
            only reads correctly when those sections follow it. */}
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

        {/* Disciplinary record. Placed after the compliance sections because it
            also answers "where do I stand?", and before the outward-facing
            Calendar and Service record sections. */}
        <section>
          <SectionHeader className="mb-4">Disciplinary record</SectionHeader>
          <StrikesPanel strikes={myStrikes} />
        </section>

        {/* Calendar subscription */}
        <section>
          <SectionHeader className="mb-4">Calendar</SectionHeader>
          <CalendarSubscribeSection
            personId={person.personId}
            generateAction={generateFeedAction}
            resetAction={resetFeedAction}
          />
        </section>

        {/* Service record */}
        <section>
          <ServiceRecordCard
            orgName={orgName}
            brandColor={brandColor}
            baseUrl={baseUrl}
            initialToken={existingCredential?.publicToken ?? null}
            issue={issueAction}
            publish={publishAction}
            unpublish={unpublishAction}
            walletEnabled={walletEnabled}
            issueWalletPass={issueWalletPassAction}
          />
        </section>
      </div>
    </>
  );
}
