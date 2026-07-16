/**
 * Shift-request approvals page.
 *
 * A dedicated approve/deny surface for everyone with request authority, most
 * importantly schedule.manage_requests holders who are NOT builders. They are
 * emailed and reminded to decide requests, but the only other approve/deny UI
 * lives inside the Builder, which redirects non-builders to /no-access. This page
 * gates on request authority (manageableRequestDepartmentIds), not on being a
 * builder, so the notification actually leads somewhere.
 */

import { redirect } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { runAction } from "@/platform/actions";
import {
  manageableRequestDepartmentIds,
  listDepartmentRequests,
  approveRequest,
  denyRequest,
  RequestForbiddenError,
  RequestNotFoundError,
  RequestValidationError,
} from "@/modules/schedule/services/requests";
import { PendingRequests } from "@/modules/schedule/components/pending-requests";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Alert } from "@/platform/ui/alert";

type PageProps = { searchParams: Promise<{ error?: string; message?: string }> };

export default async function ScheduleRequestsPage({ searchParams }: PageProps) {
  const session = await requirePersonSession();
  const deptIds = await manageableRequestDepartmentIds(session.personId);
  if (deptIds.length === 0) redirect("/no-access");
  const sp = await searchParams;

  const depts = await prisma.department.findMany({
    where: { id: { in: deptIds } },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const perDept = await Promise.all(
    depts.map(async (dept) => ({ dept, rows: await listDepartmentRequests(session.personId, dept.id) })),
  );
  const withRows = perDept.filter((p) => p.rows.length > 0);

  async function approveRequestAction(formData: FormData) {
    "use server";
    const actor = await requirePersonSession();
    const requestId = (formData.get("requestId") as string) ?? "";
    await runAction({
      work: () => approveRequest(actor.personId, requestId),
      domainErrors: [RequestValidationError, RequestForbiddenError, RequestNotFoundError],
      errorRedirect: (message) => `/schedule/requests?error=validation&message=${encodeURIComponent(message)}`,
      revalidate: "/schedule/requests",
      successRedirect: "/schedule/requests",
    });
  }

  async function denyRequestAction(formData: FormData) {
    "use server";
    const actor = await requirePersonSession();
    const requestId = (formData.get("requestId") as string) ?? "";
    const note = ((formData.get("denyNote") as string) ?? "").trim() || undefined;
    await runAction({
      work: () => denyRequest(actor.personId, requestId, note),
      domainErrors: [RequestValidationError, RequestForbiddenError, RequestNotFoundError],
      errorRedirect: (message) => `/schedule/requests?error=validation&message=${encodeURIComponent(message)}`,
      revalidate: "/schedule/requests",
      successRedirect: "/schedule/requests",
    });
  }

  const errorMessage = sp.error ? (sp.error === "validation" && sp.message ? sp.message : sp.error) : null;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Shift request approvals" description="Approve or deny drop and swap requests for your departments." />
      {errorMessage && <Alert tone="error">{errorMessage}</Alert>}
      {withRows.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">No shift requests right now.</p>
        </Card>
      ) : (
        withRows.map(({ dept, rows }) => (
          <section key={dept.id} className="space-y-3">
            <SectionHeader>{dept.code} &middot; {dept.name}</SectionHeader>
            <PendingRequests rows={rows} approveAction={approveRequestAction} denyAction={denyRequestAction} />
          </section>
        ))
      )}
    </div>
  );
}
