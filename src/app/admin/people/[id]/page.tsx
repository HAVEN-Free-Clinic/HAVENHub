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
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
};

export default async function PersonDetailPage({ params, searchParams }: PageProps) {
  await requirePermission("admin.manage_people");
  const { id } = await params;
  const { error, saved } = await searchParams;

  const person = await getPerson(id);
  if (!person) notFound();

  const airtableLinked = !!person.airtableRecordId;

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

  async function offboardAction() {
    "use server";
    const actorSession = await requirePermission("admin.manage_people");
    try {
      await setPersonStatus(actorSession.personId, id, "OFFBOARDED");
    } catch (err) {
      if (err instanceof PersonNotFoundError) notFound();
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

  const description = [
    person.netId ? `NetID ${person.netId}` : null,
    airtableLinked ? "Linked to Airtable" : "Not linked to Airtable",
  ]
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

      {/* Edit form */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Details
        </h2>
        <PersonForm
          action={updateAction}
          person={person}
          error={error}
          saved={saved === "1" ? "Saved." : undefined}
        />
      </section>

      {/* Memberships table */}
      {person.memberships.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Memberships
          </h2>
          <Table>
            <THead>
              <TR>
                <TH>Term</TH>
                <TH>Department</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <tbody>
              {person.memberships.map((m) => (
                <TR key={m.id}>
                  <TD>{m.term.code}</TD>
                  <TD>{m.department.code}</TD>
                  <TD>
                    {m.kind === "DIRECTOR" ? (
                      <Badge tone="brand">Director</Badge>
                    ) : (
                      <Badge tone="default">Volunteer</Badge>
                    )}
                  </TD>
                  <TD>
                    {m.status === "ACTIVE" ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="default">Removed</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {/* Status section */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Status
        </h2>
        {person.status === "ACTIVE" ? (
          <form action={offboardAction}>
            <p className="mb-3 text-sm text-slate-500">
              Offboarding removes this person from active access. Their data and
              membership history are preserved. Status is not mirrored to Airtable
              (the volunteer offboarding flow belongs to the Volunteers module).
            </p>
            <ConfirmButton label="Offboard" confirmLabel="Confirm offboard?" />
          </form>
        ) : (
          <form action={reactivateAction}>
            <p className="mb-3 text-sm text-slate-500">
              Reactivating this person restores their ACTIVE status.
            </p>
            <ConfirmButton label="Reactivate" confirmLabel="Confirm reactivation?" />
          </form>
        )}
      </section>
    </div>
  );
}
