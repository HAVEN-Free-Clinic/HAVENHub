import { Badge } from "@/platform/ui/badge";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { DateTime } from "@/platform/dates/display";

/**
 * The delivery log shared by /admin/email and /admin/notifications.
 *
 * The two pages are the same page: a filtered, paginated list of outbound
 * messages with a status, an attempt count, a truncated last error, timestamps
 * and a retry. They had been built twice, and the halves that had no reason to
 * differ were byte-identical, including the 60-character error truncation and
 * its title tooltip.
 *
 * What legitimately differs stays with the caller:
 *
 *  - Who the recipient is (an email address vs a person's name) and what the
 *    second column holds (a template key vs a notification type label). Both
 *    are just strings by the time they reach here, but their HEADERS differ, so
 *    the caller names them.
 *  - Which statuses can be retried. Email retries only FAILED; a Teams message
 *    also retries FALLBACK and LOGGED, because those were delivered by some
 *    other channel or not at all and a re-queue is still meaningful.
 *  - The status tone. `FALLBACK` is a warning for Teams and has no meaning for
 *    email, so the page resolves its own tone rather than this table guessing
 *    from a status string it does not own.
 */

export type DeliveryLogTone = "default" | "success" | "warning" | "critical";

export type DeliveryLogRow = {
  id: string;
  /** Email address or person name, whichever this log is about. */
  recipient: string;
  /** Template key or notification type label. */
  kind: string;
  status: string;
  statusTone: DeliveryLogTone;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  /** Whether a re-queue is meaningful for this row's status. */
  canRetry: boolean;
};

/** Long errors are truncated in the cell and given in full as a tooltip. */
function LastError({ message }: { message: string | null }) {
  if (!message) return <span className="text-subtle-foreground">-</span>;
  return (
    <span title={message} className="block truncate max-w-[15rem]">
      {message.length > 60 ? message.slice(0, 60) + "…" : message}
    </span>
  );
}

export function DeliveryLogTable({
  rows,
  recipientHeader,
  kindHeader,
  retryAction,
  retryConfirmLabel,
}: {
  rows: DeliveryLogRow[];
  recipientHeader: string;
  kindHeader: string;
  retryAction: (formData: FormData) => Promise<void>;
  retryConfirmLabel: string;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>{recipientHeader}</TH>
          <TH>{kindHeader}</TH>
          <TH>Status</TH>
          <TH>Attempts</TH>
          <TH>Last error</TH>
          <TH>Created</TH>
          <TH>Sent</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TR key={row.id}>
            <TD className="font-medium text-sm">{row.recipient}</TD>
            <TD className="text-sm text-foreground-soft">{row.kind}</TD>
            <TD>
              <Badge tone={row.statusTone}>{row.status}</Badge>
            </TD>
            <TD className="tabular-nums text-sm text-foreground-soft">{row.attempts}</TD>
            <TD className="text-sm text-muted-foreground max-w-xs">
              <LastError message={row.lastError} />
            </TD>
            <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
              <DateTime value={row.createdAt} />
            </TD>
            <TD className="tabular-nums text-sm text-foreground-soft whitespace-nowrap">
              <DateTime value={row.sentAt} />
            </TD>
            <TD>
              {row.canRetry && (
                <form action={retryAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <ConfirmButton label="Retry" confirmLabel={retryConfirmLabel} />
                </form>
              )}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
