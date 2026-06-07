import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { searchPeople } from "@/modules/admin/services/people";
import { prisma } from "@/platform/db";
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

  const statusFilter =
    status === "OFFBOARDED" ? "OFFBOARDED" : status === "ACTIVE" ? "ACTIVE" : undefined;
  const pageNum = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);

  // Get the active term so we can show membership counts.
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });

  const { rows, total, page, pageCount } = await searchPeople({
    search: q?.trim() || undefined,
    // Default to ACTIVE when no filter is applied.
    status: statusFilter ?? "ACTIVE",
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
    if (status) params.set("status", status);
    params.set("page", String(p));
    return `/admin/people?${params.toString()}`;
  }

  const effectiveStatus = status ?? "ACTIVE";

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description={`${total.toLocaleString()} ${effectiveStatus === "OFFBOARDED" ? "offboarded" : effectiveStatus === "" ? "" : "active"} people`}
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
          />
        </div>
        <div className="w-44">
          <Select name="status" defaultValue={effectiveStatus}>
            <option value="ACTIVE">Active</option>
            <option value="OFFBOARDED">Offboarded</option>
            <option value="">All statuses</option>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <PeopleTable rows={rowsWithCounts} />

      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
