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
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import {
  canManageAttendingRequests,
  listAttendingRequests,
  approveAttendingRequest,
  denyAttendingRequest,
  AttendingPortalForbiddenError,
  AttendingPortalNotFoundError,
  AttendingPortalValidationError,
} from "@/modules/schedule/services/attending-portal";
import { PendingRequests } from "@/modules/schedule/components/pending-requests";
import { AttendingPendingRequests } from "@/modules/schedule/components/attending-pending-requests";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Badge } from "@/platform/ui/badge";
import { EmptyState } from "@/platform/ui/empty-state";

export default async function ScheduleRequestsPage() {
  const session = await requirePersonSession();
  // Two independent authorities land on this page, and holding EITHER admits you.
  // Faculty Relations approves attending requests but manages no department, so
  // gating on manageableRequestDepartmentIds alone bounced the very person the
  // attending-request emails point here. Each section below still renders only
  // for the authority that owns it.
  const [deptIds, managesAttendings] = await Promise.all([
    manageableRequestDepartmentIds(session.personId),
    canManageAttendingRequests(session.personId),
  ]);
  if (deptIds.length === 0 && !managesAttendings) redirect("/no-access");
  // Resolved once for the page; PendingRequests uses todayKey to mark stale
  // (past-date) rows across every department section below, and timeZone to
  // render the decision timestamps in the decided list.
  const [todayKey, timeZone] = await Promise.all([displayTodayKey(), getDisplayTimeZone()]);

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

  // Attending requests are clinic-wide and live-term only: there is no department
  // to scope them by, and Faculty Relations builds one grid at a time.
  const attendingRows = managesAttendings ? await listAttendingRequests(session.personId) : [];

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

  async function approveAttendingAction(formData: FormData) {
    "use server";
    const actor = await requirePersonSession();
    const requestId = (formData.get("requestId") as string) ?? "";
    await runAction({
      work: () => approveAttendingRequest(actor.personId, requestId),
      domainErrors: [AttendingPortalValidationError, AttendingPortalForbiddenError, AttendingPortalNotFoundError],
      errorRedirect: (message) => `/schedule/requests?error=validation&message=${encodeURIComponent(message)}`,
      revalidate: "/schedule/requests",
      successRedirect: "/schedule/requests",
    });
  }

  async function denyAttendingAction(formData: FormData) {
    "use server";
    const actor = await requirePersonSession();
    const requestId = (formData.get("requestId") as string) ?? "";
    await runAction({
      work: () => denyAttendingRequest(actor.personId, requestId),
      domainErrors: [AttendingPortalValidationError, AttendingPortalForbiddenError, AttendingPortalNotFoundError],
      errorRedirect: (message) => `/schedule/requests?error=validation&message=${encodeURIComponent(message)}`,
      revalidate: "/schedule/requests",
      successRedirect: "/schedule/requests",
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Shift request approvals"
        description={
          managesAttendings && deptIds.length > 0
            ? "Approve or deny drop and swap requests for your departments and for the attending schedule."
            : managesAttendings
              ? "Approve or deny drop and swap requests from attendings."
              : "Approve or deny drop and swap requests for your departments."
        }
      />

      {/* Attending requests first for a Faculty-Relations-only viewer, since it is
          the only section they have. It stays above the department groups for a
          viewer holding both: the attending grid is clinic-wide, so it is the
          wider of the two. */}
      {managesAttendings && (
        <AttendingPendingRequests
          rows={attendingRows}
          approveAction={approveAttendingAction}
          denyAction={denyAttendingAction}
          todayKey={todayKey}
          timeZone={timeZone}
        />
      )}

      {groups.length === 0 ? (
        // Suppressed for a Faculty-Relations-only viewer: their section above has
        // its own empty state, and a second "no requests" card under it reads as
        // a bug.
        deptIds.length === 0 ? null : (
          <Card>
            <EmptyState
              title="No shift requests right now"
              description="Swap and drop requests from your departments will appear here for approval."
            />
          </Card>
        )
      ) : (
        groups.map(({ term, isLive, perDept }) => (
          <div key={term.id} className="space-y-6">
            {showTermHeadings && (
              <div className="flex items-center gap-2">
                <SectionHeader as="h2" level="title" className="text-xl">{term.name}</SectionHeader>
                <Badge tone={isLive ? "brand" : "default"}>{isLive ? "Live" : "Next term"}</Badge>
              </div>
            )}
            {perDept.map(({ dept, rows }) => (
              <section key={dept.id} className="space-y-3">
                <SectionHeader>{dept.code} &middot; {dept.name}</SectionHeader>
                <PendingRequests rows={rows} approveAction={approveRequestAction} denyAction={denyRequestAction} todayKey={todayKey} timeZone={timeZone} />
              </section>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
