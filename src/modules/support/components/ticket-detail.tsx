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
 *     linked YNHH ticket's SR# once set), each cancellable while PENDING and
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
 */

import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { SubmitButton } from "@/platform/ui/submit-button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";
import { formatDateOnly } from "@/platform/dates";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import type { TechRequestStatus, TechRequestPriority, EpicRequestKind, EpicRequestStatus } from "@prisma/client";
import { SupportStatusBadge, STATUS_LABELS } from "./status-badge";
import { CommentThread } from "./comment-thread";
import { AttachmentList } from "./attachment-list";
import { EpicPersonPicker } from "./epic-person-picker";
import { CATEGORY_LABELS, PRIORITY_LABELS } from "@/modules/support/labels";
import type { TechRequestDetail } from "../services/tech-request";
import type { DepartmentWithMembers } from "../services/itcm";
import { TERMINAL_STATUSES } from "../services/manage";
import type { CommentRow } from "../services/comments";

const ALL_PRIORITIES = Object.keys(PRIORITY_LABELS) as TechRequestPriority[];

const EPIC_KIND_LABELS: Record<EpicRequestKind, string> = {
  NEW: "New account",
  MODIFY: "Modification",
  RENEW: "Renewal",
  DEACTIVATE: "Deactivation",
};

/** Kinds a manager may choose when promoting a ticket. DEACTIVATE is a separate offboarding flow, not offered here. */
const PROMOTABLE_EPIC_KINDS: EpicRequestKind[] = ["NEW", "MODIFY", "RENEW"];

const EPIC_STATUS_LABELS: Record<EpicRequestStatus, string> = {
  PENDING: "Pending",
  SUBMITTED: "Submitted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

type Tone = "default" | "brand" | "success" | "warning" | "critical";

const EPIC_STATUS_TONE: Record<EpicRequestStatus, Tone> = {
  PENDING: "default",
  SUBMITTED: "warning",
  COMPLETED: "success",
  CANCELLED: "critical",
};

/**
 * Statuses a manager can set directly through the status select. RESOLVED
 * and CANCELLED are excluded -- those are reached only through the Resolve
 * form and Cancel button, which require a reason and notify the requester
 * (setStatus rejects them as a target value; see manage.ts).
 */
const MANAGER_SETTABLE_STATUSES: TechRequestStatus[] = [
  "SUBMITTED",
  "IN_PROGRESS",
  "AWAITING_REQUESTER",
  "AWAITING_YNHH",
  "CLOSED",
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
  /** Error from the most recent manager-panel action, if any. */
  manageError?: string;
  /** The ticket's comments, already visibility-filtered by listComments. */
  comments?: CommentRow[];
  /** Server action that posts a reply/note via addComment + notifyCommentAdded. */
  commentAction?: (formData: FormData) => Promise<void>;
  commentError?: string;
  /** Server action wired to attachEpicRequests. Reads "epicKind" + repeated "personIds". */
  attachEpicAction?: (formData: FormData) => Promise<void>;
  /** Server action wired to cancelEpicRequest. Reads hidden "epicRequestId". */
  cancelEpicAction?: (formData: FormData) => Promise<void>;
  /** Active departments+members for the attach picker. Only needed when canManage. */
  departments?: DepartmentWithMembers[];
  /** Error from the most recent Epic-section action, if any. */
  epicError?: string;
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
  manageError,
  comments,
  commentAction,
  commentError,
  attachEpicAction,
  cancelEpicAction,
  departments = [],
  epicError,
}: TicketDetailProps) {
  const isOpen = !TERMINAL_STATUSES.includes(detail.status);
  const zone = await getDisplayTimeZone();

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

      {isRequester && isOpen && cancelOwnAction && (
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
        cancelAction && (
          <section>
            <SectionHeader className="mb-2">Manager controls</SectionHeader>
            {isOpen ? (
              <Card className="space-y-6">
                {manageError && <Alert tone="error">{manageError}</Alert>}

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
              </Card>
            ) : (
              <Card>
                {manageError && <Alert tone="error">{manageError}</Alert>}
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
            {epicError && <Alert tone="error">{epicError}</Alert>}

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
                    {isOpen && r.status === "PENDING" && cancelEpicAction && (
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

            {isOpen && attachEpicAction && (
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
          error={commentError}
        />
      )}
    </div>
  );
}
