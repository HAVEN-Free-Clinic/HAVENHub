import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * True when `err` indicates the database server could not be reached: the client
 * failed to establish a connection (e.g. Neon briefly unreachable) or a query
 * timed out at the connection layer. Callers that hold a safe fallback can then
 * degrade gracefully instead of surfacing a 500.
 */
export function isDbUnreachableError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  // P1001 can't reach server, P1002 timed out reaching it, P1008 operation
  // timed out, P1017 server closed the connection.
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    ["P1001", "P1002", "P1008", "P1017"].includes(err.code)
  );
}

/**
 * True when `err` indicates the schema is behind the code: the queried table
 * (P2021) or column (P2022) does not exist. The database answered fine; a
 * migration is missing or was rolled back. Read-only callers that hold a safe
 * fallback can degrade gracefully instead of surfacing a 500, exactly as they do
 * for an unreachable server.
 */
export function isSchemaMissingError(err: unknown): boolean {
  // P2021 table does not exist, P2022 column does not exist.
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2021", "P2022"].includes(err.code)
  );
}

/** True when `err` is a Prisma unique-constraint (P2002) violation. */
export function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** True when `err` is a Prisma foreign-key-constraint (P2003) violation. */
export function isForeignKeyConstraintError(
  err: unknown
): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

/** True when `err` is a Prisma transaction write-conflict / deadlock (P2034),
 *  which Serializable isolation raises when concurrent transactions conflict. Safe
 *  to retry: re-running reads the winner's committed rows. */
export function isSerializationError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

/**
 * Run `fn` in a Serializable transaction, retrying a few times when Postgres
 * aborts it with a write-conflict/deadlock (P2034). Use when two transactions can
 * read-then-write the same rows and must not lose an update. `fn` must be free of
 * external side effects, since it may run more than once.
 */
export async function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      if (attempt < attempts && isSerializationError(err)) continue;
      throw err;
    }
  }
}

/**
 * Run `fn`, retrying a few times when it fails because the database was
 * momentarily unreachable (`isDbUnreachableError`). Anything else propagates on
 * the first attempt, and the last failure is rethrown once the budget is spent.
 *
 * This is the RETRY half of the rule `isDbUnreachableError` gates. The other
 * half is degradation, and which one applies is decided by whether the caller
 * holds a safe answer:
 *
 *   - A render-path read with a sensible default (`getSetting`) degrades to it.
 *   - A polled API route degrades to 503, never to content.
 *   - The auth session path has NO safe answer. It must resolve the caller's
 *     Person, and "null" there means "log out", so degrading would sign a
 *     member out over a blip. It retries instead.
 *
 * Unlike `runSerializable`, this waits between attempts, and the difference is
 * deliberate. A serialization conflict is resolved the instant the competing
 * transaction commits, so an immediate retry is the right move. A dropped
 * connection is not: retrying into the same just-closed pooled connection with
 * no pause is the least likely moment to succeed. The backoff is linear and
 * short (50ms, then 100ms) because this sits in front of a page render -- the
 * budget is bounded at 150ms of added latency, and only on a failing request.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 50 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isDbUnreachableError(err)) throw err;
      // No wait before the first attempt: a healthy call pays nothing.
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
