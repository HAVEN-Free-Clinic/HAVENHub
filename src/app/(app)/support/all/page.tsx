/**
 * All requests: manager-only master list across every requester.
 *
 * Gated on support.manage_requests via requirePermission (defense in depth --
 * listAllRequests enforces the same permission internally and throws
 * SupportForbiddenError, but gating here first gives the correct /no-access
 * redirect instead of a thrown error reaching the page).
 *
 * Filters come from the query string (?status=&category=&priority=&assignee=&q=&page=)
 * so the view is shareable and survives a refresh; RequestFilters (a client
 * component) owns writing to it. Enum filters are validated against the
 * known enum values here rather than cast blindly, so a stray/garbage query
 * param is dropped instead of passed through to Prisma.
 */

import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { listAllRequests, PAGE_SIZE, MANAGE } from "@/modules/support/services/tech-request";
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
  const session = await requirePermission("support.manage_requests");
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
        // "inbox": managers work tickets in Intercom's agent inbox, so a
        // linked row deep-links there instead of opening the Messenger.
        intercomAction={isIntercomConfigured() ? "inbox" : undefined}
      />
      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
