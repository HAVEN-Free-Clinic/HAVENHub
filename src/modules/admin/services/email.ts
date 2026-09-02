/**
 * Admin email monitoring service: list, health counts, and retry.
 *
 * Read-only queries (listEmails, emailHealthCounts) are safe for any admin.
 * retryEmail is a mutation -- callers are responsible for permission checks.
 * Services trust their callers and remain testable in isolation.
 */

import type { EmailLog, EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import {
  GraphTransport,
  LogTransport,
  MailerooTransport,
  type EmailTransport,
} from "@/platform/email/transport";
import { config } from "@/platform/config";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { formatForDateInput, parseZonedInput } from "@/platform/dates/format";
import { getAccessToken as defaultGetAccessToken } from "@/platform/email/oauth";
import { signingTransportFor } from "@/platform/email/sending-domains";
import { getSetting } from "@/platform/settings/service";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when an EmailLog row cannot be found by the given id. */
export class EmailNotFoundError extends Error {
  constructor(id: string) {
    super(`Email not found: ${id}`);
    this.name = "EmailNotFoundError";
  }
}

/** Thrown when an attempted state transition is not permitted. */
export class EmailStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailStateError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregate counts for the email health dashboard header. */
export type EmailHealthCounts = {
  queued: number;
  /** Every FAILED row, regardless of age -- the standing health signal. */
  failed: number;
  /** FAILED rows recent enough that "Retry all" will actually re-queue them
   *  (see RETRY_MAX_AGE_MS). Drives the bulk-retry button so its label matches
   *  what the action sends. */
  retryableFailed: number;
  sentToday: number;
};

export const EMAIL_PAGE_SIZE = 25;

/**
 * "Retry all failed" only re-queues FAILED rows from the last 7 days. EmailLog is
 * never purged, and the drain re-sends each row's FROZEN html verbatim, so an
 * unbounded bulk retry would re-deliver months-old acceptance/rejection notices,
 * shift reminders for clinic dates long past, and magic-link / onboarding URLs
 * that are already past their expiresAt (a dead link). Bound the retry, and drive
 * the button's count off the same window so the label never over-promises.
 */
export const RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The oldest createdAt a bulk retry will touch, relative to `now`. */
function retryableFailedCutoff(now: Date): Date {
  return new Date(now.getTime() - RETRY_MAX_AGE_MS);
}

/**
 * Return aggregate status counts across the entire EmailLog table.
 *
 * @param now - Override the current time (for testability). Defaults to new Date().
 */
export async function emailHealthCounts(now?: Date): Promise<EmailHealthCounts> {
  const d = now ?? new Date();
  // Start of "today" in the configured display zone (the zone the rows render in),
  // not UTC -- otherwise "Sent today" counts a different day than the one shown.
  const zone = await getDisplayTimeZone();
  const startOfToday =
    parseZonedInput(`${formatForDateInput(d, zone)}T00:00`, zone) ??
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

  const [queued, failed, retryableFailed, sentToday] = await Promise.all([
    prisma.emailLog.count({ where: { status: "QUEUED" } }),
    prisma.emailLog.count({ where: { status: "FAILED" } }),
    prisma.emailLog.count({
      where: { status: "FAILED", createdAt: { gte: retryableFailedCutoff(d) } },
    }),
    prisma.emailLog.count({
      where: {
        status: "SENT",
        sentAt: { gte: startOfToday },
      },
    }),
  ]);

  return { queued, failed, retryableFailed, sentToday };
}

/** Input shape for listEmails pagination and filtering. */
export type ListEmailsQuery = {
  /** Exact status match. */
  status?: EmailStatus;
  /** Exact template match. */
  template?: string;
  /** Case-insensitive substring match against toEmail. */
  q?: string;
  /** 1-based page number. Defaults to 1. */
  page?: number;
};

/**
 * List EmailLog rows with optional filters, newest first.
 *
 * The returned `counts` field reflects GLOBAL health counts (not filtered),
 * suitable for rendering a summary header alongside filtered results.
 */
export async function listEmails(query: ListEmailsQuery): Promise<{
  rows: EmailLog[];
  total: number;
  counts: EmailHealthCounts;
}> {
  const page = query.page ?? 1;
  const skip = (page - 1) * EMAIL_PAGE_SIZE;

  const where: Prisma.EmailLogWhereInput = {};

  if (query.status) {
    where.status = query.status;
  }

  if (query.template) {
    where.template = query.template;
  }

  if (query.q && query.q.length > 0) {
    where.toEmail = { contains: query.q, mode: "insensitive" };
  }

  const [rows, total, counts] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      // `id` (a cuid) breaks createdAt ties: chunked createMany gives every row
      // in a campaign fan-out the same CURRENT_TIMESTAMP, and Postgres has no
      // stable order within a tie group, so offset pages would otherwise repeat
      // and drop rows. Matches listTeamsMessages / listNotifications / the drain.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: EMAIL_PAGE_SIZE,
    }),
    prisma.emailLog.count({ where }),
    emailHealthCounts(),
  ]);

  return { rows, total, counts };
}

