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
  listPendingEpicRequests,
  closeTicket,
  updateServiceRequestNumber,
  logYnhhIncident,
  resolveIncident,
} from "@/modules/support/services/itcm";
import { persistAttachment } from "@/modules/support/services/attachments";
import { SupportForbiddenError, SupportNotFoundError, SupportStateError } from "@/modules/support/services/tech-request";
import {
  createTicket,
  completeRequest,
  sendEpicEmail,
  linkEpicRequestToTicket,
  cancelEpicRequest,
  EpicForbiddenError,
  EpicNotFoundError,
  EpicStateError,
} from "@/modules/support/services/epic";
import type { EpicTemplateKey } from "@/platform/email/templates/epic";
import { PageHeader } from "@/platform/ui/page-header";
import { EpicRequestTabs } from "@/modules/support/components/epic-request-tabs";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getWorkingTerm } from "@/platform/terms/working-term";
import { listBatchTermOptions, loadTermEpicRollup } from "@/modules/support/services/epic-rollup";

const EPIC_EMAIL_TEMPLATES: EpicTemplateKey[] = ["epic-onboarding", "epic-activation", "epic-password-reset"];

async function closeTicketAction(ticketId: string) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  try {
    await closeTicket(session.personId, ticketId);
  } catch (err) {
    if (err instanceof SupportStateError || err instanceof SupportForbiddenError) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
}

async function updateServiceRequestNumberAction(ticketId: string, value: string) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  try {
    await updateServiceRequestNumber(session.personId, ticketId, value);
  } catch (err) {
    if (
      err instanceof SupportStateError ||
      err instanceof SupportForbiddenError ||
      err instanceof SupportNotFoundError
    ) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
}

