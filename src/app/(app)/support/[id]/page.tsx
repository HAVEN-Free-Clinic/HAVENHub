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
import { promoteToEpic } from "@/modules/support/services/epic-link";
import {
  completeRequest,
  createTicket,
  setTicketServiceRequestNumber,
  sendEpicEmail,
  EpicForbiddenError,
  EpicNotFoundError,
  EpicStateError,
} from "@/modules/support/services/epic";
import type { EpicTemplateKey } from "@/platform/email/templates/epic";
import { peopleWithAnyPermission } from "@/platform/rbac/holders";
import { TicketDetail } from "@/modules/support/components/ticket-detail";
import { ALL_STATUSES, ALL_PRIORITIES } from "@/modules/support/components/request-filters";
import { Alert } from "@/platform/ui/alert";

const EPIC_EMAIL_TEMPLATES: EpicTemplateKey[] = [
  "epic-onboarding",
  "epic-activation",
  "epic-password-reset",
];

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    submitted?: string;
    commentError?: string;
    attachmentError?: string;
    manageError?: string;
    epicError?: string;
  }>;
};

function pick<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function TicketPage({ params, searchParams }: PageProps) {
  const session = await requireModuleAccess("support");
  const { id } = await params;
  const { submitted, commentError, attachmentError, manageError, epicError } = await searchParams;

  let detail: TechRequestDetail;
  try {
    detail = await getTechRequest(session.personId, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) notFound();
    throw e;
  }

  const canManage = await isManager(session.personId);
  const isRequester = detail.requesterId === session.personId;
  const comments = await listComments(session.personId, id);
  const managers = canManage ? await peopleWithAnyPermission([MANAGE]) : [];

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

  // ---------------------------------------------------------------------------
  // Epic pipeline: promotion + the single-ticket inline actions from epic.ts.
  // Each action re-derives the linked EpicRequest (and its ticket) off the
  // `detail` already loaded above rather than trusting client-supplied ids.
  // ---------------------------------------------------------------------------

  async function promoteAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const kind = (formData.get("epicKind") as string) as EpicRequestKind;
    try {
      await promoteToEpic(actorSession.personId, id, kind);
    } catch (err) {
      if (
        err instanceof SupportStateError ||
        err instanceof SupportForbiddenError ||
        err instanceof SupportNotFoundError ||
        err instanceof EpicStateError ||
        err instanceof EpicForbiddenError ||
        err instanceof EpicNotFoundError
      ) {
        redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function completeEpicAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const epicRequestId = detail.epicRequestId;
    if (!epicRequestId) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("No linked Epic request.")}`);
    }
    const epicId = ((formData.get("epicId") as string | null) ?? "").trim() || undefined;
    try {
      await completeRequest(actorSession.personId, epicRequestId, epicId);
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

  async function createEpicTicketAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const epicRequestId = detail.epicRequestId;
    if (!epicRequestId) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("No linked Epic request.")}`);
    }
    const description = (formData.get("description") as string | null) || null;
    try {
      await createTicket(actorSession.personId, { requestIds: [epicRequestId], description });
    } catch (err) {
      if (err instanceof EpicForbiddenError || err instanceof EpicStateError) {
        redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function setEpicSrAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const ticketId = detail.epicRequest?.ticketId;
    if (!ticketId) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("This request has no YNHH ticket yet.")}`);
    }
    const srNumber = (formData.get("srNumber") as string | null) ?? "";
    try {
      await setTicketServiceRequestNumber(actorSession.personId, ticketId, srNumber);
    } catch (err) {
      if (err instanceof EpicForbiddenError || err instanceof EpicNotFoundError) {
        redirect(`/support/${id}?epicError=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
    redirect(`/support/${id}`);
  }

  async function sendEpicEmailAction(formData: FormData) {
    "use server";
    const actorSession = await requireModuleAccess("support");
    const epicRequestId = detail.epicRequestId;
    if (!epicRequestId) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("No linked Epic request.")}`);
    }
    const template = (formData.get("template") as string | null) ?? "";
    if (!(EPIC_EMAIL_TEMPLATES as string[]).includes(template)) {
      redirect(`/support/${id}?epicError=${encodeURIComponent("Invalid email template.")}`);
    }
    try {
      await sendEpicEmail(actorSession.personId, epicRequestId, template as EpicTemplateKey);
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

    const req = await prisma.techRequest.findUniqueOrThrow({ where: { id } });
    const author = await prisma.person.findUniqueOrThrow({
      where: { id: actorSession.personId },
      select: { id: true, name: true },
    });
    await notifyCommentAdded(prisma, req, comment, author);
    redirect(`/support/${id}`);
  }

  return (
    <div className="space-y-6">
      {submitted === "1" && (
        <Alert tone="success">Request submitted. We will keep you posted here.</Alert>
      )}
      {attachmentError && (
        <Alert tone="error">{decodeURIComponent(attachmentError)}</Alert>
      )}
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
        manageError={manageError ? decodeURIComponent(manageError) : undefined}
        comments={comments}
        commentAction={commentAction}
        commentError={commentError ? decodeURIComponent(commentError) : undefined}
        promoteAction={promoteAction}
        completeEpicAction={completeEpicAction}
        createEpicTicketAction={createEpicTicketAction}
        setEpicSrAction={setEpicSrAction}
        sendEpicEmailAction={sendEpicEmailAction}
        epicError={epicError ? decodeURIComponent(epicError) : undefined}
      />
    </div>
  );
}
