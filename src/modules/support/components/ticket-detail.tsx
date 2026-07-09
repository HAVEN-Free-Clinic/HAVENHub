/**
 * TicketDetail: full-page view of a single TechRequest, shared by the
 * requester and (once `canManage` is true) support managers. The [id] page
 * loads `detail` via getTechRequest - which already enforces that only the
 * requester or a support.manage_requests holder can reach this component -
 * and passes it straight through.
 *
 * Header, description, and resolution are always shown. Two further
 * sections are conditional:
 *   - a `canManage` gated block for manager controls (assignment,
 *     status/priority changes, the Epic promotion pipeline) -- not yet
 *     built, seam left below.
 *   - ticket-level attachments (Task 7): rendered only when the ticket has
 *     any (detail.attachments comes straight off getTechRequest's include).
 *
 * `comments` + `commentAction` are optional so this component still renders
 * (with the thread empty) for any caller that has not been updated to pass
 * them.
 */

import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { fmtDate } from "@/platform/dates";
import { SupportStatusBadge } from "./status-badge";
import { CommentThread } from "./comment-thread";
import { AttachmentList } from "./attachment-list";
import { CATEGORY_LABELS } from "@/modules/support/labels";
import type { TechRequestDetail } from "../services/tech-request";
import type { CommentRow } from "../services/comments";

type TicketDetailProps = {
  detail: TechRequestDetail;
  /** True when the caller holds support.manage_requests. Gates manager-only sections. */
  canManage?: boolean;
  /** The ticket's comments, already visibility-filtered by listComments. */
  comments?: CommentRow[];
  /** Server action that posts a reply/note via addComment + notifyCommentAdded. */
  commentAction?: (formData: FormData) => Promise<void>;
  commentError?: string;
};

export function TicketDetail({
  detail,
  canManage = false,
  comments,
  commentAction,
  commentError,
}: TicketDetailProps) {
  return (
    <div className="space-y-8">
      <PageHeader
        title={detail.subject}
        description={`#${detail.number} · ${CATEGORY_LABELS[detail.category]} · Submitted ${fmtDate(
          detail.createdAt
        )}`}
        action={<SupportStatusBadge status={detail.status} />}
      />

      <section>
        <SectionHeader className="mb-2">Description</SectionHeader>
        <Card>
          <p className="whitespace-pre-wrap text-sm text-foreground">{detail.description}</p>
        </Card>
      </section>

      {detail.resolution && (
        <section>
          <SectionHeader className="mb-2">Resolution</SectionHeader>
          <Card>
            <p className="whitespace-pre-wrap text-sm text-foreground">{detail.resolution}</p>
          </Card>
        </section>
      )}

      {/* Manager controls seam: added in a later task */}

      {detail.attachments.length > 0 && (
        <section>
          <SectionHeader className="mb-2">Attachments</SectionHeader>
          <Card>
            <AttachmentList attachments={detail.attachments} />
          </Card>
        </section>
      )}

      {comments && commentAction && (
        <CommentThread
          comments={comments}
          canManage={canManage}
          action={commentAction}
          error={commentError}
        />
      )}
    </div>
  );
}
