import { notFound, redirect } from "next/navigation";
import { ActiveBadge } from "@/platform/ui/active-badge";
import { requirePermission } from "@/platform/auth/session";
import {
  getSubcommittee, updateSubcommittee,
  SubcommitteeValidationError, SubcommitteeNotFoundError,
} from "@/modules/admin/services/subcommittees";
import { PageHeader } from "@/platform/ui/page-header";
import { SubcommitteeForm } from "@/modules/admin/components/subcommittee-form";
import { optionalInt } from "@/modules/admin/form-coerce";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { EmptyState } from "@/platform/ui/empty-state";
import { listMembers } from "@/modules/admin/services/subcommittee-members";
import { AddMembersForm } from "./add-members-form";
import { addMembersAction, setRoleAction, removeMemberAction } from "./actions";

const SOURCE_LABELS = { IMPORT: "Added from list", SIGNUP: "Signed up", STAFF: "Added by staff" } as const;

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditSubcommitteePage({ params }: PageProps) {
  await requirePermission("recruitment.manage_cycles");
  const { id } = await params;

  const subcommittee = await getSubcommittee(id);
  if (!subcommittee) notFound();
  const members = await listMembers(id);
  const memberCount = members.filter((m) => m.role === "MEMBER").length;
  const boundAdd = addMembersAction.bind(null, id);
  const boundSetRole = setRoleAction.bind(null, id);
  const boundRemove = removeMemberAction.bind(null, id);

  async function updateAction(formData: FormData) {
    "use server";
    const session = await requirePermission("recruitment.manage_cycles");
    try {
      await updateSubcommittee(session.personId, id, {
        name: String(formData.get("name") ?? ""),
        isActive: formData.get("isActive") === "on",
        order: optionalInt(formData.get("order")) ?? 0,
        description: String(formData.get("description") ?? ""),
        capacity: optionalInt(formData.get("capacity")),
        signupOpen: formData.get("signupOpen") === "on",
      });
    } catch (err) {
      if (err instanceof SubcommitteeValidationError || err instanceof SubcommitteeNotFoundError) {
        redirect(`/recruitment/subcommittees/${id}?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/recruitment/subcommittees/${id}?saved=1`);
  }

  return (
    <div className="space-y-8">
      <SetBreadcrumbLeaf label={subcommittee.name} />
      {/* The soft-remove note moved onto the Active checkbox itself, where the
          control it describes is. */}
      <PageHeader
        title={subcommittee.name}
        status={<ActiveBadge active={subcommittee.isActive} />}
      />
      <SubcommitteeForm action={updateAction} mode="edit" subcommittee={subcommittee} />

      <section id="members" className="space-y-4">
        <div>
          <SectionHeader level="title">Members</SectionHeader>
          <p className="mt-1 text-sm text-muted-foreground">
            {members.length - memberCount} {members.length - memberCount === 1 ? "lead" : "leads"},{" "}
            {memberCount} {memberCount === 1 ? "member" : "members"}
            {subcommittee.capacity !== null ? ` of ${subcommittee.capacity}` : ""}. Leads do not count
            toward capacity, and adding people here is never refused for a full subcommittee.
          </p>
        </div>
        <AddMembersForm action={boundAdd} />
        {members.length === 0 ? (
          <EmptyState inline>
            Nobody yet. Add the leads above, then open sign-up so volunteers can join.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>How</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <tbody>
              {members.map((m) => (
                <TR key={m.id}>
                  <TD>
                    <div className="font-medium text-foreground">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{m.email ?? m.netId ?? ""}</div>
                  </TD>
                  <TD>
                    {m.role === "LEAD" ? <Badge tone="brand">Lead</Badge> : <Badge tone="default">Member</Badge>}
                  </TD>
                  <TD className="text-muted-foreground">{SOURCE_LABELS[m.source]}</TD>
                  <TD>
                    <div className="flex flex-wrap justify-end gap-2">
                      <form action={boundSetRole}>
                        <input type="hidden" name="membershipId" value={m.id} />
                        <input type="hidden" name="role" value={m.role === "LEAD" ? "MEMBER" : "LEAD"} />
                        <Button type="submit" variant="outline" size="sm">
                          {m.role === "LEAD" ? "Make member" : "Make lead"}
                        </Button>
                      </form>
                      <form action={boundRemove}>
                        <input type="hidden" name="membershipId" value={m.id} />
                        <ConfirmButton size="sm" label="Remove" confirmLabel={`Remove ${m.name}?`} />
                      </form>
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
