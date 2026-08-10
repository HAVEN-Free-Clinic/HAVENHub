/**
 * Limits shared by the bulk offboarding service and the client tabs that drive it.
 *
 * Deliberately its own module with NO imports. The tabs are "use client" and need
 * this number to disable their submit button, and importing it from
 * services/transition-actions.ts would drag Prisma and the audit writer into the
 * client bundle.
 */

/**
 * The largest batch bulkExecuteOffboard will accept.
 *
 * Two reasons.
 *
 * Blast radius: each person is offboarded in its own transaction with real side
 * effects (memberships removed, Epic requests cancelled and enqueued, shift
 * requests cancelled). Bounding the batch bounds the damage of a mis-click on a
 * destructive action that reactivation cannot undo.
 *
 * Wall clock: setPersonStatusField calls revokeWalletPasses outside the offboard
 * transaction, with an 8s vendor timeout PER PASS. During a wallet outage an
 * unbounded 38-person batch would spend past the 300s function limit in that loop
 * alone and silently lose its tail. 25 bounds the worst case near 225s, leaving
 * headroom for the rest of each offboard.
 *
 * That second reason is why this number is load-bearing rather than cosmetic: it
 * is sized against a real vendor timeout in the call path, so raising it needs a
 * new calculation, not just a bigger number.
 *
 * The UI enforces the same number on selection, so nothing is silently
 * truncated.
 */
export const MAX_BULK_OFFBOARD = 25;
