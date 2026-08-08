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
 * Two reasons, one present and one imminent.
 *
 * Present: each person is offboarded in its own transaction with real side
 * effects (memberships removed, Epic requests cancelled and enqueued, shift
 * requests cancelled). Bounding the batch bounds the blast radius of a
 * mis-click on a destructive action.
 *
 * Imminent: the volunteer-passport work, in flight on its own branch, adds
 * revokeWalletPasses to this exact path with an 8s vendor timeout per pass,
 * outside the offboard transaction. Once that merges, a wallet outage during a
 * 38-person batch would spend past the 300s function limit in that loop alone
 * and lose its tail. 25 bounds that worst case near 225s with headroom, and
 * choosing it now means the limit is already correct when the path changes.
 *
 * The UI enforces the same number on selection, so nothing is silently
 * truncated.
 */
export const MAX_BULK_OFFBOARD = 25;
