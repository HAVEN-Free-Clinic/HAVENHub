"use client";

import { useEffect } from "react";
import { decideCrashRecovery } from "./router-hook-crash";
import { installReloadOnce } from "./client-self-heal";

/**
 * Reloads the client once when React's hook-list corruption kills Next's App
 * Router root. See `router-hook-crash.ts` for the diagnosis and for when this
 * whole workaround should be deleted, and `client-self-heal.ts` for the reload
 * mechanism.
 *
 * Renders nothing; mounted from the root layout so it covers public routes too.
 */
export function RouterCrashRecovery() {
  useEffect(() => {
    installReloadOnce({
      decide: decideCrashRecovery,
      storageKey: "haven:router-hook-crash-recovered",
      recoveredEvent: "client_router_crash_recovered",
    });
  }, []);
  return null;
}
