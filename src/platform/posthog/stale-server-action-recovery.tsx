"use client";

import { useEffect } from "react";
import { STALE_SERVER_ACTION_HEAL } from "./stale-server-action";
import { installReloadOnce } from "./client-self-heal";

/**
 * Reloads the client once when a Server Action call is refused because the
 * running deploy no longer has that action id. See `stale-server-action.ts` for
 * the diagnosis and `client-self-heal.ts` for the reload mechanism.
 *
 * The catch blocks in `run-action.ts` and `login/member-sign-in-form.tsx` drive
 * this recovery for the calls they wrap, and the `login/error.tsx` boundary drives
 * it for the plain `<form action={...}>` on the sign-in page -- React catches a
 * form action's rejection and routes it to the nearest boundary, so it never
 * reaches this listener. All of them share this heal's sessionStorage key, so a
 * tab still gets exactly one reload however the failure arrives. This listener is
 * the backstop for the remaining path: a stale action rejection that surfaces to
 * the window because no boundary or catch of ours is above it.
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
