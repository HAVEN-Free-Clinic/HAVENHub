/**
 * TicketDetail: full-page view of a single TechRequest, shared by the
 * requester and (once `canManage` is true) support managers. The [id] page
 * loads `detail` via getTechRequest - which already enforces that only the
 * requester or a support.manage_requests holder can reach this component -
 * and passes it straight through.
 *
 * Header, description, and resolution are always shown. Further sections are
 * conditional:
 *   - an `isRequester` gated cancel button, shown while the ticket is open
 *     (non-terminal) so the requester can withdraw their own request.
 *   - a `canManage` gated manager control panel (assign / status / priority /
 *     resolve / cancel), one small form per control so each mutation is
 *     independent.
 *   - a `canManage` gated Epic section, shown for any ticket category: the
 *     list of Epic requests already attached (kind, person, status, and the
 *     linked YNHH ticket's SR# once set), each cancellable while open and
 *     the ticket is open, plus an attach form (request-type selector +
 *     EpicPersonPicker) while the ticket is open. Attaching creates one
 *     PENDING EpicRequest per selected person via attachEpicRequests; the
 *     rest of the pipeline (submit to YNHH, set SR#, complete, email) is
 *     worked on the Epic Requests page, not here.
 *   - ticket-level attachments (Task 7): rendered only when the ticket has
 *     any (detail.attachments comes straight off getTechRequest's include).
 *
 * All action props are optional so this component still renders (with the
 * relevant section hidden) for any caller that has not been updated to pass
 * them.
 *
 * --- Intercom-linked tickets (docs/superpowers/specs/2026-08-12-intercom-ticket-sync-design.md) ---
 *
 * A ticket with intercomConversationId set came in through (or was promoted
 * to) an Intercom conversation, and per "Where the work happens" it is
 * managed there, not here: this component becomes a read-only record for it
 * rather than a workspace. Concretely that means, relative to the unlinked
 * behavior above:
 *   - the owner-facing cancel button is hidden (isLinked check below).
 *   - the manager control panel's assign / priority / resolve / cancel /
 *     close controls are hidden. The status control is the one exception --
 *     see `showStatusControl`'s own comment, just below the imports.
 *   - the Epic access section still shows the attached-request chain (part
 *     of "the record"), but its attach/cancel forms are hidden.
 *   - the comment thread still shows existing comments, but the reply form
 *     is hidden (CommentThread's showReplyForm prop) -- correspondence goes
 *     through the conversation instead.
 *   - a banner explains where the work happens and links into it, so a
 *     manager who used to work this ticket here is not left hunting for a
 *     disabled button.
 * None of this reruns server actions or deletes them -- setStatus in
 * particular stays wired for the EPIC exception and remains the documented
 * escape hatch for a ticket an agent moved to a terminal state in Intercom by
 * mistake. Only the UI affordances are removed.
 */

import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { ExternalLinkButton } from "@/platform/ui/external-link-button";
import { Badge } from "@/platform/ui/badge";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { isIntercomConfigured, intercomConversationUrl } from "@/platform/intercom/config";
import { ContinueConversationButton } from "@/platform/intercom/messenger-actions";
import type { TechRequestStatus, TechRequestPriority, EpicRequestKind } from "@prisma/client";
import { SupportStatusBadge, STATUS_LABELS } from "./status-badge";
import { CommentThread } from "./comment-thread";
import { AttachmentList } from "./attachment-list";
import { EpicPersonPicker } from "./epic-person-picker";
import { CATEGORY_LABELS, PRIORITY_LABELS, EPIC_KIND_LABELS, EPIC_STATUS_LABELS, EPIC_STATUS_TONE } from "@/modules/support/labels";
import type { TechRequestDetail } from "../services/tech-request";
import type { DepartmentWithMembers } from "../services/itcm";
import { TERMINAL_STATUSES } from "../services/manage";
import type { CommentRow } from "../services/comments";

const ALL_PRIORITIES = Object.keys(PRIORITY_LABELS) as TechRequestPriority[];

/** Kinds a manager may choose when promoting a ticket. DEACTIVATE is a separate offboarding flow, not offered here. */
const PROMOTABLE_EPIC_KINDS: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];

