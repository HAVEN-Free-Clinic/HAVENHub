import { requirePermission } from "@/platform/auth/session";
import { queryAudit, distinctEntityTypes } from "@/modules/admin/services/audit";
import { AuditTable } from "@/modules/admin/components/audit-table";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { FilterBar, FilterField } from "@/platform/ui/filter-bar";

type PageProps = {
  searchParams: Promise<{ action?: string; entityType?: string; page?: string }>;
};

export default async function AuditPage({ searchParams }: PageProps) {
  await requirePermission("admin.view_audit");

  const { action, entityType, page: pageStr } = await searchParams;

  const pageNum = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);
  // One boolean for the Clear link and the empty state, so the log cannot offer
  // to clear a filter while claiming there is nothing to find.
  const filtered = Boolean(action || entityType);

  const [{ rows, total, page, pageCount }, entityTypes] = await Promise.all([
    queryAudit({
      action: action?.trim() || undefined,
      entityType: entityType?.trim() || undefined,
      page: pageNum,
    }),
    distinctEntityTypes(),
  ]);

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (entityType) params.set("entityType", entityType);
    params.set("page", String(p));
    return `/admin/audit?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      {/* The count moved out of the description and onto the filter row, beside
          the controls that change it -- the same move admin/people made. What
          is left here is what the page IS. */}
      <PageHeader
        title="Audit log"
        description="Every recorded change, newest first. Filter by action, actor or entity."
      />

      {/* Filter bar (GET form) */}
      <FilterBar
        clearHref={filtered ? "/admin/audit" : undefined}
        resultCount={{ total, noun: "entry", pluralNoun: "entries" }}
      >
        <FilterField label="Action" width="grow">
          <Input
            type="search"
            name="action"
            defaultValue={action ?? ""}
            placeholder="action contains..."
          />
        </FilterField>
        <FilterField label="Entity type">
          <Select name="entityType" defaultValue={entityType ?? ""}>
            <option value="">All types</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      <AuditTable rows={rows} filtered={filtered} />

      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
