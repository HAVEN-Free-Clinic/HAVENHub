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
import { getActiveTerm } from "@/platform/terms/active-term";
import { getNextTerm } from "@/platform/terms/next-term";
import { displayTodayKey } from "@/platform/dates/today";
import { PendingRequests } from "@/modules/schedule/components/pending-requests";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";

type PageProps = { searchParams: Promise<{ error?: string; message?: string }> };

export default async function ScheduleRequestsPage({ searchParams }: PageProps) {
  const session = await requirePersonSession();
  const deptIds = await manageableRequestDepartmentIds(session.personId);
  if (deptIds.length === 0) redirect("/no-access");
  const sp = await searchParams;
  // Resolved once for the page; PendingRequests uses it to mark stale
  // (past-date) rows across every department section below.
  const todayKey = await displayTodayKey();

  const depts = await prisma.department.findMany({
    where: { id: { in: deptIds } },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  // Span the working set: the live term plus a next (PLANNING) term being
  // prepared. createRequest lets a member raise a drop/swap against a published
  // next term, and the reminder cron emails approvers about it, but this page
  // used to pin to the live term only, so those requests appeared nowhere an
  // approver could act. One group per (term, department), live term first.
  const [liveTerm, nextTerm] = await Promise.all([getActiveTerm(), getNextTerm()]);
  const terms = [
    ...(liveTerm ? [{ term: liveTerm, isLive: true }] : []),
    ...(nextTerm ? [{ term: nextTerm, isLive: false }] : []),
  ];
  const groups = (
    await Promise.all(
      terms.map(async ({ term, isLive }) => {
        const perDept = await Promise.all(
          depts.map(async (dept) => ({
            dept,
            rows: await listDepartmentRequests(session.personId, dept.id, term.id),
          })),
        );
        return { term, isLive, perDept: perDept.filter((p) => p.rows.length > 0) };
      }),
    )
  ).filter((g) => g.perDept.length > 0);
  // Suppress the term heading in the common single-term case so an approver with
  // only live-term requests sees exactly the layout they saw before.
  const showTermHeadings = groups.length > 1;

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
      {groups.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">No shift requests right now.</p>
        </Card>
      ) : (
        groups.map(({ term, isLive, perDept }) => (
          <div key={term.id} className="space-y-6">
            {showTermHeadings && (
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight text-foreground">{term.name}</h2>
                <Badge tone={isLive ? "brand" : "default"}>{isLive ? "Live" : "Next term"}</Badge>
              </div>
            )}
            {perDept.map(({ dept, rows }) => (
              <section key={dept.id} className="space-y-3">
                <SectionHeader>{dept.code} &middot; {dept.name}</SectionHeader>
                <PendingRequests rows={rows} approveAction={approveRequestAction} denyAction={denyRequestAction} todayKey={todayKey} />
              </section>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