/**
 * Statuses a manager can set directly through the status select. RESOLVED,
 * CANCELLED, and CLOSED are excluded -- these are all reached through dedicated
 * guarded controls (Resolve / Cancel require a reason; Close is a permanent,
 * no-reopen terminal state behind a ConfirmButton). Keeping CLOSED out of the
 * dropdown of otherwise-reversible states stops an accidental one-click close.
 */
const MANAGER_SETTABLE_STATUSES: TechRequestStatus[] = [
  "SUBMITTED",
  "IN_PROGRESS",
  "AWAITING_REQUESTER",
  "AWAITING_YNHH",
];

type ManagerOption = { id: string; name: string | null };

type TicketDetailProps = {
  detail: TechRequestDetail;
  /** True when the caller holds support.manage_requests. Gates the manager control panel. */
  canManage?: boolean;
  /** True when the caller is this ticket's own requester. Gates the owner-facing cancel button. */
  isRequester?: boolean;
  /** support.manage_requests holders, for the assignee selector. Only needed when canManage. */
  managers?: ManagerOption[];
  /** Server action wired to assignRequest. */
  assignAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to setStatus. */
  setStatusAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to setPriority. */
  setPriorityAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to resolveRequest. */
  resolveAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to cancelRequest (manager cancel). */
  cancelAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to cancelOwnRequest (requester self-service cancel). */
  cancelOwnAction?: (formData: FormData) => Promise<void>;
  /** The ticket's comments, already visibility-filtered by listComments. */
  comments?: CommentRow[];
  /** Server action that posts a reply/note via addComment + notifyCommentAdded. */
  commentAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to attachEpicRequests. Reads "epicKind" + repeated "personIds". */
  attachEpicAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to cancelEpicRequest. Reads hidden "epicRequestId". */
  cancelEpicAction?: (formData: FormData) => Promise<void>;
  /** Active departments+members for the attach picker. Only needed when canManage. */
  departments?: DepartmentWithMembers[];
};

