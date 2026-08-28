"use client";

import { useEffect } from "react";
import { STALE_SERVER_ACTION_HEAL } from "./stale-server-action";
import { installReloadOnce } from "./client-self-heal";

/**
 * Reloads the client once when a Server Action call is refused because the
 * running deploy no longer has that action id. See `stale-server-action.ts` for
 * the diagnosis and `client-self-heal.ts` for the reload mechanism.
 *
 * The catch blocks in `run-action.ts` and `login/member-sign-in-form.tsx` already
 * drive this recovery for the calls they wrap, and both share this heal's
 * sessionStorage key, so a tab still gets exactly one reload however the failure
 * arrives. This listener covers what those cannot: a plain `<form action={...}>`
 * posting a server action directly, which has no catch of ours anywhere and
 * otherwise ends at an error boundary the member cannot act on.
 *
 * Watches promise rejections as well as thrown errors: the refusal comes back
 * from an in-flight request, so it rejects rather than throwing.
 *
 * Renders nothing; mounted from the root layout so it covers public routes too,
 * including `/login`, where we saw the failure.
 */
export function StaleServerActionRecovery() {
  useEffect(() => {
    installReloadOnce(STALE_SERVER_ACTION_HEAL);
  }, []);
  return null;
}
