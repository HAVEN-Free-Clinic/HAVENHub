/**
 * Run the client self-heals against an error an ERROR BOUNDARY caught, so a
 * member whose crash arrives that way is put back on their feet instead of being
 * shown a "Try again" button that cannot work.
 *
 * The gap this closes. `installReloadOnce` (client-self-heal.ts) listens on
 * `window`'s `error` and `unhandledrejection`, which covers every crash that
 * reaches the global handlers. A Server Action invoked by a plain
 * `<form action={...}>` never does: React catches the action's rejection itself
 * and re-throws it during render so the nearest error boundary handles it. It is
 * neither an uncaught error nor an unhandled rejection at any point, so the
 * listeners are silent by design and the reload never fires.
 *
 * What that cost us. The "Sign in with Yale" button on `/login` is exactly that
 * shape -- a bare `<form action={inline server action}>` with no catch of its
 * own (see src/app/login/page.tsx). `/login` has no `error.tsx`, so the throw
 * fell all the way to `global-error.tsx` and its "Try again" button. Retrying
 * re-sends the same dead action id from the same stale bundle, so it fails
 * identically. Error Tracking recorded 8 of these across 5 members on Aug 28-29,
 * every event on `/login` with `handled: true` (the boundary's own capture), and
 * members visibly retrying two to three seconds apart -- taking the advice the
 * screen gave them, into the same wall.
 *
 * Why here rather than a `login/error.tsx`. A route-local boundary fixes one
 * route; this fixes every boundary in the app at once, including the ones we
 * have not written yet, because `CaptureException` is already mounted in all of
 * them. The failure is not specific to `/login` -- any bare `<form action>` in
 * the app can hit it -- so the recovery should not be either.
 *
 * Which heals run here, and which deliberately do not:
 *
 *  - Stale Server Action: the case above. Included.
 *  - Chunk load: a failed dynamic import inside a lazy component surfaces
 *    through the boundary rather than the window handler. Included.
 *  - Router hook crash: NOT included, and not an oversight. That crash kills
 *    Next's `Router`, which sits ABOVE every boundary we own -- including
 *    `global-error.tsx` -- so it can never arrive here. See
 *    router-hook-crash.ts. Listing it would be dead code implying a coverage we
 *    do not have.
 *
 * Each heal keeps its own sessionStorage key, and `recoverOnce` is the same
 * function the listeners and `runAction` call, so a tab still spends exactly one
 * reload per crash class however the failure reaches us.
 */

import { recoverOnce, type SelfHeal } from "./client-self-heal";
import { STALE_SERVER_ACTION_HEAL, isStaleServerActionError } from "./stale-server-action";
import { CHUNK_LOAD_HEAL, isChunkLoadError } from "./chunk-load-crash";
import {
  SERVER_ACTION_TRANSPORT_HEAL,
  isServerActionTransportError,
} from "./server-action-transport";

/**
 * Each boundary-reachable heal paired with the predicate that recognises it.
 *
 * Paired rather than listed separately because two callers need different halves
 * -- the render pass needs "would this reload?" without touching storage, the
 * effect needs the reload itself -- and a heal whose predicate drifted out of
 * sync would show a member "reloading..." on an error that then never reloads.
 * One table, so they cannot drift.
 *
 * Order is not load-bearing; the predicates are disjoint. Keeping the two Server
 * Action entries first documents which failure drove this.
 */
const BOUNDARY_RECOVERIES: readonly { heal: SelfHeal; matches: (error: unknown) => boolean }[] = [
  { heal: STALE_SERVER_ACTION_HEAL, matches: isStaleServerActionError },
  { heal: SERVER_ACTION_TRANSPORT_HEAL, matches: isServerActionTransportError },
  { heal: CHUNK_LOAD_HEAL, matches: isChunkLoadError },
];

/** The heals a boundary-caught error is tried against. */
export const BOUNDARY_HEALS: readonly SelfHeal[] = BOUNDARY_RECOVERIES.map((entry) => entry.heal);

/**
 * True when `error` belongs to a class a boundary reloads out of.
 *
 * PURE, and deliberately so: boundaries call this during render to choose their
 * copy, so it must not read sessionStorage or touch the DOM. That means it
 * answers "is this class recoverable?", not "will a reload happen right now" --
 * a tab that has already spent its one reload for this class still gets `true`
 * here and will show the reloading copy without reloading again.
 *
 * That gap is accepted rather than closed. Closing it means reading
 * sessionStorage during render, which is a hydration mismatch waiting to happen
 * in the one component that must never throw. The cost of the gap is small and
 * bounded: it needs the same crash class twice in one tab, and what the member
 * sees is a "reloading" message on a page they can reload themselves -- which is
 * what the message tells them is happening anyway. Every boundary using this
 * keeps a way out visible for exactly that case.
 */
export function isBoundaryRecoverableError(error: unknown): boolean {
  return BOUNDARY_RECOVERIES.some((entry) => entry.matches(error));
}

/**
 * Try every boundary-reachable heal against `error`. Returns true when one of
 * them started a reload.
 *
 * `some` short-circuits, so at most one heal reloads for a given error.
 */
export function recoverBoundaryError(error: unknown): boolean {
  return BOUNDARY_RECOVERIES.some((entry) => recoverOnce(entry.heal, error));
}

/**
 * Heading and body a boundary shows while `recoverBoundaryError` reloads.
 *
 * Deliberately vaguer than `STALE_DEPLOY_MESSAGE`, which `runAction` uses: that
 * one can say "a new version was just released" because it only ever fires for
 * the stale-action-id case. A boundary reaches here for three different causes
 * -- a new deploy, a Server Action response that came back unreadable, or a
 * dropped chunk -- so the copy names the only thing true of all three, which is
 * that a reload is under way and the member does not need to do anything.
 *
 * What matters most is what it does NOT say: "try again". That is the one
 * instruction that cannot work for any of the three.
 */
export const BOUNDARY_RECOVERING_TITLE = "One moment";
export const BOUNDARY_RECOVERING_MESSAGE =
  "We hit a hiccup and are reloading the page to get you back on track...";
