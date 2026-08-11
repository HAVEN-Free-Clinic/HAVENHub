import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import {
  getPerson,
  updatePerson,
  setPersonStatus,
  PersonConflictError,
  PersonNotFoundError,
} from "@/modules/admin/services/people";
import { PersonForm } from "@/modules/admin/components/person-form";
import { PageHeader } from "@/platform/ui/page-header";
import { Badge } from "@/platform/ui/badge";
import { can } from "@/platform/rbac/engine";
import { assertNotLastActiveAdminTx, LastAdminError } from "@/platform/rbac/last-admin";
import { PersonMembershipsPanel } from "@/modules/admin/components/person-memberships-panel";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { SectionHeader } from "@/platform/ui/section-header";
import { getApplicantHistory } from "@/modules/recruitment/services/history";
import { ApplicantHistory } from "@/modules/recruitment/components/applicant-history";
import { PhotoError, removePhoto, setPhotoFromUpload } from "@/platform/photos";
import { PhotoCard } from "@/modules/my-info/components/photo-card";
import { getSetting } from "@/platform/settings/service";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function PersonDetailPage({ params }: PageProps) {
  const session = await requirePermission("admin.manage_people");
  const { id } = await params;

  const person = await getPerson(id);
  if (!person) notFound();

  const canManageRoster = await can(session.personId, "admin.manage_roster");
  const maxMb = await getSetting<number>("uploads.maxMb");

  // Reuses the same reviewer-facing card from the application detail page (see
  // ApplicantHistory in the recruitment module), matched by netId/email/personId
  // the same way that page does. `.filter(Boolean)` alone would not narrow
  // `contactEmail`'s `string | null` for TS, hence the explicit predicate.
  const history = await getApplicantHistory({
    netId: person.netId,
    emails: [person.contactEmail].filter((e): e is string => Boolean(e)),
    personId: person.id,
  });

  async function updateAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    try {
      await updatePerson(actorSession.personId, id, {
        name: (formData.get("name") as string) ?? "",
        netId: (formData.get("netId") as string) || null,
        contactEmail: (formData.get("contactEmail") as string) || null,
        phone: (formData.get("phone") as string) || null,
        epicId: (formData.get("epicId") as string) || null,
        yaleAffiliation: (formData.get("yaleAffiliation") as string) || null,
        gradYear: (formData.get("gradYear") as string) || null,
        spanishSelfReported: formData.get("spanishSelfReported") === "on",
        spanishVerified: formData.get("spanishVerified") === "on",
        licensedRN: formData.get("licensedRN") === "on",
      });
    } catch (err) {
      if (err instanceof PersonConflictError) {
        redirect(
          `/admin/people/${id}?error=${encodeURIComponent(`${err.field} already belongs to another person`)}`
        );
      }
      throw err;
    }
    redirect(`/admin/people/${id}?saved=1`);
  }

  // The target person id comes from `id`, closed over from the route param
  // above (`params` on this dynamic segment), never read out of the
  // submitted FormData. Both actions necessarily operate on someone OTHER
  // than the signed-in admin -- unlike my-info's photo actions, which derive
  // the person solely from the caller's own session and so can never be
  // aimed elsewhere -- so which id they act on matters: a form field named
  // e.g. "personId" could be forged by any client to retarget the action at
  // an arbitrary person. Closing over the server-rendered route param instead
  // means the target is fixed by which page rendered the form, not by
  // anything the submitted request supplies.
  async function photoUploadAction(formData: FormData) {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/admin/people/${id}?photoError=Choose+an+image+file.`);
    }
    try {
      await setPhotoFromUpload(
        id,
        { type: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
        await getSetting<number>("uploads.maxMb"),
        // Actor is the ADMIN, not `id` (the target). Almost always
        // different, so this upload must not silently clear a suppression
        // the target person set for themselves -- see setPhotoFromUpload's
        // doc comment. If the admin happens to be viewing their own record,
        // actorSession.personId === id and it clears exactly as a self
        // upload would.
        actorSession.personId
      );
    } catch (err) {
      if (err instanceof PhotoError) {
        redirect(`/admin/people/${id}?photoError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/people/${id}?photoSaved=1`);
  }

  async function photoRemoveAction() {
    "use server";
    await requirePermission("admin.manage_people");
    await removePhoto(id);
    redirect(`/admin/people/${id}?photoRemoved=1`);
  }

  async function offboardAction() {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    try {
      // Refuse to offboard the last person who can reach the admin module; an
      // offboarded person can no longer authenticate. The guard runs INSIDE the
      // status-flip transaction (see setPersonStatusField) so the check and the
      // flip commit atomically; a bare pre-check would let two concurrent offboards
      // both pass and lock everyone out (write skew).
      await setPersonStatus(actorSession.personId, id, "OFFBOARDED", {
        assertInvariant: (tx) => assertNotLastActiveAdminTx(tx, id),
      });
    } catch (err) {
      if (err instanceof PersonNotFoundError) notFound();
      if (err instanceof LastAdminError) {
        redirect(`/admin/people/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/admin/people/${id}`);
  }

  async function reactivateAction() {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    try {
      await setPersonStatus(actorSession.personId, id, "ACTIVE");
    } catch (err) {
      if (err instanceof PersonNotFoundError) notFound();
      throw err;
    }
    redirect(`/admin/people/${id}`);
  }

  const description = [person.netId ? `NetID ${person.netId}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-10">
      <PageHeader
        title={person.name}
        description={description}
        action={
          person.status === "ACTIVE" ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="default">Offboarded</Badge>
          )
        }
      />

      {/* Photo */}
      <section>
        <SectionHeader className="mb-4">Photo</SectionHeader>
        <PhotoCard
          person={{
            id: person.id,
            name: person.name,
            photoVersion: person.photoVersion,
            photoKey: person.photoKey,
          }}
          photoSource={person.photoSource}
          maxMb={maxMb}
          uploadAction={photoUploadAction}
          removeAction={photoRemoveAction}
          audience="admin"
        />
      </section>

      {/* Edit form */}
      <section>
        <SectionHeader className="mb-4">Details</SectionHeader>
        <PersonForm
          action={updateAction}
          person={person}
        />
      </section>

      <PersonMembershipsPanel
        personId={id}
        canManage={canManageRoster}
        baseHref={`/admin/people/${id}`}
      />

      <ApplicantHistory history={history} title="Recruitment history" />

      {/* Status section */}
      <section>
        <SectionHeader className="mb-4">Status</SectionHeader>
        {person.status === "ACTIVE" ? (
          <form action={offboardAction}>
            <p className="mb-3 text-sm text-muted-foreground">
              Offboarding removes this person from active access and ends all of
              their active memberships, so they no longer appear on any roster.
              Their membership history is preserved.
            </p>
            <ConfirmButton
              label="Offboard"
              confirmLabel="Offboard? This ends all their active memberships."
            />
          </form>
        ) : (
          <form action={reactivateAction}>
            <p className="mb-3 text-sm text-muted-foreground">
              Reactivating this person restores their ACTIVE status.
            </p>
            <ConfirmButton label="Reactivate" confirmLabel="Confirm reactivation?" />
          </form>
        )}
      </section>
    </div>
  );
}
