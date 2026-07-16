/**
 * CommentThread: the two-way conversation on a ticket, plus the reply form.
 *
 * `comments` already reflects the caller's visibility - comments.ts's
 * listComments filters INTERNAL rows out for non-managers before this
 * component ever sees them - so it only needs to split what it received into
 * the PUBLIC conversation (everyone) and an INTERNAL notes section
 * (`canManage` only). Managers get a Public reply / Internal note toggle on
 * the form; requesters only ever post PUBLIC (a hidden field, enforced again
 * server-side by addComment).
 */

import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Textarea } from "@/platform/ui/input";
import { Radio, RadioGroup } from "@/platform/ui/radio";
import { SubmitButton } from "@/platform/ui/submit-button";
import { FormActions } from "@/platform/ui/form";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { DateTime } from "@/platform/dates/display";
import type { CommentRow } from "../services/comments";
import { SUPPORT_UPLOAD_ACCEPT } from "../upload-constants";
import { AttachmentList } from "./attachment-list";

type CommentThreadProps = {
  comments: CommentRow[];
  /** True when the caller holds support.manage_requests. */
  canManage: boolean;
  action: (formData: FormData) => Promise<void>;
  error?: string;
};

function CommentCard({ comment, internal }: { comment: CommentRow; internal?: boolean }) {
  return (
    <Card size="compact">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {comment.author.name ?? "Unknown"}
          {internal && <Badge tone="warning">Internal</Badge>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground"><DateTime value={comment.createdAt} /></span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-soft">{comment.body}</p>
      <AttachmentList attachments={comment.attachments} />
    </Card>
  );
}

export function CommentThread({ comments, canManage, action, error }: CommentThreadProps) {
  const publicComments = comments.filter((c) => c.visibility === "PUBLIC");
  const internalComments = comments.filter((c) => c.visibility === "INTERNAL");

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader className="mb-2">Conversation</SectionHeader>
        {publicComments.length === 0 ? (
          <Card pad={false} className="px-6 py-8 text-center text-sm text-muted-foreground">
            No replies yet.
          </Card>
        ) : (
          <div className="space-y-3">
            {publicComments.map((c) => (
              <CommentCard key={c.id} comment={c} />
            ))}
          </div>
        )}
      </section>

      {canManage && internalComments.length > 0 && (
        <section>
          <SectionHeader className="mb-2">Internal notes</SectionHeader>
          <div className="space-y-3">
            {internalComments.map((c) => (
              <CommentCard key={c.id} comment={c} internal />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader className="mb-2">Reply</SectionHeader>
        <form action={action}>
          <Card className="space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            <Textarea
              name="body"
              rows={3}
              placeholder={
                canManage ? "Reply to the requester, or leave an internal note…" : "Add an update…"
              }
              required
            />
            {canManage ? (
              <RadioGroup legend="Visibility">
                <Radio name="visibility" value="PUBLIC" label="Public reply" defaultChecked />
                <Radio name="visibility" value="INTERNAL" label="Internal note" />
              </RadioGroup>
            ) : (
              <input type="hidden" name="visibility" value="PUBLIC" />
            )}
            {/* eslint-disable-next-line no-restricted-syntax -- native file input with file-button pseudo-element styling (file:* classes); no file primitive exists */}
            <input type="file" name="attachments" multiple accept={SUPPORT_UPLOAD_ACCEPT} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground-soft hover:file:bg-muted-strong" />
            <FormActions>
              <SubmitButton variant="primary" pendingLabel="Posting…">
                Post
              </SubmitButton>
            </FormActions>
          </Card>
        </form>
      </section>
    </div>
  );
}
