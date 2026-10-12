import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { getSubcommittee } from "@/modules/admin/services/subcommittees";
import { listMembers } from "@/modules/admin/services/subcommittee-members";
import { canManageSubcommittee } from "@/modules/admin/services/subcommittee-lead-access";
import { PageHeader } from "@/platform/ui/page-header";
import { SetBreadcrumbLeaf } from "@/platform/ui/breadcrumb-context";
import { SectionHeader } from "@/platform/ui/section-header";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { EmptyState } from "@/platform/ui/empty-state";
import { AddMembersForm } from "@/app/(app)/recruitment/subcommittees/[id]/add-members-form";
import { leadAddMembersAction, leadSetRoleAction, leadRemoveMemberAction } from "./actions";

const SOURCE_LABELS = { IMPORT: "Added from list", SIGNUP: "Signed up", STAFF: "Added by staff" } as const;

type PageProps = { params: Promise<{ id: string }> };

/**
 * A subcommittee lead's view of their own subcommittee: the member list with
 * add, make lead/member, and remove. Under My Info, not Recruitment, so leads
 * need no recruitment access. Anyone who does not lead it gets a 404, the same
 * answer as for a subcommittee that does not exist.
 */
export default async function LeadSubcommitteePage({ params }: PageProps) {
  const person = await requireModuleAccess("my-info");
  const { id } = await params;
  if (!(await canManageSubcommittee(person.personId, id))) notFound();

  const subcommittee = await getSubcommittee(id);
  if (!subcommittee) notFound();
  const members = await listMembers(id);
  const memberCount = members.filter((m) => m.role === "MEMBER").length;
  const leadCount = members.length - memberCount;

  const boundAdd = leadAddMembersAction.bind(null, id);
  const boundSetRole = leadSetRoleAction.bind(null, id);
  const boundRemove = leadRemoveMemberAction.bind(null, id);

  return (
    <div className="space-y-8">
      <SetBreadcrumbLeaf label={subcommittee.name} />
      <PageHeader
        title={subcommittee.name}
        description="Add people, choose who leads, and remove anyone who has left."
      />

      <section id="members" className="space-y-4">
        <div>
          <SectionHeader level="title">Members</SectionHeader>
          <p className="mt-1 text-sm text-muted-foreground">
            {leadCount} {leadCount === 1 ? "lead" : "leads"}, {memberCount}{" "}
            {memberCount === 1 ? "member" : "members"}
            {subcommittee.capacity !== null ? ` of ${subcommittee.capacity}` : ""}. Sign-up and
            capacity are set by HAVEN IT.
          </p>
        </div>
        <AddMembersForm action={boundAdd} />
        {members.length === 0 ? (
          <EmptyState inline>Nobody yet.</EmptyState>
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
                    {m.otherSubcommittees.length > 0 && (
                      <div className="text-xs font-medium text-warning-foreground">
                        Also on {m.otherSubcommittees.join(", ")}
                      </div>
                    )}
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