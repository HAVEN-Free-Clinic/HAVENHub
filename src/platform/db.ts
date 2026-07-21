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
