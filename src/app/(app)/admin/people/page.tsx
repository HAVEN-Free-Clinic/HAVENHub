import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { searchPeople } from "@/modules/admin/services/people";
import { prisma } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { PeopleTable } from "@/modules/admin/components/people-table";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button, buttonClasses } from "@/platform/ui/button";

type PageProps = {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
};

export default async function PeopleListPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_people");

  const { q, status, page: pageStr } = await searchParams;

  // Distinguish "no param at all" (first load, default to ACTIVE) from
  // "param present but empty" (user explicitly chose All statuses).
  const statusFilter: "ACTIVE" | "OFFBOARDED" | undefined =
    status === undefined
      ? "ACTIVE" // first load default
      : status === "OFFBOARDED"
        ? "OFFBOARDED"
        : status === "ACTIVE"
          ? "ACTIVE"
          : undefined; // status === "" -> all statuses
  const pageNum = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);

  // Get the active term so we can show membership counts.
  const activeTerm = await getActiveTerm();

  const { rows, total, page, pageCount } = await searchPeople({
    search: q?.trim() || undefined,
    status: statusFilter,
    page: pageNum,
    pageSize: 25,
  });

  // Fetch membership counts for the active term for each row's person.
  let membershipCountMap: Map<string, number> = new Map();
  if (activeTerm && rows.length > 0) {
    const personIds = rows.map((r) => r.id);
    const counts = await prisma.termMembership.groupBy({
      by: ["personId"],
      where: {
        personId: { in: personIds },
        termId: activeTerm.id,
        status: "ACTIVE",
      },
      _count: { id: true },
    });
    membershipCountMap = new Map(counts.map((c) => [c.personId, c._count.id]));
  }

  const rowsWithCounts = rows.map((r) => ({
    ...r,
    _membershipCount: membershipCountMap.get(r.id) ?? 0,
  }));

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    // Preserve explicit empty status (All statuses) in pagination links.
    if (status !== undefined) params.set("status", status);
    params.set("page", String(p));
    return `/admin/people?${params.toString()}`;
  }

  const effectiveStatus = status ?? "ACTIVE";

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description={
          effectiveStatus === ""
            ? `${total.toLocaleString()} people`
            : `${total.toLocaleString()} ${effectiveStatus === "OFFBOARDED" ? "offboarded" : "active"} people`
        }
        action={
          <Link href="/admin/people/new" className={buttonClasses("primary", "sm")}>
            Add person
          </Link>
        }
      />

      {/* Search form (GET) */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <Input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search name, NetID, or email..."
            aria-label="Search people"
          />
        </div>
        <div className="w-44">
          <Select
            name="status"
            defaultValue={effectiveStatus}
            aria-label="Filter by status"
          >
            <option value="ACTIVE">Active</option>
            <option value="OFFBOARDED">Offboarded</option>
            <option value="">All statuses</option>
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>

      <PeopleTable rows={rowsWithCounts} />

      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
