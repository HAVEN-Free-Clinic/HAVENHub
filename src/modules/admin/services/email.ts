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
import { GraphTransport, LogTransport } from "@/platform/email/transport";
import { getAccessToken as defaultGetAccessToken } from "@/platform/email/oauth";
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
  failed: number;
  sentToday: number;
};

export const EMAIL_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// emailHealthCounts
// ---------------------------------------------------------------------------

/**
 * Return aggregate status counts across the entire EmailLog table.
 *
 * @param now - Override the current time (for testability). Defaults to new Date().
 */
export async function emailHealthCounts(now?: Date): Promise<EmailHealthCounts> {
  const d = now ?? new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const startOfTodayUtc = new Date(Date.UTC(y, m, day));

  const [queued, failed, sentToday] = await Promise.all([
    prisma.emailLog.count({ where: { status: "QUEUED" } }),
    prisma.emailLog.count({ where: { status: "FAILED" } }),
    prisma.emailLog.count({
      where: {
        status: "SENT",
        sentAt: { gte: startOfTodayUtc },
      },
    }),
  ]);

  return { queued, failed, sentToday };
}

// ---------------------------------------------------------------------------
// listEmails
// ---------------------------------------------------------------------------

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
      orderBy: { createdAt: "desc" },
      skip,
      take: EMAIL_PAGE_SIZE,
    }),
    prisma.emailLog.count({ where }),
    emailHealthCounts(),
  ]);

  return { rows, total, counts };
}

// ---------------------------------------------------------------------------
// retryEmail
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// retryAllFailedEmails
// ---------------------------------------------------------------------------

/**
 * Bulk-reset every FAILED email to QUEUED so the next drain pass re-attempts
 * them. Intended for recovery after a transient transport outage that exhausted
 * the retry budget on many rows at once (issue #63), where clicking per-row
 * Retry is impractical.
 *
 * Resets attempts/lastError exactly like retryEmail. Records a single audit
 * entry carrying the affected count, or none when there is nothing to retry.
 * Returns the number of rows re-queued.
 *
 * @param actorPersonId - The person authorizing the bulk retry (for audit).
 */
export async function retryAllFailedEmails(actorPersonId: string): Promise<number> {
  const { count } = await prisma.emailLog.updateMany({
    where: { status: "FAILED" },
    data: { status: "QUEUED", attempts: 0, lastError: null },
  });

  if (count === 0) return 0;

  await recordAudit({
    actorPersonId,
    action: "email.retry_all",
    entityType: "EmailLog",
    before: { status: "FAILED" },
    after: { status: "QUEUED", count },
  });

  return count;
}

// ---------------------------------------------------------------------------
// sendSenderTest
// ---------------------------------------------------------------------------

/**
 * Send a one-off test email AS `fromEmail`, directly (NOT via the queue), so any
 * Graph rejection (malformed address or missing Send-As rights) surfaces
 * synchronously to the admin. In log mode it just logs. Records an audit entry.
 *
 * `opts` is for testing only; production callers omit it.
 */
export async function sendSenderTest(
  actorPersonId: string,
  input: { toEmail: string; fromEmail: string; fromName?: string | null },
  opts?: { getAccessToken?: () => Promise<string>; fetchImpl?: typeof fetch }
): Promise<void> {
  const transportKind = await getSetting<"log" | "graph">("email.transport");
  const transport =
    transportKind === "graph"
      ? new GraphTransport({
          getAccessToken: opts?.getAccessToken ?? defaultGetAccessToken,
          sender: input.fromEmail,
          fetchImpl: opts?.fetchImpl,
        })
      : new LogTransport();

  await transport.send({
    to: input.toEmail,
    subject: "HAVEN Hub sender test",
    html: `<p>This is a test message confirming HAVEN Hub can send from ${input.fromEmail}.</p>`,
    from: input.fromEmail,
    fromName: input.fromName ?? undefined,
  });

  await recordAudit({
    actorPersonId,
    action: "email.sender_test",
    entityType: "EmailSenderRule",
    after: { toEmail: input.toEmail, fromEmail: input.fromEmail },
  });
}