export async function TicketDetail({
  detail,
  canManage = false,
  isRequester = false,
  managers = [],
  assignAction,
  setStatusAction,
  setPriorityAction,
  resolveAction,
  cancelAction,
  cancelOwnAction,
  comments,
  commentAction,
  attachEpicAction,
  cancelEpicAction,
  departments = [],
}: TicketDetailProps) {
  const isOpen = !TERMINAL_STATUSES.includes(detail.status);
  const zone = await getDisplayTimeZone();

  // The golden rule (see the module doc comment): a ticket is "managed in
  // Intercom" purely by having a conversation link, independent of whether
  // Intercom happens to be configured on THIS deploy right now. A ticket
  // linked before an env var was rolled back must not spring back to full
  // Hub interactivity just because the var is gone -- the correspondence
  // still lives in Intercom regardless.
  const isLinked = detail.intercomConversationId !== null;

  // EPIC exception (temporary, narrower than the rest of this file): the
  // Epic workflow (epic.ts) only ever writes EpicRequest.status /
  // YnhhTicket.status, never TechRequest.status, so AWAITING_YNHH has
  // exactly one origin in this codebase -- a manager picking it from this
  // control. Hiding the status control for a linked EPIC ticket the way
  // every other control is hidden would strand it: nobody could ever mark it
  // Awaiting YNHH, the Direction-3 push to Intercom would never fire, and
  // the member's Intercom ticket would sit unchanged for as long as the
  // request is with Yale New Haven Health -- precisely the visibility the
  // custom "Waiting on YNHH" state exists to provide. Drop this exception
  // once epic.ts drives TechRequest.status itself.
  const showStatusControl = !isLinked || detail.category === "EPIC";
  // Every other manager mutation (assign, priority, resolve, cancel, close)
  // moves fully to Intercom for a linked ticket, no exceptions.
  const showManagerMutations = !isLinked;
  // Epic mutations are NOT a link-conditional control, and this is not an
  // exception to the read-only rule so much as the boundary of what that rule
  // was ever about. Intercom took over the CONVERSATION; the Epic to YNHH to
  // ITCM workflow never left the Hub, because Intercom cannot model it.
  //
  // Gating these on !isLinked strands the workflow completely now that Epic
  // tickets originate in Intercom: every EPIC ticket arrives already linked
  // via the ticket.created webhook, so an attach form hidden on linked
  // tickets is an attach form nobody can ever reach, and no EpicRequest could
  // be raised at all. The failure would be silent -- the page renders fine,
  // it just has no way forward.
  const showEpicMutations = detail.category === "EPIC";
  const showCommentForm = !isLinked;
  const showCancelOwn = !isLinked;

  // Only rendered when Intercom is live right now (see messenger-actions.tsx's
  // doc comment on why a stale link must not be offered against an unbooted
  // widget), separately from isLinked above -- the two can disagree if the
  // app id was rolled back after this ticket was linked.
  const intercomLive = isIntercomConfigured();
  const conversationId = detail.intercomConversationId;
  const conversationUrl = conversationId && intercomLive ? intercomConversationUrl(conversationId) : null;

  // The current assignee may have lost support.manage_requests since being
  // assigned; make sure they still show up as a selectable (and selected)
  // option instead of silently falling back to "Unassigned".
  const assigneeOptions = new Map<string, string | null>(managers.map((m) => [m.id, m.name]));
  if (detail.assignedTo) assigneeOptions.set(detail.assignedTo.id, detail.assignedTo.name);

  return (
    <div className="space-y-8">
      <PageHeader
        title={detail.subject}
        description={`#${detail.number} · ${CATEGORY_LABELS[detail.category]} · Submitted ${formatDateOnly(
          detail.createdAt,
          zone
        )}`}
        action={<SupportStatusBadge status={detail.status} />}
      />

      {isLinked && (
        <section>
          <Card className="flex flex-wrap items-center justify-between gap-4 border-brand/20 bg-brand-faint">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">This ticket is managed in Intercom</p>
              <p className="mt-1 text-sm text-foreground-soft">
                {canManage
                  ? "Reply, reassign, and change its priority in the Intercom conversation -- the Hub shows this ticket as a record of it."
                  : "Reply and get updates in the conversation -- the Hub shows this ticket as a record of it."}
                {showStatusControl && canManage && (
                  <>
                    {" "}
                    Status stays adjustable below until Epic access requests drive it automatically -- see
                    Manager controls.
                  </>
                )}
              </p>
            </div>
            {canManage
              ? conversationUrl && (
                  <ExternalLinkButton href={conversationUrl} variant="primary" size="sm">
                    Open in Intercom
                  </ExternalLinkButton>
                )
              : isRequester &&
                intercomLive &&
                conversationId && (
                  <ContinueConversationButton conversationId={conversationId} variant="primary" size="sm" />
                )}
          </Card>
        </section>
      )}

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

      {isRequester && isOpen && showCancelOwn && cancelOwnAction && (
        <section>
          <form action={cancelOwnAction}>
            <ConfirmButton label="Cancel my request" confirmLabel="Cancel it?" />
          </form>
        </section>
      )}

      {canManage &&
        assignAction &&
        setStatusAction &&
        setPriorityAction &&
        resolveAction &&
        cancelAction &&
        (showManagerMutations || showStatusControl) && (
          <section>
            <SectionHeader className="mb-2">Manager controls</SectionHeader>
            {isOpen ? (
              <Card className="space-y-6">
                {showManagerMutations ? (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <form action={assignAction} className="space-y-2">
                      <Field label="Assignee">
                        <Select name="assigneeId" defaultValue={detail.assignedToId ?? ""}>
                          <option value="">Unassigned</option>
                          {[...assigneeOptions].map(([id, name]) => (
                            <option key={id} value={id}>
                              {name ?? "Unknown"}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
                        Update assignee
                      </SubmitButton>
                    </form>

                    <form action={setStatusAction} className="space-y-2">
                      <Field label="Status">
                        <Select name="status" defaultValue={detail.status}>
                          {MANAGER_SETTABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABELS[s]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
                        Update status
                      </SubmitButton>
                    </form>

                    <form action={setPriorityAction} className="space-y-2">
                      <Field label="Priority">
                        <Select name="priority" defaultValue={detail.priority}>
                          {ALL_PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {PRIORITY_LABELS[p]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
                        Update priority
                      </SubmitButton>
                    </form>
                  </div>
                ) : (
                  // Linked EPIC exception -- see showStatusControl's doc comment
                  // above. Status only: assign/priority/resolve/cancel/close all
                  // moved to Intercom, same as any other linked ticket.
                  <div className="grid gap-4 sm:grid-cols-3">
                    <form action={setStatusAction} className="space-y-2">
                      <Field label="Status">
                        <Select name="status" defaultValue={detail.status}>
                          {MANAGER_SETTABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABELS[s]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <SubmitButton variant="outline" size="sm" pendingLabel="Saving…">
                        Update status
                      </SubmitButton>
                    </form>
                  </div>
                )}

                {showManagerMutations && (
                  <>
                    <form action={resolveAction} className="space-y-2 border-t border-border pt-4">
                      <Field label="Resolution">
                        <Textarea name="resolution" rows={3} placeholder="What fixed this?" required />
                      </Field>
                      <SubmitButton pendingLabel="Resolving…">Resolve ticket</SubmitButton>
                    </form>

                    <form action={cancelAction} className="space-y-2 border-t border-border pt-4">
                      <Field label="Cancel this ticket">
                        <Textarea name="reason" rows={2} placeholder="Reason for cancelling…" required />
                      </Field>
                      <ConfirmButton label="Cancel ticket" confirmLabel="Confirm cancel?" />
                    </form>

                    <form action={setStatusAction} className="space-y-2 border-t border-border pt-4">
                      <input type="hidden" name="status" value="CLOSED" />
                      <p className="text-sm font-medium text-foreground-soft">Close this ticket</p>
                      <p className="text-xs text-muted-foreground">
                        Closing is permanent: the ticket becomes read-only and cannot be reopened.
                      </p>
                      <ConfirmButton label="Close ticket" confirmLabel="Close permanently?" />
                    </form>
                  </>
                )}
              </Card>
            ) : (
              <Card>
                <p className="text-sm text-muted-foreground">
                  This ticket is {STATUS_LABELS[detail.status].toLowerCase()} and can no longer be
                  edited.
                </p>
              </Card>
            )}
          </section>
        )}

      {canManage && (
        <section>
          <SectionHeader className="mb-2">Epic access</SectionHeader>
          <Card className="space-y-4">
            {detail.epicRequests.length > 0 ? (
              <ul className="space-y-2">
                {detail.epicRequests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-border pb-2 last:border-0">
                    <Badge>{EPIC_KIND_LABELS[r.kind]}</Badge>
                    <span className="text-sm font-medium text-foreground">{r.person.name}</span>
                    <Badge tone={EPIC_STATUS_TONE[r.status]}>{EPIC_STATUS_LABELS[r.status]}</Badge>
                    {r.ticket && (
                      <span className="text-xs text-foreground-soft">
                        YNHH SR#: {r.ticket.serviceRequestNumber ?? "(not set)"}
                      </span>
                    )}
                    {showEpicMutations && isOpen && (r.status === "PENDING" || r.status === "SUBMITTED") && cancelEpicAction && (
                      <form action={cancelEpicAction} className="ml-auto">
                        <input type="hidden" name="epicRequestId" value={r.id} />
                        <SubmitButton size="sm" variant="ghost" pendingLabel="Cancelling…">
                          Cancel
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No Epic requests attached yet.</p>
            )}

            {showEpicMutations && isOpen && attachEpicAction && (
              <form action={attachEpicAction} className="space-y-3 border-t border-border pt-4">
                <Field label="Request type">
                  <Select name="epicKind" defaultValue="NEW" className="w-48">
                    {PROMOTABLE_EPIC_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {EPIC_KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <EpicPersonPicker
                  departments={departments}
                  quickAdd={{ id: detail.requester.id, name: detail.requester.name }}
                />
                <SubmitButton variant="primary" size="sm" pendingLabel="Attaching…">
                  Attach Epic request(s)
                </SubmitButton>
                <p className="text-xs text-subtle-foreground">
                  Attached requests are worked on the Epic Requests page (submit to YNHH, set SR#, complete, email).
                </p>
              </form>
            )}
          </Card>
        </section>
      )}

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
          showReplyForm={showCommentForm}
        />
      )}
    </div>
  );
}