async function logIncidentAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");

  const subject = (formData.get("subject") as string) ?? "";
  const description = ((formData.get("description") as string) ?? "").trim();
  const serviceRequestNumber = ((formData.get("serviceRequestNumber") as string) ?? "").trim();
  const personId = ((formData.get("personId") as string) ?? "").trim();

  let ticket;
  try {
    ticket = await logYnhhIncident(session.personId, {
      subject,
      description: description || null,
      serviceRequestNumber: serviceRequestNumber || null,
      personId: personId || null,
    });
  } catch (err) {
    if (err instanceof SupportStateError || err instanceof SupportForbiddenError) {
      // Scope this to the incident form's own error slot so it renders in the "Log a
      // YNHH incident" card, not attributed to a Tracker row action (#115).
      redirect(`/support/epic?tab=tracker&incidentError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  // The incident is now committed. A failure while saving an attachment must NOT
  // read as "not logged" -- otherwise the manager re-enters and duplicates it, and
  // the first incident is already in the Tracker. Say the incident was logged.
  const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
  try {
    for (const file of files) {
      await persistAttachment(session.personId, { ynhhTicketId: ticket.id }, {
        fileName: file.name,
        mimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (err) {
    if (err instanceof SupportStateError || err instanceof SupportForbiddenError) {
      revalidatePath("/support/epic");
      redirect(
        `/support/epic?tab=tracker&incidentError=${encodeURIComponent(`The incident was logged, but an attachment could not be saved: ${err.message}`)}`,
      );
    }
    throw err;
  }

  revalidatePath("/support/epic");
  redirect("/support/epic?tab=tracker");
}

async function resolveIncidentAction(ticketId: string, resolution: string) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  try {
    await resolveIncident(session.personId, ticketId, resolution);
  } catch (err) {
    // resolveIncident throws user-facing SupportStateError for the two ordinary,
    // reachable states -- the incident was already resolved by another manager, and
    // a whitespace-only resolution -- plus SupportNotFoundError on a concurrent
    // delete. Surface those inline instead of falling through to the (app) error
    // boundary, which discards the message (#91).
    if (
      err instanceof SupportStateError ||
      err instanceof SupportForbiddenError ||
      err instanceof SupportNotFoundError
    ) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
}

async function createTicketFromPendingAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  const requestIds = formData.getAll("requestIds").map(String).filter(Boolean);
  const description = ((formData.get("description") as string) ?? "").trim() || null;
  try {
    await createTicket(session.personId, { requestIds, description });
  } catch (err) {
    if (err instanceof EpicForbiddenError || err instanceof EpicStateError) {
      redirect(`/support/epic?tab=pending&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
  redirect("/support/epic?tab=pending");
}

async function completeEpicRequestAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  const requestId = String(formData.get("requestId") ?? "");
  const epicId = String(formData.get("epicId") ?? "").trim() || undefined;
  try {
    await completeRequest(session.personId, requestId, epicId);
  } catch (err) {
    if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
  redirect("/support/epic?tab=tracker");
}

async function sendEpicEmailFromTrackerAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  const requestId = String(formData.get("requestId") ?? "");
  const template = String(formData.get("template") ?? "");
  if (!(EPIC_EMAIL_TEMPLATES as string[]).includes(template)) {
    redirect(`/support/epic?tab=tracker&error=${encodeURIComponent("Invalid email template.")}`);
  }
  try {
    await sendEpicEmail(session.personId, requestId, template as EpicTemplateKey);
  } catch (err) {
    if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
  redirect("/support/epic?tab=tracker");
}

async function cancelEpicRequestAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  const requestId = String(formData.get("requestId") ?? "");
  // Return to whichever tab initiated the cancel (Tracker or Pending).
  const tab = String(formData.get("tab") ?? "tracker") === "pending" ? "pending" : "tracker";
  try {
    await cancelEpicRequest(session.personId, requestId);
  } catch (err) {
    if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
      redirect(`/support/epic?tab=${tab}&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
  redirect(`/support/epic?tab=${tab}`);
}

async function linkEpicRequestAction(formData: FormData) {
  "use server";
  const session = await requirePermission("support.manage_requests");
  const requestId = String(formData.get("requestId") ?? "");
  const ticketNumber = Number.parseInt(String(formData.get("ticketNumber") ?? ""), 10);
  if (!Number.isFinite(ticketNumber) || ticketNumber <= 0) {
    redirect(`/support/epic?tab=tracker&error=${encodeURIComponent("Enter a valid support ticket number.")}`);
  }
  try {
    await linkEpicRequestToTicket(session.personId, requestId, ticketNumber);
  } catch (err) {
    if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError || err instanceof EpicStateError) {
      redirect(`/support/epic?tab=tracker&error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
  revalidatePath("/support/epic");
  redirect("/support/epic?tab=tracker");
}

type PageProps = {
  // `term` selects the Term batch tab's target term.
  searchParams: Promise<{ tab?: string; term?: string }>;
};

export default async function EpicRequestsPage({ searchParams }: PageProps) {
  await requirePermission("support.manage_requests");

  const { tab, term } = await searchParams;
  const activeTab =
    tab === "pending"
      ? "pending"
      : tab === "tracker"
        ? "tracker"
        : tab === "history"
          ? "history"
          : tab === "term-batch"
            ? "term-batch"
            : "generate";

  // Load data for both tabs in parallel.
  const [departments, history, pendingDeactivations, authorizers, incidentPeople, pending] = await Promise.all([
    listDepartmentsWithMembers(),
    getEpicRequestHistory(),
    listPendingDeactivations(),
    listEpicAuthorizers(),
    listIncidentPeople(),
    listPendingEpicRequests(),
  ]);

  // The Term batch tab can target a term before it goes active, so resolve the
  // working term from ?term= (falling back to the live term) rather than assuming
  // the active one.
  const [workingTerm, liveTerm, termOptions] = await Promise.all([
    getWorkingTerm(term),
    getActiveTerm(),
    listBatchTermOptions(),
  ]);
  // The roll-up is six queries plus loadClearanceMap (roughly twelve more over the
  // full roster); only the Term batch tab renders it (EpicRequestTabs), so skip the
  // work on every other tab visit instead of paying for it on the default Generate
  // tab too.
  const rollup =
    activeTab === "term-batch" && workingTerm ? await loadTermEpicRollup(workingTerm.id) : null;

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
        pending={pending}
        rollup={rollup}
        termOptions={termOptions}
        liveTermId={liveTerm?.id ?? null}
        closeTicketAction={closeTicketAction}
        updateServiceRequestNumberAction={updateServiceRequestNumberAction}
        logIncidentAction={logIncidentAction}
        resolveIncidentAction={resolveIncidentAction}
        createTicketFromPendingAction={createTicketFromPendingAction}
        completeEpicRequestAction={completeEpicRequestAction}
        sendEpicEmailFromTrackerAction={sendEpicEmailFromTrackerAction}
        linkEpicRequestAction={linkEpicRequestAction}
        cancelEpicRequestAction={cancelEpicRequestAction}
      />
    </div>
  );
}