/**
 * Return the distinct `template` values actually present in EmailLog, sorted.
 *
 * The monitoring page builds its template filter from this so every option
 * matches real data: recruitment and campaign emails (the highest-volume
 * categories during a cycle) are no longer omitted by a hardcoded allowlist
 * (issue #99). An empty log yields an empty list.
 */
export async function listEmailTemplates(): Promise<string[]> {
  const rows = await prisma.emailLog.findMany({
    distinct: ["template"],
    select: { template: true },
    orderBy: { template: "asc" },
  });
  return rows.map((r) => r.template);
}

/**
 * Reset a FAILED email to QUEUED so the next drain pass will re-attempt it.
 *
 * Only FAILED emails may be retried. Throws EmailStateError for any other
 * status. The actual send is performed by the existing minute-cron drain;
 * this function only resets the row state and records an audit entry.
 *
 * @param actorPersonId - The person authorizing the retry (for audit).
 * @param emailId - The EmailLog row to retry.
 */
export async function retryEmail(actorPersonId: string, emailId: string): Promise<void> {
  const row = await prisma.emailLog.findUnique({ where: { id: emailId } });

  if (!row) {
    throw new EmailNotFoundError(emailId);
  }

  if (row.status !== "FAILED") {
    throw new EmailStateError("Only failed emails can be retried.");
  }

  const oldAttempts = row.attempts;

  await prisma.emailLog.update({
    where: { id: emailId },
    data: {
      status: "QUEUED",
      attempts: 0,
      lastError: null,
      lockedAt: null,
    },
  });

  await recordAudit({
    actorPersonId,
    action: "email.retry",
    entityType: "EmailLog",
    entityId: emailId,
    before: { status: "FAILED", attempts: oldAttempts },
    after: { status: "QUEUED" },
  });
}

/**
 * Bulk-reset recent FAILED emails to QUEUED so the next drain pass re-attempts
 * them. Intended for recovery after a transient transport outage that exhausted
 * the retry budget on many rows at once (issue #63), where clicking per-row
 * Retry is impractical.
 *
 * Only rows newer than RETRY_MAX_AGE_MS are touched: EmailLog is never purged and
 * the drain re-sends the frozen html verbatim, so an unbounded retry would blast
 * out stale mail (see RETRY_MAX_AGE_MS). The bulk-retry button is driven by
 * `counts.retryableFailed`, which uses the same window.
 *
 * Resets attempts/lastError exactly like retryEmail. Records a single audit
 * entry carrying the affected count, or none when there is nothing to retry.
 * Returns the number of rows re-queued.
 *
 * @param actorPersonId - The person authorizing the bulk retry (for audit).
 * @param now - Override the current time (for testability). Defaults to new Date().
 */
