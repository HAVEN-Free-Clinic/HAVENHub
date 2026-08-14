/**
 * All requests: the master list across every requester.
 *
 * Gated on support.manage_requests OR support.view_all_requests via
 * requireAnyPermission (defense in depth -- listAllRequests enforces the same
 * pair internally and throws SupportForbiddenError, but gating here first gives
 * the correct /no-access redirect instead of a thrown error reaching the page).
 *
 * The two audiences see the SAME list. Nothing on this page mutates a ticket:
 * the read-only distinction bites one level down, on the ticket detail page,
 * where an auditor loses the manager controls and the correspondence.
 *
 * Filters come from the query string (?status=&category=&priority=&assignee=&q=&page=)
 * so the view is shareable and survives a refresh; RequestFilters (a client
 * component) owns writing to it. Enum filters are validated against the
 * known enum values here rather than cast blindly, so a stray/garbage query
 * param is dropped instead of passed through to Prisma.
 */

import { requireAnyPermission } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { loadClearedSet } from "@/platform/clearance";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { listAllRequests, PAGE_SIZE, MANAGE, VIEW_ALL } from "@/modules/support/services/tech-request";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { RequestList } from "@/modules/support/components/request-list";
import { RequestFilters } from "@/modules/support/components/request-filters";
import { ALL_STATUSES, ALL_CATEGORIES, ALL_PRIORITIES } from "@/modules/support/filter-options";
import type { TechRequestStatus, TechRequestCategory, TechRequestPriority } from "@prisma/client";

type PageProps = {
  searchParams: Promise<{
    status?: string;
    category?: string;
    priority?: string;
    assignee?: string;
    q?: string;
    page?: string;
  }>;
};

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function AllRequestsPage({ searchParams }: PageProps) {
  const session = await requireAnyPermission([MANAGE, VIEW_ALL]);
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const [{ rows, total, counts }, assignees] = await Promise.all([
    listAllRequests(session.personId, {
      status: pick<TechRequestStatus>(sp.status, ALL_STATUSES),
      category: pick<TechRequestCategory>(sp.category, ALL_CATEGORIES),
      priority: pick<TechRequestPriority>(sp.priority, ALL_PRIORITIES),
      assignedToId: sp.assignee?.trim() || undefined,
      q: sp.q,
      page,
    }),
    peopleWithAnyPermission([MANAGE]),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Verified badges on the requester column. Gated on volunteers.view (the
  // permission that opens the compliance roster) rather than on
  // support.manage_requests: a ticket manager is not automatically entitled to
  // read anyone's clearance. Skipped entirely otherwise, so it costs nothing.
  const canSeeClearance = await can(session.personId, "volunteers.view");
  const clearedPersonIds = [
    ...(await loadClearedSet(canSeeClearance ? rows.map((r) => r.requester.id) : [])),
  ];

  function hrefFor(targetPage: number): string {
    const params = new URLSearchParams();
    if (sp.status) params.set("status", sp.status);
    if (sp.category) params.set("category", sp.category);
    if (sp.priority) params.set("priority", sp.priority);
    if (sp.assignee) params.set("assignee", sp.assignee);
    if (sp.q) params.set("q", sp.q);
    params.set("page", String(targetPage));
    return `/support/all?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="All requests" description="Every IT Support request across the clinic." />
      <RequestFilters
        counts={counts}
        total={total}
        assignees={assignees.map((a) => ({ id: a.id, name: a.name }))}
      />
      <RequestList
        rows={rows}
        hrefBase="/support"
        showRequester
        clearedPersonIds={clearedPersonIds}
        // "inbox": managers work tickets in Intercom's agent inbox, so a
        // linked row deep-links there instead of opening the Messenger.
        intercomAction={isIntercomConfigured() ? "inbox" : undefined}
      />
      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
