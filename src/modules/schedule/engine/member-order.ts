import { comparePersonName } from "@/platform/person-name";
/**
 * Ordering for the builder's member lists.
 *
 * Lives in `engine/` rather than in `services/builder.ts` because the grid and
 * the Day view are CLIENT components now: importing a runtime function out of
 * the service would drag Prisma into the browser bundle. Types can still be
 * imported from the service (type imports are erased); runtime helpers the
 * client needs have to live in a module with no server-only imports. The
 * service re-exports this so existing server-side callers are unaffected.
 */

/** Just the fields {@link compareBuilderMembers} needs; any BuilderMember satisfies it. */
export type BuilderMemberOrder = {
  kind: "DIRECTOR" | "VOLUNTEER";
  // The name PARTS, not the rendered string: this orders by surname like the
  // rest of the app, and a preferred name must not reshuffle the roster.
  person: { legalFirstName: string; lastName: string };
  /** Present and non-null for an incoming (accepted, pre-roster) row. */
  provisional?: unknown | null;
};

/**
 * Confirmed roster members first, then the incoming (accepted, not yet built
 * onto the roster) ones; within each group directors first, then volunteers,
 * each sorted alphabetically by name. Used by the Day view's "Available to
 * assign" pool, the grid view, and the availability view, so all three surfaces
 * match.
 *
 * Incoming members sort last deliberately: the confirmed roster is the thing a
 * director is scheduling, and interleaving people who might yet not arrive would
 * bury it.
 */
export function compareBuilderMembers(a: BuilderMemberOrder, b: BuilderMemberOrder): number {
  const aIncoming = a.provisional != null;
  const bIncoming = b.provisional != null;
  if (aIncoming !== bIncoming) return aIncoming ? 1 : -1;
  if (a.kind !== b.kind) return a.kind === "DIRECTOR" ? -1 : 1;
  return comparePersonName(a.person, b.person);
}
