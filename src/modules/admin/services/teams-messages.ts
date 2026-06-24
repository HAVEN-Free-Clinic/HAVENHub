/**
 * Admin Teams message monitoring service: list and retry.
 *
 * Read-only queries (listTeamsMessages) are safe for any admin.
 * retryTeamsMessage is a mutation -- callers are responsible for permission checks.
 * Services trust their callers and remain testable in isolation.
 */

import type { TeamsMessage, TeamsMessageStatus, Person } from "@prisma/client";
import { prisma } from "@/platform/db";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when a TeamsMessage row cannot be found by the given id. */
export class TeamsMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Teams message not found: ${id}`);
    this.name = "TeamsMessageNotFoundError";
  }
}

/** Thrown when an attempted state transition is not permitted. */
export class TeamsMessageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsMessageStateError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeamsMessageWithPerson = TeamsMessage & {
  person: Pick<Person, "id" | "name" | "contactEmail">;
};

export const TEAMS_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// listTeamsMessages
// ---------------------------------------------------------------------------

/** List Teams messages with optional status/type/recipient filters, paginated. */
export async function listTeamsMessages(params: {
  status?: TeamsMessageStatus;
  type?: string;
  q?: string;
  page?: number;
}): Promise<{ rows: TeamsMessageWithPerson[]; total: number; page: number }> {
  const page = Math.max(1, params.page ?? 1);
  const where = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.q
      ? { person: { is: { name: { contains: params.q, mode: "insensitive" as const } } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.teamsMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * TEAMS_PAGE_SIZE,
      take: TEAMS_PAGE_SIZE,
      include: { person: { select: { id: true, name: true, contactEmail: true } } },
    }),
    prisma.teamsMessage.count({ where }),
  ]);

  return { rows, total, page };
}

// ---------------------------------------------------------------------------
// retryTeamsMessage
// ---------------------------------------------------------------------------

/**
 * Reset a FAILED or FALLBACK Teams message back to QUEUED for another attempt.
 *
 * Only FAILED or FALLBACK messages may be retried. Throws TeamsMessageStateError
 * for any other status. The actual send is performed by the delivery cron;
 * this function only resets the row state.
 *
 * @param id - The TeamsMessage row to retry.
 */
export async function retryTeamsMessage(id: string): Promise<void> {
  const row = await prisma.teamsMessage.findUnique({ where: { id } });
  if (!row) throw new TeamsMessageNotFoundError(id);
  if (row.status !== "FAILED" && row.status !== "FALLBACK") {
    throw new TeamsMessageStateError(
      `Only FAILED or FALLBACK messages can be retried (status: ${row.status}).`,
    );
  }
  await prisma.teamsMessage.update({
    where: { id },
    data: { status: "QUEUED", attempts: 0, lastError: null },
  });
}
