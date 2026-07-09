import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import type { CommentVisibility } from "@prisma/client";
import {
  getTechRequest,
  isManager,
  SupportNotFoundError,
  SupportForbiddenError,
  SupportStateError,
} from "@/modules/support/services/tech-request";
import { addComment, listComments, notifyCommentAdded } from "@/modules/support/services/comments";
import { TicketDetail } from "@/modules/support/components/ticket-detail";
import { Alert } from "@/platform/ui/alert";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ submitted?: string; commentError?: string }>;
};

export default async function TicketPage({ params, searchParams }: PageProps) {
  const session = await requireModuleAccess("support");
  const { id } = await params;
  const { submitted, commentError } = await searchParams;

  let detail;
  try {
    detail = await getTechRequest(session.personId, id);
  } catch (e) {
    if (e instanceof SupportNotFoundError) notFound();
    throw e;
  }

  const canManage = await isManager(session.personId);
  const comments = await listComments(session.personId, id);

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
      <TicketDetail
        detail={detail}
        canManage={canManage}
        comments={comments}
        commentAction={commentAction}
        commentError={commentError ? decodeURIComponent(commentError) : undefined}
      />
    </div>
  );
}
