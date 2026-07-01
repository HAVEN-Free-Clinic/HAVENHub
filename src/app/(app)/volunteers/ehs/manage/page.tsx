import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { Input } from "@/platform/ui/input";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { listTrainings } from "@/platform/ehs/services/trainings";
import { createTrainingAction } from "./actions";

export default async function ManageEhsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePermission("volunteers.manage_compliance");
  const trainings = await listTrainings();
  const sp = await searchParams;

  return (
    <>
      <PageHeader
        title="Manage EHS trainings"
        description="Add and edit EHS training requirements."
      />
      <div className="mt-6 max-w-2xl space-y-6">
        {sp.error && (
          <Alert tone="error">{decodeURIComponent(sp.error)}</Alert>
        )}
        <Card>
          <form action={createTrainingAction} className="flex gap-2">
            <Input name="name" placeholder="New EHS training name" required className="flex-1" />
            <Button type="submit">Create</Button>
          </form>
        </Card>
        <ul className="space-y-2">
          {trainings.map((t) => (
            <li key={t.id}>
              <Link href={`/volunteers/ehs/manage/${t.id}`} className="block">
                <Card interactive pad={false} className="flex items-center justify-between px-4 py-3">
                  <span>{t.name}</span>
                  {!t.isActive && (
                    <span className="text-xs text-muted-foreground">inactive</span>
                  )}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
