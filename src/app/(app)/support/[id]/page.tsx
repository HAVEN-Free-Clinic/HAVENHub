import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import type { CommentVisibility, TechRequestStatus, TechRequestPriority, EpicRequestKind } from "@prisma/client";
import {
  getTechRequest,
  isManager,
  MANAGE,
  SupportNotFoundError,
  SupportForbiddenError,
  SupportStateError,
  type TechRequestDetail,
} from "@/modules/support/services/tech-request";
import {
  assignRequest,
  setStatus,
  setPriority,
  resolveRequest,
  cancelRequest,
  cancelOwnRequest,
} from "@/modules/support/services/manage";
import { addComment, listComments, notifyCommentAdded } from "@/modules/support/services/comments";
import { persistAttachment } from "@/modules/support/services/attachments";
import { attachEpicRequests } from "@/modules/support/services/epic-link";
import { cancelEpicRequest, EpicForbiddenError, EpicNotFoundError, EpicStateError } from "@/modules/support/services/epic";
import { listDepartmentsWithMembers } from "@/modules/support/services/itcm";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { TicketDetail } from "@/modules/support/components/ticket-detail";
import { ticketViewCapabilities } from "@/modules/support/ticket-view";
import { ALL_STATUSES, ALL_PRIORITIES } from "@/modules/support/filter-options";

type PageProps = {
  params: Promise<{ id: string }>;
};

function pick<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function TicketPage({ params }: PageProps) {
  const session = await requireModuleAccess("support");
  const { id } = await params;

  let detail: TechRequestDetail;
  try {
    detail = await getTechRequest(session.personId, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) notFound();
    throw e;
  }

  const canManage = await isManager(session.personId);
  const isRequester = detail.requesterId === session.personId;
  const { showCorrespondence } = ticketViewCapabilities({ canManage, isRequester });
  // A view-only auditor gets neither: listComments would throw
  // SupportNotFoundError for them (it still gates on manager-or-requester, and
  // deliberately so), and the page would 500 rather than render the read-only
  // view they are entitled to.
  const comments = showCorrespondence ? await listComments(session.personId, id) : undefined;
  const managers = canManage ? await peopleWithAnyPermission([MANAGE]) : [];
  const departments = canManage ? await listDepartmentsWithMembers() : [];

  async function assignAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const raw = ((formData.get("assigneeId") as string) ?? "").trim();
    try {
      await assignRequest(actorSession.personId, id, raw || null);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function setStatusAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const raw = (formData.get("status") as string) ?? "";
    const status = pick<TechRequestStatus>(raw, ALL_STATUSES);
    try {
      if (!status) throw new SupportStateError(`Unknown status: ${raw}`);
      await setStatus(actorSession.personId, id, status);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function setPriorityAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const raw = (formData.get("priority") as string) ?? "";
    const priority = pick<TechRequestPriority>(raw, ALL_PRIORITIES);
    try {
      if (!priority) throw new SupportStateError(`Unknown priority: ${raw}`);
      await setPriority(actorSession.personId, id, priority);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function resolveAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const resolution = (formData.get("resolution") as string) ?? "";
    try {
      await resolveRequest(actorSession.personId, id, resolution);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function cancelAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const reason = (formData.get("reason") as string) ?? "";
    try {
      await cancelRequest(actorSession.personId, id, reason);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function cancelOwnAction() {
    "use server";
    const actorSession = await requireModuleAccess("support");
    try {
      await cancelOwnRequest(actorSession.personId, id);
    } catch (err) {
      if (err instanceof SupportStateError || err instanceof SupportNotFoundError) {
        redirect(`/support/${id}?manageError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function attachEpicAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const kind = (formData.get("epicKind") as string) as EpicRequestKind;
    const personIds = formData.getAll("personIds").map(String).filter(Boolean);
    try {
      await attachEpicRequests(actorSession.personId, id, { kind, personIds });
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function cancelEpicAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const epicRequestId = String(formData.get("epicRequestId") ?? "");
    // Only allow cancelling a request that belongs to this ticket.
    if (!detail.epicRequests.some((r) => r.id === epicRequestId)) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("Unknown Epic request.")}`);
    }
    try {
      await cancelEpicRequest(actorSession.personId, epicRequestId);
    } catch (err) {
      if (
        err instanceof EpicForbiddenError ||
        err instanceof EpicNotFoundError ||
        err instanceof EpicStateError
      ) {
        redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function commentAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const actorCanManage = await isManager(actorSession.personId);
    const body = (formData.get("body") as string) ?? "";
    const requestedVisibility = (formData.get("visibility") as CommentVisibility) || "PUBLIC";
    // Defense in depth: addComment enforces this too, but a non-manager's
    // form never renders the toggle in the first place.
    const visibility: CommentVisibility = actorCanManage ? requestedVisibility : "PUBLIC";

    let comment;
    try {
      comment = await addComment(actorSession.personId, id, { body, visibility });
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError
      ) {
        redirect(`/support/${id}?commentError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }

    // Notify BEFORE persisting attachments (audit F9): a rejected attachment below
    // redirects (NEXT_REDIRECT throws), so with the notify after the loop a committed
    // reply would go un-notified. Mirrors support/new/page.tsx's ordering.
    const req = await prisma.techRequest.findUniqueOrThrow({ where: { id } });
    const author = await prisma.person.findUniqueOrThrow({
      where: { id: actorSession.personId },
      select: { id: true, name: true },
    });
    await notifyCommentAdded(prisma, req, comment, author);

    const files = formData.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    try {
      for (const file of files) {
        await persistAttachment(actorSession.personId, { commentId: comment.id }, {
          fileName: file.name,
          mimeType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
      }
    } catch (err) {
      if (err instanceof SupportForbiddenError) {
        redirect(`/support/${id}?attachmentError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }

    redirect(`/support/${id}`);
  }

  return (
    <div className="space-y-6">
      <TicketDetail
        detail={detail}
        canManage={canManage}
        isRequester={isRequester}
        managers={managers}
        assignAction={assignAction}
        setStatusAction={setStatusAction}
        setPriorityAction={setPriorityAction}
        resolveAction={resolveAction}
        cancelAction={cancelAction}
        cancelOwnAction={cancelOwnAction}
        comments={comments}
        commentAction={showCorrespondence ? commentAction : undefined}
        showCorrespondence={showCorrespondence}
        attachEpicAction={attachEpicAction}
        cancelEpicAction={cancelEpicAction}
        departments={departments}
      />
    </div>
  );
}
