/**
 * ITCM Epic Requests page.
 *
 * Two-tab layout:
 *   - Generate: form-driven PDF, spreadsheet, and email draft generator.
 *   - Tracker: table of all submitted Epic requests with ticket status,
 *     submitter, business days since submission, and service request number.
 *
 * The active tab is driven by a ?tab= search param so the URL is shareable
 * and the browser back button works correctly.
 */

import { requirePermission } from "@/platform/auth/session";
import { listDepartmentsWithMembers } from "@/modules/admin/services/itcm";
import { getEpicRequestHistory } from "@/modules/admin/services/itcm";
import { PageHeader } from "@/platform/ui/page-header";
import { EpicRequestTabs } from "@/modules/admin/components/epic-request-tabs";

type PageProps = {
  searchParams: Promise<{ tab?: string }>;
};

export default async function EpicRequestsPage({ searchParams }: PageProps) {
  await requirePermission("admin.access");

  const { tab } = await searchParams;
  const activeTab = tab === "tracker" ? "tracker" : "generate";

  // Load data for both tabs in parallel.
  const [departments, history] = await Promise.all([
    listDepartmentsWithMembers(),
    getEpicRequestHistory(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Epic Requests"
        description="Generate YNHH service request PDFs and track submission status."
      />
      <EpicRequestTabs
        activeTab={activeTab}
        departments={departments}
        history={history}
      />
    </div>
  );
}