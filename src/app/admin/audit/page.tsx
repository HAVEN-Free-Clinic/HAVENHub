import { requirePermission } from "@/platform/auth/session";
import { queryAudit, distinctEntityTypes } from "@/modules/admin/services/audit";
import { AuditTable } from "@/modules/admin/components/audit-table";
import { PageHeader } from "@/platform/ui/page-header";
import { Pagination } from "@/platform/ui/pagination";
import { Input } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { Button } from "@/platform/ui/button";

type PageProps = {
  searchParams: Promise<{ action?: string; entityType?: string; page?: string }>;
};

export default async function AuditPage({ searchParams }: PageProps) {
  await requirePermission("admin.view_audit");

  const { action, entityType, page: pageStr } = await searchParams;

  const pageNum = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);

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
      <PageHeader
        title="Audit Log"
        description={`${total.toLocaleString()} ${total === 1 ? "entry" : "entries"}`}
      />

      {/* Filter bar (GET form) */}
      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-48">
          <Input
            name="action"
            defaultValue={action ?? ""}
            placeholder="action contains..."
            aria-label="Filter by action"
          />
        </div>
        <div className="w-44">
          <Select
            name="entityType"
            defaultValue={entityType ?? ""}
            aria-label="Filter by entity type"
          >
            <option value="">All types</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          Filter
        </Button>
      </form>

      <AuditTable rows={rows} />

      <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} />
    </div>
  );
}
