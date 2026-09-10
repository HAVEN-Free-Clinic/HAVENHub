import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { listTrainings } from "@/platform/ehs/services/trainings";
import { createTrainingAction } from "./actions";
import { Table, THead, TR, TH, TD, TableEmpty } from "@/platform/ui/table";
import { TextLink } from "@/platform/ui/text-link";
import { ActiveBadge } from "@/platform/ui/active-badge";
import { ListEmpty } from "@/platform/ui/list-empty";

export default async function ManageEhsPage() {
  await requirePermission("volunteers.manage_compliance");
  const trainings = await listTrainings();

  return (
    <>
      <PageHeader
        title="Manage trainings"
        description="Add, edit, and scope EHS training requirements."
      />
      <div className="mt-6 max-w-2xl space-y-6">
        <Card>
          <form action={createTrainingAction} className="flex gap-2">
            <Input name="name" placeholder="New EHS training name" required className="flex-1" />
            <Button type="submit">Create</Button>
          </form>
        </Card>
        <Table>
          <THead>
            <TR>
              <TH>Training</TH>
              <TH>Required for</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <tbody>
            {trainings.map((t) => (
              <TR key={t.id}>
                <TD>
                  <TextLink href={`/volunteers/ehs/manage/${t.id}`} className="font-medium">
                    {t.name}
                  </TextLink>
                </TD>
                <TD className="text-muted-foreground">
                  {t.requiredForAll
                    ? "All departments"
                    : `${t.departmentCount} department${t.departmentCount === 1 ? "" : "s"}`}
                </TD>
                <TD>
                  <ActiveBadge active={t.isActive} />
                </TD>
              </TR>
            ))}
            {trainings.length === 0 && (
              <TableEmpty colSpan={3}>
                <ListEmpty
                  filtered={false}
                  noun="EHS trainings"
                  emptyDescription="Create one using the form above."
                />
              </TableEmpty>
            )}
          </tbody>
        </Table>
      </div>
    </>
  );
}
