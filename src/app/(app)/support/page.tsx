import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listMyRequests } from "@/modules/support/services/tech-request";
import { RequestList } from "@/modules/support/components/request-list";

export default async function MyRequestsPage() {
  const session = await requireModuleAccess("support");
  const rows = await listMyRequests(session.personId);

  return (
    <div className="space-y-6">
      <PageHeader title="My requests" description="Requests you have submitted to IT Support." />
      <RequestList rows={rows} hrefBase="/support" showRequester={false} />
    </div>
  );
}
