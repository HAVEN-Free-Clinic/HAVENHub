import { recoverOnce } from "@/platform/posthog/client-self-heal";
import {
  STALE_DEPLOY_MESSAGE,
  STALE_SERVER_ACTION_HEAL,
} from "@/platform/posthog/stale-server-action";

/** The result shape every server action in this app returns for a HANDLED failure. */
export type ActionResult = { error?: string };

/**
 * Shown when the action promise rejected rather than returning `{ error }`. Names
 * the one fact the user needs before deciding what to do: their input is still
 * there, so re-clicking is safe and does not risk applying the action twice.
 */
export const ACTION_REJECTED_MESSAGE =
  "Something went wrong and nothing was saved. Check your connection and try again.";

/**
 * Calls a bound server action and turns a REJECTION into the same `{ error }`
 * result a handled failure returns.
 *
 * Server actions in this app return `{ error }` for the cases they anticipate, and
 * every caller checks that. What no caller checked (audit 14) is the other exit:
 * a Prisma failure, a permission check that throws, a dropped request, or a deploy
 * swapping the action id mid-session all REJECT the promise instead. Inside a
 * `startTransition(async () => ...)` body that rejection is unhandled: the `if
 * (res.error)` line is never reached, so no Alert renders, the transition's pending
 * flag simply flips back to false, the spinner vanishes, and the modal looks like it
 * succeeded. In the speed-scoring and speed-routing modals that meant the reviewer's
 * score or routing decision was silently dropped and the queue advanced past the
 * applicant as if it had been recorded.
 *
 * Wrapping the call here rather than adding a try/catch at each site keeps the
 * message and the behaviour identical across modals, and gives the next
 * modal-driven action one obvious thing to reach for.
 */
export async function runAction<T extends ActionResult>(
  call: () => Promise<T>,
  fallbackMessage: string = ACTION_REJECTED_MESSAGE,
): Promise<T | { error: string }> {
  try {
    return await call();
  } catch (err) {
    // One of the rejections named above -- "a deploy swapping the action id
    // mid-session" -- is the one case where the fallback message is actively
    // wrong. It tells the member their input is safe and re-clicking will work,
    // but the retry re-sends the same dead action id from the same stale bundle
    // and fails identically. Reload onto the new bundle instead, and say that is
    // what is happening. See stale-server-action.ts.
    if (recoverOnce(STALE_SERVER_ACTION_HEAL, err)) {
      return { error: STALE_DEPLOY_MESSAGE };
    }
    return { error: fallbackMessage };
  }
}
