/**
 * Support / Epic tools page.
 *
 * Two-tab layout:
 *   - Generate: form-driven PDF, spreadsheet, and email draft generator.
 *   - Tracker: table of all submitted Epic requests with ticket status,
 *     submitter, business days since submission, and service request number.
 *     Also hosts the "log a YNHH incident" form for standalone (non-Epic)
 *     tickets, e.g. a general outage report or a one-off account question.
 *
 * The active tab is driven by a ?tab= search param so the URL is shareable
 * and the browser back button works correctly.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import {
  listDepartmentsWithMembers,
  getEpicRequestHistory,
  listPendingDeactivations,
  listEpicAuthorizers,
  listIncidentPeople,
  closeTicket,
  updateServiceRequestNumber,
  logYnhhIncident,
  resolveIncident,
} from "@/modules/support/services/itcm";
import { persistAttachment } from "@/modules/support/services/attachments";
import { SupportForbiddenError, SupportStateError } from "@/modules/support/services/tech-request";
import { PageHeader } from "@/platform/ui/page-header";
import { EpicRequestTabs } from "@/modules/support/components/epic-request-tabs";

async function closeTicketAction(ticketId: string) {
  "use server";
  await requirePermission("support.manage_requests");
  await closeTicket(ticketId);
  revalidatePath("/support/epic");
}

async function updateServiceRequestNumberAction(ticketId: string, value: string) {
  "use server";
  await requirePermission("support.manage_requests");
  await updateServiceRequestNumber(ticketId, value);
  revalidatePath("/support/epic");
}

async function logIncidentAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");

  const subject = (formData.get("subject") as string) ?? "";
  const description = ((formData.get("description") as string) ?? "").trim();
  const serviceRequestNumber = ((formData.get("serviceRequestNumber") as string) ?? "").trim();
  const personId = ((formData.get("personId") as string) ?? "").trim();

  try {
    const ticket = await logYnhhIncident(session.personId, {
      subject,
      description: description || null,
      serviceRequestNumber: serviceRequestNumber || null,
      personId: personId || null,
    });

    const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    for (const file of files) {
      await persistAttachment(session.personId, { ynhhTicketId: ticket.id }, {
        fileName: file.name,
        mimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (err) {
    if (err instanceof SupportStateError || err instanceof SupportForbiddenError) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath("/support/epic");
  redirect("/support/epic?tab=tracker");
}

async function resolveIncidentAction(ticketId: string, resolution: string) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  await resolveIncident(session.personId, ticketId, resolution);
  revalidatePath("/support/epic");
}

type PageProps = {
  searchParams: Promise<{ tab?: string; error?: string }>;
};

export default async function EpicRequestsPage({ searchParams }: PageProps) {
  await requirePermission("support.manage_requests");

  const { tab, error } = await searchParams;
  const activeTab = tab === "tracker" ? "tracker" : tab === "history" ? "history" : "generate";

  // Load data for both tabs in parallel.
  const [departments, history, pendingDeactivations, authorizers, incidentPeople] = await Promise.all([
    listDepartmentsWithMembers(),
    getEpicRequestHistory(),
    listPendingDeactivations(),
    listEpicAuthorizers(),
    listIncidentPeople(),
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
        authorizers={authorizers}
        incidentPeople={incidentPeople}
        error={error ? decodeURIComponent(error) : undefined}
        closeTicketAction={closeTicketAction}
        updateServiceRequestNumberAction={updateServiceRequestNumberAction}
        logIncidentAction={logIncidentAction}
        resolveIncidentAction={resolveIncidentAction}
      />
    </div>
  );
}
