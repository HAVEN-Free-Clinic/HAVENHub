import { Prisma, PrismaClient } from "@prisma/client";
import { personNameWriteExtension } from "./person-name-write";

/**
 * The Person name extension is applied here rather than at each call site
 * because `Person.name` is a DERIVED column: it must always equal
 * `displayNameOf` of the parts beside it. Applying it to the one client covers
 * services, scripts, seeds, tests, and writes inside a `$transaction` alike, so
 * there is no eleventh write path that quietly forgets. See
 * platform/person-name-write.ts.
 */
/**
 * Build a client with the extensions applied.
 *
 * Exported for the two places that legitimately own their own connection rather
 * than sharing the app singleton below: prisma/seed.ts and the standalone import
 * scripts. `new PrismaClient()` on its own is a Person write path with no name
 * reconciliation, so construct through here instead.
 */
export function makePrismaClient() {
  return new PrismaClient().$extends(personNameWriteExtension());
}

function client() {
  return makePrismaClient();
}

/**
 * The client type, extension included. Import these rather than naming
 * `PrismaClient` or `Prisma.TransactionClient` directly: an extended client is a
 * structurally different type, and a signature written against the bare one
 * silently stops accepting `prisma`.
 */
export type ExtendedPrismaClient = ReturnType<typeof client>;

/** What `$transaction` hands its callback: the client minus the lifecycle methods. */
export type TransactionClient = Omit<
  ExtendedPrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** Either, for the many helpers that work the same inside a transaction or out. */
export type Db = ExtendedPrismaClient | TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? client();

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
  fn: (tx: TransactionClient) => Promise<T>,
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
