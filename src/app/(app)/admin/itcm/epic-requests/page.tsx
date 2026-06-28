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

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { listDepartmentsWithMembers, getEpicRequestHistory, listPendingDeactivations, closeTicket, updateServiceRequestNumber } from "@/modules/admin/services/itcm";
import { PageHeader } from "@/platform/ui/page-header";
import { EpicRequestTabs } from "@/modules/admin/components/epic-request-tabs";

async function closeTicketAction(ticketId: string) {
  "use server";
  await requirePermission("admin.access");
  await closeTicket(ticketId);
  revalidatePath("/admin/itcm/epic-requests");
}

async function updateServiceRequestNumberAction(ticketId: string, value: string) {
  "use server";
  await requirePermission("admin.access");
  await updateServiceRequestNumber(ticketId, value);
  revalidatePath("/admin/itcm/epic-requests");
}

type PageProps = {
  searchParams: Promise<{ tab?: string }>;
};

export default async function EpicRequestsPage({ searchParams }: PageProps) {
  await requirePermission("admin.access");

  const { tab } = await searchParams;
const activeTab = tab === "tracker" ? "tracker" : tab === "history" ? "history" : "generate";

  // Load data for both tabs in parallel.
  const [departments, history, pendingDeactivations] = await Promise.all([
    listDepartmentsWithMembers(),
    getEpicRequestHistory(),
    listPendingDeactivations(),
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
        pendingDeactivations={pendingDeactivations}
        closeTicketAction={closeTicketAction}
        updateServiceRequestNumberAction={updateServiceRequestNumberAction}
      />
    </div>
  );
}
