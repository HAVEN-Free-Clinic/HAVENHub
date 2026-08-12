import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { isIntercomConfigured } from "@/platform/intercom/config";
import { listMyRequests } from "@/modules/support/services/tech-request";
import { RequestList } from "@/modules/support/components/request-list";

export default async function MyRequestsPage() {
  const session = await requireModuleAccess("support");
  const rows = await listMyRequests(session.personId);

  return (
    <div className="space-y-6">
      <PageHeader title="My requests" description="Requests you have submitted to IT Support." />
      <RequestList
        rows={rows}
        hrefBase="/support"
        showRequester={false}
        // "messenger": a member has no login to Intercom's own inbox, so a
        // linked row's action opens the widget instead of a deep link.
        intercomAction={isIntercomConfigured() ? "messenger" : undefined}
      />
    </div>
  );
}
