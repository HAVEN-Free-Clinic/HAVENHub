/**
 * /admin/sync -- Sync health dashboard.
 *
 * Read-only view of the mirror worker status, outbox stats, FAILED outbox
 * rows, and drift correction log. Operators can retry all FAILED rows with
 * a single ConfirmButton.
 *
 * Gates on admin.manage_sync. The retry action re-checks the same permission.
 */

import { redirect } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { syncOverview, retryFailed } from "@/modules/admin/services/sync";
import { SyncPanel } from "@/modules/admin/components/sync-panel";
import { PageHeader } from "@/platform/ui/page-header";

type PageProps = {
  searchParams: Promise<{ retried?: string }>;
};

export default async function SyncPage({ searchParams }: PageProps) {
  await requirePermission("admin.manage_sync");

  const { retried: retriedStr } = await searchParams;
  const requeued =
    retriedStr !== undefined ? parseInt(retriedStr, 10) || 0 : undefined;

  const overview = await syncOverview();

  async function retry() {
    "use server";
    // Re-check permission inside the action.
    const actor = await requirePermission("admin.manage_sync");
    const count = await retryFailed(actor.personId);
    redirect(`/admin/sync?retried=${count}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sync Health"
        description="Mirror worker status and outbox metrics. Retry all failed outbox rows with a single click."
      />

      <SyncPanel overview={overview} requeued={requeued} retryAction={retry} />
    </div>
  );
}
