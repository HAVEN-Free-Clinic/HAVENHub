import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import {
  getTechRequest,
  isManager,
  SupportNotFoundError,
} from "@/modules/support/services/tech-request";
import { TicketDetail } from "@/modules/support/components/ticket-detail";
import { Alert } from "@/platform/ui/alert";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ submitted?: string }>;
};

export default async function TicketPage({ params, searchParams }: PageProps) {
  const session = await requireModuleAccess("support");
  const { id } = await params;
  const { submitted } = await searchParams;

  let detail;
  try {
    detail = await getTechRequest(session.personId, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) notFound();
    throw e;
  }

  const canManage = await isManager(session.personId);

  return (
    <div className="space-y-6">
      {submitted === "1" && (
        <Alert tone="success">Request submitted. We will keep you posted here.</Alert>
      )}
      <TicketDetail detail={detail} canManage={canManage} />
    </div>
  );
}