export async function retryAllFailedEmails(actorPersonId: string, now?: Date): Promise<number> {
  const cutoff = retryableFailedCutoff(now ?? new Date());
  const { count } = await prisma.emailLog.updateMany({
    where: { status: "FAILED", createdAt: { gte: cutoff } },
    data: { status: "QUEUED", attempts: 0, lastError: null, lockedAt: null },
  });

  if (count === 0) return 0;

  await recordAudit({
    actorPersonId,
    action: "email.retry_all",
    entityType: "EmailLog",
    before: { status: "FAILED" },
    after: { status: "QUEUED", count, maxAgeDays: RETRY_MAX_AGE_MS / (24 * 60 * 60 * 1000) },
  });

  return count;
}

/**
 * Send a one-off test email AS `fromEmail`, directly (NOT via the queue), so any
 * rejection (malformed address, missing Send-As rights, unsignable sending
 * domain) surfaces synchronously to the admin. In log mode it just logs. Records
 * an audit entry.
 *
 * `opts` is for testing only; production callers omit it.
 */
export async function sendSenderTest(
  actorPersonId: string,
  input: { toEmail: string; fromEmail: string; fromName?: string | null },
  opts?: { getAccessToken?: () => Promise<string>; fetchImpl?: typeof fetch }
): Promise<void> {
  const transportKind = await getSetting<"log" | "graph" | "maileroo">("email.transport");

  // Which transport can DKIM-sign for the requested address decides BOTH what
  // this test sends as and which transport carries it, because that is what the
  // drain does with a real message naming the same From (SigningDomainRouter).
  // Testing anything else would report on a send production never makes.
  //
  // This used to be one answer per transport setting: maileroo pinned every send
  // to the global sender, so a rule's own address was never the one tested. That
  // is now only the OFF-LIST case; an address Maileroo can sign is tested as
  // itself, and a Graph-signed address (yale.edu today) is tested through Graph.
  const signer = signingTransportFor(input.fromEmail);

  // Build the transport that is actually selected. Falling through to LogTransport
  // for a live non-graph transport would make the test send silently "pass"
  // without sending, defeating the one check that confirms the From address is
  // usable (Send-As rights on graph, a signable sending domain on maileroo).
  let transport: EmailTransport;
  let effectiveFrom: string;
  if (transportKind === "log") {
    effectiveFrom = input.fromEmail;
    transport = new LogTransport();
  } else if (transportKind === "maileroo" && signer !== "graph") {
    // Maileroo signs it, or nothing does: either way the real send goes through
    // Maileroo. It leaves as the requested address when the allowlist carries its
    // domain, and as the pinned global sender when it does not.
    effectiveFrom =
      signer === "maileroo" ? input.fromEmail : await getSetting<string>("email.sender");
    transport = new MailerooTransport({
      apiKey: config.MAILEROO_API_KEY ?? "",
      sender: effectiveFrom,
      fetchImpl: opts?.fetchImpl,
    });
  } else {
    // Graph mode, or maileroo mode with a Graph-signed From. Either way the
    // address itself is what is tested, which is exactly the Send-As check.
    effectiveFrom = input.fromEmail;
    transport = new GraphTransport({
      getAccessToken: opts?.getAccessToken ?? defaultGetAccessToken,
      sender: effectiveFrom,
      fetchImpl: opts?.fetchImpl,
    });
  }

  await transport.send({
    to: input.toEmail,
    subject: "HAVEN Hub sender test",
    html: `<p>This is a test message confirming HAVEN Hub can send from ${effectiveFrom}.</p>`,
    from: effectiveFrom,
    fromName: input.fromName ?? undefined,
  });

  await recordAudit({
    actorPersonId,
    action: "email.sender_test",
    entityType: "EmailSenderRule",
    // Record both: an off-list address under maileroo is not the one used, and
    // the audit trail should not imply otherwise.
    after: { toEmail: input.toEmail, fromEmail: input.fromEmail, sentAs: effectiveFrom },
  });
}
