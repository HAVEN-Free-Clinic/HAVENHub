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
import { LastLoginPanel } from "@/modules/admin/components/last-login-panel";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { getApplicantHistory } from "@/modules/recruitment/services/history";
import { ApplicantHistory } from "@/modules/recruitment/components/applicant-history";
import { PhotoError, removePhoto, setPhotoFromUpload } from "@/platform/photos";
import { PhotoCard } from "@/modules/my-info/components/photo-card";
import { getSetting } from "@/platform/settings/service";
import { getRehireFlag, setDoNotRehire } from "@/modules/incidents/services/disciplinary";
import {
  getCredential,
  revokeServiceCredential,
  restoreServiceCredential,
} from "@/modules/passport/services/credential";
import { Alert } from "@/platform/ui/alert";
import { Field, Input } from "@/platform/ui/input";
import { DateOnly } from "@/platform/dates/display";

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

  // Separate permission from the rest of this page on purpose: see the section's
  // comment below. The service re-checks it, so this only decides whether the
  // controls render rather than being the security boundary.
  const canSetRehireFlag = await can(session.personId, "incidents.manage");
  const rehireFlag = await getRehireFlag(id);

  // Null for most people: a credential exists only once the member has issued
  // one from /my-info, so the section below renders nothing rather than offering
  // a control over something that does not exist.
  const credential = await getCredential(id);

  // Resolved here rather than inside LastLoginPanel: that component stays
  // synchronous so it can be tested with renderToStaticMarkup, and the zone
  // lookup is async. getDisplayTimeZone is request-cached, so this is free.
  const timeZone = await getDisplayTimeZone();

  // Reuses the same reviewer-facing card from the application detail page (see
  // ApplicantHistory in the recruitment module), matched by netId/email/personId
  // the same way that page does. `.filter(Boolean)` alone would not narrow
  // `contactEmail`'s `string | null` for TS, hence the explicit predicate.
  const history = await getApplicantHistory({
    netId: person.netId,
    emails: [person.contactEmail].filter((e): e is string => Boolean(e)),
    personId: person.id,
  });

  // Both actions re-require incidents.manage rather than the page's
  // admin.manage_people: a server action is a public endpoint in its own right,
  // and the page gate above does not protect it from being invoked directly.
  async function setRehireFlagAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("incidents.manage");
    await setDoNotRehire(actor.personId, id, {
      doNotRehire: true,
      note: String(formData.get("note") ?? ""),
    });
    redirect(`/admin/people/${id}`);
  }

  async function clearRehireFlagAction() {
    "use server";
    const actor = await requirePermission("incidents.manage");
    await setDoNotRehire(actor.personId, id, { doNotRehire: false });
    redirect(`/admin/people/${id}`);
  }

  /**
   * Retract this person's public service credential: the public page 404s, the
   * QR on any wallet badge stops resolving, and the photo route stops serving.
   *
   * Both actions re-check admin.manage_people at the door rather than trusting
   * the page's guard, matching every other action here, and revokeServiceCredential
   * checks it a third time in the service. Restoring is a separate decision, not
   * an undo: the token is kept through a revoke precisely so a restore returns
   * the SAME URL rather than silently minting a new one.
   */
  async function revokeCredentialAction() {
    "use server";
    const actor = await requirePermission("admin.manage_people");
    await revokeServiceCredential(actor.personId, id);
    redirect(`/admin/people/${id}`);
  }

  async function restoreCredentialAction() {
    "use server";
    const actor = await requirePermission("admin.manage_people");
    await restoreServiceCredential(actor.personId, id);
    redirect(`/admin/people/${id}`);
  }

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
        licensedRN: formData.get("licensedRN") === "on",
        blockerGateExempt: formData.get("blockerGateExempt") === "on",
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

      {/* Do-not-rehire. Gated on incidents.manage, NOT the admin.manage_people
          that guards the rest of this page: deciding the clinic would not take
          someone back is an incidents judgment, and the people who administer
          records are not necessarily the people who make it. */}
      {canSetRehireFlag && (
        <section>
          <SectionHeader className="mb-4">Rehire eligibility</SectionHeader>
          {rehireFlag.doNotRehire ? (
            <div className="space-y-3">
              <Alert tone="warning">
                <p className="font-medium">Flagged do-not-rehire.</p>
                {rehireFlag.note && <p className="mt-1">{rehireFlag.note}</p>}
                <p className="mt-1 text-xs">
                  Set by {rehireFlag.setByName ?? "an unknown reviewer"}
                  {rehireFlag.setAt ? <> on <DateOnly value={rehireFlag.setAt} /></> : null}.
                </p>
              </Alert>
              <p className="text-sm text-muted-foreground">
                Recruitment reviewers see this if they apply again. It does not reject or hide
                an application on its own.
              </p>
              <form action={clearRehireFlagAction}>
                <ConfirmButton label="Clear flag" confirmLabel="Clear the do-not-rehire flag?" />
              </form>
            </div>
          ) : (
            <form action={setRehireFlagAction} className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Flags this person for the recruitment team&apos;s attention if they apply again.
                Advisory only: it never rejects, filters, or hides an application, and the
                applicant is not told it exists.
              </p>
              <Field label="Reason" hint="Shown to recruitment reviewers. Optional but strongly recommended.">
                <Input name="note" />
              </Field>
              <ConfirmButton label="Flag do-not-rehire" confirmLabel="Flag this person do-not-rehire?" />
            </form>
          )}
        </section>
      )}

      {/* Service credential. Rendered only when one exists: a member issues
          their own from /my-info, so for most people there is nothing to
          retract and an always-on control would imply otherwise.

          Gated by this page's own admin.manage_people, which is the permission
          revokeServiceCredential itself checks. Until now that retraction path
          existed in the service layer with no caller, so an offboarded member's
          public credential page could not actually be taken down (audit 14). */}
      {credential && (
        <section>
          <SectionHeader className="mb-4">Service credential</SectionHeader>
          {credential.revokedAt ? (
            <div className="space-y-3">
              <Alert tone="warning">
                <p className="font-medium">Revoked.</p>
                <p className="mt-1 text-xs">
                  Retracted on <DateOnly value={new Date(credential.revokedAt)} />.
                </p>
              </Alert>
              <p className="text-sm text-muted-foreground">
                The public page returns 404, the QR on any wallet badge does not resolve, and the
                photo route serves nothing. Restoring brings back the same URL, not a new one.
              </p>
              <form action={restoreCredentialAction}>
                <ConfirmButton label="Restore credential" confirmLabel="Restore this credential?" />
              </form>
            </div>
          ) : (
            <form action={revokeCredentialAction} className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Issued on <DateOnly value={new Date(credential.issuedAt)} />
                {credential.publicToken ? " and published publicly." : " but never published."} Revoking
                makes the public page 404 and stops any wallet badge&apos;s QR from resolving. The
                record is kept, so this can be undone.
              </p>
              <ConfirmButton
                label="Revoke credential"
                confirmLabel="Revoke this person's credential?"
              />
            </form>
          )}
        </section>
      )}

      {/* Admin-only. This page already requires admin.manage_people, so the
          gating is inherited. Nothing here is shown to the member themselves or
          to department directors. */}
      <section>
        <SectionHeader className="mb-4">Sign-in activity</SectionHeader>
        <LastLoginPanel person={person} timeZone={timeZone} />
      </section>
    </div>
  );
}
